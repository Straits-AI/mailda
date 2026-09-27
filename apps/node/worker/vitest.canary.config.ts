import { defineConfig } from "vitest/config";

import workerd from "./vitest.config.ts";

/**
 * The workerd suite's own config, pointed at `test/canary/` alone.
 *
 * Everything that decides whether workerd's `uncaught exception` lines reach the output (the pool, its
 * `verbose` option) comes from `vitest.config.ts` unchanged, so the canary sees what the suite sees. Run only
 * by `test/node/fail-on-uncaught.test.ts`. The reporter is replaced rather than inherited because the
 * inherited one writes `.vitest-report.json` on CI, and that file is the workerd suite's report for
 * `.github/scripts/test-headroom.mjs`, which this one-test run would overwrite.
 */
export default defineConfig({
  ...workerd,
  test: { ...workerd.test, include: ["test/canary/**/*.canary.ts"], reporters: ["default"] },
});
