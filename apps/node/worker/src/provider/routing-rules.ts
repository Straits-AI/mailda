import type { Ctx } from "@mailda/runtime";

import { auditedBatch, log } from "../audit.ts";
import { conflict, unprocessable } from "../errors.ts";
import { sha256Hex } from "../evidence-store.ts";
import { cloudflareGet, cloudflarePut, zoneFor } from "./cloudflare-grant.ts";
import { type CloudflareRule, mailboxForAddress, routingRulesOf, workerNameFor } from "./receiving.ts";

/**
 * The routing rules already on a zone, and taking one over (#258).
 *
 * `onboardReceiving` keeps a rule that already routes the address it is asked for, so on a zone that was
 * receiving mail before this Node existed, "onboard `hello@`" leaves `hello@` forwarding to wherever it
 * went and reports success. This module is the part that was missing: **see** what routes where, **replace**
 * one rule's action with this Worker, and **put it back**.
 *
 * Measured (`docs/receipts/email-routing-rule-takeover.md`): a rule holds exactly one action, so there is no
 * "forward and also send to the Node". Taking over is a replacement, and the previous action is recorded on
 * the audit entry so the replacement can be undone by the same call in the other direction.
 */

export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  /** The `to` address a literal matcher names, or `*` for the catch-all. */
  to: string;
  action: string;
  destinations: string[];
  catchAll: boolean;
  /** Whether the action already names this Worker. */
  ours: boolean;
  /**
   * Over the rule as listed. A take-over quotes it, so a rule edited in the dashboard between the listing
   * and the confirm is refused as stale rather than overwritten with what this Node last saw.
   */
  digest: string;
  /**
   * What this Node would do with the rule if asked, decided by the same checks the act makes (30 September 2026),
   * so no channel offers a take-over or put-back the server must refuse. Null with `refusal` saying why.
   */
  offer: "take_over" | "put_back" | null;
  /** The refusal the act would answer, by code, when nothing is offered. */
  refusal: Refusal | null;
}

/** A named refusal, as the act would throw it. */
export interface Refusal { code: string; what: string; why: string; fix: string }

type Listed = Omit<RoutingRule, "offer" | "refusal">;

export interface RoutingRules {
  domain: string;
  zone: string | null;
  zoneId: string | null;
  rules: RoutingRule[];
  error: string | null;
}

async function describe(raw: CloudflareRule, worker: string | null): Promise<Listed> {
  const literal = (raw.matchers ?? []).find((m) => m.type === "literal" && m.field === "to");
  const catchAll = literal === undefined && (raw.matchers ?? []).some((m) => m.type === "all");
  const action = raw.actions?.[0];
  const destinations = action?.value ?? [];
  const body = {
    id: raw.id ?? "", name: raw.name ?? "", enabled: raw.enabled === true,
    to: literal?.value?.toLowerCase() ?? (catchAll ? "*" : ""),
    action: action?.type ?? "?", destinations, catchAll,
    ours: action?.type === "worker" && worker !== null && destinations.includes(worker),
  };
  const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify([
    body.id, body.name, body.enabled, body.to, body.action, body.destinations,
  ])));
  return { ...body, digest };
}

export async function routingRulesFor(
  env: Env, ctx: Ctx, orgId: string, domain: string,
): Promise<RoutingRules> {
  const blank: RoutingRules = { domain, zone: null, zoneId: null, rules: [], error: null };
  const carrying = await zoneFor(env, ctx, orgId, domain);
  if (!carrying.ok) return { ...blank, error: carrying.error };
  if (carrying.zone === null) return { ...blank, error: `no zone in this account carries ${domain}` };
  const zone = carrying.zone;
  const listed = await routingRulesOf(env, ctx, orgId, zone.id);
  if (!listed.ok) return { ...blank, zone: zone.name, zoneId: zone.id, error: listed.error };
  // Listing must not fail on a Node that does not know its own name; taking over must.
  const worker = env.WORKER_NAME ?? null;
  const rules = await Promise.all(listed.result.map((one) => describe(one, worker)));
  // Which rules this Node took over, read only when one names it: a put-back restores what that entry recorded.
  const taken = new Set<string>();
  if (rules.some((one) => one.ours)) {
    const { results } = await env.CATALOG.prepare(
      "SELECT DISTINCT action, subject FROM audit_entries WHERE org_id = ? AND action IN (?, ?)",
    ).bind(orgId, "provider.routing_rule_taken_over", "provider.catch_all_taken_over").all<{ action: string; subject: string }>();
    for (const one of results) taken.add(`${one.action} ${one.subject}`);
  }
  return {
    domain, zone: zone.name, zoneId: zone.id, error: null,
    rules: rules.map((rule) => {
      if (rule.ours) {
        const refusal = taken.has(takenKey(rule, zone.name)) ? null : neverTaken(rule.id);
        return { ...rule, offer: refusal === null ? "put_back" as const : null, refusal };
      }
      const refusal = takeOverRefusal(rules, rule);
      return { ...rule, offer: refusal === null ? "take_over" as const : null, refusal };
    }),
  };
}

/** The audit entry a put-back restores from: the catch-all's is recorded against the zone, a rule's against its id. */
const takenKey = (rule: Listed, zone: string) =>
  rule.catchAll ? `provider.catch_all_taken_over ${zone}` : `provider.routing_rule_taken_over ${rule.id}`;

const neverTaken = (ruleId: string): Refusal => ({
  code: "E_ROUTING_RULE_NEVER_TAKEN",
  what: `this Node never took over rule ${ruleId}`,
  why: "a put-back restores the action the take-over recorded, and there is none",
  fix: "a rule this Node did not change is edited in the Cloudflare dashboard",
});

export interface TakeoverOutcome {
  ruleId: string;
  to: string;
  /** The action the rule had, which is what a put-back restores. */
  before: { action: string; destinations: string[] };
  /** As Cloudflare read the rule back after the PUT, never as sent. */
  after: { action: string; destinations: string[] };
  /** The mailbox the address files into after a take-over, which is the address row's own; null on a put-back. */
  mailbox: { id: string; name: string } | null;
}

async function ruleNow(
  env: Env, ctx: Ctx, orgId: string, domain: string, ruleId: string,
): Promise<{ listing: RoutingRules; rule: RoutingRule; raw: CloudflareRule }> {
  const listing = await routingRulesFor(env, ctx, orgId, domain);
  if (listing.error !== null) {
    throw unprocessable("E_ROUTING_RULES_UNREADABLE", {
      what: `the routing rules on ${domain} could not be read`,
      why: listing.error,
      fix: "this Node changes no rule it cannot first read; check the grant and the zone",
    });
  }
  const rule = listing.rules.find((one) => one.id === ruleId);
  if (rule === undefined) {
    throw unprocessable("E_ROUTING_RULE_UNKNOWN", {
      what: `${ruleId} is not a routing rule on ${listing.zone}`,
      why: "it may have been deleted since it was listed",
      fix: `GET /api/provider/routing-rules?domain=${domain} lists what is there now`,
    });
  }
  // The raw rule, because a PUT must carry the matchers exactly as Cloudflare holds them.
  const raw = await cloudflareGet<CloudflareRule>(
    env, ctx, orgId, `/zones/${listing.zoneId}/email/routing/rules/${ruleId}`,
  );
  if (!raw.ok) {
    throw unprocessable("E_ROUTING_RULES_UNREADABLE", {
      what: `rule ${ruleId} could not be read back`, why: raw.error,
      fix: "this Node changes no rule it cannot first read; check the grant and the zone",
    });
  }
  return { listing, rule, raw: raw.result };
}

/**
 * The PUT, then the rule read back from the same path, and the answer recorded as
 * `provider.routing_rule_read_back` (30 September 2026).
 *
 * The take-over and put-back entries are the intent and go first, for `receiving_onboarded`'s reason: a PUT
 * whose answer is lost has still changed the customer's routing. They used to be the only record, and said `ok`
 * before Cloudflare had answered. This is the result beside them, the way `provider.receiving_routed` follows an
 * onboard, and it says only what the read-back showed:
 *
 * - `ok` when the rule reads back with the action, destinations and enabled state it was sent, whatever the PUT
 *   answered;
 * - `refused` when the PUT threw and the rule reads back as something else, so the change is not there;
 * - `failed` otherwise: the PUT answered and the rule reads back as something else, or it could not be read back
 *   at all. The last includes a PUT whose answer was lost, which Cloudflare may have applied, so the act throws
 *   `E_ROUTING_RULE_NOT_CONFIRMED` saying so rather than re-raising the PUT's "refused" (AGENTS.md §3: an unknown
 *   outcome is never rounded down).
 */
async function putAndConfirm(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, act: "take_over" | "put_back", subject: string, path: string,
  body: { name: string; enabled: boolean; matchers: unknown[]; actions: Array<{ type: string; value?: string[] }> },
): Promise<{ action: string; destinations: string[] }> {
  const sent = body.actions[0]!;
  const expected = { action: sent.type, destinations: sent.value ?? [], enabled: body.enabled };
  /*
   * Read back even when the PUT threw: `cloudflareWrite` says "refused" for an answer that never arrived too, and
   * a PUT Cloudflare applied with its answer lost is this act done, which the read-back shows and a guess cannot.
   */
  let putError: Error | null = null;
  try {
    await cloudflarePut<unknown>(env, ctx, orgId, path, body);
  } catch (error) {
    putError = error as Error;
  }
  const back = await cloudflareGet<CloudflareRule>(env, ctx, orgId, path)
    .catch((error: Error) => ({ ok: false as const, error: error.message }));
  const now = back.ok
    ? { action: back.result.actions?.[0]?.type ?? "?", destinations: back.result.actions?.[0]?.value ?? [], enabled: back.result.enabled === true }
    : null;
  const readBackError = back.ok ? null : back.error;
  const confirmed = now !== null && JSON.stringify(now) === JSON.stringify(expected);
  const record = async (outcome: "ok" | "refused" | "failed") =>
    await auditedBatch(env, ctx, orgId, {
      action: "provider.routing_rule_read_back", outcome, actorUserId, subject,
      detail: { act, expected, readBack: now, putError: putError?.message ?? null, readBackError },
    }, (entry) => [entry]);
  if (putError !== null && now !== null && !confirmed) {
    // A record that cannot itself be written is logged, and never replaces the refusal the caller needs to see.
    await record("refused").catch(async (unrecorded: Error) => await log(env, ctx, {
      level: "error", event: "provider.routing_rule_read_back_unrecorded", orgId, message: unrecorded.message, detail: { act, subject },
    }));
    throw putError;
  }
  await record(confirmed ? "ok" : "failed");
  if (now === null) {
    throw unprocessable("E_ROUTING_RULE_NOT_CONFIRMED", {
      what: putError === null
        ? `Cloudflare accepted the change to ${subject} but it could not be read back`
        : `Cloudflare may have applied the change to ${subject}: its answer was lost, and the rule could not be read back`,
      why: putError === null ? `the read-back failed: ${readBackError}` : `the PUT: ${putError.message}; the read-back: ${readBackError}`,
      fix: `list the rules again (GET /api/provider/routing-rules) and check ${subject} in the Cloudflare dashboard (Email, Email Routing, Routing rules) before relying on it`,
    });
  }
  if (!confirmed) {
    const said = (one: typeof expected) => `${one.action}${one.destinations.length === 0 ? "" : ` → ${one.destinations.join(", ")}`}, enabled=${String(one.enabled)}`;
    throw unprocessable("E_ROUTING_RULE_NOT_CONFIRMED", {
      what: `Cloudflare accepted the change to ${subject} but it reads back as ${said(now)}, not ${said(expected)}`,
      why: "a PUT that answered 200 is not the rule; what Cloudflare now holds is what routes mail",
      fix: `list the rules again (GET /api/provider/routing-rules) and check ${subject} in the Cloudflare dashboard (Email, Email Routing, Routing rules) before relying on it`,
    });
  }
  // Equal to what was sent once confirmed, so returning `expected` instead survives a mutant; the read-back is
  // returned because it is the claim the outcome's `after` makes.
  return { action: now.action, destinations: now.destinations };
}

/**
 * The refusals a take-over needs that the listing itself decides (30 September 2026): each is a rule this Node
 * could point here and then receive nothing through, or lose a destination by, while reporting success. Pure,
 * because the listing offers by it and the act refuses by it, so the two cannot disagree. Subaddressing is not
 * here: it is a zone setting the listing does not read, so the act alone refuses it (`refuseUnserved`).
 */
function takeOverRefusal(rules: Listed[], rule: Listed): Refusal | null {
  const dashboard = "the Cloudflare dashboard (Email, Email Routing, Routing rules)";
  if (rule.catchAll || rule.to === "") {
    return {
      code: "E_ROUTING_RULE_NOT_AN_ADDRESS",
      what: `rule ${rule.id} does not match one literal address`,
      why: "this Node files mail for addresses it knows; a catch-all pointed here would have every other "
        + "address rejected as an unknown recipient",
      fix: "the catch-all is taken over from the receiving step with catchAll: true, or "
        + "`mailda provider --onboard-receiving <apex> --catch-all`; take over rules for single addresses here",
    };
  }
  // Before `ours`, which ignores `enabled`: a disabled rule naming this Worker is not "nothing to take over".
  if (!rule.enabled) {
    return {
      code: "E_ROUTING_RULE_DISABLED",
      what: `the rule for ${rule.to} is disabled`,
      why: "Cloudflare does not apply a disabled rule, and a take-over keeps enabled as it is, so this Node would "
        + "report the address taken over while nothing routes to it",
      fix: rule.ours
        ? `it already names this Node: enable it in ${dashboard}`
        : `enable it in ${dashboard} and list the rules again, or delete it there and add ${rule.to} on People`,
    };
  }
  if (rule.ours) {
    return { code: "E_ROUTING_RULE_ALREADY_OURS", what: `${rule.to} already routes to this Worker`, why: "there is nothing to take over", fix: "nothing" };
  }
  // Cloudflare documents `value` as "currently limited to a single value"; a put-back could only restore what was read.
  if (rule.destinations.length > 1) {
    return {
      code: "E_ROUTING_RULE_MANY_DESTINATIONS",
      what: `the rule for ${rule.to} ${rule.action}s to ${rule.destinations.length} destinations (${rule.destinations.join(", ")})`,
      why: "Cloudflare documents one destination per rule and has not said what it does with more, so this Node "
        + "cannot say what this rule routes today or promise a put-back restores it",
      fix: `edit it to one destination in ${dashboard}, list the rules again, and take it over then`,
    };
  }
  /*
   * "If you create more than one rule with the same email pattern, only the rule shown first in the dashboard list
   * processes incoming emails" (developers.cloudflare.com/email-service/configuration/email-routing-addresses/
   * #routing-rules). Whether the API lists in dashboard order is not documented, so neither rule is taken over:
   * the one that looks first may be the one that routes nothing.
   */
  const twins = rules.filter((one) => one.id !== rule.id && !one.catchAll && one.to === rule.to);
  if (twins.length > 0) {
    return {
      code: "E_ROUTING_RULE_DUPLICATE",
      what: `${rule.to} has ${twins.length + 1} routing rules: ${[rule, ...twins].map((one) => `${one.id} (${JSON.stringify(one.name)})`).join(", ")}`,
      why: "Cloudflare applies only the one shown first in its dashboard and the API does not say which that is, "
        + "so pointing either here may route nothing",
      fix: `delete all but one in ${dashboard}, list the rules again, and take that one over`,
    };
  }
  return null;
}

/** The take-over refusal the zone's settings decide, which the listing does not read. */
async function refuseUnserved(
  env: Env, ctx: Ctx, orgId: string, listing: RoutingRules, rule: RoutingRule,
): Promise<void> {
  /*
   * Subaddressing (developers.cloudflare.com/email-service/configuration/email-routing-addresses/#subaddressing,
   * off unless the zone's `support_subaddress` is true): with it on, `user+tag@` matches `user@`'s rule, so after
   * a take-over it reaches this Node, and ingress files by the exact address and bounces it as an unknown recipient. Before, the rule forwarded it. Refused rather than handled, because the
   * address row is also the join every read makes from a receipt's `envelope_to` to its mailbox, and teaching it
   * `+tag` is a change to ingress and those reads, not to this act. Unreadable is refused too: the setting decides.
   */
  const settings = await cloudflareGet<{ support_subaddress?: boolean } | null>(env, ctx, orgId, `/zones/${listing.zoneId}/email/routing`);
  if (!settings.ok || settings.result === null) {
    throw unprocessable("E_ROUTING_SETTINGS_UNREADABLE", {
      what: `the Email Routing settings of ${listing.zone} could not be read`,
      why: settings.ok ? "Cloudflare answered with no settings" : settings.error,
      fix: "whether subaddressing is on decides whether a take-over bounces mail; check the grant and the zone",
    });
  }
  if (settings.result.support_subaddress === true) {
    const [local, host] = rule.to.split("@");
    throw unprocessable("E_ROUTING_SUBADDRESS_UNSERVED", {
      what: `${listing.zone} has subaddressing on, so the rule for ${rule.to} also routes ${local}+anything@${host}`,
      why: "this Node files mail by the exact address it was sent to, so after a take-over mail to a +tag address "
        + "would reach it and bounce as an unknown recipient, where today the rule delivers it",
      fix: `turn subaddressing off in the Cloudflare dashboard (Email, Email Routing, Settings) and take over again, or leave the rule as it is`,
    });
  }
}

export async function takeOverRule(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string,
  domain: string, ruleId: string, digest: string, mailboxId: string | null,
): Promise<TakeoverOutcome> {
  const { listing, rule, raw } = await ruleNow(env, ctx, orgId, domain, ruleId);
  const refusal = takeOverRefusal(listing.rules, rule);
  if (refusal !== null) throw unprocessable(refusal.code, { what: refusal.what, why: refusal.why, fix: refusal.fix });
  if (digest !== rule.digest) {
    throw conflict("E_ROUTING_RULE_STALE", {
      what: "the rule confirmed is not the one this Node would now replace",
      why: "its name, matcher, action or enabled state changed since it was listed",
      fix: `list the rules again and confirm the digest shown: ${rule.digest}`,
    });
  }
  await refuseUnserved(env, ctx, orgId, listing, rule);
  const worker = workerNameFor(env);

  /*
   * The mailbox that will actually receive (30 September 2026). An address row already there, added on People or
   * left by a put-back, decides it: the insert used to be `OR IGNORE`, so the row kept its mailbox while the entry
   * recorded the one chosen. A different choice is refused by name; no choice uses the row's.
   */
  const existing = await env.CATALOG.prepare(
    "SELECT m.id, m.name FROM addresses a JOIN mailboxes m ON m.id = a.mailbox_id AND m.org_id = a.org_id "
    + "WHERE a.org_id = ? AND a.address = ?",
  ).bind(orgId, rule.to).first<{ id: string; name: string }>();
  if (existing !== null && mailboxId !== null && mailboxId !== existing.id) {
    throw unprocessable("E_ROUTING_ADDRESS_FILES_ELSEWHERE", {
      what: `${rule.to} is already an address here, filing into ${JSON.stringify(existing.name)} (${existing.id}), not ${mailboxId}`,
      why: "a take-over routes the address to this Node and leaves where it files as it is",
      fix: `take it over without a mailbox, or with ${existing.id}, and it files into ${JSON.stringify(existing.name)}`,
    });
  }
  const mailbox = existing ?? await mailboxForAddress(env, orgId, mailboxId);
  const before = { action: rule.action, destinations: rule.destinations };

  // The address first, in the same batch as the entry, so a rule that delivers finds a recipient (#92). A plain
  // INSERT: a row that appeared since the read above fails the batch rather than being recorded as this mailbox.
  await auditedBatch(env, ctx, orgId, {
    action: "provider.routing_rule_taken_over", outcome: "ok", actorUserId, subject: ruleId,
    detail: {
      zone: listing.zone, to: rule.to, name: rule.name, before, after: { action: "worker", destinations: [worker] },
      mailboxId: mailbox.id, addressExisted: existing !== null, readBackFollows: true,
    },
  }, (entry) => [
    ...(existing === null
      ? [env.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)")
        .bind(ctx.id("addr"), orgId, rule.to, mailbox.id, new Date(ctx.now()).toISOString())]
      : []),
    entry,
  ]);
  const after = await putAndConfirm(env, ctx, orgId, actorUserId, "take_over", ruleId,
    `/zones/${listing.zoneId}/email/routing/rules/${raw.id}`,
    { name: raw.name ?? "", enabled: raw.enabled === true, matchers: raw.matchers ?? [], actions: [{ type: "worker", value: [worker] }] });
  return { ruleId, to: rule.to, before, after, mailbox };
}

export async function putBackRule(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, domain: string, ruleId: string,
): Promise<TakeoverOutcome> {
  const { listing, rule, raw } = await ruleNow(env, ctx, orgId, domain, ruleId);
  /*
   * The catch-all (25 September 2026) was taken over by the receiving step, which recorded it under its own
   * action against the zone; it is written back through its own endpoint, since `/rules/{id}` is not how
   * Cloudflare addresses it. Same rules as any put-back: never taken, never restored; changed since, never
   * overwritten.
   */
  const last = await env.CATALOG.prepare(
    "SELECT detail FROM audit_entries WHERE org_id = ? AND action = ? AND subject = ? ORDER BY seq DESC LIMIT 1",
  ).bind(
    orgId,
    rule.catchAll ? "provider.catch_all_taken_over" : "provider.routing_rule_taken_over",
    rule.catchAll ? (listing.zone ?? domain) : ruleId,
  ).first<{ detail: string | null }>();
  const recorded = typeof last?.detail === "string"
    ? (JSON.parse(last.detail) as { before?: { action?: string; destinations?: string[]; enabled?: boolean } }).before
    : undefined;
  if (recorded?.action === undefined) {
    const { code, ...said } = neverTaken(ruleId);
    throw unprocessable(code, said);
  }
  if (!rule.ours) {
    throw conflict("E_ROUTING_RULE_NOT_OURS_NOW", {
      what: `${rule.to} no longer routes to this Worker (${rule.action} → ${rule.destinations.join(", ")})`,
      why: "somebody changed it since the take-over, or the take-over itself did not complete (its read-back is on "
        + "the audit trail as provider.routing_rule_read_back), and overwriting either is not a put-back",
      fix: "nothing, or edit it in the dashboard",
    });
  }
  const before = { action: rule.action, destinations: rule.destinations };
  const restore = { action: recorded.action, destinations: recorded.destinations ?? [] };
  const actions = [{ type: restore.action, ...(restore.destinations.length === 0 ? {} : { value: restore.destinations }) }];
  if (rule.catchAll) {
    const wasEnabled = recorded.enabled === true;
    await auditedBatch(env, ctx, orgId, {
      action: "provider.catch_all_put_back", outcome: "ok", actorUserId, subject: listing.zone ?? domain,
      detail: { zone: listing.zone, before: { ...before, enabled: true }, after: { ...restore, enabled: wasEnabled }, readBackFollows: true },
    }, (entry) => [entry]);
    const after = await putAndConfirm(env, ctx, orgId, actorUserId, "put_back", listing.zone ?? domain,
      `/zones/${listing.zoneId}/email/routing/rules/catch_all`,
      { name: raw.name ?? "", enabled: wasEnabled, matchers: [{ type: "all" }], actions });
    return { ruleId, to: "*", before, after, mailbox: null };
  }
  await auditedBatch(env, ctx, orgId, {
    action: "provider.routing_rule_put_back", outcome: "ok", actorUserId, subject: ruleId,
    detail: { zone: listing.zone, to: rule.to, name: rule.name, before, after: restore, readBackFollows: true },
  }, (entry) => [entry]);
  const after = await putAndConfirm(env, ctx, orgId, actorUserId, "put_back", ruleId,
    `/zones/${listing.zoneId}/email/routing/rules/${raw.id}`,
    { name: raw.name ?? "", enabled: raw.enabled === true, matchers: raw.matchers ?? [], actions });
  return { ruleId, to: rule.to, before, after, mailbox: null };
}
