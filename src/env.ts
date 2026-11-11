import type { IdempotencyGuard } from "./dedup/guard";
import type { SourceConfig } from "./sources/types";

export interface DeliveryMessage {
  eventId: string;
}

export interface Env {
  DB: D1Database;
  DELIVERY_QUEUE: Queue<DeliveryMessage>;
  IDEMPOTENCY: DurableObjectNamespace<IdempotencyGuard>;

  /** Source name -> configuration. JSON object (or JSON string) from `vars`. */
  SOURCES: Record<string, SourceConfig> | string;
  /** Name of the dead-letter queue, so the queue handler can tell batches apart. */
  DEAD_LETTER_QUEUE: string;

  MAX_BODY_BYTES?: string | number;
  DEDUP_TTL_SECONDS?: string | number;
  DELIVERY_TIMEOUT_MS?: string | number;
  RETRY_BASE_SECONDS?: string | number;
  RETRY_MAX_SECONDS?: string | number;

  /** Secret: bearer token for /admin/*. Admin API is disabled when unset. */
  ADMIN_TOKEN?: string;
  /** Secret: key used to sign outbound deliveries (X-Relay-Signature). */
  RELAY_SIGNING_SECRET?: string;
}

/** Looks up a secret by binding name (names come from SOURCES config). */
export function secretFrom(env: Env, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
