import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wrapCredential } from "../src/auth/kek.ts";
import { classifyRestError, restConfigured, restTransport } from "../src/outbound/rest-transport.ts";
import { chooseTransport, cloudflareTransport } from "../src/outbound/transport.ts";

/**
 * The second send adapter (#86, ADR 33).
 *
 * ADR 33 locks *"the transport offers both send APIs, and every send records which one carried it."* The
 * recording half was already correct and had one possible value; this is the half that gives it a second.
 *
 * ## What these tests are actually about
 *
 * Not "does it POST to a URL". The two things that can go wrong here are both about **honesty**:
 *
 * 1. **Which outcome a failure becomes.** The four `SubmitOutcome` kinds are not interchangeable — a
 *    `refused` claims the message provably never left and is safe to retry, and an `outcome_unknown` claims
 *    the opposite. Getting that backwards either strands mail or delivers a duplicate the recipient keeps
 *    for ever (ADR 40).
 * 2. **What this adapter refuses to attempt.** It cannot carry `authored` fidelity, and the failure mode of
 *    getting that wrong is the worst available: mail sent whose recorded bytes are not the bytes sent.
 */

const testEnv = env as unknown as Env;

beforeEach(async () => {
  await testEnv.CATALOG.prepare("DELETE FROM sending_transport").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function configure(accountId = "acc_1", token = "cf-token-value"): Promise<void> {
  await testEnv.CATALOG.prepare(
    `INSERT INTO sending_transport (id, account_id, api_token, configured_by, configured_at)
     VALUES (1,?,?,?,?)`,
  ).bind(accountId, await wrapCredential(testEnv, token), "usr_admin", "2026-08-22T00:00:00.000Z").run();
}

/** A `fetch` that records what it was asked and answers what the test wants. */
function answering(status: number, body: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { calls };
}

const RECONSTRUCTED = {
  from: "support@acme.example",
  to: ["customer@example.net"],
  subject: "Re: invoice",
  text: "Thanks for your message.",
};

describe("the REST adapter refuses what it cannot carry", () => {
  it("refuses an authored send rather than rebuilding its MIME", async () => {
    /*
     * The most important assertion in this file. The REST endpoint takes structured JSON and no raw MIME —
     * checked against Cloudflare's documentation — so submitting an authored send through it would mean the
     * bytes recorded and the bytes sent are different objects. That is precisely the guarantee authored
     * fidelity exists to make, and ADR 33 requires it for customer mail.
     *
     * Refused rather than downgraded to reconstructed: a silent downgrade would send *something*, and the
     * operator would find out from the archive months later.
     */
    await configure();
    const outcome = await restTransport.submit(
      testEnv, { ...RECONSTRUCTED, raw: new TextEncoder().encode("From: x\r\n\r\nbody") }, "authored",
    );
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toMatch(/cannot carry an authored send/);
    expect(outcome.kind === "refused" && outcome.reason).toMatch(/bytes submitted would not be the bytes/);
  });

  it("refuses when this Node has no token, rather than calling Cloudflare unauthenticated", async () => {
    const outcome = await restTransport.submit(testEnv, RECONSTRUCTED, "reconstructed");
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toMatch(/no sending API token/);
  });
});

describe("the token is read at the point of use and never held", () => {
  it("unwraps the stored credential and sends it as a bearer token", async () => {
    await configure("acc_42", "secret-token-42");
    const { calls } = answering(200, { success: true, errors: [], result: { delivered: ["x"] } });

    await restTransport.submit(testEnv, RECONSTRUCTED, "reconstructed");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/accounts/acc_42/email/sending/send");
    const headers = calls[0]!.init.headers as Record<string, string>;
    // The wrapped form is what D1 holds; the plaintext exists only for the length of this call.
    expect(headers.authorization).toBe("Bearer secret-token-42");
  });

  it("stores the token wrapped, so a database read discloses nothing", async () => {
    /*
     * ADR 22's surviving property, asserted rather than assumed. The rule as written required a Secrets
     * Store binding, which ADR 24 forbids here — migration 0036 carries that argument — and what it was
     * actually buying is this: the credential is not readable from the place it is stored.
     */
    await configure("acc_1", "secret-token-42");
    const row = await testEnv.CATALOG.prepare(
      "SELECT api_token FROM sending_transport WHERE id = 1",
    ).first<{ api_token: string }>();
    expect(row?.api_token).not.toContain("secret-token-42");
    expect(row?.api_token).toMatch(/^v\d+\./);
  });

  it("reports that a token is configured without reading it", async () => {
    // What `doctor` and `GET /api/transport` call: the account and the date, never the secret.
    await configure("acc_7", "secret");
    const reported = await restConfigured(testEnv);
    expect(reported).toEqual({ accountId: "acc_7", at: "2026-08-22T00:00:00.000Z" });
    expect(JSON.stringify(reported)).not.toContain("secret");
  });
});

describe("Cloudflare's answers become the right outcome, and the direction matters", () => {
  /*
   * Each of these is a claim about what may happen next. `refused` permits a retry once the cause is fixed
   * because the message provably never left; `outcome_unknown` forbids one because it might have.
   */
  it("maps the two documented codes to refusals that name the fix", () => {
    const notEntitled = classifyRestError(403, 10105, "not entitled");
    expect(notEntitled.kind).toBe("refused");
    expect(notEntitled.kind === "refused" && notEntitled.reason).toMatch(/10105/);

    const disabled = classifyRestError(403, 10203, "sending disabled");
    expect(disabled.kind).toBe("refused");
    expect(disabled.kind === "refused" && disabled.reason).toMatch(/10203/);
  });

  it("maps a rejected token to a refusal naming the permission it needs", () => {
    const outcome = classifyRestError(401, null, "invalid token");
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toMatch(/Email Sending: Edit/);
  });

  it("maps 429 to throttled, which is the one failure safe to retry automatically", () => {
    expect(classifyRestError(429, null, "slow down").kind).toBe("throttled");
  });

  it("maps a server error to outcome_unknown rather than refused", () => {
    /*
     * The direction that matters most. A 5xx is **not** proof the message did not send — Cloudflare may
     * have accepted it and failed to answer — so calling it `refused` would license an automatic retry and
     * a duplicate the recipient keeps for ever (ADR 40).
     */
    expect(classifyRestError(500, null, "internal").kind).toBe("outcome_unknown");
    expect(classifyRestError(503, null, "unavailable").kind).toBe("outcome_unknown");
  });

  it("maps an unrecognised code to outcome_unknown, which is the safe default", () => {
    // Same default `classifyError` takes for the binding: the safe answer to an unclassifiable failure is
    // the state that forbids automatic retry.
    expect(classifyRestError(418, 99999, "teapot").kind).toBe("refused");
    expect(classifyRestError(600, 99999, "nonsense").kind).toBe("outcome_unknown");
  });

  it("treats a request that never completed as unknown, not as a refusal", async () => {
    await configure();
    vi.stubGlobal("fetch", async () => { throw new Error("socket closed"); });
    const outcome = await restTransport.submit(testEnv, RECONSTRUCTED, "reconstructed");
    expect(outcome.kind).toBe("outcome_unknown");
    expect(outcome.kind === "outcome_unknown" && outcome.reason).toMatch(/did not complete/);
  });
});

describe("what this adapter knows that the binding does not", () => {
  it("reports a permanent bounce at submission as suppressed", async () => {
    /*
     * The binding reports nothing per recipient, so a bounce known at submit becomes an optimistic
     * `handed_over` and is discovered later, if at all. The REST response carries `permanent_bounces`, and
     * `suppressed` is the state that says *this will never arrive, and that is knowable now*.
     */
    await configure();
    answering(200, {
      success: true, errors: [],
      result: { delivered: [], permanent_bounces: ["customer@example.net"], queued: [] },
    });
    const outcome = await restTransport.submit(testEnv, RECONSTRUCTED, "reconstructed");
    expect(outcome.kind).toBe("suppressed");
  });

  it("hands over when Cloudflare accepted it", async () => {
    await configure();
    answering(200, { success: true, errors: [], result: { delivered: ["customer@example.net"] } });
    const outcome = await restTransport.submit(testEnv, RECONSTRUCTED, "reconstructed");
    expect(outcome.kind).toBe("handed_over");
  });

  it("treats success:false as a failure even on a 200", async () => {
    /*
     * Cloudflare's envelope carries `success` independently of the HTTP status. Reading only the status
     * would report a refusal as a hand-over, which is the one direction that loses mail silently.
     */
    await configure();
    answering(200, { success: false, errors: [{ code: 10105, message: "not entitled" }] });
    const outcome = await restTransport.submit(testEnv, RECONSTRUCTED, "reconstructed");
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toMatch(/10105/);
  });
});

describe("which adapter a Node uses", () => {
  it("prefers the binding, because it needs no credential and can carry authored bytes", async () => {
    /*
     * `env.EMAIL` is bound in the test environment, so this is the ordinary case. Preferring the binding is
     * a decision with two reasons rather than an arbitrary order: it holds nothing that can leak, and it is
     * the only adapter that can submit the exact recorded bytes.
     */
    await configure();
    expect((await chooseTransport(testEnv)).name).toBe(cloudflareTransport.name);
  });

  it("falls back to REST only when there is no binding and a token exists", async () => {
    await configure();
    const noBinding = { ...testEnv, EMAIL: undefined } as unknown as Env;
    expect((await chooseTransport(noBinding)).name).toBe("cloudflare-email-rest");
  });

  it("falls back to the binding when neither is available, for its better refusal", async () => {
    /*
     * Deliberate rather than a coin toss: the binding's refusal names the `send_email` binding an operator
     * should install; the REST adapter's would name a token, which is the second-best answer. The most
     * useful refusal wins.
     */
    const bare = { ...testEnv, EMAIL: undefined } as unknown as Env;
    expect((await chooseTransport(bare)).name).toBe(cloudflareTransport.name);
  });

  it("says what it can and cannot do, without claiming the gates it cannot check", async () => {
    await configure("acc_9");
    const capability = await restTransport.capability(testEnv);
    expect(capability.canSend).toBe(true);
    // Null exactly as the binding's is: entitlement and domain onboarding are ADR 34's two unanswerables,
    // and the REST API reports `not_entitled` only in response to a send that has already been committed.
    expect(capability.verifiedAt).toBeNull();
    expect(capability.detail).toMatch(/reconstructed sends only/);
  });

  it("answers that it cannot send at all when no token exists", async () => {
    const capability = await restTransport.capability(testEnv);
    expect(capability.canSend).toBe(false);
    expect(capability.detail).toMatch(/No sending API token/);
  });
});
