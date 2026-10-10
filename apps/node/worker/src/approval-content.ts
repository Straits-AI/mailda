import type { Ctx } from "@mailda/runtime";
import { recordDisclosure } from "./audit.ts";
import { decidersByMailbox } from "./deciders.ts";
import { getEvidence } from "./evidence-store.ts";

/*
 * Its own module rather than beside `pendingApprovals`, whose rule it shares: this one reads evidence, which needs the
 * Workers runtime, and `approval-pending.ts` is imported by node tests that have none (AGENTS.md 2b, the seam).
 */
export interface ApprovalContent {
  approvalId: string;
  manifestId: string;
  /** The normalized body: the bytes §18 binds and dispatch sends, as text. */
  body: string;
  /** Names, types and sizes; the bytes are `approvalAttachment`'s, by `id`, each read recorded on its own. */
  attachments: Array<{ id: string; filename: string; contentType: string; bytes: number }>;
}

/**
 * The send a person is being asked to decide, for them to read before they decide (§18, amended 10 October 2026).
 *
 * **The rule is the queue's, exactly**: an approval on a mailbox where `decidersByMailbox` counts this person, that
 * they did not cause, still pending, and gating a send. So whoever sees the request in `pendingApprovals` may read
 * it, including somebody outside a stage's team, who sees the request there too ("shown rather than filtered").
 * `org.admin` alone confers nothing, as it confers no `approval.decide`. Anything else answers null, which the route
 * turns into the same 404 a missing approval gets: a resolved one, another kind, the author, a stranger.
 *
 * Recorded as a disclosure first, and not returned if the record cannot be written, because this is a read of mail
 * by somebody who may hold no read on the mailbox: the decision's own entry would not show it, since a person can
 * read and never decide.
 */
export async function approvalContent(
  env: Env,
  ctx: Ctx,
  orgId: string,
  userId: string,
  approvalId: string,
): Promise<ApprovalContent | null> {
  const approval = await decidableSend(env, orgId, userId, approvalId);
  if (approval === null) return null;

  const { results: attachments } = await env.CATALOG.prepare(
    `SELECT id, filename, content_type, bytes FROM send_attachments
      WHERE org_id = ? AND manifest_id = ? ORDER BY ordinal`,
  ).bind(orgId, approval.manifest_id).all<{ id: string; filename: string; content_type: string; bytes: number }>();

  await recordDisclosure(env, ctx, orgId, [{
    action: "approval.content_read",
    outcome: "ok",
    actorUserId: userId,
    subject: approval.id,
    detail: { manifestId: approval.manifest_id, mailboxId: approval.scope_id, attachments: attachments.length },
  }], unrecordable(approval.manifest_id));

  return {
    approvalId: approval.id,
    manifestId: approval.manifest_id,
    body: new TextDecoder().decode(await getEvidence(env, approval.body_normalized_key)),
    attachments: attachments.map((one) => ({
      id: one.id, filename: one.filename, contentType: one.content_type, bytes: one.bytes,
    })),
  };
}

/**
 * One attachment of that send, as its bytes (§18, amended 10 October 2026): the file an approver is asked to let
 * leave, which a name and a size do not show them.
 *
 * The same rule as the body, through the same `decidableSend`, and the attachment must belong to the send the
 * approval gates: an id from another manifest answers null like a stranger does. Recorded as its own disclosure
 * before any byte is read, naming the attachment, because "who opened the contract that went out" is a question
 * about one file, and not returned if the entry cannot be written.
 *
 * The author's own filename, as the composer showed it to them and the approver will see it saved.
 */
export async function approvalAttachment(
  env: Env,
  ctx: Ctx,
  orgId: string,
  userId: string,
  approvalId: string,
  attachmentId: string,
): Promise<{ bytes: Uint8Array; filename: string; contentType: string } | null> {
  const approval = await decidableSend(env, orgId, userId, approvalId);
  if (approval === null) return null;
  const attachment = await env.CATALOG.prepare(
    `SELECT id, COALESCE(author_filename, filename) AS filename, content_type, bytes, blob_key FROM send_attachments
      WHERE org_id = ? AND manifest_id = ? AND id = ?`,
  ).bind(orgId, approval.manifest_id, attachmentId)
    .first<{ id: string; filename: string; content_type: string; bytes: number; blob_key: string }>();
  if (attachment === null) return null;

  await recordDisclosure(env, ctx, orgId, [{
    action: "approval.attachment_read",
    outcome: "ok",
    actorUserId: userId,
    subject: approval.id,
    detail: {
      manifestId: approval.manifest_id, mailboxId: approval.scope_id, attachmentId: attachment.id, bytes: attachment.bytes,
    },
  }], unrecordable(approval.manifest_id));

  return {
    bytes: await getEvidence(env, attachment.blob_key),
    filename: attachment.filename,
    contentType: attachment.content_type,
  };
}

/**
 * The pending approval on a send that this person may decide, or null: the queue's rule (above) in one place, so
 * the body and each attachment cannot come to answer it differently.
 */
async function decidableSend(env: Env, orgId: string, userId: string, approvalId: string) {
  const approval = await env.CATALOG.prepare(
    `SELECT a.id, a.scope_id, a.actor_user_id, sm.id AS manifest_id, sm.body_normalized_key
       FROM approvals a
       JOIN send_manifests sm ON sm.id = a.subject_id AND sm.org_id = a.org_id
      WHERE a.org_id = ? AND a.id = ? AND a.state = 'pending' AND a.subject_kind = 'send_manifest'`,
  ).bind(orgId, approvalId).first<{
    id: string; scope_id: string; actor_user_id: string; manifest_id: string; body_normalized_key: string;
  }>();
  if (approval === null || approval.actor_user_id === userId) return null;
  if (!(await decidersByMailbox(env, orgId)).get(approval.scope_id)?.has(userId)) return null;
  return approval;
}

function unrecordable(manifestId: string) {
  return {
    code: "E_APPROVAL_CONTENT_UNRECORDABLE",
    logEvent: "approval.record_failed",
    what: `this Node could not record that you read send ${manifestId}, so it did not show it to you`,
    why: "an approver may read a send they hold no read on, only because the read is recorded; a read that is not "
      + "recorded is the one outcome that permission depends on not happening",
    fix: "read the log for approval.record_failed — GET /api/logs — and check GET /api/doctor. A Node that cannot "
      + "append to audit_entries cannot record any act, not only this one",
  };
}
