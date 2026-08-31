import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../..");

/**
 * Every hand-written `.d.mts` names exactly what its module exports.
 *
 * ## Why this file exists
 *
 * Two scripts here run under `node` with no build step — the operator's CLI and the SBOM generator — which is
 * deliberate: it keeps them files a person can open and read. The cost is a hand-written declaration beside
 * each, and that declaration is the one artifact in the pair that can be wrong without anything noticing.
 *
 * `deploy-parse.d.mts` had said so itself: *"the one thing here that **can drift** from its implementation,
 * and nothing checks the pair"*, arguing the drift was bounded because a wrong signature shows up as a failing
 * test. Then it drifted in the direction that argument missed. #98 replaced `previewUrlFrom` with two
 * functions; the declaration kept exporting the old name. `tsc` caught the two **missing** exports only
 * because a test imported them — a name left behind after the function is gone is invisible to it, and would
 * type-check every call to something that no longer exists.
 *
 * So the comparison runs in both directions, which is the only version worth having, and it costs a set
 * difference.
 *
 * ## Why not generate the declarations instead
 *
 * That is the obvious alternative and it was considered. Generating means a build step for two files whose
 * whole point is not having one, or checking generated output into the tree and then needing a check that
 * *it* is current — the same problem one layer along, which is the shape `AGENTS.md` warns about. A set
 * comparison is smaller than either.
 */

const PAIRS = [
  {
    what: "the operator's CLI parsers",
    module: "packages/cli/src/deploy-parse.mjs",
    declaration: "packages/cli/src/deploy-parse.d.mts",
  },
  {
    what: "the SBOM generator",
    module: ".github/scripts/sbom.mjs",
    declaration: ".github/scripts/sbom.d.mts",
  },
] as const;

describe("hand-written declarations match their modules", () => {
  it("finds the pairs, so nothing below passes by checking none", () => {
    expect(PAIRS.length).toBeGreaterThan(1);
  });

  for (const pair of PAIRS) {
    it(`declares every export and exports every declaration: ${pair.what}`, async () => {
      const loaded = await import(join(ROOT, pair.module));
      const exported = Object.keys(loaded).filter((name) => name !== "default");

      const text = readFileSync(join(ROOT, pair.declaration), "utf8");
      /*
       * Functions only. A declaration may also export `interface` and `type` — shapes that describe values
       * rather than being them, and which have no runtime counterpart to compare against. Including them
       * would make this fail on every legitimate type alias.
       */
      const declared = [...text.matchAll(/^export function (\w+)/gm)].map((one) => one[1]);

      expect(exported.length, `${pair.module} exports nothing — did the import fail?`).toBeGreaterThan(1);
      expect(declared.length, `${pair.declaration} declares no functions`).toBeGreaterThan(1);
      expect([...declared].sort()).toEqual([...exported].sort());
    });
  }
});
