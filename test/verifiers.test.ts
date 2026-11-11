import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hmacSha256, toBase64, toHex, utf8 } from "../src/lib/crypto";
import { generic } from "../src/sources/generic";
import { github } from "../src/sources/github";
import { parseStripeSignature, stripe } from "../src/sources/stripe";
import type { GenericSourceConfig, StripeSourceConfig, WebhookInput } from "../src/sources/types";
import { whatsapp } from "../src/sources/whatsapp";
import {
  call,
  hubSignature,
  nowSeconds,
  stripeEventBody,
  stripeSignature,
  uid,
  whatsappMessageBody,
  whatsappStatusBody,
} from "./helpers";

function input(body: string, headers: Record<string, string>, now = Date.now()): WebhookInput {
  return { headers: new Headers(headers), rawBody: utf8(body), text: body, now };
}

const SECRET = "unit-test-secret";

describe("whatsapp verifier", () => {
  const cfg = { type: "whatsapp", destination: "https://d.test", secret: "X" } as const;

  it("accepts a valid X-Hub-Signature-256", async () => {
    const body = whatsappMessageBody("wamid.A");
    const res = await whatsapp.verify(input(body, { "x-hub-signature-256": await hubSignature(SECRET, body) }), cfg, SECRET);
    expect(res).toEqual({ ok: true });
  });

  it("rejects a signature made with another secret", async () => {
    const body = whatsappMessageBody("wamid.A");
    const res = await whatsapp.verify(input(body, { "x-hub-signature-256": await hubSignature("other", body) }), cfg, SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects when the body was modified after signing (verifies the RAW body)", async () => {
    const body = whatsappMessageBody("wamid.A");
    const sig = await hubSignature(SECRET, body);
    // Same JSON, different bytes: re-serialized with whitespace.
    const reformatted = JSON.stringify(JSON.parse(body), null, 2);
    const res = await whatsapp.verify(input(reformatted, { "x-hub-signature-256": sig }), cfg, SECRET);
    expect(res.ok).toBe(false);
  });

  it("rejects missing and malformed headers", async () => {
    const body = "{}";
    expect(await whatsapp.verify(input(body, {}), cfg, SECRET)).toEqual({ ok: false, reason: "missing_signature" });
    expect(await whatsapp.verify(input(body, { "x-hub-signature-256": "sha256=zz" }), cfg, SECRET)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("derives keys from message ids and from (status id, status) pairs", () => {
    expect(whatsapp.idempotencyKey(input(whatsappMessageBody("wamid.X"), {}), cfg)).toBe("msg:wamid.X");
    const sent = whatsapp.idempotencyKey(input(whatsappStatusBody("wamid.Y", "sent"), {}), cfg);
    const read = whatsapp.idempotencyKey(input(whatsappStatusBody("wamid.Y", "read"), {}), cfg);
    expect(sent).toBe("status:wamid.Y:sent");
    expect(read).not.toBe(sent);
    expect(whatsapp.idempotencyKey(input("{}", {}), cfg)).toBeNull();
  });
});

describe("whatsapp subscription handshake (GET hub.challenge)", () => {
  it("echoes hub.challenge when the verify token matches", async () => {
    const qs = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": env.WHATSAPP_VERIFY_TOKEN,
      "hub.challenge": "1158201444",
    });
    const res = await call(`/in/whatsapp?${qs}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
  });

  it("returns 403 for a wrong verify token or mode", async () => {
    const wrongToken = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" });
    expect((await call(`/in/whatsapp?${wrongToken}`)).status).toBe(403);
    const wrongMode = new URLSearchParams({
      "hub.mode": "unsubscribe",
      "hub.verify_token": env.WHATSAPP_VERIFY_TOKEN,
      "hub.challenge": "1",
    });
    expect((await call(`/in/whatsapp?${wrongMode}`)).status).toBe(403);
  });

  it("does not offer a handshake for sources without one", async () => {
    expect((await call("/in/stripe")).status).toBe(405);
  });
});

describe("stripe verifier", () => {
  const cfg: StripeSourceConfig = { type: "stripe", destination: "https://d.test", secret: "X", toleranceSeconds: 300 };
  const body = stripeEventBody("evt_123");

  it("accepts a fresh, valid signature", async () => {
    const header = await stripeSignature(SECRET, body, nowSeconds());
    expect(await stripe.verify(input(body, { "stripe-signature": header }), cfg, SECRET)).toEqual({ ok: true });
  });

  it("accepts when any of several v1 signatures matches (secret rotation)", async () => {
    const t = nowSeconds();
    const good = (await stripeSignature(SECRET, body, t)).split(",")[1];
    const header = `t=${t},v1=${"0".repeat(64)},${good}`;
    expect(await stripe.verify(input(body, { "stripe-signature": header }), cfg, SECRET)).toEqual({ ok: true });
  });

  it("rejects a stale timestamp even with a valid MAC", async () => {
    const stale = nowSeconds() - 301;
    const header = await stripeSignature(SECRET, body, stale);
    expect(await stripe.verify(input(body, { "stripe-signature": header }), cfg, SECRET)).toEqual({
      ok: false,
      reason: "timestamp_out_of_tolerance",
    });
  });

  it("rejects a timestamp too far in the future", async () => {
    const header = await stripeSignature(SECRET, body, nowSeconds() + 600);
    expect((await stripe.verify(input(body, { "stripe-signature": header }), cfg, SECRET)).ok).toBe(false);
  });

  it("rejects a bad signature and malformed headers", async () => {
    const header = await stripeSignature("whsec_other", body, nowSeconds());
    expect(await stripe.verify(input(body, { "stripe-signature": header }), cfg, SECRET)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect((await stripe.verify(input(body, { "stripe-signature": "garbage" }), cfg, SECRET)).ok).toBe(false);
    expect((await stripe.verify(input(body, {}), cfg, SECRET)).ok).toBe(false);
  });

  it("parses the header and uses the event id as idempotency key", () => {
    expect(parseStripeSignature("t=10,v1=aa,v0=bb,v1=cc")).toEqual({ timestamp: 10, v1: ["aa", "cc"] });
    expect(stripe.idempotencyKey(input(body, {}), cfg)).toBe("evt_123");
  });
});

describe("github verifier", () => {
  const cfg = { type: "github", destination: "https://d.test", secret: "X" } as const;

  it("accepts a valid signature and uses X-GitHub-Delivery as key", async () => {
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const headers = { "x-hub-signature-256": await hubSignature(SECRET, body), "x-github-delivery": "d-1" };
    expect(await github.verify(input(body, headers), cfg, SECRET)).toEqual({ ok: true });
    expect(github.idempotencyKey(input(body, headers), cfg)).toBe("d-1");
  });

  it("rejects a bad signature", async () => {
    const body = "{}";
    const headers = { "x-hub-signature-256": await hubSignature("wrong", body) };
    expect((await github.verify(input(body, headers), cfg, SECRET)).ok).toBe(false);
  });
});

describe("generic HMAC verifier", () => {
  const hexCfg: GenericSourceConfig = {
    type: "generic",
    destination: "https://d.test",
    secret: "X",
    signatureHeader: "x-signature",
    signaturePrefix: "sha256=",
    idempotencyHeader: "x-delivery",
  };
  const b64Cfg: GenericSourceConfig = { type: "generic", destination: "https://d.test", secret: "X", signatureHeader: "x-sig", encoding: "base64" };
  const body = '{"hello":"world"}';

  it("accepts hex with prefix and base64 encodings", async () => {
    const mac = await hmacSha256(SECRET, body);
    expect(await generic.verify(input(body, { "x-signature": `sha256=${toHex(mac)}` }), hexCfg, SECRET)).toEqual({ ok: true });
    expect(await generic.verify(input(body, { "x-sig": toBase64(mac) }), b64Cfg, SECRET)).toEqual({ ok: true });
  });

  it("rejects wrong prefix, wrong MAC and missing header", async () => {
    const mac = await hmacSha256(SECRET, body);
    expect((await generic.verify(input(body, { "x-signature": toHex(mac) }), hexCfg, SECRET)).ok).toBe(false);
    const other = await hmacSha256("nope", body);
    expect((await generic.verify(input(body, { "x-signature": `sha256=${toHex(other)}` }), hexCfg, SECRET)).ok).toBe(false);
    expect((await generic.verify(input(body, {}), hexCfg, SECRET)).ok).toBe(false);
  });

  it("uses the configured idempotency header, else falls back (null)", () => {
    expect(generic.idempotencyKey(input(body, { "x-delivery": "abc" }), hexCfg)).toBe("abc");
    expect(generic.idempotencyKey(input(body, {}), b64Cfg)).toBeNull();
  });
});

describe("ingest endpoint rejects unauthenticated requests", () => {
  it("returns 401 for a bad WhatsApp signature and records nothing", async () => {
    const body = whatsappMessageBody(`wamid.${uid()}`);
    const res = await call("/in/whatsapp", {
      method: "POST",
      headers: { "x-hub-signature-256": await hubSignature("forged", body) },
      body,
    });
    expect(res.status).toBe(401);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE payload = ?").bind(body).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("returns 401 for a stale Stripe request", async () => {
    const body = stripeEventBody(`evt_${uid()}`);
    const res = await call("/in/stripe", {
      method: "POST",
      headers: { "stripe-signature": await stripeSignature(env.STRIPE_WEBHOOK_SECRET, body, nowSeconds() - 3600) },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown sources", async () => {
    expect((await call("/in/nope", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
