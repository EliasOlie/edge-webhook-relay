import type { D1Migration } from "cloudflare:test";
import type { Env as RelayEnv } from "../src/env";

// Types `env` from "cloudflare:workers" inside tests: the Worker's Env plus
// the test-only bindings configured in vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {
      TEST_MIGRATIONS: D1Migration[];
      ADMIN_TOKEN: string;
      RELAY_SIGNING_SECRET: string;
      WHATSAPP_APP_SECRET: string;
      WHATSAPP_VERIFY_TOKEN: string;
      STRIPE_WEBHOOK_SECRET: string;
      GITHUB_WEBHOOK_SECRET: string;
      ACME_WEBHOOK_SECRET: string;
    }
  }
}
