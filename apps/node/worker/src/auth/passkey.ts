import { BUDGETS } from "@mailda/budgets";
import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { conflict, notFound, unprocessable } from "../errors.ts";

/**
 * Passkeys (#84, ADR 29, §5A).
 *
 * ADR 29 locks *"passkeys are the authentication Mailda builds; password authentication survives as a
 * per-user fallback."* It shipped inverted. This is the correction, and the direction matters: passwords do
 * **not** go away — the ADR says they survive as the fallback, and `passkey-verification.md` records why
 * keeping them is what stops `mailda set-password` becoming the ordinary recovery path for every account.
 *
 * ## The relying-party id comes from the request, not from configuration
 *
 * WebAuthn binds a credential to an **origin**, and the relying-party id is the domain that origin is under.
 * That domain is customer-specific, which ADR 24 forbids the repository from containing — so the obvious
 * shapes are a `vars` entry (forbidden) or a D1 row (allowed, and wrong here).
 *
 * It is derived from the request's own URL instead, and that is better than a stored value rather than a
 * concession to it: **a stored RP id can disagree with the origin the browser is actually on**, and when it
 * does, every ceremony fails with a message about a mismatch nobody can act on. Deriving it makes the
 * disagreement unrepresentable. The consequence is stated rather than discovered: a Node reachable at two
 * origins holds separate credentials per origin, which is WebAuthn working as specified rather than a
 * limitation of this implementation.
 *
 * ## What is verified, and why the library rather than by hand
 *
 * `@simplewebauthn/server`, measured at +128.9 KiB gzip in `passkey-verification.md` — 2.5× what the YAML
 * parser cost, and most of it X.509 machinery for attestation formats this Node does not use. Adopted anyway
 * by this repository's own test, set when `mime-header-parse.md` *deferred* a parser: attacker-chosen
 * structure feeding an authentication decision is where a mature implementation earns its bytes, and the
 * blast radius of a mistake here is account takeover.
 *
 * The tempting counter — *"the cryptography is Web Crypto either way, so what is left is a few
 * comparisons"* — is true and is not the point. Those comparisons are where WebAuthn implementations go
 * wrong: challenge server-issued and single-use, origin matching, RP id hash matching, user-presence flag
 * set, counter not going backwards. **Omitting any one is an auth bypass rather than a bug.**
 *
 * ## Attestation is `none`, deliberately
 *
 * Attestation proves *what kind of authenticator* this is. Mailda has no policy that depends on the answer —
 * no "hardware keys only", no vendor allowlist — so requesting it would collect a device fingerprint this
 * product has no use for, and ask the user to consent to disclosing it. Requesting none is the privacy-
 * preserving default and it is the reason two thirds of the library's bytes are dead weight, which the
 * receipt records rather than hides.
 */

const CHALLENGE_TTL = BUDGETS["auth.passkey_challenge_ttl_seconds"];
const MAX_PER_USER = BUDGETS["auth.passkeys_per_user_max"];

export interface StoredCredential {
  id: string;
  userId: string;
  orgId: string;
  publicKey: string;
  signCount: number;
  transports: string[] | null;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * The relying party this Node is, derived from the request.
 *
 * `id` is the registrable domain; `origin` is the exact scheme-and-host the browser will report. Both come
 * from the same URL, so they cannot disagree.
 */
export interface RelyingParty {
  id: string;
  origin: string;
  name: string;
}

export function relyingPartyFor(request: Request): RelyingParty {
  const url = new URL(request.url);
  return {
    id: url.hostname,
    // Port included, because `localhost:8787` and `localhost` are different origins to a browser and the
    // spec compares origins exactly. Dropping it is the mistake that makes local development fail in a way
    // nobody can debug from the error message.
    origin: url.origin,
    // The name a browser shows in its prompt. The hostname, because the alternative is a product name the
    // user did not type and cannot check against the address bar — and checking the address bar is the one
    // defence a user has against a lookalike prompt.
    name: url.hostname,
  };
}

/**
 * Mints a challenge, records it, and sweeps the expired ones.
 *
 * Both statements in one `batch()`, so the sweep cannot commit without the mint. The sweep rides here rather
 * than on a cron for the reason `webauthn_challenges`'s header gives: this is the only moment the table is
 * written, so it is the cheapest place to keep it bounded, and a stale row nobody reads costs only bytes.
 */
export async function mintChallenge(
  env: Env,
  ctx: Ctx,
  purpose: "register" | "authenticate",
  who: { userId: string; orgId: string } | null,
): Promise<string> {
  const bytes = ctx.random(32);
  const challenge = base64url(bytes);
  const now = ctx.now();
  const at = new Date(now).toISOString();
  const expires = new Date(now + CHALLENGE_TTL * 1000).toISOString();

  await env.CATALOG.batch([
    env.CATALOG.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").bind(at),
    env.CATALOG.prepare(
      `INSERT INTO webauthn_challenges (challenge, purpose, user_id, org_id, created_at, expires_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(challenge, purpose, who?.userId ?? null, who?.orgId ?? null, at, expires),
  ]);
  return challenge;
}

/**
 * Spends a challenge: proves it was issued by this Node for this ceremony, and deletes it.
 *
 * **The delete is what makes it single-use, and it is conditional on the row still being there.** `changes`
 * is checked rather than assumed, so two concurrent redemptions of one challenge resolve to one winner and
 * one refusal instead of both proceeding — the same compare-and-swap shape this repository uses wherever the
 * conflict *is* the signal.
 *
 * Expiry is compared here rather than trusted to the sweep, because a row can outlive its expiry until the
 * next mint. The sweep bounds the table; this bounds the credential.
 */
export async function spendChallenge(
  env: Env,
  ctx: Ctx,
  challenge: string,
  purpose: "register" | "authenticate",
): Promise<{ userId: string | null; orgId: string | null }> {
  const at = new Date(ctx.now()).toISOString();
  const row = await env.CATALOG.prepare(
    "SELECT user_id, org_id, expires_at FROM webauthn_challenges WHERE challenge = ? AND purpose = ?",
  ).bind(challenge, purpose).first<{ user_id: string | null; org_id: string | null; expires_at: string }>();

  /*
   * One refusal for "never issued", "issued for the other ceremony" and "expired".
   *
   * The same treatment `E_INVITATION_UNUSABLE` gets, for the same reason: an attacker probing which of the
   * three it is learns whether a challenge existed, and a legitimate caller does the same thing in all three
   * cases, which is start again.
   */
  if (row === null || row.expires_at < at) {
    throw unprocessable("E_CHALLENGE_UNUSABLE", {
      what: "that challenge was not issued by this Node for this ceremony, or it has expired",
      why: "a challenge is the anti-replay device of the whole exchange: it is minted here, spent once, and "
        + `deleted. Its lifetime is auth.passkey_challenge_ttl_seconds=${CHALLENGE_TTL}`,
      fix: "start again — the interface asks for a fresh challenge each time",
    });
  }

  const spent = await env.CATALOG.prepare(
    "DELETE FROM webauthn_challenges WHERE challenge = ?",
  ).bind(challenge).run();
  if ((spent.meta.changes ?? 0) === 0) {
    // Somebody else spent it between the read and the delete. One winner, and the loser is told plainly.
    throw conflict("E_CHALLENGE_ALREADY_SPENT", {
      what: "that challenge was spent by another request",
      why: "a challenge is single-use, and two ceremonies redeeming one would be a replay",
      fix: "start again",
    });
  }
  return { userId: row.user_id, orgId: row.org_id };
}

/** Every credential this person holds. Public keys and bookkeeping; nothing replayable. */
export async function credentialsOf(env: Env, orgId: string, userId: string): Promise<StoredCredential[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT id, user_id, org_id, public_key, sign_count, transports, label, created_at, last_used_at
       FROM credentials WHERE org_id = ? AND user_id = ? ORDER BY created_at`,
  ).bind(orgId, userId).all<{
    id: string; user_id: string; org_id: string; public_key: string; sign_count: number;
    transports: string | null; label: string; created_at: string; last_used_at: string | null;
  }>();
  return results.map((row) => ({
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    publicKey: row.public_key,
    signCount: row.sign_count,
    transports: row.transports === null ? null : (JSON.parse(row.transports) as string[]),
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/** One credential, by the id the authenticator returns. The lookup an assertion makes. */
export async function credentialById(env: Env, id: string): Promise<StoredCredential | null> {
  const row = await env.CATALOG.prepare(
    `SELECT id, user_id, org_id, public_key, sign_count, transports, label, created_at, last_used_at
       FROM credentials WHERE id = ?`,
  ).bind(id).first<{
    id: string; user_id: string; org_id: string; public_key: string; sign_count: number;
    transports: string | null; label: string; created_at: string; last_used_at: string | null;
  }>();
  if (row === null) return null;
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    publicKey: row.public_key,
    signCount: row.sign_count,
    transports: row.transports === null ? null : (JSON.parse(row.transports) as string[]),
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * The bound on how many credentials one account may hold.
 *
 * Checked before the ceremony rather than after it, so a person is refused before they touch their key
 * rather than afterwards — AGENTS.md's rule that a developer sees the limit before they hit it, applied to
 * the person at the keyboard.
 */
export async function assertRoomForAnother(env: Env, orgId: string, userId: string): Promise<void> {
  const row = await env.CATALOG.prepare(
    "SELECT COUNT(*) AS n FROM credentials WHERE org_id = ? AND user_id = ?",
  ).bind(orgId, userId).first<{ n: number }>();
  if ((row?.n ?? 0) >= MAX_PER_USER) {
    throw conflict("E_BUDGET_EXCEEDED", {
      what: `auth.passkeys_per_user_max=${MAX_PER_USER}, and this account already holds ${row?.n ?? 0}`,
      why: "registration is an authenticated write with no other limit, so an account could otherwise grow "
        + "an unbounded table. The bound is generous because holding several passkeys — a phone, a laptop, "
        + "a hardware key, a spare — is the point of the format",
      fix: "remove one you no longer use. receipt docs/receipts/passkey-verification.md",
    });
  }
}

/**
 * Removes one credential, with its audit entry in the same transaction.
 *
 * **Bound to the owner by the predicate**, so nobody can revoke somebody else's device — and the binding is
 * in the `WHERE` rather than in a check above it, which is what makes it a property of the statement rather
 * than of the order two statements ran in.
 *
 * Audited rather than logged, unlike a sign-in: revoking removes a **way in**, which is the same shape as
 * `access.revoked` and the thing somebody checks after losing a device. In one `auditedBatch` with the
 * delete, so a revocation cannot commit without its record — the direction that matters for an act somebody
 * may later need to prove they performed.
 */
export async function forgetCredential(
  env: Env, ctx: Ctx, orgId: string, userId: string, credentialId: string,
): Promise<void> {
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "auth.passkey_revoked", outcome: "ok", actorUserId: userId, subject: userId,
      detail: { credentialId },
    },
    (entry) => [
      env.CATALOG.prepare(
        "DELETE FROM credentials WHERE org_id = ? AND user_id = ? AND id = ?",
      ).bind(orgId, userId, credentialId),
      entry,
    ],
  );
  const gone = results[0];
  if ((gone?.meta.changes ?? 0) === 0) {
    // A credential belonging to somebody else and one that never existed answer identically (§5C).
    throw notFound("E_NO_SUCH_CREDENTIAL", {
      what: "no such passkey on this account",
      why: "a credential is revocable by the person who holds it and by nobody else",
      fix: "check the list — GET /api/auth/passkeys",
    });
  }
}

/** Base64url without padding, which is what WebAuthn uses throughout. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
