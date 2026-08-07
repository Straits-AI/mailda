import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * Guards the CI workflow against the one way it has already failed silently.
 *
 * The policy was `group: ci-<ref>` with `cancel-in-progress: true`. That is right for a branch someone
 * is iterating on and wrong for `main`: two pushes in quick succession cancel the first, and a
 * **cancelled run does not read as a failure anywhere** — not in the run list, not on a badge, not to a
 * person glancing at the tab. Commit `14522c1` went unverified that way and looked fine, which is the
 * same landmine as a check that never ran.
 *
 * The fix is one expression in a YAML file, so it is exactly the kind of thing a later edit reverts
 * while trying to make PR runs snappier. This test is what makes that revert loud.
 *
 * It is deliberately **static** — no API, no token, no network. The live counterpart (a step in the
 * workflow itself) catches runs cancelled by a human or lost to an outage; this catches the *policy*
 * regressing, which is the cause rather than a symptom.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const workflowPath = join(repoRoot, ".github/workflows/ci.yml");

interface Workflow {
  on?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  permissions?: Record<string, string>;
  jobs?: Record<string, { steps?: Array<{ name?: string; run?: string; uses?: string }> }>;
}

// `on` is the YAML 1.1 boolean `true`, which is why reading this key is not as simple as it looks.
const raw = parseYaml(readFileSync(workflowPath, "utf8")) as Record<string, unknown>;
const workflow = raw as Workflow;
const triggers = Object.keys((raw["on"] ?? raw[true as unknown as string] ?? {}) as object);

describe("the CI workflow's own policy", () => {
  it("does not cancel a push to main", () => {
    const cancel = String(workflow.concurrency?.["cancel-in-progress"] ?? "");
    // Unconditional cancellation is the bug. A conditional that only fires for pull requests is the
    // fix; anything else needs a human to think about whether main can lose a verdict again.
    expect(cancel).not.toBe("true");
    expect(cancel).toContain("pull_request");
  });

  it("keys concurrency per commit, so one push cannot supersede another", () => {
    const group = workflow.concurrency?.group ?? "";
    // `github.ref` is the same string for every push to main, which is what made them collide.
    expect(group).toContain("github.sha");
    expect(group).not.toMatch(/github\.ref\b/);
  });

  it("can be re-triggered without inventing a commit", () => {
    // GitHub's action-download service was unavailable on 6 August and killed a run in `Set up job`.
    // Without a manual trigger, recovering from someone else's outage means pushing something.
    expect(triggers).toContain("workflow_dispatch");
  });

  it("can read its own run history, which the live gap check needs", () => {
    // `contents: read` alone cannot list workflow runs. If this is dropped the live check below stops
    // being able to see anything — and would report "no gaps" for the wrong reason.
    expect(workflow.permissions?.actions).toBe("read");
  });

  it("still checks the things a green tick is claiming", () => {
    const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
    const commands = steps.map((step) => step.run ?? "").join("\n");
    // A green run should mean all of these ran. Removing one silently narrows what the tick means,
    // which is the failure this whole file exists to make impossible.
    for (const required of ["receipts:check", "pnpm lint", "pnpm typecheck", "pnpm test", "deploy --dry-run"]) {
      expect(commands, required).toContain(required);
    }
  });
});
