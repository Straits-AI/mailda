import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

import { BUDGETS } from "@mailda/budgets";

// Read at config time in Node, handed to the test worker as a binding so
// applyD1Migrations() can run them inside the Workers runtime.
const migrations = await readD1Migrations(resolve(import.meta.dirname, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      verbose: true,
      wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
        r2Buckets: ["EVIDENCE"],
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],

    // test/node/ holds checks about the repository itself, which need a filesystem. They run under
    // vitest.node.config.ts; without this they would be picked up here and fail inside workerd.
    exclude: [...configDefaults.exclude, "test/node/**"],

    // Measured, not inherited. Vitest's 5,000 ms default was already breached by a legitimate test
    // on an ordinarily-busy machine (5,790 ms worst case under load), and one breach cascades: the
    // isolated-storage undo stack is left unbalanced, so later tests in the same file fail for
    // reasons of their own. That is what made this suite look flaky rather than slow.
    //
    // See docs/receipts/test-timeout-headroom.md for the measurement and for the two fixes that were
    // deliberately rejected — `retry`, which would have gone green by muting the problem, and
    // cheaper PBKDF2 in tests, which would re-open the platform-ceiling landmine.
    testTimeout: BUDGETS["test.timeout_ms"],
    hookTimeout: BUDGETS["test.hook_timeout_ms"],

    // On CI, also emit a machine-readable report so the workflow can show how close the slowest test
    // came to the timeout above. Same run, not a second one — re-running the suite to measure it would
    // double the slowest job for a number the first run already knows.
    reporters: process.env.CI === undefined
      ? ["default"]
      : ["default", ["json", { outputFile: "./.vitest-report.json" }]],
  },
});
