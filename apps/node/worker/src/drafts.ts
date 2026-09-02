import type { Ctx } from "@mailda/runtime";
import { utf8 } from "@mailda/evidence";

import { EvidenceMissing, getEvidence, putEvidence, sha256Hex } from "./evidence-store.ts";
import { assertNotHeld } from "./holds.ts";
import { maySend } from "./authz-read.ts";
import { CallerError, notFound, unprocessable } from "./errors.ts";

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
  /**
   * Why `body` is empty when the row says it should not be (#143).
   *
   * `null` when the body is genuinely what was written. Otherwise the two states are kept apart because an
   * operator does something different with each, exactly as `EvidenceFault` keeps its three apart:
   *
   *   - **missing** — the object is gone and the row saying it existed is not. ADR 32's reportable-only
   *     side; the reconciler is what notices.
   *   - **unreadable** — the object is *there* and this vault cannot open it. The ADR 28 loss the recovery
   *     codes exist for, and it may clear: redeeming one can install the key.
   *
   * This used to be silence. An empty `body` with `bodyBytes: 180` beside it was the only clue, and an empty
   * body in a composer is an invitation to type over evidence that was never lost.
   */
  bodyUnavailable: "missing" | "unreadable" | null;
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
      bodyUnavailable: null,
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

  // Written before the row, so a crash between the two leaves bytes nobody references rather than a row
  // pointing at bytes that were never stored. ADR 32 makes that the safe side of an asymmetry: a reference
  // with no blob is *reportable only*, the side no automatic repair can fix, while a stray object costs
  // storage and reveals nothing. That argument stands on its own.
  //
  // And it **is** a handoff to a collector, which is new (#67) and is why this comment changed. The
  // reconciler scans `${orgId}/drafts/` under its own referent rule — a row in `drafts` keyed by
  // `body_key`, not a receipt — and collects from it through the same single `EVIDENCE.delete` as raw
  // orphans, gated on the org-wide legal hold. The same grace window applies for the identical reason: a
  // body written here has no row for the width of the gap below, so collecting it fast would delete
  // somebody's writing mid-save. This comment said "no code path can collect it at all" until the pass
  // existed; `test/stranded-draft-bodies.test.ts` is what keeps that from silently reverting.
  /*
   * **A body this Node cannot read is not a blank page to write over** (#143).
   *
   * Two different losses were reachable from here, and neither announced itself:
   *
   *   - a **non-empty** save re-seals to `bodyKeyFor(orgId, id)`, which is deterministic — so it overwrites
   *     the very object it could not open. Evidence that was intact and merely waiting for a key becomes
   *     evidence that is gone.
   *   - an **empty** save takes the branch below and leaves `body_key` pointing at the old object while
   *     recording `body_sha256 = NULL` and `body_bytes = 0`. The bytes survive and stop being verifiable:
   *     the verifier skips a row with no recorded hash, so the object becomes unaccounted for.
   *
   * Both are reached by opening a draft on a Node whose vault is incomplete and pressing save, which is the
   * ordinary thing to do with what looks like an empty draft. So the write refuses while the body is
   * unreadable, and says what would clear it. The refusal is on **unreadable** only: a `missing` object is
   * ADR 32's reportable-only side, already lost, and blocking writes over it would strand the recipients and
   * subject too.
   */
  /*
   * **Gated on the body actually changing**, because this costs an R2 `get` and a decrypt and drafts
   * autosave. When the incoming digest equals the stored one there is nothing to replace: the body survives
   * this write untouched whether it opens or not, so asking would be paying on the hot path for an answer
   * that changes nothing. A save that alters only the subject is the common case and skips it.
   *
   * The check therefore runs exactly when a replacement would occur, which is also exactly when it can lose
   * something.
   */
  if (existing?.body_key != null && existing.body_sha256 !== bodyDigest) {
    const readable = await getEvidence(env, existing.body_key).then(() => true).catch(
      (error: unknown) => error instanceof EvidenceMissing,
    );
    if (!readable) {
      throw unprocessable("E_DRAFT_BODY_UNREADABLE", {
        what: "this draft's body is stored but cannot be opened on this Node, so it will not be replaced",
        why: "the object is intact and sealed under a key generation this vault does not hold — the ADR 28 "
          + "loss the recovery codes exist for. It reads as an empty body, and saving over it would "
          + "destroy writing that is still recoverable",
        fix: "restore the vault first: `mailda doctor` reports the escrow, and redeeming one of the ten "
          + "recovery codes installs the keys. If the body is genuinely not wanted, delete the draft",
      });
    }
  }

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
    // A write that got this far either replaced the body or left one that reads.
    bodyUnavailable: null,
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
  let bodyUnavailable: "missing" | "unreadable" | null = null;
  if (row.body_key !== null) {
    /*
     * A body whose object cannot be read is still reported as an empty body rather than failing the read,
     * and that part of the original reasoning stands: the alternative is a draft nobody can open, which
     * loses the recipients and subject as well as the writing, and the reconciler is what notices a missing
     * blob (ADR 32).
     *
     * **What changed is that it says so** (#143). `.catch(() => "")` swallowed every failure alike, so a
     * body that was merely unopenable — present, intact, waiting for a key — was indistinguishable from one
     * that had never been written. Measured on a restored Node: `body: ""` returned with `bodyBytes: 180`
     * beside it, the row contradicting the answer, and nothing said which of the two states it was.
     */
    try {
      body = new TextDecoder().decode(await getEvidence(env, row.body_key));
    } catch (error) {
      bodyUnavailable = error instanceof EvidenceMissing ? "missing" : "unreadable";
    }
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
    bodyUnavailable,
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
 * Deletes a draft — **the row, and only the row**. Called when a message is sealed, which is the ordinary
 * send path, and by a person abandoning one.
 *
 * ## It consults the legal hold first (#64)
 *
 * A draft is addressed *from a mailbox* (ADR 36), so it is coverable by a hold on that mailbox, and this is
 * one of the two D1 sites #64 classified as carrying content. The row is read before the delete — the one
 * extra query this costs — because the hold predicate needs the mailbox and the instant, and neither is in
 * the caller's hand: the composer sends a draft id.
 *
 * `created_at`, not `updated_at`, is the instant tested. See `HoldTarget.at` in `holds.ts` for what that
 * chooses and the one residual it leaves.
 *
 * A draft that is absent, or somebody else's, returns `false` **without consulting a hold**, and the order is
 * deliberate: §5C keeps those two answers alike, and asking about a hold first would let a caller learn that
 * a draft exists in a held mailbox from the shape of the refusal.
 *
 * ## Which makes the ordinary send path able to refuse
 *
 * A send seals the manifest and then deletes the draft. Under a hold that deletion is refused, so the caller
 * gets a completed send *and* a retained draft — `index.ts` reports that as `draftRetained` rather than
 * failing the send, because the message did leave and the draft is now preserved on purpose. One
 * `hold.blocked` entry per send from a held mailbox is within `audit-and-log-retention.md`'s sizing of a
 * handful of entries per message.
 *
 * ## The R2 object is not deleted here, and that is now a handoff rather than a hole
 *
 * The reconciler scans `${orgId}/drafts/` and collects a body whose `drafts` row is gone, past the same
 * grace window, through the same single `EVIDENCE.delete` as a raw orphan (#67, `reconcile.ts`). Until that
 * existed this comment said the object was left for the reconciler while the reconciler listed only
 * `${orgId}/raw/` — a claim about a hand-off to a component that had never been given the prefix, and the
 * third time that shape has been found in these exact comments. What keeps the sentence true now is not the
 * sentence: `test/stranded-draft-bodies.test.ts` collects a real residue object through a real pass.
 *
 * **No delete is added here, deliberately.** ADR 32 makes reconciliation asymmetric — a reference with no
 * blob may only be reported, never repaired automatically — so an inline delete that failed after the row
 * was gone would create exactly the unreachable orphan #67 was filed about. Routing it through the existing
 * collector also means no new R2 delete site, which is the property
 * `test/node/content-deletion-world.test.ts` exists to protect: the allowlist stays at one entry.
 *
 * The collector inherits the orphan problem in miniature, which is why its suppression is org-wide rather
 * than per-hold: a stranded body has no `drafts` row, so there is no mailbox to test a hold against, and the
 * key's own prefix is the organization. The hold consulted *here*, before the row is deleted, is the
 * per-mailbox one — this is the last moment at which the mailbox is still known.
 */
export async function deleteDraft(
  env: Env,
  ctx: Ctx,
  orgId: string,
  userId: string,
  draftId: string,
): Promise<boolean> {
  const held = await env.CATALOG.prepare(
    "SELECT mailbox_id, created_at FROM drafts WHERE org_id = ? AND id = ? AND author_user_id = ? LIMIT 1",
  )
    .bind(orgId, draftId, userId)
    .first<{ mailbox_id: string; created_at: string }>();
  // Nothing to destroy, so nothing to hold. Also §5C: absent and somebody else's answer identically.
  if (held === null) return false;

  await assertNotHeld(env, ctx, orgId, userId, {
    kind: "draft",
    id: draftId,
    mailboxId: held.mailbox_id,
    at: held.created_at,
  });

  const result = await env.CATALOG.prepare(
    "DELETE FROM drafts WHERE org_id = ? AND id = ? AND author_user_id = ?",
  )
    .bind(orgId, draftId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
