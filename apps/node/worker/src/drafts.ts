import type { Ctx } from "@mailda/runtime";
import { utf8 } from "@mailda/evidence";

import { getEvidence, putEvidence, sha256Hex } from "./evidence-store.ts";
import { maySend } from "./authz-read.ts";
import { CallerError, notFound } from "./errors.ts";

/**
 * Drafts that survive a reload.
 *
 * ## Why this is authorized by `send.propose` rather than by ownership
 *
 * A draft is addressed *from a mailbox* (ADR 36), so being able to hold one is being able to propose a send
 * as that mailbox. Checking only "is this your draft" would let somebody whose authority was withdrawn keep
 * composing as a mailbox they can no longer send from — and then discover it at the moment they pressed
 * send, which is the failure `withheld` exists to name rather than a state to design in deliberately.
 *
 * The check is re-run on **every** save and every read, not once when the draft is created, because §7 and
 * §28 require withdrawn authority to stop working immediately and a long-lived draft is precisely where
 * "immediately" gets quietly redefined as "next time you sign in".
 *
 * ## Reading someone else's draft
 *
 * Nobody can, including a mailbox's other members. Not because it is settled that they should not — Layer 3
 * decides what sharing unfinished work means, and there are real arguments both ways for a shared queue —
 * but because a guess here would be a guess about who reads a half-written sentence about a customer. The
 * author filter is on both the read and the list.
 */

export interface DraftInput {
  mailboxId: string;
  inReplyToMessageId?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

export interface DraftRecord {
  id: string;
  mailboxId: string;
  inReplyToMessageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyBytes: number;
  updatedAt: string;
}

interface Row {
  id: string;
  mailbox_id: string;
  author_user_id: string;
  in_reply_to_message_id: string | null;
  to_addresses: string;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  subject: string;
  body_key: string | null;
  body_sha256: string | null;
  body_bytes: number;
  updated_at: string;
}

/** A draft's R2 key is stable, so an autosave overwrites instead of accumulating an object per keystroke. */
function bodyKeyFor(orgId: string, draftId: string): string {
  return `${orgId}/drafts/${draftId}.txt`;
}

function parseAddresses(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    // A draft whose addresses cannot be parsed is still a draft, and the body is the part somebody would
    // be upset to lose. Returning nothing here loses the recipients and keeps the writing.
    return [];
  }
}

async function assertMaySend(env: Env, orgId: string, userId: string, mailboxId: string): Promise<void> {
  if (await maySend(env, { orgId, userId }, mailboxId)) return;
  // 403 rather than 404, and that is a deliberate difference from the draft lookup below. §5C hides
  // whether a *thing* exists; it does not require hiding that a mailbox you were told about is one you may
  // not send as — the caller already knows the mailbox, and "you lack this relation" is the answer that
  // names the remedy instead of sending somebody to look for a mailbox that is right there.
  throw new CallerError("E_MAY_NOT_SEND_AS_MAILBOX", 403, {
    what: `you may not compose as mailbox ${mailboxId}`,
    why: "a draft is addressed from a mailbox (ADR 36), so holding one requires send.propose on it",
    fix: "ask an administrator to grant send.propose on this mailbox",
  });
}

/**
 * Creates or updates a draft, and returns what was stored.
 *
 * Upsert by id when one is supplied, so the composer's autosave is one call rather than a create-or-update
 * decision the client has to get right. A draft id that does not belong to the caller is not found rather
 * than forbidden — §5C's rule that an absent thing and one you cannot see answer identically.
 */
export async function saveDraft(
  env: Env,
  ctx: Ctx,
  orgId: string,
  userId: string,
  draftId: string | null,
  input: DraftInput,
): Promise<DraftRecord> {
  await assertMaySend(env, orgId, userId, input.mailboxId);

  const at = new Date(ctx.now()).toISOString();
  const existing = draftId === null ? null : await draftRow(env, orgId, userId, draftId);
  if (draftId !== null && existing === null) {
    throw notFound("E_NO_DRAFT", {
      what: `draft ${draftId} does not exist`,
      why: "a draft is readable only by the person writing it, so this is also the answer when it is somebody else's",
      fix: "save without an id to start a new draft",
    });
  }

  const id = existing?.id ?? ctx.id("dft");

  const bodyDigest = input.body === "" ? null : await sha256Hex(utf8(input.body));

  /**
   * A save that changes nothing writes nothing.
   *
   * `updated_at` is shown to a person as "saved on your node · HH:MM:SS", so it has to mean *when this last
   * changed* and not *when somebody last opened it*. Without this, resuming a draft looked like an edit to
   * the composer, which scheduled a save, which moved the clock — so reopening a draft to read it made the
   * interface report a save that had not happened, and cost an R2 write to do it. That was found by
   * reloading the page and comparing the timestamp, and the guard lives here rather than only in the
   * composer because this is the layer that owns the column.
   */
  if (
    existing !== null &&
    existing.subject === input.subject &&
    existing.to_addresses === JSON.stringify(input.to) &&
    (existing.cc_addresses ?? "[]") === JSON.stringify(input.cc ?? []) &&
    (existing.bcc_addresses ?? "[]") === JSON.stringify(input.bcc ?? []) &&
    existing.body_sha256 === bodyDigest &&
    (existing.in_reply_to_message_id ?? null) === (input.inReplyToMessageId ?? null)
  ) {
    return {
      id,
      mailboxId: existing.mailbox_id,
      inReplyToMessageId: existing.in_reply_to_message_id,
      to: parseAddresses(existing.to_addresses),
      cc: parseAddresses(existing.cc_addresses),
      bcc: parseAddresses(existing.bcc_addresses),
      subject: existing.subject,
      body: input.body,
      bodyBytes: existing.body_bytes,
      // The *existing* timestamp, which is the whole point: nothing was written, so nothing is newer.
      updatedAt: existing.updated_at,
    };
  }

  // Written before the row, so a crash between the two leaves an orphan object rather than a row pointing
  // at bytes that were never stored. The reconciler already treats an unreferenced blob as collectable and
  // a reference with no blob as *reportable only* (ADR 32) — this ordering keeps drafts on the safe side of
  // that asymmetry.
  let bodyKey = existing?.body_key ?? null;
  let bodySha: string | null = null;
  let bodyBytes = 0;
  if (input.body !== "") {
    const bytes = utf8(input.body);
    const stored = await putEvidence(env, bodyKeyFor(orgId, id), bytes);
    bodyKey = stored.blobKey;
    bodySha = stored.plaintextSha256;
    bodyBytes = bytes.byteLength;
  }

  await env.CATALOG.prepare(
    `INSERT INTO drafts (id, org_id, mailbox_id, author_user_id, in_reply_to_message_id,
                         to_addresses, cc_addresses, bcc_addresses, subject,
                         body_key, body_sha256, body_bytes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (id) DO UPDATE SET
       in_reply_to_message_id = excluded.in_reply_to_message_id,
       to_addresses = excluded.to_addresses,
       cc_addresses = excluded.cc_addresses,
       bcc_addresses = excluded.bcc_addresses,
       subject = excluded.subject,
       body_key = excluded.body_key,
       body_sha256 = excluded.body_sha256,
       body_bytes = excluded.body_bytes,
       updated_at = excluded.updated_at`,
  )
    .bind(
      id, orgId, input.mailboxId, userId, input.inReplyToMessageId ?? null,
      JSON.stringify(input.to), JSON.stringify(input.cc ?? []), JSON.stringify(input.bcc ?? []),
      input.subject, bodyKey, bodySha, bodyBytes, at, at,
    )
    .run();

  return {
    id,
    mailboxId: input.mailboxId,
    inReplyToMessageId: input.inReplyToMessageId ?? null,
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: input.subject,
    body: input.body,
    bodyBytes,
    updatedAt: at,
  };
}

async function draftRow(env: Env, orgId: string, userId: string, draftId: string): Promise<Row | null> {
  return await env.CATALOG.prepare(
    `SELECT id, mailbox_id, author_user_id, in_reply_to_message_id, to_addresses, cc_addresses,
            bcc_addresses, subject, body_key, body_sha256, body_bytes, updated_at
       FROM drafts WHERE org_id = ? AND id = ? AND author_user_id = ? LIMIT 1`,
  )
    .bind(orgId, draftId, userId)
    .first<Row>();
}

/** One draft, with its body read back out of R2. Null when it is absent or somebody else's. */
export async function readDraft(
  env: Env,
  orgId: string,
  userId: string,
  draftId: string,
): Promise<DraftRecord | null> {
  const row = await draftRow(env, orgId, userId, draftId);
  if (row === null) return null;
  // Re-checked on read, not only on write: a draft outlives the grant that allowed it.
  await assertMaySend(env, orgId, userId, row.mailbox_id);

  let body = "";
  if (row.body_key !== null) {
    // A body whose object is gone is reported as an empty body rather than failing the read. The
    // alternative is a draft nobody can open, which loses the recipients and subject as well as the
    // writing — and the reconciler is the thing that notices a missing blob (ADR 32).
    body = await getEvidence(env, row.body_key)
      .then((bytes) => new TextDecoder().decode(bytes))
      .catch(() => "");
  }

  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    inReplyToMessageId: row.in_reply_to_message_id,
    to: parseAddresses(row.to_addresses),
    cc: parseAddresses(row.cc_addresses),
    bcc: parseAddresses(row.bcc_addresses),
    subject: row.subject,
    body,
    bodyBytes: row.body_bytes,
    updatedAt: row.updated_at,
  };
}

export interface DraftSummary {
  id: string;
  mailboxId: string;
  inReplyToMessageId: string | null;
  to: string[];
  subject: string;
  bodyBytes: number;
  updatedAt: string;
}

/** The caller's own drafts, newest first. Bodies are not read — a list does not need them. */
export async function listDrafts(env: Env, orgId: string, userId: string): Promise<DraftSummary[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT id, mailbox_id, in_reply_to_message_id, to_addresses, subject, body_bytes, updated_at
       FROM drafts WHERE org_id = ? AND author_user_id = ?
      ORDER BY updated_at DESC LIMIT 50`,
  )
    .bind(orgId, userId)
    .all<Omit<Row, "author_user_id" | "cc_addresses" | "bcc_addresses" | "body_key">>();

  return results.map((row) => ({
    id: row.id,
    mailboxId: row.mailbox_id,
    inReplyToMessageId: row.in_reply_to_message_id,
    to: parseAddresses(row.to_addresses),
    subject: row.subject,
    bodyBytes: row.body_bytes,
    updatedAt: row.updated_at,
  }));
}

/**
 * Finds the draft already in progress for a reply, so replying twice resumes rather than forking.
 *
 * The unique index makes at most one exist; this is the read that lets the composer honour it instead of
 * discovering the constraint as a conflict.
 */
export async function draftForReply(
  env: Env,
  orgId: string,
  userId: string,
  inReplyToMessageId: string,
): Promise<DraftRecord | null> {
  const row = await env.CATALOG.prepare(
    "SELECT id FROM drafts WHERE org_id = ? AND author_user_id = ? AND in_reply_to_message_id = ? LIMIT 1",
  )
    .bind(orgId, userId, inReplyToMessageId)
    .first<{ id: string }>();
  return row === null ? null : await readDraft(env, orgId, userId, row.id);
}

/**
 * Deletes a draft. Called when a message is sealed, and by a person abandoning one.
 *
 * The R2 object is **not** deleted here. ADR 32 makes reconciliation deliberately asymmetric — an orphan
 * blob past grace may be collected, a reference with no blob may only be reported — and deleting the object
 * inline would mean a failure between the two writes leaves a row pointing at nothing, which is the side of
 * that asymmetry that cannot be repaired automatically. The row goes; the object becomes an orphan the
 * reconciler collects.
 */
export async function deleteDraft(env: Env, orgId: string, userId: string, draftId: string): Promise<boolean> {
  const result = await env.CATALOG.prepare(
    "DELETE FROM drafts WHERE org_id = ? AND id = ? AND author_user_id = ?",
  )
    .bind(orgId, draftId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
