import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { unwrapCredential, wrapCredential } from "../auth/kek.ts";
import { conflict, unprocessable } from "../errors.ts";

/**
 * Cloudflare's authorization server, measured.
 *
 * @see docs/receipts/cloudflare-oauth-endpoints.md
 */
/**
 * An operator's own Cloudflare credential, carried on the request for one call (25 September 2026).
 *
 * The Node's provisioning code — receiving, sending, delivery events, routing rules — reads the account
 * through the Node's grant. The grant exists so a browser can do those things later; at install there is a
 * better credential already consented to: wrangler's login, which `mailda install` holds and which reaches
 * every endpoint the grant does except raw DNS and the registrar (measured, `docs/receipts/wrangler-login-reach.md`).
 * So an administrator may send that token and its account id with one request, in two headers, and every
 * read and write in that request uses them instead of the grant. Nothing is stored: the authority lives on
 * the request's `Ctx` and dies with it. It is the same trust as `POST /api/provider/client`'s token — the
 * operator's, sent to the operator's own Node, once.
 *
 * On the `Ctx` rather than threaded through every signature: the two functions that turn a `Ctx` into a
 * credential (`accessTokenFor` here, `boundAccount` in `account-routing.ts`) are the whole seam.
 */
export interface OperatorAuthority { token: string; accountId: string }
export type ProviderCtx = Ctx & { operator?: OperatorAuthority };
export function operatorOf(ctx: Ctx): OperatorAuthority | null {
  return (ctx as ProviderCtx).operator ?? null;
}
export function withOperator(ctx: Ctx, operator: OperatorAuthority | null): Ctx {
  return operator === null ? ctx : { now: () => ctx.now(), id: (p: string) => ctx.id(p), random: (n: number) => ctx.random(n), operator } as ProviderCtx;
}

export const CLOUDFLARE_OAUTH = {
  issuer: "https://dash.cloudflare.com",
  authorize: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
  /** Where the four above were read from, so `doctor` re-reads the same document rather than a guess. */
  discovery: "https://dash.cloudflare.com/.well-known/openid-configuration",
} as const;

/**
 * What the token endpoint answered.
 *
 * ## `accountId` is optional because its presence is **not measured**
 *
 * `cloudflare-oauth-endpoints.md` read the discovery document; nothing in this repository has yet seen a
 * Cloudflare token response, because no Node has held a grant. Whether it names the account the operator
 * selected is therefore unknown, and the two honest options were to invent a field or to admit it may be
 * absent.
 *
 * Absent is handled: the binding stores `account_id` as null and every surface says *not yet determined*
 * rather than showing an empty account. Resolving it costs one `GET /client/v4/accounts` with the grant, and
 * that call belongs to the layer that already talks to the API rather than to this one — a module that
 * obtained authority and immediately spent it to fill in a field would have no place to put the honest answer
 * "connected, and nothing has been read yet".
 *
 * If the response does carry it, this reads it and the extra call never happens. That is a difference the
 * first real consent settles, and it is #162's to record.
 */
export interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  account_id?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * The Cloudflare API, called as this Node (#162 L2).
 *
 * ## Why this is the first thing L2 needs
 *
 * L1 obtained a grant and deliberately spent none of it — `doctor` reported *"nothing has been read with it
 * yet"*, which was honest and is not a place to stay. Every later layer reads or writes through here.
 *
 * ## The access token lives an hour, so refreshing is not an optimisation
 *
 * Measured: `access_expires_at` is one hour after the grant. A caller that used the stored token without
 * checking would work for an hour after each consent and fail silently afterwards, which is the failure mode
 * ADR 42's *one ceremony* exists to avoid — it would make the ceremony hourly in practice while claiming
 * otherwise.
 *
 * Refreshed **before** expiry rather than on a 401, with a minute of margin: a token that expires between
 * the check and the request is a request that fails for a reason the caller cannot distinguish from a
 * revocation. The margin costs one refresh an hour.
 *
 * ## A rejected refresh is what makes `grant_refused` real
 *
 * L1 could describe that state and not reach it — the drill had to write the row by hand. This is the path
 * that reaches it: Cloudflare answering `invalid_grant` to a refresh means the grant is gone, revoked in the
 * dashboard or past its session, and the row records **Cloudflare's own words** rather than a paraphrase.
 *
 * The tokens are kept, deliberately. #162's distinction between *never granted* and *granted and then
 * refused* is only legible while they are there.
 */
export async function accessTokenFor(env: Env, ctx: Ctx, orgId: string): Promise<string> {
  const operator = operatorOf(ctx);
  if (operator !== null) return operator.token;
  const row = await env.CATALOG.prepare(
    "SELECT client_id, client_secret, access_token, refresh_token, access_expires_at, refused_at "
    + "FROM provider_binding WHERE id = 1",
  ).first<{
    client_id: string; client_secret: string; access_token: string | null;
    refresh_token: string | null; access_expires_at: string | null; refused_at: string | null;
  }>();

  if (row === null || row.access_token === null) {
    throw conflict("E_PROVIDER_NO_GRANT", {
      what: "this Node holds no Cloudflare grant",
      why: "reading the account needs an authorization somebody consented to, and none has been given",
      fix: "connect the account first: `mailda provider` prints the steps",
    });
  }
  if (row.refused_at !== null) {
    throw conflict("E_PROVIDER_GRANT_REFUSED", {
      what: `Cloudflare rejected this Node's grant at ${row.refused_at}`,
      why: "a refused grant is not a missing one — it was consented to and has since been revoked or has "
        + "expired past its session, and this Node keeps it so the difference stays legible",
      fix: "authorize again: `mailda provider --scopes …`. Nothing else on this Node is affected by the "
        + "refusal — mail, sign-in, Butlers, backup and recovery do not use this grant",
    });
  }

  /*
   * A minute of margin. Cutting it finer would let a token expire between this check and the request it was
   * fetched for, and a caller cannot tell that failure from a revocation.
   */
  const expiresAt = row.access_expires_at === null ? 0 : new Date(row.access_expires_at).getTime();
  if (expiresAt - 60_000 > ctx.now()) return unwrapCredential(env, row.access_token);

  if (row.refresh_token === null) {
    throw conflict("E_PROVIDER_NO_REFRESH", {
      what: "this Node's access token has expired and there is no refresh token to renew it",
      why: "Cloudflare issues a refresh token only when the client's grant types include `refresh_token`, "
        + "which adds `offline_access` to its scopes automatically — a client without it grants an hour and "
        + "no more",
      fix: "add Refresh Token to the client's grant types in Manage Account → OAuth clients, then authorize "
        + "again. `docs/receipts/cloudflare-oauth-scopes.md` records the measurement",
    });
  }

  const secret = await unwrapCredential(env, row.client_secret);
  const refresh = await unwrapCredential(env, row.refresh_token);
  const response = await fetch(CLOUDFLARE_OAUTH.token, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${encodeURIComponent(row.client_id)}:${encodeURIComponent(secret)}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }).toString(),
  }).catch(() => null);

  const payload = response === null
    ? null
    : (await response.json().catch(() => ({}))) as TokenResponse;

  if (response === null || !response.ok || typeof payload?.access_token !== "string") {
    /*
     * A network failure is **not** recorded as a refusal. `grant_refused` means Cloudflare rejected a grant
     * this Node holds; an unreachable token endpoint says nothing about the grant, and marking it refused
     * would tell an operator their authorization had been revoked because a request timed out. ADR 40's
     * distinction between a refusal and an unknown, in a third place.
     */
    if (response === null) {
      throw conflict("E_PROVIDER_REFRESH_UNREACHABLE", {
        what: "the token endpoint could not be reached to renew this Node's access token",
        why: "an unreachable endpoint says nothing about whether the grant is still good, so it is not "
          + "recorded as a refusal",
        fix: "retry. If it persists, check whether Cloudflare's API is reachable from this Node",
      });
    }
    const detail = typeof payload?.error_description === "string"
      ? payload.error_description
      : (typeof payload?.error === "string" ? payload.error : `http_${response.status}`);
    await auditedBatch(
      env, ctx, orgId,
      {
        action: "provider.grant_refused", outcome: "refused", actorUserId: null,
        subject: row.client_id, detail: { error: detail },
      },
      (entry) => [
        entry,
        env.CATALOG.prepare(
          "UPDATE provider_binding SET refused_at = ?, refused_detail = ? WHERE id = 1",
        ).bind(new Date(ctx.now()).toISOString(), detail),
      ],
    );
    throw conflict("E_PROVIDER_GRANT_REFUSED", {
      what: `Cloudflare refused to renew this Node's grant: ${detail}`,
      why: "the refresh token is the durable half of the authorization, so a refusal means the grant is "
        + "gone — revoked in the dashboard, or past its session",
      fix: "authorize again: `mailda provider --scopes …`. Nothing else on this Node uses this grant",
    });
  }

  /*
   * The new refresh token replaces the old **when one is returned**. Rotation is at the server's discretion:
   * a response carrying only an access token means the existing refresh token stays valid, and overwriting
   * it with null would discard the durable half on a successful renewal.
   */
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
  const rotated = typeof payload.refresh_token === "string" ? payload.refresh_token : null;
  await env.CATALOG.prepare(
    "UPDATE provider_binding SET access_token = ?, access_expires_at = ?"
    + (rotated === null ? "" : ", refresh_token = ?") + " WHERE id = 1",
  ).bind(
    ...[
      await wrapCredential(env, payload.access_token),
      expiresIn === null ? null : new Date(ctx.now() + expiresIn * 1000).toISOString(),
      ...(rotated === null ? [] : [await wrapCredential(env, rotated)]),
    ],
  ).run();

  return payload.access_token;
}

/**
 * One authenticated read of Cloudflare's API as this Node.
 *
 * `GET` only, deliberately: L1 provisions nothing, and a helper that could write would be reached for by the
 * layer that eventually does before anybody decided what that layer may change.
 */
export async function cloudflareGet<T>(
  env: Env, ctx: Ctx, orgId: string, path: string,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const token = await accessTokenFor(env, ctx, orgId);
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  }).catch(() => null);
  if (response === null) return { ok: false, error: "the Cloudflare API could not be reached" };

  const body = (await response.json().catch(() => ({}))) as {
    success?: boolean; result?: T; errors?: Array<{ message?: string; code?: number }>;
  };
  if (response.ok && body.success === true && body.result !== undefined) {
    return { ok: true, result: body.result };
  }
  /*
   * Cloudflare's own words, not a paraphrase — and its error codes are what distinguish "this scope was not
   * granted" from "this resource does not exist", which a caller has to be able to tell apart.
   */
  const said = (body.errors ?? []).map((one) => `${one.code ?? "?"} ${one.message ?? ""}`.trim()).join("; ");
  return { ok: false, error: said === "" ? `http_${response.status}` : said };
}

/**
 * One authenticated **read** of Cloudflare's API that happens to be a `POST`.
 *
 * `cloudflareGet` is `GET`-only and says why: a helper that could write would be reached for by the layer
 * that eventually does, before anybody decided what that layer may change. That argument still holds, and
 * this does not weaken it — `domain-check` is a `POST` because it takes a list of names in a body, and
 * Cloudflare documents it as *"read-only — it does not create, modify, or reserve any domains"*.
 *
 * It throws rather than returning a result union, because its callers have nothing useful to say about a
 * refusal. The routes that actually write name their calls in the open, where they can be read.
 */
export async function cloudflarePost<T>(
  env: Env, ctx: Ctx, orgId: string, path: string, body: unknown,
): Promise<T> {
  return await cloudflareWrite<T>(env, ctx, orgId, "POST", path, body);
}

/**
 * One authenticated `PATCH`, for the single settings change this Node makes.
 *
 * Separate from `cloudflarePost` and named for what it does, so the one act that turns a zone into a mail
 * zone is greppable. `POST /email/routing/enable` would be the obvious call and Cloudflare marks it
 * deprecated; `PATCH /email/routing` is the live one.
 */
export async function cloudflarePatch<T>(
  env: Env, ctx: Ctx, orgId: string, path: string, body: unknown,
): Promise<T> {
  return await cloudflareWrite<T>(env, ctx, orgId, "PATCH", path, body);
}

/**
 * One authenticated `PUT`, for replacing a routing rule (#258). Measured: the rules endpoint refuses a
 * partial body (`2007 matchers: must have matchers`), so a caller sends the whole rule as it read it
 * (`docs/receipts/email-routing-rule-takeover.md`).
 */
export async function cloudflarePut<T>(
  env: Env, ctx: Ctx, orgId: string, path: string, body: unknown,
): Promise<T> {
  return await cloudflareWrite<T>(env, ctx, orgId, "PUT", path, body);
}

async function cloudflareWrite<T>(
  env: Env, ctx: Ctx, orgId: string, method: "POST" | "PATCH" | "PUT", path: string, body: unknown,
): Promise<T> {
  const token = await accessTokenFor(env, ctx, orgId);
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }).catch(() => null);

  const payload = (await response?.json().catch(() => ({}))) as {
    success?: boolean; result?: T; errors?: Array<{ message?: string; code?: number }>;
  };
  if (response !== null && response.ok && payload.success === true && payload.result !== undefined) {
    return payload.result;
  }
  const said = (payload?.errors ?? [])
    .map((one) => `${one.code ?? "?"} ${one.message ?? ""}`.trim()).join("; ");
  throw unprocessable("E_CLOUDFLARE_REFUSED", {
    what: `Cloudflare refused ${path}`,
    why: said === "" ? `the API answered ${response?.status ?? "nothing"}` : said,
    fix: "check the grant still carries the scope this call needs, and that the account may perform it",
  });
}

/**
 * Every item of a paged Cloudflare listing, following pages until a short one.
 *
 * Stopping on a short page needs no count from the response and cannot be fooled by a total that disagrees
 * with what was returned. A listing read as one page of fifty is right until the fifty-first item and then
 * silently wrong (`wrangler-list-pagination.md`), which is why nothing reads a page and calls it the list.
 */
export async function cloudflareGetAll<T>(
  env: Env, ctx: Ctx, orgId: string, path: string,
): Promise<{ ok: true; result: T[] } | { ok: false; error: string }> {
  const page_size = 50;
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const answer = await cloudflareGet<T[]>(env, ctx, orgId, `${path}?page=${page}&per_page=${page_size}`);
    if (!answer.ok) return answer;
    all.push(...answer.result);
    if (answer.result.length < page_size) return { ok: true, result: all };
  }
}
