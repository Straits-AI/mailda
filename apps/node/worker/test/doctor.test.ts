import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

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
    const stored = await putEvidence(testEnv, `${orgId}/raw/2026-Q3/legacy.eml`, new TextEncoder().encode("hi"));

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

    const stored = await putEvidence(testEnv, `org_1/raw/2026-Q3/${present}.eml`, new TextEncoder().encode("hi"));
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
    const stored = await putEvidence(testEnv, "org_1/raw/2026-Q3/one.eml", new TextEncoder().encode("hi"));
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
    // cannot quietly make doctor proportional to mailbox size.
    expect(BUDGETS["doctor.evidence_sample_size"]).toBeLessThanOrEqual(BUDGETS["doctor.max_subrequests"] / 2);
  });

  it("costs more per receipt, which is exactly what the scan bound exists to cap", async () => {
    const ctx = createSystemCtx();
    await claim(ctx);
    const at = new Date(ctx.now()).toISOString();
    const stored = await putEvidence(testEnv, "org_1/raw/2026-Q3/x.eml", new TextEncoder().encode("hi"));

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
