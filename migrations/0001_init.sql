-- Migration number: 0001 	 initial schema

-- One row per unique (source, idempotency_key). The UNIQUE constraint is the
-- long-term de-duplication record; the Durable Object is the race-free gate in
-- front of it.
CREATE TABLE events (
  id               TEXT    PRIMARY KEY,
  source           TEXT    NOT NULL,
  idempotency_key  TEXT    NOT NULL,
  status           TEXT    NOT NULL CHECK (status IN ('received', 'delivered', 'failed', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  payload_sha256   TEXT    NOT NULL,
  payload          TEXT    NOT NULL,
  content_type     TEXT,
  received_at      INTEGER NOT NULL, -- unix epoch milliseconds
  updated_at       INTEGER NOT NULL,
  enqueued_at      INTEGER,          -- set once the event is on the delivery queue
  delivered_at     INTEGER,
  UNIQUE (source, idempotency_key)
);

CREATE INDEX idx_events_status_received ON events (status, received_at DESC);
CREATE INDEX idx_events_source_received ON events (source, received_at DESC);

-- Append-only audit trail: every state transition, delivery attempt and admin
-- action against an event.
CREATE TABLE event_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  TEXT    NOT NULL REFERENCES events (id),
  at        INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  detail    TEXT
);

CREATE INDEX idx_event_history_event ON event_history (event_id, id);
