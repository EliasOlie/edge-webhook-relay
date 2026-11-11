import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getHistory } from "../src/store/events";
import {
  call,
  hubSignature,
  postStripe,
  postWhatsApp,
  stripeEventBody,
  uid,
  whatsappMessageBody,
  whatsappStatusBody,
} from "./helpers";

async function rowsForKey(source: string, key: string) {
  const { results } = await env.DB.prepare("SELECT * FROM events WHERE source = ? AND idempotency_key = ?")
    .bind(source, key)
    .all<{ id: string; status: string; enqueued_at: number | null; payload: string }>();
  return results;
}

describe("ingest + idempotency", () => {
  it("accepts a new event with 202, persists it and marks it enqueued", async () => {
    const wamid = `wamid.${uid()}`;
    const body = whatsappMessageBody(wamid);
    const res = await postWhatsApp(body);
    expect(res.status).toBe(202);
    const json = await res.json<{ accepted: boolean; id: string }>();
    expect(json.accepted).toBe(true);

    const rows = await rowsForKey("whatsapp", `msg:${wamid}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(json.id);
    expect(rows[0]?.status).toBe("received");
    expect(rows[0]?.enqueued_at).not.toBeNull();
    expect(rows[0]?.payload).toBe(body); // byte-identical payload is stored

    const kinds = (await getHistory(env.DB, json.id)).map((h) => h.kind);
    expect(kinds).toEqual(["received", "enqueued"]);
  });

  it("suppresses a sequential duplicate: 200 duplicate=true, same id, nothing re-enqueued", async () => {
    const id = `evt_${uid()}`;
    const first = await postStripe(stripeEventBody(id));
    const second = await postStripe(stripeEventBody(id));
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    const a = await first.json<{ id: string }>();
    const b = await second.json<{ id: string; duplicate: boolean }>();
    expect(b).toEqual({ duplicate: true, id: a.id });

    expect(await rowsForKey("stripe", id)).toHaveLength(1);
    const enqueues = (await getHistory(env.DB, a.id)).filter((h) => h.kind === "enqueued");
    expect(enqueues).toHaveLength(1);
  });

  it("is race-free: concurrent identical requests yield exactly one accepted event", async () => {
    const wamid = `wamid.${uid()}`;
    const body = whatsappMessageBody(wamid);
    const responses = await Promise.all(Array.from({ length: 5 }, () => postWhatsApp(body)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 202]);

    const ids = new Set(await Promise.all(responses.map(async (r) => (await r.json<{ id: string }>()).id)));
    expect(ids.size).toBe(1);

    const rows = await rowsForKey("whatsapp", `msg:${wamid}`);
    expect(rows).toHaveLength(1);
    const enqueues = (await getHistory(env.DB, rows[0]!.id)).filter((h) => h.kind === "enqueued");
    expect(enqueues).toHaveLength(1);
  });

  it("treats WhatsApp status transitions of one message as distinct events", async () => {
    const wamid = `wamid.${uid()}`;
    expect((await postWhatsApp(whatsappStatusBody(wamid, "sent"))).status).toBe(202);
    expect((await postWhatsApp(whatsappStatusBody(wamid, "delivered"))).status).toBe(202);
    expect((await postWhatsApp(whatsappStatusBody(wamid, "delivered"))).status).toBe(200);
  });

  it("uses X-GitHub-Delivery as the key (redelivery with same id is a duplicate)", async () => {
    const delivery = uid();
    const send = async (body: string) =>
      call("/in/github", {
        method: "POST",
        headers: {
          "x-github-delivery": delivery,
          "x-hub-signature-256": await hubSignature(env.GITHUB_WEBHOOK_SECRET, body),
        },
        body,
      });
    expect((await send('{"action":"opened"}')).status).toBe(202);
    expect((await send('{"action":"opened"}')).status).toBe(200);
  });

  it("falls back to SHA-256 of the body for generic sources without a delivery header", async () => {
    const body = JSON.stringify({ n: uid() });
    const send = async () =>
      call("/in/acme", {
        method: "POST",
        headers: { "x-acme-signature": await hubSignature(env.ACME_WEBHOOK_SECRET, body) },
        body,
      });
    const first = await send();
    expect(first.status).toBe(202);
    expect((await send()).status).toBe(200);
    const { results } = await env.DB.prepare("SELECT idempotency_key FROM events WHERE payload = ?")
      .bind(body)
      .all<{ idempotency_key: string }>();
    expect(results[0]?.idempotency_key).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects oversized bodies with 413", async () => {
    const big = "x".repeat(300 * 1024);
    const res = await call("/in/acme", { method: "POST", headers: { "x-acme-signature": "sha256=00" }, body: big });
    expect(res.status).toBe(413);
  });

  it("serves /health and 404s everything else", async () => {
    expect(await (await call("/health")).json()).toEqual({ ok: true });
    expect((await call("/nope")).status).toBe(404);
  });
});
