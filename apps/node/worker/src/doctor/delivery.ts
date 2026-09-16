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
 * written and **ADR 42 made it false**: the Node now holds its own Cloudflare grant, carrying `queues.write`,
 * and two plain reads settle all three objects. `butler_execution` is the precedent for the rewrite as well
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
      "Not answered here, and answerable: `GET /api/provider/delivery-events` reads it through this Node's " +
      "own Cloudflare grant (ADR 42) and names which of the three objects is missing — the `email.sending` " +
      "event subscription, the queue it publishes to, or a consumer on that queue. It is not folded into " +
      "this report because it costs live Cloudflare calls and may renew a token, and a report that reached " +
      "the network would spend the account's authority every time anything asked how this Node was. Two of " +
      "the three still cannot be created from here: the consumer is attached out of band by " +
      "`pnpm --filter @mailda/worker run queue:attach-consumer`, which discovers the queue from this " +
      "Worker's deployed binding, and the subscription is created by the API and not by wrangler (measured " +
      "16 September 2026: `POST /accounts/{id}/event_subscriptions/subscriptions` with an `email.sending` " +
      "source creates one for an onboarded sending domain and refuses a domain that is not; wrangler " +
      "4.118.0 still offers no such source). `POST /api/provider/subscription` makes that call through the " +
      "grant, which needs `queues.write` (measured). So a button-only install can observe its delivery " +
      "outcomes once somebody runs the subscribe and attaches the consumer; until then their absence is " +
      "reportable by name instead of inferable from silence. " +
      "`delivery_visibility` reports the consequence from evidence.",
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
 * currently throws — so it has to be created through the API (`queue-provisioning.md`), which **no tool in
 * this repository does**: `mailda deploy` attaches the consumer and stops there. And since #72 the consumer
 * is attached out of band too.
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
 * Inferred from evidence rather than asked of the platform, deliberately: reading the subscription would
 * need an account credential §5A forbids a Node retaining. Instead it compares what this Node has handed
 * over against what it has heard back — which is the thing a person actually wants to know, and is true
 * even if a subscription exists but is misrouted.
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
  const counted = await env.CATALOG.prepare(
    `SELECT
       (SELECT COUNT(*) FROM send_recipients r
          JOIN send_manifests m ON m.id = r.manifest_id
         WHERE r.org_id = ? AND r.submission_state = 'handed_over' AND m.state_at < ?) AS awaiting,
       (SELECT COUNT(*) FROM send_recipients r
          JOIN send_manifests m ON m.id = r.manifest_id
         WHERE r.org_id = ? AND r.submission_state = 'handed_over' AND m.state_at < ?
           AND r.delivery_state IS NULL) AS unobserved,
       -- Split, and the split is the point. An event this Node could not tie to a manifest is evidence
       -- that ATTRIBUTION is broken, not evidence that the Node can see. Counting the two together meant
       -- one unattributable event flipped the blindness flag to false and suppressed the very warning the
       -- check exists to raise. Migration 0010 built the sre_unattributed index over exactly these rows
       -- and nothing ever read it, which is the tell that somebody expected them to matter.
       --
       -- No backticks in this comment: it sits inside a TypeScript template literal, so one would end it.
       -- That hazard has now bitten four times in this codebase (ui.ts, response-clock.ts, and here).
       (SELECT COUNT(*) FROM send_recipient_events
         WHERE org_id = ? AND manifest_id IS NOT NULL) AS attributed,
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
         WHERE org_id = ? AND manifest_id IS NULL AND received_at >= ?) AS unattributed,
       (SELECT COUNT(*) FROM send_recipient_events
         WHERE org_id = ? AND manifest_id IS NULL) AS unattributed_ever`,
  )
    .bind(orgId, window, orgId, window, orgId, orgId, window, orgId)
    .first<{
      awaiting: number; unobserved: number; attributed: number;
      unattributed: number; unattributed_ever: number;
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

  // Every hand-over old enough to have been answered, and not one answer among them. One unobserved
  // recipient means nothing; all of them, with zero **attributed** events ever received, means the channel
  // is not there. `attributed`, not the total: see the query above.
  const blind = counted.awaiting > 0 && counted.unobserved === counted.awaiting
    && counted.attributed === 0;

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
   */
  const visibility = (): Finding[] => [{
    check: "delivery_visibility",
    severity: "degraded",
    discloses: "data",
    ok: !blind,
    detail: blind
      ? `${counted.awaiting} recipient(s) were handed over more than ` +
        `${Math.round(DELIVERY_SILENCE_MS / 60000)} minutes ago and this Node has received no delivery ` +
        `events at all. It cannot tell you whether any of them arrived, and "no bounces" here means ` +
        `"nothing heard" rather than "nothing failed".`
      : counted.awaiting === 0
        ? "Nothing has been handed over long enough to expect an answer yet."
        : `${counted.awaiting - counted.unobserved} of ${counted.awaiting} handed-over recipient(s) have ` +
          `an observed outcome, from ${counted.attributed} attributed event(s).`,
    ...(blind ? {
      fix: "two things have to exist and neither is in this Worker's config, so check both. First attach " +
        "the queue consumer: pnpm --filter @mailda/worker run queue:attach-consumer, which discovers this " +
        "Worker's queue rather than naming it — the name is derived per Node since #72 and is not written " +
        "down anywhere. Then create an Email Sending event subscription for this sending domain, " +
        "delivering to that queue (docs/receipts/email-sending-events.md). The sending_events_consumer " +
        "finding says why neither can be checked from in here. Without both, every recipient stays " +
        "unobserved forever",
    } : {}),
  }];

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
   *
   * The discriminator is `blind`, which is `delivery_visibility`'s own predicate: hand-overs old enough to
   * have been answered, none of them observed, and **zero attributed events ever**. A Node that is sending
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
        : "these breakers cannot fire, and the cause is the one delivery_visibility above is reporting: this "
          + "Node has handed mail over and received no delivery outcome it could attribute, so the rates "
          + "have no denominator. Fix the event subscription and the consumer — the fix on that finding "
          + "names both — and these arm themselves as outcomes start arriving. Nothing here needs resetting",
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
      fix: "no send from these domains is leaving. Any one administrator can restart a domain alone — "
        + `POST /api/domain-pauses/${paused[0]!.pauseId}/lift — because the harm of a wrongly paused domain `
        + "grows every minute it stands. Placing one took two administrators; lifting takes one",
      receipt: "docs/receipts/send-breakers.md",
    });
  }

  return findings;
}
