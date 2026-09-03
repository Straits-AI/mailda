import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unwrapCredential } from "../src/auth/kek.ts";
import {
  beginAuthorization, ceremony, CLOUDFLARE_OAUTH, completeAuthorization, MIN_STATE_LENGTH,
  PROVIDER_STATES, providerStatus, registerClient, reportUnselectable, STATUS_COLUMNS,
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

  it("adds offline_access rather than requiring the caller to remember it", async () => {
    await register();
    const { url } = await beginAuthorization(testEnv, atTime(SEPTEMBER_3 + 1000), ADMIN, ["a"]);
    const scopes = new URL(url).searchParams.get("scope")?.split(" ") ?? [];
    /*
     * Without it there is no refresh token, so the grant would expire with its access token and ADR 42's one
     * ceremony would become a recurring one — which an operator would meet as a Node that keeps disconnecting.
     */
    expect(scopes).toContain("offline_access");
    // Once, not twice, when the caller did remember.
    const second = await beginAuthorization(
      testEnv, atTime(SEPTEMBER_3 + 2000), ADMIN, ["a", "offline_access"],
    );
    const again = new URL(second.url).searchParams.get("scope")?.split(" ") ?? [];
    expect(again.filter((one) => one === "offline_access")).toHaveLength(1);
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
    // Eleven minutes later; the redirect's working life is ten.
    await expect(completeAuthorization(testEnv, atTime(SEPTEMBER_3 + 11 * 60 * 1000), ORG, {
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
    expect(printed.steps.some((step) => step.includes("offline_access"))).toBe(true);
    // Private, which is what keeps the grant the customer's — ADR 42's whole custody argument.
    expect(printed.steps.some((step) => step.toLowerCase().includes("private"))).toBe(true);

    /*
     * The honesty requirement, asserted rather than left to a docstring. #162 asks for the scope list
     * prefilled; this repository has seen two Cloudflare scope strings, both from a documentation example. An
     * operator following printed steps is entitled to know which parts of them the Node has verified, so the
     * ceremony says the scope names are not printed and names the call that would produce them.
     */
    expect(printed.unmeasured).toContain("has not measured");
    expect(printed.unmeasured).toContain("/oauth/scopes");
    for (const step of printed.steps) {
      // No invented scope name anywhere in the printed steps.
      expect(step).not.toMatch(/workers-platform\.|\bd1\.(read|write)\b|\br2\.(read|write)\b/);
    }
  });

  it("asks for read capabilities in this layer and defers write to the one that provisions", () => {
    const printed = ceremony(REDIRECT);
    const l1 = printed.capabilities.filter((one) => one.layer === "L1");
    expect(l1.length).toBeGreaterThanOrEqual(4);
    /*
     * An operator asked for write access to their whole Workers platform in order to display a read-only
     * inventory would be right to refuse, and #162's L1 does exactly one thing with the grant: read.
     */
    for (const one of l1) expect(one.capability).not.toMatch(/^write/);
    expect(printed.capabilities.some((one) => one.layer !== "L1" && one.capability.startsWith("write")))
      .toBe(true);
    // Every capability carries its reason, which is what makes a consent screen reviewable.
    for (const one of printed.capabilities) expect(one.why.length).toBeGreaterThan(30);
  });
});
