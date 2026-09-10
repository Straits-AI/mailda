import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unwrapCredential } from "../src/auth/kek.ts";
import {
  beginAuthorization, ceremony, CLOUDFLARE_OAUTH, completeAuthorization, MIN_STATE_LENGTH,
  cloudflareGet, deliveryEventsState, PROVIDER_STATES, providerStatus, registerClient,
  reportUnselectable, resolveAccount,
  STATUS_COLUMNS,
  type ProviderState,
} from "../src/provider/cloudflare-grant.ts";

/**
 * The Node's own Cloudflare grant (#162 L1, ADR 42).
 *
 * ## What these tests are about, which is not "does the OAuth dance work"
 *
 * Three properties, and all three are honesty rather than mechanism:
 *
 * 1. **A state means what it says.** #162's whole point is that `connecting / success / failed` is a lie about
 *    a flow with nine outcomes. The one that matters most is `account_not_selectable`, which the Node **cannot
 *    observe** — an administrator disabling public OAuth app access produces an account absent from a consent
 *    screen, with no error and no response the Node ever sees. So it is reported, and a test has to hold the
 *    line that it is never inferred.
 * 2. **No secret leaves.** The client secret, the access token, the refresh token and the PKCE verifier are
 *    wrapped, and the status surface is the thing an operator and `doctor` both read. A status read that
 *    decrypted anything, or returned it, would put the account's provisioning authority in every place a
 *    status is displayed.
 * 3. **A refusal is not a connection.** A declined consent, an expired nonce, a replayed code and an
 *    unreachable token endpoint are four different things, and three of them must leave the binding exactly as
 *    it was. The dangerous direction is the one where any of them writes a grant.
 */

const testEnv = env as unknown as Env;

const ORG = "org_provider";
const ADMIN = "usr_provider_admin";
const SEPTEMBER_3 = Date.parse("2026-09-03T10:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

beforeEach(async () => {
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("DELETE FROM provider_authorizations"),
    testEnv.CATALOG.prepare("DELETE FROM provider_binding"),
    testEnv.CATALOG.prepare("DELETE FROM users WHERE id = ?").bind(ADMIN),
  ]);
  await testEnv.CATALOG.prepare(
    "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(ADMIN, ORG, "admin@example.test", new Date(SEPTEMBER_3).toISOString()).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const REDIRECT = "https://mailda.example.workers.dev/oauth/cloudflare/callback";

async function register(at = SEPTEMBER_3): Promise<void> {
  await registerClient(testEnv, atTime(at), ORG, ADMIN, {
    clientId: "cf-client-id",
    clientSecret: "cf-client-secret",
    redirectUri: REDIRECT,
  });
}

/** A `fetch` that records what it was asked and answers what the test wants. */
function answering(status: number, body: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls };
}

describe("the states, and which of them the Node can observe", () => {
  it("reports no_client before anything, without inventing a client", async () => {
    const status = await providerStatus(testEnv);
    expect(status.state).toBe("no_client");
    expect(status.evidence).toBe("observed");
    expect(status.clientId).toBeNull();
    expect(status.accountId).toBeNull();
  });

  it("reports awaiting_consent once a client exists, which is a place and not a failure", async () => {
    await register();
    const status = await providerStatus(testEnv);
    expect(status.state).toBe("awaiting_consent");
    expect(status.evidence).toBe("observed");
    expect(status.clientId).toBe("cf-client-id");
    expect(status.redirectUri).toBe(REDIRECT);
    // No grant, and the surface says so rather than showing an empty account.
    expect(status.accountId).toBeNull();
    expect(status.grantedAt).toBeNull();
    expect(status.scopesGranted).toBeNull();
  });

  it("marks account_not_selectable as reported rather than observed", async () => {
    await register();
    await reportUnselectable(testEnv, atTime(SEPTEMBER_3 + 1000), ORG, ADMIN);

    const status = await providerStatus(testEnv);
    expect(status.state).toBe("account_not_selectable");
    /*
     * The assertion this whole state exists for. An administrator disabling public OAuth app access produces
     * a consent screen missing an account, with no error and no response the Node sees — so a Node that
     * returned `evidence: "observed"` here would be claiming a measurement it cannot make, and would tell an
     * operator who simply closed the tab that their administrator had disabled OAuth apps.
     */
    expect(status.evidence).toBe("reported");
  });

  it("refuses the report when a grant already exists, because it cannot be true", async () => {
    await register();
    answering(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "a offline_access" });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);
    await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });

    await expect(
      reportUnselectable(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, ADMIN),
    ).rejects.toThrow("E_PROVIDER_ALREADY_GRANTED");
  });

  it("keeps grant_refused distinct from awaiting_consent, tokens still in the row", async () => {
    await register();
    answering(200, {
      access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "a offline_access",
      account_id: "acc_revoked_later",
    });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);
    await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });

    // What a revocation in Cloudflare looks like from here: the grant is held and no longer works.
    await testEnv.CATALOG.prepare(
      "UPDATE provider_binding SET refused_at = ?, refused_detail = ? WHERE id = 1",
    ).bind(new Date(SEPTEMBER_3 + 3000).toISOString(), "invalid_grant").run();

    const status = await providerStatus(testEnv);
    expect(status.state).toBe("grant_refused");
    // Cloudflare's own words, not a paraphrase.
    expect(status.refusedDetail).toBe("invalid_grant");
    /*
     * The distinction the state exists for. *Never granted* and *granted and then refused* are different
     * questions, and a Node that cleared the row on a refusal would erase the second one — so `grantedAt`
     * survives, and it is what makes the difference legible.
     */
    expect(status.grantedAt).not.toBeNull();
    expect(status.accountId).not.toBeNull();
  });

  it("has a closed world of states, every member reachable and named", () => {
    /*
     * Not a restatement of the union. Five of #162's nine states belong to the layer that builds an inventory
     * and a plan, and this asserts they are **absent** — a state nothing can construct is a branch no test
     * can reach, and declaring all nine here would look like coverage of a flow that does not exist yet.
     */
    expect([...PROVIDER_STATES].sort()).toEqual([
      "account_not_selectable", "awaiting_consent", "consent_granted", "grant_refused", "no_client",
    ]);
    const notYet: string[] = [
      "inventory_read", "plan_produced", "partially_provisioned", "provisioned_unverified", "verified",
    ];
    for (const later of notYet) {
      expect(
        (PROVIDER_STATES as readonly string[]).includes(later),
        `${later} is declared but nothing in this layer can reach it`,
      ).toBe(false);
    }
    // And the union and the list agree, which a hand-maintained pair does not do for free.
    const exhaustive: Record<ProviderState, true> = {
      no_client: true, awaiting_consent: true, account_not_selectable: true,
      consent_granted: true, grant_refused: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual([...PROVIDER_STATES].sort());
  });
});

describe("what never leaves", () => {
  it("stores the client secret wrapped and never returns it", async () => {
    await register();

    const row = await testEnv.CATALOG.prepare(
      "SELECT client_secret FROM provider_binding WHERE id = 1",
    ).first<{ client_secret: string }>();
    expect(row?.client_secret).not.toBe("cf-client-secret");
    expect(row?.client_secret).toMatch(/^v\d+\./);
    expect(await unwrapCredential(testEnv, row!.client_secret)).toBe("cf-client-secret");

    // The surface an operator and `doctor` both read. Every field, checked against the secret's value.
    const status = await providerStatus(testEnv);
    expect(JSON.stringify(status)).not.toContain("cf-client-secret");
  });

  it("stores both grant tokens wrapped, and the status carries neither", async () => {
    await register();
    answering(200, {
      access_token: "the-access-token", refresh_token: "the-refresh-token",
      expires_in: 3600, scope: "a offline_access", account_id: "acc_from_response",
    });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);
    await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });

    const row = await testEnv.CATALOG.prepare(
      "SELECT access_token, refresh_token FROM provider_binding WHERE id = 1",
    ).first<{ access_token: string; refresh_token: string }>();
    expect(await unwrapCredential(testEnv, row!.access_token)).toBe("the-access-token");
    expect(await unwrapCredential(testEnv, row!.refresh_token)).toBe("the-refresh-token");

    const serialised = JSON.stringify(await providerStatus(testEnv));
    expect(serialised).not.toContain("the-access-token");
    expect(serialised).not.toContain("the-refresh-token");
  });

  it("stores the PKCE verifier wrapped, so a D1 dump plus a code is not an exchange", async () => {
    await register();
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);

    const row = await testEnv.CATALOG.prepare(
      "SELECT code_verifier FROM provider_authorizations WHERE state = ?",
    ).bind(state).first<{ code_verifier: string }>();
    expect(row?.code_verifier).toMatch(/^v\d+\./);
  });

  it("reads the status from a column list holding no secret", async () => {
    /*
     * Not a claim about performance. `providerStatus` is what `doctor` and every surface call, so a token
     * column arriving in its query would put the account's provisioning authority on the path that renders a
     * page, and would make the key vault a dependency of displaying one.
     *
     * Asserted against the exported constant rather than the module's text, because the first version of this
     * test regex-matched a source file it could not read in workerd, caught the failure, and passed on an
     * empty string — a test that checked nothing and reported green.
     */
    for (const secret of ["client_secret", "access_token", "refresh_token", "code_verifier"]) {
      expect(STATUS_COLUMNS, `${secret} is in the status query`).not.toContain(secret);
    }
    // And it is not vacuous: the columns the state *is* derived from are there.
    for (const needed of ["client_id", "granted_at", "refused_at", "unselectable_reported_at"]) {
      expect(STATUS_COLUMNS).toContain(needed);
    }
  });
});

describe("the authorization URL", () => {
  it("is built from the measured endpoint with PKCE and a long state", async () => {
    await register();
    const { url, state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a", "b"]);
    const parsed = new URL(url);

    expect(`${parsed.origin}${parsed.pathname}`).toBe(CLOUDFLARE_OAUTH.authorize);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("cf-client-id");
    // The registered URI, not one recomputed from a request — RFC 6749 requires the exchange to match it.
    expect(parsed.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).not.toBeNull();
    // The verifier is never in the URL; that is the whole of what PKCE buys.
    expect(url).not.toContain("code_verifier");
    /*
     * Cloudflare enforces a minimum of 8 and answers a shorter state by redirecting with
     * `error=invalid_state` and a message about entropy — which does not read like a configuration problem
     * (`cloudflare-oauth-node-as-client.md`).
     */
    expect(state.length).toBeGreaterThanOrEqual(MIN_STATE_LENGTH);
    expect(parsed.searchParams.get("state")).toBe(state);
  });

  it("adds no scope of its own, which one real consent settled", async () => {
    /*
     * This test asserted the opposite until 8 September 2026: `beginAuthorization` appended
     * `offline_access` to every request, on the argument that discovery's `scopes_supported` lists it and
     * that a refresh token needs it.
     *
     * A real consent refused the whole authorization:
     *
     *   invalid_scope — The OAuth 2.0 Client is not allowed to request scope 'offline_access'.
     *
     * `scopes_supported` describes the **server**; a client may request only what it was registered with,
     * and the dashboard's picker offers permission names rather than OIDC scopes. So the append did not add
     * a capability — it made every request refusable, for every operator following the Node's own steps.
     */
    await register();
    const { url } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);
    expect(new URL(url).searchParams.get("scope")).toBe("a");
  });

  it("omits the scope parameter entirely when it has none, rather than sending an empty one", async () => {
    /*
     * Not the same as `scope=`. RFC 6749 leaves a request that names no scope to the authorization server,
     * so Cloudflare applies the client's own registered scopes — which the operator chose in the dashboard's
     * picker, and which this Node deliberately does not know the names of.
     */
    await register();
    const { url } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["", " "]);
    expect(new URL(url).searchParams.has("scope")).toBe(false);
  });

  it("refuses to build one with no client, rather than producing a URL that cannot work", async () => {
    await expect(
      beginAuthorization(testEnv, atTime(SEPTEMBER_3), ADMIN, ["a"]),
    ).rejects.toThrow("E_PROVIDER_NO_CLIENT");
  });

  it("mints a different state and challenge every time", async () => {
    await register();
    const first = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);
    const second = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ADMIN, ["a"]);
    expect(first.state).not.toBe(second.state);
    expect(new URL(first.url).searchParams.get("code_challenge"))
      .not.toBe(new URL(second.url).searchParams.get("code_challenge"));
  });
});

describe("the callback, and the four ways it does not become a connection", () => {
  it("exchanges a code and records the scopes as granted", async () => {
    await register();
    const stub = answering(200, {
      access_token: "at", refresh_token: "rt", expires_in: 3600,
      // Cloudflare permits optional scopes to be declined: `b` was asked for and is not here.
      scope: "a offline_access",
      account_id: "acc_from_response",
    });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a", "b"]);
    const outcome = await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.scopesGranted).toEqual(["a", "offline_access"]);
    /*
     * The half a Node that recorded its *request* would get wrong: it would report an authority it does not
     * have, and the plan would be built from scopes nobody granted.
     */
    expect(outcome.scopesDeclined).toEqual(["b"]);

    expect(stub.calls[0]?.url).toBe(CLOUDFLARE_OAUTH.token);
    const headers = stub.calls[0]?.init.headers as Record<string, string>;
    // `client_secret_basic`, which discovery lists among the supported methods.
    expect(headers.authorization).toBe(`Basic ${btoa("cf-client-id:cf-client-secret")}`);
    const sent = new URLSearchParams(String(stub.calls[0]?.init.body));
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("redirect_uri")).toBe(REDIRECT);
    expect(sent.get("code_verifier")).not.toBeNull();

    const status = await providerStatus(testEnv);
    expect(status.state).toBe("consent_granted");
    expect(status.accountId).toBe("acc_from_response");
  });

  it("form-url-encodes the credential before base64, which the spec requires", async () => {
    /*
     * RFC 6749 §2.3.1: both the client id and the secret are encoded with the
     * `application/x-www-form-urlencoded` algorithm **before** they are joined and base64'd.
     *
     * The first version did not, and a real exchange answered `invalid_client` — *"client authentication
     * failed"* — **after a consent had already succeeded**. That is the worst place in this flow to fail: the
     * authorization code is single-use, so there is no retry and the operator has to consent again.
     *
     * It bites because a Cloudflare secret is base64-ish and routinely carries `+`, `/` and `=`. This server
     * is Ory Hydra, which enforces the encoding rather than decoding leniently — so the assertion uses a
     * secret containing exactly those characters.
     */
    await registerClient(testEnv, atTime(SEPTEMBER_3 + 100), ORG, ADMIN, {
      clientId: "cf/client+id", clientSecret: "sec+ret/with=chars", redirectUri: REDIRECT,
    });
    const stub = answering(200, { access_token: "at", scope: "a" });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 200), ADMIN, ["a"]);
    await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 300), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });

    const sent = (stub.calls[0]?.init.headers as Record<string, string>).authorization;
    expect(sent).toBe(`Basic ${btoa("cf%2Fclient%2Bid:sec%2Bret%2Fwith%3Dchars")}`);
    // And not the raw form, which is what failed against the real server.
    expect(sent).not.toBe(`Basic ${btoa("cf/client+id:sec+ret/with=chars")}`);
  });

  it("leaves the account null when the response does not name one, rather than guessing", async () => {
    await register();
    // Whether Cloudflare's token response carries the account is **not measured** — no Node has held a grant.
    answering(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "offline_access" });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, []);
    const outcome = await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.accountId).toBeNull();
    const status = await providerStatus(testEnv);
    // Connected, and honest that it does not yet know which account. Not an empty string standing in for one.
    expect(status.state).toBe("consent_granted");
    expect(status.accountId).toBeNull();
  });

  it("a declined consent writes no grant and leaves the operator where they were", async () => {
    await register();
    const stub = answering(200, { access_token: "should-never-be-requested" });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);

    const outcome = await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: null, error: "access_denied", errorDescription: "The user denied the request",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("access_denied");
    // The token endpoint was never called: there was nothing to exchange.
    expect(stub.calls).toHaveLength(0);
    // And the binding is untouched. `awaiting_consent` is exactly where the operator is.
    const status = await providerStatus(testEnv);
    expect(status.state).toBe("awaiting_consent");
    expect(status.grantedAt).toBeNull();
  });

  it("a token endpoint that refuses writes no grant", async () => {
    await register();
    answering(400, { error: "invalid_grant", error_description: "the code has expired" });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);

    const outcome = await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("invalid_grant");
    expect(outcome.detail).toBe("the code has expired");
    /*
     * Not `grant_refused`. That state means Cloudflare rejected a grant this Node *held*; a failed exchange
     * means it never got one, and conflating the two would tell an operator their connection had been revoked
     * when it had never been made.
     */
    expect((await providerStatus(testEnv)).state).toBe("awaiting_consent");
  });

  it("a 200 with no access token is a refusal, not a connection", async () => {
    await register();
    // The shape that would slip through a check on `response.ok` alone.
    answering(200, { token_type: "bearer" });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);

    const outcome = await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("http_200");
    expect((await providerStatus(testEnv)).state).toBe("awaiting_consent");
  });

  it("an unreachable token endpoint is an unknown and is recorded as neither", async () => {
    await register();
    vi.stubGlobal("fetch", async () => { throw new Error("socket closed"); });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);

    await expect(completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    })).rejects.toThrow("E_PROVIDER_EXCHANGE_UNREACHABLE");

    /*
     * The code is spent at Cloudflare's end and this Node cannot tell whether a grant was issued. Neither
     * `consent_granted` nor `grant_refused` is true, and the refusal says so rather than picking one — ADR
     * 40's distinction between a refusal and an unknown, in a second place.
     */
    expect((await providerStatus(testEnv)).state).toBe("awaiting_consent");
  });

  it("refuses a state it never issued", async () => {
    await register();
    await expect(completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ORG, {
      state: "not-a-state-this-node-issued", code: "the-code", error: null, errorDescription: null,
    })).rejects.toThrow("E_PROVIDER_STATE_UNKNOWN");
  });

  it("refuses a replayed code, and the row is what refuses it", async () => {
    await register();
    answering(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "offline_access" });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, []);
    await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });

    await expect(completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    })).rejects.toThrow("E_PROVIDER_STATE_CONSUMED");
  });

  it("lets exactly one of two racing callbacks through, and the row is what decides", async () => {
    await register();
    const stub = answering(200, {
      access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "offline_access",
    });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, []);

    /*
     * **This is the test the `AND consumed_at IS NULL` predicate exists for, and it was missing.**
     *
     * The sequential replay above is caught by the read that precedes the update, so a mutation deleting the
     * predicate left every assertion in this file passing. What the predicate actually decides is this: two
     * callbacks for one state, both of which read `consumed_at` as null before either writes. Without it both
     * proceed, both exchange the code, and the second overwrites the first's grant — two token requests for
     * one authorization.
     *
     * The comment in `completeAuthorization` claimed the predicate made racing callbacks resolve to one. It
     * was a claim about a property nothing measured, in a comment justifying the design, which is the same
     * defect #168 fixed one module along.
     */
    const both = await Promise.allSettled([
      completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
        state, code: "the-code", error: null, errorDescription: null,
      }),
      completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
        state, code: "the-code", error: null, errorDescription: null,
      }),
    ]);

    const fulfilled = both.filter((one) => one.status === "fulfilled");
    const rejected = both.filter((one) => one.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain("E_PROVIDER_STATE_CONSUMED");
    // One authorization, one exchange. Two would mean the code was spent twice at Cloudflare's end.
    expect(stub.calls).toHaveLength(1);
    expect((await providerStatus(testEnv)).state).toBe("consent_granted");
  });

  it("consumes the state before the exchange, so a failed exchange cannot be retried", async () => {
    await register();
    answering(400, { error: "invalid_grant" });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, []);
    await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });

    /*
     * The code is already spent at Cloudflare's end, so a state left open would only permit a retry that
     * could not succeed — and it would leave a verifier alive after its redirect.
     */
    answering(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 });
    await expect(completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    })).rejects.toThrow("E_PROVIDER_STATE_CONSUMED");
  });

  it("refuses an expired authorization", async () => {
    await register();
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, []);
    // Thirty-one minutes later. Was eleven, until a ten-minute window expired twice on one real consent —
    // the nonce's protection is being single-use, not being short-lived.
    await expect(completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 31 * 60 * 1000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    })).rejects.toThrow("E_PROVIDER_STATE_EXPIRED");
  });

  it("refuses a callback carrying neither a code nor an error", async () => {
    await register();
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, []);
    await expect(completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: null, error: null, errorDescription: null,
    })).rejects.toThrow("E_PROVIDER_NO_CODE");
  });
});

describe("re-registering the client", () => {
  it("discards the grant with it, because a grant belongs to the client that obtained it", async () => {
    await register();
    answering(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "offline_access" });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, []);
    await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });
    expect((await providerStatus(testEnv)).state).toBe("consent_granted");

    await registerClient(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, ADMIN, {
      clientId: "a-different-client", clientSecret: "a-different-secret", redirectUri: REDIRECT,
    });

    /*
     * Keeping the tokens would leave a row whose `client_id` did not issue its `refresh_token`, and the first
     * refresh would be refused with an error about the client — which an operator would read as a revocation.
     */
    const status = await providerStatus(testEnv);
    expect(status.state).toBe("awaiting_consent");
    expect(status.clientId).toBe("a-different-client");
    expect(status.grantedAt).toBeNull();
    expect(status.accountId).toBeNull();
  });

  it("discards a consent in flight, whose verifier the new client could never exchange", async () => {
    await register();
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, []);

    await registerClient(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, ADMIN, {
      clientId: "a-different-client", clientSecret: "a-different-secret", redirectUri: REDIRECT,
    });

    await expect(completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    })).rejects.toThrow("E_PROVIDER_STATE_UNKNOWN");
  });

  it("keeps a consumed authorization, because it is the record that one happened", async () => {
    await register();
    answering(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "offline_access" });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, []);
    await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });

    await registerClient(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, ADMIN, {
      clientId: "a-different-client", clientSecret: "a-different-secret", redirectUri: REDIRECT,
    });

    /*
     * `WHERE consumed_at IS NULL`. A consumed row is the record that an authorization was completed and by
     * whom it was started; deleting it would erase the difference between a consent that happened and one
     * that never did.
     */
    const kept = await testEnv.CATALOG.prepare(
      "SELECT started_by, consumed_at FROM provider_authorizations WHERE state = ?",
    ).bind(state).first<{ started_by: string; consumed_at: string }>();
    expect(kept?.started_by).toBe(ADMIN);
    expect(kept?.consumed_at).not.toBeNull();
  });

  it("refuses half a registration", async () => {
    await expect(registerClient(testEnv, atTime(SEPTEMBER_3), ORG, ADMIN, {
      clientId: "cf-client-id", clientSecret: "  ", redirectUri: REDIRECT,
    })).rejects.toThrow("E_PROVIDER_NEEDS_BOTH");
    // And nothing was written, so a failed paste does not leave a client that cannot exchange.
    expect((await providerStatus(testEnv)).state).toBe("no_client");
  });
});

describe("the guided ceremony", () => {
  it("carries the Node's own redirect URI and says which parts are unmeasured", () => {
    const printed = ceremony(REDIRECT);
    expect(printed.redirectUri).toBe(REDIRECT);
    expect(printed.steps.some((step) => step.includes(REDIRECT))).toBe(true);
    // Without `offline_access` the ceremony recurs, so the steps name it rather than leaving it to be found.
    // The steps still mention it — now to say Cloudflare adds it, rather than to warn against adding it.
    expect(printed.steps.some((step) => step.includes("offline_access"))).toBe(true);
    // Private, which is what keeps the grant the customer's — ADR 42's whole custody argument.
    expect(printed.steps.some((step) => step.toLowerCase().includes("private"))).toBe(true);

    /*
     * The honesty requirement, asserted rather than left to a docstring. #162 asks for the scope list
     * prefilled; this repository has seen two Cloudflare scope strings, both from a documentation example. An
     * operator following printed steps is entitled to know which parts of them the Node has verified, so the
     * ceremony says the scope names are not printed and names the call that would produce them.
     */
    // Still says what is unverified: these come from wrangler's vocabulary, not from `GET /oauth/scopes`.
    expect(printed.unmeasured).toContain("/oauth/scopes");
    expect(printed.unmeasured).toContain("wrangler");
    /*
     * The steps carried an assertion that the scopes were **not** the dotted form, on the grounds that
     * Cloudflare's documentation example was not the vocabulary in use. It was. Replaced with the property
     * that actually matters: the steps say not to add `offline_access`, which is the one scope a client is
     * measurably not allowed to request.
     */
    expect(printed.steps.some((step) => step.includes("offline_access"))).toBe(true);
  });

  it("prints real scope strings, and says which of them had no read-only choice", () => {
    /*
     * This asserted the opposite until two consents settled it: the ceremony named **capabilities** in prose
     * and no scope strings, because `GET /oauth/scopes` needs a token this Node does not have.
     *
     * That could not work. A request naming no scope is granted none — the consent screen reads "0 total
     * permissions" with `Authorize` disabled, because a client's registered scopes are a ceiling on what it
     * may request rather than a default for what it does. So the Node must enumerate them.
     */
    const printed = ceremony(REDIRECT);
    expect(printed.scopes.length).toBeGreaterThanOrEqual(5);
    for (const one of printed.scopes) {
      /*
       * `<group>.<verb>` with a **dot**, or a protocol scope with neither. Cloudflare's API reference says
       * both in one sentence: *"Colon-delimited scopes are not accepted. Dot-delimited scopes are validated
       * against available OAuth API scopes; simple identity scopes are allowed."*
       *
       * This asserted a colon until 9 September 2026, because wrangler's bundle spells its own scopes that
       * way — and wrangler is a first-party client whose shorthand nobody else may use. The reference had
       * the answer the whole time; so did the guide's own example.
       */
      expect(one.scope, "a scope is <group>.<verb> or a protocol scope")
        .toMatch(/^([a-z0-9-]+\.[a-z_]+|offline_access|openid)$/);
      expect(one.why.length).toBeGreaterThan(30);
    }
    // The steps name the exact ids, so an operator can select them rather than interpret a description.
    expect(printed.steps.some((step) => step.includes("account-settings.read"))).toBe(true);

    /*
     * **L1 asks for reads only, and getting here took two corrections.**
     *
     * The first version asserted every L1 capability was read-only, in prose with no scope strings. The
     * second asserted the opposite — that D1, Queues and Email had no read scope, so a read-only layer had
     * to ask for write — on the strength of wrangler's bundled vocabulary.
     *
     * Both wrong. The dashboard's picker offers **Read** for every one of them; wrangler's list is what
     * *wrangler* asks for, and wrangler deploys Workers. Reading a client's request list as the provider's
     * vocabulary is the same error as reading `scopes_supported` as a client's menu, one layer in.
     *
     * So the property to hold is the original one after all: **a layer that provisions nothing asks for
     * nothing but reads.**
     */
    /*
     * **Not "reads only" any more, and that is an operator's selection rather than a design change.** This
     * list is the fourteen scopes a real client was registered with, and the picker had `d1` and `queues` on
     * Edit. Both have a `.read` Cloudflare offers, which is what L1 would ask for since it provisions
     * nothing — so what is asserted is that every write entry *says* a read exists, not that none is used.
     */
    for (const one of printed.scopes.filter((x) => x.scope.endsWith(".write"))) {
      expect(one.readOnlyExists, `${one.scope} claims no read form exists`).toBe(true);
    }
    expect(printed.scopes.some((one) => one.scope.endsWith(".read"))).toBe(true);

    /*
     * **`offline_access` is requested, and this test asserted its absence for a day.** A consent refused it
     * and the conclusion drawn was that no self-managed client can hold a refreshable grant — from a picker
     * that does not list it and a `GET /oauth/scopes` that does not either. Both true and neither the point:
     * the API reference says protocol scopes are *"added or removed automatically based on `grant_types`"*,
     * so a client with `refresh_token` has it and one without never could.
     *
     * Without it the grant expires in an hour, measured, which turns ADR 42's one ceremony into one per hour.
     */
    expect(printed.scopes.map((one) => one.scope)).toContain("offline_access");

    // And every read scope is honest the other way: a narrower choice was available and taken.
    for (const one of printed.scopes.filter((x) => x.scope.endsWith(":read"))) {
      expect(one.readOnlyExists).toBe(true);
    }
  });
});

describe("spending the grant, which is what makes grant_refused reachable", () => {
  /** A grant that expires at `expiresAt`, so the refresh path can be aimed at. */
  async function granted(expiresAt: number, withRefresh = true) {
    await register();
    answering(200, {
      access_token: "first-access", refresh_token: withRefresh ? "the-refresh" : undefined,
      expires_in: 3600, scope: "a",
    });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);
    await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });
    await testEnv.CATALOG.prepare("UPDATE provider_binding SET access_expires_at = ? WHERE id = 1")
      .bind(new Date(expiresAt).toISOString()).run();
  }

  it("uses the stored token while it is good, without touching the token endpoint", async () => {
    await granted(SEPTEMBER_3 + 3600_000);
    const stub = answering(200, { success: true, result: [{ id: "acc_only", name: "One" }] });
    const answer = await cloudflareGet(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "/accounts");
    expect(answer.ok).toBe(true);
    // One call, and it is the API rather than a renewal.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toContain("/client/v4/accounts");
    expect((stub.calls[0]?.init.headers as Record<string, string>).authorization)
      .toBe("Bearer first-access");
  });

  it("renews a minute before expiry, not after, and keeps the refresh token when none is returned", async () => {
    /*
     * The margin is the point. A token that expires between the check and the request it was fetched for is
     * a request that fails for a reason the caller cannot tell from a revocation — so the check is against
     * `now + 60s`, and this grant expires in thirty.
     */
    await granted(SEPTEMBER_3 + 30_000);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(
        String(url).includes("oauth2/token")
          // No `refresh_token` in the renewal: rotation is at the server's discretion.
          ? { access_token: "second-access", expires_in: 3600 }
          : { success: true, result: [] },
      ), { status: 200, headers: { "content-type": "application/json" } });
    });

    await cloudflareGet(testEnv, atTime(SEPTEMBER_3), ORG, "/accounts");
    expect(calls[0]?.url).toBe("https://dash.cloudflare.com/oauth2/token");
    expect(new URLSearchParams(String(calls[0]?.init.body)).get("grant_type")).toBe("refresh_token");
    // The API call then carries the new token.
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBe("Bearer second-access");

    const row = await testEnv.CATALOG.prepare(
      "SELECT access_token, refresh_token FROM provider_binding WHERE id = 1",
    ).first<{ access_token: string; refresh_token: string }>();
    expect(await unwrapCredential(testEnv, row!.access_token)).toBe("second-access");
    /*
     * **The refresh token survives a renewal that did not rotate it.** Overwriting it with the response's
     * absent field would discard the durable half of the authorization on a *successful* renewal — the
     * grant would work for one more hour and then be unrecoverable.
     */
    expect(await unwrapCredential(testEnv, row!.refresh_token)).toBe("the-refresh");
  });

  it("records grant_refused in Cloudflare's own words when a renewal is rejected", async () => {
    /*
     * The path L1 could describe and not reach. Until this existed the state was only settable by hand, and
     * the revocation drill had to write the row itself.
     */
    await granted(SEPTEMBER_3);
    answering(400, { error: "invalid_grant", error_description: "token is inactive because it was revoked" });

    await expect(cloudflareGet(testEnv, atTime(SEPTEMBER_3 + 1), ORG, "/accounts"))
      .rejects.toThrow("E_PROVIDER_GRANT_REFUSED");

    const status = await providerStatus(testEnv);
    expect(status.state).toBe("grant_refused");
    expect(status.refusedDetail).toBe("token is inactive because it was revoked");
    // The tokens stay: *never granted* and *granted and then refused* are different questions.
    expect(status.grantedAt).not.toBeNull();
  });

  it("does not record a refusal when the token endpoint is merely unreachable", async () => {
    /*
     * ADR 40's distinction, in a third place. An unreachable endpoint says nothing about the grant, and
     * marking it refused would tell an operator their authorization was revoked because a request timed out.
     */
    await granted(SEPTEMBER_3);
    vi.stubGlobal("fetch", async () => { throw new Error("socket closed"); });

    await expect(cloudflareGet(testEnv, atTime(SEPTEMBER_3 + 1), ORG, "/accounts"))
      .rejects.toThrow("E_PROVIDER_REFRESH_UNREACHABLE");
    expect((await providerStatus(testEnv)).state).toBe("consent_granted");
  });

  it("refuses to spend a grant already marked refused, rather than retrying it", async () => {
    await granted(SEPTEMBER_3 + 3600_000);
    await testEnv.CATALOG.prepare(
      "UPDATE provider_binding SET refused_at = ?, refused_detail = 'revoked' WHERE id = 1",
    ).bind(new Date(SEPTEMBER_3).toISOString()).run();
    await expect(cloudflareGet(testEnv, atTime(SEPTEMBER_3 + 1), ORG, "/accounts"))
      .rejects.toThrow("E_PROVIDER_GRANT_REFUSED");
  });

  it("says so when an expired grant has no refresh token to renew with", async () => {
    // The one-hour dead end: a client whose grant types omit `refresh_token`.
    await granted(SEPTEMBER_3, false);
    await expect(cloudflareGet(testEnv, atTime(SEPTEMBER_3 + 1), ORG, "/accounts"))
      .rejects.toThrow("E_PROVIDER_NO_REFRESH");
  });

  it("records the account only when there is exactly one, because a guess is worse than a null", async () => {
    await granted(SEPTEMBER_3 + 3600_000);
    answering(200, { success: true, result: [{ id: "acc_one", name: "A" }, { id: "acc_two", name: "B" }] });
    const many = await resolveAccount(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(many.found).toBe(2);
    expect(many.accountId).toBeNull();
    /*
     * Belonging to two accounts is a real answer, not an error — and the column a deployment plan reads
     * names the account it would provision into, so a guess there is worse than *not yet determined*.
     */
    expect((await providerStatus(testEnv)).accountId).toBeNull();

    answering(200, { success: true, result: [{ id: "acc_only", name: "A" }] });
    const one = await resolveAccount(testEnv, atTime(SEPTEMBER_3 + 4000), ORG);
    expect(one.accountId).toBe("acc_only");
    expect((await providerStatus(testEnv)).accountId).toBe("acc_only");
  });

  it("carries Cloudflare's own error rather than a status code", async () => {
    await granted(SEPTEMBER_3 + 3600_000);
    // The shape that matters: a missing scope and a missing resource must be tellable apart.
    answering(403, { success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] });
    const answer = await cloudflareGet(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "/accounts");
    expect(answer.ok).toBe(false);
    expect((answer as { error: string }).error).toContain("9109");
    expect((answer as { error: string }).error).toContain("Unauthorized");
  });
});


/**
 * Whether a send's outcome would ever be **seen** (#163 L2).
 *
 * ## Why this is worth stubbing rather than only measuring live
 *
 * The live account has exactly one subscription and it is correct, so every branch that matters — an apex
 * subscription covering a subdomain, a queue nobody consumes, a subscription switched off, an unreadable
 * answer — is a branch a live run cannot reach. Those are the states an operator would actually be in, and
 * the failure mode of all of them is the same: the report says *fine* and the mail says nothing.
 */
describe("delivery events, read through the grant", () => {
  /** A grant good for an hour, an account already resolved, and one routed address. */
  async function ready(address: string) {
    await register();
    answering(200, {
      access_token: "an-access", refresh_token: "a-refresh", expires_in: 3600, scope: "a",
    });
    const { state } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);
    await completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 2000), ORG, {
      state, code: "the-code", error: null, errorDescription: null,
    });
    await testEnv.CATALOG.prepare("DELETE FROM addresses WHERE org_id = ?").bind(ORG).run();
    await testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind("addr_delivery", ORG, address, "mbx_x", new Date(SEPTEMBER_3).toISOString()).run();
  }

  /** A path this stub answers with Cloudflare's own kind of refusal rather than with a result. */
  const REFUSE = Symbol("refused");
  const ZONE = { id: "zone_1", name: "example.test" };
  const SENDING = "/zones/zone_1/email/sending/subdomains";

  /**
   * Answers each Cloudflare path from `answers`, and records what was asked.
   *
   * The zone lookup and the sending list are answered by default, because every test here is about one of
   * the four objects and would otherwise have to restate the other three.
   */
  function serving(answers: Record<string, unknown>) {
    answers = {
      "/zones?name=example.test": [ZONE],
      "/zones?name=": [],
      [SENDING]: [{
        id: "snd_1", name: "example.test", enabled: true,
        return_path_domain: "cf-bounce.example.test", dkim_selector: "cf-bounce",
      }],
      [`${SENDING}/snd_1/dns`]: [
        { type: "TXT", name: "_dmarc.example.test", content: "\"v=DMARC1; p=reject;\"" },
      ],
      ...answers,
    };
    // An explicit `undefined` removes a default, which is how a test asks for a path nobody answers.
    for (const [at, value] of Object.entries(answers)) if (value === undefined) delete answers[at];
    /*
     * `REFUSE` is not the same as removing the key: a path nested under one that *is* answered would
     * otherwise fall back to its parent's answer rather than being refused.
     */
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      asked.push(path);
      const key = Object.keys(answers).filter((one) => path.startsWith(one))
        .sort((a, b) => b.length - a.length)[0];
      return new Response(
        JSON.stringify(
          key === undefined || answers[key] === REFUSE
            ? { success: false, errors: [{ code: 7003, message: `no route for ${path}` }] }
            : { success: true, result: answers[key] },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    return asked;
  }

  const SUBSCRIPTIONS = "/accounts/acc_1/event_subscriptions/subscriptions";

  function subscription(domain: string, over: Record<string, unknown> = {}) {
    return {
      id: "sub_1", name: "mailda-sending-events", enabled: true,
      events: ["message.delivered", "message.bounced"],
      source: { type: "email.sending", domain },
      destination: { queue_id: "q_1" },
      ...over,
    };
  }

  async function withAccount() {
    await testEnv.CATALOG.prepare("UPDATE provider_binding SET account_id = 'acc_1' WHERE id = 1").run();
  }

  it("names the subscription, its queue and the consumers reading it", async () => {
    await ready("inbox@mailda-test.example.test");
    await withAccount();
    serving({
      [SUBSCRIPTIONS]: [subscription("mailda-test.example.test")],
      "/accounts/acc_1/queues/q_1": {
        queue_name: "mailda-sending-events", consumers: [{ script: "mailda", type: "worker" }],
      },
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen).toEqual({
      domain: "mailda-test.example.test",
      zone: "example.test",
      /*
       * The apex is the onboarded sending domain and this Node sends from a subdomain of it, which is the
       * real shape on the live account — `whymelabs.com` is onboarded and `mailda-test.whymelabs.com` is
       * onboarded separately beside it.
       */
      sending: {
        name: "example.test", enabled: true,
        returnPath: "cf-bounce.example.test", dkimSelector: "cf-bounce",
        required: [{
          type: "TXT", name: "_dmarc.example.test", content: "\"v=DMARC1; p=reject;\"", priority: null,
        }],
        error: null,
      },
      subscription: "mailda-sending-events",
      subscriptionId: "sub_1",
      enabled: true,
      events: ["message.delivered", "message.bounced"],
      queueId: "q_1",
      queueName: "mailda-sending-events",
      consumers: ["mailda"],
      error: null,
    });
  });

  it("counts an apex sending domain as covering a subdomain sending under it", async () => {
    /*
     * The same dot-boundary rule as the subscription match, and it needs its own test because the two are
     * separate lines: Cloudflare onboards `whymelabs.com` and `mailda-test.whymelabs.com` as distinct
     * sending domains, so a Node under either has to be found under the one that is actually there.
     */
    await ready("inbox@deep.example.test");
    await withAccount();
    serving({ [SUBSCRIPTIONS]: [] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.sending?.name).toBe("example.test");
    expect(seen!.sending?.required).toHaveLength(1);
  });

  it("prefers the most specific sending domain when an apex is onboarded too", async () => {
    /*
     * **Found by a live run, not by a stub.** `whymelabs.com` and `mailda-test.whymelabs.com` are both
     * onboarded, and taking the first match reported the apex — so the records shown were the apex's, every
     * one of them correct about a domain nobody had asked about. Proposing those would have meant writing
     * into a zone carrying live mail.
     */
    await ready("inbox@deep.example.test");
    await withAccount();
    serving({
      [SENDING]: [
        { id: "snd_apex", name: "example.test", enabled: true },
        { id: "snd_deep", name: "deep.example.test", enabled: true },
      ],
      [`${SENDING}/snd_deep/dns`]: [
        { type: "TXT", name: "_dmarc.deep.example.test", content: "\"v=DMARC1; p=reject;\"" },
      ],
      [SUBSCRIPTIONS]: [],
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.sending?.name).toBe("deep.example.test");
    expect(seen!.sending?.required[0]?.name).toBe("_dmarc.deep.example.test");
  });

  it("prefers the most specific subscription when an apex one covers the domain too", async () => {
    await ready("inbox@deep.example.test");
    await withAccount();
    serving({
      [SUBSCRIPTIONS]: [
        subscription("example.test", { id: "sub_apex", name: "apex-events" }),
        subscription("deep.example.test", { id: "sub_deep", name: "deep-events" }),
      ],
      "/accounts/acc_1/queues/q_1": { queue_name: "q", consumers: [{ script: "mailda" }] },
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.subscription).toBe("deep-events");
  });

  it("does not count a sending domain that merely ends the same way", async () => {
    await ready("inbox@notexample.test");
    await withAccount();
    // A zone exists for it, so the walk succeeds and only the sending-list match decides.
    serving({
      "/zones?name=notexample.test": [{ id: "zone_1", name: "notexample.test" }],
      [SUBSCRIPTIONS]: [],
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.zone).toBe("notexample.test");
    expect(seen!.sending).toBeNull();
  });

  it("reports an unreadable sending list as unknown rather than as not onboarded", async () => {
    /*
     * The dangerous direction. `null` means *this domain may not send*, and an operator meeting that about a
     * working sender would re-onboard a domain that was already fine — or read the three lines below it as
     * irrelevant when they are the actual fault.
     */
    await ready("inbox@example.test");
    await withAccount();
    serving({ [SENDING]: REFUSE, [SUBSCRIPTIONS]: [] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.sending).not.toBeNull();
    expect(seen!.sending!.enabled).toBeNull();
    expect(seen!.sending!.error).toContain("7003");
  });

  it("keeps an unreadable record list apart from a sending domain that needs nothing", async () => {
    /*
     * `required: []` twice over, and only `error` says which. This is `emailRoutingFor`'s hazard on the
     * sending side: a proposal built from an unreadable list would tell an operator their DNS was complete
     * because a request failed.
     */
    await ready("inbox@example.test");
    await withAccount();
    serving({ [`${SENDING}/snd_1/dns`]: REFUSE, [SUBSCRIPTIONS]: [] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.sending!.required).toEqual([]);
    expect(seen!.sending!.error).toContain("7003");
  });

  it("never asks Cloudflare about a single label", async () => {
    /*
     * The walk stops at two labels. A single label is a public suffix rather than a zone anybody owns, so
     * `GET /zones?name=test` is a request whose every possible answer is wrong — an empty one wastes a call,
     * and a non-empty one would attach this Node's mail to somebody else's registry entry.
     */
    await ready("inbox@deep.example.test");
    await withAccount();
    const asked = serving({ "/zones?name=deep.example.test": [], [SUBSCRIPTIONS]: [] });

    await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(asked).toContain("/zones?name=example.test");
    expect(asked).not.toContain("/zones?name=test");
  });

  it("resolves the innermost zone carrying a domain, not the outermost", async () => {
    /*
     * A subdomain that is **its own zone** must be found as itself. Email Sending and Email Routing are both
     * configured per zone, so resolving `deep.b.example.test` to `example.test` when `b.example.test` is a
     * zone would report a different zone's configuration as this domain's — records for the wrong name, and
     * a verdict about somebody else's mail.
     */
    await ready("inbox@deep.b.example.test");
    await withAccount();
    serving({
      "/zones?name=b.example.test": [{ id: "zone_inner", name: "b.example.test" }],
      "/zones/zone_inner/email/sending/subdomains": [{ id: "snd_2", name: "b.example.test", enabled: true }],
      "/zones/zone_inner/email/sending/subdomains/snd_2/dns": [],
      [SUBSCRIPTIONS]: [],
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.zone).toBe("b.example.test");
    expect(seen!.sending?.name).toBe("b.example.test");
  });

  it("counts an apex subscription as covering a subdomain it sends from", async () => {
    /*
     * Cloudflare scopes a subscription to one sending domain: the zone apex, **or** a verified sending
     * subdomain. So a Node sending from `mailda-test.example.test` under an apex subscription is covered,
     * and an equality match would report it as having none — sending an operator to create a second
     * subscription for a domain that already has one.
     */
    await ready("inbox@mailda-test.example.test");
    await withAccount();
    serving({
      [SUBSCRIPTIONS]: [subscription("example.test")],
      "/accounts/acc_1/queues/q_1": { queue_name: "q", consumers: [{ script: "mailda" }] },
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.subscription).toBe("mailda-sending-events");
  });

  it("does not count a subscription on a different domain that merely ends the same way", async () => {
    // `notexample.test` ends with `example.test` as a *string*. The dot is what makes it a label boundary.
    await ready("inbox@notexample.test");
    await withAccount();
    serving({ [SUBSCRIPTIONS]: [subscription("example.test")] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.subscription).toBeNull();
    expect(seen!.error).toBeNull();
  });

  it("ignores subscriptions from other sources on the same domain", async () => {
    await ready("inbox@example.test");
    await withAccount();
    serving({ [SUBSCRIPTIONS]: [subscription("example.test", { source: { type: "r2", domain: "example.test" } })] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.subscription).toBeNull();
  });

  it("reports a queue nobody consumes as empty rather than as absent", async () => {
    /*
     * The failure this whole route exists for: the subscription is there, the queue is there, events are
     * published — into a queue no Worker reads. Nothing errors, and nothing arrives.
     */
    await ready("inbox@example.test");
    await withAccount();
    serving({
      [SUBSCRIPTIONS]: [subscription("example.test")],
      "/accounts/acc_1/queues/q_1": { queue_name: "orphan", consumers: [] },
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.queueName).toBe("orphan");
    expect(seen!.consumers).toEqual([]);
    expect(seen!.error).toBeNull();
  });

  it("keeps an unreadable queue apart from one with no consumers", async () => {
    // Both are `consumers: []`. Only `error` says which, and a surface that read the first as the second
    // would report a working Node as blind.
    await ready("inbox@example.test");
    await withAccount();
    serving({ [SUBSCRIPTIONS]: [subscription("example.test")] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.consumers).toEqual([]);
    expect(seen!.error).toContain("7003");
  });

  it("follows every page rather than trusting the first", async () => {
    /*
     * A subscription on page two is a subscription a single read would miss — and the report would be that
     * the domain has none, which is the way round that sends somebody to create a duplicate. `deploy --plan`
     * called a healthy Node broken on exactly this, over R2's page of twenty.
     */
    await ready("inbox@example.test");
    await withAccount();
    const filler = Array.from({ length: 50 }, (_, at) => subscription("other.test", { id: `pad_${at}` }));
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      asked.push(path);
      const result = path.startsWith(SUBSCRIPTIONS)
        ? (path.includes("page=1") ? filler : [subscription("example.test")])
        : { queue_name: "q", consumers: [{ script: "mailda" }] };
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.subscription).toBe("mailda-sending-events");
    expect(asked.filter((one) => one.startsWith(SUBSCRIPTIONS))).toHaveLength(2);
  });

  it("says the account is not determined yet rather than blaming Cloudflare", async () => {
    /*
     * `account_id` is filled lazily by `resolveAccount`, so a Node can hold a working grant and not know
     * which account it covers. Naming the step is the difference between one command and a re-consent.
     */
    await ready("inbox@example.test");
    const asked = serving({});

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.error).toContain("/api/provider/resolve-account");
    // And it spent nothing finding out.
    expect(asked).toEqual([]);
  });

  it("answers nothing, and asks nothing, for a Node that routes no domains", async () => {
    await ready("inbox@example.test");
    await testEnv.CATALOG.prepare("DELETE FROM addresses WHERE org_id = ?").bind(ORG).run();
    const asked = serving({});

    expect(await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
