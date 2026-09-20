import type { Ctx } from "@mailda/runtime";

import { boundAccount } from "./account-routing.ts";
import { cloudflareGet } from "./cloudflare-api.ts";
import { providerStatus } from "./grant-oauth.ts";

export type OwnershipSource = "provider" | "node" | "structural" | "unreadable";

export interface OwnershipFact {
  /** What is being answered, in the words #165 asks for. */
  question: string;
  /** The answer, or null when there is none to give. */
  answer: string | null;
  source: OwnershipSource;
  /** Why this source and not a better one — present exactly when the source is not `provider`. */
  because: string | null;
}

/**
 * Cloudflare's account `type`, which is the one field that can contradict the ownership claim.
 *
 * #108 is emphatic: *"`tenant_managed` must never be labelled customer-owned. Ownership is a factual
 * relationship, not a pricing-plan name."* A tenant-managed account is one a reseller holds on somebody's
 * behalf, and a Node inside one is **not** in a customer-owned account however the product describes itself.
 *
 * So the claim is derived from what Cloudflare says rather than asserted, and anything that is not plainly a
 * standard or enterprise account is reported as unrecognised rather than waved through — a new `type` string
 * must not default to *customer-owned*.
 */
function ownershipModelOf(type: string | null): string {
  if (type === null) return "unknown — Cloudflare did not name this account's type";
  if (type === "standard" || type === "enterprise") {
    return `customer-owned (Cloudflare account type \`${type}\`)`;
  }
  return `NOT customer-owned — Cloudflare calls this account \`${type}\`, which is not an account the `
    + `customer holds directly`;
}

export async function ownershipFacts(
  env: Env, ctx: Ctx, orgId: string,
): Promise<OwnershipFact[]> {
  const facts: OwnershipFact[] = [];
  const say = (
    question: string, answer: string | null, source: OwnershipSource, because: string | null = null,
  ) => facts.push({ question, answer, source, because });

  const status = await providerStatus(env);
  const accountId = await boundAccount(env);

  if (accountId === null) {
    say("Which Cloudflare account holds this Node", null, "node",
      `this Node has not determined it — provider state is \`${status.state}\`. Nothing below could be `
      + "read from Cloudflare, so nothing below is reported as if it had been");
    return facts;
  }

  const account = await cloudflareGet<{
    id?: string; name?: string; type?: string; created_on?: string;
    settings?: { enforce_twofactor?: boolean; oauth_app_access_enabled?: boolean };
  }>(env, ctx, orgId, `/accounts/${accountId}`);

  if (!account.ok) {
    say("Which Cloudflare account holds this Node", accountId, "node",
      `Cloudflare could not be read: ${account.error}. This is the id this Node recorded, which is not the `
      + "same as the account confirming it");
    return facts;
  }
  const it = account.result;

  say("Which Cloudflare account holds this Node", `${it.name ?? "unnamed"} (${it.id ?? accountId})`,
    "provider");
  say("What the ownership model actually is", ownershipModelOf(it.type ?? null), "provider");
  say("When the account was created", it.created_on ?? null, "provider");
  say("Does the account require two-factor authentication",
    it.settings?.enforce_twofactor === true ? "yes" : "no", "provider");
  /*
   * The setting whose absence produces `account_not_selectable`, readable here for the first time. It does
   * **not** make that state observable: it is unreadable precisely when no grant exists for the account, and
   * this read needs one. What it does answer is whether the account this Node *did* connect still permits
   * OAuth apps — which is the thing that would stop a re-consent after a revocation.
   */
  say("Does the account still permit OAuth apps to be authorized",
    it.settings?.oauth_app_access_enabled === true ? "yes" : "no", "provider");

  say("Who pays for it", null, "unreadable",
    "`/accounts/{id}/subscriptions` answers 403 on this grant, which carries no billing scope. Named here "
    + "rather than omitted, because a page that leaves out what it cannot see is a page whose completeness "
    + "is a claim");

  say("Which OAuth client this Node uses", status.clientId, "node",
    "the client is registered by an administrator in Cloudflare's dashboard and named to this Node; "
    + "Cloudflare does not tell a client about itself");
  say("What the account permitted this Node to do",
    status.scopesGranted === null ? null : status.scopesGranted.join(", "), "node",
    "the scopes Cloudflare returned with the grant. What it permits *now* would need a call this grant "
    + "cannot make");
  say("When consent was given", status.grantedAt, "node",
    "Cloudflare's callback carries no identity for the person who consented — they did so in Cloudflare's "
    + "own session. Who *started* the authorization is on the `provider_authorizations` row");

  say("What Mailda holds that could reach this account", "nothing", "structural",
    "ADR 42: the Node is its own private OAuth client, authorizable only by members of the account that "
    + "created it. No Mailda-operated service holds a Cloudflare grant at any point, so disconnecting "
    + "Mailda cannot remove an access it never had");
  say("What revoking this grant would stop", "changing infrastructure, and nothing else", "structural",
    "drilled on 10 September 2026 and held closed by `test/node/provider-blast-radius.test.ts`: only "
    + "`doctor.ts` and `index.ts` may reach the grant at all, so mail, users, Butlers, schedules, API, CLI, "
    + "backup and recovery cannot depend on it");
  say("Which implementation partner holds an operator grant", "none — the capability does not exist yet",
    "structural",
    "#165 asks for this revocation to be drilled. There is nothing to revoke: no partner grant is issued by "
    + "this Node today. Reported by name rather than omitted, so an absent feature does not read as an "
    + "empty list");

  return facts;
}
