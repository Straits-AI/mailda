import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createFrozenCtx, createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { mintAccessToken, verifyAccessToken } from "../src/auth/jwt.ts";
import { clearKeyCache, currentSigningKey, publicJwks, rotateSigningKey } from "../src/auth/keys.ts";
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from "../src/auth/password.ts";
import {
  issueSession, login, refreshSession, revokeAllSessions, sessionCookies, setPassword, signOut,
  ACCESS_COOKIE, EXPIRY_COOKIE, REFRESH_COOKIE,
} from "../src/auth/session.ts";

const ORG = "org_test";
const EMAIL = "owner@example.com";
const PASSWORD = "a-long-enough-passphrase";

/**
 * A ctx with a controlled clock and real entropy.
 *
 * `createFrozenCtx` freezes *both* — that is exactly its job, so §27 can replay a request
 * deterministically (#6) — which means two frozen contexts mint byte-identical "random" tokens and
 * collide on `refresh_tokens.token_hash`. These tests need to move the clock, not to fix the
 * entropy, so they say so rather than borrowing a tool built for a different purpose.
 */
function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (prefix) => system.id(prefix), random: (bytes) => system.random(bytes) };
}

let userId: string;

beforeEach(async () => {
  for (const table of ["users", "signing_keys", "refresh_tokens", "login_attempts"]) {
    await env.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  clearKeyCache();

  const ctx = createSystemCtx();
  userId = ctx.id("usr");
  const verifier = await hashPassword(PASSWORD);
  await env.CATALOG.prepare(
    `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations, password_updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(userId, ORG, EMAIL, new Date(ctx.now()).toISOString(),
      verifier.encoded, verifier.effectiveIterations, new Date(ctx.now()).toISOString())
    .run();
});

describe("password verifier (§8)", () => {
  it("accepts the right password and rejects a near miss", async () => {
    const verifier = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, verifier.encoded)).toBe(true);
    expect(await verifyPassword(PASSWORD + "x", verifier.encoded)).toBe(false);
    expect(await verifyPassword(PASSWORD.slice(0, -1), verifier.encoded)).toBe(false);
  });

  it("salts per user, so identical passwords do not share a verifier", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a.encoded).not.toBe(b.encoded);
  });

  it("never asks a single PBKDF2 call for more than the platform allows", async () => {
    // The ceiling that produced an HTTP 500 in production while every local test passed. Asserted
    // structurally so it cannot be reintroduced by raising a constant: local workerd will not
    // catch it, so this test has to.
    const verifier = await hashPassword(PASSWORD);
    const [algorithm, rounds, iterations] = verifier.encoded.split("$");
    expect(algorithm).toBe("pbkdf2-sha256");
    expect(Number(iterations!.slice(2))).toBeLessThanOrEqual(BUDGETS["auth.pbkdf2_platform_max_iterations"]);
    // ...and the rounds still add up to the intended work factor.
    expect(Number(rounds!.slice(2)) * Number(iterations!.slice(2)))
      .toBe(BUDGETS["auth.pbkdf2_effective_iterations"]);
  });

  it("carries its own parameters, so a future change cannot silently reinterpret a row", async () => {
    const verifier = await hashPassword(PASSWORD);
    expect(verifier.encoded).toMatch(/^pbkdf2-sha256\$r=\d+\$i=\d+\$[^$]+\$[^$]+$/);
    expect(needsRehash(verifier.encoded)).toBe(false);

    // A verifier made under less work still verifies, and is flagged for upgrade — otherwise
    // raising the cost would lock out every existing user.
    const cheaper = await hashPassword(PASSWORD);
    const weakened = cheaper.encoded.replace(/\$r=\d+\$/, "$r=1$");
    expect(needsRehash(weakened)).toBe(true);

    // An unreadable verifier is not "wrong password" — it is refused, and flagged for rehash.
    expect(await verifyPassword(PASSWORD, "garbage")).toBe(false);
    expect(needsRehash("garbage")).toBe(true);
  });

  it("rejects a short password with a fix, not just a refusal", () => {
    const problem = passwordProblem("short");
    expect(problem).toContain("E_PASSWORD_TOO_SHORT");
    expect(problem).toContain("minimum=12");
    expect(problem).toContain("fix");
    expect(passwordProblem(PASSWORD)).toBeNull();
  });
});

describe("ES256 tokens", () => {
  it("mints and verifies, carrying identity and nothing else", async () => {
    const ctx = createFrozenCtx(1_900_000_000_000);
    const minted = await mintAccessToken(env, ctx, { orgId: ORG, userId });
    const verified = await verifyAccessToken(env, minted.token, ctx.now());

    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.sub).toBe(userId);
    expect(verified.claims.org).toBe(ORG);

    // §7: no authority in the token. Anything resembling a permission list is a bug, because a
    // snapshot of access cannot be revoked.
    const serialized = JSON.stringify(verified.claims);
    expect(serialized).not.toContain("relation");
    expect(serialized).not.toContain("mailbox");
    expect(serialized).not.toContain("read");
  });

  it("declares ES256 in the header with the signing kid", async () => {
    const ctx = createFrozenCtx(1_900_000_000_000);
    const minted = await mintAccessToken(env, ctx, { orgId: ORG, userId });
    const header = JSON.parse(atob(minted.token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(header.alg).toBe("ES256");
    expect(header.kid).toMatch(/^key_/);
  });

  it("expires exactly at the measured TTL", async () => {
    const issuedAt = 1_900_000_000_000;
    const minted = await mintAccessToken(env, createFrozenCtx(issuedAt), { orgId: ORG, userId });
    expect(minted.expiresAt).toBe(issuedAt + BUDGETS["auth.access_token_ttl_seconds"] * 1000);

    const justInside = await verifyAccessToken(env, minted.token, minted.expiresAt - 1000);
    expect(justInside.ok).toBe(true);

    const justOutside = await verifyAccessToken(env, minted.token, minted.expiresAt + 1000);
    expect(justOutside.ok).toBe(false);
    if (!justOutside.ok) expect(justOutside.reason).toBe("expired");
  });

  it("refuses a tampered payload", async () => {
    const ctx = createFrozenCtx(1_900_000_000_000);
    const minted = await mintAccessToken(env, ctx, { orgId: ORG, userId });
    const [header, payload, signature] = minted.token.split(".");

    // Rewrite the subject and keep the signature: the classic forgery.
    const claims = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/")));
    claims.sub = "usr_someone_else";
    const forged = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const result = await verifyAccessToken(env, `${header}.${forged}.${signature}`, ctx.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });

  it("refuses alg:none — the algorithm comes from us, never from the token", async () => {
    const ctx = createFrozenCtx(1_900_000_000_000);
    const minted = await mintAccessToken(env, ctx, { orgId: ORG, userId });
    const kid = JSON.parse(atob(minted.token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).kid;

    const b64u = (value: object) =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const unsigned =
      `${b64u({ alg: "none", typ: "JWT", kid })}.` +
      `${b64u({ iss: "mailda", aud: "mailda-node", sub: userId, org: ORG, exp: 9_999_999_999 })}.`;

    const result = await verifyAccessToken(env, unsigned, ctx.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unexpected_algorithm");
  });

  it("refuses an unknown kid rather than trying every key", async () => {
    const ctx = createFrozenCtx(1_900_000_000_000);
    const minted = await mintAccessToken(env, ctx, { orgId: ORG, userId });
    const [, payload, signature] = minted.token.split(".");
    const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "key_not_ours" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const result = await verifyAccessToken(env, `${header}.${payload}.${signature}`, ctx.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_key");
  });

  it("refuses a token minted for a different audience", async () => {
    const ctx = createFrozenCtx(1_900_000_000_000);
    const key = await currentSigningKey(env, ctx);
    const b64u = (value: object) =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const input =
      `${b64u({ alg: "ES256", typ: "JWT", kid: key.kid })}.` +
      `${b64u({ iss: "somebody-else", aud: "another-service", sub: userId, org: ORG, exp: 9_999_999_999 })}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(input),
    );
    const token = `${input}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

    // Genuinely signed by this Node, and still refused: a valid signature is not a valid token.
    const result = await verifyAccessToken(env, token, ctx.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_audience");
  });

  it("refuses malformed input without throwing", async () => {
    for (const bad of ["", "a", "a.b", "....", "not.a.token", "a.b.c.d"]) {
      const result = await verifyAccessToken(env, bad, Date.now());
      expect(result.ok).toBe(false);
    }
  });
});

describe("signing key rotation", () => {
  it("keeps at most one current key, enforced by the database", async () => {
    const ctx = createSystemCtx();
    await currentSigningKey(env, ctx);
    await rotateSigningKey(env, ctx);
    await rotateSigningKey(env, ctx);

    const current = await env.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM signing_keys WHERE status = 'current'",
    ).first<{ n: number }>();
    expect(current?.n).toBe(1);
  });

  it("does not sign anyone out: a token from the old key still verifies", async () => {
    const ctx = createSystemCtx();
    const before = await mintAccessToken(env, ctx, { orgId: ORG, userId });

    const rotated = await rotateSigningKey(env, ctx);
    expect(rotated.retired).not.toBeNull();

    // The whole point of the retiring window. Rotation that invalidates live tokens is rotation
    // nobody performs.
    const stillValid = await verifyAccessToken(env, before.token, Date.now());
    expect(stillValid.ok).toBe(true);

    const after = await mintAccessToken(env, ctx, { orgId: ORG, userId });
    const afterHeader = JSON.parse(atob(after.token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(afterHeader.kid).toBe(rotated.kid);
    expect(afterHeader.kid).not.toBe(rotated.retired);
  });

  it("stops verifying once the retiring window has closed", async () => {
    const ctx = createSystemCtx();
    const before = await mintAccessToken(env, ctx, { orgId: ORG, userId });
    await rotateSigningKey(env, ctx);
    clearKeyCache();

    const past = Date.now() + BUDGETS["auth.signing_key_verify_grace_seconds"] * 1000 + 60_000;
    const result = await verifyAccessToken(env, before.token, past);
    expect(result.ok).toBe(false);
    // Whichever it trips first, the key must no longer be usable.
    if (!result.ok) expect(["unknown_key", "expired"]).toContain(result.reason);
  });

  it("never stores a usable private key: a D1 dump cannot mint tokens", async () => {
    const ctx = createSystemCtx();
    await currentSigningKey(env, ctx);
    const row = await env.CATALOG.prepare(
      "SELECT public_jwk, private_jwk_wrapped FROM signing_keys LIMIT 1",
    ).first<{ public_jwk: string; private_jwk_wrapped: string }>();

    // `d` is the ECDSA private scalar. Its presence in the row would mean the table *is* the key.
    expect(JSON.parse(row!.public_jwk).d).toBeUndefined();
    expect(row!.private_jwk_wrapped).not.toContain('"d"');
    expect(atob(row!.private_jwk_wrapped).startsWith("MLDA")).toBe(true);
  });

  it("publishes verification keys, and only verification keys", async () => {
    const ctx = createSystemCtx();
    await currentSigningKey(env, ctx);
    await rotateSigningKey(env, ctx);

    const jwks = await publicJwks(env, Date.now());
    expect(jwks.keys.length).toBe(2); // current + retiring
    for (const key of jwks.keys) {
      expect(key.alg).toBe("ES256");
      expect(key.crv).toBe("P-256");
      expect(key.d).toBeUndefined();
    }
  });
});

describe("sign-in", () => {
  it("signs a user in with the right password", async () => {
    const outcome = await login(env, createSystemCtx(), ORG, EMAIL, PASSWORD);
    expect(outcome.status).toBe("signed_in");
    if (outcome.status !== "signed_in") return;
    expect((await verifyAccessToken(env, outcome.session.accessToken, Date.now())).ok).toBe(true);
  });

  it("normalises the email, so casing and stray spaces still sign in", async () => {
    const outcome = await login(env, createSystemCtx(), ORG, "  Owner@Example.COM ", PASSWORD);
    expect(outcome.status).toBe("signed_in");
  });

  it("does not reveal whether an address exists", async () => {
    const ctx = createSystemCtx();
    const wrongPassword = await login(env, ctx, ORG, EMAIL, "wrong-but-long-enough");
    const noSuchUser = await login(env, ctx, ORG, "nobody@example.com", "wrong-but-long-enough");
    expect(wrongPassword.status).toBe("invalid_credentials");
    expect(noSuchUser.status).toBe("invalid_credentials");
  });

  it("locks out after the measured number of failures, and says for how long", async () => {
    const ctx = createSystemCtx();
    const max = BUDGETS["auth.max_failed_logins_per_15min"];
    for (let attempt = 0; attempt < max; attempt++) {
      expect((await login(env, ctx, ORG, EMAIL, "wrong-but-long-enough")).status).toBe("invalid_credentials");
    }

    const locked = await login(env, ctx, ORG, EMAIL, "wrong-but-long-enough");
    expect(locked.status).toBe("locked_out");
    if (locked.status === "locked_out") expect(locked.retryAfterSeconds).toBeGreaterThan(0);

    // And the lockout holds even against the *correct* password — otherwise it is not a lockout.
    expect((await login(env, ctx, ORG, EMAIL, PASSWORD)).status).toBe("locked_out");
  });

  it("clears the failure count on success, so a typo is not punished", async () => {
    const ctx = createSystemCtx();
    await login(env, ctx, ORG, EMAIL, "wrong-but-long-enough");
    await login(env, ctx, ORG, EMAIL, "wrong-but-long-enough");
    expect((await login(env, ctx, ORG, EMAIL, PASSWORD)).status).toBe("signed_in");

    const remaining = await env.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM login_attempts WHERE org_id = ? AND email = ?",
    ).bind(ORG, EMAIL).first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it("counts failures in the database, so a fresh isolate cannot reset them", async () => {
    const ctx = createSystemCtx();
    await login(env, ctx, ORG, EMAIL, "wrong-but-long-enough");
    const rows = await env.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM login_attempts WHERE org_id = ? AND email = ?",
    ).bind(ORG, EMAIL).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("upgrades a verifier that was made under less work, transparently", async () => {
    const ctx = createSystemCtx();

    // A one-round verifier, as an install predating the round count would have stored. Derived
    // honestly at that cost, so it genuinely verifies.
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const roundSalt = new Uint8Array(17);
    roundSalt.set(salt, 0);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: roundSalt, iterations: 100_000 }, key, 256,
    );
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const legacy = `pbkdf2-sha256$r=1$i=100000$${b64(salt)}$${b64(new Uint8Array(bits))}`;

    await env.CATALOG.prepare("UPDATE users SET password_hash = ?, password_iterations = ? WHERE id = ?")
      .bind(legacy, 100_000, userId).run();

    expect((await login(env, ctx, ORG, EMAIL, PASSWORD)).status).toBe("signed_in");

    const after = await env.CATALOG.prepare("SELECT password_hash, password_iterations FROM users WHERE id = ?")
      .bind(userId).first<{ password_hash: string; password_iterations: number }>();
    expect(after?.password_iterations).toBe(BUDGETS["auth.pbkdf2_effective_iterations"]);
    expect(after?.password_hash).toContain(`r=${BUDGETS["auth.pbkdf2_rounds"]}`);
    // And the upgraded verifier still accepts the same password.
    expect((await login(env, ctx, ORG, EMAIL, PASSWORD)).status).toBe("signed_in");
  });

  it("refuses a user with no password, without saying so", async () => {
    const ctx = createSystemCtx();
    const other = ctx.id("usr");
    await env.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(other, ORG, "nopass@example.com", new Date(ctx.now()).toISOString()).run();

    const outcome = await login(env, ctx, ORG, "nopass@example.com", PASSWORD);
    expect(outcome.status).toBe("no_password_set");
  });

  it("accepts a password set afterwards", async () => {
    const ctx = createSystemCtx();
    await setPassword(env, ctx, userId, "an-entirely-different-passphrase");
    expect((await login(env, ctx, ORG, EMAIL, PASSWORD)).status).toBe("invalid_credentials");
    expect((await login(env, ctx, ORG, EMAIL, "an-entirely-different-passphrase")).status).toBe("signed_in");
  });
});

describe("refresh token rotation", () => {
  it("rotates on use: the presented token stops working, the successor works", async () => {
    const ctx = createSystemCtx();
    const first = await issueSession(env, ctx, { orgId: ORG, userId });

    const rotated = await refreshSession(env, ctx, first.refreshToken);
    expect(rotated.status).toBe("rotated");
    if (rotated.status !== "rotated") return;
    expect(rotated.session.refreshToken).not.toBe(first.refreshToken);

    const second = await refreshSession(env, ctx, rotated.session.refreshToken);
    expect(second.status).toBe("rotated");
  });

  it("replays the same successor inside the window, instead of signing the user out", async () => {
    const ctx = createSystemCtx();
    const first = await issueSession(env, ctx, { orgId: ORG, userId });
    const rotated = await refreshSession(env, ctx, first.refreshToken);
    if (rotated.status !== "rotated") throw new Error("expected a rotation");

    // The client never received the response and retried. This is a dropped packet, not a theft,
    // and treating it as theft is what signs people out for having flaky wifi.
    const retry = await refreshSession(env, ctx, first.refreshToken);
    expect(retry.status).toBe("replayed");
    if (retry.status !== "replayed") return;
    expect(retry.session.refreshToken).toBe(rotated.session.refreshToken);

    // And the family is still alive.
    const alive = await refreshSession(env, ctx, rotated.session.refreshToken);
    expect(alive.status).toBe("rotated");
  });

  it("survives two simultaneous refreshes with the same token", async () => {
    const ctx = createSystemCtx();
    const first = await issueSession(env, ctx, { orgId: ORG, userId });

    // Two tabs, same moment. Exactly one rotation must happen and both callers must come away
    // holding the *same* live token — anything else logs the user out for opening a second tab.
    const [a, b] = await Promise.all([
      refreshSession(env, ctx, first.refreshToken),
      refreshSession(env, ctx, first.refreshToken),
    ]);

    const tokens = [a, b].map((r) => ("session" in r ? r.session.refreshToken : null));
    expect(tokens[0]).not.toBeNull();
    expect(tokens[1]).toBe(tokens[0]);

    const live = await env.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM refresh_tokens WHERE org_id = ? AND used_at IS NULL AND revoked_at IS NULL",
    ).bind(ORG).first<{ n: number }>();
    // One unused token, not two: the gated insert stops the losing race from leaving a live token
    // that nobody holds.
    expect(live?.n).toBe(1);
  });

  it("revokes the whole family when a used token reappears after the window", async () => {
    const at = 2_000_000_000_000;
    const first = await issueSession(env, atTime(at), { orgId: ORG, userId });
    const rotated = await refreshSession(env, atTime(at + 1000), first.refreshToken);
    if (rotated.status !== "rotated") throw new Error("expected a rotation");

    const past = at + BUDGETS["auth.refresh_replay_window_seconds"] * 1000 + 5_000;
    const reused = await refreshSession(env, atTime(past), first.refreshToken);
    expect(reused.status).toBe("reuse_detected");

    // The successor dies with it. A captured token means we cannot tell which holder is genuine,
    // so neither one continues.
    const successor = await refreshSession(env, atTime(past + 1000), rotated.session.refreshToken);
    expect(successor.status).toBe("reuse_detected");
  });

  it("refuses an unknown token and an expired one, distinctly", async () => {
    const ctx = createSystemCtx();
    expect((await refreshSession(env, ctx, "0".repeat(64))).status).toBe("unknown");

    const stale = await issueSession(env, atTime(1_000_000_000_000), { orgId: ORG, userId });
    expect((await refreshSession(env, createSystemCtx(), stale.refreshToken)).status).toBe("expired");
  });

  it("signs out one device, leaving other sessions alone", async () => {
    const ctx = createSystemCtx();
    const laptop = await issueSession(env, ctx, { orgId: ORG, userId });
    const phone = await issueSession(env, ctx, { orgId: ORG, userId });

    await signOut(env, ctx, laptop.refreshToken);
    expect((await refreshSession(env, ctx, laptop.refreshToken)).status).toBe("reuse_detected");
    expect((await refreshSession(env, ctx, phone.refreshToken)).status).toBe("rotated");
  });

  it("signs out everywhere — what §28 needs for a departing employee", async () => {
    const ctx = createSystemCtx();
    const laptop = await issueSession(env, ctx, { orgId: ORG, userId });
    const phone = await issueSession(env, ctx, { orgId: ORG, userId });

    expect(await revokeAllSessions(env, ctx, ORG, userId)).toBe(2);
    expect((await refreshSession(env, ctx, laptop.refreshToken)).status).toBe("reuse_detected");
    expect((await refreshSession(env, ctx, phone.refreshToken)).status).toBe("reuse_detected");
  });

  it("clears the replay successor once its window has closed", async () => {
    const at = 2_100_000_000_000;
    const first = await issueSession(env, atTime(at), { orgId: ORG, userId });
    const rotated = await refreshSession(env, atTime(at + 1000), first.refreshToken);
    if (rotated.status !== "rotated") throw new Error("expected a rotation");

    // A later refresh sweeps stale successors, so the widened window does not stay open forever.
    const later = at + BUDGETS["auth.refresh_replay_window_seconds"] * 1000 + 10_000;
    await refreshSession(env, atTime(later), rotated.session.refreshToken);

    const parent = await env.CATALOG.prepare(
      "SELECT replaced_by_wrapped FROM refresh_tokens WHERE token_hash = ?",
    )
      .bind([...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(first.refreshToken)))]
        .map((b) => b.toString(16).padStart(2, "0")).join(""))
      .first<{ replaced_by_wrapped: string | null }>();
    expect(parent?.replaced_by_wrapped).toBeNull();
  });

  it("stores no plaintext refresh token anywhere in the table", async () => {
    const ctx = createSystemCtx();
    const session = await issueSession(env, ctx, { orgId: ORG, userId });
    await refreshSession(env, ctx, session.refreshToken);

    const rows = await env.CATALOG.prepare("SELECT * FROM refresh_tokens").all();
    expect(JSON.stringify(rows.results)).not.toContain(session.refreshToken);
  });
});

describe("session cookies", () => {
  it("keeps the credentials script-invisible and the expiry visible", async () => {
    const ctx = createSystemCtx();
    const cookies = sessionCookies(await issueSession(env, ctx, { orgId: ORG, userId }));

    const access = cookies.find((c) => c.startsWith(`${ACCESS_COOKIE}=`))!;
    const refresh = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE}=`))!;
    const expiry = cookies.find((c) => c.startsWith(`${EXPIRY_COOKIE}=`))!;

    for (const cookie of [access, refresh]) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      // Lax withholds the cookie from a cross-site POST, which is what makes the state-changing
      // endpoints CSRF-safe without a separate token.
      expect(cookie).toContain("SameSite=Lax");
    }

    // Scoped, so it is not attached to every request. A token that is not sent cannot leak from a
    // log or a mis-proxied request.
    expect(refresh).toContain("Path=/api/auth");

    // Readable by the page, because the client has to see expiry coming to refresh ahead of it.
    // It carries one integer and no authority.
    expect(expiry).not.toContain("HttpOnly");
    expect(Number(expiry.split(";")[0]!.split("=")[1])).toBeGreaterThan(Date.now());
  });
});
