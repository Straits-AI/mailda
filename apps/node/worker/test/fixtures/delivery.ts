import { utf8 } from "@mailda/evidence";
import type { Ctx } from "@mailda/runtime";

import { conversationForDelivery } from "../../src/conversations.ts";
import { putEvidence } from "../../src/evidence-store.ts";

/**
 * A delivery that really arrived: evidence in R2, a receipt, a message, a conversation and a case.
 *
 * ## Why this is a shared fixture rather than a copy
 *
 * `test/butler-run.test.ts` grew one of these inline, and #85 needed the same thing to describe the routes
 * that only exist once mail has landed — cases, a message body, a conversation merge. Copying it would have
 * put two spellings of *"what a delivery looks like"* in the suite, and the one nobody updates is the one
 * that quietly stops matching what ingest actually writes.
 *
 * So it is parameterised by organization, mailbox and address, and both callers use it.
 *
 * ## What it does not claim
 *
 * **This is not the ingest path.** The real one parses MIME, checks the ingress receipt against the blob and
 * runs the Butler trigger; this writes the rows those steps produce. That is the right fidelity for what it
 * is used for — describing the *projections* routes make over stored mail — and it would be the wrong
 * fidelity for a claim about ingest, which is `test/ingress.test.ts`'s job and not made here.
 */
export interface SeededDelivery {
  messageId: string;
  conversationId: string;
  caseId: string;
  receiptId: string;
  /** The RFC 5322 `Message-ID`, as stored: bracket-stripped, which is the form the causal join compares in. */
  rfcMessageId: string;
}

export async function seedDelivery(
  env: Env,
  ctx: Ctx,
  where: { orgId: string; mailboxId: string; address: string },
  options: { subject?: string; from?: string } = {},
): Promise<SeededDelivery> {
  const subject = options.subject ?? "Invoice 4021 query";
  const from = options.from ?? "customer@example.net";
  const at = new Date(ctx.now()).toISOString();
  const rfcMessageId = `in-${ctx.id("x")}@example.net`;

  const raw = utf8(
    `Message-ID: <${rfcMessageId}>\r\nSubject: ${subject}\r\n`
    + `From: ${from}\r\n\r\nWhere is my invoice?\r\n`,
  );
  const stored = await putEvidence(env, `${where.orgId}/raw/${ctx.id("k")}.eml`, raw);

  const receiptId = ctx.id("ir");
  const conversationId = await conversationForDelivery(env, ctx, where.orgId, `<root-${ctx.id("r")}@example.net>`);
  const messageId = ctx.id("msg");
  const caseId = ctx.id("cas");

  await env.CATALOG.batch([
    env.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, envelope_from, envelope_to, raw_bytes, accepted_at,
                                     blob_key, blob_sha256, provider_event_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(receiptId, where.orgId, from, where.address, raw.byteLength, at,
      stored.blobKey, stored.plaintextSha256, ctx.id("pe")),
    env.CATALOG.prepare(
      `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
                             thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
                             created_at, conversation_id, parse_error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    ).bind(messageId, where.orgId, "2026-08", stored.blobKey, stored.plaintextSha256, raw.byteLength,
      rfcMessageId, ctx.id("thr"), subject, from, at, at, receiptId, at, conversationId),
    /*
     * The mailbox item is what makes a message *reachable* — every read is bounded by what a person holds on
     * a mailbox, and a message with no item belongs to no mailbox and is therefore visible to nobody. A
     * fixture that omitted it would seed mail the routes correctly refuse to show.
     */
    env.CATALOG.prepare(
      `INSERT INTO mailbox_items (id, org_id, mailbox_id, time_bucket, message_id, change_number, flags,
                                  sent_at, created_at)
       VALUES (?,?,?,?,?,0,0,?,?)`,
      // `change_number` is the placeholder `placeholder-columns.test.ts` classifies: always 0, because the
      // monotonic change feed it names is a Layer 6 concern. Written as 0 here for the same reason
      // `materialise.ts` does, rather than invented.
    ).bind(ctx.id("mbi"), where.orgId, where.mailboxId, "2026-08", messageId, at, at),
    env.CATALOG.prepare(
      `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at,
                          created_at)
       VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
    ).bind(caseId, where.orgId, conversationId, where.mailboxId, at, at),
  ]);

  return { messageId, conversationId, caseId, receiptId, rfcMessageId };
}
