import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Read at config time in Node, handed to the test worker as a binding so
// applyD1Migrations() can run them inside the Workers runtime.
const migrations = await readD1Migrations(resolve(import.meta.dirname, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      verbose: true,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
        r2Buckets: ["EVIDENCE"],
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
