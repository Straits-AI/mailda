import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { ROUTES } from "@mailda/contract/routes";

import { runDoctor } from "../src/doctor.ts";
import { applySendingEvent } from "../src/outbound/events.ts";
import { REQUIRED_PERMISSIONS } from "../src/provider/credential.ts";

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

/**
 * A handed-over recipient with no observed outcome — the raw material of blindness.
 *
 * `at` is the recipient's `submission_state_at`; `manifestStateAt` is the manifest's `state_at`, which
 * dispatch stamps after every recipient write and which is what `covered` compares. They differ only where a
 * test needs a send still running while a read ran.
 */
async function anUnobservedHandOver(ctx: Ctx, {
  address = "c@example.net", at = LONG_AGO, manifestState = "handed_over", manifestStateAt = at,
}: { address?: string; at?: string; manifestState?: string; manifestStateAt?: string } = {}): Promise<string> {
  const manifestId = ctx.id("snd");
  await testEnv.CATALOG.prepare(
    `INSERT INTO send_manifests
       (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to, subject, rfc_message_id,
        fidelity, body_normalized_key, body_normalized_sha256, body_typed_key, body_typed_sha256,
        sealed_at, release_at, state, state_at, attempts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 1)`,
  ).bind(manifestId, ORG, MAILBOX, "usr_a", "support@acme.example", JSON.stringify([address]), "s",
    `${manifestId}@acme.example`, "authored", "k", "sha", "k2", "sha2", at, at, manifestState, manifestStateAt).run();
  await testEnv.CATALOG.prepare(
    `INSERT INTO send_recipients (id, org_id, manifest_id, address, kind, submission_state,
                                  submission_state_at, attempts, delivery_state, created_at)
     VALUES (?,?,?,?, 'to', 'handed_over', ?, 1, NULL, ?)`,
  ).bind(ctx.id("srr"), ORG, manifestId, address, at, at).run();
  return manifestId;
}

/** An event whose `messageId` matched nothing, stored with `manifest_id` NULL as the ingest does. */
/**
 * `at` decides which of two different facts this is, and the default is the old one.
 *
 * An unattributable event **still arriving** is a live misconfiguration — something is publishing here that
 * this Node did not send. One that **stopped** is history, and nothing resolves it: the rows are correctly
 * recorded and 0010 keeps them on purpose. Both must stop the Node claiming sight; only the first is a
 * degradation.
 */
async function anUnattributableEvent(ctx: Ctx, at: string = LONG_AGO, recipient = "someone@example.net"): Promise<void> {
  await testEnv.CATALOG.prepare(
    `INSERT INTO send_recipient_events
       (event_id, org_id, manifest_id, recipient, event_type, transport_message_id, terminal, payload,
        received_at)
     VALUES (?,?, NULL, ?, 'message.delivered', ?, 1, '{}', ?)`,
  ).bind(ctx.id("sre"), ORG, recipient, "cf-unknown", at).run();
}

beforeEach(async () => {
  for (const table of ["send_recipient_events", "send_recipients", "send_manifests", "mailboxes",
                       "node_claim", "cases", "conversations", "messages", "log_entries",
                       "verified_destination_recipients", "verified_destination_read"]) {
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

function voidFinding(report: Awaited<ReturnType<typeof runDoctor>>) {
  const found = report.findings.find((finding) => finding.check === "delivery_explanation_void");
  expect(found, "expected a delivery_explanation_void finding").toBeDefined();
  return found!;
}

describe("delivery visibility distinguishes blind from attributing-badly", () => {
  it("reports blind when nothing has been observed at all", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok, "a Node with hand-overs and no events should report blind").toBe(false);
    expect(finding.detail).toContain("nothing heard");

    // Since #72 there are **two** account-level things missing from a blind Node, not one, and the queue
    // consumer is the one an install can now legitimately lack. A fix naming only the subscription sends an
    // operator to look for a misrouted subscription that may not be the problem at all.
    expect(finding.fix, "the fix must name the consumer attach step").toContain("queue:attach-consumer");
    expect(finding.fix).toContain("event subscription");
    // And it must not name a queue: the name is derived per Node since #72, so a printed one is a guess.
    expect(finding.fix).not.toContain("mailda-sending-events");
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

  it("degrades on unattributable events that are still arriving, because that is a third state", async () => {
    // Neither blind nor healthy. §5C: distinct states must not collapse, and a diagnostic is the last place
    // to blur. `migrations/0010` built a partial index for these rows that nothing read.
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    await anUnattributableEvent(ctx, new Date(NOW - 1000).toISOString());

    const report = await runDoctor(testEnv, ctx);
    const unattributed = report.findings.find((finding) => finding.check === "delivery_attribution");
    expect(unattributed, "expected a delivery_attribution finding").toBeDefined();
    expect(unattributed!.ok).toBe(false);
    expect(unattributed!.severity).toBe("degraded");
    expect(unattributed!.fix, "a finding a person cannot act on is a complaint").toBeTruthy();
  });

  it("reports, and does not degrade, on unattributable events that stopped", async () => {
    /*
     * **The live Node's actual state, and the reason this split exists.** Three events from five weeks ago,
     * from a message sent on its sending domain by something that was not this Node. The rows are correct,
     * nothing resolves them, and the check degraded for ever on them — so `doctor` exited 1 on a Node in
     * good health. A finding that fails on every Node for ever is one somebody mutes, which is the failure
     * mode `DELIVERY_SILENCE_MS` names in this same file.
     */
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    await anUnattributableEvent(ctx);

    const report = await runDoctor(testEnv, ctx);
    const unattributed = report.findings.find((finding) => finding.check === "delivery_attribution")!;
    expect(unattributed, "the evidence must not vanish just because it stopped").toBeDefined();
    expect(unattributed.ok).toBe(true);
    expect(unattributed.severity).toBe("report");
    // Still said, and said as a count, so an operator investigating a lost bounce finds a trace of it.
    expect(unattributed.detail).toContain("1 delivery event");
  });

  it("counts a recent unattributable event and mentions the older ones beside it", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    await anUnattributableEvent(ctx, new Date(NOW - 1000).toISOString());
    await anUnattributableEvent(ctx);
    await anUnattributableEvent(ctx);

    const report = await runDoctor(testEnv, ctx);
    const unattributed = report.findings.find((finding) => finding.check === "delivery_attribution")!;
    expect(unattributed.severity).toBe("degraded");
    // One is the fault; the two behind it are context, and conflating them is what made this fail for ever.
    expect(unattributed.detail).toContain("1 delivery event");
    expect(unattributed.detail).toContain("2 older ones");
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

/* ------------------------------------------ verified destinations (28 September 2026) ------------------ */

/**
 * No outcome is reported for verified destinations, and the silence they leave must not read as blindness.
 *
 * Cloudflare published no `email.sending` event for mail to a verified Email Routing destination of the
 * account in the one case measured (`docs/receipts/email-sending-events.md`). A read of the account's list
 * records which of this Node's recipients were verified, over which interval, and doctor reads that record
 * with no live call. These pin the three silences `delivery_visibility` tells apart (explained, covered and not
 * explained, not covered), the extrapolation past the latest read and where it stops, the race a read can
 * lose against a send still dispatching, and the two kinds of evidence that void the explanation.
 */

const ACCOUNT = "acct_fixture";
const days = (n: number): string => new Date(NOW - n * 24 * 3600 * 1000).toISOString();
/** Long before the hand-over, as Cloudflare's verified timestamp. */
const VERIFIED_LONG_BEFORE = days(30);
/** A read after the hand-over at LONG_AGO (seven days) had finished. */
const READ_AFTER = days(6);

/** A row as the read writes it: the address was verified from `from`, and the latest read listing it ran at `until`. */
async function aVerifiedRecipient(address: string, from: string, until: string): Promise<void> {
  await testEnv.CATALOG.prepare(
    `INSERT INTO verified_destination_recipients (org_id, address, verified_from, verified_until)
     VALUES (?,?,?,?)`,
  ).bind(ORG, address, from, until).run();
}

/** The read row. `readAt` null is a Node whose every attempt failed; `error` is the latest attempt's. */
async function aRead({ readAt, attemptedAt = readAt!, error = null, accountId = readAt === null ? null : ACCOUNT }: {
  readAt: string | null; attemptedAt?: string; error?: string | null; accountId?: string | null;
}): Promise<void> {
  await testEnv.CATALOG.prepare(
    `INSERT INTO verified_destination_read (id, account_id, authority, read_at, attempted_at, error)
     VALUES (1, ?, 'token', ?, ?, ?)`,
  ).bind(accountId, readAt, attemptedAt, error).run();
}

/** An outcome observed for one recipient: its state, and the attributed event that set it. */
async function anOutcome(ctx: Ctx, manifestId: string, address: string): Promise<void> {
  await testEnv.CATALOG.prepare(
    "UPDATE send_recipients SET delivery_state = 'accepted', delivery_state_at = ? WHERE manifest_id = ?",
  ).bind(LONG_AGO, manifestId).run();
  await testEnv.CATALOG.prepare(
    `INSERT INTO send_recipient_events
       (event_id, org_id, manifest_id, recipient, event_type, transport_message_id, terminal, payload,
        received_at)
     VALUES (?,?,?,?, 'cf.email.sending.message.delivered', ?, 1, '{}', ?)`,
  ).bind(ctx.id("sre"), ORG, manifestId, address, "cf-known", LONG_AGO).run();
}

/** A verified destination, proven by a read that ran after the send finished: the explained case. */
async function aProvenVerifiedHandOver(ctx: Ctx, address = "c@example.net"): Promise<string> {
  const manifestId = await anUnobservedHandOver(ctx, { address });
  await aVerifiedRecipient(address, VERIFIED_LONG_BEFORE, READ_AFTER);
  return manifestId;
}

describe("delivery visibility and verified destinations", () => {
  it("calls silence expected when a read shows every silent recipient verified at hand-over", async () => {
    const ctx = atTime(NOW);
    await aProvenVerifiedHandOver(ctx);
    await aRead({ readAt: READ_AFTER });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(true);
    expect(finding.detail).toContain("No outcome is reported for verified destinations");
    expect(finding.detail).toContain("not a fault this Node can fix");
    // Which account's list said so, because a Node lives in one account and the reader should see which.
    expect(finding.detail).toContain(`account ${ACCOUNT}`);
    // The latest attempt is the read itself, so there is no later failure to mention.
    expect(finding.detail).not.toContain("A later attempt");
    expect(finding.fix).toBeUndefined();
  });

  it("does not explain a hand-over by a verification that came after it", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    await aVerifiedRecipient("c@example.net", days(6.5), READ_AFTER);
    await aRead({ readAt: READ_AFTER });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("not shown as");
    // Nothing unchecked and nothing explained, so neither "more" sentence is said with a zero in it.
    expect(finding.detail).not.toContain("have not been checked");
    expect(finding.detail).not.toContain("more were verified destinations");
  });

  it("keeps explaining a hand-over inside the proven interval after the address left the list", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    // Listed by a read at 6.5 days, not by the latest at 6: removed in between, after the hand-over at 7.
    await aVerifiedRecipient("c@example.net", VERIFIED_LONG_BEFORE, days(6.5));
    await aRead({ readAt: READ_AFTER });

    expect(visibility(await runDoctor(testEnv, ctx)).ok).toBe(true);
  });

  it("extrapolates past the latest read for an address that read still listed", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    const read = days(8);
    // The same string on both sides: the extrapolation clause is text equality with the read's instant.
    await aVerifiedRecipient("c@example.net", VERIFIED_LONG_BEFORE, read);
    await aRead({ readAt: read });

    expect(visibility(await runDoctor(testEnv, ctx)).ok).toBe(true);
  });

  it("stops extrapolating for an address the latest read no longer listed", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    await aVerifiedRecipient("c@example.net", VERIFIED_LONG_BEFORE, days(9));
    await aRead({ readAt: days(8) });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("None of them is covered");
  });

  it("is blind for the unexplained recipients of a Node that also sends to verified ones", async () => {
    const ctx = atTime(NOW);
    await aProvenVerifiedHandOver(ctx, "x@example.net");
    await anUnobservedHandOver(ctx, { address: "y@example.net" });
    // Handed over after the read (5 days against 6), so the read could not have seen it.
    await anUnobservedHandOver(ctx, { address: "w@example.net", at: days(5) });
    await aRead({ readAt: READ_AFTER });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("1 recipient handed over");
    expect(finding.detail).toContain(`account ${ACCOUNT}`);
    expect(finding.detail).toContain("1 more are not covered by that read, because the latest dispatch pass");
    expect(finding.detail).toContain("1 more were verified destinations");
    // That sentence relies on the extrapolation and on four sends, and says both.
    expect(finding.detail).toContain("no outcome is reported for verified destinations, in the one case measured");
    expect(finding.detail).toContain("still counts as verified here until the list is read again");
    // A read already covered them, so the subscription is the suspect and the fix does not ask for the read.
    expect(finding.fix).toContain("queue:attach-consumer");
    expect(finding.fix).not.toContain("Email Routing Addresses");
  });

  it("asks for the read first when this Node has never read the list", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("has never read");
    expect(finding.detail).not.toContain("more were verified destinations");
    // Nothing voids the inference here, so the fix opens with the read, not with the void's first step.
    expect(finding.fix!.startsWith("first find out whether these recipients are verified destinations")).toBe(true);
    expect(finding.fix).toMatch(/verified destinations[\s\S]*queue:attach-consumer/);
    // Read from the registry, so renaming the permission there turns this red rather than leaving the fix
    // naming one no token can be given.
    const permission = REQUIRED_PERMISSIONS.find((one) => one.name.startsWith("Email Routing Addresses"));
    expect(permission, "the permission the fix names must be in REQUIRED_PERMISSIONS").toBeDefined();
    expect(finding.fix).toContain(permission!.name);
    // And the route it names is the one the contract serves, so moving the route turns this red.
    const route = ROUTES.find((one) => one.method === "POST" && one.path.endsWith("/verified-destinations"));
    expect(route, "the read the fix names must be a route").toBeDefined();
    expect(finding.fix).toContain(`POST ${route!.path}`);
  });

  it("says could not read, not none verified, when every read failed", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    // Synthetic words on purpose: `10000 Authentication error` is what a rejected token is recorded as
    // answering, and a reader would take a fixture using it for a measurement.
    await aRead({ readAt: null, attemptedAt: READ_AFTER, error: "fixture: refused for the test" });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("fixture: refused for the test");
    expect(finding.detail).toContain("could not read, not none verified");
    expect(finding.detail).not.toContain("not shown as");
  });

  it("does not count a send as checked by a read that ran while it was still dispatching", async () => {
    const ctx = atTime(NOW);
    // The recipient row carries the pass's start (7 days), the manifest the pass's end (5 days); the read
    // ran between them (6 days), so it may have missed this recipient.
    await anUnobservedHandOver(ctx, { manifestStateAt: days(5) });
    await aRead({ readAt: READ_AFTER });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("None of them is covered");
    expect(finding.detail).not.toContain("not shown as");
  });

  it("never counts a send whose pass died as checked", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx, { manifestState: "outcome_unknown" });
    await aProvenVerifiedHandOver(ctx, "x@example.net");
    await aRead({ readAt: READ_AFTER });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("None of them is covered");
    // Not "handed over after the read": this one was handed over a day before it, by a pass that never finished.
    expect(finding.detail).toContain("That pass ran during or after the read, or has not finished.");
    expect(finding.detail).toContain("1 more were verified destinations when handed over");
    expect(finding.detail).toContain("still counts as verified here until the list is read again");
  });

  it("stops calling silence explained when a verified destination had an outcome", async () => {
    const ctx = atTime(NOW);
    await aProvenVerifiedHandOver(ctx, "x@example.net");
    const heard = await aProvenVerifiedHandOver(ctx, "z@example.net");
    await anOutcome(ctx, heard, "z@example.net");
    await aRead({ readAt: READ_AFTER });

    const report = await runDoctor(testEnv, ctx);
    // It can see, so it is not blind, and the breakers must not be told it is.
    const finding = visibility(report);
    expect(finding.ok).toBe(true);
    expect(finding.detail).toBe("1 of 2 handed-over recipients has an observed outcome, from 1 attributed event.");
    // The receipt's tripwire firing is a degradation of its own, with the way to resolve it.
    const against = voidFinding(report);
    expect(against.ok).toBe(false);
    expect(against.severity).toBe("degraded");
    expect(against.detail).toContain("1 recipient that a read showed as verified destinations when handed over had a delivery event published for them");
    expect(against.detail).toContain("which no verified destination did in the one case measured");
    expect(against.detail).toContain("still counts as verified here until the list is read again");
    expect(against.detail).not.toContain("could not be used");
    // Every event here was attributed, so the unattributed sentence is not said with a zero in it.
    expect(against.detail).not.toContain("could not tie to a send");
    expect(against.fix!.startsWith("remeasure docs/receipts/email-sending-events.md")).toBe(true);
    expect(against.receipt).toBe("docs/receipts/email-sending-events.md");
  });

  it("stops calling silence explained when an event that sets no state was published for a verified destination", async () => {
    // A complained event is stored attributed and sets no delivery state, so the recipient stays silent. It is
    // still an email.sending event published for a verified destination, which is the receipt's tripwire.
    const ctx = atTime(NOW);
    const manifestId = await aProvenVerifiedHandOver(ctx, "x@example.net");
    await testEnv.CATALOG.prepare("UPDATE send_recipients SET transport_message_id = ? WHERE manifest_id = ?")
      .bind("<complained@acme.example>", manifestId).run();
    await aRead({ readAt: READ_AFTER });
    const outcome = await applySendingEvent(testEnv, ctx, ORG, {
      type: "cf.email.sending.message.complained",
      payload: { eventId: "evt_complained", messageId: "<complained@acme.example>", recipient: "X@example.net" },
    });
    expect(outcome, "the fixture must be an attributed event that sets no state").toMatchObject({
      applied: true, manifestId, deliveryState: null,
    });

    const report = await runDoctor(testEnv, ctx);
    const finding = visibility(report);
    // Heard from, so not blind, and not branch 5 or 6: nothing here is called explained.
    expect(finding.ok).toBe(true);
    expect(finding.detail).toBe("0 of 1 handed-over recipient have an observed outcome, from 1 attributed event.");
    const against = voidFinding(report);
    expect(against.ok).toBe(false);
    expect(against.detail).toContain("1 recipient that a read showed as verified destinations when handed over had a delivery event published for them");
  });

  it("degrades on an unusable event even on a Node that is hearing outcomes", async () => {
    const ctx = atTime(NOW);
    await aProvenVerifiedHandOver(ctx, "x@example.net");
    // Heard, and not a verified destination, so the Node can see and contradicts nothing.
    const heard = await anUnobservedHandOver(ctx, { address: "z@example.net" });
    await anOutcome(ctx, heard, "z@example.net");
    await aRead({ readAt: READ_AFTER });
    const outcome = await applySendingEvent(testEnv, ctx, ORG, {
      type: "cf.email.sending.message.delivered", payload: { recipient: "x@example.net" },
    });
    expect(outcome.unusable, "the fixture must be an unusable event").toEqual(["payload.eventId"]);

    const report = await runDoctor(testEnv, ctx);
    expect(visibility(report).ok).toBe(true);
    const against = voidFinding(report);
    expect(against.ok).toBe(false);
    expect(against.detail).toContain("could not be used");
    expect(against.detail).not.toContain("still counts as verified here");
    expect(against.fix!.startsWith("read the sending_event.unusable")).toBe(true);
    expect(against.fix).not.toContain("remeasure");
  });

  it("stops calling silence explained when an event it could not attribute was for a listed address", async () => {
    const ctx = atTime(NOW);
    await aProvenVerifiedHandOver(ctx, "x@example.net");
    await aRead({ readAt: READ_AFTER });
    // Inside the proven interval, and in the case Cloudflare wrote it: the address is compared folded.
    await anUnattributableEvent(ctx, days(6.5), "X@Example.net");

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).not.toContain("not a fault this Node can fix");
    expect(finding.detail).toContain("1 delivery event this Node could not tie to a send was for addresses");
    expect(finding.fix).toContain("The delivery_attribution finding counts the events");
    expect(finding.fix!.startsWith("remeasure docs/receipts/email-sending-events.md")).toBe(true);
    // A read listed every silent recipient, and the evidence voids that: the conditional must not resolve to
    // "expected", and the fix does not ask again for the read it already has (its re-read arm is the evidence's).
    expect(finding.detail).not.toContain("the silence is expected");
    expect(finding.detail).toContain("the evidence above stops this check calling it so");
    expect(finding.fix).not.toContain("find out whether these recipients are verified destinations");
  });

  it("holds an unattributed event after the latest read against an address that read still listed", async () => {
    // The ordinary case: the list is read at setup, and events for later sends arrive after that read.
    const ctx = atTime(NOW);
    await aProvenVerifiedHandOver(ctx, "x@example.net");
    await aRead({ readAt: READ_AFTER });
    await anUnattributableEvent(ctx, days(1), "X@example.net");

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("could not tie to a send");
    expect(finding.detail).not.toContain("not a fault this Node can fix");
  });

  it("does not hold an address's outcome on an earlier send against a later silent one", async () => {
    // Answered at 40 days, before it was verified (30); silent at 7, verified then. Only the manifest tells the
    // two sends apart, and the earlier outcome contradicts nothing about the later silence.
    const ctx = atTime(NOW);
    const early = await anUnobservedHandOver(ctx, { address: "x@example.net", at: days(40) });
    await anOutcome(ctx, early, "x@example.net");
    await aProvenVerifiedHandOver(ctx, "x@example.net");
    await aRead({ readAt: READ_AFTER });

    const report = await runDoctor(testEnv, ctx);
    const finding = visibility(report);
    expect(finding.ok).toBe(true);
    expect(finding.detail).toContain("1 of the 1 without one were shown as verified");
    expect(report.findings.find((one) => one.check === "delivery_explanation_void")).toBeUndefined();
  });

  it("does not hold an event against an address outside the interval a read proved for it", async () => {
    const ctx = atTime(NOW);
    // Verified from 30 days to 9, handed over at 10; the latest read (8) no longer lists it.
    await anUnobservedHandOver(ctx, { address: "x@example.net", at: days(10) });
    await aVerifiedRecipient("x@example.net", VERIFIED_LONG_BEFORE, days(9));
    await aRead({ readAt: days(8) });
    // One after the interval ended and one before it began: neither was sent to a verified destination.
    await anUnattributableEvent(ctx, days(7), "x@example.net");
    await anUnattributableEvent(ctx, days(31), "x@example.net");

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(true);
    expect(finding.detail).toContain("not a fault this Node can fix");
  });

  it("stops calling silence explained while an unusable event is on the log", async () => {
    const ctx = atTime(NOW);
    await aProvenVerifiedHandOver(ctx);
    await aRead({ readAt: READ_AFTER });
    // Through the writer that produces the line, so a renamed log event fails here rather than reading 0.
    const outcome = await applySendingEvent(testEnv, ctx, ORG, {
      type: "cf.email.sending.message.delivered", payload: { recipient: "c@example.net" },
    });
    expect(outcome.unusable, "the fixture must be an unusable event").toEqual(["payload.eventId"]);

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("could not be used");
    expect(finding.detail).not.toContain("had a delivery event published");
    // The read covered and listed it, so it is said to have been shown as verified, and not as uncovered.
    expect(finding.detail).toContain("1 of them were shown as verified destinations when handed over by a read");
    expect(finding.detail).not.toContain("covered by this Node's latest read");
    expect(finding.detail).not.toContain("the silence is expected");
    expect(finding.fix!.startsWith("read the sending_event.unusable")).toBe(true);
    expect(finding.fix).not.toContain("find out whether these recipients are verified destinations");
  });

  it("keeps what a covering read found when evidence voids the explanation", async () => {
    // The read covered this send and did not list it; an unusable event voids explanations, not that finding.
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx, { address: "n@example.net" });
    await aRead({ readAt: READ_AFTER });
    await applySendingEvent(testEnv, ctx, ORG, {
      type: "cf.email.sending.message.delivered", payload: { recipient: "n@example.net" },
    });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("1 recipient handed over more than 15 minutes ago was not shown as a verified Email Routing destination");
    expect(finding.detail).toContain("could not be used");
    // The read already answered for it, so the fix does not ask for the read.
    expect(finding.fix!.startsWith("read the sending_event.unusable")).toBe(true);
    expect(finding.fix).not.toContain("find out whether these recipients are verified destinations");
    expect(finding.fix).toContain("queue:attach-consumer");
  });

  it("names a voided listed recipient as listed, not as uncovered, beside one a read did not list", async () => {
    const ctx = atTime(NOW);
    await aProvenVerifiedHandOver(ctx, "x@example.net");
    await anUnobservedHandOver(ctx, { address: "y@example.net" });
    await aRead({ readAt: READ_AFTER });
    await applySendingEvent(testEnv, ctx, ORG, {
      type: "cf.email.sending.message.delivered", payload: { recipient: "x@example.net" },
    });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("1 recipient handed over");
    expect(finding.detail).toContain("1 more were shown as verified destinations when handed over, and are not counted as explained.");
    // It relies on the extrapolation, and no evidence sentence said so first.
    expect(finding.detail).toContain("still counts as verified here until the list is read again");
    expect(finding.detail).not.toContain("are not covered by that read");
    expect(finding.detail).not.toContain("more were verified destinations when handed over, and no outcome");
  });

  it("still says could not read when evidence voids the explanation on a Node no read has covered", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx);
    await aRead({ readAt: null, attemptedAt: READ_AFTER, error: "fixture: refused for the test" });
    await applySendingEvent(testEnv, ctx, ORG, {
      type: "cf.email.sending.message.delivered", payload: { recipient: "c@example.net" },
    });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("could not read, not none verified");
    expect(finding.detail).toContain("could not be used");
    // The evidence's step first, then the read, and "first" said once.
    expect(finding.fix!.startsWith("read the sending_event.unusable")).toBe(true);
    expect(finding.fix).toContain("then find out whether these recipients are verified destinations");
    expect(finding.fix!.match(/\bfirst\b/g)).toHaveLength(1);
  });

  it("gives the sample the verified-destination exception rests on in sending_events_consumer too", async () => {
    const consumer = (await runDoctor(testEnv, atTime(NOW))).findings.find((one) => one.check === "sending_events_consumer")!;
    expect(consumer.detail).toContain("for which Cloudflare published no outcome in the one case measured");
  });

  it("says nothing is awaited on a Node that has handed nothing over long enough ago", async () => {
    const ctx = atTime(NOW);
    await anUnobservedHandOver(ctx, { at: new Date(NOW - 60_000).toISOString() });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(true);
    expect(finding.detail).toBe("Nothing has been handed over long enough to expect an answer yet.");
  });

  it("counts the explained silence beside the outcomes a Node that can see has heard", async () => {
    const ctx = atTime(NOW);
    await aProvenVerifiedHandOver(ctx, "x@example.net");
    // Heard, and not a verified destination, so it contradicts nothing.
    const heard = await anUnobservedHandOver(ctx, { address: "z@example.net" });
    await anOutcome(ctx, heard, "z@example.net");
    await aRead({ readAt: READ_AFTER });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(true);
    expect(finding.detail).toContain("1 of 2 handed-over recipients has an observed outcome");
    expect(finding.detail).toContain("1 of the 1 without one were shown as verified");
    expect(finding.detail).toContain("still counts as verified here until the list is read again");
  });

  it("says when a later read failed, beside the read that still stands", async () => {
    const ctx = atTime(NOW);
    await aProvenVerifiedHandOver(ctx);
    await aRead({ readAt: READ_AFTER, attemptedAt: days(1), error: "fixture: refused for the test" });

    const finding = visibility(await runDoctor(testEnv, ctx));
    expect(finding.ok).toBe(true);
    expect(finding.detail).toContain(`A later attempt, at ${days(1)}, did not succeed`);
  });
});
