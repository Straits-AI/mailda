import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { createSystemCtx } from "@mailda/runtime";

import { interpret, type ButlerRunPayload, type RunSteps } from "./interpret.ts";

/**
 * `ButlerRun`: **one** generic Workflow class for every Butler on this Node (#50).
 *
 * ## Why one class and not one per Butler
 *
 * Because a Butler is *runtime data*. #49 made publication the versioning event and a published version
 * immutable, with no deploy anywhere in that lifecycle — and a Workflow class is code in a bundle, so a
 * class per Butler would have made publishing one require a deploy, which is the thing that decision
 * forbids. This class is handed `{ butlerVersionId, trigger }` and interprets whatever `ast_json` it reads.
 *
 * Three further things fall out of it, and each is worth more than the tidiness:
 *
 * - **Retiring or deleting a Butler leaves no residue.** `workflow-provisioning.md` measured that deleting
 *   a Worker leaves its workflow behind, needing `wrangler workflows delete` — the same asymmetry #67 and
 *   #74 record for R2 objects and #72 for the Queues subscription. With a class per Butler, every published
 *   Butler would have left one orphaned account-level resource behind it, for ever, invisible to the Worker.
 *   With one generic class there is exactly **one** workflow on the account no matter how many Butlers come
 *   and go, and the only thing a teardown has to name is the Node's own.
 * - **An in-flight instance survives a publication.** The payload names a *version*, so a run that started
 *   under v3 goes on reading v3's frozen AST while v4 is live. That is the property #49's immutability was
 *   for, and it works here because nothing about the run is compiled.
 * - **A Butler with no channel is still runnable.** There is no route that publishes one yet; the day there
 *   is, nothing here changes.
 *
 * ## Why this class is four lines and the interpreter is a function
 *
 * `run()` receives `this.env` from the platform. `metering()` wraps an env a *caller* passes in, so an
 * entrypoint that did the work could never be measured — and this layer's cost is exactly the thing #54's
 * arithmetic has to be checked against. So the walk is `interpret(env, ctx, payload, steps, runId)` and this
 * is the adapter that supplies the real three.
 *
 * ## The instance id is the run id, and it comes from the platform rather than from us
 *
 * `event.instanceId` is `<butlerVersionId>-<triggerKey>` because `trigger.ts` created it with that id. Read
 * back off the event rather than recomputed from the payload, so the record's primary key is the id the
 * platform is actually addressing — a recomputation that disagreed would put the record under a key
 * `wrangler workflows instances describe` cannot find.
 */
export class ButlerRun extends WorkflowEntrypoint<Env, ButlerRunPayload> {
  override async run(event: Readonly<WorkflowEvent<ButlerRunPayload>>, step: WorkflowStep): Promise<unknown> {
    const result = await interpret(this.env, createSystemCtx(), event.payload, adapt(step), event.instanceId);
    /*
     * A summary, not the whole result.
     *
     * An instance's output is serialized and retained with it (3 days Free / 30 Paid), and the full result
     * carries every effect row and the cost meter's breakdown — all of which is already in D1, permanently,
     * where a person can read it. Returning it here would be a second copy with a shorter life, which is
     * exactly the two-truths shape the run record was split from instance state to avoid.
     */
    return {
      runId: result.runId,
      state: result.state,
      reason: result.reason,
      effects: result.effects.length,
      subrequests: result.cost.subrequests,
    };
  }
}

/**
 * The three methods the interpreter asks for, over the real `WorkflowStep`.
 *
 * **Durations are milliseconds.** `step.sleep` and `waitForEvent`'s `timeout` both accept either a duration
 * string (`"30 minutes"`) or a number, and the number is milliseconds. The AST carries `wait.seconds`, so
 * the conversion happens here — once, in the adapter — rather than in the interpreter, which then has one
 * unit throughout and a test runner that does not have to agree with the platform about a spelling.
 *
 * `waitForEvent` resolves with a `WorkflowStepEvent` and the interpreter wants only its payload. Unwrapped
 * here for the same reason: the narrower interface is what lets a test supply a runner at all.
 */
function adapt(step: WorkflowStep): RunSteps {
  return {
    do: async <T>(name: string, body: () => Promise<T>): Promise<T> =>
      // The cast is the one place this file has to reach past the platform's type. `step.do` requires an
      // `Rpc.Serializable` return, and the interpreter's step results are plain JSON objects — which
      // satisfy it in fact but not in a way a generic `T` can prove. Narrowing `RunSteps` to
      // `Rpc.Serializable` instead would push that constraint through every effect handler for no gain.
      await (step.do as (n: string, b: () => Promise<unknown>) => Promise<unknown>)(name, body) as T,
    sleep: async (name: string, seconds: number): Promise<void> => {
      await step.sleep(name, seconds * 1000);
    },
    waitForEvent: async (name: string, type: string, timeoutSeconds: number): Promise<unknown> => {
      // Cast for the same reason `do` is cast: `waitForEvent`'s type parameter must satisfy
      // `Rpc.Serializable`, and the interpreter deliberately does not know what a release event carries —
      // it only needs to be told that one arrived.
      const received = await (step.waitForEvent as unknown as (
        n: string, o: { type: string; timeout: number },
      ) => Promise<{ payload: unknown }>)(name, { type, timeout: timeoutSeconds * 1000 });
      return received.payload;
    },
  };
}
