import { defineConfig } from "vitest/config";

/**
 * The checks that cannot run inside workerd.
 *
 * `test/node/` holds tests about the repository itself — what `wrangler.jsonc` declares, what a
 * customer's deploy would provision — and those need a filesystem, which the Workers runtime does not
 * have. A separate config rather than a `projects` block in `vitest.config.ts` because that config is
 * the one carrying the measured timeouts and the Cloudflare pool, and restructuring it to add a second
 * environment would put the suite I have just stabilised at risk for no gain.
 *
 * Run by the package's `test` script, so these are not a second thing to remember.
 */
export default defineConfig({
  test: {
    include: ["test/node/**/*.test.ts"],
    environment: "node",
  },
});
