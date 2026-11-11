import type { Env } from "../env";
import { constantTimeEqualStrings } from "../lib/crypto";
import { json, problem } from "../lib/http";
import { log } from "../lib/log";
import {
  EVENT_STATUSES,
  getEvent,
  getHistory,
  listDeadIds,
  listEvents,
  markReplayed,
  type EventStatus,
} from "../store/events";

const MAX_LIST = 200;
/** Queue sendBatch accepts at most 100 messages. */
const DLQ_REPLAY_BATCH = 100;

async function authorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false; // Admin API is disabled until a token is configured.
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) return false;
  return constantTimeEqualStrings(match[1].trim(), expected);
}

/**
 * Admin API (bearer token):
 *   GET  /admin/events?status=&source=&limit=&before=
 *   GET  /admin/events/:id
 *   POST /admin/events/:id/replay[?force=true]
 *   POST /admin/dlq/replay
 */
export async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  if (!(await authorized(request, env))) {
    return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="admin"' });
  }
  const url = new URL(request.url);
  const method = request.method;

  if (path === "/admin/events" && method === "GET") {
    const status = url.searchParams.get("status") ?? undefined;
    if (status && !EVENT_STATUSES.includes(status as EventStatus)) return problem(400, "invalid_status");
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw ? Number(beforeRaw) : undefined;
    if (before !== undefined && !Number.isFinite(before)) return problem(400, "invalid_before");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), MAX_LIST);

    const events = await listEvents(env.DB, {
      status: status as EventStatus | undefined,
      source: url.searchParams.get("source") ?? undefined,
      before,
      limit,
    });
    const last = events.at(-1);
    return json({ events, next_before: events.length === limit && last ? last.received_at : null });
  }

  const one = /^\/admin\/events\/([0-9a-f-]{36})(\/replay)?$/.exec(path);
  if (one?.[1]) {
    const id = one[1];
    const event = await getEvent(env.DB, id);
    if (!event) return problem(404, "event_not_found");

    if (!one[2] && method === "GET") {
      return json({ event, history: await getHistory(env.DB, id) });
    }
    if (one[2] && method === "POST") {
      const force = url.searchParams.get("force") === "true";
      if (event.status === "delivered" && !force) {
        return problem(409, "already_delivered", { hint: "pass ?force=true to redeliver" });
      }
      await markReplayed(env.DB, id, "admin");
      await env.DELIVERY_QUEUE.send({ eventId: id });
      log("info", "admin_replay", { event_id: id, previous_status: event.status, force });
      return json({ replayed: true, id }, 202);
    }
    return problem(405, "method_not_allowed");
  }

  if (path === "/admin/dlq/replay" && method === "POST") {
    const ids = await listDeadIds(env.DB, DLQ_REPLAY_BATCH);
    for (const id of ids) await markReplayed(env.DB, id, "admin:dlq");
    if (ids.length > 0) await env.DELIVERY_QUEUE.sendBatch(ids.map((eventId) => ({ body: { eventId } })));
    log("info", "admin_dlq_replay", { count: ids.length });
    return json({ replayed: ids.length, ids, more: ids.length === DLQ_REPLAY_BATCH }, 202);
  }

  return problem(404, "not_found");
}
