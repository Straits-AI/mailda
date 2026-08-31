import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

/**
 * Every vitest config carries the measured timeout, not the one vitest ships with.
 *
 * ## What went wrong
 *
 * [test-timeout-headroom](../../../../../docs/receipts/test-timeout-headroom.md) recorded the finding in
 * August: vitest's default `testTimeout` is 5,000 ms, **it was never chosen by anybody**, and legitimate
 * tests on an ordinarily-busy machine breach it. The fix was applied to `vitest.config.ts`.
 *
 * Two more configs were created afterwards. Neither carried it. Both explain in their own header that they
 * exist as separate files rather than as a `projects` block *because `vitest.config.ts` is the one carrying
 * the measured timeouts* — a sentence that names the exact thing being dropped, in the file dropping it.
 * That is the shape this repository keeps finding: the comment describing an invariant reads as evidence
 * the invariant holds.
 *
 * It came back as a flake. `test/node/attach-queue-consumer.test.ts` spawns four Node processes per case
 * and runs each in 99–364 ms idle. Under `turbo test` one of them was observed at **5,481 ms** and failed —
 * against a limit no measurement supports, in a suite whose sibling had had the answer for three weeks.
 *
 * ## Why this is a test and not a lint rule
 *
 * The configs are **resolved and read**, not grepped. Both mutations that matter die: deleting the line is
 * caught, and setting it to the literal `5000` is caught — which a text search for `BUDGETS[` would pass if
 * the import were left behind. The value vitest would actually use is the only thing worth asserting, and
 * importing the module is how to get it.
 *
 * What it does **not** catch, measured rather than assumed: feeding `testTimeout` the *hook* budget key
 * survives, because `test.timeout_ms` and `test.hook_timeout_ms` are both 30,000 today. No check of the
 * resolved value can separate two keys holding one number, and neither can a text search that accepts any
 * `BUDGETS[…]`. If the receipt ever measures them apart, this becomes catchable on its own.
 *
 * Discovery walks the repository rather than naming the three that exist, because the failure mode is
 * **a fourth config**, and a list of three cannot notice one.
 */

const REPO = new URL("../../../../../", import.meta.url).pathname;
const SKIP = new Set(["node_modules", ".git", "dist", ".turbo", ".wrangler", "coverage"]);

/** Every `vitest*.config.ts` in the repository. Walked, so a config added tomorrow is in this world too. */
function configs(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) configs(path, found);
    else if (/^vitest.*\.config\.ts$/.test(entry)) found.push(path);
  }
  return found;
}

/** The timeouts vitest would actually apply, by importing the config the way vitest does. */
async function timeouts(path: string): Promise<{ test: unknown; hook: unknown }> {
  const module = await import(path) as { default: unknown };
  const resolved = typeof module.default === "function"
    // A config may be a function of the vite env. Both forms are legal and both must be read.
    ? await (module.default as (env: unknown) => unknown)({ mode: "test", command: "serve" })
    : module.default;
  const section = (resolved as { test?: Record<string, unknown> } | undefined)?.test;
  return { test: section?.["testTimeout"], hook: section?.["hookTimeout"] };
}

/**
 * There is no allowlist any more, and its removal is the point.
 *
 * This used to name six packages that ran vitest with no config, each therefore at the 5,000 ms default, and
 * called the list one that "can only shrink". That is the weaker form of the invariant: it tolerates the
 * omission and asks people to be honest about it, which is how `test/node/` sat outside the CI headroom
 * ceiling for three weeks and how `packages/evidence` came to flake under `turbo test`.
 *
 * The invariant is now flat — **every workspace package whose test script runs vitest has a discoverable
 * config carrying the measured timeouts** — so a seventh configless package fails immediately rather than
 * joining a queue of tolerated omissions. `vitest.shared.ts` at the repository root is what made that
 * affordable: it reads the generated receipt value rather than importing `@mailda/budgets`, so
 * `packages/receipts` can carry a config without depending on the package it generates.
 */

describe("the measured timeout reaches every suite", () => {
  it("leaves no package running vitest without a config", () => {
    const running: string[] = [];
    for (const group of ["packages", "apps"]) {
      for (const entry of readdirSync(join(REPO, group))) {
        const dir = join(REPO, group, entry);
        if (!statSync(dir).isDirectory()) continue;
        for (const [where, at] of [[`${group}/${entry}`, dir], ...readdirSync(dir)
          .filter((child) => statSync(join(dir, child)).isDirectory())
          .map((child) => [`${group}/${entry}/${child}`, join(dir, child)] as const)]) {
          const manifest = join(at, "package.json");
          if (!existsSync(manifest)) continue;
          const scripts = (JSON.parse(readFileSync(manifest, "utf8")) as {
            scripts?: Record<string, string>;
          }).scripts ?? {};
          if (!(scripts["test"] ?? "").includes("vitest")) continue;
          if (configs(at).length === 0) running.push(where);
        }
      }
    }

    expect(
      running.sort(),
      "these packages run vitest with no config, so they inherit the 5,000 ms default that "
      + "docs/receipts/test-timeout-headroom.md exists to reject. Add a vitest.config.ts spreading "
      + "`measuredTimeouts` from vitest.shared.ts — there is no allowlist to add it to:",
    ).toEqual([]);

    // The control: a walk that found no packages at all would satisfy the assertion above perfectly.
    expect(
      countPackagesRunningVitest(),
      "no package was found to run vitest, so the check above passed over an empty set",
    ).toBeGreaterThan(5);
  });

  /** How many workspace packages run vitest, so the emptiness above is emptiness of a real search. */
  function countPackagesRunningVitest(): number {
    let found = 0;
    for (const group of ["packages", "apps"]) {
      for (const entry of readdirSync(join(REPO, group))) {
        const dir = join(REPO, group, entry);
        if (!statSync(dir).isDirectory()) continue;
        for (const at of [dir, ...readdirSync(dir)
          .filter((child) => statSync(join(dir, child)).isDirectory())
          .map((child) => join(dir, child))]) {
          const manifest = join(at, "package.json");
          if (!existsSync(manifest)) continue;
          const scripts = (JSON.parse(readFileSync(manifest, "utf8")) as {
            scripts?: Record<string, string>;
          }).scripts ?? {};
          if ((scripts["test"] ?? "").includes("vitest")) found += 1;
        }
      }
    }
    return found;
  }


  it("finds the configs at all, so a renamed file cannot empty this check", () => {
    /*
     * The control. A walk that matched nothing would report every config compliant, which is the failure
     * this whole file exists to prevent — an assertion that cannot fail. Three exist today; the floor is
     * two so that deleting one is a decision rather than a silent pass.
     */
    expect(configs(REPO).length, "no vitest configs found — has the walk been broken?")
      .toBeGreaterThanOrEqual(2);
  });

  it("gives every config the measured timeout rather than vitest's default", async () => {
    /*
     * Named against the budget rather than against a literal, so that re-measuring the receipt moves every
     * suite at once. A config left at `undefined` inherits 5,000 ms — which is the defect, not a default.
     */
    const wrong: string[] = [];
    for (const path of configs(REPO)) {
      const relative = path.slice(REPO.length);
      const { test, hook } = await timeouts(path);
      if (test !== BUDGETS["test.timeout_ms"]) wrong.push(`${relative}: testTimeout is ${String(test)}`);
      if (hook !== BUDGETS["test.hook_timeout_ms"]) wrong.push(`${relative}: hookTimeout is ${String(hook)}`);
    }

    expect(
      wrong,
      "these configs do not carry the measured timeout from docs/receipts/test-timeout-headroom.md, so "
      + "their suites run at vitest's inherited 5,000 ms default. Set testTimeout and hookTimeout from "
      + "BUDGETS, as apps/node/worker/vitest.config.ts does:",
    ).toEqual([]);
  });
});
