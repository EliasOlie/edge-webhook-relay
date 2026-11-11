import { guardName } from "../dedup/guard";
import { secretFrom, type Env } from "../env";
import { sha256Hex } from "../lib/crypto";
import { intVar, json, PayloadTooLargeError, problem, readRawBody } from "../lib/http";
import { log } from "../lib/log";
import { loadSources, verifierFor } from "../sources/registry";
import type { WebhookInput } from "../sources/types";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * POST /in/:source - authenticate, de-duplicate, persist, enqueue, 202.
 * GET  /in/:source - provider handshake (WhatsApp hub.challenge).
 *
 * The response is sent as soon as the event is durable (D1 row + queue
 * message); delivery to the destination happens asynchronously in the queue
 * consumer, so providers get a fast answer and never time out on a slow
 * downstream.
 */
export async function handleIngest(
  request: Request,
  env: Env,
  sourceName: string,
  now: number = Date.now(),
): Promise<Response> {
  const config = loadSources(env)[sourceName];
  if (!config) return problem(404, "unknown_source");
  const verifier = verifierFor(config);

  if (request.method === "GET") {
    if (!verifier.handshake) return problem(405, "method_not_allowed");
    return verifier.handshake(new URL(request.url), config, (name) => secretFrom(env, name));
  }
  if (request.method !== "POST") return problem(405, "method_not_allowed");

  const secret = secretFrom(env, config.secret);
  if (!secret) {
    // Fail closed: never accept unauthenticated webhooks because of a missing secret.
    log("error", "source_secret_missing", { source: sourceName });
    return problem(500, "source_not_configured");
  }

  let rawBody: Uint8Array;
  try {
    rawBody = await readRawBody(request, intVar(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES));
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return problem(413, "payload_too_large");
    throw err;
  }

  let text: string;
  try {
    text = utf8Strict.decode(rawBody);
  } catch {
    return problem(400, "body_not_utf8");
  }

  const input: WebhookInput = { headers: request.headers, rawBody, text, now };
  const verdict = await verifier.verify(input, config, secret);
  if (!verdict.ok) {
    log("warn", "signature_rejected", { source: sourceName, reason: verdict.reason, bytes: rawBody.byteLength });
    return problem(401, "invalid_signature");
  }

  const payloadSha256 = await sha256Hex(rawBody);
  const idempotencyKey = verifier.idempotencyKey(input, config) ?? `sha256:${payloadSha256}`;

  const stub = env.IDEMPOTENCY.getByName(guardName(sourceName, idempotencyKey));
  const result = await stub.admit({
    source: sourceName,
    idempotencyKey,
    payload: text,
    payloadSha256,
    contentType: request.headers.get("content-type"),
    receivedAt: now,
  });

  if (result.outcome === "error") {
    // 5xx makes the provider retry later; nothing was recorded as seen.
    return problem(503, "temporarily_unavailable");
  }
  if (result.outcome === "duplicate") {
    log("info", "duplicate_suppressed", { source: sourceName, event_id: result.eventId });
    return json({ duplicate: true, id: result.eventId }, 200);
  }
  log("info", "event_accepted", { source: sourceName, event_id: result.eventId, bytes: rawBody.byteLength });
  return json({ accepted: true, id: result.eventId }, 202);
}
