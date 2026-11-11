import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Tests drive the queue handler directly with createMessageBatch().
          // Miniflare merges these options into the ones read from wrangler.jsonc
          // (it cannot delete a consumer), so park the local consumers instead:
          // a batch only flushes at 100 messages or after 60 s, which a test run
          // never reaches. This keeps assertions deterministic.
          queueConsumers: {
            "webhook-deliveries": { maxBatchSize: 100, maxBatchTimeout: 60 },
            "webhook-deliveries-dlq": { maxBatchSize: 100, maxBatchTimeout: 60 },
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only values. Real secrets live in `wrangler secret put`.
            ADMIN_TOKEN: "test-admin-token",
            RELAY_SIGNING_SECRET: "test-relay-signing-secret",
            WHATSAPP_APP_SECRET: "test-whatsapp-app-secret",
            WHATSAPP_VERIFY_TOKEN: "test-verify-token",
            STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
            GITHUB_WEBHOOK_SECRET: "test-github-secret",
            ACME_WEBHOOK_SECRET: "test-acme-secret",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      // The Worker logs structured JSON on every request; only show it for failing tests.
      silent: "passed-only" as const,
    },
  };
});
