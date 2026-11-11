import { handleDeadLetterBatch, handleDeliveryBatch } from "./delivery/consumer";
import type { DeliveryMessage, Env } from "./env";
import { handleAdmin } from "./http/admin";
import { handleIngest } from "./http/ingest";
import { json, problem } from "./lib/http";
import { errorMessage, log } from "./lib/log";

export { IdempotencyGuard } from "./dedup/guard";

const INGEST_ROUTE = /^\/in\/([a-z0-9_-]{1,64})$/;

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/health" && request.method === "GET") return json({ ok: true });

      const ingest = INGEST_ROUTE.exec(pathname);
      if (ingest?.[1]) return await handleIngest(request, env, ingest[1]);

      if (pathname.startsWith("/admin/")) return await handleAdmin(request, env, pathname);

      return problem(404, "not_found");
    } catch (err) {
      log("error", "unhandled_error", { path: pathname, error: errorMessage(err) });
      return problem(500, "internal_error");
    }
  },

  async queue(batch, env, _ctx): Promise<void> {
    if (batch.queue === env.DEAD_LETTER_QUEUE) await handleDeadLetterBatch(batch, env);
    else await handleDeliveryBatch(batch, env);
  },
} satisfies ExportedHandler<Env, DeliveryMessage>;
