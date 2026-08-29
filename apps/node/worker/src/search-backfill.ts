import type { Ctx } from "@mailda/runtime";

import { getEvidence, runKeyCache } from "./evidence-store.ts";
import { afterFailedAttempt, claimBodyIndexBatch, indexBody, settleBodyIndex } from "./search.ts";
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
 * Small because it is bounded by a *statement*, not by a scan: the pass is one `INSERT … SELECT` with a
 * `LIMIT`, so the cost is the limit and the work per row is an index write. It runs from the scheduled handler
 * every minute and is resumable, so a Node with a long archive catches up over a few passes rather than
 * risking one invocation that has to finish.
 */
const BACKFILL_LIMIT = 500;

/**
 * Indexes messages that arrived before the index existed. Returns how many it wrote.
 *
 * ## Why this is one statement rather than a read-then-write loop
 *
 * `INSERT … SELECT … WHERE NOT EXISTS … LIMIT` never brings a row into the Worker, so a pass costs one D1
 * query regardless of the limit, and there is no window between deciding to index a message and indexing it.
 * The `NOT EXISTS` makes it **idempotent and resumable**: running it twice indexes nothing twice, and running
 * it after a partial pass continues where that pass stopped without recording a cursor anywhere.
 *
 * That last property is the reason there is no state to lose. A backfill with a stored position is a backfill
 * that can silently skip a range when the position is written before the work commits; here the absence of an
 * index row *is* the position.
 *
 * ## What it deliberately does not do
 *
 * It does not read R2 and it does not decrypt anything, because `subject` and `from_addr` are columns of
 * `messages` in plaintext. The body index that #105 puts at L2 will have to, and its backfill will be a
 * genuinely different and more expensive thing — which is why this one is not written to be reused for it.
 *
 * It also does not report progress to anybody. `doctor` counts what is left, so the boundary is visible as a
 * number an operator can read rather than as a log line that scrolls past.
 */
export async function backfillSearchIndex(env: Env): Promise<number> {
  const outcome = await env.CATALOG.prepare(
    `INSERT INTO message_search (subject, from_addr, message_id, org_id)
     SELECT subject, from_addr, id, org_id FROM messages m
      WHERE NOT EXISTS (SELECT 1 FROM message_search s WHERE s.message_id = m.id)
      LIMIT ?`,
  ).bind(BACKFILL_LIMIT).run();
  return outcome.meta.changes ?? 0;
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
 * layers. The metadata backfill is one `INSERT … SELECT` and never leaves D1. This one costs, per message:
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
 * A read that fails for a *transient* reason is settled too, which is the cost of that choice and is stated
 * rather than hidden: such a message stays unsearchable by body until something re-indexes it, and nothing
 * does yet. Recorded in `docs/receipts/message-search-cost.md` under what is not built.
 */
export async function backfillBodyIndex(env: Env, ctx: Ctx): Promise<number> {
  const at = new Date(ctx.now()).toISOString();
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
      statements.push(indexBody(env, message.id, body.text, message.version));
      statements.push(settleBodyIndex(env, message.id, { state: "indexed" }, at, message.version));
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
