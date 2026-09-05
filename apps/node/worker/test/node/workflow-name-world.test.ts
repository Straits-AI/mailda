import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readWranglerConfig, type ConfigScope } from "./wrangler-world";

/**
 * The Workflow's name must derive from the Worker's (#99).
 *
 * ## The collision, measured rather than suspected
 *
 * Every resource a Mailda Node provisions derives its name from the Worker's: a Node called `mailda2` gets
 * `mailda2-catalog`, `mailda2-evidence`, `mailda2-sending-events`. **The Workflow does not.** Its name is
 * written in `wrangler.jsonc`, and a Workflow is owned by exactly one script.
 *
 * Drilled against a live account on 27 August 2026 (`deploy-drill-live-account.md`). Deploying a second Node
 * beside the first **succeeded — exit 0, no warning, no prompt** — and `wrangler workflows list` showed
 * ownership of `mailda-butler-runs` move from `mailda` to `mailda2`. The first Node kept a `BUTLER_RUNS`
 * binding pointing at a Workflow now served by the second Node's code, against the second Node's bindings:
 * a cross-Node execution path into another organization's D1. It does not refuse. It reassigns.
 *
 * ## Why a naming rule rather than omitting the name
 *
 * Queues solve this by omitting the name and letting Cloudflare derive it. Workflows cannot: `name` is
 * **required** on the binding, per Cloudflare's configuration reference. So the name stays in the file and
 * the rule is that it must derive from the Worker's.
 *
 * That works because of something ADR 24 does not say out loud: **a second Node in one account cannot be
 * byte-identical anyway.** Two Workers cannot share a name, so an operator standing up a second Node is
 * already editing `name`. This makes the edit they must already make carry the Workflow with it — and a
 * mismatch fails here rather than silently taking the first Node's Butler engine.
 *
 * ## This file is not the whole defence
 *
 * It guards *this repository*. An operator who edits `wrangler.jsonc` and runs `mailda deploy` without
 * running the suite is not protected by a test — so `deploy` performs the same check against the live
 * account, where it can see who actually owns the Workflow rather than what the file intends.
 */

const SUFFIX = "-butler-runs";

/**
 * Every scope, with the Worker name it will actually be deployed under.
 *
 * A named environment that declares no `name` does **not** inherit the top level's: wrangler deploys it as
 * `<top-level>-<environment>`. So `env.test` is the Worker `mailda-test`, and a Workflow named
 * `mailda-butler-runs` there is the collision one level down — the same shape as #71's hole, which is why
 * this resolves the effective name rather than reading the field.
 */
function scopes(): { where: string; workerName: string | undefined; scope: ConfigScope }[] {
  const config = readWranglerConfig() as ConfigScope & {
    name?: string;
    env?: Record<string, ConfigScope & { name?: string }>;
  };
  const found = [{ where: "top level", workerName: config.name, scope: config as ConfigScope }];
  for (const [environment, scope] of Object.entries(config.env ?? {})) {
    found.push({
      where: `env.${environment}`,
      workerName: scope.name ?? (config.name === undefined ? undefined : `${config.name}-${environment}`),
      scope: scope as ConfigScope,
    });
  }
  return found;
}

describe("a second Node in one account cannot steal the first's Butler engine", () => {
  it("declares a Workflow to check, so this cannot pass by finding none", () => {
    // Anti-vacuity: every assertion below loops over the workflow blocks, and a loop over nothing agrees
    // with everything. The binding has been removed once already in this repository's history.
    const declared = scopes().flatMap(({ scope }) => (scope as { workflows?: unknown[] }).workflows ?? []);
    expect(declared.length, "no workflows block in wrangler.jsonc — has the binding moved?")
      .toBeGreaterThan(0);
  });

  it("names every Workflow after the Worker it belongs to, in every scope", () => {
    /*
     * The rule. `<worker>-butler-runs`, so that changing the Worker's name — which an operator standing up a
     * second Node must do anyway — carries the Workflow with it.
     *
     * Checked in **each scope separately**, because a named environment declares its own `name` and its own
     * workflows block: an environment whose Worker is `mailda-staging` and whose Workflow is still
     * `mailda-butler-runs` is the collision, arriving one level down. That is where #71's hole was.
     */
    const wrong: string[] = [];
    for (const { where, workerName, scope } of scopes()) {
      const workflows = (scope as { workflows?: { name?: string; binding?: string }[] }).workflows ?? [];
      if (workflows.length === 0) continue;
      if (workerName === undefined) {
        wrong.push(`${where} declares workflows and no Worker name, so nothing can derive from it`);
        continue;
      }
      for (const workflow of workflows) {
        const expected = `${workerName}${SUFFIX}`;
        if (workflow.name !== expected) {
          wrong.push(
            `${where}: Workflow "${workflow.name}" does not derive from the Worker name "${workerName}" — `
            + `expected "${expected}". A Workflow is owned by exactly one script, so two Nodes in one `
            + "account sharing this name means the second deploy takes the first's Butler engine, with no "
            + "warning (measured: docs/receipts/deploy-drill-live-account.md).",
          );
        }
      }
    }
    expect(wrong.length === 0 ? null : wrong.join("\n")).toBeNull();
  });

  it("keeps the suffix out of the Worker name, so the rule cannot be satisfied trivially", () => {
    /*
     * A Worker called `butler-runs` would make `butler-runs-butler-runs` the expected name, which is silly
     * but passes. What would *not* pass, and is the real trap: a Worker whose name already ends in the
     * suffix could tempt somebody into reusing it directly and reintroducing a fixed name. Asserted so the
     * derivation stays a derivation.
     */
    for (const { where, workerName } of scopes()) {
      if (workerName === undefined) continue;
      expect(workerName.endsWith(SUFFIX), `${where}: the Worker name ends in "${SUFFIX}"`).toBe(false);
    }
  });
});

describe("the deploy refuses a Workflow name that does not follow the Worker's (#99)", () => {
  /*
   * The rule above is a repository test: it runs when somebody runs the suite. An operator standing up a
   * second Node in their own account edits `name`, deploys, and never runs it — which is the case #99 is
   * about, and the one the rule could not reach.
   *
   * So the deploy checks it too. Lexical, because `refuseIfWorkflowBelongsElsewhere` shells out to wrangler
   * and cannot be called from here — and narrow for that reason: it asserts the comparison exists and is
   * followed by a refusal, not that the refusal is correct. The rule above is what checks correctness.
   */
  const cli = readFileSync(
    join(import.meta.dirname, "../../../../../packages/cli/src/mailda.mjs"), "utf8",
  );

  it("compares the two names and fails, rather than warning", () => {
    const guard = /if \(workflowName !== `\$\{workerName\}-butler-runs`\) \{[\s\S]{0,900}?\n {2}\}/.exec(cli);
    expect(guard, "the deploy no longer compares the Workflow's name with the Worker's").not.toBeNull();
    expect(guard![0]).toContain("fail(");
    // The remedy names the value to type, because a refusal that only says "wrong" costs a second round trip.
    expect(guard![0]).toContain("${workerName}-butler-runs\\`.");
  });
});
