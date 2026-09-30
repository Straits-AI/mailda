import { BUDGETS } from "@mailda/budgets";
import { SEARCH_MAX_WORDS } from "@mailda/contract/routes";

import { unprocessable } from "./errors.ts";

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

/*
 * ## Chinese, Japanese and Korean, and why the index does not hold what `unicode61` would make of them
 *
 * `unicode61` splits on everything that is not a letter or a number, and nothing else. English puts a space
 * between words, so that is a word tokenizer for English. Chinese and Japanese put no space between words, so
 * for them it is a **sentence** tokenizer: `关于发票的问题` ("a question about the invoice") is one token, and
 * a search for `发票` ("invoice") found nothing — on every Node receiving Chinese mail, silently. `订单123` was
 * one token too, so `123` did not find it, and full-width `ＡＢＣ` was not folded to `abc`.
 *
 * So the text is rewritten before `unicode61` sees it, **identically on both sides**: `searchText` for every
 * indexed column, and `ftsQuery` for the typing. The rewrite is:
 *
 * 1. **NFKC, inside words.** Full-width Latin and digits become ASCII (`ＡＢＣ１２３` → `ABC123`), half-width
 *    katakana becomes full-width, compatibility ideographs become the unified ones. Only runs of letters, marks
 *    and numbers are folded (`FOLDED_RUN`), never the symbols between them: NFKC turns `™` into `TM` and `№`
 *    into `No`, which `unicode61` would then join to the word beside them, so `Acme™ widget` would stop
 *    matching `acme` — a symbol `unicode61` has always split on stays a separator, `㈱` included. Stable across
 *    runtime updates for every character assigned when it was indexed: Unicode's normalization stability
 *    policy forbids changing an assigned character's decomposition.
 * 2. **Every CJK run becomes overlapping bigrams**, `发票抬头` → `发票 票抬 抬头 头`, and every other run of
 *    letters and numbers is left exactly as it was, so English tokenises as it always did.
 *
 * Bigrams because any substring of two or more characters is then a sequence of consecutive bigrams, which an
 * FTS5 phrase matches, and a single character is the start of some token. No dictionary and no segmenter, so
 * the tokens a row was indexed with next year are the tokens it was indexed with today. Rejected:
 *
 * - **the `trigram` tokenizer**: a two-character word — most Chinese words — has no trigram and never matches;
 * - **`Intl.Segmenter`**: ICU's dictionary changes with the runtime, so a row indexed under one runtime and
 *   searched under the next would disagree about where the words are, and nothing would say so.
 *
 * ### The trailing single character
 *
 * A run's last character also stands alone (`头` above). Without it the last character of a run begins no
 * token, so a search for `题` — the last character of `关于发票的问题` — could match nothing: a prefix query
 * finds tokens that *start* with what was typed, and FTS5 has no suffix query. One token per run is the cost.
 *
 * ### Which characters, and why runs break between scripts
 *
 * Han, kana (Hiragana and Katakana together) and Hangul, by `Script_Extensions`, and only among characters
 * that are letters or numbers — the same set `unicode61` keeps as token characters, so `・` and `゛` stay
 * separators. `Script_Extensions` rather than `Script` because `ー` (the long-vowel mark) and `々` (the
 * iteration mark) are `Common` by `Script` and would split `コーヒー` and `時々` into fragments. Hiragana and
 * Katakana are one class because `ー` belongs to both and `らーめん` is one word.
 *
 * Runs break where the class changes, which in Japanese is roughly where the words change (`東京` | `タワー`).
 * Nothing is lost by it: the break is the same on both sides, and the trailing single character is what lets
 * a search cross it (`京タ` is `京` then a token starting `タ`).
 *
 * Not included, and known: Thai, Lao, Khmer and Myanmar are also written without spaces, and their vowel
 * signs are combining marks that `unicode61` treats as separators — so a code-point bigram there would be a
 * bigram of fragments. That is its own design, measured on its own text, and not this one.
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
 * One run of a single CJK class, among letters and numbers. The alternation is the class: at each position
 * the first alternative that matches wins and runs as far as its class does, so `東京タワー` is two matches.
 */
const CJK_RUN = new RegExp(
  [
    String.raw`(?:(?=[\p{L}\p{N}])\p{scx=Han})+`,
    String.raw`(?:(?=[\p{L}\p{N}])[\p{scx=Hiragana}\p{scx=Katakana}])+`,
    String.raw`(?:(?=[\p{L}\p{N}])\p{scx=Hangul})+`,
  ].join("|"),
  "gu",
);

/**
 * What NFKC is applied to: runs of letters, marks and numbers. `TOKEN` plus marks, so a decomposed accent is
 * composed with its letter (`cafe\u0301` → `café`) as whole-text NFKC did, while the symbols and punctuation
 * between words, which `unicode61` splits on, are left as they are.
 */
const FOLDED_RUN = /[\p{L}\p{M}\p{N}]+/gu;

function folded(text: string): string {
  return text.replace(FOLDED_RUN, (run) => run.normalize("NFKC"));
}

/** Overlapping pairs, `发票抬头` → `发票 票抬 抬头`. A single character has none. */
function bigrams(characters: readonly string[]): string[] {
  return characters.slice(1).map((character, index) => characters[index] + character);
}

/** A whole run as the index holds it: its bigrams and its last character, or the one character it is. */
function runTerms(run: string): string[] {
  const characters = [...run];
  return characters.length === 1 ? characters : [...bigrams(characters), characters.at(-1)!];
}

/**
 * Text as the index holds it: every indexed column of both search tables goes through this, and so does a
 * query (`ftsQuery`), which is the whole guarantee — the two sides cannot tokenise the same words differently
 * because there is one function.
 *
 * Spaces around each rewritten run, so `订单123` becomes `订单 单 123` and `123` is a token of its own.
 */
export function searchText(text: string): string {
  return folded(text).replace(CJK_RUN, (run) => ` ${runTerms(run).join(" ")} `);
}

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
  const words = [...folded(raw).matchAll(TOKEN)].map((match) => match[0]);
  if (words.length === 0) return null;
  /*
   * `SEARCH_MAX_WORDS` is the contract's, which states it on `q`. Refused rather than truncated: truncating
   * answered a different question from the one asked — the thirteenth word was dropped, so mail lacking it
   * matched, and the page did not say so. AGENTS.md §3: a limit somebody can hit is one they must see.
   */
  if (words.length > SEARCH_MAX_WORDS) {
    throw unprocessable("E_SEARCH_TOO_MANY_WORDS", {
      what: `this search has ${words.length} words, and one search may carry at most ${SEARCH_MAX_WORDS}`,
      why: "every word must appear, so each is a separate lookup in the index; dropping the extra words would "
        + "answer with mail that lacks them, and the page could not say which were ignored",
      fix: `search with the ${SEARCH_MAX_WORDS} most distinctive of them. A run of Chinese, Japanese or Korean `
        + "without spaces counts as one word",
    });
  }

  /*
   * Every word becomes one quoted phrase, and the last one gains a `*`.
   *
   * Quoted because a bare token is parsed as the expression language — that is the whole finding above. No
   * escaping of the quote is needed and none is done: `TOKEN` admits only letters and numbers, so a `"` can
   * never be inside one, and neither can the spaces `phrase` puts between the terms it emits. That is a
   * property of the extraction rather than a promise, which is why the extraction is a whitelist.
   *
   * The trailing `*` on the last word only. `"demur"*` was measured to match *demurrage*, so a search
   * narrows while somebody is still typing the word they are part-way through. Applying it to every word
   * would make `inv 44` match far more than a person means, and applying it to none would mean a search for a
   * half-typed word finds nothing until the moment it is complete — which reads as "no such mail".
   */
  const phrases = words.map((word, index) => phrase(word, index === words.length - 1));

  /*
   * The word limit counts words **typed**, and a Chinese, Japanese or Korean run is one word however long, so it
   * does not bound the index terms: a pasted paragraph without spaces was one phrase with a term per character,
   * bounded by nothing but the URL. Each term is its own lookup and a search's time grows with them, linearly,
   * without showing in rows read (FTS5's doclist reads are not rows) — measured in
   * `docs/receipts/cjk-search-bigrams.md`, which sizes the limit so that a search at it costs no more than the
   * commonest one-character search the same receipt already accepts.
   */
  const terms = phrases.reduce((n, one) => n + one.split(" ").length, 0);
  const limit = BUDGETS["search.max_query_terms"];
  if (terms > limit) {
    throw unprocessable("E_SEARCH_TOO_LONG", {
      what: `search.max_query_terms=${limit}, this search asked for ${terms}: each character of a Chinese, `
        + "Japanese or Korean run is about one index term, and every other word is one",
      why: "every term is a separate lookup in the index and a search's time grows with them; the limit is where "
        + "the costliest search of that many terms was measured to cost no more than the commonest one-character search",
      fix: `search with a shorter part of the text, at most about ${limit} characters of it. To raise the limit, `
        + "remeasure docs/receipts/cjk-search-bigrams.md, then pnpm receipts",
    });
  }
  return phrases.join(" ");
}

/**
 * One typed word as a phrase over the index's terms.
 *
 * A phrase matches **consecutive** tokens, which is what keeps a CJK search a substring search: `发票抬` is
 * `"发票 票抬"`, and a row holding `发票` and `票抬` far apart does not match it.
 *
 * The word is split where `searchText` splits it — CJK runs by class, everything else left whole — and each
 * piece contributes the terms the index would hold for it, with one difference at the **end**. A piece in the
 * middle of the word is a whole run in the indexed text too (it is bounded by class changes on both sides),
 * and so is the first, up to where it starts; both take `runTerms`, trailing character included, because the
 * index has that character right there. The last piece may stop part-way through a longer indexed run, so it
 * takes only its bigrams — and a single character, which in the index is only ever the start of a token, is
 * matched as a prefix whatever its position, or `发 问题` would never find `关于发票的问题`.
 */
function phrase(word: string, last: boolean): string {
  const terms = searchText(word).trim().split(/\s+/);
  const tail = [...word.matchAll(CJK_RUN)].at(-1);
  const endsInRun = tail !== undefined && tail.index + tail[0].length === word.length;
  const single = endsInRun && [...tail[0]].length === 1;
  // `searchText` gave the last run its trailing character; the typed run may stop part-way through a longer
  // indexed one, so that character is taken back off. A single character has no bigram to stand for it.
  if (endsInRun && !single) terms.pop();
  return `"${terms.join(" ")}"${last || single ? "*" : ""}`;
}

/**
 * The day token, as SQL over a receipt's `accepted_at` (#153).
 *
 * **One spelling, used by every writer** — `indexMessage` and `indexBody`, which the ingress path and both
 * backfills go through, and the migration that rebuilt the table — because a token computed several ways is a
 * token that eventually disagrees with itself. A row whose day differs by one character is a row no window matches, and
 * nothing would report it: the search would simply not return that message.
 *
 * `accepted_at` and not `sent_at`, matching the listing's window. Two features that windowed by different
 * clocks would disagree about which mail is in a range, and `sent_at` is the sender's claim.
 */
export const DAY_TOKEN_SQL = "'d' || replace(substr(%s, 1, 10), '-', '')";

/** The same token in TypeScript, for a query building a window rather than writing a row. */
export function dayToken(instant: string): string {
  return `d${instant.slice(0, 10).replaceAll("-", "")}`;
}

/**
 * Every day a window covers, as the token set a MATCH filters on.
 *
 * Inclusive of both ends, and **bounded**: `messages.search_window_max_days` caps how many tokens one query
 * may carry, because the `OR` list is the query's own size and an unbounded window would build a MATCH
 * expression proportional to the archive's age.
 */
export function daysAcross(from: string, to: string): string[] {
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`);
  const end = Date.parse(`${to.slice(0, 10)}T00:00:00.000Z`);
  const days: string[] = [];
  for (let at = start; at <= end; at += 24 * 60 * 60 * 1000) {
    days.push(dayToken(new Date(at).toISOString()));
  }
  return days;
}

/**
 * The form the index rows are written in, recorded per message as `search_index_form` and `body_index_form`
 * (`migrations/0071_search_form.sql`).
 *
 * **Bump it whenever what `searchText` makes of some text changes**, and nothing else: every writer stamps it,
 * both backfills re-form whatever is below it, and `doctor`'s `search_index_backlog` and `body_index_backlog`
 * count what is left. `0` is every form before `searchText` existed, and it is the column default, so code that
 * does not know the column (the version still serving during a deploy, or one rolled back to) leaves its rows
 * marked old, whichever order the code and the migration arrive in.
 *
 * 1: NFKC inside runs of letters, marks and numbers, and CJK runs as overlapping bigrams plus the last
 *    character (30 September 2026).
 */
export const SEARCH_FORM = 1;

/**
 * The index row for a message, and its form stamp, as statements to put in the **same batch** as the message.
 *
 * ## Selected from the row, so no index row can point at nothing
 *
 * `INSERT … SELECT … FROM messages WHERE id = ?`, and the reason is a trap in the caller. `materialise.ts`
 * writes the message with `INSERT OR IGNORE`, against `msg_by_receipt UNIQUE (ingress_receipt_id)` — so a
 * redelivery mints a fresh `msg_…` id, the insert is **ignored**, and that id belongs to no row.
 *
 * A search insert of its own values would happily write an index entry for that id: an entry pointing at a
 * message that does not exist, which no message deletion will ever remove because there is no message to
 * delete. The orphaned-index-row failure, arriving on the most ordinary event in a mail system.
 *
 * Selecting from `messages` makes it structurally impossible. If the message row was not created, the
 * `SELECT` returns nothing and the `INSERT` writes nothing — the two statements agree because one reads the
 * other, in one batch, in one transaction.
 *
 * ## The text is bound, because SQL cannot compute it — and it is checked against the row
 *
 * The indexed text is `searchText` of the subject and sender, which is JavaScript, so it arrives as bound
 * values rather than as `m.subject` (it used to be `m.subject`, and the index "never had its own opinion"
 * about what the subject was). The caller passes the **same values** it wrote, and the statement keeps the
 * old property by comparing them with the row: `m.subject IS ? AND m.from_addr IS ?`. A caller handing over
 * text the row does not hold writes nothing — and the stamp below is under the same predicate, so that
 * message stays below `SEARCH_FORM`, which is exactly what the backfill looks for and `doctor` counts: the
 * disagreement repairs itself from the row rather than persisting.
 *
 * ## The stamp is a second statement under the same predicate
 *
 * `message_search` is a virtual table, and SQLite allows no trigger on one, so the insert cannot stamp
 * `messages` itself. The `UPDATE` repeats the insert's whole predicate, receipt join included, so it lands
 * exactly where the insert did: a stamp without a row would hide a message from the backfill for good, and
 * a row without a stamp costs one rewrite.
 *
 * The stored `subject` column therefore holds the bigrammed form. Nothing reads it back: every query reads
 * `m.subject`, and no search excerpt (`snippet()`) is built from this table.
 */
export function indexMessage(
  env: Env,
  messageId: string,
  /** What the `messages` row holds — the values the caller wrote, or read from it. */
  row: { readonly subject: string | null; readonly from: string | null },
): [D1PreparedStatement, D1PreparedStatement] {
  return [
    env.CATALOG.prepare(
      `INSERT INTO message_search (subject, from_addr, day, message_id, org_id)
       SELECT ?, ?, ${DAY_TOKEN_SQL.replace("%s", "r.accepted_at")}, m.id, m.org_id
         FROM messages m
         JOIN ingress_receipts r ON r.id = m.ingress_receipt_id
        WHERE m.id = ? AND m.subject IS ? AND m.from_addr IS ?`,
    ).bind(
      row.subject === null ? null : searchText(row.subject), row.from === null ? null : searchText(row.from),
      messageId, row.subject, row.from,
    ),
    env.CATALOG.prepare(
      `UPDATE messages SET search_index_form = ?
        WHERE id = ? AND subject IS ? AND from_addr IS ?
          AND EXISTS (SELECT 1 FROM ingress_receipts r WHERE r.id = messages.ingress_receipt_id)`,
    ).bind(SEARCH_FORM, messageId, row.subject, row.from),
  ];
}

/**
 * Re-forms the subject rows of messages that already have one: their old rows out, and `indexMessage` for each.
 *
 * ## One delete for the set, because each lookup by message is a scan
 *
 * `message_id` is `UNINDEXED` in FTS5, so FTS5 cannot seek on it: measured under vitest-pool-workers on 3,000
 * rows, one lookup by `message_id` reads 3,000 rows and one `DELETE … IN (json_each(500 ids))` reads 3,490.
 * So the old rows of a whole set go in one statement, and a caller that re-forms 149 messages pays one scan,
 * not 149. The subject index has no key the delete could use instead: its rowid is FTS5's own, assigned at
 * insert, and the old code keeps assigning them while it serves.
 *
 * The delete comes **first** and in the same batch, so there is no moment in which a message has both rows
 * and none in which it has neither. A message with no row yet (mail from before the index) deletes nothing.
 */
export function reindexMessages(
  env: Env,
  rows: readonly { readonly id: string; readonly subject: string | null; readonly from: string | null }[],
): D1PreparedStatement[] {
  return [
    env.CATALOG.prepare(
      "DELETE FROM message_search WHERE message_id IN (SELECT value FROM json_each(?))",
    ).bind(JSON.stringify(rows.map((row) => row.id))),
    ...rows.flatMap((row) => indexMessage(env, row.id, row)),
  ];
}

/**
 * A body as the body index binds it: `searchText`, cut to what D1 accepts as one bound string, and whether it was.
 *
 * `extractBody` bounds a body at `render.max_body_bytes` **UTF-16 units**, which is a display bound and was
 * never a D1 one. A Chinese body at that bound is already 3.1 MB of UTF-8 and the bigrams double it to 6.4 MB
 * (`test/message-search-cjk.measure.test.ts`), against `d1.max_row_bytes` of 2,000,000 — D1's limit on one
 * string, bound parameters included (a platform limit: `docs/receipts/d1-platform-limits.md`). `indexBody`
 * rides in the **ingest** batch, so a value past it would fail the batch that materialises the message: a long
 * Chinese body would make its whole message not arrive.
 *
 * So the text is cut at the last whole term before the limit, and the index holds the body's first two
 * megabytes of terms. Words past that point cannot be found, which a searcher cannot see from the page — so the
 * cut is **returned**, not only made: `cutFromBytes` is the whole text's size, `settleBodyIndex` records it on
 * the message (`body_index_cut_from_bytes`), and `doctor`'s `body_index_partial` counts those messages and
 * names the limit. `null` when nothing was cut.
 */
export function bodyIndexText(body: string): { readonly text: string; readonly cutFromBytes: number | null } {
  const text = searchText(body);
  const limit = BUDGETS["d1.max_row_bytes"];
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= limit) return { text, cutFromBytes: null };
  // Decoding a prefix can end in half a character, which decodes as U+FFFD; the partial term goes with it.
  const prefix = new TextDecoder().decode(bytes.subarray(0, limit));
  return { text: prefix.slice(0, Math.max(0, prefix.lastIndexOf(" "))), cutFromBytes: bytes.byteLength };
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
 * The body text comes from the parsed message rather than from a column, so the value is bound — as
 * `bodyIndexText`'s text, the form every search reads, which the caller computes once because the settlement
 * records its cut — but the *rowid* is still selected from `messages`, which keeps the property that made
 * `indexMessage` safe: if the message row was not created, the `SELECT` returns nothing, the `INSERT` writes nothing, and no index row
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
  /** `bodyIndexText(body)`: the same value whose `cutFromBytes` the `indexed` settlement records. */
  indexed: ReturnType<typeof bodyIndexText>,
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
    /*
     * The day comes from the receipt (#153), so a body row can be narrowed by a window the same way a
     * subject row can. Without it a windowed search would match subjects and silently miss bodies — which is
     * why 0054 puts every message back in this queue rather than leaving old rows tokenless.
     */
    `INSERT OR REPLACE INTO message_body_search (rowid, body, day)
     SELECT m.rowid, ?, ${DAY_TOKEN_SQL.replace("%s", "r.accepted_at")}
       FROM messages m
       JOIN ingress_receipts r ON r.id = m.ingress_receipt_id
      WHERE m.id = ? AND m.body_index_attempt_version = ?`,
  ).bind(indexed.text, messageId, version);
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
 *
 * Every terminal outcome also stamps `body_index_form` with `SEARCH_FORM`, under the same compare-and-swap as
 * the rest, so the stamp belongs to the claim whose batch wrote (or found nothing to write). A claim moving the
 * version clears it (0071's trigger), so an attempt that settles without stamping — the old code's, while it
 * still serves — leaves the message marked old and the backfill re-forms it. `retryable` stamps nothing: it
 * wrote nothing, and whatever row the message had is as old as it was.
 *
 * `indexed` carries the cut, required rather than optional for the version's reason below: the caller that
 * bound `bodyIndexText` is the only one that knows whether it cut, and forgetting to pass it would make the
 * cut silent again. It is written on every terminal outcome (`NULL` for the ones that wrote no row), so a
 * message that was cut once and re-indexed whole does not keep reporting a cut.
 */
export function settleBodyIndex(
  env: Env,
  messageId: string,
  outcome:
    | { state: "indexed"; cutFromBytes: number | null }
    | { state: "empty" }
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
            body_indexed_at = ?, body_index_lease_until = NULL,
            body_index_form = ?, body_index_cut_from_bytes = ?
      WHERE id = ? AND body_index_attempt_version = ?`,
  ).bind(
    outcome.state, outcome.state === "unindexable" ? outcome.error : null, at,
    SEARCH_FORM, outcome.state === "indexed" ? outcome.cutFromBytes : null, messageId, version,
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
 * Puts up to `limit` bodies indexed in an older form back in the queue, for the claim that follows.
 *
 * The same reset `repairBodyIndex` and 0054 make, minus the delete: the old row **stays** until `indexBody`'s
 * `INSERT OR REPLACE` on the rowid swaps it for the current form. What it answers meanwhile is less than it
 * answered under the old code: its words in Latin and other spaced scripts, and a Chinese, Japanese or Korean
 * search only when that is a run's first one or two characters (the query bigrams what the old row kept as one
 * token), and no full-width text. Dropping it first would lose the Latin words too, for as long as the backfill
 * takes to arrive, which at 25 a minute is hours on a long archive.
 *
 * Bounded, and run every pass rather than once by a migration, because the old rows are not only the ones that
 * existed when 0071 ran: the version still serving during a deploy, or one rolled back to, writes old-form rows
 * afterwards (`migrations/0071_search_form.sql`). The version bump invalidates any claim already running on
 * one, and the range of `msg_body_index_form` it seeks is empty on a Node that has caught up.
 *
 * One disagreement is left and is stated rather than hidden: a requeued message whose evidence now fails to
 * read six times is settled `unindexable` while its old row still answers its Latin words.
 */
export function requeueOlderBodyForm(env: Env, limit: number): D1PreparedStatement {
  return env.CATALOG.prepare(
    `UPDATE messages
        SET body_index_state = 'pending', body_index_attempts = 0, body_index_error = NULL,
            body_index_next_attempt_at = NULL, body_indexed_at = NULL, body_index_lease_until = NULL,
            body_index_attempt_version = body_index_attempt_version + 1
      WHERE id IN (
        SELECT id FROM messages
         WHERE body_index_state = 'indexed' AND body_index_form < ? AND blob_key IS NOT NULL
         LIMIT ?
      )`,
  ).bind(SEARCH_FORM, limit);
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
              body_index_lease_until = NULL, body_index_cut_from_bytes = NULL,
              body_index_attempt_version = body_index_attempt_version + 1
        WHERE org_id = ? AND id IN (${placeholders})`,
    ).bind(orgId, ...messageIds),
  ];
}

/**
 * How many messages the subject index has not written in the current form — the number `doctor` reports.
 *
 * That is two kinds of message, and `doctor` says so: one with no row at all (mail from before the index) is
 * not found by its subject, and one with an older-form row (indexed before `SEARCH_FORM`, or by the version
 * still serving during a deploy) is found by its Latin words, and by a Chinese, Japanese or Korean search only
 * when that is a run's first one or two characters. Telling them apart would need a lookup by `message_id`, which FTS5 answers with a scan.
 *
 * Counted rather than inferred from whether a backfill pass wrote anything, because "the last pass indexed
 * nothing" is true both when the backfill is complete and when it is broken. Those need to look different.
 *
 * It was `NOT EXISTS (SELECT 1 FROM message_search s WHERE s.message_id = m.id)`, one FTS5 scan per message:
 * 4,501,455 rows read for one count on 3,000 messages (`migrations/0071_search_form.sql`). This reads the
 * backlog's entries in `msg_search_index_form` and nothing else.
 */
export async function searchIndexBacklog(env: Env): Promise<number> {
  const row = await env.CATALOG.prepare(
    "SELECT count(*) AS n FROM messages WHERE search_index_form < ?",
  ).bind(SEARCH_FORM).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * What the body index has and has not reached, by state — and, of the `indexed`, how many are in an older form
 * and how many hold only part of their body.
 *
 * One query rather than several, because `doctor` reports on a subrequest budget it has to report on — and a
 * caller asking several times could see counts from different moments. The two extra figures are sums over the
 * same groups, so they cost no subrequest (`docs/receipts/doctor-check-cost.md` records the precedent).
 *
 * This replaced `unindexedBodies`, which counted `body_indexed_at IS NULL` and therefore answered one
 * question — "how much is left" — for a design that now has three different answers behind it: not reached,
 * failing and retrying, and given up on.
 *
 * - `olderForm`: `indexed` below `SEARCH_FORM`. Found by its Latin words, and by CJK only as a run's first one or
 *   two characters; waiting for the re-form requeue.
 * - `cut`, `cutLargestBytes`: messages whose indexed text was longer than one D1 string, and the largest such
 *   text. Counted in any state, because the column describes the row the message has, and a cut message that
 *   has been requeued keeps its cut row until the backfill replaces it.
 */
export async function bodyIndexState(env: Env): Promise<
  Record<BodyIndexState, number> & { olderForm: number; cut: number; cutLargestBytes: number | null }
> {
  const rows = await env.CATALOG.prepare(
    `SELECT body_index_state AS state, COUNT(*) AS n,
            SUM(body_index_form < ?) AS older,
            COUNT(body_index_cut_from_bytes) AS cut, MAX(body_index_cut_from_bytes) AS largest
       FROM messages
      WHERE blob_key IS NOT NULL GROUP BY body_index_state`,
  ).bind(SEARCH_FORM).all<{ state: string; n: number; older: number; cut: number; largest: number | null }>();
  const counts = {
    pending: 0, indexed: 0, empty: 0, unindexable: 0, retryable: 0,
    olderForm: 0, cut: 0, cutLargestBytes: null as number | null,
  };
  for (const row of rows.results) {
    if (row.state in counts) counts[row.state as BodyIndexState] = Number(row.n);
    if (row.state === "indexed") counts.olderForm = Number(row.older);
    counts.cut += Number(row.cut);
    if (row.largest !== null) counts.cutLargestBytes = Math.max(counts.cutLargestBytes ?? 0, Number(row.largest));
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
