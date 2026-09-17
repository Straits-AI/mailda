import type { Ctx } from "@mailda/runtime";
import type { QuarantineReason } from "@mailda/contract/schemas";

import { auditedBatch } from "./audit.ts";
import { caseForDelivery } from "./cases.ts";
import { notFound } from "./errors.ts";
import { assertAdmin } from "./access.ts";

/**
 * Deliveries held back from every queue because the sender's own domain disowned them (0056).
 *
 * The narrowest honest act on the receiving server's verdict: a mailbox that asked for it files a DMARC
 * failure from a domain publishing `quarantine` or `reject` as evidence and a row, opens no case, and lists
 * it here for an administrator rather than in anybody's inbox. Release opens the case the delivery would
 * have had — `caseForDelivery`, the same statement `materialise` runs — so a released message is exactly
 * what an unquarantined one would have been, only later. There is no delete: nothing deletes mail on this
 * Node, and a quarantined message is mail.
 */
export interface QuarantinedDelivery {
  messageId: string;
  receiptId: string;
  mailboxId: string;
  mailboxAddress: string;
  subject: string | null;
  fromAddr: string | null;
  fromDomain: string | null;
  dmarcPolicy: string | null;
  acceptedAt: string;
  quarantinedAt: string;
  reason: QuarantineReason;
}

export async function listQuarantined(env: Env, orgId: string, actorUserId: string): Promise<QuarantinedDelivery[]> {
  await assertAdmin(env, orgId, actorUserId);
  const rows = await env.CATALOG.prepare(
    `SELECT m.id AS message_id, r.id AS receipt_id, a.mailbox_id, a.address AS mailbox_address,
            m.subject, m.from_addr, m.auth_from_domain, m.auth_dmarc_policy, r.accepted_at,
            m.quarantined_at, m.quarantine_reason
       FROM messages m
       JOIN ingress_receipts r ON r.id = m.ingress_receipt_id
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
      WHERE m.org_id = ? AND m.quarantined_at IS NOT NULL
      ORDER BY m.quarantined_at DESC LIMIT 200`,
  ).bind(orgId).all<{
    message_id: string; receipt_id: string; mailbox_id: string; mailbox_address: string;
    subject: string | null; from_addr: string | null; auth_from_domain: string | null;
    auth_dmarc_policy: string | null; accepted_at: string; quarantined_at: string;
    quarantine_reason: QuarantineReason;
  }>();
  return rows.results.map((row) => ({
    messageId: row.message_id, receiptId: row.receipt_id, mailboxId: row.mailbox_id,
    mailboxAddress: row.mailbox_address, subject: row.subject, fromAddr: row.from_addr,
    fromDomain: row.auth_from_domain, dmarcPolicy: row.auth_dmarc_policy, acceptedAt: row.accepted_at,
    quarantinedAt: row.quarantined_at, reason: row.quarantine_reason,
  }));
}

export async function releaseQuarantine(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, messageId: string,
): Promise<{ released: true; messageId: string; mailboxId: string }> {
  await assertAdmin(env, orgId, actorUserId);
  const row = await env.CATALOG.prepare(
    `SELECT m.conversation_id, a.mailbox_id, m.quarantine_reason
       FROM messages m
       JOIN ingress_receipts r ON r.id = m.ingress_receipt_id
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
      WHERE m.org_id = ? AND m.id = ? AND m.quarantined_at IS NOT NULL LIMIT 1`,
  ).bind(orgId, messageId).first<{ conversation_id: string; mailbox_id: string; quarantine_reason: string }>();
  if (row === null) {
    // One answer for "no such message" and "not quarantined", by §5C: the list above is what says which.
    throw notFound("E_NOT_QUARANTINED", {
      what: `${messageId} is not a quarantined delivery in this organization`,
      why: "either it does not exist, or it was already released — GET /api/quarantine lists what is held",
      fix: "read the list and release from it",
    });
  }
  const at = new Date(ctx.now()).toISOString();
  await auditedBatch(env, ctx, orgId, {
    action: "message.released", outcome: "ok", actorUserId, subject: messageId,
    detail: { mailboxId: row.mailbox_id, reason: row.quarantine_reason },
  }, (entry) => [
    entry,
    env.CATALOG.prepare(
      "UPDATE messages SET quarantined_at = NULL WHERE org_id = ? AND id = ? AND quarantined_at IS NOT NULL",
    ).bind(orgId, messageId),
    caseForDelivery(env, ctx, orgId, row.conversation_id, row.mailbox_id, at),
  ]);
  return { released: true, messageId, mailboxId: row.mailbox_id };
}
