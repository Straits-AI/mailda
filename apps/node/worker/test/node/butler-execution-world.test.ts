import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/**
 * Keeps `doctor`'s claim about Butler execution true of the code, rather than true of the day it was written.
 *
 * ## This file changed direction, and the reason it exists did not
 *
 * Until #50 it asserted an **absence**: no `workflows` binding, no `WorkflowEntrypoint`, and a `doctor`
 * finding saying *"none of them runs"*. `butler_execution` is `severity: "report", ok: true` on every Node
 * forever — the shape `workers_paid_plan` and `sending_events_consumer` already have, for the reason a
 * finding that fails on every Node is one somebody mutes — and the hazard in a finding that cannot fail is
 * that its `detail` stays in the file long after it stops describing the code, while *nothing looks wrong*:
 * the check still runs, still passes, still reads as verified. That is #70's defect — an identifier reads as
 * though it is being checked and nothing was checking it — applied to a claim instead of a name.
 *
 * The engine landed, this file failed, and the sentence was rewritten. **The guard is now pointed the other
 * way**, which is the only version of it that stays useful: it asserts that both halves of the engine are
 * present and that `doctor` no longer says they are absent. Deleting a workflow binding, deleting the
 * entrypoint, or reinstating the old sentence all fail here.
 *
 * ## The three things it holds, and why each is a separate assertion
 *
 *   1. **The binding exists in every scope.** Named environments inherit nothing, so a `workflows` block at
 *      the top level and not in `env.test` is a Node whose tests exercise no engine.
 *   2. **A `WorkflowEntrypoint` exists in `src/` and is exported from the entry module.** A binding with no
 *      class behind it, or a class the bundle's entry does not export, are both half-landed states — and the
 *      second is the one that deploys cleanly and fails at the first delivery, because the platform resolves
 *      `class_name` off the entry module.
 *   3. **`doctor` no longer says nothing runs.** Asserted as the *absence* of the old sentence as well as the
 *      presence of the new one, because a `detail` that gained a paragraph while keeping the old claim would
 *      satisfy a presence check alone.
 *
 * `workflows[].schedules` stays deliberately unasserted here and is asserted in `deployability.test.ts`: #48
 * established that this Node declares none, because schedules are deploy-time config while Butlers are
 * published at runtime, and that file is the one that owns what a customer's deploy can provision.
 */

const workerDir = resolve(import.meta.dirname, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const doctorSource = readFileSync(join(workerDir, "src/doctor.ts"), "utf8");
const indexSource = readFileSync(join(workerDir, "src/index.ts"), "utf8");
const wrangler = parseJsonc(readFileSync(join(workerDir, "wrangler.jsonc"), "utf8")) as {
  workflows?: { binding?: string; name?: string; class_name?: string }[];
  env?: Record<string, { workflows?: { binding?: string; class_name?: string }[] }>;
};

/**
 * Comment lines are skipped, the same rule `id-prefix-world.test.ts` uses and for the same reason: several
 * files *name* the class in prose. Proved non-vacuous below against literal fixtures rather than against any
 * file's contents, so skipping comments cannot make the extractor blind.
 */
const isComment = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
};
const EXTENDS_WORKFLOW = /\bextends\s+WorkflowEntrypoint\b/;

describe("Butlers run on this Node, and doctor says so (#50)", () => {
  it("declares a Workflow binding in the top-level config and in every environment", () => {
    expect(
      wrangler.workflows ?? null,
      "wrangler.jsonc declares no Workflow. #50's engine needs one; if it has been removed, doctor's "
        + "`butler_execution` detail now tells every operator their Butlers run when they do not.",
    ).not.toBeNull();
    expect(wrangler.workflows).toHaveLength(1);
    const [declared] = wrangler.workflows!;
    expect(declared?.binding).toBe("BUTLER_RUNS");
    expect(declared?.class_name).toBe("ButlerRun");

    // Named environments inherit nothing. A binding at the top level and not here is a Node whose whole
    // test suite exercises an engine that is not there.
    for (const [name, environment] of Object.entries(wrangler.env ?? {})) {
      expect(environment.workflows ?? null, `env.${name} declares no Workflow`).not.toBeNull();
      expect(environment.workflows?.[0]?.class_name, `env.${name}`).toBe("ButlerRun");
    }
  });

  it("carries exactly one WorkflowEntrypoint in src/, and it is the class the binding names", () => {
    // Non-vacuity, against literals rather than files: the extractor must match a declaration and must skip
    // the prose that discusses one.
    expect(EXTENDS_WORKFLOW.test("export class ButlerRun extends WorkflowEntrypoint<Env, Payload> {")).toBe(true);
    expect(isComment(" * one generic `ButlerRun extends WorkflowEntrypoint` interpreting")).toBe(true);

    const declaring = sourceFiles(join(workerDir, "src"))
      .filter((path) => readFileSync(path, "utf8").split("\n")
        .some((line) => !isComment(line) && EXTENDS_WORKFLOW.test(line)))
      .map((path) => path.slice(workerDir.length + 1));

    // One, and only one. #50 chose a single generic interpreter precisely so that publishing a Butler needs
    // no deploy; a second entrypoint would mean somebody had started writing a class per Butler, which that
    // decision forbids and which would leave one orphaned account-level workflow per published Butler.
    expect(declaring).toEqual(["src/butler/run.ts"]);
  });

  it("exports that class from the entry module, which is where the platform looks for it", () => {
    // The half-landed state that deploys cleanly and fails at the first delivery: `class_name` is resolved
    // off the bundle's entry module, exactly as the two Durable Objects are.
    expect(indexSource).toContain('export { ButlerRun } from "./butler/run.ts"');
  });

  it("emits a butler_execution check that no longer says nothing runs", () => {
    expect(doctorSource).toContain('check: "butler_execution"');
    // The old claim, asserted absent. A detail that gained a paragraph while keeping this sentence would
    // satisfy a presence check on the new text alone.
    expect(
      doctorSource.includes("none of them runs"),
      "doctor still tells operators that no Butler runs here, which stopped being true with #50",
    ).toBe(false);
    expect(doctorSource).toContain("Butlers run on this Node");
    // And the two things an operator most needs to know about a running Butler: whose authority it acts on,
    // and that it cannot send without a person. Both are decisions rather than implementation detail, which
    // is why they are held here rather than left to the prose drifting.
    expect(doctorSource).toContain("actor_kind=butler");
    expect(doctorSource).toContain("awaiting a human release");
  });

  it("starts instances one at a time, because createBatch drops duplicates silently", () => {
    /*
     * `src/butler/trigger.ts` says *"`createBatch` is not used, and must not be"* and until this test that
     * was a claim nothing enforced — which is the shape this file exists to refuse one level up. The
     * prohibition is the load-bearing half of #50's whole idempotency story: `create({ id })` **throws**
     * `instance.already_exists` on a duplicate, while `createBatch` was measured at **4 requested, 1
     * returned, no error** (`workflow-provisioning.md`). A fan-out built on the batch form would drop runs
     * with nothing anywhere to notice, and the delivery those runs were for would look handled.
     *
     * Scoped to `src/butler/` rather than to `src/`, because `src/cost-meter.ts` legitimately *names* the
     * method: it meters both forms, so that if the rule is ever reversed the cost is already counted.
     */
    const CALL = /\.createBatch\s*\(/;
    // Non-vacuity, against literals rather than any file: the extractor must match a call and skip prose.
    expect(CALL.test("await env.BUTLER_RUNS.createBatch(batch);")).toBe(true);
    expect(isComment(" * - **`createBatch` is not used, and must not be.** It silently skips")).toBe(true);

    const offenders = sourceFiles(join(workerDir, "src/butler"))
      .filter((path) => readFileSync(path, "utf8").split("\n")
        .some((line) => !isComment(line) && CALL.test(line)))
      .map((path) => path.slice(workerDir.length + 1));

    expect(
      offenders.length === 0 ? null
        : `${offenders.join(", ")} calls createBatch. It silently skips a duplicate id and excludes it from `
          + "the returned array (4 requested, 1 returned, no error — workflow-provisioning.md), so a fan-out "
          + "built on it drops runs with nothing to notice. `create` per item is what makes a duplicate throw, "
          + "which is #50's entire dedup mechanism",
    ).toBeNull();
  });

  it("has the tables that make the claim worth making", () => {
    const migrations = readdirSync(join(workerDir, "migrations"))
      .filter((file) => file.endsWith(".sql"))
      .map((file) => readFileSync(join(workerDir, "migrations", file), "utf8"))
      .join("\n");
    expect(migrations).toMatch(/CREATE\s+TABLE\s+butler_versions\b/);
    expect(migrations).toMatch(/CREATE\s+TABLE\s+butler_runs\b/);
    expect(migrations).toMatch(/CREATE\s+TABLE\s+butler_run_effects\b/);
    expect(doctorSource).toContain('"butlers", "butler_versions"');
    expect(doctorSource).toContain('"butler_runs", "butler_run_effects"');
  });
});
