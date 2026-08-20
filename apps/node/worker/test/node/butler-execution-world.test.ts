import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/**
 * Keeps `doctor`'s claim that no Butler runs here true of the code, rather than true of the day it was
 * written (#49).
 *
 * ## Why a permanently-true sentence needs a test
 *
 * `butler_execution` is `severity: "report", ok: true` on every Node, forever — the shape
 * `workers_paid_plan` and `sending_events_consumer` already have, and for the same reason: a finding that
 * fails on every Node is one somebody mutes. The hazard in a finding that cannot fail is different. Its
 * `detail` stays in the file long after it stops describing the code, and *nothing looks wrong*: the check
 * still runs, still passes, still reads as verified. That is #70's defect — an identifier reads as though
 * it is being checked and nothing was checking it — applied to a claim instead of a name.
 *
 * So the absence itself is asserted. The day #50's engine lands, this file fails, and whoever lands it has
 * to go and change the sentence rather than leaving `doctor` telling operators their Butlers do not run.
 *
 * ## The two things that would make the sentence false
 *
 *   1. `wrangler.jsonc` declaring a `workflows` binding. That is what #50's `ButlerRun` needs, and #47
 *      measured that `wrangler deploy` creates the workflow from a binding with no resource id.
 *   2. A `WorkflowEntrypoint` in `src/`. A binding with no class behind it, or a class with no binding, are
 *      both half-landed states, and either makes "there is no run engine in this bundle" arguable rather
 *      than plain — which is when a sentence like this should be rewritten, not when both halves are done.
 *
 * `workflows[].schedules` is a third thing worth watching and is deliberately **not** asserted here: #48
 * established that the Node never declares one, because schedules are deploy-time config while Butlers are
 * published at runtime. Rule 1 already refuses the whole block.
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
const wrangler = parseJsonc(readFileSync(join(workerDir, "wrangler.jsonc"), "utf8")) as {
  workflows?: unknown[];
  env?: Record<string, { workflows?: unknown[] }>;
};

describe("no Butler runs on this Node, and doctor says so (#49)", () => {
  it("declares no Workflow binding, in the top-level config or in any environment", () => {
    expect(
      wrangler.workflows ?? null,
      "wrangler.jsonc declares a Workflow. If that is #50's engine landing, rewrite doctor's "
        + "`butler_execution` detail — it currently tells every operator that their Butlers do not run.",
    ).toBeNull();
    for (const [name, environment] of Object.entries(wrangler.env ?? {})) {
      expect(environment.workflows ?? null, `env.${name} declares a Workflow — same instruction`).toBeNull();
    }
  });

  it("carries no WorkflowEntrypoint in src/", () => {
    // Comment lines are skipped, the same rule `id-prefix-world.test.ts` uses and for the same reason:
    // `src/butlers.ts` and `src/doctor.ts` both *name* the class in prose, explaining that it does not
    // exist here. A scan that flagged the explanation would be unusable, and a comment extends nothing.
    // Proved non-vacuous below by matching the declaration this test exists to catch.
    const isComment = (line: string): boolean => {
      const trimmed = line.trim();
      return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
    };
    const extendsWorkflow = /\bextends\s+WorkflowEntrypoint\b/;
    expect(extendsWorkflow.test("export class ButlerRun extends WorkflowEntrypoint<Env, Payload> {")).toBe(true);
    expect(extendsWorkflow.test(" * one generic `ButlerRun extends WorkflowEntrypoint` interpreting")).toBe(true);

    const offenders = sourceFiles(join(workerDir, "src"))
      .filter((path) => readFileSync(path, "utf8").split("\n")
        .some((line) => !isComment(line) && extendsWorkflow.test(line)))
      .map((path) => path.slice(workerDir.length + 1));
    expect(
      offenders,
      "a WorkflowEntrypoint exists. Rewrite doctor's `butler_execution` detail before shipping it.",
    ).toEqual([]);
  });

  it("emits a butler_execution check whose detail says exactly that", () => {
    // Read from the source rather than listed here, `doctor-check-names.test.ts`-style. The behavioural
    // half — that the check is really in the report, with `report`/`ok`/`infrastructure` — lives in
    // `test/doctor.test.ts`, which runs the real thing inside workerd.
    expect(doctorSource).toContain('check: "butler_execution"');
    expect(doctorSource).toContain("none of them runs");
  });

  it("has the tables that make the claim worth making", () => {
    // The whole reason a reader could be misled: `migrations_applied` reports both Butler tables present,
    // which reads as "the feature works". If they ever stop being there, this check has no audience and the
    // check itself should go rather than linger as a sentence about nothing.
    const migrations = readdirSync(join(workerDir, "migrations"))
      .filter((file) => file.endsWith(".sql"))
      .map((file) => readFileSync(join(workerDir, "migrations", file), "utf8"))
      .join("\n");
    expect(migrations).toMatch(/CREATE\s+TABLE\s+butler_versions\b/);
    expect(doctorSource).toContain('"butlers", "butler_versions"');
  });
});
