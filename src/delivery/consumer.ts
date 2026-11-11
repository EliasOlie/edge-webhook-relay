import type { DeliveryMessage, Env } from "../env";
import { intVar } from "../lib/http";
import { errorMessage, log } from "../lib/log";
import { loadSources } from "../sources/registry";
import { getEvent, markDead, recordAttempt } from "../store/events";
import { backoffSeconds } from "./backoff";
import { RELAY_SIGNATURE_HEADER, signDelivery } from "./sign";

const DEFAULT_TIMEOUT_MS = 10_000;

type Outcome =
  | { kind: "delivered"; httpStatus: number }
  | { kind: "retry"; httpStatus?: number; error: string }
  | { kind: "permanent"; httpStatus: number; error: string };

/** 2xx = done; 408/425/429/5xx/network = retry; other 4xx = the request itself is wrong. */
export function classify(status: number): Outcome["kind"] {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "retry";
  return "permanent";
}

/**
 * Main delivery queue consumer. Each message carries only an event id; the
 * payload is read from D1 so replays and retries always send the stored bytes.
 */
export async function handleDeliveryBatch(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map((msg) => deliverOne(msg, env)));
}

async function deliverOne(msg: Message<DeliveryMessage>, env: Env): Promise<void> {
  const eventId = msg.body?.eventId;
  const event = eventId ? await getEvent(env.DB, eventId) : null;
  if (!event) {
    log("warn", "delivery_event_missing", { message_id: msg.id });
    msg.ack();
    return;
  }
  if (event.status === "delivered" || event.status === "dead") {
    // Stale message (already delivered, or given up and awaiting a manual replay).
    msg.ack();
    return;
  }

  const config = loadSources(env)[event.source];
  const signingSecret = env.RELAY_SIGNING_SECRET;
  if (!config || !signingSecret) {
    const reason = !config ? "source_removed" : "relay_signing_secret_missing";
    log("error", "delivery_misconfigured", { event_id: event.id, reason });
    // Configuration problem: retrying will not help until an operator acts.
    await markDead(env.DB, event.id, reason);
    msg.ack();
    return;
  }

  const attempt = event.attempts + 1;
  const started = Date.now();
  let outcome: Outcome;
  try {
    const res = await fetch(config.destination, {
      method: "POST",
      headers: {
        "content-type": event.content_type ?? "application/json",
        "idempotency-key": event.id,
        "x-relay-event-id": event.id,
        "x-relay-source": event.source,
        "x-relay-attempt": String(attempt),
        [RELAY_SIGNATURE_HEADER]: await signDelivery(signingSecret, event.id, event.payload),
      },
      body: event.payload,
      signal: AbortSignal.timeout(intVar(env.DELIVERY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)),
    });
    // Drain the body so the connection can be reused; content is not needed.
    await res.body?.cancel();
    const kind = classify(res.status);
    outcome =
      kind === "delivered"
        ? { kind, httpStatus: res.status }
        : { kind, httpStatus: res.status, error: `http_${res.status}` };
  } catch (err) {
    outcome = { kind: "retry", error: `network: ${errorMessage(err)}` };
  }
  const durationMs = Date.now() - started;
  const fields = { event_id: event.id, source: event.source, attempt, duration_ms: durationMs };

  if (outcome.kind === "delivered") {
    await recordAttempt(env.DB, event.id, { status: "delivered", httpStatus: outcome.httpStatus, attempt, durationMs });
    log("info", "delivered", { ...fields, http_status: outcome.httpStatus });
    msg.ack();
    return;
  }

  if (outcome.kind === "permanent") {
    await recordAttempt(env.DB, event.id, { status: "failed", ...outcome, attempt, durationMs });
    await markDead(env.DB, event.id, outcome.error);
    log("warn", "delivery_rejected", { ...fields, http_status: outcome.httpStatus });
    msg.ack();
    return;
  }

  // Retryable. Once the queue's max_retries is exhausted, Cloudflare moves the
  // message to the dead-letter queue, whose consumer marks the event dead.
  const delaySeconds = backoffSeconds(
    msg.attempts,
    intVar(env.RETRY_BASE_SECONDS, 10),
    intVar(env.RETRY_MAX_SECONDS, 3600),
  );
  await recordAttempt(env.DB, event.id, {
    status: "failed",
    error: outcome.error,
    httpStatus: outcome.httpStatus,
    attempt,
    durationMs,
  });
  log("warn", "delivery_retry", { ...fields, http_status: outcome.httpStatus ?? null, delay_seconds: delaySeconds, error: outcome.error });
  msg.retry({ delaySeconds });
}

/** Dead-letter queue consumer: the event exhausted its retries. */
export async function handleDeadLetterBatch(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const eventId = msg.body?.eventId;
    if (eventId) {
      await markDead(env.DB, eventId, "max_retries_exhausted");
      log("error", "event_dead", { event_id: eventId, attempts: msg.attempts });
    }
    msg.ack();
  }
}
