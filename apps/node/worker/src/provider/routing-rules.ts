import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
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
}

export interface RoutingRules {
  domain: string;
  zone: string | null;
  zoneId: string | null;
  rules: RoutingRule[];
  error: string | null;
}

async function describe(raw: CloudflareRule, worker: string | null): Promise<RoutingRule> {
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
  return {
    domain, zone: zone.name, zoneId: zone.id, error: null,
    rules: await Promise.all(listed.result.map((one) => describe(one, worker))),
  };
}

export interface TakeoverOutcome {
  ruleId: string;
  to: string;
  /** The action the rule had, which is what a put-back restores. */
  before: { action: string; destinations: string[] };
  after: { action: string; destinations: string[] };
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

async function replaceAction(
  env: Env, ctx: Ctx, orgId: string, zoneId: string, raw: CloudflareRule,
  action: { type: string; value?: string[] },
): Promise<void> {
  await cloudflarePut(env, ctx, orgId, `/zones/${zoneId}/email/routing/rules/${raw.id}`, {
    name: raw.name ?? "", enabled: raw.enabled === true, matchers: raw.matchers ?? [], actions: [action],
  });
}

export async function takeOverRule(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string,
  domain: string, ruleId: string, digest: string, mailboxId: string | null,
): Promise<TakeoverOutcome> {
  const { listing, rule, raw } = await ruleNow(env, ctx, orgId, domain, ruleId);
  if (rule.catchAll || rule.to === "") {
    throw unprocessable("E_ROUTING_RULE_NOT_AN_ADDRESS", {
      what: `rule ${ruleId} does not match one literal address`,
      why: "this Node files mail for addresses it knows; a catch-all pointed here would have every other "
        + "address rejected as an unknown recipient",
      fix: "take over rules for single addresses, and leave the catch-all where it is",
    });
  }
  if (digest !== rule.digest) {
    throw conflict("E_ROUTING_RULE_STALE", {
      what: "the rule confirmed is not the one this Node would now replace",
      why: "its name, matcher, action or enabled state changed since it was listed",
      fix: `list the rules again and confirm the digest shown: ${rule.digest}`,
    });
  }
  if (rule.ours) {
    throw unprocessable("E_ROUTING_RULE_ALREADY_OURS", {
      what: `${rule.to} already routes to this Worker`, why: "there is nothing to take over",
      fix: "nothing",
    });
  }
  const worker = workerNameFor(env);
  const mailbox = await mailboxForAddress(env, orgId, mailboxId);
  const before = { action: rule.action, destinations: rule.destinations };
  const after = { action: "worker", destinations: [worker] };

  // The address first, in the same batch as the entry, so a rule that delivers finds a recipient (#92).
  await auditedBatch(env, ctx, orgId, {
    action: "provider.routing_rule_taken_over", outcome: "ok", actorUserId, subject: ruleId,
    detail: { zone: listing.zone, to: rule.to, name: rule.name, before, after, mailboxId: mailbox.id },
  }, (entry) => [
    env.CATALOG.prepare(
      "INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), orgId, rule.to, mailbox.id, new Date(ctx.now()).toISOString()),
    entry,
  ]);
  await replaceAction(env, ctx, orgId, listing.zoneId!, raw, { type: "worker", value: [worker] });
  return { ruleId, to: rule.to, before, after };
}

export async function putBackRule(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, domain: string, ruleId: string,
): Promise<TakeoverOutcome> {
  const { listing, rule, raw } = await ruleNow(env, ctx, orgId, domain, ruleId);
  const last = await env.CATALOG.prepare(
    "SELECT detail FROM audit_entries WHERE org_id = ? AND action = 'provider.routing_rule_taken_over' "
    + "AND subject = ? ORDER BY seq DESC LIMIT 1",
  ).bind(orgId, ruleId).first<{ detail: string | null }>();
  const recorded = typeof last?.detail === "string"
    ? (JSON.parse(last.detail) as { before?: { action?: string; destinations?: string[] } }).before
    : undefined;
  if (recorded?.action === undefined) {
    throw unprocessable("E_ROUTING_RULE_NEVER_TAKEN", {
      what: `this Node never took over rule ${ruleId}`,
      why: "a put-back restores the action the take-over recorded, and there is none",
      fix: "a rule this Node did not change is edited in the Cloudflare dashboard",
    });
  }
  if (!rule.ours) {
    throw conflict("E_ROUTING_RULE_NOT_OURS_NOW", {
      what: `${rule.to} no longer routes to this Worker (${rule.action} → ${rule.destinations.join(", ")})`,
      why: "somebody changed it since the take-over, and overwriting their change is not a put-back",
      fix: "nothing, or edit it in the dashboard",
    });
  }
  const before = { action: rule.action, destinations: rule.destinations };
  const after = { action: recorded.action, destinations: recorded.destinations ?? [] };
  await auditedBatch(env, ctx, orgId, {
    action: "provider.routing_rule_put_back", outcome: "ok", actorUserId, subject: ruleId,
    detail: { zone: listing.zone, to: rule.to, name: rule.name, before, after },
  }, (entry) => [entry]);
  await replaceAction(env, ctx, orgId, listing.zoneId!, raw, {
    type: after.action, ...(after.destinations.length === 0 ? {} : { value: after.destinations }),
  });
  return { ruleId, to: rule.to, before, after };
}
