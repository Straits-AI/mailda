import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { issueSession } from "../src/auth/session.ts";
import { mintChallenge, spendChallenge } from "../src/auth/passkey.ts";
import { SoftwareAuthenticator } from "./authenticator.ts";

/**
 * Passkeys, end to end (#84, ADR 29).
 *
 * ADR 29 locks *"passkeys are the authentication Mailda builds; password authentication survives as a
 * per-user fallback"* and shipped inverted. These tests are what make the correction real rather than
 * written down.
 *
 * ## Driven through `SELF.fetch`, and a real authenticator
 *
 * The ceremonies are HTTP, so they are exercised as HTTP — a unit test of the verification function would
 * skip the challenge routes, which is where the anti-replay property lives. And `test/authenticator.ts`
 * holds a real P-256 key and signs real assertions, because the negative cases are the whole point: a
 * recorded fixture proves one response verifies and can never answer *"does a replay fail"*.
 */

const testEnv = env as unknown as Env;
const ORG = "org_pk";
const USER = "usr_pk";
const ORIGIN = "https://node";
const RP_ID = "node";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

const T0 = Date.parse("2026-08-22T09:00:00.000Z");

beforeEach(async () => {
  for (const table of [
    "credentials", "webauthn_challenges", "refresh_tokens", "audit_entries", "log_entries",
    "relationship_tuples", "users", "node_claim",
  ]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const at = new Date(T0).toISOString();
  await testEnv.CATALOG.prepare(
    "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(USER, ORG, "person@local.invalid", at).run();
  await testEnv.CATALOG.prepare(
    "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('claim','x',?,?)",
  ).bind(at, ORG).run();
});

/**
 * A signed-in caller, as cookies.
 *
 * **The real clock, not `atTime(T0)`.** The routes below run inside the Worker, which verifies a token
 * against `Date.now()` — so a session minted at a fixed 2026-08-22T09:00 arrives expired whenever the suite
 * happens to run later that day, and every request 401s. The fixed clock is right for the two tests that
 * drive `mintChallenge`/`spendChallenge` **directly**, where both ends share it, and wrong for anything that
 * crosses an HTTP boundary.
 */
async function signedIn(): Promise<string> {
  const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId: USER });
  return `mailda_at=${session.accessToken}`;
}

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return await SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  });
}

/** Registers one passkey and returns the authenticator that holds it. */
async function registered(cookie: string, label = "work laptop"): Promise<SoftwareAuthenticator> {
  const challenged = await post("/api/auth/passkeys/challenge", { purpose: "register" }, cookie);
  expect(challenged.status, await challenged.clone().text()).toBe(200);
  const { publicKey } = await challenged.json() as { publicKey: { challenge: string } };
  const authenticator = new SoftwareAuthenticator();
  const ceremony = await authenticator.register(publicKey.challenge, RP_ID, ORIGIN);
  const done = await post("/api/auth/passkeys", { credential: ceremony.credential, label }, cookie);
  expect(done.status, await done.text()).toBe(200);
  return authenticator;
}

describe("a person can register a passkey and sign in with it", () => {
  it("completes both ceremonies and issues a session", async () => {
    /*
     * The claim ADR 29 makes, exercised rather than asserted: a real key, a real signature, over the real
     * routes, ending in a session indistinguishable from the one a password produces.
     */
    const cookie = await signedIn();
    const authenticator = await registered(cookie);

    const challenged = await post("/api/auth/passkeys/challenge", { purpose: "authenticate" });
    const { publicKey } = await challenged.json() as { publicKey: { challenge: string } };
    const ceremony = await authenticator.authenticate(publicKey.challenge, RP_ID, ORIGIN);

    const verified = await post("/api/auth/passkeys/verify", { credential: ceremony.credential });
    expect(verified.status, await verified.clone().text()).toBe(200);
    const answer = await verified.json() as { signedIn: boolean; userId: string };
    expect(answer).toMatchObject({ signedIn: true, userId: USER });
    // The same cookies a password sign-in sets: nothing downstream learns which mechanism was used.
    expect(verified.headers.get("set-cookie")).toContain("mailda_at=");
  });

  it("authenticates without being told who the caller is", async () => {
    /*
     * The property that keeps this route from answering *"does this address have a passkey"*. Nothing in the
     * authentication request names an account — no email, no user id, no `allowCredentials` — and the
     * credential id is what identifies it. A route that took an address first would be a user-enumeration
     * oracle, which is what `login` goes to some trouble to avoid.
     */
    const cookie = await signedIn();
    const authenticator = await registered(cookie);

    const challenged = await post("/api/auth/passkeys/challenge", { purpose: "authenticate" });
    const body = await challenged.json() as { publicKey: Record<string, unknown> };
    expect(body.publicKey.allowCredentials).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(USER);

    const ceremony = await authenticator.authenticate(String(body.publicKey.challenge), RP_ID, ORIGIN);
    expect((await post("/api/auth/passkeys/verify", { credential: ceremony.credential })).status).toBe(200);
  });

  it("records the registration in the audit trail and the sign-in in the log", async () => {
    /*
     * The split is the decision: **adding** a way in is an act on an account and belongs in the permanent
     * record; **using** one is operational. `access.granted` is the shape of the first, `auth.signed_in` of
     * the second.
     */
    const cookie = await signedIn();
    const authenticator = await registered(cookie);
    const challenged = await post("/api/auth/passkeys/challenge", { purpose: "authenticate" });
    const { publicKey } = await challenged.json() as { publicKey: { challenge: string } };
    await post("/api/auth/passkeys/verify", {
      credential: (await authenticator.authenticate(publicKey.challenge, RP_ID, ORIGIN)).credential,
    });

    const audited = await testEnv.CATALOG.prepare(
      "SELECT action, detail FROM audit_entries WHERE org_id = ? ORDER BY seq",
    ).bind(ORG).all<{ action: string; detail: string }>();
    expect(audited.results.map((row) => row.action)).toContain("auth.passkey_registered");
    // The label and the credential id, never the public key.
    expect(audited.results.map((row) => row.detail).join(" ")).toContain("work laptop");

    const logged = await testEnv.CATALOG.prepare(
      "SELECT event, detail FROM log_entries ORDER BY id DESC LIMIT 5",
    ).all<{ event: string; detail: string }>();
    const signIn = logged.results.find((row) => row.event === "auth.signed_in");
    expect(signIn?.detail).toContain("passkey");
  });
});

describe("the challenge is what makes the ceremony replay-proof", () => {
  it("refuses a second use of one challenge", async () => {
    /*
     * The single most important negative in this file. A challenge is minted here, spent once and deleted in
     * the act of spending it — so an intercepted assertion is worthless the moment it has been used, which
     * is the entire anti-replay design.
     */
    const cookie = await signedIn();
    const authenticator = await registered(cookie);
    const challenged = await post("/api/auth/passkeys/challenge", { purpose: "authenticate" });
    const { publicKey } = await challenged.json() as { publicKey: { challenge: string } };
    const ceremony = await authenticator.authenticate(publicKey.challenge, RP_ID, ORIGIN);

    expect((await post("/api/auth/passkeys/verify", { credential: ceremony.credential })).status).toBe(200);

    const replayed = await post("/api/auth/passkeys/verify", { credential: ceremony.credential });
    expect(replayed.status).toBe(422);
    expect(await replayed.text()).toContain("E_CHALLENGE_UNUSABLE");
  });

  it("refuses a challenge this Node never issued", async () => {
    const cookie = await signedIn();
    const authenticator = await registered(cookie);
    const ceremony = await authenticator.authenticate("a-challenge-nobody-minted", RP_ID, ORIGIN);
    const answer = await post("/api/auth/passkeys/verify", { credential: ceremony.credential });
    expect(answer.status).toBe(422);
    expect(await answer.text()).toContain("E_CHALLENGE_UNUSABLE");
  });

  it("refuses a registration challenge presented as an authentication", async () => {
    /*
     * The reason `purpose` is a column. A registration challenge is handed to a caller who is *already*
     * signed in — but without this, it would be redeemable at the unauthenticated verify route, which is a
     * challenge-confusion bypass rather than an inconvenience.
     */
    const cookie = await signedIn();
    const authenticator = await registered(cookie);
    const challenged = await post("/api/auth/passkeys/challenge", { purpose: "register" }, cookie);
    const { publicKey } = await challenged.json() as { publicKey: { challenge: string } };

    const ceremony = await authenticator.authenticate(publicKey.challenge, RP_ID, ORIGIN);
    const answer = await post("/api/auth/passkeys/verify", { credential: ceremony.credential });
    expect(answer.status).toBe(422);
  });

  it("refuses an expired challenge, and expiry is checked rather than swept", async () => {
    /*
     * The sweep bounds the *table*; this bounds the *credential*. A row can outlive its expiry until the
     * next mint, so trusting the sweep would leave a stale challenge redeemable for as long as nobody
     * started another ceremony.
     */
    const ctx = atTime(T0);
    const challenge = await mintChallenge(testEnv, ctx, "authenticate", null);
    const later = atTime(T0 + 301_000);   // auth.passkey_challenge_ttl_seconds is 300
    await expect(spendChallenge(testEnv, later, challenge, "authenticate"))
      .rejects.toThrow(/E_CHALLENGE_UNUSABLE/);
  });

  it("sweeps expired challenges when the next one is minted", async () => {
    await mintChallenge(testEnv, atTime(T0), "authenticate", null);
    expect(await challengeCount()).toBe(1);
    await mintChallenge(testEnv, atTime(T0 + 301_000), "authenticate", null);
    // The first is gone, the second is there: the sweep rides on the only write this table takes.
    expect(await challengeCount()).toBe(1);
  });
});

describe("a wrong signature, origin or credential is refused, and says nothing about which", () => {
  it("refuses an assertion signed for a different origin", async () => {
    /*
     * The origin check is what stops a lookalike site relaying a ceremony. The authenticator here signs for
     * `https://evil.example`, and everything else about the response is correct — which is exactly the shape
     * of the attack.
     */
    const cookie = await signedIn();
    const authenticator = await registered(cookie);
    const challenged = await post("/api/auth/passkeys/challenge", { purpose: "authenticate" });
    const { publicKey } = await challenged.json() as { publicKey: { challenge: string } };

    const ceremony = await authenticator.authenticate(publicKey.challenge, RP_ID, "https://evil.example");
    const answer = await post("/api/auth/passkeys/verify", { credential: ceremony.credential });
    expect(answer.status).toBe(422);
    expect(await answer.text()).toContain("E_PASSKEY_REJECTED");
  });

  it("refuses an assertion signed for a different relying party", async () => {
    const cookie = await signedIn();
    const authenticator = await registered(cookie);
    const challenged = await post("/api/auth/passkeys/challenge", { purpose: "authenticate" });
    const { publicKey } = await challenged.json() as { publicKey: { challenge: string } };

    // Right origin, wrong RP id hash inside authData — the two are checked separately and both must hold.
    const ceremony = await authenticator.authenticate(publicKey.challenge, "evil.example", ORIGIN);
    expect((await post("/api/auth/passkeys/verify", { credential: ceremony.credential })).status).toBe(422);
  });

  it("refuses a credential this Node has never seen, in the same words as a bad signature", async () => {
    /*
     * §5C applied to authentication: distinguishing "no such credential" from "wrong signature" tells an
     * anonymous caller whether a credential exists. Both are `E_PASSKEY_REJECTED`.
     */
    const stranger = new SoftwareAuthenticator("never-registered");
    const challenged = await post("/api/auth/passkeys/challenge", { purpose: "authenticate" });
    const { publicKey } = await challenged.json() as { publicKey: { challenge: string } };
    const ceremony = await stranger.authenticate(publicKey.challenge, RP_ID, ORIGIN);

    const answer = await post("/api/auth/passkeys/verify", { credential: ceremony.credential });
    expect(answer.status).toBe(422);
    expect(await answer.text()).toContain("E_PASSKEY_REJECTED");
  });
});

describe("credentials are the account holder's, and only theirs", () => {
  it("lists them without ever returning a public key", async () => {
    const cookie = await signedIn();
    await registered(cookie, "work laptop");
    const listed = await SELF.fetch(`${ORIGIN}/api/auth/passkeys`, { headers: { cookie } });
    const body = await listed.text();
    expect(body).toContain("work laptop");
    expect(body).not.toContain("publicKey");
    expect(body).not.toContain("public_key");
  });

  it("revokes one, and records it in the same transaction", async () => {
    const cookie = await signedIn();
    const authenticator = await registered(cookie);
    const gone = await SELF.fetch(`${ORIGIN}/api/auth/passkeys`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: authenticator.id }),
    });
    expect(gone.status).toBe(200);

    const audited = await testEnv.CATALOG.prepare(
      "SELECT action FROM audit_entries WHERE org_id = ? ORDER BY seq",
    ).bind(ORG).all<{ action: string }>();
    expect(audited.results.map((row) => row.action)).toContain("auth.passkey_revoked");
    expect(await credentialCount()).toBe(0);
  });

  it("refuses to revoke a credential that exists and belongs to somebody else", async () => {
    /*
     * **The first version of this test was vacuous and a mutation found it.** It asked to revoke an id that
     * did not exist at all, so removing `user_id` from the delete's predicate — the line that binds a
     * credential to its owner — changed nothing and the test stayed green. An id that matches no row is
     * deleted by zero statements either way.
     *
     * So the credential here is **real and somebody else's**. That is the only shape that distinguishes a
     * statement bound to its owner from one that is not, and it is the difference between a passkey being
     * revocable by its holder and by any signed-in colleague.
     */
    const cookie = await signedIn();
    await registered(cookie);
    const at = new Date(T0).toISOString();
    await testEnv.CATALOG.prepare(
      `INSERT INTO credentials
         (id, user_id, org_id, public_key, sign_count, transports, label, created_at, last_used_at)
       VALUES ('someone-elses-key','usr_other',?,'k',0,'[]','their phone',?,NULL)`,
    ).bind(ORG, at).run();

    const answer = await SELF.fetch(`${ORIGIN}/api/auth/passkeys`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "someone-elses-key" }),
    });
    // Not-found rather than forbidden: a credential belonging to somebody else and one that never existed
    // answer identically (§5C).
    expect(answer.status).toBe(404);
    expect(await credentialCount()).toBe(2);
  });

  it("refuses registration to somebody who is not signed in", async () => {
    // Registration adds a way into an account, so it takes proof of being in that account already.
    expect((await post("/api/auth/passkeys/challenge", { purpose: "register" })).status).toBe(401);
    expect((await post("/api/auth/passkeys", { credential: {} })).status).toBe(401);
  });
});

describe("what passkeys do not change (#84's two open questions)", () => {
  it("leaves dual control counting people, not credentials", async () => {
    /*
     * #84 asked whether a passkey satisfies dual control. It does, and nothing moves — asserted here rather
     * than left as an assumption somebody rediscovers.
     *
     * §18 and #61 count **distinct people**. Authentication strength is orthogonal to identity: a passkey
     * does not make one person two, and a password does not make them half. The way to state that in a test
     * is that the credentials table names a `user_id` and nothing downstream of authentication can see which
     * mechanism was used — the session a passkey issues is byte-identical in shape to the one a password
     * issues, which is what makes every counting rule indifferent to it.
     */
    const cookie = await signedIn();
    const authenticator = await registered(cookie);
    const challenged = await post("/api/auth/passkeys/challenge", { purpose: "authenticate" });
    const { publicKey } = await challenged.json() as { publicKey: { challenge: string } };
    const verified = await post("/api/auth/passkeys/verify", {
      credential: (await authenticator.authenticate(publicKey.challenge, RP_ID, ORIGIN)).credential,
    });

    const session = await verified.json() as Record<string, unknown>;
    // The same fields `POST /api/auth/login` answers with. No mechanism, no credential strength, nothing a
    // separation-of-duty rule could branch on even if somebody wanted it to.
    expect(Object.keys(session).sort()).toEqual(
      ["accessExpiresAt", "credentialId", "organizationId", "signedIn", "userId"],
    );
    /*
     * And the durable half is bound to a **person**: `refresh_tokens` is what a session actually persists —
     * the `sessions` table is not what `prepareSession` writes, which is worth knowing — and its row names a
     * `user_id` and nothing about how that person proved who they were.
     */
    const stored = await testEnv.CATALOG.prepare(
      "SELECT user_id FROM refresh_tokens WHERE org_id = ? ORDER BY created_at DESC LIMIT 1",
    ).bind(ORG).first<{ user_id: string }>();
    expect(stored?.user_id).toBe(USER);
  });

  it("leaves the password in place as the fallback, which is the recovery path", async () => {
    /*
     * #84's other question: with passkeys primary, does `mailda set-password` — which runs outside the audit
     * trail — become the ordinary recovery route for every account?
     *
     * Only if passwords are **removed**, and ADR 29 explicitly does not remove them: *"password
     * authentication survives as a per-user fallback."* Registering a passkey therefore leaves the password
     * path untouched, and this asserts it rather than trusting that nothing was changed.
     */
    const cookie = await signedIn();
    await registered(cookie);
    // The password route still exists and still refuses a wrong one in the same words as before — nothing
    // about registering a passkey disabled or altered it.
    const answer = await post("/api/auth/login", { email: "person@local.invalid", password: "wrong" });
    expect(answer.status).toBe(401);
    expect(await answer.text()).toContain("invalid_credentials");
  });
});

async function challengeCount(): Promise<number> {
  const row = await testEnv.CATALOG.prepare(
    "SELECT COUNT(*) AS n FROM webauthn_challenges",
  ).first<{ n: number }>();
  return row?.n ?? -1;
}

async function credentialCount(): Promise<number> {
  const row = await testEnv.CATALOG.prepare(
    "SELECT COUNT(*) AS n FROM credentials",
  ).first<{ n: number }>();
  return row?.n ?? -1;
}
