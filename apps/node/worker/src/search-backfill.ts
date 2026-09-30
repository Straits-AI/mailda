import type { Ctx } from "@mailda/runtime";

import { getEvidence, runKeyCache } from "./evidence-store.ts";
import {
  afterFailedAttempt, bodyIndexText, claimBodyIndexBatch, indexBody, reindexMessages, requeueOlderBodyForm,
  SEARCH_FORM, settleBodyIndex,
} from "./search.ts";
import { indexableText } from "./search-body.ts";

/**
 * Catching the search indexes up on mail that arrived before they existed (#107).
 *
 * ## Why this is a separate file from `search.ts`
 *
 * Not organisation. `src/doctor.ts` imports the two *counting* functions, and
 * `test/node/doctor-meter-honesty.test.ts` requires that **no file on the doctor path contains `.batch(`** —
 * because the cost meter counts a batch as zero executions, so a batch reachable from `runDoctor` would make
 * the reported figure understate the real one. `backfillBodyIndex` batches, and the guard is lexical on the
 * file rather than on the call graph.
 *
 * `decidersByMailbox` was moved into a file of its own for exactly this reason, and the guard's own comment
 * records it. So this is the established answer rather than a workaround: the argument "unreachable from
 * doctor" is available for a *prepare*, and the batch rule is absolute.
 *
 * It also keeps `search.ts` loadable outside workerd. `ftsQuery` is pure and
 * `test/node/fts-query.test.ts` runs it under the node config; importing `evidence-store.ts` there — which
 * this file needs and that one no longer does — broke that suite at module load.
 */

/**
 * How many messages one backfill pass indexes.
 *
 * It runs from the scheduled handler every minute and is resumable, so a Node with a long archive catches up
 * over a few passes rather than risking one invocation that has to finish. 500 is unchanged from when a pass
 * was one `INSERT … SELECT`; it now costs one read and four batches (`BACKFILL_BATCH`), each one D1 round trip.
 */
const BACKFILL_LIMIT = 500;

/**
 * Statements per `batch()`. `test/message-search.measure.test.ts` records a 3,600-statement batch refused by
 * D1 and seeds its corpus 300 at a time, so the pass uses that same observed-good size rather than a new one.
 */
const BACKFILL_BATCH = 300;

/**
 * Messages per batch: `reindexMessages` spends one statement on the set's delete and two on each message (its
 * row and its stamp), so 149 messages are 299 statements.
 */
const REINDEX_PER_BATCH = Math.floor((BACKFILL_BATCH - 1) / 2);

/**
 * Writes the subject row of every message not yet in the current form. Returns how many it brought there.
 *
 * ## Chosen by the form they were written in, not by whether they have a row
 *
 * This selected messages with **no** index row. Since `searchText` a row can exist and be wrong — written
 * in form 0 before this code, or after 0071 by the version still serving during a deploy — and "has a row" cannot tell. So
 * each message records the form its row was written in (`search_index_form`, 0071), and this pass takes up to
 * `BACKFILL_LIMIT` messages below `SEARCH_FORM`: mail from before the index, whose row is missing, and mail
 * whose row is old, alike. `reindexMessages` deletes whatever old row a message has and writes the current
 * one through `indexMessage` — the **same statements** ingest uses, so there is one spelling of an index row
 * and one of its stamp.
 *
 * The selection used to be `NOT EXISTS (… s.message_id = m.id)`, which FTS5 answers by scanning the index once
 * per message: 4,501,465 rows read per pass on a 3,000-message Node that was caught up, every minute. The form
 * is an ordinary indexed column, so a caught-up pass reads nothing.
 *
 * It is idempotent and resumable without a cursor: the form *is* the position. Two passes overlapping could
 * each re-form the same message; the second's delete takes the first's row, so the cost is the work, not a
 * duplicate row. A pass is a read and four batches, and ticks are a minute apart.
 * ponytail: no claim or lease on the subject backfill; add one if a pass is ever seen to outlast a tick.
 *
 * ## What it deliberately does not do
 *
 * It does not read R2 and it does not decrypt anything, because `subject` and `from_addr` are columns of
 * `messages` in plaintext. The body index has to, which is why that backfill is a different function.
 */
export async function backfillSearchIndex(env: Env): Promise<number> {
  const due = await env.CATALOG.prepare(
    // The receipt join matches `indexMessage`'s, so a message the insert would skip is not selected forever.
    `SELECT m.id, m.subject, m.from_addr FROM messages m
       JOIN ingress_receipts r ON r.id = m.ingress_receipt_id
      WHERE m.search_index_form < ?
      LIMIT ?`,
  ).bind(SEARCH_FORM, BACKFILL_LIMIT).all<{ id: string; subject: string | null; from_addr: string | null }>();

  let written = 0;
  for (let at = 0; at < due.results.length; at += REINDEX_PER_BATCH) {
    const outcomes = await env.CATALOG.batch(reindexMessages(env, due.results.slice(at, at + REINDEX_PER_BATCH)
      .map((message) => ({ id: message.id, subject: message.subject, from: message.from_addr }))));
    // The stamps, which are every second statement after the delete: one change per message now current.
    written += outcomes.filter((_, index) => index > 0 && index % 2 === 0)
      .reduce((sum, outcome) => sum + (outcome.meta.changes ?? 0), 0);
  }
  return written;
}

/*
 * ## There is no `unindexMessage`, and that is the honest state rather than an omission
 *
 * #105 requires that the index row die with the message. **Nothing in this Node deletes a message row** —
 * `grep -rE "DELETE\s+FROM\s+messages" src/` finds none, and content deletion today means the single
 * `EVIDENCE.delete` in `reconcile.ts`, which destroys an R2 blob and leaves `messages` intact. So the rule
 * has no event to attach to yet.
 *
 * A `unindexMessage` written now would be a function nobody calls, and a `DELETE FROM message_search` in this
 * file would put an entry in `content-deletion-world.test.ts`'s inventory describing a deletion that happens
 * nowhere. Both are this repository's recurring shape from the other direction: not a comment claiming a
 * property the code lacks, but code implying a lifecycle the product does not have.
 *
 * The obligation is enforced instead by `test/node/search-scope-world.test.ts`, which asserts that nothing
 * deletes a message today. That assertion **fails on the day somebody adds message deletion**, and its
 * failure message carries the rule — so the requirement is met by a check that cannot be satisfied by
 * forgetting, rather than by a function waiting to be wired up correctly by whoever gets there next.
 */

/**
 * How many messages one **body** backfill pass reaches.
 *
 * Far smaller than the metadata backfill's 500, and the asymmetry is the whole difference between the two
 * layers. The metadata backfill reads `messages` and writes D1, and never leaves it. This one costs, per message:
 * an R2 read, a vault-key unwrap, frame decryption, and a full MIME parse. Those are subrequests against a
 * per-invocation ceiling (`doctor.free.max_subrequests` records it at 1,000 on Free), and the parse is CPU
 * against a Worker's limit.
 *
 * 25 keeps a pass to roughly one R2 read and one parse per message with the whole thing far inside both
 * ceilings, running once a minute. A Node with a long archive therefore catches up slowly and visibly —
 * `doctor`'s `body_index_backlog` counts what is left — which is the correct trade when the alternative is a
 * pass that sometimes exceeds a limit and retries the same work forever.
 *
 * The key cache is what makes 25 affordable rather than 25 separate vault round trips: every message in one
 * pass is very likely sealed under the same generation.
 */
const BODY_BACKFILL_LIMIT = 25;

/**
 * Indexes the bodies of messages the index has not reached. Returns how many it settled.
 *
 * ## Why this reads R2 and the metadata backfill does not
 *
 * `subject` and `from_addr` are columns of `messages`; a body is an encrypted object in R2. So this is the
 * expensive backfill, and it is the reason indexing happens **at ingest** wherever possible — there the raw
 * bytes have already been fetched to parse the headers, so the body costs a parse and no round trip. A message
 * is never again as cheap to index as on the minute it arrives.
 *
 * ## Every message is settled, including the ones with nothing to index
 *
 * A failure to read or parse one message settles it anyway. That is deliberate and it is the difference
 * between a backfill that converges and one that does not: an unreadable body is not going to become readable
 * on the next pass, and leaving it unsettled means the backlog never empties and the pass spends its whole
 * budget on the same failures forever. §24's guarantee is about not losing mail, and nothing is lost — the
 * message stays listed, readable and searchable by subject, and is simply not searchable by its contents.
 *
 * **The two failure classes are told apart**, and this paragraph used to say they were not. Reaching the
 * evidence is R2 and the vault: recoverable, so it becomes `retryable`, backs off from one minute to sixteen,
 * and is abandoned after six attempts with the reason kept. Parsing what came back is deterministic: the same
 * bytes fail the same way next minute, so retrying spends the pass on a message that cannot succeed while the
 * mail behind it waits.
 *
 * That distinction and `mailda search repair` arrived with #107's state machine, and this comment went on
 * describing the absence they filled — sitting directly above the code that fills it, which is the shape of
 * drift this repository keeps meeting: a comment that reads as a statement of what the system cannot do,
 * three lines above the thing doing it.
 */
export async function backfillBodyIndex(env: Env, ctx: Ctx): Promise<number> {
  const at = new Date(ctx.now()).toISOString();
  /*
   * Bodies indexed in an older form back into the queue first, as many as one pass settles, so the claim below
   * can take them this minute. Their old rows stay and answer their Latin words until replaced; see
   * `requeueOlderBodyForm` on why this runs every pass rather than once in 0071.
   */
  await requeueOlderBodyForm(env, BODY_BACKFILL_LIMIT).run();
  /*
   * **Claimed, not selected.** `claimBodyIndexBatch` is one `UPDATE … RETURNING` that picks the batch and
   * stamps a lease on it in the same statement, so there is no window between deciding to index a message and
   * marking it as being indexed. That window is why this pass could hand the same message to two overlapping
   * cron ticks — see the migration, and `search.ts` on why the version matters as well as the lease.
   *
   * Pending first, then retryables whose time has come — and **newest first within each**, which is a guess
   * about what people search for and worth naming as one. A reader looking for something is far more often
   * looking for recent mail, so a Node catching up becomes useful from the top down.
   */
  const due = await claimBodyIndexBatch(env, at, BODY_BACKFILL_LIMIT)
    .all<{ id: string; blob_key: string; attempts: number; version: number }>();
  if (due.results.length === 0) return 0;

  const cache = runKeyCache();
  const statements: D1PreparedStatement[] = [];
  for (const message of due.results) {
    /*
     * The two failure classes, told apart by **where** they come from rather than by inspecting an error
     * string. Reaching the evidence is R2 and the vault: recoverable, and retried. Parsing what came back is
     * deterministic: the same bytes will fail the same way next minute, so retrying is spending the pass on a
     * message that cannot succeed while the mail behind it waits.
     *
     * This is the distinction the previous design could not make. It settled both, so one momentary R2 error
     * made a message permanently unsearchable by its text with no record of why.
     */
    let raw: Uint8Array;
    try {
      raw = await getEvidence(env, message.blob_key, cache);
    } catch (error) {
      const why = (error as Error).message.split("\n")[0] ?? "unreadable evidence";
      statements.push(settleBodyIndex(env, message.id, afterFailedAttempt(message.attempts + 1, why), at, message.version));
      continue;
    }

    const body = await indexableText(raw);
    if (body.kind === "text") {
      const indexed = bodyIndexText(body.text);
      statements.push(indexBody(env, message.id, indexed, message.version));
      statements.push(settleBodyIndex(
        env, message.id, { state: "indexed", cutFromBytes: indexed.cutFromBytes }, at, message.version,
      ));
    } else if (body.kind === "empty") {
      statements.push(settleBodyIndex(env, message.id, { state: "empty" }, at, message.version));
    } else {
      // Deterministic: no retry, and the reason is kept so `doctor` can count it and an operator can see it.
      statements.push(settleBodyIndex(env, message.id, { state: "unindexable", error: body.why }, at, message.version));
    }
  }
  await env.CATALOG.batch(statements);
  return due.results.length;
}
