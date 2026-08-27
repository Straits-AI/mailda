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
export function indexBody(env: Env, messageId: string, body: string): D1PreparedStatement {
  return env.CATALOG.prepare(
    `INSERT OR REPLACE INTO message_body_search (rowid, body)
     SELECT rowid, ? FROM messages WHERE id = ?`,
  ).bind(body, messageId);
}

/**
 * Marks the body index as finished with a message, whether or not it produced a row.
 *
 * Separate from `indexBody` and always issued, which is the point: a message with no readable body gets this
 * and no index row, and that is the only way the backfill can tell *"not reached yet"* from *"reached, and
 * there was nothing there"*. Without it the empty-body case is selected by every pass forever and the backlog
 * figure never reaches zero — reporting outstanding work that no amount of work removes.
 */
export function markBodyIndexed(env: Env, messageId: string, at: string): D1PreparedStatement {
  return env.CATALOG.prepare("UPDATE messages SET body_indexed_at = ? WHERE id = ?").bind(at, messageId);
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

/** How many messages the body index has not reached — the number `doctor` reports. */
export async function unindexedBodies(env: Env): Promise<number> {
  const row = await env.CATALOG.prepare(
    "SELECT count(*) AS n FROM messages WHERE body_indexed_at IS NULL AND blob_key IS NOT NULL",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}
