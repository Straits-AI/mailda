import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { maySend } from "../authz-read.ts";
import { BUTLER_RELEASE_REASON } from "./gate.ts";
import { RELEASE_EVENT } from "./interpret.ts";
import { abandonRun, runOfSubject } from "./record.ts";

/**
 * Releasing a Butler-proposed send: the human half of #50's gate.
 *
 * ## The manifest first, the instance second, and the order is the point
 *
 * A manifest outlives its run. Instance state is retained 3 days on Workers Free and 30 on Paid; a
 * `send_manifests` row is kept for ever. So the act that matters is the **D1 transition** — `awaiting` with
 * `butler_release_required` back to `held`, from where the ordinary hold window and `dispatchDue` take it —
 * and telling the parked instance is a courtesy that lets the rest of the program run. Doing it the other
 * way round would make a send unreleasable the day its run expired, which is the one deadline nobody should
 * inherit from a platform's retention policy.
 *
 * ## Conditional on the exact gate, so this cannot clear somebody else's
 *
 * The `UPDATE` names `state = 'awaiting' AND state_reason = 'butler_release_required'`. That is what stops it
 * being a way past a **policy** gate or an approval: those are `awaiting` too, with their own reasons, and
 * this predicate does not match them. `cancelSend` set the shape — *"conditional on still being stoppable,
 * which is what makes the race safe without a transaction D1 does not offer"* — and the same conditional
 * makes a release that raced a cancellation lose at the database rather than sending cancelled mail.
 *
 * ## Who may release, and why it is `send.propose`
 *
 * The authority that would have been needed to compose the message. #60 gave a policy hold's release to any
 * `send.propose` holder and this follows it: the gate exists because *no person had seen it*, not because a
 * stricter authority is owed. Requiring `approval.decide` would have made this the approval machinery with
 * none of its guarantees — no stages, no actor exclusion, no expiry — which is the worst of both.
 *
 * ## The audit entry names the **person**, never the Butler
 *
 * That is the whole value of the gate. `send.sealed` already records the Butler as the actor with
 * `actor_kind = butler`; this records who agreed it could go. Two entries about one send, each answering a
 * question the other cannot.
 */

export type ReleaseOutcome =
  | { released: true; runId: string | null; resumed: boolean }
  /** `not_found` covers absent, another organization's, not gated this way, and not visible to the caller. */
  | { released: false; reason: "not_found" };

/**
 * Releases one send.
 *
 * `not_found` for everything that is not a successful release, and that is §5C rather than laziness: a
 * caller who may not send as the mailbox must not be able to tell a manifest that exists from one that does
 * not, and a manifest gated by a *policy* must not be distinguishable from one that is not gated at all —
 * otherwise this route is a way to enumerate which sends are waiting on which gate.
 *
 * **The gate is named in three predicates and any one of them is sufficient.** The read below, the
 * conditional `UPDATE`, and the `AuditGate` beside it all carry `state_reason = 'butler_release_required'`,
 * and widening any *two* of them changes nothing observable — only widening all three lets a policy-gated
 * send be released.
 *
 * That is a **mutation measurement, not a test**, and the difference is stated because the first draft of
 * this paragraph claimed a test proved it. No test can: widening a predicate means editing this file, so what
 * `test/butler-run.test.ts` pins is the *outcome* — a `policy_hold` send answers `not_found`, stays
 * `awaiting`, and appends no `send.released` entry — which is what fails if any one of the three is widened
 * in a way that matters, and passes if the redundancy is trimmed. So the redundancy is genuine rather than
 * the kind that reads as redundancy and is load-bearing, and the reason to keep all three anyway is that
 * they enforce different things: the read decides the answer, the `UPDATE` decides the race, and the gate
 * decides whether the trail records an act that happened.
 */
export async function releaseButlerSend(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  manifestId: string,
): Promise<ReleaseOutcome> {
  const target = await env.CATALOG.prepare(
    `SELECT mailbox_id FROM send_manifests
      WHERE org_id = ? AND id = ? AND state = 'awaiting' AND state_reason = ? LIMIT 1`,
  ).bind(orgId, manifestId, BUTLER_RELEASE_REASON).first<{ mailbox_id: string }>();
  if (target === null) return { released: false, reason: "not_found" };

  if (!(await maySend(env, { orgId, userId: actorUserId }, target.mailbox_id))) {
    return { released: false, reason: "not_found" };
  }

  const at = new Date(ctx.now()).toISOString();
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "send.released",
      outcome: "ok",
      actorUserId,
      subject: manifestId,
      detail: { mailboxId: target.mailbox_id, reason: BUTLER_RELEASE_REASON },
    },
    (entry) => [
      // The entry precedes the update it tests, which `AuditGate` requires: an update that cleared the
      // predicate first would leave the act done and unrecorded.
      entry,
      env.CATALOG.prepare(
        `UPDATE send_manifests SET state = 'held', state_at = ?, state_reason = NULL
          WHERE org_id = ? AND id = ? AND state = 'awaiting' AND state_reason = ?`,
      ).bind(at, orgId, manifestId, BUTLER_RELEASE_REASON),
    ],
    {
      sql: `SELECT 1 FROM send_manifests WHERE org_id = ? AND id = ?
              AND state = 'awaiting' AND state_reason = ?`,
      params: [orgId, manifestId, BUTLER_RELEASE_REASON],
    },
  );

  // Lost the race: cancelled, or released by somebody else, between the read and the commit. Nothing
  // committed — the entry and the update share one transaction — so this is the honest answer.
  if ((results[1]?.meta.changes ?? 0) === 0) return { released: false, reason: "not_found" };

  const runId = await runOfSubject(env, orgId, manifestId);
  if (runId === null) return { released: true, runId: null, resumed: false };

  /*
   * Tell the parked instance. Best effort, and the failure is a **state** rather than a swallowed error:
   * an instance whose retention has expired cannot be resumed, so the run is closed as `finished` with
   * `released_after_run_expired` instead of being left reading `awaiting_release` for ever. The send is
   * already released either way, which is the property the ordering above exists to give.
   */
  try {
    const instance = await env.BUTLER_RUNS.get(runId);
    await instance.sendEvent({ type: RELEASE_EVENT, payload: { manifestId, by: actorUserId, at } });
    return { released: true, runId, resumed: true };
  } catch {
    // The counts are left exactly as the run last wrote them — see `abandonRun`.
    await abandonRun(env, ctx, orgId, runId, "finished", "released_after_run_expired");
    return { released: true, runId, resumed: false };
  }
}
