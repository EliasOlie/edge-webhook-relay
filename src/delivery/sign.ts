import { hmacSha256, toHex } from "../lib/crypto";

export const RELAY_SIGNATURE_HEADER = "x-relay-signature";

/**
 * Signs an outbound delivery so the destination can authenticate the relay:
 * `X-Relay-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<event id>.<body>")>`.
 * Binding the event id into the MAC stops an attacker from pairing a captured
 * body with a different Idempotency-Key.
 */
export async function signDelivery(
  secret: string,
  eventId: string,
  body: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  const mac = await hmacSha256(secret, `${t}.${eventId}.${body}`);
  return `t=${t},v1=${toHex(mac)}`;
}
