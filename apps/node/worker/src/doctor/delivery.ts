import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { evaluateBreakers, pausesInForce, RATE_BREAKERS } from "../breakers.ts";
import { type Finding } from "../doctor.ts";
/**
 * Two things a Node needs before a delivery outcome can reach it, and **neither is in this Worker's
 * config** — so neither can be checked from inside a Worker, and both are reported rather than omitted.
 *
 *   the queue consumer   — this Worker subscribed to its own sending-events queue. Since #72 the producer
 *                          binding names no queue (a queue name is account-scoped, so a committed one made
 *                          the second Node in an account bind to the first Node's queue), and a consumer
 *                          block cannot name a queue whose name the config does not know. So the consumer
 *                          is attached out of band.
 *   the subscription     — the account-level `email.sending` object that feeds the queue. API-only:
 *                          `queue-provisioning.md` records `queues.subscription_creatable_by_cli: 0`.
 *
 * `workers_paid_plan` is the precedent for the shape and the argument is the same one: an absent check
 * reads exactly like a passing one.
 *
 * ## What this comment used to say, and why the sentence had to change rather than stay
 *
 * It said a Worker holds no account credential, so it cannot ask Queues who consumes its queue, and that
 * inventing a check that could not work would be worse than naming the question. That was true when it was
 * written and **ADR 42 made it false**: the Node now holds a Cloudflare credential of its own (an API token
 * since 26 September 2026, an OAuth grant before that; `docs/cloudflare-grant.md`), or is handed the
 * operator's wrangler consent on the request, and two plain reads settle all three objects. `butler_execution` is the precedent for the rewrite as well
 * as the shape — the hazard in a permanently-true `detail` is that it stays in the file long after it stops
 * describing the world, and *nothing looks wrong*: the check still runs, still passes, still reads as
 * verified.
 *
 * The answer is not moved into this report, though. It costs live Cloudflare calls and may renew a token,
 * and `doctor.max_subrequests_per_run` is a budget with a receipt — a report that reached the network to
 * produce a finding would be spending the account's authority every time anything asked how the Node was.
 * So the check names the surface that does answer it, and `test/node/delivery-events-world.test.ts` fails the
 * day that surface stops existing.
 *
 * `report`, `ok: true`, always. It is a fact about how a Node is installed rather than a fault, it varies
 * with nothing this Node can see, and a finding that fails on every Node forever is one somebody mutes —
 * the failure mode `DELIVERY_SILENCE_MS` names in this same file. What *does* fail, from evidence, is
 * `delivery_visibility` below: hand-overs old enough to have been answered with nothing heard back. So the
 * un-actionable capability is stated once and the observable consequence is what carries a severity.
 */
export function sendingEventsConsumerCheck(): Finding {
  return {
    check: "sending_events_consumer",
    severity: "report",
    // The queue's name is derived from the Worker's name and the binding's name, both of which are in this
    // public repository or chosen by the operator. No organization content, so this survives into the
    // reduced report an unauthenticated locked-out operator sees, for the reason planCheck's does.
    discloses: "infrastructure",
    ok: true,
    detail:
      "Not answered here, and answerable: `GET /api/provider/delivery-events` reads it with the Cloudflare " +
      "credential this Node holds — its stored API token, or the operator's wrangler consent carried on the " +
      "request — and names which of the three objects is missing — the `email.sending` event " +
      "subscription, the queue it publishes to, or a consumer on that queue. It is not folded into this " +
      "report because it costs live Cloudflare calls, and a report that reached the network would spend " +
      "the account's authority every time anything asked how this Node was. Neither missing object comes " +
      "from wrangler: the subscription is created by the API alone (measured 16 September 2026: " +
      "`POST /accounts/{id}/event_subscriptions/subscriptions` with an `email.sending` source creates one " +
      "for an onboarded sending domain and refuses a domain that is not; wrangler 4.118.0 offers no such " +
      "source). `POST /api/provider/subscription` makes that call with the same credential, which needs " +
      "`queues.write` (measured), and attaches this Worker as the queue's consumer when nothing consumes " +
      "it; `pnpm --filter @mailda/worker run queue:attach-consumer` does the consumer half from a shell for " +
      "a Node holding no token. So a button-only install can observe its delivery outcomes once somebody " +
      "confirms the subscription, except for mail to a verified destination address of the account, for " +
      `which Cloudflare published no outcome ${MEASURED}; until then their absence is reportable by name ` +
      "instead of inferable from silence. `delivery_visibility` reports the consequence from evidence.",
    receipt: "docs/receipts/queue-provisioning.md",
  };
}


/**
 * Can this Node see what happened to the mail it sent?
 *
 * A Node cannot receive its own bounces (`cloudflare-email-sending.md`, corrected), so delivery outcomes
 * arrive only on a queue, fed by a Queues event subscription. Two account-level things stand between a
 * hand-over and an observed outcome, and the `sending_events_consumer` finding above names both: the
 * subscription is not in `wrangler.jsonc`, wrangler's CLI cannot create it, and the dashboard's own modal
 * currently throws — so it has to be created through the API (`queue-provisioning.md`).
 * `POST /api/provider/subscription` creates it with this Node's credential, and `mailda install`, `setup` and
 * `upgrade` make the same call with wrangler's login carried on the request.
 *
 * Which means it can be absent, deleted, disabled, or pointed at the wrong sending domain, and **nothing
 * about a Node in that state looks wrong**: sends still hand over, the outbox still fills, and every
 * recipient sits at `unobserved` forever. No events is indistinguishable from nothing having bounced,
 * which is the exact ambiguity Layer 2 exists to remove — so the silence has to be named.
 *
 * `degraded`, not `refuse`. A Node without it still sends honest mail and still reports `handed_over`
 * truthfully; what it cannot do is tell you what happened next. Refusing to run would trade a working
 * product for a missing observation, which is precisely the trade AGENTS.md forbids.
 *
 * The subscription itself is asked of the platform by `GET /api/provider/delivery-events`, with the
 * credential ADR 42 gave the Node; this check does not ask, because doctor makes no live call (the
 * `sending_events_consumer` header above says why). It compares what this Node has handed over against what
 * it has heard back — which is the thing a person actually wants to know, and is true even if a
 * subscription exists but is misrouted.
 *
 * ## One kind of silence is expected (28 September 2026)
 *
 * No outcome is reported for verified destinations: Cloudflare published no `email.sending` event for mail
 * to a verified Email Routing destination of the account in the one case measured
 * (`docs/receipts/email-sending-events.md`, which also records how thin that is). Which of this Node's
 * recipients were verified destinations, and over which interval, is read from the account by
 * `POST /api/provider/verified-destinations` and recorded in two tables this check reads with its one
 * statement. So it still makes no live call, and it tells three silences apart: explained by a read,
 * covered by a read and not explained (the subscription is the suspect), and not covered by any read yet
 * (which comes first is the read). Evidence against the inference, an event published for a recipient a read
 * explained, an event this Node could not attribute for an address a read listed, or an event that arrived
 * unusable, voids the explanation rather than being outvoted by it. On a Node that is hearing outcomes the
 * evidence is reported as `delivery_explanation_void`, a degraded finding of its own.
 *
 * One way an event can still go unseen: one whose apply throws (a D1 failure) is logged by the consumer as
 * `sending_event.failed` and retried up to the consumer's `max_retries` (3, `docs/receipts/queue-provisioning.md`)
 * with no dead-letter queue, then dropped. That line names no recipient and is not counted here, because the
 * failure that drops an event is the one that keeps its log line out of D1 (`log` falls back to the console), and
 * because a failure a retry recovered from would void the explanation for nothing. An accepted gap.
 */
export async function checkDeliveryVisibility(env: Env, ctx: Ctx, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "delivery_visibility",
      severity: "degraded",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so nothing has been sent.",
    }];
  }

  const window = new Date(ctx.now() - DELIVERY_SILENCE_MS).toISOString();
  // One statement, as before: the awaiting population is scanned once, with a primary-key lookup per row into
  // each table the verified-destination read writes, and for a silent row one sre_by_manifest lookup for whether
  // an event was published for it (docs/receipts/doctor-check-cost.md, 28 September 2026).
  const counted = await env.CATALOG.prepare(
    `SELECT
       COUNT(*)                                            AS awaiting,
       COALESCE(SUM(silent), 0)                            AS unobserved,
       COALESCE(SUM(silent AND listed), 0)                 AS unreported,
       COALESCE(SUM(silent AND NOT listed AND covered), 0) AS checked,
       -- An event published for a recipient a read listed at hand-over, whether or not it set a delivery state:
       -- a complained event, or a type this Node does not know, is stored attributed and sets none.
       COALESCE(SUM(listed AND heard), 0)                  AS contradicting,
       -- Split, and the split is the point. An event this Node could not tie to a manifest is evidence
       -- that ATTRIBUTION is broken, not evidence that the Node can see. Counting the two together meant
       -- one unattributable event flipped the blindness flag to false and suppressed the very warning the
       -- check exists to raise. Migration 0010 built the sre_unattributed index over exactly these rows
       -- and nothing ever read it, which is the tell that somebody expected them to matter.
       --
       -- No backticks in this comment: it sits inside a TypeScript template literal, so one would end it.
       -- That hazard has now bitten four times in this codebase (ui.ts, response-clock.ts, and here).
       (SELECT COUNT(*) FROM send_recipient_events
         WHERE org_id = ?1 AND manifest_id IS NOT NULL) AS attributed,
       --
       -- Two counts, and the window between them is what tells a fault from a fact. Unattributable events
       -- STILL ARRIVING mean something is publishing here that this Node did not send: a live
       -- misconfiguration, and the thing this check exists to catch. Unattributable events that stopped
       -- are history — a message sent from this domain by something else, once — and no action resolves
       -- them, because the rows are correctly recorded and migration 0010 keeps them deliberately.
       --
       -- Counting them together made this degrade for ever on three events from five weeks ago. A finding
       -- that fails on every Node for ever is one somebody mutes, which is the failure mode
       -- DELIVERY_SILENCE_MS names in this same file and sendingEventsConsumer avoids by construction.
       (SELECT COUNT(*) FROM send_recipient_events
         WHERE org_id = ?1 AND manifest_id IS NULL AND received_at >= ?2) AS unattributed,
       (SELECT COUNT(*) FROM send_recipient_events
         WHERE org_id = ?1 AND manifest_id IS NULL) AS unattributed_ever,
       --
       -- Events that arrived with no usable event id or recipient. applySendingEvent logs each one as
       -- sending_event.unusable instead of storing it, and any one of them may have been the outcome a
       -- silent recipient is waiting for, so one is enough to void every explanation below. Read from the
       -- retained log, which is trimmed at log.retained_entries: an old one stops counting when its line goes.
       -- An event dropped after its retries failed is not counted, and the header above says why.
       (SELECT COUNT(*) FROM log_entries
         WHERE org_id = ?1 AND level = 'error' AND event = 'sending_event.unusable') AS unusable,
       --
       -- Events this Node could not tie to a send, for an address a read showed as a verified destination
       -- when the event arrived, by the same interval rule as listed below. Evidence against the explanation
       -- either way: Cloudflare published an outcome for a verified destination, or one of this Node's own
       -- recipients lost its attribution. contradicting counts only attributed events, so without this an
       -- event for a listed address could sit in delivery_attribution while the silence was called expected.
       (SELECT COUNT(*) FROM send_recipient_events e
          JOIN verified_destination_recipients v ON v.org_id = e.org_id AND v.address = lower(e.recipient)
          LEFT JOIN verified_destination_read rd ON rd.id = 1
         WHERE e.org_id = ?1 AND e.manifest_id IS NULL
           AND v.verified_from <= e.received_at
           AND (e.received_at <= v.verified_until OR v.verified_until = rd.read_at)) AS contradicting_unattributed,
       --
       -- The latest read of the account's verified destinations: one row, or none when nobody has read it.
       -- read_at is the latest success and a failure does not move it; attempted_at and error are the
       -- latest attempt's.
       (SELECT account_id   FROM verified_destination_read WHERE id = 1) AS read_account,
       (SELECT read_at      FROM verified_destination_read WHERE id = 1) AS read_at,
       (SELECT attempted_at FROM verified_destination_read WHERE id = 1) AS attempted_at,
       (SELECT error        FROM verified_destination_read WHERE id = 1) AS read_error
     FROM (
       SELECT r.delivery_state IS NULL AS silent,
              -- heard: a delivery state, or an event attributed to this recipient of this send. The CASE keeps
              -- the lookup to silent rows; an event that sets a state is stored before it sets it.
              CASE WHEN r.delivery_state IS NOT NULL THEN 1
                   ELSE EXISTS (SELECT 1 FROM send_recipient_events e
                                 WHERE e.org_id = r.org_id AND e.manifest_id = r.manifest_id
                                   AND lower(e.recipient) = lower(r.address)) END AS heard,
              -- listed: the hand-over falls inside an interval a read proved (verified_from is Cloudflare's
              -- own timestamp, verified_until the latest read that listed the address), or after the latest
              -- read, for an address that read still listed. That second half is an extrapolation, and every
              -- sentence below that relies on it says so: an address removed from the account since the
              -- latest read stays listed here until the next read.
              COALESCE(v.verified_from <= r.submission_state_at
                       AND (r.submission_state_at <= v.verified_until OR v.verified_until = rd.read_at),
                       0) AS listed,
              -- covered: the send had finished before the latest successful read began, so that read saw
              -- its recipients. The manifest's state_at, which applyOutcome stamps with a fresh clock after
              -- every recipient write, and not the recipient's submission_state_at, which is the pass's
              -- start and would count a send still being dispatched during the read as checked. A manifest
              -- still outcome_unknown (a pass that died) is never covered.
              (m.state <> 'outcome_unknown' AND m.state_at <= COALESCE(rd.read_at, '')) AS covered
         FROM send_recipients r
         JOIN send_manifests m ON m.id = r.manifest_id
         LEFT JOIN verified_destination_recipients v ON v.org_id = r.org_id AND v.address = lower(r.address)
         LEFT JOIN verified_destination_read rd ON rd.id = 1
        WHERE r.org_id = ?1 AND r.submission_state = 'handed_over' AND m.state_at < ?2
       -- Strictly older than the window, as before this statement was rewritten. A send at the window's
       -- exact instant waits one more millisecond, and no test pins that edge (mutants: widen-comparison).
     )`,
  )
    .bind(orgId, window)
    .first<{
      awaiting: number; unobserved: number; unreported: number; checked: number; contradicting: number;
      attributed: number; unattributed: number; unattributed_ever: number; unusable: number;
      contradicting_unattributed: number;
      read_account: string | null; read_at: string | null; attempted_at: string | null; read_error: string | null;
    }>()
    .catch(() => null);

  if (counted === null) {
    return [{
      check: "delivery_visibility",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "Could not read the delivery tables.",
      fix: "check the migrations_applied finding first",
    }];
  }

  /*
   * The terms, per recipient. A hand-over counts once it is older than the window.
   *
   *   awaiting     handed over, the send older than the window
   *   unobserved   awaiting with no delivery state: an event wins, so an observed recipient is never here
   *   explained    unobserved, and a read shows the address verified at hand-over (listed); zero when voided
   *   listedVoided unobserved and listed, when voided: shown as verified, and not counted as explained
   *   known        unobserved, not listed, and covered by the latest successful read: known not explained
   *   unexplained  unobserved minus explained: silence nothing explains
   *   unchecked    unobserved, not listed, and not covered: silence no read has looked at yet
   *
   * **Evidence against the inference voids it.** An event published for a recipient a read explained
   * contradicts the receipt, and so does an event this Node could not attribute for an address a read listed;
   * an unusable event may have been somebody's outcome. Any one sets explained to zero, so this check stops
   * calling any silence expected until the evidence is resolved. It leaves known alone: the evidence weakens
   * "a read listed them", not "a read that covered them did not list them".
   */
  const voided = counted.unusable > 0 || counted.contradicting > 0 || counted.contradicting_unattributed > 0;
  const explained = voided ? 0 : counted.unreported;
  const listedVoided = voided ? counted.unreported : 0;
  const known = counted.checked;
  const unexplained = counted.unobserved - explained;
  const unchecked = counted.unobserved - counted.unreported - counted.checked;
  // Every hand-over old enough to have been answered, not one answer among them, zero **attributed** events
  // ever (`attributed`, not the total: see the query above), and some of that silence not explained. A Node
  // whose every silent recipient a read explains is not blind; a Node with mixed recipients and no events is
  // blind for its unexplained ones. `runDoctor` hands this finding's `ok` to `checkBreakers` as `blind`.
  // "Something awaiting" is not a separate term: unexplained > 0 already implies it.
  const blind = counted.unobserved === counted.awaiting && counted.attributed === 0 && unexplained > 0;

  /**
   * The third state, which used to be invisible.
   *
   * A Node receiving events it cannot tie to a manifest is **neither blind nor healthy**, and §5C's rule
   * against collapsing distinct states applies with more force in a diagnostic than anywhere else — the
   * whole value of `doctor` is that it does not blur. It is `degraded` rather than `refuse` because mail is
   * still leaving correctly; what is broken is this Node's ability to say what happened to it.
   */
  /**
   * The visibility finding, as a closure because there are now two ways out of this function.
   *
   * It was written inline at the single return, and the second return added for the historical-events
   * report would otherwise have been a second copy — which is how two findings with one name come to
   * disagree about the same numbers.
   *
   * Counts, a date and an account id; never an address. Which recipients are verified destinations is shown
   * only by the Outbox, which is bounded by who may read the send.
   */
  const visibility = (): Finding[] => {
    const base = { check: "delivery_visibility", severity: "degraded", discloses: "data" } as const;
    const observed = `${counted.awaiting - counted.unobserved} of ${counted.awaiting} handed-over recipient(s) `
      + `have an observed outcome, from ${counted.attributed} attributed event(s).`;
    const laterFailure = counted.read_at !== null && counted.read_error !== null
      ? ` A later attempt, at ${counted.attempted_at}, did not succeed (${counted.read_error}).`
      : "";
    // Named wherever a sentence relies on the extrapolation half of `listed`.
    const extrapolated = " An address removed from the account's list since the latest read still counts as "
      + "verified here until the list is read again.";
    const listedAgainst = counted.contradicting > 0 || counted.contradicting_unattributed > 0;
    const againstIt = [
      counted.unusable > 0
        ? `${counted.unusable} delivery event(s) reached this Node without an event id or a recipient and could `
          + "not be used (logged as sending_event.unusable), so no silence here is counted as explained: one of "
          + "them may have been the outcome."
        : null,
      counted.contradicting > 0
        ? `${counted.contradicting} recipient(s) that a read showed as verified destinations when handed over had `
          + `a delivery event published for them, which no verified destination did ${MEASURED}, so no silence here `
          + "is counted as explained until that is resolved."
        : null,
      counted.contradicting_unattributed > 0
        ? `${counted.contradicting_unattributed} delivery event(s) this Node could not tie to a send were for `
          + "addresses a read showed as verified destinations when the event arrived, so no silence here is "
          + "counted as explained: either Cloudflare published an outcome for a verified destination, or one of "
          + "them was the outcome of a send here."
        : null,
    ].filter((one): one is string => one !== null).join(" ") + (listedAgainst ? extrapolated : "");
    const voidFix = (counted.unusable > 0
      ? "read the sending_event.unusable log entries first: Cloudflare published events in a shape this Node "
        + "could not use. "
      : "") + (listedAgainst
      ? "remeasure docs/receipts/email-sending-events.md, or read the list again (mailda setup) in case those "
        + "addresses stopped being verified destinations after the last read. "
      : "") + (counted.contradicting_unattributed > 0
      ? "The delivery_attribution finding counts the events this Node could not tie to a send. "
      : "");
    // The recipients a read listed whose silence the evidence stops this check calling explained: named, so they
    // are neither dropped from the count nor described as not covered.
    const notCounted = (lead: string, named: boolean): string => listedVoided === 0 ? "" :
      `${listedVoided} ${lead} were shown as verified destinations when handed over`
      + (named ? ` by a read of this Cloudflare account's list (the latest at ${counted.read_at}, account `
        + `${counted.read_account})` : "")
      + `, and are not counted as explained.${listedAgainst ? "" : extrapolated}`;
    const sentences = (...said: string[]): string => said.map((one) => one.trim()).filter((one) => one !== "").join(" ");

    if (counted.awaiting === 0) {
      return [{ ...base, ok: true, detail: "Nothing has been handed over long enough to expect an answer yet." }];
    }

    // Known blind: a read that ran after these sends finished did not list them, so the subscription is the
    // suspect and the fix does not ask for the read again. Evidence that voids an explanation leaves this finding
    // standing, and comes first in the fix when there is any.
    if (blind && known > 0) {
      return [{
        ...base,
        ok: false,
        detail: `${known} recipient(s) handed over more than ${MINUTES} minutes ago were not shown as verified `
          + `Email Routing destinations at hand-over by this Node's read of Cloudflare account `
          + `${counted.read_account}'s list at ${counted.read_at}, taken after their sends had finished, and this `
          + `Node has received no delivery event it could attribute. ${NOTHING_HEARD}`
          + (unchecked > 0
            ? ` ${unchecked} more are not covered by that read, because the latest dispatch pass of their send had `
              + "not finished when it began (that pass ran during or after the read, or has not finished), and have "
              + "not been checked."
            : "")
          + (explained > 0
            ? ` ${explained} more were verified destinations when handed over, and no outcome is reported for `
              + `verified destinations, ${MEASURED}.${extrapolated}`
            : "")
          + laterFailure
          + (voided ? ` ${sentences(notCounted("more", false), againstIt)}` : ""),
        // The evidence first when there is any: events are arriving, so the subscription delivers something.
        fix: voidFix + SUBSCRIPTION_FIX,
      }];
    }

    // Blind, and no read covers the silence, or a read listed it and evidence voided that: whether these are
    // verified destinations decides everything else, so the fix asks that first. Voided, the evidence comes before
    // it, and the read's state is still said: the evidence voids an explanation, not what the read found.
    if (blind) {
      // unchecked is 0 here only when voided: not voided, K = 0 and V = unreported leave S = unchecked.
      const readState = counted.attempted_at === null
        ? "This Node has never read which of its recipients are verified destinations."
        : counted.read_at === null
          ? "This Node has never read which of its recipients are verified destinations: the attempt at "
            + `${counted.attempted_at} did not succeed (${counted.read_error}). That is could not read, not `
            + "none verified."
          : unchecked === 0
            ? ""
            : (listedVoided > 0 ? `The other ${unchecked} are not` : "None of them is")
              + " covered by this Node's latest read of the account's verified destinations "
              + `(${counted.read_at}, account ${counted.read_account}): the latest dispatch pass of their send had `
              + "not finished when that read began, so it cannot be shown to have seen them. That pass ran during "
              + "or after the read, or has not finished.";
      const uncovered = sentences(notCounted("of them", true), readState + laterFailure, voided ? againstIt : "");
      return [{
        ...base,
        ok: false,
        detail: `${unexplained} recipient(s) were handed over more than ${MINUTES} minutes ago and this Node `
          + `has received no delivery event it could attribute. ${uncovered} If they are verified Email Routing `
          + "destinations of this Cloudflare account, the silence "
          // Voided, the conditional must not resolve to "expected": that is the conclusion the evidence withholds,
          // and a read may have just listed them.
          + (voided
            ? `would be expected, since no outcome is reported for verified destinations ${MEASURED}, but the `
              + "evidence above stops this check calling it so."
            : `is expected: no outcome is reported for verified destinations, ${MEASURED}.`)
          + " If they are not, this Node cannot tell you whether any of them arrived, and \"no bounces\" here means "
          + "\"nothing heard\" rather than \"nothing failed\"."
          + (explained > 0
            ? ` ${explained} more were verified destinations when handed over, and no outcome is reported for `
              + `them.${extrapolated}`
            : ""),
        // Every silent recipient listed (only when voided): the read has answered, and under the void its answer
        // does not decide the rest, so the fix does not ask for it again, as in the branch above. Otherwise
        // "first" once: after the evidence's own first step, the read is the next one.
        fix: unchecked === 0 ? voidFix + SUBSCRIPTION_FIX
          : voidFix + (voidFix === "" ? VERIFY_FIRST : `then ${VERIFY_FIRST.slice("first ".length)}`) + SUBSCRIPTION_FIX,
      }];
    }

    /*
     * It can see, and nothing is explained. When that is because evidence voided the explanation, the evidence
     * is its own finding and not this one turning red: `runDoctor` reads this finding's `ok` as `blind` for the
     * breakers, and a Node hearing outcomes is not blind. Blind, the branch above carries the same words.
     */
    if (explained === 0) {
      const heard: Finding = { ...base, ok: true, detail: observed };
      return !voided ? [heard] : [heard, {
        check: "delivery_explanation_void",
        severity: "degraded",
        discloses: "data",
        ok: false,
        detail: againstIt,
        fix: voidFix.trim(),
        receipt: "docs/receipts/email-sending-events.md",
      }];
    }

    // Every silence explained, and nothing heard at all: expected, and still says nothing about arrival or
    // about the subscription.
    if (unexplained === 0 && counted.unobserved === counted.awaiting && counted.attributed === 0) {
      return [{
        ...base,
        ok: true,
        detail: `${explained} recipient(s) were handed over more than ${MINUTES} minutes ago and none has an `
          + "observed outcome, and every one of them was shown as a verified Email Routing destination, verified "
          + "before it was handed over, by a read of this Cloudflare account's list (the latest at "
          + `${counted.read_at}, account ${counted.read_account}). No outcome is reported for verified `
          + `destinations, ${MEASURED}. So this silence is expected and is not a fault this Node can fix, and this `
          + "Node still cannot tell you whether any of them arrived. It shows nothing about the event subscription "
          + "either way: the first send to an address that is not a verified destination is what will show "
          + `whether outcomes reach this Node.${extrapolated}${laterFailure}`,
      }];
    }

    return [{
      ...base,
      ok: true,
      detail: `${observed} ${explained} of the ${counted.unobserved} without one were shown as verified Email `
        + "Routing destinations, verified before they were handed over, by a read of this Cloudflare account's "
        + `list (the latest at ${counted.read_at}), and no outcome is reported for verified destinations, `
        + `${MEASURED}.${extrapolated}${laterFailure}`,
    }];
  };

  const stale = counted.unattributed_ever - counted.unattributed;
  const recorded = stale === 0 ? "" :
    ` ${stale} older one(s) are also unattributed and are not counted here: they stopped arriving, ` +
    `nothing resolves them, and they are kept because an unattributable bounce that was discarded would ` +
    `be silence.`;

  /*
   * When nothing recent is unattributable but old rows exist, they are still **said** — as a report that
   * fails on nothing. Dropping the finding entirely would make the evidence disappear from the one surface
   * whose job is to show it, and an operator investigating a bounce nobody could attribute would find no
   * trace of it here. `sending_events_consumer` is the precedent for the shape: a fact about how a Node came
   * to be, stated once, carrying no severity.
   */
  if (counted.unattributed === 0 && stale > 0) {
    return [{
      check: "delivery_attribution",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: `${stale} delivery event(s) were never matched to anything this Node sent, the most recent ` +
        `outside the window this check looks at. They are kept rather than discarded — an unattributable ` +
        `bounce that was thrown away is silence — and nothing resolves them: the usual cause is a message ` +
        `sent from this Node's sending domain by something that is not this Node. Ongoing ones would be ` +
        `reported as a degradation instead.`,
      receipt: "docs/receipts/email-sending-events.md",
    }, ...visibility()];
  }

  const attribution: Finding[] = counted.unattributed === 0 ? [] : [{
    check: "delivery_attribution",
    severity: "degraded",
    discloses: "data",
    ok: false,
    detail: `${counted.unattributed} delivery event(s) in the last ${Math.round(DELIVERY_SILENCE_MS / 60000)} ` +
      `minute(s) could not be matched to anything this Node sent. Their outcome is recorded against no ` +
      `recipient, so those sends stay unobserved however many events arrive. This is not the same as ` +
      `receiving no events, and not the same as being healthy.${recorded}`,
    fix: "check that the event subscription is scoped to this Node's sending domain and no other — the " +
      "usual cause is a subscription covering a domain sent from elsewhere, whose events arrive here " +
      "with no matching manifest. transport_message_id is written only on hand-over, so a send whose " +
      "outcome was never determined has no join key and its events land here too",
    receipt: "docs/receipts/email-sending-events.md",
  }];

  return [...attribution, ...visibility()];
}


/**
 * How long a hand-over may go unanswered before silence is worth reporting.
 *
 * Derived from a measured arrival, not chosen: `email-sending-events.md` observed a bounce landing about
 * 60 seconds after hand-over, and this is 15x that. Deliberately generous, because the errors are not
 * symmetric — a false alarm gets a check muted, and a muted check guards nothing.
 */
export const DELIVERY_SILENCE_MS = BUDGETS["events.delivery_silence_minutes"] * 60 * 1000;

/*
 * `delivery_visibility`'s shared words. Declared after `DELIVERY_SILENCE_MS`, which `MINUTES` reads at load.
 *
 * `MEASURED` carries the sample size into every sentence that calls a silence expected, because one
 * verified address and three sends is what the claim rests on. `docs/receipts/email-sending-events.md` records
 * the send that ruled out the external-MX explanation, and that the sample is still one verified address, for
 * behaviour Cloudflare does not document.
 */
const MINUTES = Math.round(DELIVERY_SILENCE_MS / 60000);
const MEASURED = "in the one case measured (one verified address, three sends, 27 and 28 September 2026; "
  + "docs/receipts/email-sending-events.md)";
const NOTHING_HEARD = "It cannot tell you whether any of them arrived, and \"no bounces\" here means \"nothing heard\" "
  + "rather than \"nothing failed\".";
const SUBSCRIPTION_FIX = "check the two objects outcomes travel through: the Email Sending event subscription for this "
  + "sending domain, and this Worker as the consumer of its queue. mailda provider --delivery-events reads both with "
  + "this Node's token (GET /api/provider/delivery-events), and mailda provider --subscribe <domain> or the Setup "
  + "screen's Delivery outcomes section creates what is missing; pnpm --filter @mailda/worker run "
  + "queue:attach-consumer attaches the consumer from a shell for a Node holding no token. Without both, a recipient "
  + "that is not a verified destination stays unobserved for ever";
// Leads the fix whenever no read covers the silence: the answer decides whether the rest applies at all.
const VERIFY_FIRST = "first find out whether these recipients are verified destinations, because that decides the "
  + "rest: mailda setup reads the account's list with wrangler's login, and the Setup screen's Delivery outcomes "
  + "section reads it with this Node's token (POST /api/provider/verified-destinations), which needs the optional "
  + "permission Email Routing Addresses: Read. A token made from the list before 28 September 2026 may not carry it: "
  + "add it in Cloudflare's dashboard, or make a new token and register it (mailda provider --token; if the dashboard "
  + "shows a new value after an edit, register that). A read that does not succeed is reported here as could not "
  + "read, never as none verified. If they are not verified destinations, ";


/**
 * Can this Node's circuit breakers see anything, and is anything currently stopping mail? (#66)
 *
 * ## Why a breaker needs a check at all
 *
 * A rate breaker keeps **no state**: it is a windowed `COUNT(*)` re-asked on every send. That is the property
 * that makes it impossible to leave un-armed by accident, and it is also what makes it **invisible** — there
 * is no row anywhere saying whether the thing is working, and a tripped breaker nobody can see is the failure
 * shape this repository has now hit repeatedly. So the readings are reported here, on every claimed run,
 * whether or not anything is over.
 *
 * ## `armed: false, reason: no_observations` rather than a reassuring 0%
 *
 * This is the whole reason the check is not one line. A bounce-rate breaker reading **0%** because the
 * delivery channel is dead is the silent failure the breakers exist to prevent, and `doctor` already computes
 * that exact predicate one function up: `delivery_visibility` fails when hand-overs old enough to have been
 * answered have produced no attributed events at all. A Node in that state has a bounce breaker that will
 * never fire and a report that says everything is fine.
 *
 * So an under-observed rate reports `armed: false` with the reason, and the finding is **degraded** rather
 * than `ok` — not because the Node is broken, but because a governance control that cannot fire is a control
 * nobody should be relying on, and `report`/`ok: true` is how somebody comes to.
 *
 * **Failing closed on no observations was rejected**, and the reason is short: a Node that has never sent
 * anything has no observations, so failing closed means a new Node refuses to send. That is worse than the
 * thing it protects against.
 *
 * ## Two findings, because they answer different questions
 *
 * `send_breakers` is *can this Node see, and is anything over*. `domain_paused` is *is a human decision
 * currently stopping a customer's mail* — which is not a fault at all, and is `degraded` anyway: mail is not
 * leaving, somebody has to know, and the pause's own reason and age are what they need. §5C's rule against
 * collapsing distinct states applies with more force in a diagnostic than anywhere else.
 *
 * Costs **one** subrequest on a clean Node and two when a pause exists — the rate statement, plus the pause
 * listing only when the first said something is paused. `doctor-check-cost.md`'s `stale_when` names "any new
 * fixed-cost check", and this is one.
 */
export async function checkBreakers(
  env: Env,
  ctx: Ctx,
  orgId: string | null,
  blind: boolean,
): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "send_breakers",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so nothing has been sent and there is nothing to rate.",
    }];
  }

  // No domain: `doctor` asks the rate questions and not the pause one, because "is this domain paused" needs
  // a domain and a report about every domain is the second statement below.
  const decision = await evaluateBreakers(env, ctx, orgId, null).catch(() => null);
  if (decision === null) {
    return [{
      check: "send_breakers",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "Could not read the tables the send breakers count over, so this Node cannot say whether they "
        + "would fire.",
      fix: "check the migrations_applied finding first",
    }];
  }

  const unarmed = decision.rates.filter((rate) => !rate.armed);
  const tripped = decision.rates.filter((rate) => rate.tripped);
  /*
   * **When an unarmed breaker is a fault, and when it is just a quiet Node.** This is the line the whole
   * check turns on, and getting it wrong in either direction is a documented failure of this file.
   *
   * `ok: false` on every unarmed breaker would fail on every freshly deployed Node, for ever, until somebody
   * sent a few hundred messages — and `DELIVERY_SILENCE_MS` names the consequence three hundred lines up: a
   * finding that fails on every Node forever is one somebody mutes, and a muted check is worse than no check
   * because it still reads as verified.
   *
   * `ok: true` on every unarmed breaker is the opposite failure and the one #66 exists to prevent: a Node
   * whose event subscription was never created hears nothing, so its bounce breaker has no denominator and
   * can never fire — and the report would say so in a sentence nobody reads while the verdict stays green.
   * A Node whose every recipient is a verified destination hears nothing too, and is not blind:
   * `delivery_visibility` explains that silence (no outcome is reported for verified destinations), so its
   * breakers read as a quiet Node's.
   *
   * The discriminator is `blind`, which is `delivery_visibility`'s own predicate: hand-overs old enough to
   * have been answered, none of them observed, **zero attributed events ever**, and some of that silence
   * unexplained by a read of the account's verified destinations. A Node that is sending
   * and hearing nothing has breakers that cannot fire; a Node that has not sent has breakers with nothing to
   * rate yet. Same reading, two different facts, and §5C's rule against collapsing them applies hardest in a
   * diagnostic.
   */
  const cannotFire = blind && unarmed.length > 0;
  const findings: Finding[] = [{
    check: "send_breakers",
    // `degraded` when something is wrong, `report` when the readings are simply a fact worth printing. The
    // severity moves with the finding rather than being fixed, because a permanent WARN is the muted check.
    severity: cannotFire || tripped.length > 0 ? "degraded" : "report",
    discloses: "data",
    ok: !cannotFire && tripped.length === 0,
    detail: decision.rates.map((rate) => {
      const window = `${Math.round(rate.windowSeconds / 60)}m`;
      if (!rate.armed) {
        return `${rate.breaker}: armed=false (${rate.unarmedReason}) — ${rate.observations} observation(s) `
          + `in ${window}, and this breaker needs more before a rate means anything. It is NOT 0%.`;
      }
      const at = rate.percent === null ? `${rate.observed}` : `${rate.percent}% of ${rate.observations}`;
      return `${rate.breaker}: armed=true, at ${at} against ${rate.limit} in ${window}`
        + (rate.tripped ? " — OVER, sends are gating" : "");
    }).join(" | "),
    ...(!cannotFire && tripped.length === 0 ? {} : {
      fix: tripped.length > 0
        ? "sends are being gated to awaiting and will go when the window clears — nobody has to clear them. "
          + "Read the outbox for the exact figure and the time remaining, and find out what is being sent "
          + `before raising ${tripped.map((rate) => RATE_BREAKERS[rate.breaker].limitBudget).join(", ")}`
        // True in every state that makes delivery_visibility fail, including "could not read the delivery
        // tables": so it names that finding and makes no claim about the cause, which only that finding knows.
        : "these breakers cannot fire while delivery_visibility above cannot see delivery outcomes: the rates "
          + "count outcomes, and without them they have no denominator. That finding says why and what to "
          + "check first. These arm themselves as outcomes arrive; nothing here needs resetting",
    }),
    receipt: "docs/receipts/send-breakers.md",
  }];

  // The second statement, and only when the first says there is one to describe — `pausedDomains` is a
  // seventh sub-select on a statement already being issued, so asking costs nothing. A listing on every run
  // would spend a subrequest on every Node to report nothing on almost all of them.
  if (decision.pausedDomains > 0) {
    const paused = await pausesInForce(env, orgId);
    findings.push({
      check: "domain_paused",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: paused.map((pause) =>
        `${pause.domain} has been paused since ${pause.placedAt} (${pause.pauseId}): "${pause.reason}"`,
      ).join(" | "),
      fix: "no send from these domains is leaving. Any one administrator can lift a domain's pause alone — "
        + `POST /api/domain-pauses/${paused[0]!.pauseId}/lift — because the harm of a wrongly paused domain `
        + "grows every minute it stands. Placing one took two administrators; lifting takes one",
      receipt: "docs/receipts/send-breakers.md",
    });
  }

  return findings;
}
