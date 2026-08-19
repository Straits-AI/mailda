import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bindingNamesIn, readWranglerConfig, unclassifiedKeys, WORKER_DIR,
  type ConfigScope,
} from "./wrangler-world";

/**
 * Does the cost meter classify every binding the Worker declares?
 *
 * ## Why this is a test and not a comment
 *
 * `src/cost-meter.ts` first shipped proxying `CATALOG`, `EVIDENCE` and `KEY_VAULT`, and **said so in its own
 * header** — that `env.EMAIL.send` and the queue producer were not covered, that nothing priced reached them,
 * and that widening would be needed first. Every part of that was true and it was still the wrong shape: a
 * gap named in a comment is a gap nothing enforces. Pricing a node that hands bytes to the transport would
 * have under-reported the cost silently, in the permissive direction, and the header would have gone on
 * describing a limitation nobody re-read.
 *
 * This repository has spent a lot of effort this month on exactly that pattern — a claim in a comment with no
 * check behind it. `sealManifest` said a reply threads onto a message "the author can see" while checking
 * only the organization. `doctor` printed a subrequest cap that had been withdrawn six months earlier. Both
 * were true-sounding prose over unenforced behaviour. **This file had one of its own**, which is #71: the
 * comment below the imports used to say the binding names were read from the config "rather than listed
 * here", directly above a hardcoded list of five block types. It was that claim, in the test written to
 * close that pattern, in a file whose header cites three prior instances of it.
 *
 * So the meter now **throws** on an unclassified binding, and this test catches it earlier: at test time,
 * from the config, rather than at the moment a priced operation happens to touch one.
 *
 * ## Which half of the question this file owns
 *
 * `test/node/wrangler-world.ts` decides what a key in `wrangler.jsonc` *is* — binding block or non-binding
 * field, with nothing else permitted. Both binding tripwires share it, because each having its own
 * incomplete rule is how both came to be trusted and neither was sufficient (#71). On top of that:
 *
 * - **this file** asks whether every binding **name** is classified in `src/cost-meter.ts`;
 * - `test/node/deployability.test.ts` asks whether a customer's install can **provision** every binding
 *   **block**, which is a different question about the same keys and stays a separate file.
 *
 * ## What it deliberately does not check
 *
 * That each binding's *cost* is right. A binding could be classified as metered and count zero. That is what
 * `test/butler-step-cost.measure.test.ts` is for — it measures real operations and prints the figures. This
 * file only answers "is anything unaccounted for", which is the question a comment was previously answering.
 */

const config = readWranglerConfig();
const meter = readFileSync(join(WORKER_DIR, "src", "cost-meter.ts"), "utf8");

describe("the cost meter accounts for every binding", () => {
  const bindings = bindingNamesIn(config);

  it("finds the bindings, so this cannot pass by checking nothing", () => {
    // The vacuous-green failure mode `placeholder-columns.test.ts` names. If the config parser silently
    // returned nothing, every assertion below would pass.
    expect(bindings.length).toBeGreaterThanOrEqual(4);
    expect(bindings).toContain("CATALOG");
    expect(bindings).toContain("EVIDENCE");
  });

  it("reads every key in the config, so a binding block nobody listed cannot hide", () => {
    // The inversion #71 asked for, and the reason the hardcoded block list is gone: a new block type is
    // now an unknown *key*, which fails, instead of a key the loop never looked at. `workflows` — Layer
    // 4's Butler engine — was invisible to the old list, and would have been priced as free. One call
    // covers the top level and every named environment; the descent is proved in deployability.test.ts,
    // which owns the branches the real config cannot exercise.
    expect(unclassifiedKeys(config)).toBeNull();
  });

  it("fails on a key it does not know, so the closed world is not vacuously closed", () => {
    // Proves the guard above fires without touching wrangler.jsonc: the same check, one key richer.
    const withStranger = { ...config, mailda_unheard_of_block: [{ binding: "SURPRISE" }] };
    const complaint = unclassifiedKeys(withStranger);
    expect(complaint, "the closed world accepted a top-level key nothing classifies").not.toBeNull();
    expect(complaint).toContain("mailda_unheard_of_block");
    expect(complaint).toContain("src/cost-meter.ts");
  });

  it("refuses a known block whose shape it cannot read, since bindings it cannot see read as none", () => {
    // The blocks nothing declares yet — `workflows` among them — carry a claim about their entry shape,
    // and a wrong claim there would yield no names and look clean. Both ways of being wrong fail: the
    // block not being the collection expected, and an entry not naming its binding where expected.
    for (const shape of [{ binding: "BUTLER" }, [{ name: "mailda-butler" }]]) {
      const complaint = unclassifiedKeys({ ...config, workflows: shape });
      expect(complaint, `a workflows block shaped ${JSON.stringify(shape)} was read as no bindings`)
        .not.toBeNull();
      expect(complaint).toContain("cannot read");
    }
  });

  it("names every declared binding in the meter's source", () => {
    const unclassified = bindings.filter((name) => !meter.includes(name));
    expect(
      unclassified.length === 0 ? null
        : `${unclassified.join(", ")} declared in wrangler.jsonc but absent from src/cost-meter.ts — a `
          + "priced operation touching one would now throw at runtime, which is better than being counted "
          + "as free, but it should have been classified here first",
    ).toBeNull();
  });

  it("still refuses an unclassified binding at runtime, not only here", () => {
    // Belt and braces on purpose, and the belt is the runtime throw: this test reads the config, and a
    // binding could reach the env by some path the config does not describe — the Queues *event
    // subscription* is exactly such a thing, created through the API rather than declared here.
    for (const phrase of ["is not classified", "would be counted "]) {
      expect(meter, `the meter no longer refuses unclassified bindings: missing "${phrase}"`)
        .toContain(phrase);
    }
  });

  it("keeps the test environment's bindings covered too", () => {
    // `env.test` duplicates the top level, drift-checked by deployability.test.ts. If it ever declares
    // something extra, the meter has to know about that too. Its *keys* are already closed over by the
    // guard above, which descends into every environment, so this asks only about the binding names.
    const testEnv = (config.env as { test?: ConfigScope } | undefined)?.test;
    if (testEnv === undefined) return;
    const extra = bindingNamesIn(testEnv).filter((name) => !meter.includes(name));
    expect(extra).toEqual([]);
  });
});
