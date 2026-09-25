import { operatorOf } from "./cloudflare-api.ts";
import { providerStatus } from "./grant-oauth.ts";
import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { conflict, unprocessable } from "../errors.ts";
import { sha256Hex } from "../evidence-store.ts";
import { cloudflareGet, cloudflareGetAll, cloudflarePost, cloudflarePut, zoneFor } from "./cloudflare-grant.ts";

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

export interface CloudflareRule {
  id?: string;
  name?: string;
  enabled?: boolean;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
  actions?: Array<{ type?: string; value?: string[] }>;
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
  rule: string | null;
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
      // Which credential did this: the Node's grant, or an operator's own token carried on the request.
      authority: operatorOf(ctx) === null ? "grant" : "operator",
      // True when the zone's catch-all is what routes here, so adding an address later writes no rule.
      catchAll,
    },
  }, (entry) => [
    env.CATALOG.prepare(
      "INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), orgId, normalized, mailbox.id, new Date(ctx.now()).toISOString()),
    entry,
  ]);

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
      detail: { zone: proposal.zone, before, after, authority: operatorOf(ctx) === null ? "grant" : "operator" },
    }, (entry) => [entry]);
    await cloudflarePut(env, ctx, orgId, `/zones/${proposal.zoneId}/email/routing/rules/catch_all`, {
      name: "", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [worker] }],
    });
    const now = await catchAllOf(env, ctx, orgId, proposal.zoneId);
    const confirmed = now !== null && now.enabled && now.action === "worker" && now.destinations.includes(worker);
    return {
      domain, written: [], confirmed: confirmed ? ["catch-all → " + worker] : [], rule: "catch-all",
      catchAll: { before, after: now ?? after },
      note: confirmed
        ? `the catch-all on ${proposal.zone} now routes to this Node; before, it was ${before.enabled ? `${before.action}${before.destinations.length === 0 ? "" : ` → ${before.destinations.join(", ")}`}` : "disabled"}. `
          + "Every address this Node knows files; every other address on the apex bounces as an unknown recipient."
        : `the catch-all was written but did not read back as pointing here${now === null ? "" : ` (${now.action} → ${now.destinations.join(", ")}, enabled=${String(now.enabled)})`}; check the zone before relying on it.`,
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
    return {
      domain, written, confirmed, rule: null, catchAll: null,
      note: "the records were accepted but read back absent, so no routing rule was created. A rule "
        + "without records is accepted by Cloudflare and never matches, which is the state this refuses to "
        + "leave behind. Check the zone before retrying.",
    };
  }

  /*
   * A rule already routing this exact address is kept, not duplicated: Cloudflare refuses the duplicate
   * (`2014 Duplicated Zone rule`), and the #92 drill met that refusal on the third run of an onboarding
   * whose first had written the rule and whose second had registered the address. The check is on the
   * address, so a rule for a different address on the same domain still gets its own.
   */
  const { rule, existing } = await ensureLiteralRule(env, ctx, orgId, proposal.zoneId, domain, normalized);

  return {
    domain, written, confirmed, rule: rule.name ?? null, catchAll: null,
    note: existing !== undefined
      ? `a rule named ${existing.name ?? "?"} already routed ${normalized}, and was kept rather than duplicated.`
      : proposal.rule === null
        ? null
        : `a routing rule named ${proposal.rule} already existed for this domain. It was inert until now — `
          + "the records it needed did not exist — and both rules will match from here.",
  };
}

/**
 * One literal rule routing `address` to this Worker, kept if it already exists (Cloudflare refuses the
 * duplicate, `2014 Duplicated Zone rule`, met on the #92 drill). Shared by the receiving onboard and by
 * adding an address (25 September 2026), which is the same act minus the records.
 */
export async function ensureLiteralRule(
  env: Env, ctx: Ctx, orgId: string, zoneId: string, domain: string, address: string,
): Promise<{ rule: { name?: string }; existing: CloudflareRule | undefined }> {
  const rules = await routingRulesOf(env, ctx, orgId, zoneId);
  const existing = rules.ok
    ? rules.result.find((one) => (one.matchers ?? []).some((m) =>
      m.field === "to" && typeof m.value === "string" && m.value.toLowerCase() === address))
    : undefined;
  const rule = existing ?? await cloudflarePost<{ name?: string }>(
    env, ctx, orgId, `/zones/${zoneId}/email/routing/rules`,
    {
      name: `mailda ${domain}`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: address }],
      actions: [{ type: "worker", value: [workerNameFor(env)] }],
    },
  );
  return { rule, existing };
}

/**
 * An address on a mailbox, and the routing for it, in one act (25 September 2026).
 *
 * The address is written first, in the batch with its audit entry, so the Node knows the recipient before
 * anything can deliver one. Then the routing: nothing to write when this domain's catch-all was taken over
 * (`receiving_onboarded` with `catchAll: true`, the latest entry for the domain); a literal rule otherwise,
 * through whatever credential the request carries; and when none can — no grant, no operator token, or
 * Cloudflare refuses — the answer names it and the next step, because an address the Node knows and
 * Cloudflare does not route is silent, which is the one state this refuses to leave unsaid.
 */
export async function addAddress(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, address: string, mailboxId: string | null,
): Promise<{
  address: { id: string; address: string; mailboxId: string };
  routing: { state: "catch_all" | "rule_written" | "not_written"; detail: string };
}> {
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

  const routedByCatchAll = await env.CATALOG.prepare(
    "SELECT detail FROM audit_entries WHERE org_id = ? AND action = 'provider.receiving_onboarded' "
    + "AND subject = ? ORDER BY seq DESC LIMIT 1",
  ).bind(orgId, domain).first<{ detail: string | null }>().then((row) => {
    try { return (JSON.parse(row?.detail ?? "{}") as { catchAll?: unknown }).catchAll === true; } catch { return false; }
  });

  let routing: { state: "catch_all" | "rule_written" | "not_written"; detail: string };
  if (routedByCatchAll) {
    routing = { state: "catch_all", detail: `the catch-all on ${domain} routes every address here; nothing to write` };
  } else {
    routing = await (async () => {
      /*
       * Said first, in its own words: a Node with no grant and no operator token has no credential at all,
       * and `zoneFor` would report the account as unresolved, which names the wrong next step (measured in
       * a browser on 25 September 2026: the line pointed at resolve-account on a Node that had never connected).
       */
      if (operatorOf(ctx) === null && (await providerStatus(env)).state !== "consent_granted") {
        return { state: "not_written" as const, detail: "this Node holds no Cloudflare grant and no operator credential came with the request" };
      }
      const carrying = await zoneFor(env, ctx, orgId, domain).catch((error: Error) => ({ ok: false as const, error: error.message }));
      if (!carrying.ok) return { state: "not_written" as const, detail: carrying.error };
      if (carrying.zone === null) return { state: "not_written" as const, detail: `no zone in this account carries ${domain}` };
      try {
        const { existing } = await ensureLiteralRule(env, ctx, orgId, carrying.zone.id, domain, normalized);
        return { state: "rule_written" as const, detail: existing === undefined ? `a rule now routes ${normalized} to this Node` : `a rule already routed ${normalized} here and was kept` };
      } catch (error) {
        return { state: "not_written" as const, detail: (error as Error).message };
      }
    })();
    if (routing.state === "not_written") {
      routing.detail += `. Mail for ${normalized} does not reach this Node until a rule routes it: `
        + `mailda provider --onboard-receiving ${domain} --address ${normalized} --url <this Node>`;
    }
  }

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
