import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../..");

const sbom = await import("../../../../../.github/scripts/sbom.mjs");

/**
 * The inventory a customer can check what they merged against (#102).
 *
 * ## Why an SBOM is load-bearing here rather than a compliance chore
 *
 * The update model asks a customer to merge this repository into the software holding their organization's
 * mail. #102's argument is that such a merge has to be verifiable. Provenance — CI's Sigstore attestation —
 * answers *"did this come from there?"*; the SBOM answers *"what is in it?"*. Neither is worth much alone.
 *
 * ## What these tests are actually protecting
 *
 * Not the format. The generator parses YAML with regular expressions, and the failure mode of that is
 * **silent under-reporting**: an SBOM missing a dependency does not look broken, it looks like a document
 * asserting that the dependency is not there. So the count is checked against an independent scan of the same
 * section, and the generator is required to throw rather than skip an entry it cannot read.
 */
describe("the dependency inventory", () => {
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
  const built = sbom.buildSbom({ lock, at: "1970-01-01T00:00:00.000Z", commit: "test" });

  /**
   * The `packages:` entries, counted **without** using the generator's own parser.
   *
   * Deliberately a second implementation. Sharing one would make this test agree with the generator by
   * construction, including when both are wrong — which is the whole failure this file exists to catch.
   */
  function entriesInLockfile(): number {
    const start = lock.indexOf("\npackages:\n") + "\npackages:\n".length;
    const rest = lock.slice(start);
    const nextTopLevel = rest.search(/^\S/m);
    const section = nextTopLevel === -1 ? rest : rest.slice(0, nextTopLevel);
    return section.split("\n").filter((line) => /^ {2}\S.*@[^\s:]+'?:\s*$/.test(line)).length;
  }

  it("names every package the lockfile resolves, counted independently", () => {
    const thirdParty = built.components.filter(
      (one: { properties?: unknown }) => one.properties === undefined,
    );
    expect(entriesInLockfile()).toBeGreaterThan(200);
    expect(thirdParty.length).toBe(entriesInLockfile());
  });

  it("gives every third-party component something checkable, not just a name", () => {
    /*
     * A name and a version are what an attacker would leave in place. The hash is the field that makes an
     * entry falsifiable, so a component carrying neither a hash nor a distribution URL is a line of prose.
     */
    const unverifiable = built.components
      .filter((one: { properties?: unknown }) => one.properties === undefined)
      .filter((one: { hashes?: unknown[]; externalReferences?: unknown[] }) =>
        (one.hashes ?? []).length === 0 && (one.externalReferences ?? []).length === 0);
    expect(unverifiable.map((one: { name: string }) => one.name)).toEqual([]);
  });

  it("includes every workspace package, so the document says what this repository is", () => {
    /*
     * Closed over the workspace rather than a list: a package added under `packages/` and left out of the
     * inventory is the case this catches, and a hardcoded list would need the same edit that was forgotten.
     */
    const declared = new Set<string>();
    for (const parent of ["packages", "adapters"]) {
      let names: string[] = [];
      try {
        names = readdirSync(join(ROOT, parent));
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          const manifest = JSON.parse(readFileSync(join(ROOT, parent, name, "package.json"), "utf8"));
          declared.add(manifest.name);
        } catch {
          /* Not a package directory. */
        }
      }
    }
    declared.add(JSON.parse(readFileSync(join(ROOT, "apps/node/worker/package.json"), "utf8")).name);

    const inventory = new Set(built.components.map((one: { name: string }) => one.name));
    const missing = [...declared].filter((name) => !inventory.has(name));
    expect(missing, "a workspace package is absent from the SBOM").toEqual([]);
    expect(declared.size).toBeGreaterThan(5);
  });

  it("is byte-identical across runs of the same commit", () => {
    /*
     * #102 asked for *reproducible* release artifacts. A document that differs per run cannot be one, and the
     * two ways it would are both here: the clock, and object iteration order. The timestamp is passed in and
     * the components are sorted.
     */
    const again = sbom.buildSbom({ lock, at: "1970-01-01T00:00:00.000Z", commit: "test" });
    expect(JSON.stringify(again)).toBe(JSON.stringify(built));

    const names = built.components.map((one: { name: string }) => one.name);
    expect([...names]).toEqual([...names].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1)));
  });

  it("refuses an entry it cannot verify instead of dropping it", () => {
    /*
     * The property that makes the count above mean something. A lockfile shape this parser does not know
     * must stop the build — an SBOM silently missing a package is worse than none, because it answers
     * "is this dependency here?" with a confident no.
     */
    const withoutHash = [
      "",
      "packages:",
      "",
      "  '@mailda/invented@1.0.0':",
      "    engines: {node: '>=18'}",
      "",
      "snapshots:",
    ].join("\n");
    expect(() => sbom.componentsFromLock(withoutHash)).toThrow(/neither an integrity nor a tarball/);

    // And the shape it *does* know still works, so the refusal above is not simply "throws on everything".
    const withHash = [
      "",
      "packages:",
      "",
      "  '@mailda/invented@1.0.0':",
      "    resolution: {integrity: sha512-YWJjZA==}",
      "",
      "snapshots:",
    ].join("\n");
    expect(sbom.componentsFromLock(withHash).components).toHaveLength(1);
  });

  it("refuses a lockfile with no packages section at all", () => {
    // The empty-scan failure: a renamed section would otherwise yield an SBOM of nine first-party packages
    // and no dependencies, which reads as a clean bill of health.
    expect(() => sbom.componentsFromLock("lockfileVersion: '9.0'\n")).toThrow(/no `packages:` section/);
  });
});

/**
 * That CI produces and attests the document, since a generator nobody runs is the muted check again.
 *
 * Read from the workflow rather than observed, with one deliberate limit stated plainly: this asserts the
 * steps are **declared**, not that an attestation exists. The attestation is only produced on a push to
 * `main`, so the first real one appears after this merges, and `gh attestation verify` is how it is checked.
 */
describe("the workflow publishes what a customer can verify", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

  /**
   * Just the `sbom:` job, and the reason is a mutation that survived.
   *
   * The guard assertion below used to search backwards from the attestation step for the nearest `if:`. With
   * the job's own `if:` deleted — the exact defect it was written to catch — the search ran on into the
   * **`check` job** and found `if: always() && github.event_name == 'push'` there, which contains the string
   * it was looking for. Green, against a workflow that attests every pull request.
   *
   * Reading one job's block makes the claim about that job. A property asserted over a whole file is a
   * property about whatever else the file happens to contain.
   */
  function job(name: string): string {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    expect(start, `the ${name} job is gone`).toBeGreaterThan(-1);
    const after = workflow.slice(start + 1);
    const next = after.slice(1).search(/^ {2}\w[\w-]*:\n/m);
    return next === -1 ? after : after.slice(0, next + 1);
  }

  it("generates the SBOM and attests it", () => {
    expect(workflow).toContain(".github/scripts/sbom.mjs");
    expect(workflow).toContain("actions/attest-build-provenance");
  });

  it("holds the permissions an attestation needs, and no more", () => {
    /*
     * `id-token: write` is what Sigstore signs with and `attestations: write` is what records it. Both are
     * job-scoped rather than workflow-scoped: every other job in this file runs with `contents: read`, and a
     * token that can mint signatures should not be handed to the step that runs the test suite.
     */
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("attestations: write");
    const top = workflow.slice(workflow.indexOf("\npermissions:"), workflow.indexOf("\njobs:"));
    expect(top, "the signing permissions are workflow-wide, so every job holds them")
      .not.toContain("id-token: write");
  });

  it("attests only a push to main, never a pull request", () => {
    /*
     * An attestation over a pull request branch would claim provenance for code that is not in the product.
     * That is worse than having none: the artifact would verify, and say nothing true.
     */
    const sbomJob = job("sbom");
    expect(sbomJob).toContain("actions/attest-build-provenance");

    /*
     * The guard has to be the **job's**, above its steps. A step-level `if:` further down would leave the
     * job's earlier steps — checkout, and the SBOM build — running on pull requests, and the assertion
     * "attests only a push" would be resting on a condition attached to something else.
     */
    const guard = sbomJob.indexOf("if:");
    const steps = sbomJob.indexOf("steps:");
    expect(guard, "the sbom job has no condition of its own").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(steps);
    expect(sbomJob.slice(guard, steps)).toContain("github.event_name == 'push'");
  });

  it("attests nothing that did not pass the suite", () => {
    // `needs: check`. Provenance over an artifact built from a red commit would be a signature asserting
    // that this is what the repository produced — true, and exactly the wrong thing to make verifiable.
    expect(job("sbom")).toContain("needs: check");
  });
});
