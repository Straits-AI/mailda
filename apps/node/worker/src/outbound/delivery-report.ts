import type { Ctx } from "@mailda/runtime";

/**
 * A delivery report that arrives as ordinary inbound mail.
 *
 * ## Why this exists at all, given bounces come by queue
 *
 * A Node cannot receive bounces *for its own sends* — `cf-bounce` belongs to Cloudflare
 * (`cloudflare-email-sending.md`). But a Node's inbox can still receive a delivery-status report: mail
 * sent by some other system on the same domain, a report forwarded by a person, a report for something
 * relayed before Mailda existed.
 *
 * Left alone, that report lands in the mailbox as an ordinary message — and a reader sees a bounce notice
 * in the inbox while the outbox says the send was accepted. **The two views contradict each other and
 * neither is wrong**, because they are about different sends. That is the failure this closes: not by
 * hiding the report, but by recording it in the same place the queue's events go, so the outbox remains
 * the single account of delivery and an unattributable report is visible rather than silent.
 *
 * ## Deliberately not a full RFC 3464 parser
 *
 * Only two fields are extracted, by line match on the decoded body: `Final-Recipient` and
 * `Original-Message-ID`. That is a fraction of the standard — no per-recipient blocks beyond the first,
 * no `Diagnostic-Code` decoding, no multipart traversal, no encoded-word handling.
 *
 * The limit is the point rather than an omission. A report whose failed recipient cannot be read is
 * **not recorded as a delivery outcome at all**, because inventing one would put a fabricated bounce in
 * front of a person — worse than the silence it replaces. It is logged instead, so an operator can see
 * that something arrived which this Node could not interpret. Growing this into a real parser is a
 * decision about how much of somebody else's mail system to model, and it should be made on evidence
 * that unreadable reports actually occur.
 */

/** Is this inbound message a delivery-status report? */
export function isDeliveryReport(contentType: string | null, body: string): boolean {
  const type = (contentType ?? "").toLowerCase();
  // The standard container, and the part that carries the machine-readable status. Either is sufficient:
  // some reporting MTAs send the status part without the multipart wrapper.
  if (type.includes("report-type=delivery-status")) return true;
  if (type.includes("message/delivery-status")) return true;
  // A wrapper whose declared type is generic but which contains the status part. Matched on the part
  // header rather than on prose, so an ordinary message quoting these words is not misread.
  return /^content-type:\s*message\/delivery-status/im.test(body);
}

export interface ReportedFailure {
  /** The address the report says failed. */
  recipient: string;
  /** The failed message's own Message-ID, when the report quotes it. */
  originalMessageId: string | null;
  /** The report's own words about why, when present. */
  diagnostic: string | null;
}

/**
 * Reads the first failed recipient out of a report, or null when it cannot be read.
 *
 * Null is a real answer here and callers must treat it as one: it means *this Node could not tell who
 * failed*, which is different from nobody having failed.
 */
export function readReportedFailure(body: string): ReportedFailure | null {
  // `Final-Recipient: rfc822; someone@example.com`. The address type is not assumed to be rfc822 — some
  // reports use `x-unix` or a local scheme — so only the part after the semicolon is taken.
  const finalRecipient = /^final-recipient:\s*[^;\n]*;\s*(.+)$/im.exec(body);
  if (finalRecipient === null) return null;

  const recipient = finalRecipient[1]!.trim().replace(/^<|>$/g, "");
  if (recipient === "" || !recipient.includes("@")) return null;

  const original = /^original-message-id:\s*(.+)$/im.exec(body);
  const diagnostic = /^diagnostic-code:\s*(.+)$/im.exec(body);

  return {
    recipient,
    // Kept with its angle brackets if it has them: that is the form `transport_message_id` stores, and
    // normalising here would break the only join available.
    originalMessageId: original === null ? null : original[1]!.trim(),
    diagnostic: diagnostic === null ? null : diagnostic[1]!.trim().slice(0, 300),
  };
}

export interface RecordedReport {
  recorded: boolean;
  /** Null when the report could not be matched to a send this Node made. */
  manifestId: string | null;
  /** Why nothing was recorded, when nothing was. */
  unreadable?: string;
}

/**
 * Records an inbound delivery report alongside the queue's own events.
 *
 * Never overwrites a delivery outcome the queue already established. The queue is Cloudflare's own
 * account of what happened to a message it sent; a forwarded report is somebody else's account of
 * something that may not even be the same message. Where they disagree, the first-party record wins and
 * the report remains visible as an event.
 */
export async function recordDeliveryReport(
  env: Env,
  ctx: Ctx,
  orgId: string,
  receiptId: string,
  body: string,
): Promise<RecordedReport> {
  const failure = readReportedFailure(body);
  if (failure === null) {
    return {
      recorded: false,
      manifestId: null,
      unreadable: "no readable Final-Recipient; recorded nowhere rather than guessed at",
    };
  }

  const manifest = failure.originalMessageId === null
    ? null
    : await env.CATALOG.prepare(
        `SELECT id FROM send_manifests
          WHERE org_id = ? AND (transport_message_id = ? OR rfc_message_id = ?) LIMIT 1`,
      ).bind(orgId, failure.originalMessageId, failure.originalMessageId.replace(/^<|>$/g, ""))
        .first<{ id: string }>();

  const at = new Date(ctx.now()).toISOString();
  // The receipt id makes the event id deterministic, so redelivery of the same inbound message — which
  // #9's at-least-once model permits — cannot record the report twice.
  const eventId = `inbound_${receiptId}`;

  await env.CATALOG.prepare(
    `INSERT OR IGNORE INTO send_recipient_events
       (event_id, org_id, manifest_id, recipient, event_type, transport_message_id, terminal, payload, received_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(eventId, orgId, manifest?.id ?? null, failure.recipient, "inbound.delivery_report",
      failure.originalMessageId, 1,
      JSON.stringify({ source: "inbound", ingressReceiptId: receiptId, ...failure }), at)
    .run();

  return { recorded: true, manifestId: manifest?.id ?? null };
}
