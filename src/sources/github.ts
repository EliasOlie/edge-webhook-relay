import { verifyHexHmac } from "../lib/crypto";
import type { GitHubSourceConfig, SourceVerifier } from "./types";

/**
 * GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`.
 * `X-GitHub-Delivery` is a GUID that stays the same when GitHub redelivers.
 */
export const github: SourceVerifier<GitHubSourceConfig> = {
  type: "github",

  async verify(input, _config, secret) {
    const header = input.headers.get("x-hub-signature-256");
    if (!header?.startsWith("sha256=")) return { ok: false, reason: "missing_signature" };
    const valid = await verifyHexHmac(secret, input.rawBody, header.slice("sha256=".length));
    return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
  },

  idempotencyKey(input) {
    return input.headers.get("x-github-delivery") || null;
  },
};
