import { defineConfig } from "vitest/config";

import { BUDGETS } from "@mailda/budgets";

/**
 * The checks that cannot run inside workerd.
 *
 * `test/node/` holds tests about the repository itself — what `wrangler.jsonc` declares, what a
 * customer's deploy would provision — and those need a filesystem, which the Workers runtime does not
 * have. A separate config rather than a `projects` block in `vitest.config.ts` because that config carries
 * the Cloudflare pool, and restructuring it to add a second environment would put a stable suite at risk
 * for no gain.
 *
 * That reason used to read "the measured timeouts and the Cloudflare pool", which is how the timeouts below
 * came to be missing for three weeks — see the note on them. The pool is a real reason for a separate file.
 * A budget is one import, and was never a reason for anything.
 *
 * Run by the package's `test` script, so these are not a second thing to remember.
 */
export default defineConfig({
  test: {
    include: ["test/node/**/*.test.ts"],
    environment: "node",

    // The same measured budget `vitest.config.ts` carries, and the paragraph above is why this line was
    // missing for three weeks: it names that config as "the one carrying the measured timeouts" and then
    // inherits vitest's 5,000 ms default anyway. A sentence about where the fix lives is not the fix.
    //
    // It came back exactly as the receipt describes. `test/node/attach-queue-consumer.test.ts` spawns four
    // Node processes per case — the script under test, plus the three `npx wrangler` calls it makes — and
    // runs each case in 99–364 ms idle. Under `turbo test` one was measured at **5,481 ms** and failed.
    // That is inside the 5,790 ms the receipt already recorded as this machine's worst case under load, so
    // the budget needed applying here, not re-measuring.
    //
    // `test/node/vitest-timeout-world.test.ts` now resolves every config in the repository and asserts this
    // value, so a fourth config cannot repeat it.
    testTimeout: BUDGETS["test.timeout_ms"],
    hookTimeout: BUDGETS["test.hook_timeout_ms"],

    // Same as `vitest.config.ts`, and for the same reason the timeouts above are here: the CI headroom
    // ceiling read one report — the workerd suite's — so the check that exists to catch a test creeping
    // toward the timeout was not looking at the suite that breached it. `.github/scripts/test-headroom.mjs`
    // reads all three now.
    reporters: process.env.CI === undefined
      ? ["default"]
      : ["default", ["json", { outputFile: "./.vitest-report-node.json" }]],
  },
});
