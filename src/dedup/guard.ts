import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { intVar } from "../lib/http";
import { errorMessage, log } from "../lib/log";
import { markEnqueued, upsertEvent, type NewEvent } from "../store/events";

export type AdmitResult =
  | { outcome: "accepted"; eventId: string }
  | { outcome: "duplicate"; eventId: string }
  | { outcome: "error"; error: string };

const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;

/** Durable Object name for an idempotency key: one instance per (source, key). */
export function guardName(source: string, idempotencyKey: string): string {
  return `${source}\u0000${idempotencyKey}`;
}

/**
 * The de-duplication authority. There is exactly one instance per
 * (source, idempotency key), and `admit` runs inside `blockConcurrencyWhile`,
 * so concurrent deliveries of the same webhook are fully serialized: the
 * second caller only runs after the first has either committed (row in D1 and
 * message on the queue) or failed. A failure stores nothing, so a provider
 * retry can still get the event through. No duplicate is ever acknowledged
 * before the original is durable.
 *
 * Instance storage is a hot cache with a TTL (alarm). After it expires, D1's
 * UNIQUE(source, idempotency_key) + `enqueued_at` remain the long-term record.
 */
export class IdempotencyGuard extends DurableObject<Env> {
  async admit(ev: NewEvent): Promise<AdmitResult> {
    return this.ctx.blockConcurrencyWhile(async (): Promise<AdmitResult> => {
      const known = await this.ctx.storage.get<string>("eventId");
      if (known) return { outcome: "duplicate", eventId: known };

      try {
        const row = await upsertEvent(this.env.DB, ev);
        let outcome: AdmitResult["outcome"] = "duplicate";
        if (row.enqueuedAt === null) {
          await this.env.DELIVERY_QUEUE.send({ eventId: row.id });
          await markEnqueued(this.env.DB, row.id);
          outcome = "accepted";
        }
        await this.ctx.storage.put("eventId", row.id);
        const ttl = intVar(this.env.DEDUP_TTL_SECONDS, DEFAULT_TTL_SECONDS);
        await this.ctx.storage.setAlarm(Date.now() + ttl * 1000);
        return { outcome, eventId: row.id };
      } catch (err) {
        log("error", "admit_failed", { source: ev.source, error: errorMessage(err) });
        return { outcome: "error", error: "persist_failed" };
      }
    });
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
