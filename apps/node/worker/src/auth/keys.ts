import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { audit } from "../audit.ts";
import { unwrapCredential, wrapCredential } from "./kek.ts";

/**
 * ES256 signing keys and their rotation.
 *
 * ES256 is ECDSA on P-256 with SHA-256 — an asymmetric signature, which is the property that
 * earns it its place here over HMAC. A verifier needs only the public key, so verification can
 * move out of this Worker later (§25's UI, a second service, an auditor checking a token was
 * genuinely issued) without ever handing out the ability to *mint* one. HS256 would have to
 * ship the signing secret to every verifier.
 *
 * ## Rotation
 *
 * Three states, and the middle one is the whole point:
 *
 *   current  — signs new tokens; exactly one, enforced by a partial unique index
 *   retiring — no longer signs, still verifies, until `retires_at`
 *   retired  — verifies nothing
 *
 * Without `retiring`, rotating a key invalidates every token it signed, and every signed-in
 * user is thrown out at the moment of rotation. The retiring window is 2x the access-token
 * TTL, so by the time a key stops verifying, every token it could have signed has expired on
 * its own. Rotation is therefore invisible — which is the only kind of rotation that actually
 * gets performed.
 *
 * The unique index means "two current keys" is unrepresentable rather than a state the code is
 * trusted to avoid: a concurrent generation loses at the database, not at a check.
 */

const VERIFY_GRACE_MS = BUDGETS["auth.signing_key_verify_grace_seconds"] * 1000;

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
}

/** Workers' own lib types name these params structurally rather than by interface. */
const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/**
 * The key that signs. Generates one on first use, so a freshly installed Node needs no key
 * ceremony — the install flow has enough to get wrong already (§5A).
 */
export async function currentSigningKey(env: Env, ctx: Ctx): Promise<SigningKey> {
  const existing = await env.CATALOG.prepare(
    "SELECT kid, private_jwk_wrapped FROM signing_keys WHERE status = 'current' LIMIT 1",
  ).first<{ kid: string; private_jwk_wrapped: string }>();

  if (existing !== null) {
    return { kid: existing.kid, privateKey: await importPrivate(env, existing.private_jwk_wrapped) };
  }

  const generated = await generateSigningKey(env, ctx, "current");
  if (generated !== null) return generated;

  // The insert lost to a concurrent generation. The winner's key is as good as ours would
  // have been, so read it rather than retrying — there is nothing to retry toward.
  const winner = await env.CATALOG.prepare(
    "SELECT kid, private_jwk_wrapped FROM signing_keys WHERE status = 'current' LIMIT 1",
  ).first<{ kid: string; private_jwk_wrapped: string }>();

  if (winner === null) {
    throw new Error(
      "E_NO_SIGNING_KEY  no current signing key, and generating one failed\n" +
        "  why      the insert was rejected but no other current key is present\n" +
        "  fix      check the signing_keys table and the sk_one_current index",
    );
  }
  return { kid: winner.kid, privateKey: await importPrivate(env, winner.private_jwk_wrapped) };
}

/**
 * Returns null if the row was rejected because a current key already existed — and **only** then.
 *
 * The first version caught everything, which meant any failure at all — an unreadable KEK, a schema
 * mismatch — presented as "someone else won the race" and then as a confusing "no current signing
 * key" error several lines later. A catch that swallows the cause is worse than no catch: it turns
 * one legible failure into a misleading one.
 */
async function generateSigningKey(env: Env, ctx: Ctx, status: string): Promise<SigningKey | null> {
  const pair = (await crypto.subtle.generateKey(ES256, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const kid = ctx.id("key");

  try {
    await env.CATALOG.prepare(
      `INSERT INTO signing_keys (kid, algorithm, public_jwk, private_jwk_wrapped, status, created_at, retires_at)
       VALUES (?,?,?,?,?,?,NULL)`,
    )
      .bind(
        kid,
        "ES256",
        JSON.stringify(publicJwk),
        await wrapCredential(env, JSON.stringify(privateJwk)),
        status,
        new Date(ctx.now()).toISOString(),
      )
      .run();
  } catch (error) {
    // Only the partial unique index losing means "another isolate got there first". Anything else
    // is a real fault and must not be disguised as one.
    if (/UNIQUE constraint failed/i.test((error as Error).message)) return null;
    throw error;
  }

  return { kid, privateKey: pair.privateKey };
}

/**
 * Rotates. The old key moves to `retiring` and the new one becomes current in one batch — #5
 * established `batch()` is D1's only atomic primitive, and a partial failure here would leave
 * either no current key (nothing can sign in) or a rejected insert (nothing rotated).
 *
 * Ordering inside the batch is load-bearing: the demotion must precede the insert, or the
 * partial unique index rejects the new row and takes the batch with it.
 */
export async function rotateSigningKey(env: Env, ctx: Ctx): Promise<{ kid: string; retired: string | null }> {
  const outgoing = await env.CATALOG.prepare(
    "SELECT kid FROM signing_keys WHERE status = 'current' LIMIT 1",
  ).first<{ kid: string }>();

  const pair = (await crypto.subtle.generateKey(ES256, true, ["sign", "verify"])) as CryptoKeyPair;
  const kid = ctx.id("key");
  const at = new Date(ctx.now()).toISOString();
  const retiresAt = new Date(ctx.now() + VERIFY_GRACE_MS).toISOString();

  const statements = [];
  if (outgoing !== null) {
    statements.push(
      env.CATALOG.prepare("UPDATE signing_keys SET status = 'retiring', retires_at = ? WHERE kid = ?")
        .bind(retiresAt, outgoing.kid),
    );
  }
  statements.push(
    env.CATALOG.prepare(
      `INSERT INTO signing_keys (kid, algorithm, public_jwk, private_jwk_wrapped, status, created_at, retires_at)
       VALUES (?,?,?,?,'current',?,NULL)`,
    ).bind(
      kid,
      "ES256",
      JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey)),
      await wrapCredential(env, JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey))),
      at,
    ),
  );
  // Keys whose window has closed stop verifying. Marked, not deleted: which key signed a
  // token is the kind of thing an incident wants to be able to ask about later.
  statements.push(
    env.CATALOG.prepare(
      "UPDATE signing_keys SET status = 'retired' WHERE status = 'retiring' AND retires_at <= ?",
    ).bind(at),
  );

  await env.CATALOG.batch(statements);
  keyCache = null;

  // Key rotation is the kind of thing an investigation asks about months later, and the org is not on
  // hand here — the claimed one is the Node's, and a Node has exactly one.
  const claimed = await env.CATALOG.prepare(
    "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
  ).first<{ org_id: string }>().catch(() => null);
  if (claimed?.org_id != null) {
    await audit(env, ctx, claimed.org_id, {
      action: "key.rotated", outcome: "ok", subject: kid,
      detail: { retiring: outgoing?.kid ?? null, purpose: "signing" },
    });
  }

  return { kid, retired: outgoing?.kid ?? null };
}

async function importPrivate(env: Env, wrapped: string): Promise<CryptoKey> {
  const jwk = JSON.parse(await unwrapCredential(env, wrapped)) as JsonWebKey;
  return crypto.subtle.importKey("jwk", jwk, ES256, false, ["sign"]);
}

/**
 * Verification keys, cached in the isolate.
 *
 * The TTL is a **staleness bound on key revocation**: a key withdrawn from the table keeps
 * verifying for at most this long. It is set far below the access-token TTL
 * (`auth.access_token_ttl_seconds`) so that this cache is never the slowest step in getting
 * authority withdrawn — the token's own expiry always dominates. Sizing it the other way round
 * would put a limit nobody can see in front of §7's revocation guarantee.
 */
const CACHE_MS = BUDGETS["auth.signing_key_cache_seconds"] * 1000;

let keyCache: { at: number; keys: Map<string, CryptoKey> } | null = null;

export async function verificationKey(env: Env, kid: string, now: number): Promise<CryptoKey | null> {
  if (keyCache !== null && now - keyCache.at < CACHE_MS) {
    const hit = keyCache.keys.get(kid);
    if (hit !== undefined) return hit;
    // A miss on a warm cache means the kid is genuinely unknown, or was created after the
    // cache was filled. Fall through and reload rather than reject a token we just signed.
  }

  const rows = await env.CATALOG.prepare(
    `SELECT kid, public_jwk FROM signing_keys
      WHERE status = 'current' OR (status = 'retiring' AND retires_at > ?)`,
  )
    .bind(new Date(now).toISOString())
    .all<{ kid: string; public_jwk: string }>();

  const keys = new Map<string, CryptoKey>();
  for (const row of rows.results) {
    keys.set(
      row.kid,
      await crypto.subtle.importKey("jwk", JSON.parse(row.public_jwk) as JsonWebKey, ES256, false, ["verify"]),
    );
  }
  keyCache = { at: now, keys };
  return keys.get(kid) ?? null;
}

/** Test seam. Rotation clears the cache itself; this exists so tests need not wait it out. */
export function clearKeyCache(): void {
  keyCache = null;
}

/** The public JWK Set. What a future external verifier reads instead of being given a secret. */
export async function publicJwks(env: Env, now: number): Promise<{ keys: JsonWebKey[] }> {
  const rows = await env.CATALOG.prepare(
    `SELECT kid, public_jwk FROM signing_keys
      WHERE status = 'current' OR (status = 'retiring' AND retires_at > ?)
      ORDER BY created_at DESC`,
  )
    .bind(new Date(now).toISOString())
    .all<{ kid: string; public_jwk: string }>();

  return {
    keys: rows.results.map((row) => ({
      ...(JSON.parse(row.public_jwk) as JsonWebKey),
      kid: row.kid,
      alg: "ES256",
      use: "sig",
    })),
  };
}
