import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffSeconds } from "../src/delivery/backoff";
import { signDelivery } from "../src/delivery/sign";
import type { DeliveryMessage } from "../src/env";
import worker from "../src/index";
import { getEvent, getHistory } from "../src/store/events";
import { postStripe, stripeEventBody, uid } from "./helpers";

async function newEvent(): Promise<string> {
  const res = await postStripe(stripeEventBody(`evt_${uid()}`));
  expect(res.status).toBe(202);
  return (await res.json<{ id: string }>()).id;
}

async function runQueue(queue: string, eventId: string, attempts = 1) {
  const batch = createMessageBatch<DeliveryMessage>(queue, [
    { id: `msg-${uid()}`, timestamp: Date.now(), attempts, body: { eventId } },
  ]);
  // Observe the requested retry delay (the queue result only records that a retry happened).
  const retrySpy = vi.spyOn(batch.messages[0]!, "retry");
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  return { ...result, retryDelays: retrySpy.mock.calls.map(([opts]) => opts?.delaySeconds) };
}

function mockDestination(response: Response | Error) {
  const spy = vi.spyOn(globalThis, "fetch");
  if (response instanceof Error) spy.mockRejectedValue(response);
  else spy.mockResolvedValue(response);
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("delivery consumer", () => {
  it("delivers with Idempotency-Key and a verifiable relay signature, then acks", async () => {
    const id = await newEvent();
    const spy = mockDestination(new Response("ok", { status: 200 }));

    const result = await runQueue("webhook-deliveries", id);
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toHaveLength(0);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://billing.example.com/webhooks/stripe");
    const headers = new Headers(init?.headers);
    expect(headers.get("idempotency-key")).toBe(id);
    expect(headers.get("x-relay-source")).toBe("stripe");
    expect(headers.get("x-relay-attempt")).toBe("1");

    // Downstream verification: recompute the MAC from the same inputs.
    const event = await getEvent(env.DB, id);
    expect(init?.body).toBe(event?.payload);
    const sig = headers.get("x-relay-signature")!;
    const t = Number(/t=(\d+)/.exec(sig)?.[1]);
    expect(sig).toBe(await signDelivery(env.RELAY_SIGNING_SECRET, id, event!.payload, t * 1000));

    expect(event?.status).toBe("delivered");
    expect(event?.attempts).toBe(1);
    expect(event?.delivered_at).not.toBeNull();
  });

  it("retries 5xx with exponential backoff and records the failure", async () => {
    const id = await newEvent();
    mockDestination(new Response("busy", { status: 503 }));

    const first = await runQueue("webhook-deliveries", id, 1);
    expect(first.explicitAcks).toHaveLength(0);
    expect(first.retryMessages).toHaveLength(1);
    expect(first.retryDelays).toEqual([10]);

    const third = await runQueue("webhook-deliveries", id, 3);
    expect(third.retryDelays).toEqual([40]);

    const event = await getEvent(env.DB, id);
    expect(event?.status).toBe("failed");
    expect(event?.attempts).toBe(2);
    expect(event?.last_error).toBe("http_503");
  });

  it("retries network errors and 429", async () => {
    const id = await newEvent();
    mockDestination(new TypeError("connection refused"));
    expect((await runQueue("webhook-deliveries", id)).retryMessages).toHaveLength(1);
    vi.restoreAllMocks();
    mockDestination(new Response(null, { status: 429 }));
    expect((await runQueue("webhook-deliveries", id)).retryMessages).toHaveLength(1);
    expect((await getEvent(env.DB, id))?.last_error).toBe("http_429");
  });

  it("does not retry a permanent 4xx: marks the event dead and acks", async () => {
    const id = await newEvent();
    mockDestination(new Response("bad", { status: 400 }));
    const result = await runQueue("webhook-deliveries", id);
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toHaveLength(0);
    const event = await getEvent(env.DB, id);
    expect(event?.status).toBe("dead");
    expect(event?.last_error).toBe("http_400");
  });

  it("acks without calling the destination when the event is already delivered", async () => {
    const id = await newEvent();
    mockDestination(new Response("ok"));
    await runQueue("webhook-deliveries", id);
    vi.restoreAllMocks();

    const spy = mockDestination(new Response("ok"));
    const result = await runQueue("webhook-deliveries", id);
    expect(result.explicitAcks).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("dead-letter consumer marks the event dead and keeps the last real error", async () => {
    const id = await newEvent();
    mockDestination(new Response("busy", { status: 502 }));
    await runQueue("webhook-deliveries", id, 1);

    const result = await runQueue("webhook-deliveries-dlq", id, 9);
    expect(result.explicitAcks).toHaveLength(1);
    const event = await getEvent(env.DB, id);
    expect(event?.status).toBe("dead");
    expect(event?.last_error).toBe("http_502");
    const history = await getHistory(env.DB, id);
    expect(history.at(-1)).toMatchObject({ kind: "dead", detail: { reason: "max_retries_exhausted" } });
  });
});

describe("backoff", () => {
  it("doubles from the base and respects the cap", () => {
    expect([1, 2, 3, 4].map((n) => backoffSeconds(n))).toEqual([10, 20, 40, 80]);
    expect(backoffSeconds(20)).toBe(3600);
    expect(backoffSeconds(30, 10, 1e9)).toBe(43_200);
  });
});
