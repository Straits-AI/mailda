import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { conflict, unprocessable } from "../errors.ts";
import { sha256Hex } from "../evidence-store.ts";
import { NO_BOUND_ACCOUNT, boundAccount, boundAccountFor, zoneFor } from "./account-routing.ts";
import { accessTokenFor, cloudflareGet, cloudflareGetAll, cloudflarePost, operatorOf } from "./cloudflare-api.ts";

/**
 * Whether a delivery outcome would ever be **seen** for one domain this Node sends from (#163 L2).
 *
 * ## The question this answers, and why `doctor` could not
 *
 * Four objects have to line up before an outbound send has an outcome anybody can see. The domain has to be
 * **onboarded for sending** on its zone; an account-level `email.sending` **event subscription** has to
 * publish its lifecycle events to a queue; and a Worker has to **consume** that queue. Any one of the four
 * missing produces the same symptom: silence. `doctor`'s `sending_events_consumer` has said since it was written that this is *"not
 * checkable from inside a Worker — no account API access"*, and that sentence was true when it was written.
 *
 * ADR 42 made it false. The grant carries `queues.write` and `email-sending.write`, and four plain reads
 * settle all four:
 * `GET /accounts/{id}/event_subscriptions/subscriptions` lists the subscriptions, and
 * `GET /accounts/{id}/queues/{queue_id}` names the consumers of the one a subscription publishes to;
 * `GET /zones/{id}/email/sending/subdomains` says whether the domain may send at all, and
 * `GET /zones/{id}/email/sending/subdomains/{id}/dns` says which records that needs. So the absence is now
 * reportable **by name** — which object is missing — rather than inferable from a delivery outcome that
 * never arrived.
 *
 * ## The sending half was recorded as having no API, and has a full one
 *
 * `docs/receipts/email-routing-subdomain-onboarding.md` holds `routing.subdomain_api_available: 0`, measured
 * 3 August 2026, with a `stale_when` naming exactly the event that has since happened. Cloudflare publishes
 * five methods on `/zones/{zone_id}/email/sending/subdomains` — list, get, create, edit, delete — plus the
 * `/dns` sub-resource. That is `POST` to onboard and `GET` to diff, which is #163 box 1's shape.
 *
 * It also relocates a constraint. Email **Routing**'s required records land on the zone apex, so proposing
 * them on this account would mean writing to a zone carrying live mail. Email **Sending**'s land on the
 * sending domain itself — `cf-bounce.mailda-test.whymelabs.com`, `_dmarc.mailda-test.whymelabs.com` —
 * entirely inside the subdomain.
 *
 * ## The subscription is not in the documented menu, and exists anyway
 *
 * `wrangler queues subscription create --source` still does not offer `email.sending` (re-measured 10
 * September 2026, wrangler 4.118.0), and the API reference's create schema does not list it among the
 * `source.type` values either. Both are wrong: a live account holds one, created 7 August 2026, whose
 * `source` carries `type: "email.sending"` with `zone_id` and `domain` — two fields that same schema does not
 * document.
 *
 * Which is this flow's recurring mistake wearing the other face. Five times a **list of what something
 * supports** was read as a list of what may be had; here a list omits something that can be had. The rule
 * that survives both is the same one: ask the account, not the menu.
 *
 * ## Why a queue is fetched by id rather than found in the list
 *
 * `GET /accounts/{id}/queues` pages at 100 and this account holds 66. A Node that read page one and matched
 * against it would be right until the sixty-seventh queue, then silently report a healthy Node's queue as
 * absent — which is exactly how `deploy --plan` came to call a healthy Node broken, on R2's page of twenty.
 * A subscription names its `queue_id`, so there is a targeted read and no list to be wrong about.
 */
/** What Cloudflare says about a domain's ability to send, and the records that ability rests on. */
export interface SendingDomainState {
  /** The onboarded sending domain, which may be the zone apex rather than this exact name. */
  name: string;
  enabled: boolean | null;
  /** The bounce domain and DKIM selector, which is where the records below hang. */
  returnPath: string | null;
  dkimSelector: string | null;
  /** Cloudflare's own list of records this sending domain needs. */
  required: Array<{ type: string; name: string; content: string; priority: number | null }>;
  /** Why the record list could not be read. Null when it could — and empty is not the same as unreadable. */
  error: string | null;
}

export interface DeliveryEventsState {
  /** A domain this Node routes, which is what it would also send from. */
  domain: string;
  /** The zone carrying it, usually a parent. Null when no zone in this account does. */
  zone: string | null;
  /** Whether it is onboarded for sending at all. Null means it is not — the first way to be silent. */
  sending: SendingDomainState | null;
  /** The `email.sending` subscription covering it, by name. Null when there is none. */
  subscription: string | null;
  subscriptionId: string | null;
  /** A subscription that exists and is switched off publishes nothing, so this is not the same as absent. */
  enabled: boolean | null;
  /** The event types it publishes, in Cloudflare's words. */
  events: string[];
  queueId: string | null;
  queueName: string | null;
  /** The Workers consuming that queue. Empty means events are published into a queue nobody reads. */
  consumers: string[];
  /** Why this domain could not be answered for. Null when it could. */
  error: string | null;
}

/**
 * Every `email.sending` subscription on the account, following `result_info` rather than trusting a page.
 *
 * The loop stops on a short page, so it needs no count from the response and cannot be fooled by a total
 * that disagrees with what was returned.
 */
async function sendingSubscriptions(
  env: Env, ctx: Ctx, orgId: string, accountId: string,
): Promise<{ ok: true; result: CloudflareSubscription[] } | { ok: false; error: string }> {
  return await cloudflareGetAll<CloudflareSubscription>(
    env, ctx, orgId, `/accounts/${accountId}/event_subscriptions/subscriptions`,
  );
}

/**
 * Which sending domain covers `domain`: the one that matches, or the **most specific** of several.
 *
 * A domain is covered by an entry naming it exactly or by an entry naming a parent of it — the dot is the
 * label boundary, so `notexample.test` is not covered by `example.test`. Where more than one matches, the
 * longest wins.
 *
 * **That last rule was found by running this against a real zone.** `whymelabs.com` and
 * `mailda-test.whymelabs.com` are both onboarded for sending, and taking the first match reported the apex —
 * so the records shown were `cf-bounce.whymelabs.com`'s, for a Node that sends from the subdomain and whose
 * own records are `cf-bounce.mailda-test.whymelabs.com`. Every one of them was correct about a domain
 * nobody had asked about, and a proposal built from them would have written into a zone carrying live mail.
 *
 * A stub could not have shown it, because a fixture with one entry has no ambiguity to resolve.
 */
function mostSpecific<T>(all: T[], nameOf: (one: T) => string | undefined, domain: string): T | undefined {
  return all
    .filter((one) => {
      const on = nameOf(one);
      return on !== undefined && (on === domain || domain.endsWith(`.${on}`));
    })
    .sort((a, b) => (nameOf(b) ?? "").length - (nameOf(a) ?? "").length)[0];
}


async function sendingDomainFor(
  env: Env, ctx: Ctx, orgId: string, zoneId: string, domain: string,
): Promise<SendingDomainState | null> {
  const onboarded = await cloudflareGet<Array<{
    id?: string; name?: string; enabled?: boolean;
    return_path_domain?: string; dkim_selector?: string;
  }>>(env, ctx, orgId, `/zones/${zoneId}/email/sending/subdomains`);
  if (!onboarded.ok) {
    /*
     * Unreadable is not un-onboarded. Returning `null` here would report a domain that may send as one that
     * may not, which is the direction that sends somebody to re-onboard a working sender.
     */
    return {
      name: domain, enabled: null, returnPath: null, dkimSelector: null, required: [],
      error: onboarded.error,
    };
  }

  const found = mostSpecific(onboarded.result, (one) => one.name, domain);
  if (found === undefined) return null;

  const state: SendingDomainState = {
    name: found.name ?? domain,
    enabled: found.enabled ?? null,
    returnPath: found.return_path_domain ?? null,
    dkimSelector: found.dkim_selector ?? null,
    required: [],
    error: null,
  };
  if (found.id === undefined) return { ...state, error: "the sending domain carries no id" };

  const dns = await cloudflareGet<Array<{
    type?: string; name?: string; content?: string; priority?: number;
  }>>(env, ctx, orgId, `/zones/${zoneId}/email/sending/subdomains/${found.id}/dns`);
  if (!dns.ok) return { ...state, error: dns.error };
  return {
    ...state,
    required: dns.result.map((one) => ({
      type: one.type ?? "?",
      name: one.name ?? "?",
      content: one.content ?? "?",
      priority: one.priority ?? null,
    })),
  };
}

interface CloudflareSubscription {
  id?: string;
  name?: string;
  enabled?: boolean;
  events?: string[];
  source?: { type?: string; domain?: string };
  destination?: { queue_id?: string };
}

export async function deliveryEventsState(
  env: Env, ctx: Ctx, orgId: string,
): Promise<DeliveryEventsState[]> {
  const rows = await env.CATALOG.prepare(
    // The same source `emailRoutingState` uses: the domains mail is actually addressed at, not a config list.
    "SELECT DISTINCT substr(address, instr(address, '@') + 1) AS domain FROM addresses WHERE org_id = ?",
  ).bind(orgId).all<{ domain: string }>();
  const domains = rows.results.map((row) => row.domain);
  if (domains.length === 0) return [];

  const blank = (domain: string): DeliveryEventsState => ({
    domain, zone: null, sending: null,
    subscription: null, subscriptionId: null, enabled: null, events: [],
    queueId: null, queueName: null, consumers: [], error: null,
  });

  const accountId = await boundAccount(env, ctx);
  if (accountId === null) {
    /*
     * Not an error about Cloudflare — an error about this Node. No credential means no account, and the
     * sentence names the two ways to give it one rather than blaming the provider.
     */
    return domains.map((domain) => ({ ...blank(domain), error: NO_BOUND_ACCOUNT }));
  }

  const subscriptions = await sendingSubscriptions(env, ctx, orgId, accountId);
  if (!subscriptions.ok) {
    return domains.map((domain) => ({ ...blank(domain), error: subscriptions.error }));
  }

  const seen: DeliveryEventsState[] = [];
  for (const domain of domains) {
    /*
     * The first of the four, and the one that decides whether the other three could ever matter: a domain
     * not onboarded for sending produces no events, so a report that started at the subscription would say
     * *no subscription* about a domain whose real problem is one step earlier.
     */
    const carrying = await zoneFor(env, ctx, orgId, domain);
    const zone = carrying.ok ? carrying.zone : null;
    const sending = zone === null ? null : await sendingDomainFor(env, ctx, orgId, zone.id, domain);

    /*
     * A subscription is scoped to one sending domain: the zone apex or a verified sending subdomain. So an
     * apex subscription covers this domain too, and matching only on equality would report a covered domain
     * as uncovered — and where both exist, the specific one is the one publishing this Node's events.
     */
    const found = mostSpecific(
      subscriptions.result.filter((one) => one.source?.type === "email.sending"),
      (one) => one.source?.domain,
      domain,
    );
    const known = {
      ...blank(domain),
      zone: zone?.name ?? null,
      sending,
      error: carrying.ok ? null : carrying.error,
    };
    if (found === undefined) {
      seen.push(known);
      continue;
    }

    const state: DeliveryEventsState = {
      ...known,
      subscription: found.name ?? null,
      subscriptionId: found.id ?? null,
      enabled: found.enabled ?? null,
      events: found.events ?? [],
      queueId: found.destination?.queue_id ?? null,
    };
    if (state.queueId === null) {
      seen.push({ ...state, error: "the subscription names no destination queue" });
      continue;
    }

    const queue = await cloudflareGet<{
      queue_name?: string; consumers?: Array<{ script?: string; type?: string }>;
    }>(env, ctx, orgId, `/accounts/${accountId}/queues/${state.queueId}`);
    if (!queue.ok) {
      seen.push({ ...state, error: queue.error });
      continue;
    }
    seen.push({
      ...state,
      queueName: queue.result.queue_name ?? null,
      /*
       * An unreadable consumer list is not an empty one, for `emailRoutingFor`'s reason: both are `[]`, and
       * only the `error` above tells them apart. A surface reading this as *nobody consumes the queue* would
       * report a working Node as blind.
       */
      consumers: (queue.result.consumers ?? []).map((one) => one.script ?? one.type ?? "?"),
    });
  }
  return seen;
}

/**
 * Onboarding a domain for sending: the proposal, and the apply bound to it (#163 L2, write side).
 *
 * ## One call, and Cloudflare writes the DNS
 *
 * `docs/receipts/email-routing-subdomain-onboarding.md` records the drill. `POST .../email/sending/subdomains`
 * with a name creates the sending domain **and Cloudflare places the six records itself** — verified in
 * public DNS with `dig` against the authoritative nameserver rather than by believing the API's account of
 * itself. So this Node writes no DNS record, and the proposal is *"this domain is not onboarded"* rather than
 * a record list Mailda maintains, which would be a second copy of somebody else's requirements.
 *
 * ## Confirmed by the operator, and bound to what they were shown
 *
 * Not the approval machinery, and the reason is what the read side already did wrong once. It matched the
 * apex and printed six records that were each correct — about a domain nobody had asked about. **Two
 * administrators would both have approved that.** Dual control defends against one person acting alone; the
 * failure available here is a plausible proposal aimed at the wrong name, and what defends against that is
 * binding the apply to the exact proposal that was displayed.
 *
 * `domain_pause` is the precedent for an organization-scoped approval and its reason does not transfer:
 * `approvals.ts` says it exists to stop *a single administrator stopping a customer's mail*. This stops
 * nothing, is scoped to one name the operator typed, and is additive. And the approver count comes from
 * `policy_stages.required_count`, driven by a policy object whose conditions are `SendFacts` — none of which
 * describe a DNS act, which `governed.ts` names as a decision about what a policy may say rather than one to
 * pre-build here.
 *
 * ## The digest is a staleness check, not a secret
 *
 * A plain SHA-256 over the canonical proposal. There is nothing to forge — the caller is already an
 * administrator who could call the API directly — so a MAC would add key management to defend against the
 * one party the route exists to serve. What it does defend is the gap between reading and acting: somebody
 * else onboarding the name, the zone moving, or a second terminal holding an older proposal.
 *
 * ## Onboarding asks about the **exact** name, and the read side does not
 *
 * `deliveryEventsState` matches an apex sending domain as covering a subdomain under it, because for
 * *sending* it does. Onboarding is per exact name, so a domain covered by its apex is still un-onboarded as
 * itself and onboarding it is a real act. Reusing the covering match here would refuse that as already done.
 */
export interface SendingProposal {
  domain: string;
  zone: string | null;
  zoneId: string | null;
  /** Already onboarded under this exact name, so there is nothing to do. */
  onboarded: boolean;
  /** An apex entry that already covers it for sending, which is not the same as being onboarded. */
  coveredBy: string | null;
  /** What applying would cause, in Cloudflare's terms rather than this Node's. */
  creates: string[];
  /**
   * What applying cannot be undone into. Measured: un-onboarding removes five of the six records and leaves
   * the DMARC one, on a name Cloudflare then stops managing.
   */
  leavesBehind: string[];
  /** SHA-256 over the fields above, which the apply must be handed back. */
  digest: string;
  error: string | null;
}

/** The canonical bytes a digest is taken over: what the operator was told, and nothing derived from it. */
async function digestOf(of: Omit<SendingProposal, "digest">): Promise<string> {
  const canonical = JSON.stringify([
    of.domain, of.zone, of.zoneId, of.onboarded, of.coveredBy, of.creates, of.leavesBehind, of.error,
  ]);
  // `sha256Hex` rather than a sixth private copy of the same four lines — it is exported, and this file
  // adding its own was the duplication #160 is about, one level below governance.
  return await sha256Hex(new TextEncoder().encode(canonical));
}

export async function sendingProposalFor(
  env: Env, ctx: Ctx, orgId: string, domain: string,
): Promise<SendingProposal> {
  const without = async (over: Partial<Omit<SendingProposal, "digest">>): Promise<SendingProposal> => {
    const body = {
      domain, zone: null, zoneId: null, onboarded: false, coveredBy: null,
      creates: [], leavesBehind: [], error: null, ...over,
    };
    return { ...body, digest: await digestOf(body) };
  };

  const carrying = await zoneFor(env, ctx, orgId, domain);
  if (!carrying.ok) return await without({ error: carrying.error });
  if (carrying.zone === null) {
    return await without({ error: `no zone in this account carries ${domain}` });
  }
  const zone = carrying.zone;

  const onboarded = await cloudflareGet<Array<{ name?: string }>>(
    env, ctx, orgId, `/zones/${zone.id}/email/sending/subdomains`,
  );
  if (!onboarded.ok) {
    return await without({ zone: zone.name, zoneId: zone.id, error: onboarded.error });
  }

  const already = onboarded.result.some((one) => one.name === domain);
  const covering = mostSpecific(onboarded.result, (one) => one.name, domain);
  return await without({
    zone: zone.name,
    zoneId: zone.id,
    onboarded: already,
    coveredBy: already || covering?.name === undefined ? null : covering.name,
    /*
     * Named rather than listed as records: Cloudflare places them and their contents are its own. Saying
     * *where* they will appear is what an operator needs to decide, and it is the part this Node can state
     * without keeping a copy of somebody else's requirements.
     */
    creates: already ? [] : [`cf-bounce.${domain}`, `cf-bounce._domainkey.${domain}`, `_dmarc.${domain}`],
    leavesBehind: already ? [] : [`_dmarc.${domain}`],
  });
}

/**
 * The first write this Node makes to the account it is installed in.
 *
 * Every refusal here is a refusal to act, never a partial one: the `POST` is the last thing that happens and
 * nothing before it changes state. `POST` is **not idempotent** — a second one answers
 * `2040 Subdomain already exists` — so the proposal is recomputed rather than cached, and a domain that is
 * `onboarded: true` is never posted again.
 *
 * It is not refused either (26 September 2026). It used to be, as `E_PROVIDER_SENDING_ALREADY`, and a Node
 * installed into an account that had onboarded the domain before it existed then held no audit entry for
 * sending at all: the install saw `onboarded: true`, printed "already", and `provisionedFacts` said sending
 * was never set up — on `mailda upgrade`, and on the first-run progress list. So a confirmed proposal for a
 * domain already in place **records what was seen**, `provider.sending_observed`, which is the honest word:
 * this Node did not onboard it, it saw that Cloudflare had. A digest mismatch is still `E_PROVIDER_SENDING_STALE`,
 * because *you are holding an old proposal* is not something an observation may paper over.
 */
export async function onboardSending(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, domain: string, digest: string,
): Promise<SendingProposal> {
  const proposal = await sendingProposalFor(env, ctx, orgId, domain);
  if (proposal.error !== null) {
    throw unprocessable("E_PROVIDER_SENDING_UNREADABLE", {
      what: `this Node could not settle what onboarding ${domain} would do`,
      why: proposal.error,
      fix: "read GET /api/provider/delivery-events, and check the grant still covers this zone",
    });
  }
  if (digest !== proposal.digest) {
    /*
     * The whole point of the route. The proposal displayed and the proposal about to be applied are not the
     * same, so what the operator agreed to is not what would happen — and the read side has already been
     * wrong about *which domain* once, which is the shape this refuses.
     */
    throw conflict("E_PROVIDER_SENDING_STALE", {
      what: "the proposal confirmed is not the proposal this Node would now apply",
      why: "something changed between reading and confirming — the zone, or what is already onboarded",
      fix: `run the proposal again and confirm the digest it prints: ${proposal.digest}`,
    });
  }
  if (proposal.onboarded) {
    await auditedBatch(env, ctx, orgId, {
      action: "provider.sending_observed", outcome: "ok", actorUserId, subject: domain,
      detail: { zone: proposal.zone, onboarded: true, authority: operatorOf(ctx) === null ? "token" : "operator" },
    }, (entry) => [entry]);
    return proposal;
  }

  const token = await accessTokenFor(env, ctx, orgId);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${proposal.zoneId}/email/sending/subdomains`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: domain }),
    },
  ).catch(() => null);

  const body = (await response?.json().catch(() => ({}))) as {
    success?: boolean; errors?: Array<{ message?: string; code?: number }>;
  };
  if (response === null || body.success !== true) {
    const said = (body?.errors ?? []).map((one) => `${one.code ?? "?"} ${one.message ?? ""}`.trim()).join("; ");
    throw unprocessable("E_PROVIDER_SENDING_REFUSED", {
      what: `Cloudflare refused to onboard ${domain} for sending`,
      // Cloudflare's own words: its codes are what separate "already exists" from "not your zone".
      why: said === "" ? `the API answered ${response?.status ?? "nothing"}` : said,
      fix: "check the grant still covers this zone, and that the account may add a sending domain",
    });
  }

  await auditedBatch(env, ctx, orgId, {
    action: "provider.sending_onboarded", outcome: "ok", actorUserId, subject: domain,
    /*
     * The zone and what this causes, because the entry has to answer *"who made records appear in our DNS"*
     * months later — and `leavesBehind` because an operator reading this trail after un-onboarding needs the
     * record that survived to be named somewhere that was written before it mattered.
     */
    detail: {
      zone: proposal.zone, creates: proposal.creates, leavesBehind: proposal.leavesBehind,
      authority: operatorOf(ctx) === null ? "token" : "operator",
    },
  }, (entry) => [entry]);

  return await sendingProposalFor(env, ctx, orgId, domain);
}

/**
 * Who owns this installation, and where each answer came from (#165 L4).
 *
 * ## The rule that shapes everything here
 *
 * #108: the page *"reports what the provider says, not what Mailda recorded at setup. A registrant contact
 * changed in the Cloudflare dashboard must show as changed here, or the page is a cache pretending to be a
 * fact."*
 *
 * A cache cannot pretend to be a fact if **every field says where it came from**. So each answer carries a
 * `source`, and there are four, not two:
 *
 *   `provider`   read from Cloudflare on this request. Changed in their dashboard, changed here.
 *   `node`       this Node's own record of something it did. True about this Node, not about the account.
 *   `structural` true by construction — what ADR 42 makes impossible rather than what anyone configured.
 *   `unreadable` a question this grant cannot answer, **named rather than left out.**
 *
 * The fourth is the one that keeps the other three honest. An ownership page that silently omits what it
 * cannot see is a page whose completeness is a claim; billing is the live example — `/accounts/{id}/
 * subscriptions` answers **403** on the narrowed grant, so *who pays* is `unreadable` here and says so.
 *
 * ## What reading live costs, and why it is a route rather than a panel
 *
 * Two Cloudflare calls per request, and possibly a token renewal. That is the same argument
 * `sending_events_consumer` settled: a surface that reached the network to render would spend the account's
 * authority every time anybody glanced at it. So this is asked for, not displayed by default, and `doctor`
 * does not call it.
 */
/**
 * Subscribing a sending domain's delivery events to this Node's queue (#222).
 *
 * The third of the three objects `deliveryEventsState` reports on, and the one a button-only install has
 * never had: without an `email.sending` subscription publishing into `SENDING_EVENTS`, every send sits
 * unobserved for ever and nothing looks wrong. Measured 16 September 2026 (`email-sending-events.md`):
 * `POST /accounts/{id}/event_subscriptions/subscriptions` accepts the `source` shape the account's existing
 * subscription carries — undocumented, so copied from a listing rather than guessed — refuses a domain not
 * onboarded for sending in so many words, and creates one for a domain that is. So the ceremony orders
 * itself: `onboardSending` first, this second, and the proposal says which step is missing.
 *
 * The same shape as receiving and sending: a proposal that changes nothing, a digest over it, and a write
 * that recomputes the proposal and refuses unless the digest still matches.
 */
export interface SubscriptionProposal {
  domain: string;
  zone: string | null;
  zoneId: string | null;
  /** The onboarded sending domain that would carry the subscription: the name itself, or the apex covering it. */
  sendingDomain: string | null;
  /** The subscription already covering this domain, by name. Null when there is none. */
  subscribed: string | null;
  /** This Node's own events queue — the destination — found by the name wrangler derived for it. */
  queueId: string | null;
  queueName: string | null;
  /**
   * Whether this Worker already consumes that queue. The third object delivery outcomes depend on; measured
   * 16 September 2026: `POST /accounts/{id}/queues/{id}/consumers` attaches a Worker consumer, so the
   * confirm attaches it when it is missing rather than leaving it to `queue:attach-consumer` by hand.
   */
  consumerAttached: boolean | null;
  /** The event types the subscription would publish, in Cloudflare's words. */
  events: string[];
  digest: string;
  error: string | null;
}

/** Every event type Cloudflare publishes for a sending domain (receipt: `email-sending-events.md`). */
const SENDING_EVENTS = [
  "message.delivered", "message.deferred", "message.bounced",
  "message.failed", "message.rejected", "message.complained",
] as const;

async function subscriptionDigestOf(of: Omit<SubscriptionProposal, "digest">): Promise<string> {
  const canonical = JSON.stringify([
    of.domain, of.zone, of.zoneId, of.sendingDomain, of.subscribed, of.queueId, of.queueName,
    of.consumerAttached, of.events, of.error,
  ]);
  return await sha256Hex(new TextEncoder().encode(canonical));
}

/**
 * This Node's events queue, by the name wrangler derived for it: `<worker>-sending-events`.
 *
 * `GET /accounts/{id}/queues` pages, and the account this was measured on holds sixty-six queues, so the
 * walk follows the pages rather than trusting the first — the mistake `deploy --plan` made once on R2's
 * page of twenty. The name comes from `WORKER_NAME`, the same var the receiving rule names itself with.
 */
async function ownQueue(
  env: Env, ctx: Ctx, orgId: string, accountId: string,
): Promise<{ ok: true; id: string; name: string } | { ok: false; error: string }> {
  const worker: string | undefined = env.WORKER_NAME;
  if (typeof worker !== "string" || worker === "") {
    return { ok: false, error: "this Node does not know its own Worker name (WORKER_NAME), so it cannot name its queue" };
  }
  const wanted = `${worker}-sending-events`;
  const page_size = 100;
  for (let page = 1; ; page++) {
    const answer = await cloudflareGet<Array<{ queue_id?: string; queue_name?: string }>>(
      env, ctx, orgId, `/accounts/${accountId}/queues?page=${page}&per_page=${page_size}`,
    );
    if (!answer.ok) return answer;
    const found = answer.result.find((one) => one.queue_name === wanted);
    if (found?.queue_id !== undefined) return { ok: true, id: found.queue_id, name: wanted };
    if (answer.result.length < page_size) {
      return { ok: false, error: `no queue named ${wanted} in this account — has this Node been deployed here?` };
    }
  }
}

export async function subscriptionProposalFor(
  env: Env, ctx: Ctx, orgId: string, domain: string,
): Promise<SubscriptionProposal> {
  const without = async (over: Partial<Omit<SubscriptionProposal, "digest">>): Promise<SubscriptionProposal> => {
    const body = {
      domain, zone: null, zoneId: null, sendingDomain: null, subscribed: null,
      queueId: null, queueName: null, consumerAttached: null, events: [...SENDING_EVENTS], error: null, ...over,
    };
    return { ...body, digest: await subscriptionDigestOf(body) };
  };

  const accountId = await boundAccount(env, ctx);
  if (accountId === null) return await without({ error: NO_BOUND_ACCOUNT });

  const carrying = await zoneFor(env, ctx, orgId, domain);
  if (!carrying.ok) return await without({ error: carrying.error });
  if (carrying.zone === null) return await without({ error: `no zone in this account carries ${domain}` });
  const zone = carrying.zone;

  const sending = await sendingDomainFor(env, ctx, orgId, zone.id, domain);
  if (sending === null) {
    return await without({
      zone: zone.name, zoneId: zone.id,
      error: `${domain} is not onboarded for sending, and Cloudflare refuses a subscription for a domain that `
        + "is not — onboard it first: POST /api/provider/sending",
    });
  }
  if (sending.error !== null) return await without({ zone: zone.name, zoneId: zone.id, error: sending.error });

  const subscriptions = await sendingSubscriptions(env, ctx, orgId, accountId);
  if (!subscriptions.ok) {
    return await without({ zone: zone.name, zoneId: zone.id, sendingDomain: sending.name, error: subscriptions.error });
  }
  const covering = mostSpecific(
    subscriptions.result.filter((one) => one.source?.type === "email.sending"),
    (one) => one.source?.domain,
    domain,
  );

  const queue = await ownQueue(env, ctx, orgId, accountId);
  if (!queue.ok) {
    return await without({
      zone: zone.name, zoneId: zone.id, sendingDomain: sending.name,
      subscribed: covering?.name ?? null, error: queue.error,
    });
  }

  const worker = env.WORKER_NAME ?? "";
  const consumers = await cloudflareGet<{ consumers?: Array<{ script?: string; type?: string }> }>(
    env, ctx, orgId, `/accounts/${accountId}/queues/${queue.id}`,
  );
  return await without({
    zone: zone.name, zoneId: zone.id, sendingDomain: sending.name,
    subscribed: covering?.name ?? null, queueId: queue.id, queueName: queue.name,
    consumerAttached: consumers.ok
      ? (consumers.result.consumers ?? []).some((one) => one.type === "worker" && one.script === worker)
      : null,
  });
}

export async function subscribeDeliveryEvents(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, domain: string, digest: string,
): Promise<SubscriptionProposal> {
  const proposal = await subscriptionProposalFor(env, ctx, orgId, domain);
  if (proposal.error !== null) {
    throw unprocessable("E_PROVIDER_SUBSCRIPTION_UNREADABLE", {
      what: `this Node could not settle what subscribing ${domain} would do`,
      why: proposal.error,
      fix: "read GET /api/provider/delivery-events, and check the grant still covers this zone and the queue",
    });
  }
  if (digest !== proposal.digest) {
    throw conflict("E_PROVIDER_SUBSCRIPTION_STALE", {
      what: "the proposal confirmed is not the proposal this Node would now apply",
      why: "something changed between reading and confirming — the zone, the sending domain, or the queue",
      fix: `run the proposal again and confirm the digest it prints: ${proposal.digest}`,
    });
  }
  // Both objects in place: nothing to create (a second subscription would publish every event twice), so
  // what was seen is recorded, for `onboardSending`'s reason.
  if (proposal.subscribed !== null && proposal.consumerAttached === true) {
    await auditedBatch(env, ctx, orgId, {
      action: "provider.delivery_events_observed", outcome: "ok", actorUserId, subject: domain,
      detail: {
        zone: proposal.zone, sendingDomain: proposal.sendingDomain, queue: proposal.queueName,
        subscriptionId: proposal.subscribed, consumerAttached: "already",
        authority: operatorOf(ctx) === null ? "token" : "operator",
      },
    }, (entry) => [entry]);
    return proposal;
  }

  const accountId = await boundAccountFor(env, ctx);
  const created = proposal.subscribed !== null ? null : await cloudflarePost<{ id?: string; name?: string }>(
    env, ctx, orgId, `/accounts/${accountId}/event_subscriptions/subscriptions`,
    {
      name: `${proposal.queueName}-${proposal.sendingDomain}`,
      enabled: true,
      source: { type: "email.sending", zone_id: proposal.zoneId, domain: proposal.sendingDomain },
      destination: { type: "queues.queue", queue_id: proposal.queueId },
      events: proposal.events,
    },
  );

  /*
   * The consumer, when this Worker is not one yet. Until 16 September 2026 this was a wrangler call an
   * operator ran after the install (`queue:attach-consumer`), and a button-only install never had it.
   * The API attaches it — measured on a throwaway queue with the operator's token — and the settings are
   * the ones `wrangler.jsonc` used to declare in its consumers block (receipt: `queue-provisioning.md`).
   */
  const worker = env.WORKER_NAME ?? "";
  const attached = proposal.consumerAttached === true ? null : await cloudflarePost<{ consumer_id?: string }>(
    env, ctx, orgId, `/accounts/${accountId}/queues/${proposal.queueId}/consumers`,
    // No batch settings: the two numbers this used to pass were inherited from a deleted wrangler consumers
    // block and never measured, and AGENTS.md §2 leaves an unmeasured decision unqualified. The provider's
    // defaults are the provider's number, which is where a platform value belongs.
    { type: "worker", script_name: worker },
  );

  await auditedBatch(env, ctx, orgId, {
    action: "provider.delivery_events_subscribed", outcome: "ok", actorUserId, subject: domain,
    detail: {
      zone: proposal.zone, sendingDomain: proposal.sendingDomain, queue: proposal.queueName,
      subscriptionId: created?.id ?? proposal.subscribed, events: proposal.events,
      consumerAttached: attached === null ? "already" : attached.consumer_id ?? "attached",
      authority: operatorOf(ctx) === null ? "token" : "operator",
    },
  }, (entry) => [entry]);

  return await subscriptionProposalFor(env, ctx, orgId, domain);
}
