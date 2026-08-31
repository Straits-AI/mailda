import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { audit, auditedBatch } from "../audit.ts";
import { mintAccessToken } from "./jwt.ts";
import { unwrapCredential, wrapCredential } from "./kek.ts";
import { hashPassword, needsRehash, verifyPassword } from "./password.ts";

/**
 * Sign-in, refresh and sign-out.
 *
 * ## Why two tokens
 *
 * §7 and §28 require withdrawn authority to stop working immediately, and a signed token
 * cannot be recalled — once issued it is valid until it expires, wherever it is. That is not a
 * flaw to work around, it is what a signature *is*, so the design puts the two properties in
 * two different objects:
 *
 *   access token  — ES256 JWT, ten minutes, verified with no database read. Its life is the
 *                   exact size of the revocation hole, which is why it is short and why the
 *                   number is written down in a receipt rather than picked.
 *   refresh token — opaque, thirty days, a row in D1. This is the thing that can actually be
 *                   killed, and killing it caps a revoked user's remaining access at the
 *                   access token's residual life.
 *
 * ## Rotation and the replay window
 *
 * Every refresh mints a new refresh token and marks the old one used, so a stolen token is
 * useful once at most. Presenting a used token normally means it was captured after use, and
 * the response is to revoke the whole **family** — every token in the rotation chain — because
 * at that point we cannot tell which holder is the legitimate one.
 *
 * The exception is the case that would otherwise sign people out for no reason: the client
 * refreshed, the request succeeded, and the *response* never arrived. Or two tabs refreshed at
 * once. The client then holds a token the server considers used, through no fault of its own.
 * So for `auth.refresh_replay_window_seconds` the successor is kept — wrapped under the
 * credential KEK — on the parent row and handed back verbatim to a second presentation. Same
 * token, no new rotation, no family revocation. After the window it is cleared and reuse means
 * theft again.
 *
 * The client is expected to single-flight its refreshes (`src/client/session.client.js`); this window is what
 * makes correctness not *depend* on the client having got that right.
 */

const ACCESS_TTL = BUDGETS["auth.access_token_ttl_seconds"];
const REFRESH_TTL = BUDGETS["auth.refresh_token_ttl_seconds"];
const REPLAY_WINDOW_MS = BUDGETS["auth.refresh_replay_window_seconds"] * 1000;
const MAX_FAILURES = BUDGETS["auth.max_failed_logins_per_15min"];
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

/*
 * `__Host-` prefixed (#96). The prefix is a **browser-enforced** promise: a cookie named this way can only
 * have been set by this exact host, over HTTPS, with `Path=/` and no `Domain` — so a sibling subdomain
 * cannot set one this Node would then read. That is cookie fixation, and it is the same sibling-subdomain
 * threat `csrf.ts` exists for, arriving from the other direction: not "can they send a request as you" but
 * "can they choose the cookie you send".
 *
 * **Renaming these signs everybody out once, on upgrade.** Accepted rather than worked around: the
 * alternative is carrying both names for a grace period, which means two cookies either of which
 * authenticates, and "two live paths, one of them the old weaker one" is the shape ADR 29 warns about for
 * authentication generally.
 */
export const ACCESS_COOKIE = "__Host-mailda_at";
/*
 * **Not** `__Host-` prefixed, and this is a deliberate trade rather than an oversight.
 *
 * The prefix requires `Path=/`. This cookie is scoped to `/api/auth` precisely so the refresh token is not
 * attached to every request — a token that is not sent cannot leak from a log, a proxy or a mis-routed
 * request. Path-scoping is the stronger of the two properties for the cookie that can mint new sessions, so
 * it keeps the path and forgoes the prefix.
 *
 * What is lost: a sibling subdomain could set a `mailda_rt` this Node would read. What that buys an attacker
 * is bounded — a refresh token they already know, presented to `/api/auth/refresh`, which validates it
 * against the D1-backed family and finds nothing. Fixation matters when the victim's *session* becomes the
 * attacker's; here the reverse.
 */
export const REFRESH_COOKIE = "mailda_rt";
/**
 * Expiry hint. Not a credential — it holds one integer, the access token's expiry — and
 * deliberately **not** HttpOnly so the page's own script can read it and refresh *ahead* of
 * expiry. Without it the client has no way to know when its own HttpOnly token dies, and the
 * only remaining strategy is to wait for a 401, which is precisely the behaviour we are trying
 * not to ship. It survives a page reload, so a reopened tab knows where it stands immediately.
 */
export const EXPIRY_COOKIE = "__Host-mailda_at_exp";

/** The refresh cookie is scoped to the refresh endpoint, so it is not attached to every request. */
const REFRESH_PATH = "/api/auth";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function opaqueToken(ctx: Ctx): string {
  return [...ctx.random(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch millis. Given to the client so it can refresh early rather than reactively. */
  accessExpiresAt: number;
  orgId: string;
  userId: string;
}

/**
 * The session and the statement that persists it, without running it.
 *
 * Split out so a caller can commit the refresh token in the same transaction as the audit entry that
 * records the sign-in — see `auditedBatch`. Minting the access token has no database effect, so doing
 * it here costs nothing if the batch is later rolled back.
 */
export async function prepareSession(
  env: Env,
  ctx: Ctx,
  principal: { orgId: string; userId: string },
): Promise<{ statement: D1PreparedStatement; session: IssuedSession }> {
  const access = await mintAccessToken(env, ctx, principal);
  const refresh = opaqueToken(ctx);
  const familyId = ctx.id("fam");

  const statement = env.CATALOG.prepare(
    `INSERT INTO refresh_tokens
       (id, org_id, user_id, family_id, token_hash, used_at, revoked_at, expires_at, created_at, replaced_by_wrapped)
     VALUES (?,?,?,?,?,NULL,NULL,?,?,NULL)`,
  ).bind(
    ctx.id("rft"),
    principal.orgId,
    principal.userId,
    familyId,
    await sha256Hex(refresh),
    new Date(ctx.now() + REFRESH_TTL * 1000).toISOString(),
    new Date(ctx.now()).toISOString(),
  );

  return {
    statement,
    session: {
      accessToken: access.token,
      refreshToken: refresh,
      accessExpiresAt: access.expiresAt,
      orgId: principal.orgId,
      userId: principal.userId,
    },
  };
}

/** Issues a session on its own, for paths with nothing to be atomic with (claim, tests). */
export async function issueSession(
  env: Env,
  ctx: Ctx,
  principal: { orgId: string; userId: string },
): Promise<IssuedSession> {
  const { statement, session } = await prepareSession(env, ctx, principal);
  await statement.run();
  return session;
}

export type LoginOutcome =
  | { status: "signed_in"; session: IssuedSession }
  | { status: "invalid_credentials" }
  | { status: "no_password_set" }
  | { status: "locked_out"; retryAfterSeconds: number };

/**
 * Email and password.
 *
 * Two properties that are easy to lose and hard to notice losing:
 *
 *   - **No user enumeration.** An unknown address, an address with no password, and a wrong
 *     password are indistinguishable to the caller — and take comparable time, because the
 *     unknown-address path runs a real derivation against a dummy verifier rather than
 *     returning early. An early return leaks the user list through a stopwatch.
 *   - **Lockout survives isolate recycling.** Attempts are counted in D1. An in-memory counter
 *     resets whenever a new isolate starts, which an attacker can cause at will.
 */
export async function login(
  env: Env,
  ctx: Ctx,
  orgId: string,
  email: string,
  password: string,
): Promise<LoginOutcome> {
  const normalized = email.trim().toLowerCase();
  const windowStart = new Date(ctx.now() - FAILURE_WINDOW_MS).toISOString();

  const failures = await env.CATALOG.prepare(
    "SELECT COUNT(*) AS n FROM login_attempts WHERE org_id = ? AND email = ? AND at > ?",
  )
    .bind(orgId, normalized, windowStart)
    .first<{ n: number }>();

  if ((failures?.n ?? 0) >= MAX_FAILURES) {
    const oldest = await env.CATALOG.prepare(
      "SELECT at FROM login_attempts WHERE org_id = ? AND email = ? AND at > ? ORDER BY at ASC LIMIT 1",
    )
      .bind(orgId, normalized, windowStart)
      .first<{ at: string }>();
    const freeAt = Date.parse(oldest?.at ?? new Date(ctx.now()).toISOString()) + FAILURE_WINDOW_MS;
    await audit(env, ctx, orgId, {
      action: "auth.locked_out", outcome: "refused", actorKind: "node",
      // The address is the subject of the action here, and an administrator investigating a lockout
      // needs to know whose account it was.
      detail: { email: normalized },
    });
    return { status: "locked_out", retryAfterSeconds: Math.max(1, Math.ceil((freeAt - ctx.now()) / 1000)) };
  }

  const user = await env.CATALOG.prepare(
    "SELECT id, password_hash FROM users WHERE org_id = ? AND email = ? LIMIT 1",
  )
    .bind(orgId, normalized)
    .first<{ id: string; password_hash: string | null }>();

  const verifier = user?.password_hash ?? null;

  if (verifier === null) {
    // Deliberate: spend the same work as a real check so absence is not timeable. The result is
    // discarded — the comparison cannot succeed, and is not meant to.
    await verifyPassword(password, DUMMY_VERIFIER);
    await recordFailure(env, ctx, orgId, normalized);
    // A user row with no password is a real, distinct state — the owner claimed the Node before
    // this flow existed. It is reported distinctly to that user's *own* administrator path, not
    // to an anonymous caller; `index.ts` collapses it to invalid_credentials on the wire.
    return user === null ? { status: "invalid_credentials" } : { status: "no_password_set" };
  }

  if (!(await verifyPassword(password, verifier))) {
    // The attempt row is what the lockout counts, so it and the record of the refusal are the same
    // fact. Committing them separately allows a trail that shows nine refusals behind a lockout that
    // fired on ten, which reads as a bug in the lockout rather than a lost write.
    await auditedBatch(
      env, ctx, orgId,
      { action: "auth.sign_in_failed", outcome: "refused", actorKind: "node", detail: { email: normalized } },
      (entry) => [entry, failureStatement(env, ctx, orgId, normalized)],
    );
    return { status: "invalid_credentials" };
  }

  const at = new Date(ctx.now()).toISOString();
  const statements = [
    // A successful sign-in clears the failure count: the tripwire is there to slow guessing,
    // not to punish someone who mistyped twice and then got it right.
    env.CATALOG.prepare("DELETE FROM login_attempts WHERE org_id = ? AND email = ?").bind(orgId, normalized),
  ];

  // Transparent cost upgrade. The only moment the plaintext is available is now, so if the
  // stored verifier was made under a cheaper iteration count, this is when it gets fixed.
  if (needsRehash(verifier)) {
    const upgraded = await hashPassword(password);
    statements.push(
      env.CATALOG.prepare(
        "UPDATE users SET password_hash = ?, password_iterations = ?, password_updated_at = ? WHERE id = ?",
      ).bind(upgraded.encoded, upgraded.effectiveIterations, at, user!.id),
    );
  }
  // Everything a successful sign-in changes, plus the entry saying it happened, in one transaction:
  // the refresh token that *is* the session, the cleared failure count, and any verifier upgrade.
  const prepared = await prepareSession(env, ctx, { orgId, userId: user!.id });
  await auditedBatch(
    env, ctx, orgId,
    { action: "auth.signed_in", outcome: "ok", actorUserId: user!.id, detail: { method: "password" } },
    (entry) => [...statements, prepared.statement, entry],
  );
  return { status: "signed_in", session: prepared.session };
}

/**
 * A fixed verifier for the unknown-user path. Its plaintext is irrelevant and it is never compared
 * against anything real — only its *cost* is spent, so that the timing of "no such user" is
 * indistinguishable from "wrong password". It is deliberately built from the same parameters the
 * live path uses, so the two cost the same even after the round count changes.
 */
const DUMMY_VERIFIER =
  `pbkdf2-sha256$r=${BUDGETS["auth.pbkdf2_rounds"]}$i=${BUDGETS["auth.pbkdf2_platform_max_iterations"]}$` +
  "AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function failureStatement(env: Env, ctx: Ctx, orgId: string, email: string): D1PreparedStatement {
  return env.CATALOG.prepare("INSERT INTO login_attempts (id, org_id, email, at) VALUES (?,?,?,?)")
    .bind(ctx.id("att"), orgId, email, new Date(ctx.now()).toISOString());
}

async function recordFailure(env: Env, ctx: Ctx, orgId: string, email: string): Promise<void> {
  await failureStatement(env, ctx, orgId, email).run();
}

export async function setPassword(env: Env, ctx: Ctx, userId: string, password: string): Promise<void> {
  const verifier = await hashPassword(password);
  await env.CATALOG.prepare(
    "UPDATE users SET password_hash = ?, password_iterations = ?, password_updated_at = ? WHERE id = ?",
  )
    .bind(verifier.encoded, verifier.effectiveIterations, new Date(ctx.now()).toISOString(), userId)
    .run();
}

export type RefreshOutcome =
  | { status: "rotated"; session: IssuedSession }
  | { status: "replayed"; session: IssuedSession }
  | { status: "expired" }
  | { status: "unknown" }
  | { status: "reuse_detected" };

export async function refreshSession(
  env: Env,
  ctx: Ctx,
  presented: string,
  attempt = 0,
): Promise<RefreshOutcome> {
  // One retry only. Losing the rotation race means the row is now used, so the second pass
  // takes the replay branch and cannot loop — but a bound that is argued rather than enforced
  // is a bound that breaks the day the branch above changes.
  if (attempt > 1) return { status: "reuse_detected" };

  const row = await env.CATALOG.prepare(
    `SELECT id, org_id, user_id, family_id, used_at, revoked_at, expires_at, replaced_by_wrapped
       FROM refresh_tokens WHERE token_hash = ? LIMIT 1`,
  )
    .bind(await sha256Hex(presented))
    .first<{
      id: string;
      org_id: string;
      user_id: string;
      family_id: string;
      used_at: string | null;
      revoked_at: string | null;
      expires_at: string;
      replaced_by_wrapped: string | null;
    }>();

  if (row === null) return { status: "unknown" };
  if (row.revoked_at !== null) return { status: "reuse_detected" };
  if (Date.parse(row.expires_at) <= ctx.now()) return { status: "expired" };

  if (row.used_at !== null) {
    const withinWindow = ctx.now() - Date.parse(row.used_at) <= REPLAY_WINDOW_MS;
    if (withinWindow && row.replaced_by_wrapped !== null) {
      // The lost-response case. Hand back the same successor; do not rotate again, or a client
      // retrying twice would walk the chain forward without ever catching up.
      const successor = await unwrapCredential(env, row.replaced_by_wrapped);
      const access = await mintAccessToken(env, ctx, { orgId: row.org_id, userId: row.user_id });
      return {
        status: "replayed",
        session: {
          accessToken: access.token,
          refreshToken: successor,
          accessExpiresAt: access.expiresAt,
          orgId: row.org_id,
          userId: row.user_id,
        },
      };
    }
    await revokeFamily(env, ctx, row.org_id, row.family_id);
    return { status: "reuse_detected" };
  }

  const successor = opaqueToken(ctx);
  const wrappedSuccessor = await wrapCredential(env, successor);
  const at = new Date(ctx.now()).toISOString();
  const access = await mintAccessToken(env, ctx, { orgId: row.org_id, userId: row.user_id });

  const results = await env.CATALOG.batch([
    // Conditional on still being unused. This is what makes two simultaneous refreshes safe:
    // one wins here, and the loser falls into the replay path above on its retry.
    env.CATALOG.prepare(
      "UPDATE refresh_tokens SET used_at = ?, replaced_by_wrapped = ? WHERE id = ? AND used_at IS NULL",
    ).bind(at, wrappedSuccessor, row.id),
    // Gated on our own update having landed, using the wrapped successor as the witness — its
    // ciphertext is unique to this attempt. Without the gate a lost race would still insert a
    // live refresh token that no client holds and nothing revokes.
    env.CATALOG.prepare(
      `INSERT INTO refresh_tokens
         (id, org_id, user_id, family_id, token_hash, used_at, revoked_at, expires_at, created_at, replaced_by_wrapped)
       SELECT ?,?,?,?,?,NULL,NULL,?,?,NULL
        WHERE EXISTS (SELECT 1 FROM refresh_tokens WHERE id = ? AND replaced_by_wrapped = ?)`,
    ).bind(
      ctx.id("rft"),
      row.org_id,
      row.user_id,
      row.family_id,
      await sha256Hex(successor),
      new Date(ctx.now() + REFRESH_TTL * 1000).toISOString(),
      at,
      row.id,
      wrappedSuccessor,
    ),
    // Housekeeping, opportunistic rather than a scheduled job: clear successors whose replay
    // window has closed, and drop rows nothing can present any more. Bounded work on a path
    // that already writes.
    env.CATALOG.prepare(
      `UPDATE refresh_tokens SET replaced_by_wrapped = NULL
        WHERE org_id = ? AND replaced_by_wrapped IS NOT NULL AND used_at <= ?`,
    ).bind(row.org_id, new Date(ctx.now() - REPLAY_WINDOW_MS).toISOString()),
    env.CATALOG.prepare("DELETE FROM refresh_tokens WHERE org_id = ? AND expires_at <= ?")
      .bind(row.org_id, at),
  ]);

  if ((results[0]?.meta.changes ?? 0) === 0) {
    // Another request rotated this token between our read and our write. Its successor is the
    // one the client must end up with, so replay rather than mint a competing chain.
    return refreshSession(env, ctx, presented, attempt + 1);
  }

  return {
    status: "rotated",
    session: {
      accessToken: access.token,
      refreshToken: successor,
      accessExpiresAt: access.expiresAt,
      orgId: row.org_id,
      userId: row.user_id,
    },
  };
}

async function revokeFamily(env: Env, ctx: Ctx, orgId: string, familyId: string): Promise<void> {
  await env.CATALOG.prepare(
    "UPDATE refresh_tokens SET revoked_at = ?, replaced_by_wrapped = NULL WHERE org_id = ? AND family_id = ? AND revoked_at IS NULL",
  )
    .bind(new Date(ctx.now()).toISOString(), orgId, familyId)
    .run();
}

/** Sign out of this device: revoke the family this token belongs to and nothing else. */
export async function signOut(env: Env, ctx: Ctx, presented: string): Promise<void> {
  const row = await env.CATALOG.prepare(
    "SELECT org_id, family_id FROM refresh_tokens WHERE token_hash = ? LIMIT 1",
  )
    .bind(await sha256Hex(presented))
    .first<{ org_id: string; family_id: string }>();
  if (row !== null) await revokeFamily(env, ctx, row.org_id, row.family_id);
}

/**
 * Sign out everywhere. This is the operation §28 needs for a departing employee, and its
 * effect is bounded by the access token's residual life, not by anything longer.
 */
export async function revokeAllSessions(env: Env, ctx: Ctx, orgId: string, userId: string): Promise<number> {
  // The record and the revocation commit together. This used to audit first and revoke second, which
  // is the worst of the two orderings available without a transaction: a failure after the entry left
  // an audit trail asserting that a departing employee had been signed out everywhere when they had
  // not — the one claim §28 needs to be true.
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    { action: "auth.revoked_all_sessions", outcome: "ok", actorUserId: userId, subject: userId },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        "UPDATE refresh_tokens SET revoked_at = ?, replaced_by_wrapped = NULL WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL",
      ).bind(new Date(ctx.now()).toISOString(), orgId, userId),
    ],
  );
  return results[1]?.meta.changes ?? 0;
}

/**
 * The cookies a session needs.
 *
 *   access  — HttpOnly, so script cannot read it; Path=/ because every API call needs it.
 *   refresh — HttpOnly and scoped to the auth path, so it rides along with refresh requests
 *             only. A token that is not sent is a token that cannot leak from a log or a
 *             mis-proxied request.
 *   expiry  — readable by script, contains one integer, no authority whatsoever.
 *
 * ## `SameSite=Strict`, and what this comment used to claim
 *
 * It said Lax *"is what makes the state-changing endpoints CSRF-safe without a separate token"*. The first
 * half was true and the conclusion did not follow: **same-site is not same-origin**, so every sibling
 * subdomain of the customer's own domain was inside Lax's protection — on a product whose whole premise is
 * running in the customer's own account, where sibling subdomains are the normal case.
 *
 * `csrf.ts` is the actual defence: exact `Origin`, `Sec-Fetch-Site` refusing `same-site`, and no
 * CORS-safelisted content type. `Strict` here is one more layer rather than the argument — it withholds
 * cookies from cross-site navigation as well as cross-site POST, and nothing in this product needs a cookie
 * on a link followed from elsewhere. There is deliberately **no CSRF token**; the blueprint's browser
 * section is amended with the reasoning, which is that a token has to be exempted for the SDK, the CLI and
 * MCP, and an exemption reachable by omitting a header is the bypass the token was for.
 */
export function sessionCookies(session: IssuedSession): string[] {
  return [
    `${ACCESS_COOKIE}=${session.accessToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ACCESS_TTL}`,
    `${REFRESH_COOKIE}=${session.refreshToken}; HttpOnly; Secure; SameSite=Strict; Path=${REFRESH_PATH}; Max-Age=${REFRESH_TTL}`,
    `${EXPIRY_COOKIE}=${session.accessExpiresAt}; Secure; SameSite=Strict; Path=/; Max-Age=${REFRESH_TTL}`,
  ];
}

export function clearedCookies(): string[] {
  return [
    `${ACCESS_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    `${REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=${REFRESH_PATH}; Max-Age=0`,
    `${EXPIRY_COOKIE}=; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  ];
}

export function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(cookie);
  return match ? match[1]! : null;
}
