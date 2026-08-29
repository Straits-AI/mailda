/**
 * The metadata search index: what goes into it, and how a person's typing is turned into a query (#107).
 *
 * ## `MATCH` takes a query language, and that is the whole reason this file exists
 *
 * FTS5's right-hand side is not a string to look for — it is an expression with operators (`AND`, `OR`,
 * `NOT`, `NEAR`), column filters (`col:term`), prefixes (`*`), parentheses and quoted phrases. Passing a
 * search box's contents to it unaltered means the user is writing that expression, and ordinary typing is a
 * **syntax error** rather than a search that finds nothing.
 *
 * Measured against a live D1 before this was written, because the failure mode decides the design. Every one
 * of these returned `fts5: syntax error near …`:
 *
 * | typed | why it fails |
 * |:--|:--|
 * | `AND`, `NOT` | bare operators, and both are ordinary English words |
 * | `a OR` | a trailing operator with nothing after it |
 * | `foo(`, `NEAR(` | an unbalanced parenthesis |
 * | `*` | a prefix with no term |
 * | `sub:x` | `:` is the column-filter operator, so a time or a URL breaks |
 *
 * A search box that 500s when somebody types **"AND"** is not a robustness edge case, it is the feature not
 * working. So no input reaches `MATCH` unquoted: `ftsQuery` extracts tokens and rebuilds the expression, and
 * the user is never the author of it.
 *
 * ## Why rebuild rather than escape
 *
 * Escaping means enumerating what is dangerous, and the list above is exactly the enumeration that gets one
 * entry short. Rebuilding inverts it — only characters that can be *part of a token* survive, and everything
 * else is a separator. A form this file does not understand cannot be smuggled through, because nothing is
 * passed through at all.
 *
 * This also settles what searching *means* here, which is a product decision and not only a safety one:
 * **every word must appear** (FTS5's implicit AND between phrases), the last word matches as a prefix so
 * typing narrows as you go, and there is no way to ask for `OR` or `NOT`. Advanced query syntax is not
 * withheld because it is hard; it is withheld because a mail search box that silently interprets `NOT` as an
 * operator will one day fail to find a message whose subject contains the word "not".
 */

/**
 * The characters that can be inside a token, matched as runs.
 *
 * Letters and numbers by any script's definition, because a subject line is not ASCII — plus nothing else.
 * The index's tokenizer is `unicode61`, which splits on everything outside this set, so a separator kept here
 * would be a character the query names and the index cannot hold.
 *
 * `u` flag and `\p{…}` rather than `\w`: `\w` is `[A-Za-z0-9_]`, so it would cut every accented and
 * non-Latin subject into fragments and quietly make search worse for exactly the mail least likely to be
 * checked by whoever wrote the regex.
 */
const TOKEN = /[\p{L}\p{N}]+/gu;

/**
 * How many tokens one query may carry.
 *
 * Each token is a separate phrase the index must intersect, so this bounds the work a single request can ask
 * for. Pasting an entire paragraph into the search box is the ordinary way to reach it, not an attack, which
 * is why it truncates rather than refuses: with every word required, a query that already names twelve terms
 * is not made more selective by the thirteenth.
 */
const MAX_TOKENS = 12;

/**
 * A person's typing as an FTS5 expression, or `null` when they typed nothing searchable.
 *
 * `null` rather than an empty string, and rather than an expression that matches everything: those are three
 * different things and only one of them is *"there is no search here"*. An empty `MATCH` is a syntax error,
 * and an expression matching everything would make a blank search box look like a filter that found the whole
 * mailbox — the caller checks for `null` and adds no predicate at all.
 */
export function ftsQuery(raw: string | null): string | null {
  if (raw === null) return null;
  const tokens = [...raw.matchAll(TOKEN)].map((match) => match[0]).slice(0, MAX_TOKENS);
  if (tokens.length === 0) return null;

  /*
   * Every token becomes a quoted phrase, and the last one gains a `*`.
   *
   * Quoted because a bare token is parsed as the expression language — that is the whole finding above. No
   * escaping of the quote is needed and none is done: `TOKEN` admits only letters and numbers, so a `"` can
   * never be inside one. That is a property of the extraction rather than a promise, which is why the
   * extraction is a whitelist.
   *
   * The trailing `*` on the last token only. `"demur"*` was measured to match *demurrage*, so a search
   * narrows while somebody is still typing the word they are part-way through. Applying it to every token
   * would make `inv 44` match far more than a person means, and applying it to none would mean a search for a
   * half-typed word finds nothing until the moment it is complete — which reads as "no such mail".
   */
  return tokens.map((token, index) =>
    index === tokens.length - 1 ? `"${token}"*` : `"${token}"`,
  ).join(" ");
}

/**
 * The index row for a message, as a statement to put in the **same batch** as the message itself.
 *
 * ## Derived from the row rather than from the values in hand
 *
 * `INSERT … SELECT subject, from_addr FROM messages WHERE id = ?` rather than binding the parsed header
 * values again, and the reason is a trap in the caller. `materialise.ts` writes the message with
 * `INSERT OR IGNORE`, against `msg_by_receipt UNIQUE (ingress_receipt_id)` — so a redelivery mints a fresh
 * `msg_…` id, the insert is **ignored**, and that id belongs to no row.
 *
 * A search insert binding its own copy of the values would happily write an index entry for that id: an entry
 * pointing at a message that does not exist, which no message deletion will ever remove because there is no
 * message to delete. The orphaned-index-row failure, arriving on the most ordinary event in a mail system.
 *
 * Selecting from `messages` makes it structurally impossible. If the message row was not created, the
 * `SELECT` returns nothing and the `INSERT` writes nothing — the two statements agree because one reads the
 * other, in one batch, in one transaction.
 *
 * It also removes a second, quieter divergence: the index cannot disagree with the message about what the
 * subject *is*, because it never had its own opinion.
 */
export function indexMessage(env: Env, messageId: string): D1PreparedStatement {
  return env.CATALOG.prepare(
    `INSERT INTO message_search (subject, from_addr, message_id, org_id)
     SELECT subject, from_addr, id, org_id FROM messages WHERE id = ?`,
  ).bind(messageId);
}

/**
 * The **body** index row for a message, as a statement for the same batch (#107 L2).
 *
 * ## Addressed by rowid, which is why this cannot be an `INSERT … SELECT` like `indexMessage`
 *
 * `message_body_search` is contentless, so it stores no column values — an `UNINDEXED` column carrying the
 * message id reads back `null` (measured; `migrations/0041_body_search.sql` records why). The row's identity
 * is therefore its **rowid, set equal to `messages.rowid`**, and every read joins `messages` on it.
 *
 * The body text comes from the parsed message rather than from a column, so the value is bound — but the
 * *rowid* is still selected from `messages`, which keeps the property that made `indexMessage` safe: if the
 * message row was not created, the `SELECT` returns nothing, the `INSERT` writes nothing, and no index row
 * can point at a message that does not exist.
 *
 * `INSERT OR REPLACE` on the rowid, not plain `INSERT`. A backfill and an ingest can reach the same message —
 * the backfill selects messages with no index row, and a redelivery racing it could index one in between —
 * and two rows for one rowid is not a state FTS5 should be asked to hold. Replacing is idempotent and makes
 * "index this message" mean the same thing whoever calls it.
 */
export function indexBody(
  env: Env,
  messageId: string,
  body: string,
  /**
   * The claim version this write belongs to — the same one the settlement carries.
   *
   * **Required, for the reason the settlement's version is required.** The lease and the compare-and-swap
   * protected `messages.body_index_state` and left this statement unconditional, so a stale worker could not
   * record its *answer* and could still write its *tokens*:
   *
   * ```
   *   worker A   claims version 1, becomes slow, lease lapses
   *   worker B   claims version 2, parses, settles `empty`
   *   worker A   returns: INSERT OR REPLACE lands, version-1 state update changes nothing
   *   result     state says `empty`, and body search still matches A's text
   * ```
   *
   * The reverse is the same shape: an older parse overwriting a newer one's tokens. Either way the index and
   * the state column disagree, which is precisely the disagreement `repairBodyIndex` was changed to prevent
   * from the other direction.
   */
  version: number,
): D1PreparedStatement {
  return env.CATALOG.prepare(
    `INSERT OR REPLACE INTO message_body_search (rowid, body)
     SELECT rowid, ? FROM messages WHERE id = ? AND body_index_attempt_version = ?`,
  ).bind(body, messageId, version);
}


/**
 * Where a message stands with the body index (`migrations/0044_body_index_state.sql`).
 *
 * `empty` and `unindexable` are both terminal and are deliberately not one state: *"eleven messages have no
 * body text"* is ordinary, and *"eleven messages could not be parsed"* is something an operator should look
 * at. A single "finished" state is what the previous design had, and it is why a transient read failure could
 * make a message permanently unsearchable with no record of why.
 */
export type BodyIndexState = "pending" | "indexed" | "empty" | "unindexable" | "retryable";

/**
 * How many times a recoverable failure is retried before it is called permanent.
 *
 * Bounded, because "retry until it works" is a pass that spends its whole budget on the same failure forever
 * and never reaches the mail behind it. Six attempts across the backoff below is about half an hour of
 * patience, which covers an R2 blip or a vault restart and does not cover a message that is simply broken.
 *
 * When it runs out the state becomes `unindexable` with the error kept — **not** `empty`. "We stopped trying"
 * is a different fact from "there was nothing there", and repair exists for exactly the messages this
 * boundary gives up on.
 */
export const BODY_INDEX_MAX_ATTEMPTS = 6;

/**
 * When to try again, given how many attempts have already failed.
 *
 * Exponential from one minute, capped at sixteen. The cap matters more than the curve: an uncapped doubling
 * reaches days by attempt eleven, and a message nobody retries for a day is a message nobody retries.
 */
export function nextAttemptAt(now: number, attempts: number): string {
  const minutes = Math.min(2 ** Math.max(0, attempts - 1), 16);
  return new Date(now + minutes * 60_000).toISOString();
}

/**
 * Records the outcome of one attempt at a message's body.
 *
 * Every terminal outcome clears the retry fields and `retryable` is the only one that sets them. A transition
 * leaving `body_index_next_attempt_at` behind on a terminal state would make the selector's comparison
 * meaningful for a message that is finished.
 */
export function settleBodyIndex(
  env: Env,
  messageId: string,
  outcome:
    | { state: "indexed" | "empty" }
    | { state: "unindexable"; error: string }
    | { state: "retryable"; error: string; attempts: number },
  at: string,
  /**
   * The `body_index_attempt_version` this settlement is answering for — from `claimBodyIndexBatch` on the
   * backfill path, and `0` from `materialise.ts`, which settles a message it created moments earlier in the
   * same batch and which nothing can have claimed.
   *
   * **Required, and that is the point.** It was optional first, defaulting to no comparison, and mutating the
   * one call site that supplies it — deleting the argument in `search-backfill.ts` — left every test passing.
   * The clause was correct and unreached, which is this repository's recurring defect wearing a different hat.
   * A required parameter turns that mutation into a compile error, which is a stronger guarantee than a test:
   * there is nothing to remember and no way to forget.
   */
  version: number,
): D1PreparedStatement {
  /*
   * The compare-and-swap. A lease bounds how long two passes can overlap; this is what makes the write correct
   * when the bound is *exceeded* — a slow pass whose lease lapsed, whose rows were re-claimed and re-settled
   * by a later pass, cannot then overwrite the newer answer with its stale one.
   *
   * Bound as a value rather than interpolated into the statement text, so a version that somehow arrived as a
   * string cannot become a comparison that is always false — a statement that succeeds and changes no rows is
   * the failure this codebase keeps meeting, and it does not raise.
   */

  if (outcome.state === "retryable") {
    return env.CATALOG.prepare(
      `UPDATE messages
          SET body_index_state = 'retryable', body_index_attempts = ?, body_index_error = ?,
              body_index_next_attempt_at = ?, body_indexed_at = NULL,
              body_index_lease_until = NULL
        WHERE id = ? AND body_index_attempt_version = ?`,
    ).bind(
      outcome.attempts, outcome.error, nextAttemptAt(Date.parse(at), outcome.attempts), messageId,
      version,
    );
  }
  return env.CATALOG.prepare(
    `UPDATE messages
        SET body_index_state = ?, body_index_error = ?, body_index_next_attempt_at = NULL,
            body_indexed_at = ?, body_index_lease_until = NULL
      WHERE id = ? AND body_index_attempt_version = ?`,
  ).bind(
    outcome.state, outcome.state === "unindexable" ? outcome.error : null, at, messageId, version,
  );
}

/**
 * How long a claim on a message lasts.
 *
 * Five minutes, against a pass that is expected to take seconds. The number is not a guess about how long the
 * work takes — it is how long a **dead** pass parks its rows, since a pass that crashes or is evicted never
 * clears its lease and the rows wait this long before anybody else may try. Long enough that a slow pass is
 * not overtaken by the next cron tick in the ordinary case; short enough that a crash costs one tick's worth
 * of progress rather than a day's.
 *
 * The compare-and-swap is what makes the exact value uncritical. Choosing this badly costs throughput; it
 * cannot cost correctness, because a lapsed lease's settlement is refused by the version rather than applied.
 */
export const BODY_INDEX_LEASE_MS = 5 * 60_000;

/**
 * Claims up to `limit` messages for one body-index pass, and returns what it claimed.
 *
 * `UPDATE … RETURNING`, which is **one statement that both selects and claims** — so there is no window
 * between deciding to index a message and marking it as being indexed. That window was the defect: the state
 * stayed `pending` for the whole of a pass's R2 reads and parses, so the next cron tick a minute later
 * selected the same rows.
 *
 * D1 supports `RETURNING`; measured rather than assumed, in `docs/receipts/d1-fts5-search.md`.
 *
 * The subquery orders and limits, and the outer `UPDATE` claims exactly that set. Ordering inside a bare
 * `UPDATE … LIMIT` is not something SQLite guarantees for the *set chosen*, and "newest first" is a promise
 * this pass makes to readers — see `backfillBodyIndex` on why a Node catching up becomes useful from the top
 * down.
 */
export function claimBodyIndexBatch(
  env: Env,
  at: string,
  limit: number,
): D1PreparedStatement {
  const until = new Date(Date.parse(at) + BODY_INDEX_LEASE_MS).toISOString();
  return env.CATALOG.prepare(
    `UPDATE messages
        SET body_index_lease_until = ?,
            body_index_attempt_version = body_index_attempt_version + 1
      WHERE id IN (
        SELECT id FROM messages
         WHERE blob_key IS NOT NULL
           AND (body_index_state = 'pending'
                OR (body_index_state = 'retryable' AND body_index_next_attempt_at <= ?))
           AND (body_index_lease_until IS NULL OR body_index_lease_until <= ?)
         ORDER BY CASE body_index_state WHEN 'pending' THEN 0 ELSE 1 END, received_at DESC
         LIMIT ?
      )
      RETURNING id, blob_key, body_index_attempts AS attempts,
                body_index_attempt_version AS version`,
  ).bind(until, at, at, limit);
}

/**
 * Whether a recoverable failure has run out of patience.
 *
 * Exported so the backfill and its test agree on the boundary rather than each having an opinion about it.
 */
export function afterFailedAttempt(
  attempts: number,
  error: string,
): { state: "retryable"; error: string; attempts: number } | { state: "unindexable"; error: string } {
  if (attempts >= BODY_INDEX_MAX_ATTEMPTS) {
    // The count is in the message on purpose: "gave up" and "could not parse" are both `unindexable`, and an
    // operator deciding whether to repair needs to know which one they are looking at.
    return { state: "unindexable", error: `abandoned after ${attempts} attempts: ${error}` };
  }
  return { state: "retryable", error, attempts };
}

/**
 * Puts messages back in the queue, whatever state they reached — and takes them out of the index first.
 *
 * ## Two statements, because one was wrong
 *
 * This was a single `UPDATE`, and its comment argued the index row could stay because `indexBody`'s
 * `INSERT OR REPLACE` overwrites on the next pass. That is true **only when the next pass finds text**. A
 * re-parse settling `empty` or `unindexable` runs no `indexBody` at all, so the old text survived for ever:
 * `bodyIndexState` reported a message that had never been indexed while searching its body still returned it.
 * The state column and the index disagreed, and the state column was the one an operator reads.
 *
 * Repair is also not restricted to failed messages — the predicate is `org_id` and `id` and nothing else — so
 * the disagreement is reachable by repairing anything at all, not only by repairing something broken.
 *
 * The delete is possible because `migrations/0041_body_search.sql` sets `contentless_delete=1`. A contentless
 * FTS5 table cannot otherwise have a row removed by rowid, and that option was set for this.
 *
 * Resetting the counter matters — a message that exhausted its attempts an hour ago should get a full set
 * again rather than be abandoned immediately. Clearing the lease matters for the same reason: a message
 * repaired while a pass held a claim on it would otherwise wait out that claim before anybody retried.
 *
 * **The claim version is bumped**, which is what makes the repair stick. Clearing the lease frees the message
 * for a new pass and does nothing about the pass already running: a worker holding the old version could land
 * afterwards, write its tokens and settle its state, undoing the requeue with an answer computed before the
 * operator asked for it. Incrementing invalidates every in-flight claim, so a repair means "nothing already
 * running may speak for this message" rather than only "somebody else may try".
 *
 * Returns statements for the caller to combine, rather than executing them here. This file is on the doctor
 * path, and `test/node/doctor-meter-honesty.test.ts` forbids the batching call in any file that is — the rule
 * is lexical on the file rather than an argument about reachability, which is also why this paragraph does not
 * spell the method name it is talking about.
 *
 * Scoped by `org_id` as well as by id, so a caller holding one organization's ids cannot reach another's.
 */
export function repairBodyIndex(
  env: Env,
  orgId: string,
  messageIds: readonly string[],
): D1PreparedStatement[] {
  const placeholders = messageIds.map(() => "?").join(", ");
  return [
    env.CATALOG.prepare(
      `DELETE FROM message_body_search
        WHERE rowid IN (SELECT rowid FROM messages WHERE org_id = ? AND id IN (${placeholders}))`,
    ).bind(orgId, ...messageIds),
    env.CATALOG.prepare(
      `UPDATE messages
          SET body_index_state = 'pending', body_index_attempts = 0, body_index_error = NULL,
              body_index_next_attempt_at = NULL, body_indexed_at = NULL,
              body_index_lease_until = NULL,
              body_index_attempt_version = body_index_attempt_version + 1
        WHERE org_id = ? AND id IN (${placeholders})`,
    ).bind(orgId, ...messageIds),
  ];
}

/**
 * How many messages are not in the index yet — the number `doctor` reports.
 *
 * Counted rather than inferred from whether a backfill pass wrote anything, because "the last pass indexed
 * nothing" is true both when the backfill is complete and when it is broken. Those need to look different.
 */
export async function unindexedMessages(env: Env): Promise<number> {
  const row = await env.CATALOG.prepare(
    `SELECT count(*) AS n FROM messages m
      WHERE NOT EXISTS (SELECT 1 FROM message_search s WHERE s.message_id = m.id)`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * What the body index has and has not reached, by state.
 *
 * One query rather than five, because `doctor` reports on a subrequest budget it has to report on — and a
 * caller asking five times could see four counts from one moment and one from another.
 *
 * This replaced `unindexedBodies`, which counted `body_indexed_at IS NULL` and therefore answered one
 * question — "how much is left" — for a design that now has three different answers behind it: not reached,
 * failing and retrying, and given up on.
 */
export async function bodyIndexState(env: Env): Promise<Record<BodyIndexState, number>> {
  const rows = await env.CATALOG.prepare(
    `SELECT body_index_state AS state, COUNT(*) AS n FROM messages
      WHERE blob_key IS NOT NULL GROUP BY body_index_state`,
  ).all<{ state: string; n: number }>();
  const counts: Record<BodyIndexState, number> = {
    pending: 0, indexed: 0, empty: 0, unindexable: 0, retryable: 0,
  };
  for (const row of rows.results) {
    if (row.state in counts) counts[row.state as BodyIndexState] = Number(row.n);
  }
  return counts;
}

/**
 * The messages an operator would repair, newest first, with why each failed.
 *
 * Bounded, and returning the reason: "eleven messages failed" is a number nobody can act on. The repair path
 * takes message ids, so this is what a caller passes to it — which is the difference between a diagnostic and
 * a `wrangler d1 execute` an operator has to compose themselves.
 */
export async function failedBodyIndex(
  env: Env,
  orgId: string,
  limit: number,
): Promise<{ messageId: string; state: string; attempts: number; error: string | null }[]> {
  const rows = await env.CATALOG.prepare(
    `SELECT id, body_index_state AS state, body_index_attempts AS attempts, body_index_error AS error
       FROM messages
      WHERE org_id = ? AND body_index_state IN ('unindexable', 'retryable')
      ORDER BY received_at DESC LIMIT ?`,
  ).bind(orgId, limit).all<{ id: string; state: string; attempts: number; error: string | null }>();
  return rows.results.map((row) => ({
    messageId: row.id, state: row.state, attempts: Number(row.attempts), error: row.error,
  }));
}
