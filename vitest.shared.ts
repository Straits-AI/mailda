import { readFileSync } from "node:fs";

/**
 * The measured test timeouts, for every package's vitest config.
 *
 * ## Why this is a root module and not an import of `@mailda/budgets`
 *
 * Six packages ran `vitest run` with no config at all, so all six inherited vitest's 5,000 ms default — the
 * default [test-timeout-headroom](./docs/receipts/test-timeout-headroom.md) exists to reject, and the one
 * that produced a flake in `packages/evidence` while the worker's own configs were being fixed.
 *
 * The obvious fix — have each package import `BUDGETS` — cannot be taken by one of them. `packages/receipts`
 * **generates** `packages/budgets/src/generated.ts`, so depending on it would point a package at its own
 * output. Adding the dependency to five of six and exempting the sixth would leave the gap exactly where it
 * was, in the package that is hardest to reason about.
 *
 * So the value is read from the generated file here, by the same regex
 * `.github/scripts/test-headroom.mjs` uses and for the same reason it gives: this runs before any build step
 * and `generated.ts` is TypeScript. Test infrastructure sits **above** the package dependency graph, which is
 * where it belongs — a config is not part of the package's own dependency closure.
 *
 * `receipts:check` regenerates that file and fails on a diff, so the number here cannot drift from the
 * receipt that measured it.
 */

const GENERATED = new URL("./packages/budgets/src/generated.ts", import.meta.url).pathname;

function budget(name: string): number {
  const source = readFileSync(GENERATED, "utf8");
  const found = new RegExp(`"${name.replace(".", "\\.")}":\\s*(\\d+)`).exec(source);
  if (found === null) {
    /*
     * Thrown rather than defaulted. A missing budget silently becoming `undefined` is how a config comes to
     * carry vitest's default while looking like it carries a measurement, which is the whole defect this
     * module exists to close.
     */
    throw new Error(
      `${name} is not in packages/budgets/src/generated.ts — run \`pnpm receipts\`. A vitest config cannot `
      + "fall back to a default here: an unchosen 5,000 ms is what this module exists to prevent.",
    );
  }
  return Number(found[1]);
}

/**
 * Spread into a package's `test` block.
 *
 * `test/node/vitest-timeout-world.test.ts` resolves every config in the repository and asserts these exact
 * values, so a package that stops spreading them fails rather than quietly reverting to the default.
 */
export const measuredTimeouts = {
  testTimeout: budget("test.timeout_ms"),
  hookTimeout: budget("test.hook_timeout_ms"),
} as const;
