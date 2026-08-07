import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { applySendingEvent, type SendingEvent } from "../src/outbound/events.ts";

/**
 * Layer 2's proof line: **accepted / bounced / outcome_unknown distinguished, never blurred.**
 *
 * These are the tests that make that sentence true rather than aspirational. Each state has to arrive from
 * a real observation and be distinguishable from the other two and from *nothing observed yet*, which is a
 * fourth thing people habitually collapse into one of the three.
 *
 * Payload shapes are taken from `docs/receipts/email-sending-events.md`, including the one measured
 * verbatim from a real bounce — which carried **no** `smtpStatusCode` at all, because the failure never
 * reached SMTP.
 */

const testEnv = env as unknown as Env;
const ORG = "org_events";
const MANIFEST = "snd_events_1";
const TRANSPORT_ID = "<pIlEAeNiwq8Yqda1hdkDyqtTdfdzfrhVHHKb@mailda-test.whymelabs.com>";

beforeEach(async () => {
  for (const table of ["send_recipient_events", "send_recipients", "send_manifests"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const at = "2026-08-07T00:00:00.000Z";
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare(
      `INSERT INTO send_manifests
         (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to, subject, rfc_message_id,
          fidelity, body_typed_key, body_typed_sha256, body_normalized_key, body_normalized_sha256,
          sealed_at, release_at, state, state_at, transport_message_id, attempts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'handed_over',?,?,1)`,
    ).bind(MANIFEST, ORG, "mbx_1", "usr_1", "from@example.com", '["one@example.net"]', "s",
      "rfc@example.com", "authored", "k1", "h1", "k2", "h2", at, at, at, TRANSPORT_ID),
    testEnv.CATALOG.prepare(
      `INSERT INTO send_recipients
         (id, org_id, manifest_id, kind, address, submission_state, submission_state_at, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind("srp_1", ORG, MANIFEST, "to", "one@example.net", "handed_over", at, at),
    testEnv.CATALOG.prepare(
      `INSERT INTO send_recipients
         (id, org_id, manifest_id, kind, address, submission_state, submission_state_at, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind("srp_2", ORG, MANIFEST, "to", "two@example.net", "handed_over", at, at),
  ]);
});

function event(type: string, over: Record<string, unknown> = {}): SendingEvent {
  return {
    type: `cf.email.sending.message.${type}`,
    payload: {
      eventId: `ev_${type}_${String(over.recipient ?? "one")}`,
      messageId: TRANSPORT_ID,
      sender: "from@example.com",
      recipient: "one@example.net",
      subject: "s",
      terminal: type !== "deferred",
      ...over,
    },
  } as SendingEvent;
}

async function stateOf(address: string) {
  return testEnv.CATALOG.prepare(
    "SELECT delivery_state, bounce_type, last_error, last_event_id FROM send_recipients WHERE address = ?",
  ).bind(address).first<{
    delivery_state: string | null; bounce_type: string | null;
    last_error: string | null; last_event_id: string | null;
  }>();
}

describe("accepted, bounced and outcome_unknown, never blurred", () => {
  it("a 250 from the receiving server becomes accepted", async () => {
    await applySendingEvent(testEnv, createSystemCtx(), ORG,
      event("delivered", { delivery: { status: "delivered", smtpStatusCode: "250" } }));

    // §5C forbids claiming an outcome nobody observed. Somebody observed this one: the receiving mail
    // server returned 250 and Cloudflare reports the code. Withholding it would leave the ladder's own
    // first word unrepresentable while the platform hands it over.
    expect((await stateOf("one@example.net"))?.delivery_state).toBe("accepted");
  });

  it("a hard bounce becomes bounced, carrying the provider's own words", async () => {
    await applySendingEvent(testEnv, createSystemCtx(), ORG, event("bounced", {
      delivery: { status: "bounced", smtpResponse: "Permanent: unknown public suffix: example.invalid" },
      bounce: { type: "hard", classification: "permanent_failure", reason: "550 5.1.1 User unknown" },
    }));

    const row = await stateOf("one@example.net");
    expect(row?.delivery_state).toBe("bounced");
    expect(row?.bounce_type).toBe("hard");
    // Verbatim, not paraphrased: a paraphrase of an SMTP response is a guess about somebody else's server.
    expect(row?.last_error).toBe("550 5.1.1 User unknown");
  });

  it("leaves a recipient nobody reported as unobserved, which is not an outcome", async () => {
    await applySendingEvent(testEnv, createSystemCtx(), ORG, event("delivered"));

    // The heart of it. One recipient accepted, the other simply not heard about — and the second must not
    // inherit the first's outcome or be shown as anything but unobserved.
    expect((await stateOf("one@example.net"))?.delivery_state).toBe("accepted");
    expect((await stateOf("two@example.net"))?.delivery_state).toBeNull();
  });

  it("records a mixed outcome on one send, which was previously unrepresentable", async () => {
    const ctx = createSystemCtx();
    await applySendingEvent(testEnv, ctx, ORG, event("delivered"));
    await applySendingEvent(testEnv, ctx, ORG, event("bounced", {
      recipient: "two@example.net", bounce: { type: "hard", reason: "550 no such user" },
    }));

    // One send, one submission, two different truths. With a single state column on send_manifests this
    // could only have been recorded as one of them.
    expect((await stateOf("one@example.net"))?.delivery_state).toBe("accepted");
    expect((await stateOf("two@example.net"))?.delivery_state).toBe("bounced");
  });

  it("keeps deferred separate from both, because retries are still pending", async () => {
    await applySendingEvent(testEnv, createSystemCtx(), ORG, event("deferred", {
      terminal: false,
      bounce: { type: "soft", classification: "temporary_failure", reason: "451 4.2.0 try later" },
    }));

    // `deferred` is the honest word for outcome-still-unknown *with a reason*, which beats silence — and
    // it must not read as either success or failure.
    const row = await stateOf("one@example.net");
    expect(row?.delivery_state).toBe("deferred");
    expect(row?.bounce_type).toBe("soft");
  });
});

describe("the properties a queue forces on us", () => {
  it("applies an event once, however many times it is delivered", async () => {
    const ctx = createSystemCtx();
    const first = await applySendingEvent(testEnv, ctx, ORG, event("delivered"));
    const again = await applySendingEvent(testEnv, ctx, ORG, event("delivered"));

    // Queues deliver at least once. `event_id` is the primary key, so a redelivery loses at the database
    // — #9's shape, the same one the audit chain uses.
    expect(first.applied).toBe(true);
    expect(again.applied).toBe(false);

    const count = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM send_recipient_events")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("does not let a late deferral overwrite a bounce", async () => {
    const ctx = createSystemCtx();
    await applySendingEvent(testEnv, ctx, ORG, event("bounced", {
      bounce: { type: "hard", reason: "550 gone" },
    }));
    // Out of order on purpose: queues guarantee no ordering, so the deferral that *preceded* the bounce
    // can arrive after it. Without the guard the Node would report "still trying" about a dead message.
    await applySendingEvent(testEnv, ctx, ORG, event("deferred", { terminal: false, eventId: "ev_late" }));

    expect((await stateOf("one@example.net"))?.delivery_state).toBe("bounced");
  });

  it("upgrades deferred to a terminal outcome when one arrives", async () => {
    const ctx = createSystemCtx();
    await applySendingEvent(testEnv, ctx, ORG, event("deferred", { terminal: false }));
    await applySendingEvent(testEnv, ctx, ORG, event("delivered", { eventId: "ev_after_defer" }));

    // The other direction must work, or a message that was retried and then accepted reads as pending.
    expect((await stateOf("one@example.net"))?.delivery_state).toBe("accepted");
  });

  it("stores an event it cannot attribute rather than dropping it", async () => {
    const outcome = await applySendingEvent(testEnv, createSystemCtx(), ORG,
      event("bounced", { messageId: "<not-ours@elsewhere.example>", eventId: "ev_orphan" }));

    // A bounce nobody can attribute is still a bounce. Dropping it converts a fact into silence, which is
    // exactly what this layer exists to prevent — so it is kept, with a NULL manifest, and indexed as the
    // thing a person needs to look at.
    expect(outcome.manifestId).toBeNull();
    const row = await testEnv.CATALOG.prepare(
      "SELECT manifest_id, recipient FROM send_recipient_events WHERE event_id = 'ev_orphan'",
    ).first<{ manifest_id: string | null; recipient: string }>();
    expect(row?.manifest_id).toBeNull();
    expect(row?.recipient).toBe("one@example.net");
  });

  it("survives a malformed event instead of poisoning the batch", async () => {
    // A queue retries the whole batch, so one unusable message must not block every good one behind it.
    const outcome = await applySendingEvent(testEnv, createSystemCtx(), ORG,
      { type: "cf.email.sending.message.bounced" } as SendingEvent);
    expect(outcome.applied).toBe(false);
  });

  it("does not set a delivery state for a complaint, because the message did arrive", async () => {
    await applySendingEvent(testEnv, createSystemCtx(), ORG, event("complained"));

    // Being marked as spam is a fact about reputation, not about arrival. Recording it as a delivery
    // failure would be false — and the event is still stored, because it matters for other reasons.
    expect((await stateOf("one@example.net"))?.delivery_state).toBeNull();
    const stored = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM send_recipient_events WHERE event_type LIKE '%complained'",
    ).first<{ n: number }>();
    expect(stored?.n).toBe(1);
  });
});

describe("a stray delivery report cannot contradict the outbox", () => {
  const DSN = [
    "From: MAILER-DAEMON@relay.example",
    "To: inbox@mailda-test.example",
    "Subject: Delivery Status Notification (Failure)",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
    "",
    "--b",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; relay.example",
    "",
    "Final-Recipient: rfc822; gone@example.net",
    "Action: failed",
    "Status: 5.1.1",
    "Diagnostic-Code: smtp; 550 5.1.1 No such user",
    `Original-Message-ID: ${TRANSPORT_ID}`,
    "--b--",
    "",
  ].join("\r\n");

  it("recognises a report, and reads who failed", async () => {
    const { isDeliveryReport, readReportedFailure } = await import("../src/outbound/delivery-report.ts");

    expect(isDeliveryReport("multipart/report; report-type=delivery-status", DSN)).toBe(true);
    const failure = readReportedFailure(DSN);
    expect(failure?.recipient).toBe("gone@example.net");
    // Brackets kept: that is the form transport_message_id stores, and normalising breaks the only join.
    expect(failure?.originalMessageId).toBe(TRANSPORT_ID);
    expect(failure?.diagnostic).toContain("550 5.1.1");
  });

  it("does not mistake an ordinary message that mentions bouncing", async () => {
    const { isDeliveryReport } = await import("../src/outbound/delivery-report.ts");
    const ordinary = [
      "From: a@example.com", "Subject: your email bounced", "Content-Type: text/plain", "",
      "I think your message to Final-Recipient: rfc822; someone@example.net bounced. Diagnostic-Code: 550?",
      "",
    ].join("\r\n");

    // Prose quoting the field names must not be read as a machine report — the match is on a part header,
    // not on the words appearing anywhere.
    expect(isDeliveryReport("text/plain", ordinary)).toBe(false);
  });

  it("attributes a report to the send it names, alongside the queue's own events", async () => {
    const { recordDeliveryReport } = await import("../src/outbound/delivery-report.ts");
    const outcome = await recordDeliveryReport(testEnv, createSystemCtx(), ORG, "rcpt_probe_1", DSN);

    expect(outcome.recorded).toBe(true);
    // Same table as the queue's events, so the outbox is one account of delivery rather than two.
    expect(outcome.manifestId).toBe(MANIFEST);
    const row = await testEnv.CATALOG.prepare(
      "SELECT event_type, recipient, manifest_id FROM send_recipient_events WHERE event_id = 'inbound_rcpt_probe_1'",
    ).first<{ event_type: string; recipient: string; manifest_id: string | null }>();
    expect(row?.event_type).toBe("inbound.delivery_report");
    expect(row?.recipient).toBe("gone@example.net");
  });

  it("records nothing when it cannot tell who failed", async () => {
    const { recordDeliveryReport } = await import("../src/outbound/delivery-report.ts");
    const vague = [
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b"', "", "--b",
      "Content-Type: message/delivery-status", "", "Reporting-MTA: dns; relay.example", "--b--", "",
    ].join("\r\n");

    const outcome = await recordDeliveryReport(testEnv, createSystemCtx(), ORG, "rcpt_probe_2", vague);

    // Null is a real answer: this Node could not tell who failed, which differs from nobody failing.
    // Inventing a recipient would put a fabricated bounce in front of a person — worse than the silence.
    expect(outcome.recorded).toBe(false);
    expect(outcome.unreadable).toContain("Final-Recipient");
    const count = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM send_recipient_events WHERE event_id = 'inbound_rcpt_probe_2'",
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("never overwrites what the queue already established", async () => {
    const ctx = createSystemCtx();
    const { recordDeliveryReport } = await import("../src/outbound/delivery-report.ts");

    await applySendingEvent(testEnv, ctx, ORG, event("delivered"));
    await recordDeliveryReport(testEnv, ctx, ORG, "rcpt_probe_3", DSN);

    // The queue is Cloudflare's first-party account of a message it sent; a forwarded report is somebody
    // else's account of something that may not even be the same message. Where they disagree the
    // first-party record wins, and the report stays visible as an event.
    expect((await stateOf("one@example.net"))?.delivery_state).toBe("accepted");
  });
});
