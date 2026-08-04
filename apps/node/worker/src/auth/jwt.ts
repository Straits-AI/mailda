import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { currentSigningKey, verificationKey } from "./keys.ts";

/**
 * ES256 access tokens.
 *
 * ## What is *not* in a token
 *
 * No roles, no mailbox list, no permissions. §7 forbids it, and the reason is worth stating
 * because the temptation is permanent: a token is a snapshot, and authorization is a live
 * question. A token carrying "may read mailbox X" keeps saying so after the grant is removed.
 * So the token carries identity — organization and user — and every authorization decision is
 * re-evaluated against `relationship_tuples` on each request (`authz-read.ts`).
 *
 * That leaves exactly one thing a token can be wrong about: whether this user still exists and
 * is still allowed in at all. Which is what the short TTL below bounds, and what the
 * DB-backed refresh token actually revokes.
 *
 * ## Verification
 *
 * Written out rather than pulled from a JWT library, because the standard JWT footguns are all
 * in the verify path and are easier to see than to audit:
 *
 *   - the algorithm comes from *our* expectation, never from the token header, so `alg: none`
 *     and an HS256-signed token bearing a public key as its secret are both rejected before
 *     any crypto runs;
 *   - `kid` selects a key only from the set the database says may verify;
 *   - `exp` and `nbf` are checked after the signature, never instead of it.
 */

const ACCESS_TTL_SECONDS = BUDGETS["auth.access_token_ttl_seconds"];
const ISSUER = "mailda";
const AUDIENCE = "mailda-node";

export interface AccessClaims {
  iss: string;
  aud: string;
  sub: string;   // user id
  org: string;   // organization id
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

function b64uEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const utf8 = new TextEncoder();

export interface MintedAccessToken {
  token: string;
  /** Absolute expiry, so a client can refresh ahead of it instead of discovering it via a 401. */
  expiresAt: number;
}

export async function mintAccessToken(
  env: Env,
  ctx: Ctx,
  principal: { orgId: string; userId: string },
): Promise<MintedAccessToken> {
  const key = await currentSigningKey(env, ctx);
  const issuedAt = Math.floor(ctx.now() / 1000);
  const expiresAt = issuedAt + ACCESS_TTL_SECONDS;

  const header = { alg: "ES256", typ: "JWT", kid: key.kid };
  const claims: AccessClaims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: principal.userId,
    org: principal.orgId,
    iat: issuedAt,
    // A second of tolerance for the verifier's clock running behind the signer's. Without it a
    // token can be rejected as not-yet-valid by the very Node that just issued it.
    nbf: issuedAt - 1,
    exp: expiresAt,
    jti: ctx.id("jti"),
  };

  const signingInput = `${b64uEncode(utf8.encode(JSON.stringify(header)))}.${b64uEncode(utf8.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    utf8.encode(signingInput),
  );

  return {
    token: `${signingInput}.${b64uEncode(new Uint8Array(signature))}`,
    expiresAt: expiresAt * 1000,
  };
}

export type VerifyFailure =
  | "malformed"
  | "unexpected_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "wrong_audience";

export type VerifyResult =
  | { ok: true; claims: AccessClaims }
  | { ok: false; reason: VerifyFailure };

export async function verifyAccessToken(env: Env, token: string, now: number): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  let claims: AccessClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64uDecode(encodedHeader)));
    claims = JSON.parse(new TextDecoder().decode(b64uDecode(encodedClaims))) as AccessClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // The header states an algorithm; we do not take its word for it. Accepting `alg` from the
  // token is the original JWT vulnerability and it still ships in libraries today.
  if (header.alg !== "ES256") return { ok: false, reason: "unexpected_algorithm" };
  if (typeof header.kid !== "string") return { ok: false, reason: "malformed" };

  const publicKey = await verificationKey(env, header.kid, now);
  if (publicKey === null) return { ok: false, reason: "unknown_key" };

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    b64uDecode(encodedSignature) as BufferSource,
    utf8.encode(`${encodedHeader}.${encodedClaims}`),
  );
  if (!valid) return { ok: false, reason: "bad_signature" };

  // Only now are the claims worth reading.
  const seconds = Math.floor(now / 1000);
  if (claims.aud !== AUDIENCE || claims.iss !== ISSUER) return { ok: false, reason: "wrong_audience" };
  if (typeof claims.nbf === "number" && seconds < claims.nbf) return { ok: false, reason: "not_yet_valid" };
  if (typeof claims.exp !== "number" || seconds >= claims.exp) return { ok: false, reason: "expired" };

  return { ok: true, claims };
}
