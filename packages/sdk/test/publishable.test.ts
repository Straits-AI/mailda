import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * `@mailda/sdk` is installable from npm (10 October 2026), with the two packages it imports, `@mailda/contract` and
 * `@mailda/runtime`. In the workspace each one's `exports` point at its TypeScript source; `publishConfig` swaps in
 * what `prepack` builds to `dist`. Two maps for one package is a drift waiting to happen, so this holds them equal:
 * a subpath added to `exports` and not to `publishConfig.exports` would install and then fail to import.
 */
const PACKAGES = ["runtime", "contract", "sdk"] as const;
const ROOT = join(import.meta.dirname, "../..");

interface Manifest {
  name: string;
  private?: boolean;
  main?: string;
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  files?: string[];
  publishConfig?: { exports: Record<string, { types: string; default: string }>; types: string };
}

const manifests = PACKAGES.map((one) => JSON.parse(readFileSync(join(ROOT, one, "package.json"), "utf8")) as Manifest);
const built = (source: string) => source.replace("./src/", "./dist/").replace(/\.ts$/, ".js");

describe("the published packages are the workspace's, built", () => {
  for (const manifest of manifests) {
    it(`publishes ${manifest.name} from dist, with the same subpaths it has here`, () => {
      expect(manifest.private, `${manifest.name} is private, so it cannot be published`).toBeUndefined();
      expect(manifest.files).toEqual(["dist"]);
      const here = manifest.exports ?? { ".": manifest.main! };
      const published = manifest.publishConfig!.exports;
      expect(Object.keys(published).sort(), "a subpath is importable here and not once installed").toEqual(Object.keys(here).sort());
      for (const [subpath, source] of Object.entries(here)) {
        expect(published[subpath], subpath).toEqual({ types: built(source).replace(/\.js$/, ".d.ts"), default: built(source) });
      }
    });
  }

  it("depends on nothing in the workspace that is not published beside it", () => {
    const ours = new Set(manifests.map((one) => one.name));
    const strays = manifests.flatMap((manifest) => Object.keys(manifest.dependencies ?? {})
      .filter((dependency) => dependency.startsWith("@mailda/") && !ours.has(dependency))
      .map((dependency) => `${manifest.name} -> ${dependency}`));
    expect(strays, "an installed package would import one that npm does not have").toEqual([]);
  });
});
