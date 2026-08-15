import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { describe, expect, it } from "vitest";

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
 * were true-sounding prose over unenforced behaviour.
 *
 * So the meter now **throws** on an unclassified binding, and this test catches it earlier: at test time,
 * from the config, rather than at the moment a priced operation happens to touch one.
 *
 * ## What it deliberately does not check
 *
 * That each binding's *cost* is right. A binding could be classified as metered and count zero. That is what
 * `test/butler-step-cost.measure.test.ts` is for — it measures real operations and prints the figures. This
 * file only answers "is anything unaccounted for", which is the question a comment was previously answering.
 */

const workerDir = join(import.meta.dirname, "..", "..");
const config = parseJsonc(readFileSync(join(workerDir, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
const meter = readFileSync(join(workerDir, "src", "cost-meter.ts"), "utf8");

/**
 * Every binding name `wrangler.jsonc` declares, read from the config rather than listed here.
 *
 * Listing them would reproduce the original defect one level up: a hand-maintained list that stops matching
 * the config is the same thing as a comment that stops being true.
 */
function declaredBindings(scope: Record<string, unknown>): string[] {
  const names: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "object" && value !== null && "binding" in value) {
      names.push(String((value as { binding: unknown }).binding));
    }
    if (typeof value === "object" && value !== null && "name" in value && !("binding" in value)) {
      // `send_email` declares `name` rather than `binding`.
      names.push(String((value as { name: unknown }).name));
    }
  };

  for (const key of ["d1_databases", "r2_buckets", "send_email", "kv_namespaces", "secrets_store_secrets"]) {
    for (const entry of (scope[key] as unknown[] | undefined) ?? []) push(entry);
  }
  for (const entry of ((scope.durable_objects as { bindings?: unknown[] } | undefined)?.bindings) ?? []) {
    push(entry);
  }
  for (const entry of ((scope.queues as { producers?: unknown[] } | undefined)?.producers) ?? []) push(entry);
  return [...new Set(names)];
}

describe("the cost meter accounts for every binding", () => {
  const bindings = declaredBindings(config);

  it("finds the bindings, so this cannot pass by checking nothing", () => {
    // The vacuous-green failure mode `placeholder-columns.test.ts` names. If the config parser silently
    // returned nothing, every assertion below would pass.
    expect(bindings.length).toBeGreaterThanOrEqual(4);
    expect(bindings).toContain("CATALOG");
    expect(bindings).toContain("EVIDENCE");
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
    // something extra, the meter has to know about that too.
    const testEnv = (config.env as { test?: Record<string, unknown> } | undefined)?.test;
    if (testEnv === undefined) return;
    const extra = declaredBindings(testEnv).filter((name) => !meter.includes(name));
    expect(extra).toEqual([]);
  });
});
