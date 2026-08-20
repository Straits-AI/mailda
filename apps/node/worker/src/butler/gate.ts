/**
 * The human-release gate on a Butler-proposed send: the one send state #50 adds (§16, ADR 39).
 *
 * ## Why a send state and not only a parked Workflow
 *
 * #50's resolution gives the release gate a mechanism — *"the run parks on `waitForEvent` until the release
 * arrives, costing no concurrency while it waits"* — and a parked run on its own is **not a gate**. A
 * manifest sealed `held` is picked up by `dispatchDue` the moment its hold window elapses, because
 * `movableNow` admits `state = 'held' AND release_at <= ?`. So a Butler that sealed and parked would have
 * had its mail sent by the sweeper while the run sat waiting for a person who was never needed.
 *
 * Two things, correctly separated, which is the same split the run record makes: **the gate is in D1, the
 * waiting is in the Workflow.** The manifest is sealed `awaiting` with this reason, which `movableNow`
 * refuses to move because the reason is not one of `BREAKER_REASONS`; the run parks so that a release can
 * carry it on to whatever the Butler does next. Either half without the other is a defect: without the D1
 * state the mail leaves unreleased, and without the parked run a release cannot resume the program.
 *
 * It also means a send stays releasable **after its run is gone**. Instance state is retained 3 days on
 * Free and 30 on Paid; a manifest is kept for ever. `releaseButlerSend` therefore acts on the manifest
 * first and tells the instance second, tolerating one that has expired.
 *
 * ## Where it sits in §18's total order, and why there
 *
 * `sealManifest` orders every gate and refusal so that conflict resolution is one comparison. This adds one
 * rank:
 *
 *     policy deny  >  domain pause  >  require_approval  >  policy hold  >  **butler release**  >  rate gate  >  allow
 *
 * Below every policy gate, because a policy gate is a rule somebody wrote about this send and this is a
 * property of who proposed it — and because `require_approval` already *is* a human gate, so adding a
 * second ask on top of it would mean two people clearing one send for one reason.
 *
 * Above the rate gate, and that is the load-bearing placement. `manifest.ts` states the rule it follows
 * from: *"a policy gate needs a person to clear it and a rate gate needs time, so if both apply, the reason
 * a reader must act on is the human one"*. A Butler send that was also over rate would otherwise carry a
 * reason saying *"nothing has to be cleared by anybody, and it goes on its own"*, which is false of it. The
 * rate is re-asked at dispatch after the release, exactly as it is after an approval.
 *
 * ## Only over `held`, which is what keeps the state machine sound
 *
 * The gate is written only when the seal would otherwise have been movable. A `withheld` send is not
 * re-opened into a queue somebody could clear, and an `awaiting` policy gate keeps its own reason. So this
 * reason and every other are exclusive, which is what lets one column carry them.
 *
 * ## Why not require an approval instead
 *
 * It was the tempting answer: #61's machinery already asks a person, records stages, excludes the actor and
 * releases the send. Two reasons it is the wrong one, and both are #49's rather than a preference.
 *
 * 1. **A Butler may not request an approval.** `approval.request` is a *reserved* node, refused at
 *    publication, and the reason `nodes.ts` gives is exactly this: approvals are requested by the policy
 *    plane at seal, and a second way to create one is the correspondence problem ADR 35 rejected. An engine
 *    that requested one directly would be the reserved node, built in the engine instead of the AST.
 * 2. **It is already expressible, and better, as a policy.** Because a Butler's principal is the Butler
 *    (`principal.ts`), an administrator can publish a policy whose `actor` condition names the `btl_` and
 *    whose outcome is `require_approval` — governed, versioned, staged, auditable. This gate is the
 *    *default* for a program with no human present, not a replacement for that rule: when the policy exists,
 *    it outranks this and the Butler send goes through the approval instead.
 */

/** The machine token. The words live in `src/client/delivery.client.js`, like every other send reason. */
export const BUTLER_RELEASE_REASON = "butler_release_required";

/**
 * Every reason this gate mints, as a list.
 *
 * One member today. It is a list rather than a bare constant for the reason `POLICY_REASONS` and
 * `BREAKER_REASONS` are lists: the closed-world check over the reason vocabulary in
 * `test/outbound-recheck.test.ts` reads a set from each module that mints tokens, and a module that
 * contributed a single string instead would be the one entry somebody has to remember to spell.
 */
export const BUTLER_REASONS: readonly string[] = [BUTLER_RELEASE_REASON];

/**
 * How long a proposed send waits for a person before the run gives up on it.
 *
 * **Reused rather than invented**, and the figure is `approval.send_expiry_seconds` —
 * *"how long an approval of a send stays good for; Mailda's own governance preference, sized rather than
 * measured"* (`dispatch-recheck-cost.md`, classified `mailda` in `budget-plan-scope.test.ts`). A release
 * *is* a person agreeing to a Butler's send in substance, so *"how long may a proposed send wait for a
 * human"* is the same governance question that figure already answers. Writing a second number here would
 * be a number with no receipt, and writing a *different* second number would mean this Node held two
 * opinions about how long a person has to decide about one send.
 *
 * **What expiry does and does not do**, said exactly because the difference is the whole honesty of the
 * gate: the *run* stops waiting and records `release_timed_out`. The *send* does not move — it stays
 * `awaiting` with this reason, still releasable by the route and still cancellable — because a timeout is
 * this Node running out of patience, not a person deciding, and letting a clock hand mail over would make
 * the gate a delay rather than a gate.
 */
export const RELEASE_TIMEOUT_BUDGET = "approval.send_expiry_seconds" as const;
