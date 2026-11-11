const encoder = new TextEncoder();

export function utf8(input: string): Uint8Array {
  return encoder.encode(input);
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Decodes a hex string. Returns null for malformed input instead of throwing. */
export function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Decodes standard or URL-safe base64. Returns null for malformed input. */
export function fromBase64(b64: string): Uint8Array | null {
  try {
    const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(normalized);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function hmacSha256(secret: string, data: Uint8Array | string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const payload = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return toHex(await sha256(data));
}

/**
 * Constant-time comparison of two byte arrays. Length is not treated as
 * secret (all signatures we compare have a fixed, public length).
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Constant-time comparison of two arbitrary strings (e.g. bearer tokens).
 * Both sides are hashed first so neither the content nor the length of the
 * expected value leaks through timing.
 */
export async function constantTimeEqualStrings(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return constantTimeEqual(ha, hb);
}

/** Checks `sha256=<hex>`-style HMAC signatures over a raw body. */
export async function verifyHexHmac(
  secret: string,
  rawBody: Uint8Array,
  providedHex: string,
): Promise<boolean> {
  const provided = fromHex(providedHex);
  if (!provided) return false;
  const expected = await hmacSha256(secret, rawBody);
  return constantTimeEqual(expected, provided);
}
