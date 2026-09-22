import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Short timeouts so expiry can be exercised in tests.
      miniflare: { bindings: { AGENT_OFFLINE_MS: "150", LOCK_CLEAN_GRACE_MS: "600000" } },
    }),
  ],
});
