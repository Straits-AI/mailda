import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../..");

const {
  COMMAND_FOR, DISPOSITION_SAYS, dispositionOf, planFor, presenceIn, renderPlan, resourcesFrom,
  UNWIND_ORDER, unwindFor, workflowOwnerIn,
} = await import("../../../../../packages/cli/src/deploy-plan.mjs");
import type {
  Disposition, Plan, PlannedResource, Resource, ResourceKind,
} from "../../../../../packages/cli/src/deploy-plan.mjs";

/**
 * What a deploy would do to an account, before it does any of it (#162 L1).
 *
 * ## These tests are about being wrong in the useful direction
 *
 * A create-only plan is not merely incomplete — it is **wrong in the direction that costs an operator the
 * most**, and #92's drill measured all three ways:
 *
 * 1. A leftover from a failed attempt is reported as a create, and the deploy fails on it after creating
 *    whatever came before it. Auto-provisioning creates or fails and **never adopts**.
 * 2. A deleted D1 under a live Worker is reported as a create, and the deploy **reports success and changes
 *    nothing** — the binding is linked server-side, so the Worker keeps reading a dead id.
 * 3. A Workflow another Node owns is reported as a create, and the deploy **succeeds, exit 0, no warning**,
 *    and takes it.
 *
 * Every one of those is a plan promising something benign and a deploy doing something else. So the
 * assertions here are mostly about the *unhappy* dispositions, and the happy one — `create` on an empty
 * account — is the single easy case.
 */

const CONFIG = readFileSync(join(ROOT, "apps/node/worker/wrangler.jsonc"), "utf8");

/**
 * The planned item of a given kind, failing by name if it is absent.
 *
 * Rather than `find(...)!`. The assertion is the same either way; the difference is that a plan which stopped
 * producing a `d1` item fails here saying so, instead of throwing `Cannot read properties of undefined` from
 * whichever line happened to touch it first.
 */
function itemOf(plan: Plan, kind: ResourceKind): PlannedResource {
  const found = plan.items.find((one) => one.kind === kind);
  expect(found, `the plan has no ${kind} item`).toBeDefined();
  return found as PlannedResource;
}

/** An empty account: every list read, nothing in any of them, no Worker. */
function emptyAccount() {
  return { worker: false, lists: { d1: "", r2: "", queue: "", workflow: "" } };
}

/** A live Node: the Worker and all four resources present, the Workflow owned by this Worker. */
function liveAccount() {
  return {
    worker: true,
    lists: {
      d1: "mailda-catalog",
      r2: "mailda-evidence",
      queue: "mailda-sending-events",
      workflow: "│ mailda-butler-runs │ mailda │ 2026-08-27 │",
    },
  };
}

describe("the resource set comes from the config, and the names are derived the way wrangler derives them", () => {
  it("derives the three auto-provisioned names, matching what the drill measured", () => {
    const { worker, resources } = resourcesFrom(CONFIG);
    expect(worker).toBe("mailda");
    /*
     * The exact names the drill's Node got. Not restated as constants here *and* there: this asserts the
     * derivation reproduces the measurement, so a rule that drifted would fail rather than a list that was
     * copied twice.
     */
    expect(resources.filter((one) => one.derived).map((one) => one.name))
      .toEqual(["mailda-catalog", "mailda-evidence", "mailda-sending-events"]);
  });

  it("derives from the Worker's name, so a renamed Node plans correctly", () => {
    /*
     * The drill's second Node. `mailda2` got `mailda2-catalog`, `mailda2-evidence` and
     * `mailda2-sending-events` — colliding with nothing, which is the fact that makes the Workflow's
     * behaviour below the anomaly rather than the rule.
     */
    const renamed = CONFIG.replace('"name": "mailda"', '"name": "mailda2"');
    const { worker, resources } = resourcesFrom(renamed);
    expect(worker).toBe("mailda2");
    expect(resources.filter((one) => one.derived).map((one) => one.name))
      .toEqual(["mailda2-catalog", "mailda2-evidence", "mailda2-sending-events"]);
  });

  it("marks the Workflow as not derived, which is the whole of #99", () => {
    const { resources } = resourcesFrom(CONFIG);
    const workflow = resources.find((one) => one.kind === "workflow") as Resource;
    expect(workflow.name).toBe("mailda-butler-runs");
    /*
     * The asymmetry, asserted rather than described. Every other resource's name follows the Worker's, so
     * renaming a Node moves them all; the Workflow's is written in the config, so a renamed Node keeps
     * pointing at the original's Workflow name — and a Workflow is owned by exactly one script.
     */
    expect(workflow.derived).toBe(false);
    const renamed = resourcesFrom(CONFIG.replace('"name": "mailda"', '"name": "mailda2"'));
    expect(renamed.resources.find((one) => one.kind === "workflow")?.name)
      .toBe("mailda-butler-runs");
  });

  it("reads the Worker's name and not the first `name` in the file", () => {
    /*
     * `wrangler.jsonc` has five `"name"` keys — the Worker's, the Workflow's, two Durable Object bindings'
     * and `send_email`'s. `mailda.mjs` reads the first with a regex, which works only because of the file's
     * ordering. This asserts the parse survives that ordering changing, which a regex would not.
     */
    const reordered = JSON.stringify({
      workflows: [{ binding: "BUTLER_RUNS", name: "other-butler-runs", class_name: "ButlerRun" }],
      name: "the-actual-worker",
      d1_databases: [{ binding: "CATALOG" }],
    });
    expect(resourcesFrom(reordered).worker).toBe("the-actual-worker");
  });

  it("refuses a config with no Worker name rather than planning against undefined", () => {
    expect(() => resourcesFrom(JSON.stringify({ d1_databases: [{ binding: "CATALOG" }] })))
      .toThrow("E_PLAN_NO_WORKER_NAME");
  });

  it("fails loudly on a config it cannot parse, rather than planning from a partial read", () => {
    expect(() => resourcesFrom('{ "name": "mailda", }')).toThrow("E_PLAN_UNREADABLE_CONFIG");
  });

  it("takes a declared name over a derived one, because then wrangler derives nothing", () => {
    const declared = JSON.stringify({
      name: "mailda",
      d1_databases: [{ binding: "CATALOG", database_name: "somebody-elses-db" }],
    });
    const { resources } = resourcesFrom(declared);
    expect(resources[0]?.name).toBe("somebody-elses-db");
    expect(resources[0]?.derived).toBe(false);
  });
});

describe("reading a wrangler list, which has no --json", () => {
  it("finds a name that is there and not one that merely contains it", () => {
    expect(presenceIn("mailda-catalog", "mailda-catalog")).toBe(true);
    /*
     * The failure a bare `includes` would produce. `mailda-catalog` is a substring of `mailda-catalog-2`, so
     * an account holding only the second would be told the first is present — a plan reporting a resource as
     * existing when the deploy would create it, which is the opposite of the error and equally wrong.
     */
    expect(presenceIn("mailda-catalog-2", "mailda-catalog")).toBe(false);
    expect(presenceIn("premailda-catalog", "mailda-catalog")).toBe(false);
    // And found inside a table row, which is what these commands actually print.
    expect(presenceIn("│ mailda-catalog │ 1a2b3c │ 4 tables │", "mailda-catalog")).toBe(true);
  });

  it("answers null for a list it could not read, which is not an empty list", () => {
    /*
     * The distinction that matters most in this file. A missing permission or a failed call means the plan
     * does not know; reporting "absent, will create" from an unread list is exactly how a plan promises a
     * create that fails on a leftover.
     */
    expect(presenceIn(null, "mailda-catalog")).toBeNull();
    expect(presenceIn(undefined, "mailda-catalog")).toBeNull();
    expect(presenceIn("", "mailda-catalog")).toBe(false);
  });

  it("reads the Workflow's owning script from the table row", () => {
    const listed = [
      "┌────────────────────┬─────────┬──────────────┐",
      "│ Name               │ Script  │ Created      │",
      "│ mailda-butler-runs │ mailda2 │ 2026-08-27   │",
      "└────────────────────┴─────────┴──────────────┘",
    ].join("\n");
    // The drill's measurement: after the second Node deployed, the owner was `mailda2`.
    expect(workflowOwnerIn(listed, "mailda-butler-runs")).toBe("mailda2");
  });

  it("answers null for an owner it cannot establish, which must not read as nobody owns it", () => {
    expect(workflowOwnerIn(null, "mailda-butler-runs")).toBeNull();
    expect(workflowOwnerIn("some other workflow", "mailda-butler-runs")).toBeNull();
  });
});

describe("the five dispositions, and what each one costs when the plan says the wrong one", () => {
  const d1: Resource = { kind: "d1", name: "mailda-catalog", binding: "CATALOG", derived: true };

  it("create, on an empty account — the one case a create-only plan gets right", () => {
    expect(dispositionOf({ resource: d1, installed: false, present: false, owner: null, workerName: "mailda" }))
      .toBe("create");
  });

  it("linked, on a redeploy of a working Node", () => {
    expect(dispositionOf({ resource: d1, installed: true, present: true, owner: null, workerName: "mailda" }))
      .toBe("linked");
  });

  it("cannot_adopt, for a leftover from a failed attempt", () => {
    /*
     * The second-attempt case. Auto-provisioning **creates or fails and never adopts** — it will not reuse an
     * existing `mailda-catalog`, and it fails *after* creating whatever came before it in the list. So a
     * present resource with no Worker is not something to reuse; it is something to delete.
     */
    expect(dispositionOf({ resource: d1, installed: false, present: true, owner: null, workerName: "mailda" }))
      .toBe("cannot_adopt");
  });

  it("orphaned, for a resource deleted from under a live Worker", () => {
    /*
     * The worst of the five, because the deploy *succeeds*. The binding is linked server-side, so the Worker
     * keeps reading a dead database id while the CLI resolves the same name to a live one — a flow treating
     * "deploy again" as a repair reports success and changes nothing.
     */
    expect(dispositionOf({ resource: d1, installed: true, present: false, owner: null, workerName: "mailda" }))
      .toBe("orphaned");
  });

  it("stolen, for a Workflow another script owns", () => {
    const workflow: Resource = {
      kind: "workflow", name: "mailda-butler-runs", binding: "BUTLER_RUNS", derived: false,
    };
    /*
     * Measured, and the failure mode is the worse of the two possibilities: deploying does not refuse, it
     * **reassigns** — exit 0, no warning — and the previous owner keeps a BUTLER_RUNS binding pointing at a
     * Workflow now running this Node's code against this Node's bindings.
     */
    expect(dispositionOf({
      resource: workflow, installed: false, present: true, owner: "mailda2", workerName: "mailda",
    })).toBe("stolen");
    // Owned by this Worker on a redeploy is ordinary.
    expect(dispositionOf({
      resource: workflow, installed: true, present: true, owner: "mailda", workerName: "mailda",
    })).toBe("linked");
    // Present with an owner nobody could read is unknown, never "linked" — the reassignment is silent.
    expect(dispositionOf({
      resource: workflow, installed: true, present: true, owner: null, workerName: "mailda",
    })).toBe("unknown");
  });

  it("unknown, for a list it could not read, whatever the Worker's state", () => {
    for (const installed of [true, false]) {
      expect(dispositionOf({ resource: d1, installed, present: null, owner: null, workerName: "mailda" }))
        .toBe("unknown");
    }
  });
});

describe("the plan's verdict", () => {
  it("says install on an empty account, with four creates", () => {
    const plan = planFor({ configText: CONFIG, inventory: emptyAccount() });
    expect(plan.verdict).toBe("install");
    expect(plan.items.map((one) => one.disposition))
      .toEqual(["create", "create", "create", "create"]);
    // Nothing to unwind, so nothing is printed about deleting things that are not there.
    expect(plan.unwind).toEqual([]);
  });

  it("says redeploy on a live Node, with nothing to do", () => {
    const plan = planFor({ configText: CONFIG, inventory: liveAccount() });
    expect(plan.verdict).toBe("redeploy");
    expect(plan.items.every((one) => one.disposition === "linked")).toBe(true);
    expect(plan.unwind).toEqual([]);
  });

  it("blocks on a leftover, which is the second attempt after any failure", () => {
    /*
     * The exact shape the drill produced three times: the attempt died on the next resource, leaving what the
     * previous one had made. Here D1 was created and the R2 bucket was not.
     */
    const plan = planFor({
      configText: CONFIG,
      inventory: { worker: false, lists: { d1: "mailda-catalog", r2: "", queue: "", workflow: "" } },
    });
    expect(plan.verdict).toBe("blocked");
    expect(itemOf(plan, "d1").disposition).toBe("cannot_adopt");
    // And the rest are still creates, so the plan is specific rather than a blanket refusal.
    expect(plan.items.filter((one) => one.disposition === "create")).toHaveLength(3);
  });

  it("blocks on a deleted D1 under a live Worker, which a deploy would not repair", () => {
    const plan = planFor({
      configText: CONFIG,
      inventory: {
        worker: true,
        lists: {
          d1: "", r2: "mailda-evidence", queue: "mailda-sending-events",
          workflow: "│ mailda-butler-runs │ mailda │",
        },
      },
    });
    expect(plan.verdict).toBe("blocked");
    expect(itemOf(plan, "d1").disposition).toBe("orphaned");
    /*
     * Nothing to unwind: an orphaned binding is not a leftover to delete, it is a Node that needs a different
     * remedy entirely. A plan that offered a teardown here would be telling an operator to destroy a working
     * Node's evidence bucket to fix its database.
     */
    expect(plan.unwind).toEqual([]);
  });

  it("blocks on a stolen Workflow, and the deploy path already refuses the same thing", () => {
    const plan = planFor({
      configText: CONFIG,
      inventory: {
        worker: false,
        lists: { d1: "", r2: "", queue: "", workflow: "│ mailda-butler-runs │ somebody-else │" },
      },
    });
    expect(plan.verdict).toBe("blocked");
    expect(itemOf(plan, "workflow").disposition).toBe("stolen");
    expect(itemOf(plan, "workflow").owner).toBe("somebody-else");
  });

  it("does not block on an unread list, and names what went unchecked", () => {
    /*
     * The same trade `refuseIfWorkflowBelongsElsewhere` makes: `wrangler workflows list` needs a permission a
     * deploy token may not carry, and refusing every plan because a *diagnostic* was unavailable is the wrong
     * direction. What is right is naming it, which `unread` is for.
     */
    const plan = planFor({
      configText: CONFIG,
      inventory: { worker: false, lists: { d1: "", r2: "", queue: "", workflow: null } },
    });
    expect(plan.verdict).toBe("install");
    expect(plan.unread.map((one) => one.kind)).toEqual(["workflow"]);
  });

  it("is unknown when the Worker's own existence could not be established", () => {
    /*
     * Unlike the resource lists, this **does** stop the plan committing to a verdict. `mailda deploy` branches
     * on it — a first install deploys directly and every later deploy takes the canary path — so being wrong
     * here means skipping the canary on a live Node, which is the one ambiguity the deploy path also refuses
     * to guess at.
     */
    const plan = planFor({
      configText: CONFIG,
      inventory: { worker: null, lists: { d1: "", r2: "", queue: "", workflow: "" } },
    });
    expect(plan.verdict).toBe("unknown");
  });

  it("derives the verdict from the dispositions, so the two cannot disagree", () => {
    /*
     * Not a restatement of `planFor`. The failure this guards is a summary tracked beside the list it
     * summarises and drifting from it — `machine-surfaces.md`'s tier table and `budget-plan-scope.test.ts`
     * both exist because a count in a document stopped matching its code. Asserted over every combination
     * this planner can produce rather than over one example.
     */
    const blocking = ["cannot_adopt", "orphaned", "stolen"];
    for (const [name, inventory] of [
      ["empty", emptyAccount()],
      ["live", liveAccount()],
      ["leftover", { worker: false, lists: { d1: "mailda-catalog", r2: "", queue: "", workflow: "" } }],
      ["orphan", {
        worker: true,
        lists: { d1: "", r2: "mailda-evidence", queue: "mailda-sending-events", workflow: "│ x │ mailda │" },
      }],
    ] as const) {
      const plan = planFor({ configText: CONFIG, inventory });
      const hasBlocker = plan.items.some(
        (one) => blocking.includes(one.disposition),
      );
      expect(plan.verdict === "blocked", `${name}: verdict and dispositions disagree`).toBe(hasBlocker);
    }
  });
});

describe("the unwind, whose every step was found by getting it wrong", () => {
  it("keeps the measured order", () => {
    /*
     * Asserted as a sequence because the order *is* the finding. Each of these was a failed teardown before
     * it was a step: `code: 10064` when the Worker still consumed the queue, a refusal on a non-empty bucket,
     * and a Workflow that outlived the script it belonged to.
     */
    expect(UNWIND_ORDER.map((one) => one.step))
      .toEqual(["queue-consumer", "worker", "r2", "d1", "queue", "workflow"]);
    // And every step carries its reason, because a runbook step with no reason is one somebody reorders.
    for (const step of UNWIND_ORDER) expect(step.why.length).toBeGreaterThan(20);
  });

  it("prints only the steps that apply, so it never says to delete what is not there", () => {
    const plan = planFor({
      configText: CONFIG,
      inventory: { worker: false, lists: { d1: "mailda-catalog", r2: "", queue: "", workflow: "" } },
    });
    /*
     * A leftover database on an account with **no Worker** needs the database removed and nothing else.
     * Telling an operator to remove a queue consumer and delete a Worker that is not there is how a teardown
     * loses the reader's trust in the steps that are necessary.
     */
    expect(plan.unwind.map((one) => one.kind)).toEqual(["d1"]);
    expect(plan.unwind[0]?.target).toBe("mailda-catalog");
  });

  it("puts the consumer removal first, and only when there is a Worker holding one", () => {
    const withWorker = unwindFor({
      installed: true,
      worker: "mailda",
      items: [
        { kind: "queue", name: "mailda-sending-events", disposition: "cannot_adopt" },
        { kind: "d1", name: "mailda-catalog", disposition: "cannot_adopt" },
      ],
    });
    expect(withWorker.map((one) => one.kind))
      .toEqual(["queue-consumer", "worker", "d1", "queue"]);
    // The command needs both names, which is why this one step carries a pair.
    expect(withWorker[0]?.target).toBe("mailda-sending-events");
    expect(withWorker[0]?.consumer).toBe("mailda");

    const withoutWorker = unwindFor({
      installed: false,
      worker: "mailda",
      items: [{ kind: "queue", name: "mailda-sending-events", disposition: "cannot_adopt" }],
    });
    // No Worker, so no consumer to detach and no script to delete.
    expect(withoutWorker.map((one) => one.kind)).toEqual(["queue"]);
  });

  it("includes the Workflow when it is the thing in the way", () => {
    const unwind = unwindFor({
      installed: false,
      worker: "mailda",
      items: [{ kind: "workflow", name: "mailda-butler-runs", disposition: "stolen" }],
    });
    /*
     * A stolen Workflow is a leftover in the only sense that matters — the name is taken — and it is the one
     * resource whose deletion is necessary for a reason beyond ordering: it survives its script's deletion,
     * so a teardown that stops at the Worker leaves the name claimed.
     */
    expect(unwind.map((one) => one.kind)).toEqual(["workflow"]);
    expect(unwind[0]?.target).toBe("mailda-butler-runs");
  });

  it("offers nothing to unwind when nothing is in the way", () => {
    for (const inventory of [emptyAccount(), liveAccount()]) {
      expect(unwindFor({
        installed: inventory.worker,
        worker: "mailda",
        items: planFor({ configText: CONFIG, inventory }).items,
      })).toEqual([]);
    }
  });
});

describe("the words, which are what `--plan` actually delivers", () => {
  /*
   * The renderer lives in `deploy-plan.mjs` rather than in `mailda.mjs` for a reason this block is the proof
   * of: that file dispatches on `process.argv` at the top level, so importing it *runs* it, and the first
   * draft of this renderer was in there and therefore untestable.
   *
   * That was the wrong place, because **the words are the deliverable.** A plan whose dispositions are all
   * correct and whose sentences say the opposite is a plan an operator acts wrongly on, and no assertion
   * over the data model can catch it.
   */

  it("says a deploy will not reuse a leftover, in those words", () => {
    const text = renderPlan(planFor({
      configText: CONFIG,
      inventory: { worker: false, lists: { d1: "mailda-catalog", r2: "", queue: "", workflow: "" } },
    }));
    expect(text).toContain("BLOCKED");
    // The measured fact, said rather than implied by an enum name an operator has never seen.
    expect(text).toContain("never adopts");
    expect(text).toContain("will NOT reuse this");
    // And the flag is on the line that needs it, not on the three creates.
    const flagged = text.split("\n").filter((line) => line.trimStart().startsWith("!"));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toContain("mailda-catalog");
  });

  it("says a redeploy would report success and change nothing, for an orphaned binding", () => {
    const text = renderPlan(planFor({
      configText: CONFIG,
      inventory: {
        worker: true,
        lists: {
          d1: "", r2: "mailda-evidence", queue: "mailda-sending-events",
          workflow: "│ mailda-butler-runs │ mailda │",
        },
      },
    }));
    /*
     * The sentence that matters most in this file. The failure it describes is the only one where the deploy
     * *succeeds*, so an operator reading anything softer would run it again and believe it worked.
     */
    expect(text).toContain("reports success and changes nothing");
    expect(text).toContain("linked server-side");
    /*
     * And it explicitly does **not** offer a teardown here. A plan that printed the unwind for this case
     * would be telling an operator to destroy a live Node's evidence bucket to fix its database.
     */
    expect(text).toContain("unwind: nothing to remove");
    expect(text).not.toContain("wrangler d1 delete");
  });

  it("says the Workflow was taken, and names who has it", () => {
    const text = renderPlan(planFor({
      configText: CONFIG,
      inventory: {
        worker: false,
        lists: { d1: "", r2: "", queue: "", workflow: "│ mailda-butler-runs │ somebody-else │" },
      },
    }));
    expect(text).toContain("exit 0, no warning");
    expect(text).toContain("owner: somebody-else");
    // The unwind reaches it, because a Workflow survives its script's deletion.
    expect(text).toContain("wrangler workflows delete mailda-butler-runs");
  });

  it("prints copyable commands in the measured order, with both names on the consumer step", () => {
    const text = renderPlan({
      worker: "mailda",
      verdict: "blocked",
      installed: true,
      items: [],
      unread: [],
      unwind: unwindFor({
        installed: true,
        worker: "mailda",
        items: [
          { kind: "queue", name: "mailda-sending-events", disposition: "cannot_adopt" },
          { kind: "r2", name: "mailda-evidence", disposition: "cannot_adopt" },
          { kind: "d1", name: "mailda-catalog", disposition: "cannot_adopt" },
          { kind: "workflow", name: "mailda-butler-runs", disposition: "stolen" },
        ],
      }),
    });
    /*
     * The numbered steps and their continuations, not every line containing the word. The first version
     * matched `includes("wrangler ")` and picked up the closing paragraph — *"Not `wrangler deploy` as a
     * repair"* — as the last command, so `commands.at(-1)` was prose and the assertion failed against a
     * renderer that was correct.
     */
    const commands = text.split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(\d+\. )?wrangler /.test(line));
    /*
     * The order the runbook found by getting it wrong, asserted as a sequence over the rendered text — which
     * is the artefact an operator copies. `queues consumer worker remove` needs both the queue and the
     * Worker, so a step that printed one name would produce a command that does not run.
     */
    expect(commands[0]).toContain("queues consumer worker remove mailda-sending-events mailda");
    expect(commands[1]).toContain("wrangler delete");
    expect(commands.some((one) => one.includes("r2 bucket delete mailda-evidence"))).toBe(true);
    expect(commands.some((one) => one.includes("d1 delete mailda-catalog -y"))).toBe(true);
    expect(commands.some((one) => one.includes("queues delete mailda-sending-events"))).toBe(true);
    expect(commands.at(-1)).toContain("workflows delete mailda-butler-runs");
  });

  it("names an unread list rather than passing over it", () => {
    const text = renderPlan(planFor({
      configText: CONFIG,
      inventory: { worker: false, lists: { d1: "", r2: "", queue: "", workflow: null } },
    }));
    expect(text).toContain("not checked: workflow");
    expect(text).toContain("would promise a create that fails");
  });

  it("states its own limit beside its answers", () => {
    const text = renderPlan(planFor({ configText: CONFIG, inventory: emptyAccount() }));
    /*
     * The plan reads *names*, not ids, so it cannot tell whether a present resource is the one this Worker's
     * binding points at. #162 asks for a plan correct on a second attempt; saying where that correctness
     * stops belongs beside the answers rather than in a receipt nobody reads at three in the morning.
     */
    expect(text).toContain("reads resource *names*, not ids");
  });

  it("has a sentence for every disposition and a command for every unwind step", () => {
    /*
     * A closed world over both tables. A seventh disposition would render `undefined` into the plan, and an
     * unwind step with no command would print a numbered line with nothing to copy — both silent, and both
     * in the output an operator is acting on.
     */
    const dispositions: Disposition[] = [
      "create", "linked", "cannot_adopt", "orphaned", "stolen", "unknown",
    ];
    expect(Object.keys(DISPOSITION_SAYS).sort()).toEqual([...dispositions].sort());
    for (const one of dispositions) expect(DISPOSITION_SAYS[one].length).toBeGreaterThan(20);

    /*
     * Keyed by the `kind` the unwind emits, which is the step name for every entry — so this is the same
     * closed world read from the renderer's side.
     */
    expect(Object.keys(COMMAND_FOR).sort()).toEqual([...UNWIND_ORDER.map((one) => one.step)].sort());
  });

  it("wraps the long sentences, so the flagged lines stay readable", () => {
    const text = renderPlan(planFor({
      configText: CONFIG,
      inventory: { worker: false, lists: { d1: "mailda-catalog", r2: "", queue: "", workflow: "" } },
    }));
    // Not a style preference: the reader scanning for `!` lines is the one who will not follow a runaway line.
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });
});
