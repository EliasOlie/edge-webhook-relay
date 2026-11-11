interface BaseSourceConfig {
  /** Where verified events are delivered (HTTPS endpoint you own). */
  destination: string;
  /** Name of the Worker secret holding the provider signing secret. */
  secret: string;
}

export interface WhatsAppSourceConfig extends BaseSourceConfig {
  type: "whatsapp";
  /** Name of the Worker secret holding the hub.verify_token used on GET subscription. */
  verifyToken?: string;
}

export interface StripeSourceConfig extends BaseSourceConfig {
  type: "stripe";
  /** Max age of the `t=` timestamp in seconds. Defaults to 300 (Stripe's default). */
  toleranceSeconds?: number;
}

export interface GitHubSourceConfig extends BaseSourceConfig {
  type: "github";
}

export interface GenericSourceConfig extends BaseSourceConfig {
  type: "generic";
  /** Header carrying the HMAC-SHA256 signature of the raw body. */
  signatureHeader: string;
  /** Optional prefix stripped before decoding, e.g. "sha256=". */
  signaturePrefix?: string;
  /** Signature encoding. Defaults to "hex". */
  encoding?: "hex" | "base64";
  /** Header carrying a provider delivery id. Falls back to SHA-256 of the body. */
  idempotencyHeader?: string;
}

export type SourceConfig =
  | WhatsAppSourceConfig
  | StripeSourceConfig
  | GitHubSourceConfig
  | GenericSourceConfig;

export type SourceType = SourceConfig["type"];

/** Everything a verifier may look at. `rawBody` is exactly what the provider sent. */
export interface WebhookInput {
  headers: Headers;
  rawBody: Uint8Array;
  /** `rawBody` decoded as UTF-8. Never re-serialize parsed JSON for signing. */
  text: string;
  /** Current time in milliseconds (injectable for tests). */
  now: number;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * A pluggable source. Adding a provider means implementing this interface and
 * registering it in `registry.ts`.
 */
export interface SourceVerifier<C extends SourceConfig = SourceConfig> {
  readonly type: C["type"];
  /** Authenticates the request against the RAW body. Must be constant-time. */
  verify(input: WebhookInput, config: C, secret: string): Promise<VerifyResult>;
  /**
   * Returns the provider's natural de-duplication key (event id, delivery id,
   * message id...). Return null to fall back to the SHA-256 of the raw body.
   */
  idempotencyKey(input: WebhookInput, config: C): string | null;
  /** Optional GET handshake (e.g. WhatsApp hub.challenge subscription check). */
  handshake?(url: URL, config: C, lookupSecret: (name: string | undefined) => string | undefined): Promise<Response>;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
