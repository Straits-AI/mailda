import { utf8 } from "@mailda/evidence";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import worker from "../src/index.ts";
import { clearKeyCache, currentSigningKey } from "../src/auth/keys.ts";
import { LEGACY_KEY_GENERATION, vault } from "../src/keyvault.ts";
import {
  authenticationIsImpossible, formatReport, runDoctor, withoutDataFindings, type Finding,
} from "../src/doctor.ts";
import { putEvidence } from "../src/evidence-store.ts";

const testEnv = env as unknown as Env;

function find(findings: Finding[], check: string): Finding {
  const found = findings.find((f) => f.check === check);
  if (found === undefined) throw new Error(`no finding named ${check}`);
  return found;
}

/** Claims the Node, because the evidence checks are scoped to an organization. */
async function claim(ctx: ReturnType<typeof createSystemCtx>, orgId = "org_1"): Promise<string> {
  await testEnv.CATALOG.prepare(
    "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)",
  ).bind(ctx.id("clm"), "x", new Date(ctx.now()).toISOString(), orgId).run();
  return orgId;
}

/**
 * A vault whose credential *sealing* key is not the one its `openingKey` hands back.
 *
 * That is what an interrupted rotation or a half-restored vault looks like from the outside, and it is
 * the state `checkCredentialKek`'s own comment describes: presence is fine, usability is gone. It is not
 * reachable through `KeyVault`'s own API — the DO writes the key before the pointer precisely so it
 * cannot happen by accident — so it is injected at the single seam the doctor reaches the vault through,
 * the same way `metered()` wraps `CATALOG` and `EVIDENCE`.
 *
 * Only `sealingKey("credential")` is diverted. `openingKey` passes through, so an *existing* wrapped
 * signing key still unwraps and `signing_key` stays healthy — without that, this would be the
 * signing-key lockout again and would prove nothing the test above does not.
 */
function withUnopenableCredentialKey(base: Env): Env {
  const bound = (target: object, property: string | symbol): unknown => {
    const value = Reflect.get(target, property) as unknown;
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  };

  const namespace = new Proxy(base.KEY_VAULT, {
    get(target, property) {
      if (property !== "getByName") return bound(target, property);
      return (name: string) =>
        new Proxy(target.getByName(name), {
          get(stub, stubProperty) {
            // Returned unbound, unlike the namespace above: an RPC stub's properties are themselves
            // proxies that carry their target, and calling `.bind` on one sends `bind` over the wire —
            // "The RPC receiver does not implement the method bind", observed before this comment existed.
            if (stubProperty !== "sealingKey") return Reflect.get(stub, stubProperty) as unknown;
            return async (purpose: "content" | "credential") => {
              const real = await stub.sealingKey(purpose);
              if (purpose !== "credential") return real;
              // Same generation, different bytes. The generation is what `key_vault` reports, so that
              // finding stays green and the failure is isolated to the round trip.
              return { generation: real.generation, secret: btoa("not-the-key-that-wrapped-anything") };
            };
          },
        });
    },
  });

  return { ...base, KEY_VAULT: namespace } as Env;
}

beforeEach(async () => {
  for (const table of ["node_claim", "signing_keys", "ingress_receipts", "outbox", "users", "refresh_tokens"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  clearKeyCache();
});

describe("doctor", () => {
  it("passes on a healthy unclaimed Node", async () => {
    const report = await runDoctor(testEnv, createSystemCtx());
    expect(report.claimed).toBe(false);
    // The signing key self-heals on first use, so an empty table is degraded rather than fatal.
    expect(report.verdict).toBe("degraded");
    expect(find(report.findings, "migrations_applied").ok).toBe(true);
    expect(find(report.findings, "signing_key").ok).toBe(false);
    // No binding to be missing any more: the vault generated its own keys (ADR 28).
    expect(find(report.findings, "key_vault").ok).toBe(true);
    expect(find(report.findings, "credential_key").ok).toBe(true);
  });

  it("generates its own keys, so a published constant is no longer a representable state", async () => {
    const ctx = createSystemCtx();
    const report = await runDoctor(testEnv, ctx);
    const finding = find(report.findings, "key_vault");

    expect(finding.ok).toBe(true);
    // Both above generation 0. Generation 0 *is* the published constant, kept decrypt-only so mail
    // written before the vault stays readable — it can never seal anything.
    const inventory = await vault(testEnv).inventory();
    expect(inventory.content).toBeGreaterThan(LEGACY_KEY_GENERATION);
    expect(inventory.credential).toBeGreaterThan(LEGACY_KEY_GENERATION);
    expect(finding.detail).toContain(`generation ${inventory.content}`);
  });

  it("verifies the credential key by using it, not by looking for a binding", async () => {
    const report = await runDoctor(testEnv, createSystemCtx());
    const finding = find(report.findings, "credential_key");
    expect(finding.ok).toBe(true);
    expect(finding.detail).toContain("round trip");
  });

  it("reports evidence still sealed under an older key generation", async () => {
    const ctx = createSystemCtx();
    const orgId = await claim(ctx);
    const stored = await putEvidence(testEnv, `${orgId}/raw/2026-Q3/legacy.eml`, utf8("hi"));

    // A receipt from before the vault existed: NULL generation, which the index treats as 0.
    await testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
         raw_bytes, blob_key, blob_sha256, accepted_at, key_generation) VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
    ).bind(ctx.id("rcpt"), orgId, "legacy", "a@b.com", "c@d.com", 2, stored.blobKey,
      stored.plaintextSha256, new Date(ctx.now()).toISOString()).run();

    const finding = find((await runDoctor(testEnv, ctx)).findings, "evidence_key_generation");
    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("degraded");
    // A migration in progress, not a misconfiguration — so it names the remedy.
    expect(finding.fix).toContain("reseal");
  });

  it("verifies the signing key by using it, not by counting rows", async () => {
    const ctx = createSystemCtx();
    await currentSigningKey(testEnv, ctx);

    const report = await runDoctor(testEnv, ctx);
    const finding = find(report.findings, "signing_key");
    expect(finding.ok).toBe(true);
    expect(finding.detail).toContain("round trip");

    // A row that exists but cannot be used must fail. Corrupt the wrapped private key: presence is
    // unchanged, usability is gone — exactly the case a presence check would pass.
    await testEnv.CATALOG.prepare("UPDATE signing_keys SET private_jwk_wrapped = ? WHERE status = 'current'")
      .bind("bm90LWEtd3JhcHBlZC1rZXk=").run();
    clearKeyCache();

    const broken = await runDoctor(testEnv, ctx);
    const brokenFinding = find(broken.findings, "signing_key");
    expect(brokenFinding.ok).toBe(false);
    expect(brokenFinding.severity).toBe("refuse");
  });

  it("notices a stalled outbox, and ignores rows still within the sweeper's window", async () => {
    const ctx = createSystemCtx();

    // Fresh: the fast path may still be in flight, so this is not a fault.
    await testEnv.CATALOG.prepare(
      "INSERT INTO outbox (id, org_id, topic, payload, published_at, created_at) VALUES (?,?,?,?,NULL,?)",
    ).bind(ctx.id("evt"), "org_1", "t", "{}", new Date(ctx.now()).toISOString()).run();
    expect(find((await runDoctor(testEnv, ctx)).findings, "outbox_draining").ok).toBe(true);

    // Old and unpublished: the alarm is not firing, and §22's "eventually" has become "never".
    await testEnv.CATALOG.prepare(
      "INSERT INTO outbox (id, org_id, topic, payload, published_at, created_at) VALUES (?,?,?,?,NULL,?)",
    ).bind(ctx.id("evt"), "org_1", "t", "{}", new Date(ctx.now() - 60 * 60 * 1000).toISOString()).run();

    const stalled = find((await runDoctor(testEnv, ctx)).findings, "outbox_draining");
    expect(stalled.ok).toBe(false);
    expect(stalled.severity).toBe("degraded");
  });

  it("finds accepted mail whose evidence is gone — §24's worst failure", async () => {
    const ctx = createSystemCtx();
    await claim(ctx);
    const present = ctx.id("rcpt");
    const absent = ctx.id("rcpt");
    const at = new Date(ctx.now()).toISOString();

    const stored = await putEvidence(testEnv, `org_1/raw/2026-Q3/${present}.eml`, utf8("hi"));
    for (const [id, key] of [[present, stored.blobKey], [absent, "org_1/raw/2026-Q3/gone.eml"]] as const) {
      await testEnv.CATALOG.prepare(
        `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
           raw_bytes, blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(id, "org_1", id, "a@b.com", "c@d.com", 2, key, "x", at).run();
    }

    const finding = find((await runDoctor(testEnv, ctx)).findings, "evidence_present");
    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("degraded");
    expect(finding.detail).toContain(absent);
    // Not "missing object" — the report has to say what it means for the organization.
    expect(finding.detail).toContain("cannot be read");
    expect(finding.fix).toContain("lost mail");
  });

  it("says how much it sampled, so a bounded check cannot read as exhaustive", async () => {
    const ctx = createSystemCtx();
    await claim(ctx);
    const at = new Date(ctx.now()).toISOString();
    const stored = await putEvidence(testEnv, "org_1/raw/2026-Q3/one.eml", utf8("hi"));
    for (let i = 0; i < 3; i++) {
      const id = ctx.id("rcpt");
      await testEnv.CATALOG.prepare(
        `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
           raw_bytes, blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(id, "org_1", id, "a@b.com", "c@d.com", 2, stored.blobKey, "x", at).run();
    }

    const finding = find((await runDoctor(testEnv, ctx)).findings, "evidence_present");
    expect(finding.detail).toContain("3 of 3 receipt(s)");
    expect(finding.detail).toContain("object(s) examined");
    expect(finding.receipt).toBe("docs/receipts/evidence-lifecycle.md");
  });

  it("reports the plan check as absent rather than passing it silently", async () => {
    const finding = find((await runDoctor(testEnv, createSystemCtx())).findings, "workers_paid_plan");
    // An omitted check is indistinguishable from a passing one, so the gap is stated.
    expect(finding.severity).toBe("report");
    expect(finding.detail).toContain("Not checkable");
    expect(finding.detail).toContain("mailda deploy");
  });

  it("reports the queue consumer as un-checkable, and names the step that attaches it (#72)", async () => {
    // Since #72 the queue is provisioned per Node with a derived name and the consumer is attached out of
    // band, so a Node can be healthy, sending, and observing nothing. A Worker holds no account credential,
    // so it cannot ask Queues who consumes its queue — and an absent check reads exactly like a passing one,
    // which is the argument `workers_paid_plan` already makes.
    const report = await runDoctor(testEnv, createSystemCtx());
    const finding = find(report.findings, "sending_events_consumer");

    // `report` and `ok`, exactly like `workers_paid_plan`: a real gap that no operator action closes from in
    // here. A permanently-failing `degraded` is the muted-check failure mode DELIVERY_SILENCE_MS names.
    expect(finding.severity).toBe("report");
    expect(finding.ok).toBe(true);
    expect(report.verdict).not.toBe("refuse");
    expect(finding.detail).toContain("Not checkable");
    // The command, because a capability gap that does not name its remedy is a complaint (AGENTS.md §3).
    expect(finding.detail).toContain("queue:attach-consumer");
    // And the accepted cost, where the reader meets the gap rather than in a doc they have not opened.
    expect(finding.detail).toContain("button-only install");
    expect(finding.receipt).toBe("docs/receipts/queue-provisioning.md");

    // No queue name anywhere in it. The derived name is unmeasured, so a Node printing one would be
    // asserting something nobody checked — the defect this whole change is about, one layer up.
    expect(finding.detail).not.toContain("mailda-sending-events");

    // Infrastructure, so it survives into the report a locked-out operator sees unauthenticated: the queue's
    // name is derived from this Worker's name and its binding, and neither is organization content.
    expect(finding.discloses).toBe("infrastructure");
    expect(withoutDataFindings(report).findings.map((f) => f.check)).toContain("sending_events_consumer");
  });

  it("says Butlers run here, on whose authority, and what is still not built (#50)", async () => {
    // This assertion used to be the opposite: until #50 the detail said no Butler ran, because 0027 shipped
    // the store and the checker with no engine — and `migrations_applied` reporting both tables present is
    // exactly the thing a reader would otherwise read as "the feature works". The engine landed, so the
    // sentence was rewritten and this test with it; `test/node/butler-execution-world.test.ts` is what made
    // that a failure rather than a permanently-true paragraph nobody re-read.
    const report = await runDoctor(testEnv, createSystemCtx());
    const finding = find(report.findings, "butler_execution");

    expect(finding.severity).toBe("report");
    expect(finding.ok).toBe(true);
    expect(report.verdict).not.toBe("refuse");
    expect(finding.detail).toContain("Butlers run on this Node");
    expect(finding.detail).not.toContain("none of them runs");
    // The two facts an operator most needs about a *running* Butler, both of which are decisions rather
    // than implementation detail: whose authority its effects are performed on, and that it cannot put mail
    // on the wire without a person.
    expect(finding.detail).toContain("actor_kind=butler");
    expect(finding.detail).toContain("awaiting a human release");
    // The two things a publisher most needs to know beyond that: what is frozen, and what is refused.
    expect(finding.detail).toContain("frozen");
    expect(finding.detail).toContain("Reserved nodes");
    // #54 closed the affordability seam, so the detail now names the refusal *and* the pot it prices
    // against — including the plan, because an operator on Workers Free is being told a figure that is not
    // theirs unless the sentence says whose it is.
    expect(finding.detail).toContain("could not afford to run is also refused");
    expect(finding.detail).toContain("Workers Paid figure of 10,000");
    expect(finding.detail).toContain("On Workers Free the pot is 1,000");
    // And the seam still open, stated where the reader meets it. It is no longer maxItems.
    expect(finding.detail).toContain("capability ceiling");
    expect(finding.detail).not.toContain("affordable is not checked");

    // Infrastructure: the shape of the bundle and the name of a ticket, both public. So it survives into
    // the report a locked-out operator sees unauthenticated.
    expect(finding.discloses).toBe("infrastructure");
    expect(withoutDataFindings(report).findings.map((f) => f.check)).toContain("butler_execution");
  });

  it("gives every failure a fix — a refusal without a remedy is a dead end", async () => {
    const ctx = createSystemCtx();
    await claim(ctx);
    // Break something, so there is a failure to inspect at all.
    await testEnv.CATALOG.prepare(
      "INSERT INTO outbox (id, org_id, topic, payload, published_at, created_at) VALUES (?,?,?,?,NULL,?)",
    ).bind(ctx.id("evt"), "org_1", "t", "{}", new Date(ctx.now() - 60 * 60 * 1000).toISOString()).run();

    const report = await runDoctor(testEnv, ctx);
    const failures = report.findings.filter((f) => !f.ok);
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure.fix, `${failure.check} has no fix`).toBeDefined();
      expect(failure.fix!.length).toBeGreaterThan(20);
    }
  });

  it("measures and reports its own cost, and stays inside the tripwire", async () => {
    const ctx = createSystemCtx();
    await currentSigningKey(testEnv, ctx);
    const report = await runDoctor(testEnv, ctx);

    // A diagnostic that cannot say what it cost is one more number without a receipt.
    expect(report.cost.subrequests).toBe(report.cost.d1Queries + report.cost.r2Reads);
    expect(report.cost.d1Queries).toBeGreaterThan(0);
    expect(report.cost.subrequests).toBeLessThanOrEqual(BUDGETS["doctor.max_subrequests_per_run"]);
    expect(find(report.findings, "doctor_cost").ok).toBe(true);

    // The sample bound is why this is bounded at all; asserted structurally so a future check
    // cannot quietly make doctor proportional to mailbox size. Against the **free** ceiling, which is
    // the 1,000 the 200 was originally derived against and the only one a Node on an unverified plan
    // can be sure of — the plan is not observable from in here (#68).
    expect(BUDGETS["doctor.evidence_sample_size"]).toBeLessThanOrEqual(BUDGETS["doctor.free.max_subrequests"] / 2);

    // The operator is told both caps, because this Worker cannot tell which is theirs. A single figure
    // here was the Paid one, unlabelled, on a report that elsewhere says the plan is not checkable.
    const detail = find(report.findings, "doctor_cost").detail;
    expect(detail).toContain(`${BUDGETS["doctor.paid.max_subrequests"]} on Workers Paid`);
    expect(detail).toContain(`${BUDGETS["doctor.free.max_subrequests"]} on Workers Free`);
    expect(detail).toContain("cannot tell which plan");
  });

  it("costs more per receipt, which is exactly what the scan bound exists to cap", async () => {
    const ctx = createSystemCtx();
    await claim(ctx);
    const at = new Date(ctx.now()).toISOString();
    const stored = await putEvidence(testEnv, "org_1/raw/2026-Q3/x.eml", utf8("hi"));

    const baseline = (await runDoctor(testEnv, ctx)).cost;
    for (let i = 0; i < 5; i++) {
      const id = ctx.id("rcpt");
      await testEnv.CATALOG.prepare(
        `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
           raw_bytes, blob_key, blob_sha256, accepted_at, key_generation) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(id, "org_1", id, "a@b.com", "c@d.com", 2, stored.blobKey, "x", at, 1).run();
    }
    const withFive = (await runDoctor(testEnv, ctx)).cost;

    // Five more receipts cost five more R2 head calls. Proportional to what is examined, which is
    // why what is examined is bounded and reported.
    expect(withFive.r2Reads).toBeGreaterThan(baseline.r2Reads);
    expect(withFive.subrequests).toBeLessThanOrEqual(BUDGETS["doctor.max_subrequests_per_run"]);
  });

  it("answers a locked-out operator, because a diagnostic only available when healthy is not one", async () => {
    const ctx = createSystemCtx();
    await claim(ctx);

    // Simulate the state that made this endpoint unreachable when it mattered: a signing key the
    // vault cannot unwrap, which is what a restored backup without its Durable Object storage looks
    // like. ADR 28 removed the missing-binding version of this, not the condition itself.
    await currentSigningKey(testEnv, ctx);
    await testEnv.CATALOG.prepare("UPDATE signing_keys SET private_jwk_wrapped = ? WHERE status = 'current'")
      .bind("v1.bm90LWEtd3JhcHBlZC1rZXk=").run();
    clearKeyCache();

    const report = await runDoctor(testEnv, ctx);
    expect(authenticationIsImpossible(report)).toBe(true);

    const reduced = withoutDataFindings(report);
    // Infrastructure findings survive: their contents are all published in this repository already.
    expect(reduced.findings.some((f) => f.check === "signing_key" && !f.ok)).toBe(true);
    // Anything derived from the organisation's mail does not.
    expect(reduced.findings.every((f) => f.discloses === "infrastructure")).toBe(true);
    expect(reduced.findings.some((f) => f.check === "evidence_present")).toBe(false);
    expect(reduced.findings.some((f) => f.check === "outbox_draining")).toBe(false);
    // And it says it is reduced, rather than looking like a complete clean report.
    const note = reduced.findings.find((f) => f.check === "report_reduced")!;
    expect(note.detail).toContain("withheld");
  });

  it("answers a locked-out operator when only the credential key is broken (#70)", async () => {
    const ctx = createSystemCtx();
    await claim(ctx);
    // A signing key wrapped under the *real* credential key, so it stays usable. That is the whole
    // point of this case: the test above breaks the signing key, and `authenticationIsImpossible`
    // tested `credential_kek` — a name no check emits — for the other half of its disjunction, so a
    // Node in *this* state got a 401 from the one endpoint that exists to explain it.
    await currentSigningKey(testEnv, ctx);
    clearKeyCache();

    const report = await runDoctor(withUnopenableCredentialKey(testEnv), ctx);

    const credential = find(report.findings, "credential_key");
    expect(credential.ok, "the credential round trip cannot succeed in this state").toBe(false);
    expect(credential.severity).toBe("refuse");
    // The half that was never covered: signing is *healthy* here. If this ever flips, the test has
    // drifted into being a second copy of the signing-key case and proves nothing new.
    expect(find(report.findings, "signing_key").ok, "the signing key must still work").toBe(true);
    // The injection's blast radius, asserted rather than described. A comment claimed `key_vault` stays
    // green and nothing checked it; if the proxy ever starts breaking the vault too, this case stops
    // being the credential-alone case and the comment goes quietly false.
    expect(find(report.findings, "key_vault").ok, "the vault itself is reachable").toBe(true);
    expect(
      report.findings.filter((f) => !f.ok && f.severity === "refuse").map((f) => f.check),
      "exactly one refusal, and it is the credential round trip",
    ).toEqual(["credential_key"]);

    expect(
      authenticationIsImpossible(report),
      "a Node that cannot round-trip a credential cannot mint a usable signing key, so nobody can sign in",
    ).toBe(true);

    const reduced = withoutDataFindings(report);
    expect(reduced.findings.some((f) => f.check === "credential_key" && !f.ok)).toBe(true);
    expect(reduced.findings.every((f) => f.discloses === "infrastructure")).toBe(true);
    expect(reduced.findings.some((f) => f.check === "evidence_present")).toBe(false);
  });

  it("serves that operator the report over HTTP rather than a 401 (#70)", async () => {
    // The decision this defect actually broke lives at `src/index.ts:314` — a claimed, unsigned-in caller
    // gets `unauthenticated()` *unless* `authenticationIsImpossible`. Every other test here asserts that
    // predicate and `withoutDataFindings` directly, and the only route-level doctor test runs on an
    // *unclaimed* Node where `orgId === null` skips the gate entirely. So nothing reached the branch, and
    // `authenticationIsImpossible` could return false forever for this state with the suite green.
    const ctx = createSystemCtx();
    await claim(ctx);
    await currentSigningKey(testEnv, ctx);
    clearKeyCache();

    const response = await worker.fetch(
      new Request("https://node.example/api/doctor"),
      withUnopenableCredentialKey(testEnv),
      ctx as unknown as ExecutionContext,
    );

    // 503 rather than 401: a refusing verdict tells a load balancer and a human the same thing.
    expect(response.status, "the locked-out operator is answered, not refused").toBe(503);
    const body = await response.json<{ findings: { check: string; ok: boolean }[] }>();
    expect(body.findings.some((f) => f.check === "credential_key" && !f.ok)).toBe(true);
  });

  it("does not open up when authentication merely fails for one caller", async () => {
    const ctx = createSystemCtx();
    await claim(ctx);
    await currentSigningKey(testEnv, ctx);
    // With a usable signing key and a working vault, a missing session is an ordinary 401 — the Node
    // can authenticate people, this caller just is not one. Not grounds to disclose anything.
    const report = await runDoctor(testEnv, ctx);
    expect(authenticationIsImpossible(report)).toBe(false);
  });

  it("tags every finding with what it discloses", async () => {
    const report = await runDoctor(testEnv, createSystemCtx());
    for (const finding of report.findings) {
      expect(["infrastructure", "data"], finding.check).toContain(finding.discloses);
    }
    // The data findings are the ones naming counts and receipt ids.
    const data = report.findings.filter((f) => f.discloses === "data").map((f) => f.check);
    expect(data).toContain("evidence_present");
    expect(data).toContain("outbox_draining");
  });

  it("formats a report a human can act on", async () => {
    const text = formatReport(await runDoctor(testEnv, createSystemCtx()));
    expect(text).toContain("mailda doctor");
    expect(text).toMatch(/FAIL|WARN|ok/);
    expect(text).toContain("fix      ");
  });
});
