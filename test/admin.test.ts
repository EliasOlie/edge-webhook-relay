import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getEvent, getHistory, markDead } from "../src/store/events";
import { admin, call, postStripe, stripeEventBody, uid } from "./helpers";

async function newEvent(): Promise<string> {
  const res = await postStripe(stripeEventBody(`evt_${uid()}`));
  return (await res.json<{ id: string }>()).id;
}

describe("admin auth", () => {
  it("requires a bearer token", async () => {
    const res = await call("/admin/events");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a wrong token", async () => {
    expect((await admin("/admin/events", {}, "wrong-token")).status).toBe(401);
    expect((await admin("/admin/dlq/replay", { method: "POST" }, "")).status).toBe(401);
  });

  it("accepts the configured token", async () => {
    expect((await admin("/admin/events")).status).toBe(200);
  });
});

describe("admin events API", () => {
  it("lists with status/source filters and hides payloads", async () => {
    const id = await newEvent();
    const res = await admin("/admin/events?status=received&source=stripe&limit=200");
    expect(res.status).toBe(200);
    const { events } = await res.json<{ events: Array<Record<string, unknown>> }>();
    expect(events.some((e) => e.id === id)).toBe(true);
    expect(events.every((e) => e.status === "received" && e.source === "stripe")).toBe(true);
    expect(events[0]).not.toHaveProperty("payload");

    expect((await admin("/admin/events?status=bogus")).status).toBe(400);
  });

  it("returns one event with its payload and audit history", async () => {
    const id = await newEvent();
    const res = await admin(`/admin/events/${id}`);
    const body = await res.json<{ event: { id: string; payload: string }; history: Array<{ kind: string }> }>();
    expect(body.event.id).toBe(id);
    expect(JSON.parse(body.event.payload).object).toBe("event");
    expect(body.history.map((h) => h.kind)).toEqual(["received", "enqueued"]);
    expect((await admin(`/admin/events/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it("replays a single event: resets status, records audit entry, re-enqueues", async () => {
    const id = await newEvent();
    await markDead(env.DB, id, "test");
    const res = await admin(`/admin/events/${id}/replay`, { method: "POST" });
    expect(res.status).toBe(202);
    expect((await getEvent(env.DB, id))?.status).toBe("received");
    const history = await getHistory(env.DB, id);
    expect(history.at(-1)).toMatchObject({ kind: "replay", detail: { actor: "admin" } });
  });

  it("refuses to replay a delivered event unless forced", async () => {
    const id = await newEvent();
    await env.DB.prepare("UPDATE events SET status = 'delivered' WHERE id = ?").bind(id).run();
    expect((await admin(`/admin/events/${id}/replay`, { method: "POST" })).status).toBe(409);
    expect((await admin(`/admin/events/${id}/replay?force=true`, { method: "POST" })).status).toBe(202);
  });

  it("replays the dead-letter backlog", async () => {
    const a = await newEvent();
    const b = await newEvent();
    await markDead(env.DB, a, "test");
    await markDead(env.DB, b, "test");

    const res = await admin("/admin/dlq/replay", { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json<{ replayed: number; ids: string[] }>();
    expect(body.ids).toEqual(expect.arrayContaining([a, b]));
    expect((await getEvent(env.DB, a))?.status).toBe("received");
    expect((await getEvent(env.DB, b))?.status).toBe("received");

    // Replayed events left the dead set, so a second call does not pick them up again.
    const again = await (await admin("/admin/dlq/replay", { method: "POST" })).json<{ ids: string[] }>();
    expect(again.ids).not.toContain(a);
    expect(again.ids).not.toContain(b);
  });
});
