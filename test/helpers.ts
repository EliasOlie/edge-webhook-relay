import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index";
import { hmacSha256, toHex } from "../src/lib/crypto";

export const BASE = "https://relay.test";

export async function call(input: string, init?: RequestInit): Promise<Response> {
  const request = new Request(input.startsWith("http") ? input : `${BASE}${input}`, init) as Request<
    unknown,
    IncomingRequestCfProperties
  >;
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function hubSignature(secret: string, body: string): Promise<string> {
  return `sha256=${toHex(await hmacSha256(secret, body))}`;
}

export async function stripeSignature(secret: string, body: string, unixSeconds: number): Promise<string> {
  return `t=${unixSeconds},v1=${toHex(await hmacSha256(secret, `${unixSeconds}.${body}`))}`;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const uid = () => crypto.randomUUID();

export function whatsappMessageBody(messageId: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "0",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: "0" },
              messages: [{ id: messageId, from: "15550000001", type: "text", text: { body: "hi" } }],
            },
          },
        ],
      },
    ],
  });
}

export function whatsappStatusBody(messageId: string, status: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "0", changes: [{ field: "messages", value: { statuses: [{ id: messageId, status }] } }] }],
  });
}

export function stripeEventBody(eventId: string): string {
  return JSON.stringify({ id: eventId, object: "event", type: "payment_intent.succeeded", data: { object: {} } });
}

export async function postWhatsApp(body: string): Promise<Response> {
  return call("/in/whatsapp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": await hubSignature(env.WHATSAPP_APP_SECRET, body),
    },
    body,
  });
}

export async function postStripe(body: string): Promise<Response> {
  return call("/in/stripe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": await stripeSignature(env.STRIPE_WEBHOOK_SECRET, body, nowSeconds()),
    },
    body,
  });
}

export function admin(path: string, init: RequestInit = {}, token = env.ADMIN_TOKEN): Promise<Response> {
  return call(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}
