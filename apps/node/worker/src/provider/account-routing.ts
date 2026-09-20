import type { Ctx } from "@mailda/runtime";

import { unprocessable } from "../errors.ts";
import { cloudflareGet } from "./cloudflare-api.ts";

/**
 * Which account this grant covers.
 *
 * **Measured as absent from the token response** (`oauth.token_response_names_account: 0`), so it costs a
 * call. `provider_binding.account_id` is filled from here the first time anything needs it rather than at
 * consent, which is why the column is nullable and why every surface says *not yet determined* instead of
 * showing an empty account.
 *
 * More than one account is a real answer and not an error: a person may belong to several, and a grant is
 * scoped to what they chose on the consent screen. Recorded only when there is exactly one, because writing
 * a guess into the column a deployment plan reads is worse than leaving it null.
 */
export async function resolveAccount(
  env: Env, ctx: Ctx, orgId: string,
): Promise<{ accountId: string | null; found: number; error: string | null }> {
  const answer = await cloudflareGet<Array<{ id: string; name: string }>>(
    env, ctx, orgId, "/accounts?per_page=50",
  );
  if (!answer.ok) return { accountId: null, found: 0, error: answer.error };

  const only = answer.result.length === 1 ? answer.result[0]!.id : null;
  if (only !== null) {
    await env.CATALOG.prepare("UPDATE provider_binding SET account_id = ? WHERE id = 1").bind(only).run();
  }
  return { accountId: only, found: answer.result.length, error: null };
}

/**
 * What Cloudflare says about receiving mail for one domain this Node routes (#163 L2).
 *
 * ## Why this is the read side and stops there
 *
 * #163 wants DNS and MX changes *"proposed as a diff, approved, and applied through the Node's own grant"*.
 * The diff has to come from somewhere, and inventing one from what Mailda thinks Email Routing needs would be
 * a second copy of Cloudflare's own requirements — the kind that is right the day it is written.
 *
 * Cloudflare publishes both halves: `GET /zones/{id}/email/routing` answers **whether receiving works**
 * (`enabled`, and a `status` of `ready` / `unconfigured` / `misconfigured`), and
 * `GET /zones/{id}/email/routing/dns` answers **which records it needs**. So the proposal is Cloudflare's
 * list against Cloudflare's verdict, and this Node's job is to ask and to say.
 *
 * Both need `Zone Settings Read`, which the grant carries as `zone-settings.read`. Nothing here writes.
 *
 * ## The zone is not the domain, and finding it is most of the work
 *
 * This Node routes `inbox@mailda-test.whymelabs.com`. There is no zone of that name — the zone is
 * `whymelabs.com`, and the address lives on a subdomain of it. So the search walks up the labels until a zone
 * answers, which is what a person does by eye and what nothing in the address itself reveals.
 *
 * It stops at two labels. A single label is a public suffix rather than a zone anybody owns, and asking
 * Cloudflare for `com` would be a request whose only possible answers are wrong.
 */
export interface RoutingState {
  domain: string;
  /** The zone that turned out to carry it, which is often a parent of the domain. */
  zone: string | null;
  zoneId: string | null;
  enabled: boolean | null;
  /** Cloudflare's own word: `ready`, `unconfigured`, `misconfigured`, or another it may add. */
  status: string | null;
  /** The records Cloudflare says this zone needs, as it describes them. */
  required: Array<{ type: string; name: string; content: string; priority: number | null }>;
  /** Why this domain could not be answered for. Null when it could. */
  error: string | null;
}

/**
 * The Cloudflare account this Node is bound to, which is the boundary every other read is kept inside.
 *
 * Null is **not** "search everywhere" — it is a refusal, and the only caller that treats it otherwise would
 * be a bug. `resolveAccount` fills it, and deliberately leaves it null when a grant covers more than one
 * account, which its own comment calls *"a real answer and not an error"*.
 */
export async function boundAccount(env: Env): Promise<string | null> {
  const row = await env.CATALOG.prepare(
    "SELECT account_id FROM provider_binding WHERE id = 1",
  ).first<{ account_id: string | null }>();
  return row?.account_id ?? null;
}

/**
 * The bound account, or a refusal — for callers that have no honest answer without one.
 *
 * `boundAccount` answers null and lets the caller decide; this is the other half, for the registrar reads
 * where a null would mean *ask Cloudflare about no account in particular*. Separate rather than a flag,
 * because the two behaviours are different enough that a boolean would hide which one a call site meant.
 */
export async function boundAccountFor(env: Env): Promise<string> {
  const accountId = await boundAccount(env);
  if (accountId === null) {
    throw unprocessable("E_PROVIDER_NO_ACCOUNT", {
      what: "this Node has not determined which Cloudflare account it is bound to",
      why: "a grant covering more than one account records none, and asking the registry on behalf of an "
        + "unspecified account is a question with no answer",
      fix: "POST /api/provider/resolve-account",
    });
  }
  return accountId;
}

/** What every surface says when the boundary is not known, so the sentence cannot drift between them. */
export const NO_BOUND_ACCOUNT =
  "this Node has not determined its Cloudflare account yet — POST /api/provider/resolve-account";

/**
 * The zone carrying a domain, which is usually a **parent** of it — **within this Node's own account**.
 *
 * ## The account filter is the isolation boundary, and it was missing (#165)
 *
 * `GET /zones?name=x` returns zones from **every account the grant can see**, not from one. Measured: a
 * token on this machine sees fifteen zones across four accounts, one of them a client's. So a Node whose
 * grant spans two accounts would resolve a name in either, and the walk would happily hand back somebody
 * else's zone — after which `emailRoutingFor` reports their routing, `sendingProposalFor` proposes against
 * their DNS, and `onboardSending` **writes records into a zone this Node is not bound to**.
 *
 * The grant on the live Node covers one account, so nothing was ever wrong there. That is an accident of one
 * consent rather than a property of this code, which is exactly the kind of safety #165 asks to be proven
 * rather than observed: `test/provider-isolation.test.ts` removes this filter and watches a test fail.
 *
 * A null `account_id` **refuses**. It is the multi-account case — `resolveAccount` records nothing when a
 * grant covers several — and searching all of them is the hole itself rather than a fallback.
 *
 * ## The walk
 *
 * Longest first: a subdomain that *is* its own zone must be found as itself rather than as its parent,
 * because both Email Routing and Email Sending are configured per zone and the two would report different
 * states. It stops at two labels — a single label is a public suffix rather than a zone anybody owns, and
 * asking Cloudflare for `com` is a request whose every possible answer is wrong.
 *
 * Shared by the receiving read and the sending one because they resolve the *same* zone, and two copies of
 * this walk would be two places for the stopping rule — or the account filter — to drift.
 */
export async function zoneFor(
  env: Env, ctx: Ctx, orgId: string, domain: string,
): Promise<{ ok: true; zone: { id: string; name: string } | null } | { ok: false; error: string }> {
  const accountId = await boundAccount(env);
  if (accountId === null) return { ok: false, error: NO_BOUND_ACCOUNT };

  const labels = domain.split(".");
  for (let at = 0; at + 2 <= labels.length; at++) {
    const candidate = labels.slice(at).join(".");
    const found = await cloudflareGet<Array<{ id: string; name: string }>>(
      env, ctx, orgId,
      `/zones?name=${encodeURIComponent(candidate)}&account.id=${encodeURIComponent(accountId)}`,
    );
    if (!found.ok) return { ok: false, error: found.error };
    const zone = found.result[0];
    if (zone !== undefined) return { ok: true, zone };
  }
  return { ok: true, zone: null };
}

export async function emailRoutingFor(
  env: Env, ctx: Ctx, orgId: string, domain: string,
): Promise<RoutingState> {
  const blank: RoutingState = {
    domain, zone: null, zoneId: null, enabled: null, status: null, required: [], error: null,
  };

  const carrying = await zoneFor(env, ctx, orgId, domain);
  if (!carrying.ok) return { ...blank, error: carrying.error };
  if (carrying.zone === null) return { ...blank, error: `no zone in this account carries ${domain}` };
  const zone = carrying.zone;

  {
    const settings = await cloudflareGet<{ enabled?: boolean; status?: string }>(
      env, ctx, orgId, `/zones/${zone.id}/email/routing`,
    );
    if (!settings.ok) {
      return { ...blank, zone: zone.name, zoneId: zone.id, error: settings.error };
    }

    const dns = await cloudflareGet<Array<{
      type?: string; name?: string; content?: string; priority?: number;
    }>>(env, ctx, orgId, `/zones/${zone.id}/email/routing/dns`);

    return {
      domain,
      zone: zone.name,
      zoneId: zone.id,
      enabled: settings.result.enabled ?? null,
      status: settings.result.status ?? null,
      /*
       * An unreadable record list is **not** an empty one. Empty means Cloudflare says this zone needs
       * nothing; unreadable means nobody knows, and a proposal built from the second would tell an operator
       * their DNS is complete because a request failed.
       */
      required: dns.ok
        ? dns.result.map((one) => ({
          type: one.type ?? "?",
          name: one.name ?? "?",
          content: one.content ?? "?",
          priority: one.priority ?? null,
        }))
        : [],
      error: dns.ok ? null : dns.error,
    };
  }
}

/** Every domain this Node accepts mail for, and what Cloudflare says about each. */
export async function emailRoutingState(
  env: Env, ctx: Ctx, orgId: string,
): Promise<RoutingState[]> {
  const rows = await env.CATALOG.prepare(
    /*
     * The domains this Node **actually routes**, from its own addresses rather than from configuration. A
     * list read from config would describe what somebody intended; this describes what mail is expected at.
     */
    "SELECT DISTINCT substr(address, instr(address, '@') + 1) AS domain FROM addresses WHERE org_id = ?",
  ).bind(orgId).all<{ domain: string }>();

  const seen: RoutingState[] = [];
  for (const row of rows.results) {
    seen.push(await emailRoutingFor(env, ctx, orgId, row.domain));
  }
  return seen;
}
