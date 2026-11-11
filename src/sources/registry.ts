import type { Env } from "../env";
import { generic } from "./generic";
import { github } from "./github";
import { stripe } from "./stripe";
import type { SourceConfig, SourceType, SourceVerifier } from "./types";
import { whatsapp } from "./whatsapp";

const verifiers: { [T in SourceType]: SourceVerifier<Extract<SourceConfig, { type: T }>> } = {
  whatsapp,
  stripe,
  github,
  generic,
};

export function verifierFor<C extends SourceConfig>(config: C): SourceVerifier<C> {
  return verifiers[config.type] as unknown as SourceVerifier<C>;
}

let cachedRaw: unknown;
let cachedSources: Record<string, SourceConfig> = {};

/** Reads SOURCES (object or JSON string) and validates the minimum shape. */
export function loadSources(env: Env): Record<string, SourceConfig> {
  if (env.SOURCES === cachedRaw) return cachedSources;
  const raw = typeof env.SOURCES === "string" ? (JSON.parse(env.SOURCES) as unknown) : env.SOURCES;
  if (!raw || typeof raw !== "object") throw new Error("SOURCES must be an object");

  const out: Record<string, SourceConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const cfg = value as Partial<SourceConfig>;
    if (!/^[a-z0-9_-]{1,64}$/.test(name)) throw new Error(`invalid source name: ${name}`);
    if (!cfg.type || !(cfg.type in verifiers)) throw new Error(`source ${name}: unknown type`);
    if (typeof cfg.destination !== "string" || typeof cfg.secret !== "string") {
      throw new Error(`source ${name}: destination and secret are required`);
    }
    if (cfg.type === "generic" && typeof cfg.signatureHeader !== "string") {
      throw new Error(`source ${name}: signatureHeader is required for generic sources`);
    }
    out[name] = cfg as SourceConfig;
  }
  cachedRaw = env.SOURCES;
  cachedSources = out;
  return out;
}
