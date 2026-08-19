import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

/**
 * A Workflow that exists only to be **provisioned**, for #55.
 *
 * ## What this is measuring, and why it needs a real deploy
 *
 * #50 chose Workflows as the Butler engine, and that choice rests on a fact measured for one token only.
 * #47 established that `wrangler deploy` creates a workflow with no resource id in the config — but through
 * an *interactive* OAuth token with Super Administrator privileges. §11A's one-click equivalence claim rests
 * on the other path entirely: the token **Workers Builds generates for itself**.
 *
 * `queue-provisioning.md` already recorded that the button behaves differently from the CLI — a
 * consumer-only queue binding fails the install outright — so "the CLI managed it" is not evidence about
 * the button, and no amount of reading settles it. Somebody has to click Deploy and watch.
 *
 * ## Why it does nothing
 *
 * The question is whether a **binding can be created**, not whether a run can execute. A step that did real
 * work would put its own failure modes between the deploy and the answer, and a failed run would be
 * indistinguishable from a failed provision. So this sleeps for a second and returns, and the finding is
 * whether `wrangler workflows list` shows it afterwards.
 *
 * ## No `schedules`
 *
 * Deliberate, and it is a decision rather than an omission: `workflow-provisioning.md` measured that
 * wrangler at this repository's declared floor **discards an unrecognised config field and exits 0**, and
 * separately that `workflows[].schedules` is dropped silently. A Node therefore never declares one — a
 * schedule that vanishes with a zero exit code is worse than no schedule. `deployability.test.ts` enforces
 * that absence.
 *
 * ## This file is not the Butler
 *
 * Nothing imports it, nothing routes to it, and it holds no Mailda vocabulary. If the measurement comes back
 * positive, the real engine is built against the answer; if negative, this file is deleted along with the
 * binding and #55 records that the button cannot provision a Workflow — which #55 says plainly is a good
 * answer, not a failure. Either way it must not survive as scaffolding that looks like a feature.
 */
export class ButlerProbe extends WorkflowEntrypoint<Env, { note?: string }> {
  override async run(event: WorkflowEvent<{ note?: string }>, step: WorkflowStep): Promise<string> {
    // One sleep, so the instance is observably a Workflow rather than a function call, and no I/O — this
    // spends none of the 10,000-subrequest per-instance budget `butler-step-budget.md` measured.
    await step.sleep("a moment", "1 second");
    return event.payload.note ?? "provisioned";
  }
}
