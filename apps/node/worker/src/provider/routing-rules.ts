import { type RecordedAction, recordedInName, takenOverName } from "@mailda/contract/routing-rule-name";
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
  /**
   * What pointing the rule here changes, in the words every channel shows (1 October 2026): the setup step, the
   * Setup screen and `mailda provider --routing-rules` print these rather than each keeping its own table, so they
   * cannot disagree. Null unless `offer` is `take_over`.
   */
  takeOver: TakeOverOffer | null;
}

/** The one choice besides leaving the rule as it is, and what taking it changes. */
export interface TakeOverOffer {
  label: string;
  says: string;
  /** The mailbox an address row already there files into, which a take-over keeps. */
  filesInto: { id: string; name: string } | null;
  /**
   * A forward rule's address is somebody's mail going to their own inbox, so it files only into a mailbox chosen
   * for it (`E_ROUTING_FORWARD_NEEDS_MAILBOX`), never into the only one by default. False once an address row
   * decides it.
   */
  asksMailbox: boolean;
}

/**
 * What taking a rule over changes, by what it does today. Closed over Cloudflare's three actions (AGENTS.md §2c,
 * rung 1): a rule with any other action is refused (`E_ROUTING_RULE_ACTION_UNKNOWN`), since what it does, and so
 * what stops, cannot be said.
 */
const TAKE_OVER: Record<"forward" | "worker" | "drop", (rule: Listed) => { label: string; says: string }> = {
  forward: (rule) => ({
    label: "receive here only",
    says: `${rule.destinations[0]} gets nothing more for ${rule.to}: it is stored here instead, and replies sent `
      + `from ${rule.destinations[0]} are not seen here`,
  }),
  worker: (rule) => {
    const earlier = earlierRecord(rule);
    return {
      label: "receive here",
      says: `${rule.destinations[0]} stops receiving mail for ${rule.to}, and this Node cannot see what `
        + `${rule.destinations[0]} did with it: if it forwarded or answered, that stops too`
        + (earlier === null ? "" : `. The rule was itself taken over by ${rule.destinations[0]}: its name records that it `
          + `was ${saidAction(earlier)}, and that record is kept`),
    };
  },
  drop: (rule) => ({ label: "receive here", says: `mail Cloudflare was discarding for ${rule.to} is kept from now on` }),
};
const isKnownAction = (action: string): action is keyof typeof TAKE_OVER => Object.hasOwn(TAKE_OVER, action);

/**
 * The record an earlier take-over wrote into the rule's name, when the rule still routes to the Worker that wrote it
 * (review, 1 October 2026). Another Node's take-over, or this Worker's with its audit trail gone: either way the
 * name is the only record of what the address did before any Node, so a take-over carries it forward rather than
 * record "was worker <that Node>", and a put-back with no audit entry restores from it.
 */
function earlierRecord(rule: Pick<Listed, "name" | "action" | "destinations">): RecordedAction | null {
  const recorded = recordedInName(rule.name);
  if (recorded === null || rule.action !== "worker" || !rule.destinations.includes(recorded.worker)) return null;
  return { action: recorded.action, destinations: recorded.destinations };
}

const saidAction = (one: RecordedAction) => `${one.action}${one.destinations.length === 0 ? "" : ` ${one.destinations.join(", ")}`}`;

/** A named refusal, as the act would throw it. */
export interface Refusal { code: string; what: string; why: string; fix: string }

type Listed = Omit<RoutingRule, "offer" | "refusal" | "takeOver">;

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
  const settings = await zoneSettings(env, ctx, orgId, zone.id);
  // Where each address already files, since a take-over keeps an address row's mailbox: one read for the listing.
  const { results: rows } = await env.CATALOG.prepare(
    "SELECT a.address, m.id, m.name FROM addresses a JOIN mailboxes m ON m.id = a.mailbox_id AND m.org_id = a.org_id "
    + "WHERE a.org_id = ?",
  ).bind(orgId).all<{ address: string; id: string; name: string }>();
  const filing = new Map(rows.map((one) => [one.address, { id: one.id, name: one.name }]));
  return {
    domain, zone: zone.name, zoneId: zone.id, error: null,
    rules: rules.map((rule) => {
      if (rule.ours) {
        // The audit entry, or the name's record when that is gone (a reinstalled Node): either restores the action.
        const refusal = taken.has(takenKey(rule, zone.name)) || earlierRecord(rule) !== null ? null : neverTaken(rule.id);
        return { ...rule, offer: refusal === null ? "put_back" as const : null, refusal, takeOver: null };
      }
      const refusal = takeOverRefusal(rules, rule, zone.name, settings);
      if (refusal !== null || !isKnownAction(rule.action)) return { ...rule, offer: null, refusal, takeOver: null };
      const filesInto = filing.get(rule.to) ?? null;
      return {
        ...rule, offer: "take_over" as const, refusal,
        takeOver: { ...TAKE_OVER[rule.action](rule), filesInto, asksMailbox: rule.action === "forward" && filesInto === null },
      };
    }),
  };
}

/** Whether the zone has subaddressing on, or why that could not be read; a take-over depends on it. */
type ZoneSettings = { ok: true; subaddress: boolean } | { ok: false; error: string };

async function zoneSettings(env: Env, ctx: Ctx, orgId: string, zoneId: string): Promise<ZoneSettings> {
  const read = await cloudflareGet<{ support_subaddress?: boolean } | null>(env, ctx, orgId, `/zones/${zoneId}/email/routing`);
  if (!read.ok) return { ok: false, error: read.error };
  if (read.result === null) return { ok: false, error: "Cloudflare answered with no settings" };
  return { ok: true, subaddress: read.result.support_subaddress === true };
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
  /**
   * Whether the rule read back with the name the take-over wrote into it (critic H1): false means Cloudflare kept or
   * cut the name, so `--without-node` cannot restore the rule and only this Node's put-back can. Null on a put-back.
   */
  nameRecorded: boolean | null;
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
): Promise<{ action: string; destinations: string[]; name: string }> {
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
  return { action: now.action, destinations: now.destinations, name: back.ok ? back.result.name ?? "" : "" };
}

/**
 * The refusals a take-over needs (30 September 2026): each is a rule this Node could point here and then receive
 * nothing through, or lose a destination by, while reporting success. Pure, because the listing offers by it and
 * the act refuses by it, so the two cannot disagree. The zone's subaddressing setting is read with the listing
 * (1 October 2026) and decided here too: it used to be read by the act alone, so the setup step offered a rule
 * the act then refused.
 */
function takeOverRefusal(rules: Listed[], rule: Listed, zone: string, settings: ZoneSettings): Refusal | null {
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
  if (!isKnownAction(rule.action)) {
    return {
      code: "E_ROUTING_RULE_ACTION_UNKNOWN",
      what: `the rule for ${rule.to} has the action ${JSON.stringify(rule.action)}`,
      why: "this Node knows forward, worker and drop, and cannot say what a take-over of any other action stops",
      fix: `leave it, or change it in ${dashboard} and list the rules again`,
    };
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
  /*
   * Subaddressing (developers.cloudflare.com/email-service/configuration/email-routing-addresses/#subaddressing,
   * off unless the zone's `support_subaddress` is true): with it on, `user+tag@` matches `user@`'s rule, so after
   * a take-over it reaches this Node, and ingress files by the exact address and bounces it as an unknown
   * recipient. Before, the rule forwarded it. Refused rather than handled, because the address row is also the
   * join every read makes from a receipt's `envelope_to` to its mailbox, and teaching it `+tag` is a change to
   * ingress and those reads, not to this act. Unreadable is refused too: the setting decides.
   */
  if (!settings.ok) {
    return {
      code: "E_ROUTING_SETTINGS_UNREADABLE",
      what: `the Email Routing settings of ${zone} could not be read`,
      why: settings.error,
      fix: "whether subaddressing is on decides whether a take-over bounces mail; check the grant and the zone",
    };
  }
  if (settings.subaddress) {
    const [local, host] = rule.to.split("@");
    return {
      code: "E_ROUTING_SUBADDRESS_UNSERVED",
      what: `${zone} has subaddressing on, so the rule for ${rule.to} also routes ${local}+anything@${host}`,
      why: "this Node files mail by the exact address it was sent to, so after a take-over mail to a +tag address "
        + "would reach it and bounce as an unknown recipient, where today the rule delivers it",
      fix: `turn subaddressing off in the Cloudflare dashboard (Email, Email Routing, Settings) and take over again, or leave the rule as it is`,
    };
  }
  return null;
}

export async function takeOverRule(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string,
  domain: string, ruleId: string, digest: string, mailboxId: string | null,
): Promise<TakeoverOutcome> {
  const { listing, rule, raw } = await ruleNow(env, ctx, orgId, domain, ruleId);
  const refusal = takeOverRefusal(listing.rules, rule, listing.zone ?? domain, await zoneSettings(env, ctx, orgId, listing.zoneId!));
  if (refusal !== null) throw unprocessable(refusal.code, { what: refusal.what, why: refusal.why, fix: refusal.fix });
  if (digest !== rule.digest) {
    throw conflict("E_ROUTING_RULE_STALE", {
      what: "the rule confirmed is not the one this Node would now replace",
      why: "its name, matcher, action or enabled state changed since it was listed",
      fix: `list the rules again and confirm the digest shown: ${rule.digest}`,
    });
  }
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
  /*
   * A forward rule is somebody's mail on its way to their own inbox (critic M4, 1 October 2026). Filed into the
   * organization's only mailbox by default, it would be read by whoever reads that mailbox, with nothing but the
   * take-over on the audit trail to say so. So it files only into a mailbox chosen for it.
   */
  if (existing === null && mailboxId === null && rule.action === "forward") {
    throw unprocessable("E_ROUTING_FORWARD_NEEDS_MAILBOX", {
      what: `the rule for ${rule.to} forwards to ${rule.destinations.join(", ")}, and no mailbox was chosen for it`,
      why: "a forwarded address is usually one person's mail, and filing it into a mailbox by default hands it to "
        + "everyone who reads that mailbox",
      fix: "choose the mailbox it files into (mailboxId, or `--mailbox` on `mailda provider --take-over`); a new "
        + "mailbox for it is made with POST /api/mailboxes",
    });
  }
  const mailbox = existing ?? await mailboxForAddress(env, orgId, mailboxId);
  const before = { action: rule.action, destinations: rule.destinations };
  /*
   * The action it had goes into the rule's own name as well as the audit entry (critic H1, 1 October 2026): the
   * entry is on this Node, and a Node that is deleted takes it along, leaving a rule that names a Worker that is
   * gone and nothing anywhere saying where the address used to go. Cloudflare keeps the name.
   */
  const name = takenOverName(worker, earlierRecord(rule) ?? before, new Date(ctx.now()));

  // The address first, in the same batch as the entry, so a rule that delivers finds a recipient (#92). A plain
  // INSERT: a row that appeared since the read above fails the batch rather than being recorded as this mailbox.
  await auditedBatch(env, ctx, orgId, {
    action: "provider.routing_rule_taken_over", outcome: "ok", actorUserId, subject: ruleId,
    detail: {
      zone: listing.zone, to: rule.to, name: rule.name, nameWritten: name, before, after: { action: "worker", destinations: [worker] },
      mailboxId: mailbox.id, addressExisted: existing !== null, readBackFollows: true,
    },
  }, (entry) => [
    ...(existing === null
      ? [env.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)")
        .bind(ctx.id("addr"), orgId, rule.to, mailbox.id, new Date(ctx.now()).toISOString())]
      : []),
    entry,
  ]);
  const { name: nameNow, ...after } = await putAndConfirm(env, ctx, orgId, actorUserId, "take_over", ruleId,
    `/zones/${listing.zoneId}/email/routing/rules/${raw.id}`,
    { name, enabled: raw.enabled === true, matchers: raw.matchers ?? [], actions: [{ type: "worker", value: [worker] }] });
  return { ruleId, to: rule.to, before, after, mailbox, nameRecorded: nameNow === name };
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
  const detail = typeof last?.detail === "string"
    ? JSON.parse(last.detail) as { name?: string; before?: { action?: string; destinations?: string[]; enabled?: boolean } }
    : undefined;
  // With no entry (a reinstalled Node, or its audit rows gone), the rule's name, when it records a take-over by the
  // Worker it routes to: what `--without-node` restores from, done by the Node so the entry is written. Only for a
  // rule routed here; without `rule.ours` another Worker's rule would still be refused, as NOT_OURS_NOW ("no longer
  // routes to this Worker") instead of the truer NEVER_TAKEN, so no test fails on it (a known mutant survivor).
  const fromName = detail?.before?.action === undefined && rule.ours ? earlierRecord(rule) : null;
  const recorded = fromName ?? detail?.before;
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
    const wasEnabled = detail?.before?.enabled === true;
    await auditedBatch(env, ctx, orgId, {
      action: "provider.catch_all_put_back", outcome: "ok", actorUserId, subject: listing.zone ?? domain,
      detail: { zone: listing.zone, before: { ...before, enabled: true }, after: { ...restore, enabled: wasEnabled }, readBackFollows: true },
    }, (entry) => [entry]);
    const after = await putAndConfirm(env, ctx, orgId, actorUserId, "put_back", listing.zone ?? domain,
      `/zones/${listing.zoneId}/email/routing/rules/catch_all`,
      { name: raw.name ?? "", enabled: wasEnabled, matchers: [{ type: "all" }], actions });
    return { ruleId, to: "*", before, after: { action: after.action, destinations: after.destinations }, mailbox: null, nameRecorded: null };
  }
  /*
   * The name the rule had before the take-over wrote its record into it, while that record is still the name: a
   * rule renamed since keeps the name it was given. An entry from before 1 October 2026 recorded the name the take-over
   * left as it was, so restoring it changes nothing.
   */
  const name = recordedInName(raw.name ?? "") === null ? raw.name ?? "" : fromName === null && typeof detail?.name === "string" ? detail.name : "";
  await auditedBatch(env, ctx, orgId, {
    action: "provider.routing_rule_put_back", outcome: "ok", actorUserId, subject: ruleId,
    detail: {
      zone: listing.zone, to: rule.to, name: rule.name, nameRestored: name, before, after: restore,
      restoredFrom: fromName === null ? "audit" : "name", readBackFollows: true,
    },
  }, (entry) => [entry]);
  const { name: _nameNow, ...after } = await putAndConfirm(env, ctx, orgId, actorUserId, "put_back", ruleId,
    `/zones/${listing.zoneId}/email/routing/rules/${raw.id}`,
    { name, enabled: raw.enabled === true, matchers: raw.matchers ?? [], actions });
  return { ruleId, to: rule.to, before, after, mailbox: null, nameRecorded: null };
}
