import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { runDoctor, withoutDataFindings, type Finding } from "../src/doctor.ts";

/**
 * `inbound_routing`: what this Node can prove about whether mail can reach it (#101).
 *
 * ## The defect this exists because of
 *
 * The empty inbox said *"This Node is claimed and routing is live"*, derived from an empty result set,
 * which establishes neither half. The screen now says only what an empty list means and points here — so
 * this finding has to be worth arriving at, and these tests are about it saying only what it can support.
 *
 * The interesting property is **the negative one**: this finding must not claim that routing is currently
 * pointing at this Worker, because that lives in the Cloudflare account behind a token the Node
 * deliberately does not hold (ADR 22, ADR 24). Having received mail once is history. Every assertion below
 * that checks for an absence of a claim is checking that the replacement did not reintroduce the bug.
 */

const testEnv = env as unknown as Env;
const ORG = "org_routing";

function find(findings: Finding[], check: string): Finding {
  const found = findings.find((f) => f.check === check);
  if (found === undefined) throw new Error(`no finding named ${check}`);
  return found;
}

async function routing(): Promise<Finding> {
  const report = await runDoctor(testEnv, createSystemCtx());
  return find(report.findings, "inbound_routing");
}

beforeEach(async () => {
  for (const table of ["ingress_receipts", "addresses", "mailboxes", "node_claim"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)",
  ).bind(ctx.id("clm"), "x", new Date(ctx.now()).toISOString(), ORG).run();
});

async function addAddress(address: string): Promise<void> {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
  ).bind(ctx.id("addr"), ORG, address, "mbx_1", new Date(ctx.now()).toISOString()).run();
}

async function receive(n: number): Promise<void> {
  const ctx = createSystemCtx();
  for (let i = 0; i < n; i++) {
    await testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts
         (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes, blob_key, blob_sha256,
          accepted_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(
      ctx.id("ir"), ORG, `evt_${i}`, "someone@outside.test", "support@example.test", 100,
      `${ORG}/raw/k${i}`, "deadbeef", new Date(ctx.now()).toISOString(),
    ).run();
  }
}

describe("with no address configured, nothing can arrive and it says so", () => {
  it("reports not-ok, because this is actionable rather than merely quiet", async () => {
    const finding = await routing();
    expect(finding.ok).toBe(false);
    expect(finding.detail).toMatch(/No address is configured/);
    // The refusal shape AGENTS.md requires: what to do, not only what is wrong.
    expect(finding.fix).toMatch(/add an address/);
  });

  it("does not turn the whole report red", async () => {
    /*
     * `report` severity, so the verdict is unaffected. A freshly installed Node has no address yet, and a
     * check that refuses on every fresh install is one an operator learns to ignore before they reach the
     * Node where it means something — the argument `loopDetectionFinding` already makes in this file's
     * neighbour.
     */
    const report = await runDoctor(testEnv, createSystemCtx());
    expect(find(report.findings, "inbound_routing").severity).toBe("report");
    expect(report.verdict).not.toBe("refuse");
  });
});

describe("with an address but nothing received, it refuses to guess which", () => {
  beforeEach(async () => { await addAddress("support@example.test"); });

  it("names the possibilities rather than picking one", async () => {
    /*
     * This is the exact state the old inbox copy lied about. Correct setup with no mail yet and broken
     * routing are indistinguishable from inside the Worker, and the finding has to say that instead of
     * resolving it in either direction.
     */
    const finding = await routing();
    expect(finding.ok, "an address exists, so this is a healthy state").toBe(true);
    expect(finding.detail).toMatch(/Nothing has ever arrived/);
    expect(finding.detail).toMatch(/cannot tell those apart/);
    expect(finding.fix).toMatch(/Email Routing/);
  });

  it("never claims routing is live", async () => {
    // The sentence that started this. It must not come back in the diagnostic that replaced it.
    const finding = await routing();
    expect(finding.detail).not.toMatch(/routing is live/i);
  });
});

describe("once mail has arrived, it says so as history and not as a live status", () => {
  beforeEach(async () => {
    await addAddress("support@example.test");
    await receive(3);
  });

  it("credits the evidence without over-reading it", async () => {
    /*
     * The distinction the whole finding turns on. One receipt proves routing reached this Worker **once**.
     * It does not prove the zone still points here, because the configuration can have changed since — and
     * a Node whose routing was repointed an hour ago would otherwise read as healthy forever on the
     * strength of old mail.
     */
    const finding = await routing();
    expect(finding.ok).toBe(true);
    expect(finding.detail).toMatch(/3 message\(s\) have been accepted/);
    expect(finding.detail).toMatch(/history rather than a live status/);
    expect(finding.detail).not.toMatch(/routing is live/i);
  });

  it("offers no fix, because there is nothing wrong", async () => {
    expect((await routing()).fix).toBeUndefined();
  });
});

describe("the counts are data, so a locked-out reader does not get them", () => {
  it("is withheld by withoutDataFindings", async () => {
    /*
     * §5C. The counts are derived from an organization's mail — how many addresses it has and how many
     * messages it has received — so this finding is `discloses: "data"` and disappears from the report an
     * unauthenticated caller can read. Asserted rather than assumed, because the field is one word and
     * getting it wrong turns a diagnostic into a disclosure.
     */
    await addAddress("support@example.test");
    await receive(1);
    const finding = await routing();
    expect(finding.discloses).toBe("data");

    const reduced = withoutDataFindings(await runDoctor(testEnv, createSystemCtx()));
    expect(reduced.findings.find((one) => one.check === "inbound_routing")).toBeUndefined();
    // Non-vacuity: the reduction keeps *something*, so the assertion above is about this finding rather
    // than about an empty list.
    expect(reduced.findings.length).toBeGreaterThan(1);
  });
});
