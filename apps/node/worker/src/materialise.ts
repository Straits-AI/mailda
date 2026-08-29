import type { Ctx } from "@mailda/runtime";

import { getEvidence } from "./evidence-store.ts";
import { conversationForDelivery } from "./conversations.ts";
import { caseForDelivery } from "./cases.ts";
import { clockOnInbound } from "./response-clock.ts";
import { bucketFor } from "./ingress.ts";
import { parseHeaders } from "./mime.ts";
import { log } from "./audit.ts";
import { isDeliveryReport, recordDeliveryReport } from "./outbound/delivery-report.ts";
import { indexBody, indexMessage, settleBodyIndex } from "./search.ts";
import { indexableText } from "./search-body.ts";

/**
 * Turning an accepted receipt into message metadata and a mailbox delivery (#27).
 *
 * §13 accepts synchronously and defers everything else. This is the first thing that actually
 * consumes the deferred event: `messages` and `mailbox_items` have existed since migration 0002 and
 * nothing had ever written to them, so the ledger read `ingress_receipts` directly — which is fine for
 * one message and the wrong shape for a mailbox, because a receipt records *that* mail arrived, not
 * what it says.
 *
 * ## Failure is a state, not an exception
 *
 * §24 forbids losing accepted mail, and a message whose headers cannot be read is still a message.
 * So a parse failure writes the row **anyway**, with `parse_error` set and whatever was recoverable
 * filled in. The message stays listed and downloadable, and it is visibly unparsed rather than
 * silently absent or — worse — presented as though it had been understood.
 *
 * The only thing that raises here is a failure to *reach* the data: an unreadable evidence object or
 * a database error. Those are retryable, and ADR 31's sweeper retries them by leaving the event
 * unpublished.
 *
 * ## Idempotent by constraint, not by check
 *
 * Delivery is at-least-once (#9), so this will see the same event twice. `msg_by_receipt` is UNIQUE on
 * `ingress_receipt_id` and `mbi_unique` is UNIQUE on `(org_id, mailbox_id, message_id)`, so a repeat
 * is absorbed by the database rather than by a lookup that could race. `INSERT OR IGNORE` plus a
 * derived key is the shape #9 established: the conflict *is* the success signal.
 */

export interface MaterialiseOutcome {
  status: "created" | "already_present";
  messageId?: string;
  threadRoot?: string;
  parseError?: string;
}

export async function materialiseReceipt(
  env: Env,
  ctx: Ctx,
  receiptId: string,
): Promise<MaterialiseOutcome> {
  const receipt = await env.CATALOG.prepare(
    `SELECT r.id, r.org_id, r.envelope_to, r.blob_key, r.blob_sha256, r.raw_bytes, r.accepted_at,
            a.mailbox_id
       FROM ingress_receipts r
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
      WHERE r.id = ? LIMIT 1`,
  )
    .bind(receiptId)
    .first<{
      id: string; org_id: string; envelope_to: string; blob_key: string; blob_sha256: string;
      raw_bytes: number; accepted_at: string; mailbox_id: string;
    }>();

  if (receipt === null) {
    // Not retryable and not an error: the receipt is gone, or its address was removed. Raising would
    // wedge the outbox forever on an event that can never succeed.
    return { status: "already_present" };
  }

  const existing = await env.CATALOG.prepare(
    "SELECT id, thread_root_rfc_id FROM messages WHERE ingress_receipt_id = ? LIMIT 1",
  )
    .bind(receiptId)
    .first<{ id: string; thread_root_rfc_id: string | null }>();
  if (existing !== null) {
    return { status: "already_present", messageId: existing.id, threadRoot: existing.thread_root_rfc_id ?? undefined };
  }

  // Reaching the evidence is the one thing allowed to throw — it is retryable, and the sweeper will.
  const raw = await getEvidence(env, receipt.blob_key);

  let parseError: string | undefined;
  let headers;
  try {
    headers = parseHeaders(raw);
  } catch (error) {
    // Defensive: the parser is written not to throw, and if it ever does the message still gets a row.
    parseError = `E_HEADERS_UNPARSED  ${(error as Error).message.split("\n")[0]}`;
    headers = { messageId: null, inReplyTo: null, referencesRoot: null, subject: "", from: "", date: null };
  }

  const messageId = ctx.id("msg");
  const at = new Date(ctx.now()).toISOString();

  /*
   * The body, as words for the search index (#107 L2).
   *
   * **No extra R2 read**: `raw` was already fetched above to parse the headers, so indexing the body costs
   * parsing rather than a round trip. That is the reason this happens at ingest rather than in a later pass —
   * a message is never again this cheap to index.
   *
   * `indexableText` returns null and never throws: a body that cannot be parsed is still a message, and §24
   * forbids letting that block delivery. Such a message is unsearchable by its contents and stays reachable
   * by paging and by subject, which is the same position `renderBody` takes when it reports `unparsed`.
   */
  const bodyWords = await indexableText(raw);

  // A message with no readable Message-ID still needs a stable identity to thread on, and it must be
  // one that survives re-parsing. The receipt id is derived, unique and already in hand.
  const rfcMessageId = headers.messageId ?? `receipt.${receipt.id}@invalid`;
  if (headers.messageId === null) {
    parseError ??= "E_NO_MESSAGE_ID  the sender omitted a Message-ID header; threading uses a derived id";
  }

  // Its own id when there is no chain — which is what makes the column non-null for every message and
  // the thread query a single index scan rather than a union with the no-chain case.
  const threadRoot = headers.referencesRoot ?? rfcMessageId;

  // `sent_at` falls back to acceptance time, visibly: substituting *now* for an unreadable Date would
  // silently reorder a mailbox, so the fallback is the one timestamp this Node actually observed.
  const sentAtValue = headers.date ?? receipt.accepted_at;
  if (headers.date === null) {
    parseError ??= "E_NO_DATE  the Date header was absent or unreadable; sorting uses acceptance time";
  }

  const timeBucket = bucketFor(Date.parse(sentAtValue));

  // Committed *before* the batch below, and re-read, so the id bound into the message and the case is the
  // one that won. See `conversationForDelivery` — returning statements to include here looked more atomic
  // and silently orphaned the loser of a race.
  const conversationId = await conversationForDelivery(env, ctx, receipt.org_id, threadRoot);

  // One batch: the message and its delivery commit together, or neither does (#5, §22). A message row
  // without a mailbox item would be mail that exists and is in no inbox.
  await env.CATALOG.batch([
    env.CATALOG.prepare(
      `INSERT OR IGNORE INTO messages
         (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id, thread_id,
          subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
          in_reply_to, thread_root_rfc_id, parse_error, conversation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      messageId, receipt.org_id, timeBucket, receipt.blob_key, receipt.blob_sha256, receipt.raw_bytes,
      rfcMessageId,
      // `thread_id` is this Node's own thread identity; `thread_root_rfc_id` is the sender's. Both
      // exist because the first is stable under re-parsing and the second is what other clients agree
      // on. Grouping by root across an org is what assigns the shared thread_id, and that is #30's
      // problem — a reply cannot be threaded before there is anything to reply to.
      ctx.id("thr"),
      headers.subject, headers.from, sentAtValue, receipt.accepted_at, receipt.id, at,
      headers.inReplyTo, threadRoot, parseError ?? null, conversationId,
    ),
    /*
     * The search index, immediately after the row it is derived from and inside the same batch (#107).
     *
     * **Position is load-bearing.** `indexMessage` is an `INSERT … SELECT … FROM messages WHERE id = ?`, so
     * it must run after the insert above or it selects nothing and the message is silently unsearchable. D1
     * runs a batch's statements in order in one transaction, which is what makes reading the previous
     * statement's write both possible and atomic with it.
     *
     * That shape is also what handles the redelivery above: `INSERT OR IGNORE` against `msg_by_receipt` means
     * a second delivery of the same receipt mints a fresh `msg_…` id and writes no row, and a search insert
     * binding its own values would then index an id that belongs to nothing. Selecting from `messages` makes
     * the two statements agree by construction rather than by both being correct.
     */
    indexMessage(env, messageId),
    /*
     * The body index, in the same batch and after the message for the same reason (#107 L2). Omitted
     * entirely when there is nothing to index — an empty index row can never match, and it would still be
     * counted as indexed, which would make the backfill's remaining-work figure a lie.
     */
    ...(bodyWords.kind === "text" ? [indexBody(env, messageId, bodyWords.text, 0)] : []),
    /*
     * Settled either way, in the same batch, and settled to the state that is **true** rather than to one
     * "finished" value. A headers-only message is `empty`; one whose body the parser could not read is
     * `unindexable` with the reason kept. Both are terminal, and separating them is what lets `doctor` say
     * "eleven messages could not be parsed" — which is actionable — instead of burying it in a count of
     * messages with no body text, which is not.
     *
     * There is no `retryable` here on purpose: ingest already holds the bytes, so the only failure reachable
     * at this point is the parser's, and that is deterministic. Retrying it next minute would re-read the
     * same bytes and fail the same way.
     */
    settleBodyIndex(
      env,
      messageId,
      bodyWords.kind === "unparseable"
        ? { state: "unindexable", error: bodyWords.why }
        : { state: bodyWords.kind === "text" ? "indexed" : "empty" },
      at,
      /*
       * Claim zero. The message row is inserted by this same batch, so nothing can be holding a lease on it
       * and the comparison is trivially satisfied — but it is made rather than skipped, because
       * `settleBodyIndex` requires it and that requirement is what stopped the backfill silently dropping the
       * compare-and-swap. A parameter that some callers may omit is one every caller may omit.
       */
      0,
    ),
    env.CATALOG.prepare(
      `INSERT OR IGNORE INTO mailbox_items
         (id, org_id, mailbox_id, time_bucket, message_id, change_number, flags, sent_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(
      ctx.id("mbi"), receipt.org_id, receipt.mailbox_id, timeBucket, messageId,
      // change_number is §12 invariant 5 and must be DO-serialized. Nothing serializes it yet, so 0 is
      // a placeholder rather than a value — recorded here because a monotonic counter that is silently
      // always zero is exactly the landmine a later sync protocol would trip over.
      0,
      0, sentAtValue, at,
    ),
    // The case, in the same batch. A message filed with no case is mail in nobody's queue; a case with no
    // message is work about nothing. `INSERT OR IGNORE` against `cas_unique`, so a redelivery or two
    // deliveries racing file one case — the constraint is the concurrency control (#9's shape).
    caseForDelivery(env, ctx, receipt.org_id, conversationId, receipt.mailbox_id, at),
  ]);

  // The clock starts *after* the case exists, because it updates it. Not in the batch above: the case is
  // created with `INSERT OR IGNORE`, so its row id is not knowable here, and the clock is keyed on
  // (conversation, mailbox) instead.
  //
  // A mailbox with no `first_response_minutes` leaves the clock NULL and the case never enters the sweep —
  // which is the shipped state, because a default would be this Node inventing a promise nobody made.
  const caseRow = await env.CATALOG.prepare(
    "SELECT id FROM cases WHERE org_id = ? AND conversation_id = ? AND mailbox_id = ? LIMIT 1",
  ).bind(receipt.org_id, conversationId, receipt.mailbox_id).first<{ id: string }>();
  if (caseRow !== null) {
    // `received_at`, not now: the clock measures how long the *customer* has waited, and that started when
    // their message arrived rather than when this Node got round to parsing it.
    await clockOnInbound(env, receipt.org_id, caseRow.id, receipt.accepted_at).run();
  }

  // A delivery report that arrived as ordinary inbound mail is recorded where the queue's own events go,
  // so the outbox stays the single account of delivery. Without this a reader sees a bounce notice in the
  // inbox while the outbox says the send was accepted — two views contradicting each other with neither
  // being wrong, because they are about different sends.
  //
  // After the message batch, not inside it. The message belongs in the mailbox whatever the report says,
  // and a failure to interpret somebody else's report must never cost a person their mail.
  try {
    const text = new TextDecoder().decode(raw);
    if (isDeliveryReport(headerBlockContentType(text), text)) {
      const outcome = await recordDeliveryReport(env, ctx, receipt.org_id, receipt.id, text);
      if (!outcome.recorded) {
        // Logged rather than guessed at. "A report arrived that this Node could not read" is a fact an
        // operator can act on; a fabricated bounce shown to a user is not.
        await log(env, ctx, {
          level: "warn",
          event: "delivery_report.unreadable",
          message: `A delivery report could not be attributed: ${outcome.unreadable}`,
          orgId: receipt.org_id,
          detail: { ingressReceiptId: receipt.id },
        });
      }
    }
  } catch (error) {
    await log(env, ctx, {
      level: "warn",
      event: "delivery_report.failed",
      message: (error as Error).message.split("\n")[0] ?? "unknown",
      orgId: receipt.org_id,
      detail: { ingressReceiptId: receipt.id },
    });
  }

  return { status: "created", messageId, threadRoot, parseError };
}

/** The top-level Content-Type, read off the header block without parsing the whole message. */
function headerBlockContentType(text: string): string | null {
  const block = text.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const found = /^content-type:\s*(.+)$/im.exec(block);
  return found === null ? null : found[1]!.trim();
}
