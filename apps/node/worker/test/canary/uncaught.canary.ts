import { env } from "cloudflare:test";
import { expect, it } from "vitest";

/**
 * A throw across RPC that the caller catches, planted so that `scripts/fail-on-uncaught.mjs` has a line to see.
 *
 * Miniflare's Workflow binding throws inside its own objects when asked for an instance that was never
 * created, and workerd logs each of those throws as `uncaught exception` although this test catches the
 * rejection: three lines, measured on 27 September 2026. `test/node/fail-on-uncaught.test.ts` runs this file
 * through the guard and expects it to fail, which is the only proof that the guard can still read workerd's
 * lines from the real pool. Kept out of the workerd suite by its suffix, since there it would fail every run.
 */
it("asks the Workflow binding for an instance that was never created, and catches the refusal", async () => {
  await expect((env as unknown as Env).BUTLER_RUNS.get("uncaught-canary")).rejects.toThrow();
});
