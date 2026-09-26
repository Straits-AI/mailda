import type { Ctx } from "@mailda/runtime";

import { unwrapCredential } from "../auth/kek.ts";
import { conflict, unprocessable } from "../errors.ts";

/**
 * An operator's own Cloudflare credential, carried on the request for one call (25 September 2026).
 *
 * The Node's provisioning code — receiving, sending, delivery events, routing rules — reads the account
 * through the Node's stored token. The token exists so a browser can do those things later; at install there is a
 * better credential already consented to: wrangler's login, which `mailda install` holds and which reaches
 * every endpoint the grant does except raw DNS and the registrar (measured, `docs/receipts/wrangler-login-reach.md`).
 * So an administrator may send that token and its account id with one request, in two headers, and every
 * read and write in that request uses them instead of the grant. Nothing is stored: the authority lives on
 * the request's `Ctx` and dies with it. It is the operator's own credential, sent to the operator's own Node, once.
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

/**
 * The credential a call as this Node is made with.
 *
 * Two sources, in order: an operator's own token carried on the request (the CLI, with wrangler's login),
 * else the API token an administrator registered (`credential.ts`), unwrapped for this call. Nothing else.
 * Until 26 September 2026 the second was an OAuth access token renewed hourly here from a refresh token,
 * with a refusal state recorded when Cloudflare declined the renewal; a stored token has no renewal, so an
 * invalid one is refused by Cloudflare at the call, in its own words, through the error paths below.
 */
export async function accessTokenFor(env: Env, ctx: Ctx, orgId: string): Promise<string> {
  void orgId;
  const operator = operatorOf(ctx);
  if (operator !== null) return operator.token;
  const row = await env.CATALOG.prepare("SELECT token FROM provider_token WHERE id = 1")
    .first<{ token: string }>().catch(() => null);
  if (row === null) {
    throw conflict("E_PROVIDER_NO_TOKEN", {
      what: "this Node holds no Cloudflare API token, and no operator credential came with the request",
      why: "reading or changing the account needs a credential, and none has been given",
      fix: "PUT /api/provider/token with a token carrying the permissions GET /api/provider lists; the "
        + "Setup screen's connection section does this, and `mailda provider --token` from the CLI",
    });
  }
  return unwrapCredential(env, row.token);
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

/**
 * One authenticated `DELETE`, for removing a literal routing rule this Node wrote (26 September 2026), which
 * is the one thing this Node deletes in Cloudflare. Cloudflare answers with the rule it removed, so the
 * same success shape holds. No body: the rule is named by its path.
 */
export async function cloudflareDelete<T>(
  env: Env, ctx: Ctx, orgId: string, path: string,
): Promise<T> {
  return await cloudflareWrite<T>(env, ctx, orgId, "DELETE", path, undefined);
}

async function cloudflareWrite<T>(
  env: Env, ctx: Ctx, orgId: string, method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body: unknown,
): Promise<T> {
  const token = await accessTokenFor(env, ctx, orgId);
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    fix: "check the token still carries the permission this call needs (GET /api/provider lists them), and "
      + "that the account may perform it",
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
