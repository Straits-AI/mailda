import { operatorOf } from "./cloudflare-api.ts";
import { providerStatus } from "./credential.ts";
import type { AddressRemoval, AddressRouting } from "@mailda/contract/schemas";
import type { Ctx } from "@mailda/runtime";

import { auditedBatch, log } from "../audit.ts";
import { conflict, notFound, unprocessable } from "../errors.ts";
import { sha256Hex } from "../evidence-store.ts";
import { cloudflareDelete, cloudflareGet, cloudflareGetAll, cloudflarePost, cloudflarePut, zoneFor } from "./cloudflare-grant.ts";
import { type Classified, type CloudflareRule, catchAllRoutesHere, classifyAddress, whereTo } from "./routing-classify.ts";

export type { CloudflareRule };

/**
 * Onboarding a subdomain to **receive** mail (#163 L2, and the half #92's drill ran aground on).
 *
 * ## The defect this exists because of
 *
 * `POST /zones/{id}/email/routing/rules` accepts a rule whose `to` address is on a subdomain that was never
 * onboarded. It answers **200**, marks the rule `enabled`, and stamps it `source: "api"`. And the rule is
 * **inert**: no MX record exists on that name, so mail addressed to it never reaches Cloudflare at all.
 * Measured against Cloudflare's authoritative nameserver, not a resolver
 * (`routing.rule_accepted_for_unonboarded_subdomain: 1`).
 *
 * So a rule that reads as configured in every listing receives silence for ever. That is the shape this
 * repository keeps meeting — a success that does nothing — and it is the reason this module writes records
 * *before* it writes a rule, and refuses to write the rule if the records did not land.
 *
 * ## The records are Email Routing's own, written and read through its endpoints
 *
 * This module used to copy the zone's MX onto the subdomain through raw DNS, which needed the DNS write
 * scope, the largest authority the Node asked for. On 25 September 2026 the first real setup with wrangler's
 * login carried on the request refused here with `10000 Authentication error`: that token cannot touch raw
 * DNS (docs/receipts/wrangler-login-reach.md). Email Routing's own endpoint does the same job for either
 * credential: `POST /zones/{id}/email/routing/dns { name }` creates a subdomain's records, and the same
 * endpoint read with `?subdomain=` names what is missing or lists what is present. So raw DNS is gone from
 * here and the DNS scope with it. An apex's records come with enabling the zone and are read from the zone
 * list. A list this repository maintained would be a second copy of somebody else's requirements — the
 * same argument `emailRoutingFor` makes.
 */

/** A zone's catch-all rule as Cloudflare holds it. */
export interface CatchAllRule { action: string; destinations: string[]; enabled: boolean }

export interface ReceivingProposal {
  domain: string;
  /** The domain is the zone's own name, so the catch-all is available (Cloudflare: apex only). */
  apex: boolean;
  /** The zone's catch-all as it stands, read when `apex`; what a take-over replaces. */
  catchAll: CatchAllRule | null;
  zone: string | null;
  zoneId: string | null;
  /** Whether the zone itself has Email Routing on. A subdomain cannot receive if its zone does not. */
  zoneRouting: string | null;
  /**
   * The zone this act would also **turn into a mail zone**, or null when it already is one.
   *
   * Its own field rather than folded into `creates`, because it is a different size of change: enabling
   * Email Routing writes MX and SPF at the **apex**, so it decides where the whole domain's mail goes — not
   * one subdomain's. An operator confirming this should see that as its own line, not infer it.
   */
  enablesZone: string | null;
  /** The MX this Node would write onto the subdomain, in Cloudflare's own words. */
  creates: Array<{ type: string; name: string; content: string; priority: number | null }>;
  /** MX already present on the subdomain. Non-empty means somebody has been here. */
  present: string[];
  /**
   * A routing rule that already names an address here.
   *
   * Reported separately from `present` because the dangerous state is **a rule with no MX**: it reads as
   * configured everywhere and receives nothing. Naming it is the whole point of this field.
   */
  rule: string | null;
  digest: string;
  refusal: string | null;
}

async function digestOf(of: Omit<ReceivingProposal, "digest">): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(JSON.stringify([
    of.domain, of.zone, of.zoneId, of.zoneRouting, of.enablesZone,
    of.creates.map((one) => `${one.type} ${one.name} ${one.content} ${one.priority}`),
    of.present, of.rule, of.refusal,
  ])));
}

/** Every routing rule on a zone, all pages of them. The one listing three callers share. */
export async function routingRulesOf(
  env: Env, ctx: Ctx, orgId: string, zoneId: string,
): Promise<{ ok: true; result: CloudflareRule[] } | { ok: false; error: string }> {
  return await cloudflareGetAll<CloudflareRule>(env, ctx, orgId, `/zones/${zoneId}/email/routing/rules`);
}

/** Every rule on the zone whose `to` matcher names this exact domain. */
function ruleFor(rules: CloudflareRule[], domain: string): CloudflareRule | undefined {
  return rules.find((one) => (one.matchers ?? []).some((m) =>
    m.field === "to" && typeof m.value === "string" && m.value.toLowerCase().endsWith(`@${domain}`)));
}

export async function receivingProposalFor(
  env: Env, ctx: Ctx, orgId: string, domain: string,
): Promise<ReceivingProposal> {
  const blank = async (over: Partial<Omit<ReceivingProposal, "digest">>): Promise<ReceivingProposal> => {
    const body = {
      domain, apex: false, catchAll: null, zone: null, zoneId: null, zoneRouting: null, enablesZone: null,
      creates: [], present: [], rule: null, refusal: null, ...over,
    };
    return { ...body, digest: await digestOf(body) };
  };

  const carrying = await zoneFor(env, ctx, orgId, domain);
  if (!carrying.ok) return await blank({ refusal: carrying.error });
  if (carrying.zone === null) {
    return await blank({ refusal: `no zone in this account carries ${domain}` });
  }
  const zone = carrying.zone;

  /*
   * The zone's own Email Routing first. A subdomain of a zone that is not routing cannot receive however
   * many records are written — and finding that out after writing MX would leave records behind for a
   * capability that was never going to work.
   */
  const routing = await cloudflareGet<{ enabled?: boolean; status?: string }>(
    env, ctx, orgId, `/zones/${zone.id}/email/routing`,
  );
  if (!routing.ok) {
    return await blank({ zone: zone.name, zoneId: zone.id, refusal: routing.error });
  }
  const zoneRouting = routing.result.status ?? null;
  const enablesZone = routing.result.enabled === true ? null : zone.name;
  const apex = domain.toLowerCase() === zone.name.toLowerCase();

  /*
   * Everything below reads Email Routing's endpoints and never raw DNS: the zone list for an apex, the
   * subdomain endpoint for a subdomain, which names exactly the records missing or lists the ones present.
   * A zone that is not yet routing lists nothing, and that is the state enabling fixes.
   */
  const state = await routingRecordsOf(env, ctx, orgId, zone.id, apex ? null : domain);
  if (!state.ok) {
    return await blank({
      apex, zone: zone.name, zoneId: zone.id, zoneRouting, enablesZone,
      refusal: `this Node could not read the routing state of ${domain} with the credential it holds: ${state.error}`,
    });
  }
  const rules = await routingRulesOf(env, ctx, orgId, zone.id);
  const found = rules.ok ? ruleFor(rules.result, domain) : undefined;
  const catchAll = apex ? await catchAllOf(env, ctx, orgId, zone.id) : null;
  return await blank({
    apex, catchAll,
    zone: zone.name, zoneId: zone.id, zoneRouting, enablesZone,
    // An apex's records come with enabling the zone: the zone list reports nothing missing, ever.
    creates: state.missing,
    present: state.present,
    rule: found?.name ?? null,
    refusal: apex && enablesZone === null && state.present.length === 0
      ? `Cloudflare lists no MX for ${zone.name} although Email Routing is on there`
      : null,
  });
}

/** One record as Cloudflare lists it, on the zone or on a subdomain. */
interface RoutingRecord { type?: string; name?: string; content?: string; priority?: number }

/**
 * What Email Routing says a domain has and lacks, from its own endpoints.
 *
 * The zone list (`…/email/routing/dns`) is the apex's own records, present once the zone is routing. The
 * subdomain form (`?subdomain=`) answers `{ errors: [{ code: "mx.missing", missing: {…} }, …] }` for a
 * subdomain never enabled and `{ errors: null, records: […] }` for one that is — measured on
 * 25 September 2026 against mailda.site. `missing` carries the exact records, so `creates` is Cloudflare's
 * own list rather than a copy of the apex's.
 */
async function routingRecordsOf(
  env: Env, ctx: Ctx, orgId: string, zoneId: string, subdomain: string | null,
): Promise<{ ok: true; present: string[]; missing: ReceivingProposal["creates"] } | { ok: false; error: string }> {
  if (subdomain === null) {
    const zone = await cloudflareGet<RoutingRecord[]>(env, ctx, orgId, `/zones/${zoneId}/email/routing/dns`);
    if (!zone.ok) return zone;
    return { ok: true, present: zone.result.filter((one) => one.type === "MX").map((one) => one.content ?? "?"), missing: [] };
  }
  const read = await cloudflareGet<{ errors?: Array<{ code?: string; missing?: RoutingRecord }> | null; records?: RoutingRecord[] | null }>(
    env, ctx, orgId, `/zones/${zoneId}/email/routing/dns?subdomain=${encodeURIComponent(subdomain)}`,
  );
  if (!read.ok) return read;
  const missing = (read.result.errors ?? [])
    .map((one) => one.missing)
    .filter((one): one is RoutingRecord => one !== undefined)
    .map((one) => ({ type: one.type ?? "?", name: one.name ?? subdomain, content: one.content ?? "?", priority: one.priority ?? null }));
  const present = (read.result.records ?? []).filter((one) => one.type === "MX").map((one) => one.content ?? "?");
  return { ok: true, present, missing };
}

export interface ReceivingOutcome {
  domain: string;
  written: string[];
  /** Read back from Cloudflare after writing, because a write that reports success is not a record. */
  confirmed: string[];
  /**
   * What this act wrote or kept: `catch-all` when it took the zone's catch-all over, the literal rule's name
   * when one routing the address here was written or kept, null when neither. Whether the address itself
   * reaches this Node is `routing`, since a rule of its own outranks the catch-all.
   */
  rule: string | null;
  /** How the address named here is routed, in the words `POST /api/addresses` uses (28 September 2026). */
  routing: AddressRouting;
  note: string | null;
  /** Set when the catch-all was taken over: what it pointed at before, and what it points at now. */
  catchAll: { before: CatchAllRule; after: CatchAllRule } | null;
}

/** The zone's catch-all, read from its own endpoint; null when it cannot be read. */
export async function catchAllOf(
  env: Env, ctx: Ctx, orgId: string, zoneId: string,
): Promise<CatchAllRule | null> {
  const read = await cloudflareGet<CloudflareRule>(env, ctx, orgId, `/zones/${zoneId}/email/routing/rules/catch_all`);
  if (!read.ok) return null;
  const action = read.result.actions?.[0];
  return { action: action?.type ?? "?", destinations: action?.value ?? [], enabled: read.result.enabled === true };
}

/**
 * Write the records, confirm them, then the rule. **In that order, and the order is the finding.**
 *
 * A rule created before its records is the inert rule this module exists to prevent. So the records go
 * first, are read back rather than assumed, and the rule is only written once they are there.
 */
/**
 * The mailbox the address files into: the one named, or the organization's only one.
 *
 * Found on the #92 restore drill: this onboarding wrote the MX records and the routing rule for an address,
 * and ingress would then have rejected the mail it routed as `unknown_recipient`, because nothing in the
 * product ever inserted an `addresses` row — the live Node's two were put there by hand. A rule to a
 * Worker that refuses the recipient is the inert-rule failure this module exists to prevent, one layer up.
 */
export async function mailboxForAddress(
  env: Env, orgId: string, mailboxId: string | null,
): Promise<{ id: string; name: string }> {
  const rows = await env.CATALOG.prepare(
    "SELECT id, name FROM mailboxes WHERE org_id = ? ORDER BY created_at",
  ).bind(orgId).all<{ id: string; name: string }>();
  if (mailboxId !== null) {
    const named = rows.results.find((one) => one.id === mailboxId);
    if (named !== undefined) return named;
    throw unprocessable("E_RECEIVING_NO_SUCH_MAILBOX", {
      what: `${mailboxId} is not a mailbox in this organization`,
      why: "the address has to file somewhere, and a mailbox this Node does not have is nowhere",
      fix: "GET /api/mailboxes lists them; pass one of those ids as mailboxId, or omit it when there is one",
    });
  }
  if (rows.results.length === 1) return rows.results[0]!;
  throw unprocessable("E_RECEIVING_MAILBOX_AMBIGUOUS", {
    what: `this organization has ${rows.results.length} mailboxes and the request named none`,
    why: "the address has to file into one of them, and choosing for you is choosing where a customer's mail "
      + "goes",
    fix: "GET /api/mailboxes lists them; pass one of those ids as mailboxId",
  });
}

export async function onboardReceiving(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string,
  domain: string, digest: string, mailboxAddress: string, mailboxId: string | null = null,
  catchAll = false,
): Promise<ReceivingOutcome> {
  const proposal = await receivingProposalFor(env, ctx, orgId, domain);
  if (catchAll && !proposal.apex) {
    throw unprocessable("E_RECEIVING_CATCH_ALL_NOT_APEX", {
      what: `${domain} is not the apex of its zone${proposal.zone === null ? "" : ` (${proposal.zone})`}`,
      why: "Cloudflare's catch-all supports apex domains only; a subdomain routes by one literal rule per address",
      fix: `confirm without catchAll, which writes a rule for ${mailboxAddress}, or onboard ${proposal.zone ?? "the apex"} itself`,
    });
  }
  if (proposal.refusal !== null) {
    throw unprocessable("E_RECEIVING_WILL_NOT_ONBOARD", {
      what: `this Node will not onboard ${domain} for receiving`,
      why: proposal.refusal,
      fix: "read the proposal again once the reason has changed: GET /api/provider/receiving?domain=…",
    });
  }
  // A proposal that refuses nothing names its zone; the type cannot see that, so it is said once, here.
  if (proposal.zoneId === null) {
    throw unprocessable("E_RECEIVING_WILL_NOT_ONBOARD", {
      what: `this Node will not onboard ${domain} for receiving`,
      why: "the proposal names no zone",
      fix: "read the proposal again: GET /api/provider/receiving?domain=…",
    });
  }
  if (digest !== proposal.digest) {
    throw conflict("E_RECEIVING_STALE", {
      what: "the proposal confirmed is not the one this Node would now apply",
      why: "the zone, its routing state, the records it requires, or what is already on this subdomain has "
        + "changed since it was shown",
      fix: `read the proposal again and confirm the digest it prints: ${proposal.digest}`,
    });
  }

  const normalized = mailboxAddress.trim().toLowerCase();
  if (!normalized.endsWith(`@${domain.toLowerCase()}`)) {
    throw unprocessable("E_RECEIVING_ADDRESS_ELSEWHERE", {
      what: `${normalized} is not an address on ${domain}`,
      why: "the rule routes mail for this subdomain, so an address elsewhere would be a rule that never "
        + "matches and an address nothing routes",
      fix: `pass an address ending in @${domain}`,
    });
  }
  const mailbox = await mailboxForAddress(env, orgId, mailboxId);

  /*
   * The address is registered on this Node **in the same batch as the audit entry, and before Cloudflare
   * is asked for anything** — so the Node knows the recipient by the time a rule can deliver one, and a
   * refusal from Cloudflare below leaves an address that files and no rule, which is harmless, rather than
   * a rule and no address, which is mail rejected. `INSERT OR IGNORE`: a second onboarding of the same
   * address is the resumable case, not a conflict.
   */
  await auditedBatch(env, ctx, orgId, {
    action: "provider.receiving_onboarded", outcome: "ok", actorUserId, subject: domain,
    detail: {
      zone: proposal.zone,
      // Named because it is the larger half: this decides where the whole domain's mail goes.
      enablesZone: proposal.enablesZone,
      creates: proposal.creates.map((one) => `${one.content} (priority ${one.priority})`),
      address: normalized,
      mailboxId: mailbox.id,
      // Which credential did this: the Node's stored token, or an operator's own carried on the request.
      authority: operatorOf(ctx) === null ? "token" : "operator",
      // True when this act took the zone's catch-all over, which `provider.catch_all_taken_over` records too, with
      // what it replaced. Adding an address later reads the live rules, not this.
      catchAll,
      // How the address is routed is recorded after the act, as `provider.receiving_routed`; an entry carrying
      // this and no such record stopped part-way (28 September 2026).
      routingFollows: true,
    },
  }, (entry) => [
    env.CATALOG.prepare(
      "INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), orgId, normalized, mailbox.id, new Date(ctx.now()).toISOString()),
    entry,
  ]);

  /*
   * The first address's routing, recorded after the act and beside the entry above, never on it: that entry
   * is the intent and is immutable. What the Setup progress and a re-run of `mailda setup` or `mailda upgrade`
   * read, so an onboarding whose address goes elsewhere is not "set up" on its second reading either. A throw is
   * recorded as `not_written` and re-raised.
   */
  const recordRouting = async (routing: AddressRouting) => await auditedBatch(env, ctx, orgId, {
    action: "provider.receiving_routed", outcome: routing.state === "catch_all" || routing.state === "rule_written" ? "ok" : "refused",
    actorUserId, subject: domain,
    detail: { address: normalized, routing: routing.state, routingDetail: routing.detail },
  }, (entry) => [entry]);
  let outcome: ReceivingOutcome;
  try {
    outcome = await routeReceiving(env, ctx, orgId, actorUserId, { ...proposal, zoneId: proposal.zoneId }, normalized, catchAll);
  } catch (error) {
    // A record that cannot itself be written is logged, and never replaces the stop the caller needs to see.
    await recordRouting({ state: "not_written", detail: `the onboarding stopped before ${normalized} was routed: ${(error as Error).message}` })
      .catch(async (unrecorded: Error) => await log(env, ctx, {
        level: "error", event: "provider.receiving_routed_unrecorded", orgId, message: unrecorded.message, detail: { domain, address: normalized },
      }));
    throw error;
  }
  await recordRouting(outcome.routing);
  return outcome;
}

/** The half of the onboarding that talks to Cloudflare, after the intent is recorded: the zone, the records, the rule. */
async function routeReceiving(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string,
  proposal: ReceivingProposal & { zoneId: string }, normalized: string, catchAll: boolean,
): Promise<ReceivingOutcome> {
  const domain = proposal.domain;
  /*
   * **Enable the zone first, then re-read.** A zone that is not yet routing lists no MX at all, so the
   * records a subdomain needs are not knowable until it is on — which is why the proposal shows an empty
   * `creates` beside a non-null `enablesZone` rather than pretending to enumerate them.
   *
   * `POST /email/routing/enable`, and not `PATCH /email/routing { enabled: true }`, which this used to send
   * on the argument that Cloudflare marks the former deprecated. Measured on the #92 drill, 16 September
   * 2026, against `mailda.site`: the `PATCH` answers `success: true` and leaves the zone `enabled: false,
   * status: unconfigured`; the `POST` answers `enabled: true, status: ready`. A success that does nothing
   * is the shape this repository keeps meeting, so the answer is read back rather than trusted: a zone
   * still disabled after the call is a refusal here, not a rule written to a zone that will not route.
   *
   * The enable runs whenever the zone is off, whether or not MX is already on the subdomain — the two are
   * separate facts, and a resumed onboarding (records present, zone still off) was the case that showed it.
   */
  if (proposal.enablesZone !== null) {
    await cloudflarePost<{ enabled?: boolean }>(
      env, ctx, orgId, `/zones/${proposal.zoneId}/email/routing/enable`, {},
    );
    const zoneNow = await cloudflareGet<{ enabled?: boolean; status?: string }>(
      env, ctx, orgId, `/zones/${proposal.zoneId}/email/routing`,
    );
    if (!zoneNow.ok || zoneNow.result.enabled !== true) {
      throw unprocessable("E_RECEIVING_ZONE_STILL_OFF", {
        what: `Email Routing on ${proposal.enablesZone} is still off after asking Cloudflare to enable it`,
        why: zoneNow.ok
          ? `the zone reports enabled=${String(zoneNow.result.enabled)}, status=${zoneNow.result.status ?? "?"}`
          : zoneNow.error,
        fix: "nothing was written on the subdomain and no rule was created. Enable Email Routing on the zone "
          + "in the Cloudflare dashboard, then run the proposal again",
      });
    }
  }

  /*
   * The catch-all path (25 September 2026). No MX is written: the apex's records are Cloudflare's own and
   * came with enabling the zone, and the zone was read back enabled above. The catch-all is replaced with
   * this Worker, recorded first with what it pointed at, and read back: a PUT that answered 200 is not the
   * catch-all any more than a POST is a record. Literal rules outrank the catch-all, so mail already routed
   * by name goes on exactly as before; only unmatched mail changes hands, and this Node bounces what it
   * does not know.
   */
  if (catchAll) {
    const worker = workerNameFor(env);
    const before = proposal.catchAll ?? { action: "?", destinations: [], enabled: false };
    const after: CatchAllRule = { action: "worker", destinations: [worker], enabled: true };
    await auditedBatch(env, ctx, orgId, {
      action: "provider.catch_all_taken_over", outcome: "ok", actorUserId, subject: proposal.zone ?? domain,
      detail: { zone: proposal.zone, before, after, authority: operatorOf(ctx) === null ? "token" : "operator" },
    }, (entry) => [entry]);
    await cloudflarePut(env, ctx, orgId, `/zones/${proposal.zoneId}/email/routing/rules/catch_all`, {
      name: "", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [worker] }],
    });
    const now = await catchAllOf(env, ctx, orgId, proposal.zoneId);
    const confirmed = now !== null && now.enabled && now.action === "worker" && now.destinations.includes(worker);
    /*
     * A literal rule outranks the catch-all, so the address just registered may still go elsewhere by a rule
     * of its own (28 September 2026: `admin@` had one to another Worker on the zone whose catch-all pointed
     * here). Read, and said; never rewritten. Rules that cannot be read leave it `unconfirmed`, never "here".
     */
    const rules = await routingRulesOf(env, ctx, orgId, proposal.zoneId);
    const routing: AddressRouting = !rules.ok
      ? {
        state: "unconfirmed",
        detail: `not confirmed: the catch-all routes an address here only when it has no rule of its own, and this `
          + `Node could not check whether ${normalized} has an Email Routing rule of its own: ${rules.error}`,
      }
      // The catch-all's own read-back decides whether it covers the address: the listing may lag the PUT above.
      : said(classifyAddress(rules.result, normalized, worker, confirmed, domain));
    return {
      domain, written: [], confirmed: confirmed ? ["catch-all → " + worker] : [],
      rule: "catch-all", routing,
      catchAll: { before, after: now ?? after },
      note: (confirmed
        ? `the catch-all on ${proposal.zone} now routes to this Node; before, it was ${before.enabled ? `${before.action}${before.destinations.length === 0 ? "" : ` → ${before.destinations.join(", ")}`}` : "disabled"}. `
          + "Every address this Node knows files unless a rule of its own sends it elsewhere; every other address on the apex bounces as an unknown recipient."
        : `the catch-all was written but did not read back as pointing here${now === null ? "" : ` (${now.action} → ${now.destinations.join(", ")}, enabled=${String(now.enabled)})`}; check the zone before relying on it.`)
        + (routing.state === "catch_all" ? "" : ` ${routing.detail}`),
    };
  }

  /*
   * The subdomain's records, through Email Routing's own endpoint: one `POST …/email/routing/dns { name }`
   * creates the set Cloudflare requires, and the same endpoint read back says whether they are there. An
   * apex writes nothing — its records came with enabling the zone — and is read back from the zone list.
   * **Read back before the rule**, still: a POST that answered 200 is not a record, and a rule without
   * records is accepted by Cloudflare and never matches.
   */
  const before = await routingRecordsOf(env, ctx, orgId, proposal.zoneId, proposal.apex ? null : domain);
  const written: string[] = [];
  if (!proposal.apex && (!before.ok || before.present.length === 0)) {
    await cloudflarePost<unknown>(env, ctx, orgId, `/zones/${proposal.zoneId}/email/routing/dns`, { name: domain });
    written.push(...(before.ok ? before.missing : proposal.creates).map((one) => `${one.content} (priority ${one.priority})`));
  }
  const back = await routingRecordsOf(env, ctx, orgId, proposal.zoneId, proposal.apex ? null : domain);
  const confirmed = back.ok ? back.present : [];
  if (confirmed.length === 0) {
    const note = "the records were accepted but read back absent, so no routing rule was created. A rule "
      + "without records is accepted by Cloudflare and never matches, which is the state this refuses to "
      + "leave behind. Check the zone before retrying.";
    return { domain, written, confirmed, rule: null, routing: { state: "not_written", detail: note }, catchAll: null, note };
  }

  /*
   * A rule already routing this exact address here is kept, not duplicated: Cloudflare refuses the duplicate
   * (`2014 Duplicated Zone rule`), and the #92 drill met that refusal on the third run of an onboarding
   * whose first had written the rule and whose second had registered the address. The check is on the
   * address, so a rule for a different address on the same domain still gets its own; a rule of the
   * address's own that sends it elsewhere, or is disabled, is named in the note and left as it is.
   */
  const routed = await ensureLiteralRule(env, ctx, orgId, proposal.zoneId, domain, normalized);

  return {
    domain, written, confirmed, rule: routed.rule, catchAll: null,
    routing: { state: routed.state, detail: routed.detail },
    note: routed.kept
      ? `a rule named ${routed.rule} already routed ${normalized}, and was kept rather than duplicated.`
      : routed.state !== "rule_written"
        ? routed.detail
        : proposal.rule === null
          ? null
          : `a routing rule named ${proposal.rule} already existed for this domain. It was inert until now — `
            + "the records it needed did not exist — and both rules will match from here.",
  };
}

/** A classification in the contract's words, where nothing is written: a `null` state is then `not_written`. */
function said(classified: Classified): AddressRouting {
  return { state: classified.state ?? "not_written", detail: classified.detail };
}

/**
 * One literal rule routing `address` to this Worker, kept if it already exists (Cloudflare refuses the
 * duplicate, `2014 Duplicated Zone rule`, met on the #92 drill). Shared by the receiving onboard and by
 * adding an address (25 September 2026), which is the same act minus the records.
 *
 * Decided by `classifyAddress` (28 September 2026): a rule of the address's own is kept only when it delivers
 * here, and one that forwards, names another Worker, drops or is disabled is somebody's routing, named and never
 * rewritten. Nothing is written when the rules cannot be read, because one may already route the address and a
 * blind write is the duplicate. `catchAllCovers` is true when the address is on the zone's apex, where a
 * catch-all pointing here routes it with no rule of its own.
 */
export async function ensureLiteralRule(
  env: Env, ctx: Ctx, orgId: string, zoneId: string, domain: string, address: string, catchAllCovers = false,
): Promise<{ state: AddressRouting["state"]; rule: string | null; kept: boolean; detail: string }> {
  const read = await routingRulesOf(env, ctx, orgId, zoneId);
  if (!read.ok) {
    return {
      state: "not_written", rule: null, kept: false,
      detail: `the routing rules on ${domain}'s zone could not be read, so none was written (one may already route ${address}): ${read.error}`,
    };
  }
  const worker = workerNameFor(env);
  const classified = classifyAddress(read.result, address, worker, catchAllCovers && catchAllRoutesHere(read.result, worker), domain);
  if (classified.state === "rule_written") {
    return { state: "rule_written", rule: classified.rule.name ?? "?", kept: true, detail: `${classified.detail}, and was kept` };
  }
  if (classified.state === "catch_all") {
    return { state: "catch_all", rule: "catch-all", kept: false, detail: `${classified.detail}; nothing to write` };
  }
  if (classified.state !== null) return { state: classified.state, rule: null, kept: false, detail: classified.detail };
  const rule = await cloudflarePost<{ name?: string }>(
    env, ctx, orgId, `/zones/${zoneId}/email/routing/rules`,
    {
      name: `mailda ${domain}`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: address }],
      actions: [{ type: "worker", value: [worker] }],
    },
  );
  return { state: "rule_written", rule: rule.name ?? "?", kept: false, detail: `a rule now routes ${address} to this Node` };
}

/**
 * An address on a mailbox, and the routing for it, in one act (25 September 2026).
 *
 * The address is written first, in the batch with its audit entry, so the Node knows the recipient before
 * anything can deliver one. Then the routing, read live from the zone's rules through whatever credential the
 * request carries (28 September 2026; it used to trust this Node's own record of taking the catch-all over, and
 * said `catch_all` for an address whose own rule sent it to another Worker): a rule of the address's own that
 * delivers here is kept, one that goes elsewhere is named and left (`routed_elsewhere`), a disabled one is named
 * and left (`rule_disabled`), a catch-all pointing here needs nothing on the apex, and otherwise a literal rule is
 * written. When the rules cannot be read — no
 * stored token, no operator token, or Cloudflare refuses — the answer names it and the next step, because an
 * address the Node knows and Cloudflare does not route is silent; on a domain whose catch-all this Node took
 * over that answer is `unconfirmed`, never `catch_all`.
 */
export async function addAddress(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, address: string, mailboxId: string | null,
): Promise<{ address: { id: string; address: string; mailboxId: string }; routing: AddressRouting }> {
  const normalized = address.trim().toLowerCase();
  const at = normalized.indexOf("@");
  if (at < 1 || at === normalized.length - 1) {
    throw unprocessable("E_ADDRESS_MALFORMED", {
      what: `${JSON.stringify(address)} is not an address`,
      why: "an address is local@domain, and the domain is what decides how it is routed",
      fix: "pass an address such as hello@mail.example.com",
    });
  }
  const domain = normalized.slice(at + 1);
  const mailbox = await mailboxForAddress(env, orgId, mailboxId);
  const id = ctx.id("addr");

  const notWritten = (why: string): AddressRouting => ({
    state: "not_written",
    detail: `${why}. Mail for ${normalized} does not reach this Node until a rule routes it: `
      + `mailda provider --onboard-receiving ${domain} --address ${normalized} --url <this Node>`,
  });
  /** The answer when the rules could not be read: this Node's own record decides which honest word it is. */
  const unread = async (why: string): Promise<AddressRouting> => (await catchAllTakenOverFor(env, orgId, domain))
    ? {
      state: "unconfirmed",
      detail: `not confirmed: this Node took over the catch-all on ${domain}, which routes an address here only when it `
        + `has no rule of its own, and could not check whether ${normalized} has an Email Routing rule of its own: ${why}`,
    }
    : notWritten(why);
  const routing = await (async (): Promise<AddressRouting> => {
    /*
     * Said first, in its own words: a Node with no stored token and no operator token has no credential at
     * all, and `zoneFor` would report the account as unresolved, which names the wrong next step (measured
     * in a browser on 25 September 2026: the line pointed at a resolve step on a Node that had never connected).
     */
    if (operatorOf(ctx) === null && (await providerStatus(env)).state !== "token_held") {
      return await unread("this Node holds no Cloudflare token and no operator credential came with the request");
    }
    const carrying = await zoneFor(env, ctx, orgId, domain).catch((error: Error) => ({ ok: false as const, error: error.message }));
    if (!carrying.ok) return await unread(carrying.error);
    if (carrying.zone === null) return await unread(`no zone in this account carries ${domain}`);
    try {
      const routed = await ensureLiteralRule(
        env, ctx, orgId, carrying.zone.id, domain, normalized, domain === carrying.zone.name.toLowerCase(),
      );
      return routed.state === "not_written" ? await unread(routed.detail) : { state: routed.state, detail: routed.detail };
    } catch (error) {
      // The rules were read and the write refused: Cloudflare's own words, and the next step.
      return notWritten((error as Error).message);
    }
  })();

  await auditedBatch(env, ctx, orgId, {
    action: "address.added", outcome: "ok", actorUserId, subject: normalized,
    detail: { mailboxId: mailbox.id, domain, routing: routing.state, routingDetail: routing.detail },
  }, (entry) => [
    env.CATALOG.prepare(
      "INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(id, orgId, normalized, mailbox.id, new Date(ctx.now()).toISOString()),
    entry,
  ]);
  const row = await env.CATALOG.prepare("SELECT id, mailbox_id FROM addresses WHERE org_id = ? AND address = ?")
    .bind(orgId, normalized).first<{ id: string; mailbox_id: string }>();
  return { address: { id: row?.id ?? id, address: normalized, mailboxId: row?.mailbox_id ?? mailbox.id }, routing };
}

/**
 * Whether this Node holds the catch-all on `domain`: the latest take-over or put-back of it is a take-over. This
 * Node's own history, not the zone's state, so it only decides which word an unread answer gets: `unconfirmed`,
 * never `catch_all`. Read from the catch-all's own entries rather than the latest onboard (28 September 2026): a
 * later onboard of one address on the same apex, without the catch-all, did not give the catch-all back.
 */
async function catchAllTakenOverFor(env: Env, orgId: string, domain: string): Promise<boolean> {
  const row = await env.CATALOG.prepare(
    "SELECT action FROM audit_entries WHERE org_id = ? AND subject = ? "
    + "AND action IN ('provider.catch_all_taken_over', 'provider.catch_all_put_back') ORDER BY seq DESC LIMIT 1",
  ).bind(orgId, domain).first<{ action: string }>();
  return row?.action === "provider.catch_all_taken_over";
}

/**
 * The address removed, and the routing rule `addAddress` wrote for it removed with it (26 September 2026).
 *
 * The mirror of adding, from the same live reading of the zone's rules: the address's own rule is deleted
 * only when it delivers here (enabled, a Worker action naming this Worker) and this Node wrote it, because a rule
 * somebody has since pointed elsewhere, or disabled, is theirs and is left where it is, and one this Node took
 * over is theirs too and is put back rather than deleted (`mailda provider --put-back`, named in the answer);
 * with no rule of its own under a catch-all that points here there is nothing to remove. The row goes in every
 * case, in the batch
 * with its audit entry, and `not_removed` names what still routes and where to delete it: a rule pointing
 * an unknown recipient at this Node is the mirror of the silent address, in that mail arrives and bounces.
 *
 * **An address that has received mail is refused, by name.** The `addresses` row is the join every read
 * makes from a receipt's `envelope_to` to its mailbox (`authz-read.ts`, `materialise.ts`, `cases.ts`), so
 * deleting it would not delete the mail: it would make every message received at it vanish from every
 * queue and every read while the bytes stay in R2, which is "accepted but absent" (Blueprint §24) built
 * from the People screen. So the row goes only when nothing was ever received at it, and the predicate
 * rides on the DELETE itself so a delivery landing between the check and the batch is refused too.
 *
 * A mailbox may be left with no address. Nothing on this Node holds that invariant; the first send from it
 * refuses with `E_MAILBOX_HAS_NO_ADDRESS`, which names the fix.
 */
export async function removeAddress(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, address: string,
): Promise<{ address: { id: string; address: string; mailboxId: string }; routing: AddressRemoval }> {
  const normalized = address.trim().toLowerCase();
  const row = await env.CATALOG.prepare("SELECT id, mailbox_id FROM addresses WHERE org_id = ? AND address = ?")
    .bind(orgId, normalized).first<{ id: string; mailbox_id: string }>();
  if (row === null) {
    throw notFound("E_NO_SUCH_ADDRESS", {
      what: `${JSON.stringify(address)} is not an address on this Node`,
      why: "removing names the address it removes, and this Node has no row for it",
      fix: "GET /api/mailboxes lists each mailbox's addresses",
    });
  }
  const domain = normalized.slice(normalized.indexOf("@") + 1);
  const received = async () => (await env.CATALOG.prepare("SELECT COUNT(*) AS n FROM ingress_receipts WHERE org_id = ? AND envelope_to = ?")
    .bind(orgId, normalized).first<{ n: number }>())?.n ?? 0;
  const refusal = (n: number) => conflict("E_ADDRESS_HAS_MAIL", {
    what: `${normalized} has received ${n} message${n === 1 ? "" : "s"}, so it stays`,
    why: "every message is filed under its mailbox through this address; removing it would hide them all while keeping the bytes",
    fix: `to stop mail arriving at ${normalized}, delete its routing rule in the Cloudflare dashboard (Email, Email Routing, Routing rules); the address stays as the record of what did arrive`,
  });
  const before = await received();
  if (before > 0) throw refusal(before);

  let takenOver = false;
  const routing = await (async (): Promise<AddressRemoval> => {
    if (operatorOf(ctx) === null && (await providerStatus(env)).state !== "token_held") {
      return { state: "not_removed", detail: "this Node holds no Cloudflare token and no operator credential came with the request" };
    }
    const carrying = await zoneFor(env, ctx, orgId, domain).catch((error: Error) => ({ ok: false as const, error: error.message }));
    if (!carrying.ok) return { state: "not_removed", detail: carrying.error };
    if (carrying.zone === null) return { state: "not_removed", detail: `no zone in this account carries ${domain}` };
    // The same reading adding makes, so a rule this Node deletes is one that delivers here and nothing else.
    const read = await routingRulesOf(env, ctx, orgId, carrying.zone.id);
    if (!read.ok) return { state: "not_removed", detail: read.error };
    const worker = workerNameFor(env);
    const apex = domain === carrying.zone.name.toLowerCase();
    const own = classifyAddress(read.result, normalized, worker, apex && catchAllRoutesHere(read.result, worker), domain);
    if (own.state === null) return { state: "not_removed", detail: `no rule on ${carrying.zone.name} routes ${normalized}; nothing to remove` };
    if (own.state === "catch_all") return { state: "catch_all", detail: `${own.detail}; nothing to remove` };
    if (own.state === "routed_elsewhere") {
      return { state: "not_removed", detail: `the rule for ${normalized} is ${whereTo(own.rule)}, not this Node, so it was left alone` };
    }
    if (own.state === "rule_disabled") {
      return { state: "not_removed", detail: `the rule for ${normalized} is disabled (enabled, it would be ${whereTo(own.rule)}), so it was left alone` };
    }
    /*
     * A rule this Node took over is the customer's rule with its action replaced, not one this Node wrote
     * (28 September 2026). Deleting it would destroy their routing and the put-back with it, so it is left, and
     * the answer names the put-back, which restores the action the take-over recorded.
     */
    const taken = await env.CATALOG.prepare(
      "SELECT action, detail FROM audit_entries WHERE org_id = ? AND subject = ? "
      + "AND action IN ('provider.routing_rule_taken_over', 'provider.routing_rule_put_back') ORDER BY seq DESC LIMIT 1",
    ).bind(orgId, own.rule.id ?? "").first<{ action: string; detail: string | null }>();
    if (taken?.action === "provider.routing_rule_taken_over") {
      takenOver = true;
      const was = (JSON.parse(taken.detail ?? "{}") as { before?: { action?: string; destinations?: string[] } }).before;
      return {
        state: "not_removed",
        detail: `the rule for ${normalized} (${JSON.stringify(own.rule.name ?? "")}) was taken over by this Node from `
          + `${was?.action ?? "?"}${(was?.destinations ?? []).length === 0 ? "" : ` to ${(was?.destinations ?? []).join(", ")}`}, not written by it, `
          + "so it was left: deleting it would lose the customer's routing. Mail for the address still reaches this Node "
          + `and bounces as an unknown recipient until it is put back: mailda provider --put-back ${own.rule.id ?? "<rule id>"} --domain ${domain}`,
      };
    }
    try {
      await cloudflareDelete<unknown>(env, ctx, orgId, `/zones/${carrying.zone.id}/email/routing/rules/${own.rule.id}`);
      return { state: "rule_removed", detail: `the rule routing ${normalized} to this Node was deleted` };
    } catch (error) {
      return { state: "not_removed", detail: (error as Error).message };
    }
  })();
  if (routing.state === "not_removed" && !takenOver) {
    routing.detail += `. If a rule still routes ${normalized} here, mail for it arrives for a recipient this Node no longer knows: `
      + "delete the rule in the Cloudflare dashboard (Email, Email Routing, Routing rules)";
  }

  const nothingReceived = "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ingress_receipts WHERE org_id = ? AND envelope_to = ?)";
  const { results } = await auditedBatch(env, ctx, orgId, {
    action: "address.removed", outcome: "ok", actorUserId, subject: normalized,
    detail: { mailboxId: row.mailbox_id, domain, routing: routing.state, routingDetail: routing.detail },
  }, (entry) => [
    entry,
    env.CATALOG.prepare(`DELETE FROM addresses WHERE org_id = ? AND id = ? AND EXISTS (${nothingReceived})`)
      .bind(orgId, row.id, orgId, normalized),
  ], { sql: nothingReceived, params: [orgId, normalized] });
  // A delivery landed between the check above and the batch: neither the entry nor the delete happened.
  if ((results[1]?.meta.changes ?? 0) === 0) throw refusal(await received());
  return { address: { id: row.id, address: normalized, mailboxId: row.mailbox_id }, routing };
}

/**
 * This Worker's own name, which the routing rule has to name as its destination.
 *
 * Read from the binding rather than configured: ADR 24 keeps ids out of committed config, and a Node that
 * wrote its own name into a rule from a constant would route another Node's mail after a rename.
 */
export function workerNameFor(env: Env): string {
  // Typed as the two names `wrangler.jsonc` declares; a fork renames the Worker, so read it as any string.
  const named: string | undefined = env.WORKER_NAME;
  if (typeof named === "string" && named !== "") return named;
  throw unprocessable("E_RECEIVING_NO_WORKER_NAME", {
    what: "this Node does not know its own Worker name, so it cannot name itself as a routing destination",
    why: "a rule must name the Worker that receives, and writing a guess would route mail to another Node",
    fix: "set WORKER_NAME in wrangler.jsonc's vars",
  });
}
