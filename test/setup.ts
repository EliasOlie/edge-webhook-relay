import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: only un-applied migrations run.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
