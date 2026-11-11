import { constantTimeEqual, fromBase64, fromHex, hmacSha256 } from "../lib/crypto";
import type { GenericSourceConfig, SourceVerifier } from "./types";

/**
 * Generic HMAC-SHA256 over the raw body, for providers that follow the common
 * "signature header" pattern. Header name, optional prefix and encoding are
 * configurable per source.
 */
export const generic: SourceVerifier<GenericSourceConfig> = {
  type: "generic",

  async verify(input, config, secret) {
    let value = input.headers.get(config.signatureHeader);
    if (!value) return { ok: false, reason: "missing_signature" };
    if (config.signaturePrefix) {
      if (!value.startsWith(config.signaturePrefix)) return { ok: false, reason: "malformed_signature" };
      value = value.slice(config.signaturePrefix.length);
    }
    const provided = (config.encoding ?? "hex") === "base64" ? fromBase64(value) : fromHex(value);
    if (!provided) return { ok: false, reason: "malformed_signature" };
    const expected = await hmacSha256(secret, input.rawBody);
    return constantTimeEqual(expected, provided) ? { ok: true } : { ok: false, reason: "bad_signature" };
  },

  idempotencyKey(input, config) {
    if (!config.idempotencyHeader) return null;
    return input.headers.get(config.idempotencyHeader) || null;
  },
};
