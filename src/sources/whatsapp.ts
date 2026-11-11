import { constantTimeEqualStrings, verifyHexHmac } from "../lib/crypto";
import { problem } from "../lib/http";
import { parseJson, type SourceVerifier, type WhatsAppSourceConfig } from "./types";

interface WhatsAppPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ id?: string }>;
        statuses?: Array<{ id?: string; status?: string }>;
      };
    }>;
  }>;
}

/**
 * WhatsApp Cloud API (Meta Graph webhooks).
 * - POST: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(app secret, raw body)>`.
 * - GET:  subscription handshake with hub.mode / hub.verify_token / hub.challenge.
 */
export const whatsapp: SourceVerifier<WhatsAppSourceConfig> = {
  type: "whatsapp",

  async verify(input, _config, secret) {
    const header = input.headers.get("x-hub-signature-256");
    if (!header?.startsWith("sha256=")) return { ok: false, reason: "missing_signature" };
    const valid = await verifyHexHmac(secret, input.rawBody, header.slice("sha256=".length));
    return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
  },

  /**
   * One webhook can batch several messages/statuses. A message id alone is not
   * enough for statuses: the same wamid goes through sent -> delivered -> read,
   * and each transition is a distinct event. Key = sorted list of
   * `msg:<id>` and `status:<id>:<status>` entries.
   */
  idempotencyKey(input) {
    const payload = parseJson(input.text) as WhatsAppPayload | undefined;
    const parts: string[] = [];
    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) if (m.id) parts.push(`msg:${m.id}`);
        for (const s of change.value?.statuses ?? []) {
          if (s.id) parts.push(`status:${s.id}:${s.status ?? "unknown"}`);
        }
      }
    }
    if (parts.length === 0) return null;
    return [...new Set(parts)].sort().join(",");
  },

  async handshake(url, config, lookupSecret) {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    const expected = lookupSecret(config.verifyToken);
    if (!expected) return problem(500, "verify_token_not_configured");
    if (mode !== "subscribe" || !(await constantTimeEqualStrings(token, expected))) {
      return problem(403, "verification_failed");
    }
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  },
};
