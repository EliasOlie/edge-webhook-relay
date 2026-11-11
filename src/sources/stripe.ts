import { constantTimeEqual, fromHex, hmacSha256, utf8 } from "../lib/crypto";
import { parseJson, type SourceVerifier, type StripeSourceConfig } from "./types";

const DEFAULT_TOLERANCE_SECONDS = 300;

/** Parses `t=1700000000,v1=abc,v1=def,v0=...` into timestamp + v1 signatures. */
export function parseStripeSignature(header: string): { timestamp: number; v1: string[] } | null {
  let timestamp = Number.NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") timestamp = Number(value);
    else if (key === "v1") v1.push(value);
  }
  if (!Number.isInteger(timestamp) || v1.length === 0) return null;
  return { timestamp, v1 };
}

/**
 * Stripe: `Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * Several v1 entries may be present during secret rotation; any match passes.
 * Timestamps outside the tolerance window (past or future) are rejected to
 * limit replay of captured requests.
 */
export const stripe: SourceVerifier<StripeSourceConfig> = {
  type: "stripe",

  async verify(input, config, secret) {
    const header = input.headers.get("stripe-signature");
    if (!header) return { ok: false, reason: "missing_signature" };
    const parsed = parseStripeSignature(header);
    if (!parsed) return { ok: false, reason: "malformed_signature" };

    const tolerance = config.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    const ageSeconds = Math.abs(input.now / 1000 - parsed.timestamp);
    if (ageSeconds > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };

    const prefix = utf8(`${parsed.timestamp}.`);
    const signed = new Uint8Array(prefix.byteLength + input.rawBody.byteLength);
    signed.set(prefix, 0);
    signed.set(input.rawBody, prefix.byteLength);
    const expected = await hmacSha256(secret, signed);

    let match = false;
    for (const candidate of parsed.v1) {
      const bytes = fromHex(candidate);
      // Evaluate every candidate (no early exit) to keep timing uniform.
      if (bytes && constantTimeEqual(expected, bytes)) match = true;
    }
    return match ? { ok: true } : { ok: false, reason: "bad_signature" };
  },

  idempotencyKey(input) {
    const event = parseJson(input.text) as { id?: unknown } | undefined;
    return typeof event?.id === "string" && event.id.length > 0 ? event.id : null;
  },
};
