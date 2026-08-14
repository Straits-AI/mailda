import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { runDoctor } from "../src/doctor.ts";

/**
 * An event the Node could not attribute must not make it look less blind.
 *
 * ## The inversion
 *
 * `checkDeliveryVisibility` decides blindness with three terms, and the third was
 * `SELECT COUNT(*) FROM send_recipient_events WHERE org_id = ?` — **undifferentiated**. Blindness requires
 * `events === 0`, so **one** delivery event that matched no manifest was enough to make `blind` false and the
 * finding `ok`. The detail line then reported it as evidence: *"N of M handed-over recipient(s) have an
 * observed outcome, from K event(s)"*, with K counting events attributed to nothing.
 *
 * An unattributable event is evidence that **attribution is broken**. Counting it as evidence of sight
 * inverts its meaning, and it does so inside the one check whose entire purpose is that *"no bounces" must
 * not be able to mean "nothing heard"*. `migrations/0010` even builds a partial index over exactly these
 * rows — `sre_unattributed` — which nothing ever read, so somebody anticipated they would matter.
 *
 * ## Three states, not two
 *
 * A Node receiving events it cannot attribute is **neither blind nor healthy**, so §5C's rule against
 * collapsing distinct states applies — with more force in a diagnostic than anywhere else, because the whole
 * value of `doctor` is that it does not blur.
 */

const testEnv = env as unknown as Env;
const ORG = "org_blind";
const MAILBOX = "mbx_blind";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

const NOW = 2_500_000_000_000;
/** Comfortably older than the silence window, so it is "old enough to expect an answer". */
const LONG_AGO = new Date(NOW - 7 * 24 * 3600 * 1000).toISOString();

/** A handed-over recipient with no observed outcome — the raw material of blindness. */
async function anUnobservedHandOver(ctx: Ctx): Promise<string> {
  const manifestId = ctx.id("snd");
  await testEnv.CATALOG.prepare(
    `INSERT INTO send_manifests
       (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to, subject, rfc_message_id,
        fidelity, body_normalized_key, body_normalized_sha256, body_typed_key, body_typed_sha256,
        sealed_at, release_at, state, state_at, attempts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'handed_over', ?, 1)`,
  ).bind(manifestId, ORG, MAILBOX, "usr_a", "support@acme.example", '["c@example.net"]', "s",
    `${manifestId}@acme.example`, "authored", "k", "sha", "k2", "sha2", LONG_AGO, LONG_AGO, LONG_AGO).run();
  await testEnv.CATALOG.prepare(
    `INSERT INTO send_recipients (id, org_id, manifest_id, address, kind, submission_state,
                                  submission_state_at, attempts, delivery_state, created_at)
     VALUES (?,?,?,?, 'to', 'handed_over', ?, 1, NULL, ?)`,
  ).bind(ctx.id("srr"), ORG, manifestId, "c@example.net", LONG_AGO, LONG_AGO).run();
  return manifestId;
}

/** An event whose `messageId` matched nothing, stored with `manifest_id` NULL as the ingest does. */
async function anUnattributableEvent(ctx: Ctx): Promise<void> {
  await testEnv.CATALOG.prepare(
    `INSERT INTO send_recipient_events
       (event_id, org_id, manifest_id, recipient, event_type, transport_message_id, terminal, payload,
        received_at)
     VALUES (?,?, NULL, ?, 'message.delivered', ?, 1, '{}', ?)`,
  ).bind(ctx.id("sre"), ORG, "someone@example.net", "cf-unknown", LONG_AGO).run();
}

beforeEach(async () => {
  for (const table of ["send_recipient_events", "send_recipients", "send_manifests", "mailboxes",
                       "node_claim", "cases", "conversations", "messages"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
    .bind(MAILBOX, ORG, "Support", at).run();
  // Claimed, because delivery visibility is only meaningful for an organization that sends.
  await testEnv.CATALOG.prepare(
    "INSERT INTO node_claim (id, secret_hash, org_id, claimed_at) VALUES (1, ?, ?, ?)",
  ).bind("unused-in-this-test", ORG, at).run();
});

function visibility(report: Awaited<ReturnType<typeof runDoctor>>) {
  return report.findings.find((finding) => finding.check === "delivery_visibility")!;
}

describe("delivery visibility distinguishes blind from attributing-badly", () => {
  it("reports blind when nothing has been observed at all", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok, "a Node with hand-overs and no events should report blind").toBe(false);
    expect(finding.detail).toContain("nothing heard");
  });

  it("stays blind when the only event could not be attributed", async () => {
    // The defect: one unattributable event made `events > 0`, which made `blind` false, which made this
    // finding `ok` — so an event proving attribution is broken suppressed the blindness warning.
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    await anUnattributableEvent(ctx);

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok, "an unattributable event must not count as sight").toBe(false);
  });

  it("does not count an unattributable event as an observed outcome", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    await anUnattributableEvent(ctx);

    const finding = visibility(await runDoctor(testEnv, ctx));
    // The old detail line said "from 1 event(s)" while nothing had in fact been observed.
    expect(finding.detail).not.toMatch(/1 of 1 handed-over/);
  });

  it("raises its own finding for unattributable events, because that is a third state", async () => {
    // Neither blind nor healthy. §5C: distinct states must not collapse, and a diagnostic is the last place
    // to blur. `migrations/0010` built a partial index for these rows that nothing read.
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    await anUnattributableEvent(ctx);

    const report = await runDoctor(testEnv, ctx);
    const unattributed = report.findings.find((finding) => finding.check === "delivery_attribution");
    expect(unattributed, "expected a delivery_attribution finding").toBeDefined();
    expect(unattributed!.ok).toBe(false);
    expect(unattributed!.severity).toBe("degraded");
    expect(unattributed!.fix, "a finding a person cannot act on is a complaint").toBeTruthy();
  });

  it("says nothing about attribution when every event was attributed", async () => {
    const ctx = atTime(NOW);
    const manifestId = await anUnobservedHandOver(ctx);
    await testEnv.CATALOG.prepare(
      `INSERT INTO send_recipient_events
         (event_id, org_id, manifest_id, recipient, event_type, transport_message_id, terminal, payload,
          received_at)
       VALUES (?,?,?,?, 'message.delivered', ?, 1, '{}', ?)`,
    ).bind(ctx.id("sre"), ORG, manifestId, "c@example.net", "cf-known", LONG_AGO).run();

    const report = await runDoctor(testEnv, ctx);
    const unattributed = report.findings.find((finding) => finding.check === "delivery_attribution");
    expect(unattributed?.ok ?? true, "a clean Node should not carry an attribution complaint").toBe(true);
    // And an attributed event *is* sight, so blindness lifts.
    expect(visibility(report).ok).toBe(true);
  });
});
