import type { Ctx } from "@mailda/runtime";

import { boundAccount } from "./account-routing.ts";
import { cloudflareGet } from "./cloudflare-api.ts";
import { providerStatus } from "./credential.ts";

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
  const accountId = await boundAccount(env, ctx);

  if (accountId === null) {
    say("Which Cloudflare account holds this Node", null, "node",
      `this Node has not determined it — provider state is \`${status.state}\`. Nothing below could be `
      + "read from Cloudflare, so nothing below is reported as if it had been");
    return facts;
  }

  const account = await cloudflareGet<{
    id?: string; name?: string; type?: string; created_on?: string;
    settings?: { enforce_twofactor?: boolean };
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
  say("Who pays for it", null, "unreadable",
    "`/accounts/{id}/subscriptions` answers 403 on this token, which carries no billing permission. Named here "
    + "rather than omitted, because a page that leaves out what it cannot see is a page whose completeness "
    + "is a claim");

  say("When this Node was given its token", status.registeredAt, "node",
    "the API token an administrator registered here (`PUT /api/provider/token`). What it permits *now* is "
    + "in Cloudflare's token list, which the token cannot read about itself");
  say("When Cloudflare last confirmed the token active", status.verifiedAt, "node",
    "`GET /user/tokens/verify`, asked at registration");

  say("What Mailda holds that could reach this account", "nothing", "structural",
    "ADR 42: the credential is an API token an administrator of this account made and gave to this Node. "
    + "No Mailda-operated service holds a Cloudflare credential at any point, so disconnecting "
    + "Mailda cannot remove an access it never had");
  say("What revoking this token would stop", "changing infrastructure, and nothing else", "structural",
    "drilled on 10 September 2026 and held closed by `test/node/provider-blast-radius.test.ts`: only "
    + "`doctor.ts` and `index.ts` may reach the token at all, so mail, users, Butlers, schedules, API, CLI, "
    + "backup and recovery cannot depend on it");
  say("Which implementation partner holds an operator grant", "none — the capability does not exist yet",
    "structural",
    "#165 asks for this revocation to be drilled. There is nothing to revoke: no partner grant is issued by "
    + "this Node today. Reported by name rather than omitted, so an absent feature does not read as an "
    + "empty list");

  return facts;
}
