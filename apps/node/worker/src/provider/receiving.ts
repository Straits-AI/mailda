import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { conflict, unprocessable } from "../errors.ts";
import { sha256Hex } from "../evidence-store.ts";
import { cloudflareGet, cloudflarePatch, cloudflarePost, zoneFor } from "./cloudflare-grant.ts";

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
 * ## Why this needs `dns.write`, stated where the authority is spent
 *
 * The dashboard's **Settings → Subdomains** flow onboards a subdomain *and* writes its records, which is why
 * an operator using it never touches MX by hand. That flow has no API — `routing.subdomain_api_available: 0`
 * is still true. But the two things it does separately both do: a rule, and DNS records. So a Node holding
 * `dns.write` can do end to end what the wizard does, and one without it can only offer the inert half.
 *
 * `dns.write` is the largest authority this Node asks for. It is spent by this function and nowhere else.
 *
 * ## The records come from Cloudflare, not from here
 *
 * `GET /zones/{id}/email/routing/dns` answers with the MX records the zone's Email Routing requires, hosts
 * and priorities included. Those are copied onto the subdomain. A list this repository maintained would be a
 * second copy of somebody else's requirements — the same argument `emailRoutingFor` makes, and the same one
 * that made the sending onboard a single `POST` rather than a record list.
 */

export interface ReceivingProposal {
  domain: string;
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

interface CloudflareRule {
  id?: string;
  name?: string;
  matchers?: Array<{ field?: string; value?: string }>;
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
      domain, zone: null, zoneId: null, zoneRouting: null, enablesZone: null, creates: [], present: [],
      rule: null, refusal: null, ...over,
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
  const required = await cloudflareGet<Array<{
    type?: string; name?: string; content?: string; priority?: number;
  }>>(env, ctx, orgId, `/zones/${zone.id}/email/routing/dns`);
  if (!required.ok) {
    return await blank({
      zone: zone.name, zoneId: zone.id, zoneRouting, enablesZone, refusal: required.error,
    });
  }

  /*
   * MX only. The zone's list also carries SPF and DKIM, which belong to **sending** and are written at the
   * apex — copying them onto a receiving subdomain would assert a sending posture nobody asked for.
   */
  const creates = required.result
    .filter((one) => one.type === "MX")
    .map((one) => ({
      type: "MX", name: domain, content: one.content ?? "?", priority: one.priority ?? null,
    }));
  if (creates.length === 0) {
    return await blank({
      zone: zone.name, zoneId: zone.id, zoneRouting, enablesZone,
      /*
       * A zone that is not yet routing lists no MX, which is not an error — it is the state enabling fixes.
       * So this only refuses when the zone **is** routing and still offers nothing, which would mean
       * Cloudflare and its own routing state disagree.
       */
      refusal: enablesZone !== null
        ? null
        : `Cloudflare lists no MX for ${zone.name} although Email Routing is on there, so there is nothing `
          + `to copy onto ${domain}`,
    });
  }

  const existing = await cloudflareGet<Array<{ type?: string; content?: string }>>(
    env, ctx, orgId, `/zones/${zone.id}/dns_records?type=MX&name=${encodeURIComponent(domain)}`,
  );
  const rules = await cloudflareGet<CloudflareRule[]>(
    env, ctx, orgId, `/zones/${zone.id}/email/routing/rules?per_page=50`,
  );
  const found = rules.ok ? ruleFor(rules.result, domain) : undefined;

  const present = existing.ok ? existing.result.map((one) => one.content ?? "?") : [];
  const proposal = await blank({
    zone: zone.name, zoneId: zone.id, zoneRouting, enablesZone,
    creates: present.length > 0 ? [] : creates,
    present,
    rule: found?.name ?? null,
    refusal: !existing.ok
      ? `this Node could not read the MX already on ${domain}: ${existing.error}. It will not write records `
        + "it cannot first rule out having written"
      : present.length > 0
        ? `${domain} already has MX (${present.join(", ")}), so it is already pointed at a mail host`
        : null,
  });
  return proposal;
}

export interface ReceivingOutcome {
  domain: string;
  written: string[];
  /** Read back from Cloudflare after writing, because a write that reports success is not a record. */
  confirmed: string[];
  rule: string | null;
  note: string | null;
}

/**
 * Write the records, confirm them, then the rule. **In that order, and the order is the finding.**
 *
 * A rule created before its records is the inert rule this module exists to prevent. So the records go
 * first, are read back rather than assumed, and the rule is only written once they are there.
 */
export async function onboardReceiving(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string,
  domain: string, digest: string, mailboxAddress: string,
): Promise<ReceivingOutcome> {
  const proposal = await receivingProposalFor(env, ctx, orgId, domain);
  if (proposal.refusal !== null) {
    throw unprocessable("E_RECEIVING_WILL_NOT_ONBOARD", {
      what: `this Node will not onboard ${domain} for receiving`,
      why: proposal.refusal,
      fix: "read the proposal again once the reason has changed: GET /api/provider/receiving?domain=…",
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

  await auditedBatch(env, ctx, orgId, {
    action: "provider.receiving_onboarded", outcome: "ok", actorUserId, subject: domain,
    detail: {
      zone: proposal.zone,
      // Named because it is the larger half: this decides where the whole domain's mail goes.
      enablesZone: proposal.enablesZone,
      creates: proposal.creates.map((one) => `${one.content} (priority ${one.priority})`),
      address: mailboxAddress,
    },
  }, (entry) => [entry]);

  /*
   * **Enable the zone first, then re-read.** A zone that is not yet routing lists no MX at all, so the
   * records a subdomain needs are not knowable until it is on — which is why the proposal shows an empty
   * `creates` beside a non-null `enablesZone` rather than pretending to enumerate them.
   *
   * `PATCH /email/routing` rather than `POST /email/routing/enable`: the latter is the endpoint Cloudflare
   * marks deprecated.
   */
  let records = proposal.creates;
  if (proposal.enablesZone !== null) {
    await cloudflarePatch<{ enabled?: boolean }>(
      env, ctx, orgId, `/zones/${proposal.zoneId}/email/routing`, { enabled: true },
    );
    const now = await cloudflareGet<Array<{
      type?: string; content?: string; priority?: number;
    }>>(env, ctx, orgId, `/zones/${proposal.zoneId}/email/routing/dns`);
    if (!now.ok) {
      return {
        domain, written: [], confirmed: [], rule: null,
        note: `Email Routing was enabled on ${proposal.enablesZone}, and the records it requires could not `
          + `then be read: ${now.error}. Nothing was written on ${domain} and no rule was created — run the `
          + "proposal again, which will now see a routing zone.",
      };
    }
    records = now.result
      .filter((one) => one.type === "MX")
      .map((one) => ({
        type: "MX", name: domain, content: one.content ?? "?", priority: one.priority ?? null,
      }));
  }

  const written: string[] = [];
  for (const record of records) {
    await cloudflarePost<{ id?: string }>(
      env, ctx, orgId, `/zones/${proposal.zoneId}/dns_records`,
      { type: "MX", name: record.name, content: record.content, priority: record.priority, ttl: 1 },
    );
    written.push(`${record.content} (priority ${record.priority})`);
  }

  /*
   * **Read back before the rule.** A `POST` that answered 200 is not a record in DNS, and the whole reason
   * this module exists is that a rule without records is accepted and silent. If the confirmation is empty
   * the rule is not written, because an unwritten rule is a visible failure and an inert one is not.
   */
  const back = await cloudflareGet<Array<{ content?: string }>>(
    env, ctx, orgId,
    `/zones/${proposal.zoneId}/dns_records?type=MX&name=${encodeURIComponent(domain)}`,
  );
  const confirmed = back.ok ? back.result.map((one) => one.content ?? "?") : [];
  if (confirmed.length === 0) {
    return {
      domain, written, confirmed, rule: null,
      note: "the MX records were accepted but read back empty, so no routing rule was created. A rule "
        + "without records is accepted by Cloudflare and never matches, which is the state this refuses to "
        + "leave behind. Check the zone before retrying.",
    };
  }

  const rule = await cloudflarePost<{ name?: string }>(
    env, ctx, orgId, `/zones/${proposal.zoneId}/email/routing/rules`,
    {
      name: `mailda ${domain}`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: mailboxAddress }],
      actions: [{ type: "worker", value: [workerNameFor(env)] }],
    },
  );

  return {
    domain, written, confirmed, rule: rule.name ?? null,
    note: proposal.rule === null
      ? null
      : `a routing rule named ${proposal.rule} already existed for this domain. It was inert until now — `
        + "the records it needed did not exist — and both rules will match from here.",
  };
}

/**
 * This Worker's own name, which the routing rule has to name as its destination.
 *
 * Read from the binding rather than configured: ADR 24 keeps ids out of committed config, and a Node that
 * wrote its own name into a rule from a constant would route another Node's mail after a rename.
 */
function workerNameFor(env: Env): string {
  const named = (env as unknown as { WORKER_NAME?: string }).WORKER_NAME;
  if (typeof named === "string" && named !== "") return named;
  throw unprocessable("E_RECEIVING_NO_WORKER_NAME", {
    what: "this Node does not know its own Worker name, so it cannot name itself as a routing destination",
    why: "a rule must name the Worker that receives, and writing a guess would route mail to another Node",
    fix: "set WORKER_NAME in wrangler.jsonc's vars",
  });
}
