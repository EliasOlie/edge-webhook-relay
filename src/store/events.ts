export type EventStatus = "received" | "delivered" | "failed" | "dead";
export const EVENT_STATUSES: readonly EventStatus[] = ["received", "delivered", "failed", "dead"];

export interface EventSummary {
  id: string;
  source: string;
  idempotency_key: string;
  status: EventStatus;
  attempts: number;
  last_error: string | null;
  payload_sha256: string;
  received_at: number;
  updated_at: number;
  enqueued_at: number | null;
  delivered_at: number | null;
}

export interface EventRecord extends EventSummary {
  payload: string;
  content_type: string | null;
}

export interface HistoryEntry {
  at: number;
  kind: string;
  detail: Record<string, unknown> | null;
}

export interface NewEvent {
  source: string;
  idempotencyKey: string;
  payload: string;
  payloadSha256: string;
  contentType: string | null;
  receivedAt: number;
}

const SUMMARY_COLUMNS =
  "id, source, idempotency_key, status, attempts, last_error, payload_sha256, received_at, updated_at, enqueued_at, delivered_at";

function historyStmt(db: D1Database, eventId: string, kind: string, detail?: Record<string, unknown>) {
  return db
    .prepare("INSERT INTO event_history (event_id, at, kind, detail) VALUES (?, ?, ?, ?)")
    .bind(eventId, Date.now(), kind, detail ? JSON.stringify(detail) : null);
}

/**
 * Inserts the event if (source, idempotency_key) is new; otherwise returns the
 * existing row. Safe to call repeatedly for the same key: this is what makes a
 * half-finished admission (row written, enqueue failed) recoverable on retry.
 */
export async function upsertEvent(
  db: D1Database,
  ev: NewEvent,
): Promise<{ id: string; enqueuedAt: number | null; inserted: boolean }> {
  const id = crypto.randomUUID();
  const insert = await db
    .prepare(
      `INSERT INTO events (id, source, idempotency_key, status, payload_sha256, payload, content_type, received_at, updated_at)
       VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?)
       ON CONFLICT (source, idempotency_key) DO NOTHING`,
    )
    .bind(id, ev.source, ev.idempotencyKey, ev.payloadSha256, ev.payload, ev.contentType, ev.receivedAt, ev.receivedAt)
    .run();
  const inserted = insert.meta.changes === 1;

  const row = await db
    .prepare("SELECT id, enqueued_at FROM events WHERE source = ? AND idempotency_key = ?")
    .bind(ev.source, ev.idempotencyKey)
    .first<{ id: string; enqueued_at: number | null }>();
  if (!row) throw new Error("event row missing after upsert");

  if (inserted) await historyStmt(db, row.id, "received", { payload_sha256: ev.payloadSha256 }).run();
  return { id: row.id, enqueuedAt: row.enqueued_at, inserted };
}

export async function markEnqueued(db: D1Database, id: string): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE events SET enqueued_at = ?, updated_at = ? WHERE id = ?").bind(now, now, id),
    historyStmt(db, id, "enqueued"),
  ]);
}

export async function getEvent(db: D1Database, id: string): Promise<EventRecord | null> {
  return db.prepare(`SELECT ${SUMMARY_COLUMNS}, payload, content_type FROM events WHERE id = ?`).bind(id).first<EventRecord>();
}

export async function getHistory(db: D1Database, id: string): Promise<HistoryEntry[]> {
  const { results } = await db
    .prepare("SELECT at, kind, detail FROM event_history WHERE event_id = ? ORDER BY id")
    .bind(id)
    .all<{ at: number; kind: string; detail: string | null }>();
  return results.map((r) => ({ at: r.at, kind: r.kind, detail: r.detail ? JSON.parse(r.detail) : null }));
}

export interface ListFilter {
  status?: EventStatus;
  source?: string;
  /** Return events received strictly before this timestamp (ms) - keyset pagination. */
  before?: number;
  limit: number;
}

export async function listEvents(db: D1Database, f: ListFilter): Promise<EventSummary[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) {
    where.push("status = ?");
    args.push(f.status);
  }
  if (f.source) {
    where.push("source = ?");
    args.push(f.source);
  }
  if (f.before !== undefined) {
    where.push("received_at < ?");
    args.push(f.before);
  }
  const sql = `SELECT ${SUMMARY_COLUMNS} FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY received_at DESC, id DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...args, f.limit).all<EventSummary>();
  return results;
}

export async function recordAttempt(
  db: D1Database,
  id: string,
  outcome: { status: EventStatus; error?: string; httpStatus?: number; attempt: number; durationMs: number },
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE events SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?,
           delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
         WHERE id = ?`,
      )
      .bind(outcome.status, outcome.error ?? null, now, outcome.status, now, id),
    historyStmt(db, id, outcome.status === "delivered" ? "delivered" : "attempt_failed", {
      attempt: outcome.attempt,
      http_status: outcome.httpStatus ?? null,
      error: outcome.error ?? null,
      duration_ms: outcome.durationMs,
    }),
  ]);
}

export async function markDead(db: D1Database, id: string, reason: string): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      // Keep the last real delivery error if there is one; the reason goes to history.
      .prepare("UPDATE events SET status = 'dead', last_error = COALESCE(last_error, ?), updated_at = ? WHERE id = ? AND status != 'delivered'")
      .bind(reason, now, id),
    historyStmt(db, id, "dead", { reason }),
  ]);
}

/** Resets an event for redelivery and records who/why in the audit trail. */
export async function markReplayed(db: D1Database, id: string, actor: string): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE events SET status = 'received', last_error = NULL, updated_at = ? WHERE id = ?").bind(now, id),
    historyStmt(db, id, "replay", { actor }),
  ]);
}

export async function listDeadIds(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM events WHERE status = 'dead' ORDER BY received_at LIMIT ?")
    .bind(limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}
