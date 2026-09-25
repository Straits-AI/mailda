import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { wrapCredential } from "../auth/kek.ts";
import { conflict, unprocessable } from "../errors.ts";

/**
 * The Node's own Cloudflare credential: an API token an administrator made, held wrapped (ADR 42 as
 * reopened on 26 September 2026, ADR 28).
 *
 * ## What replaced what
 *
 * Until today this was a private OAuth client: a client id and secret registered in the dashboard, a consent
 * with PKCE and a state nonce, an access token renewed hourly from a refresh token, and five states to say
 * where in that an operator was. The token replaces all of it. Both cost the operator one act in Cloudflare's
 * dashboard; the token has no state machine, no renewal, no client and no callback, and the dashboard's
 * token list is its one revocation list. The Node already holds its sending token this way
 * (`PUT /api/transport`), so this is a second row of a shape that exists.
 *
 * ## Optional, and why
 *
 * `mailda install` sets receiving, sending and delivery events up with wrangler's login, sent on each request
 * in two headers and never stored (`cloudflare-api.ts`, `OperatorAuthority`). A Node that was installed that
 * way and never changes its Cloudflare setup from the browser never needs this token. It exists so the Setup
 * screen can do later what the install did once.
 *
 * ## What registration verifies, and what it does not
 *
 * `GET /user/tokens/verify` says whether the token is active. `GET /accounts` says which accounts it can
 * see, and the Node binds the one — or the one the caller named among several. Neither call says which
 * **permissions** the token carries: Cloudflare's verify endpoint reports status and expiry only. So a token
 * missing `Zone Settings: Edit` registers fine and is refused by Cloudflare at the first write that needs it,
 * in Cloudflare's words, through `cloudflareWrite`'s error path. `PROVIDER_NOTE` says so on the surface.
 */

/**
 * The permissions to tick in Cloudflare's token form, each with why this Node asks for it.
 *
 * Names are the dashboard's, `<group>: <verb>`, not the OAuth `<group>.<verb>` scopes they replaced. The
 * mapping was measured on 24–25 September 2026 with wrangler's login, which carries these as scopes
 * (`docs/receipts/wrangler-login-reach.md`), and each `why` is the endpoint it authorizes.
 * `test/node/cloudflare-reach-world.test.ts` holds the arithmetic: a permission that authorizes nothing, or
 * an endpoint no permission covers, fails there.
 */
export const REQUIRED_PERMISSIONS = [
  {
    name: "Account Settings: Read",
    scope: "account",
    why: "the account's plan. ADR 25 requires Workers Paid, and a Node that cannot read the plan cannot say "
      + "why a deploy will fail before it fails",
    optional: false,
  },
  {
    name: "Zone: Read",
    scope: "zone",
    why: "which zone would carry mail, and whether a name collides before anything creates one",
    optional: false,
  },
  {
    name: "Zone Settings: Edit",
    scope: "zone",
    why: "the zone's own configuration: whether it can carry mail at all, and turning that on when an "
      + "operator asks. Read would answer the first and leave the second in a dashboard",
    optional: false,
  },
  {
    name: "Email Routing Rules: Edit",
    scope: "zone",
    why: "the routing rule that sends an address's mail to this Worker. Without it the records receiving "
      + "needs can be written and nothing arrives — measured, on a restore drill",
    optional: false,
  },
  {
    name: "Queues: Edit",
    scope: "account",
    why: "the `email.sending` event subscription that makes a send's outcome reach this Node, and the queue "
      + "and consumers it reads to say whether one would. Read was measured refused for creating the "
      + "subscription; this Node writes nothing else through Queues",
    optional: false,
  },
  {
    name: "Email Sending: Edit",
    scope: "account",
    why: "onboarding a domain for sending, and reading which are onboarded. Cloudflare publishes no "
      + "permission name for these endpoints; in the token form it is the group whose name contains "
      + "\"Email Sending\"",
    optional: false,
  },
  {
    name: "Registrar Domains: Read",
    scope: "account",
    why: "what a domain costs and whether it can be registered, read at the moment somebody is deciding "
      + "rather than from a cached search. Only for buying a domain from this Node; leave it out otherwise",
    optional: true,
  },
] as const;

export type Permission = { name: string; scope: "account" | "zone"; why: string; optional: boolean };

/** What the surface says beside the list, so no screen or verb has to paraphrase what is unverified. */
export const PROVIDER_NOTE =
  "Restrict the token to this account and, if you like, give it an expiry. This Node checks that the token "
  + "is active and which account it sees; Cloudflare's verify endpoint does not report permissions, so a "
  + "missing one shows up as Cloudflare's own refusal at the first act that needs it.";

export type ProviderState = "no_token" | "token_held";
export const PROVIDER_STATES: readonly ProviderState[] = ["no_token", "token_held"] as const;

/** What `GET /api/provider` says. Read from a column list holding no secret: the token is never selected. */
export interface ProviderStatus {
  state: ProviderState;
  accountId: string | null;
  accountName: string | null;
  registeredAt: string | null;
  verifiedAt: string | null;
}

export const STATUS_COLUMNS = "account_id, account_name, registered_at, verified_at";

export async function providerStatus(env: Env): Promise<ProviderStatus> {
  const row = await env.CATALOG.prepare(
    `SELECT ${STATUS_COLUMNS} FROM provider_token WHERE id = 1`,
  ).first<{ account_id: string; account_name: string | null; registered_at: string; verified_at: string }>()
    // A Node from before migration 0066 has no table; that is `no_token`, not an error.
    .catch(() => null);
  if (row === null) {
    return { state: "no_token", accountId: null, accountName: null, registeredAt: null, verifiedAt: null };
  }
  return {
    state: "token_held", accountId: row.account_id, accountName: row.account_name,
    registeredAt: row.registered_at, verifiedAt: row.verified_at,
  };
}

const API = "https://api.cloudflare.com/client/v4";

async function ask<T>(token: string, path: string): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  }).catch(() => null);
  if (response === null) return { ok: false, error: "the Cloudflare API could not be reached" };
  const body = (await response.json().catch(() => ({}))) as {
    success?: boolean; result?: T; errors?: Array<{ message?: string; code?: number }>;
  };
  if (response.ok && body.success === true && body.result !== undefined) return { ok: true, result: body.result };
  const said = (body.errors ?? []).map((one) => `${one.code ?? "?"} ${one.message ?? ""}`.trim()).join("; ");
  return { ok: false, error: said === "" ? `http_${response.status}` : said };
}

/**
 * Verifies a token, binds it to the one account it can see, and stores it wrapped.
 *
 * Two reads with the token before anything is written, and the token is stored only after both answered:
 * a stored token that verify had refused would be a `token_held` state that can do nothing, which is the
 * confusion the old five states existed to avoid and the new two must not reintroduce.
 */
export async function registerToken(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string,
  input: { token: string; accountId?: string },
): Promise<ProviderStatus> {
  const verified = await ask<{ id?: string; status?: string }>(input.token, "/user/tokens/verify");
  if (!verified.ok || verified.result.status !== "active") {
    throw unprocessable("E_PROVIDER_TOKEN_INVALID", {
      what: verified.ok
        ? `Cloudflare reports the token as ${verified.result.status ?? "of unknown status"}, not active`
        : `Cloudflare did not accept the token: ${verified.error}`,
      why: "a token that is not active cannot act, and storing it would report this Node as connected "
        + "while every act refused",
      fix: "create a token at https://dash.cloudflare.com/profile/api-tokens with the permissions "
        + "GET /api/provider lists, restricted to this account, and send that one",
    });
  }

  const accounts = await ask<Array<{ id: string; name?: string }>>(input.token, "/accounts?per_page=50");
  if (!accounts.ok) {
    throw unprocessable("E_PROVIDER_TOKEN_INVALID", {
      what: `the token is active but cannot list its accounts: ${accounts.error}`,
      why: "the account is the boundary every zone read is kept inside, and a token that cannot name one "
        + "cannot be bound to one",
      fix: "give the token \"Account Settings: Read\" on the account this Node runs in",
    });
  }
  const seen = accounts.result;
  const chosen = input.accountId === undefined
    ? (seen.length === 1 ? seen[0]! : null)
    : (seen.find((one) => one.id === input.accountId) ?? null);
  if (chosen === null) {
    if (seen.length === 0) {
      throw unprocessable("E_PROVIDER_TOKEN_INVALID", {
        what: "the token is active and sees no account",
        why: "a token restricted to no account can act in none",
        fix: "when creating the token, include this Node's account under Account Resources",
      });
    }
    throw unprocessable("E_PROVIDER_ACCOUNT_AMBIGUOUS", {
      what: input.accountId === undefined
        ? `the token sees ${seen.length} accounts: ${seen.map((one) => `${one.name ?? "unnamed"} (${one.id})`).join(", ")}`
        : `the token does not see account ${input.accountId}; it sees ${seen.map((one) => one.id).join(", ")}`,
      why: "this Node binds itself to exactly one account, and guessing between several would let a zone "
        + "read land in somebody else's",
      fix: "send accountId with one of the ids above, or restrict the token to one account and send it again",
    });
  }

  const at = new Date(ctx.now()).toISOString();
  const wrapped = await wrapCredential(env, input.token);
  await auditedBatch(
    env, ctx, orgId,
    {
      action: "provider.token_registered", outcome: "ok", actorUserId,
      subject: chosen.id, detail: { accountId: chosen.id, accountName: chosen.name ?? null },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        "INSERT INTO provider_token (id, token, account_id, account_name, verified_at, registered_at, registered_by) "
        + "VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET token = excluded.token, "
        + "account_id = excluded.account_id, account_name = excluded.account_name, "
        + "verified_at = excluded.verified_at, registered_at = excluded.registered_at, "
        + "registered_by = excluded.registered_by",
      ).bind(wrapped, chosen.id, chosen.name ?? null, at, at, actorUserId),
    ],
  );
  return providerStatus(env);
}

/** Forgets the held token. The token itself stays valid in Cloudflare until the operator deletes it there. */
export async function forgetToken(env: Env, ctx: Ctx, orgId: string, actorUserId: string): Promise<ProviderStatus> {
  const held = await providerStatus(env);
  if (held.state === "no_token") {
    throw conflict("E_PROVIDER_NO_TOKEN", {
      what: "this Node holds no Cloudflare token to forget",
      why: "forgetting nothing would record an act that changed nothing",
      fix: "nothing; GET /api/provider already says no_token",
    });
  }
  await auditedBatch(
    env, ctx, orgId,
    {
      action: "provider.token_forgotten", outcome: "ok", actorUserId,
      subject: held.accountId ?? "", detail: { accountId: held.accountId, accountName: held.accountName },
    },
    (entry) => [entry, env.CATALOG.prepare("DELETE FROM provider_token WHERE id = 1")],
  );
  return providerStatus(env);
}
