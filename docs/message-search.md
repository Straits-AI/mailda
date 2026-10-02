# Searching mail

How a search narrows this Node's listing, what it costs, what it refuses, and the one release step a windowed
search needs.

Implemented by `apps/node/worker/src/search.ts` (the indexes and their writers), `src/search-backfill.ts`
(the body pass), and `messagePageQuery` in `src/authz-read.ts` (the query). Migrations
`0040_message_search.sql`, `0041_body_search.sql`, `0044_body_index_state.sql`,
`0048_body_index_lease.sql`, `0054_search_day_token.sql` and `0071_search_form.sql`. Decision record: [#107][107] for the search,
[#153][153] for the date window.

## Two indexes, authorized differently

| index | holds | authorized by |
|:--|:--|:--|
| `message_search` | subject and sender, stored | `metadata.read` or `content.read` |
| `message_body_search` | a term index of the body, **contentless** | `content.read` only |

A searched page is the union of two arms, each driven by its own virtual table, each ranked and capped. They
are separate because a grant of scope `metadata` must reach the subject index and **not** the body one. A
person permitted to see who wrote and what about is not thereby permitted the text.

`message_body_search` is `content = ''`, so it stores no body text as such. It is not a bag of words either:
the table is `detail=full`, FTS5's default, so it keeps each token's offset and `fts5vocab`'s `instance` view
reads a body back as its tokens in order (`docs/receipts/d1-fts5-search.md`, corrected 30 September 2026). For
Chinese, Japanese and Korean, whose runs are indexed as bigrams, that is the text. Kept deliberately: the owner chose
`detail=full` on 2 October 2026 (ADR 28), because dropping offsets would end phrase search and with it CJK search. The contentless form has a
consequence worth knowing: the index yields no excerpt (`snippet()` returns null on a contentless table rather
than failing), so showing the matching line would mean fetching the message from R2 and decrypting it, which
is a `mailbox.content.read` operation and is authorized as one. A result row may carry the message's stored
preview (ADR 45), which is the start of the body rather than the matching line, sealed under the content key and
opened only for readers with standing content read, exactly as every listing row does.

## What a word is, in any script (search form 1)

`unicode61` splits on everything that is not a letter or a number. That is a word tokenizer for text written
with spaces and a *sentence* tokenizer for Chinese and Japanese, so before `searchText` `关于发票的问题` was one token and
a search for `发票` found nothing; `订单123` was one token, so `123` did not find it; full-width `ＡＢＣ` was not
`abc`. Every indexed text (subject, sender, body) and every query now goes through one function,
`searchText` in `src/search.ts`:

- **NFKC inside words** (runs of letters, marks and numbers), so full-width Latin and digits, half-width katakana
  and compatibility ideographs fold to one form, while the symbols between words stay the separators
  `unicode61` has always split on: NFKC of the whole text made `Acme™` `AcmeTM` and `№5` `No5`, and `acme` and
  `5` stopped finding them (`㈱` stays a separator for the same reason);
- **every run of Han, kana or Hangul as overlapping bigrams plus its last character** (`发票抬头` → `发票 票抬
  抬头 头`); runs break where the script class changes (`東京` | `タワー`);
- everything else exactly as before, so English tokenises as it always did.

A typed run becomes one **phrase** of its bigrams, so the characters must be adjacent, and a single typed
character is a prefix of the bigrams it begins. No dictionary and no `Intl.Segmenter`: a segmenter's
dictionary moves with the runtime, and a row indexed under one runtime would stop matching under the next.
The `trigram` tokenizer was rejected because a two-character word, which is most Chinese words, has no
trigram. Not covered: Thai, Lao, Khmer and Myanmar are also written without spaces and are not rewritten.

What it costs is in [`cjk-search-bigrams`](receipts/cjk-search-bigrams.md): 3.8 times the posting bytes on
Chinese prose, none on English, and a full page of a common Chinese term at 941 rows read against the
1,000-row budget. A body's rewritten text is cut at `d1.max_row_bytes` (2,000,000 bytes, one D1 string: a
platform limit, [`d1-platform-limits`](receipts/d1-platform-limits.md)), because the write rides in the ingest
batch and a longer value would fail the message's arrival. The words past the cut are not searchable, and the
cut is recorded: `messages.body_index_cut_from_bytes` holds the size of the whole text, and `doctor`'s
`body_index_partial` counts those messages and names the limit, the largest size and what cannot be found.

**A search carries at most `SEARCH_MAX_WORDS` (12) words**, counted as typed: a run without spaces is one.
More is refused with `E_SEARCH_TOO_MANY_WORDS`, naming both numbers. It used to truncate, which silently
answered a search that ignored the extra words. The number is sized, not measured.

**And at most `search.max_query_terms` (128) index terms in all**, because the word limit does not bound them: a
pasted paragraph without spaces is one word and a phrase of a term per character. Each term is a lookup and a
search's time grows with them without showing in rows read (FTS5's doclist reads are not rows), so the limit is
sized by time: at 128 terms the worst phrase on the measured corpus costs no more than the commonest one-character
search ([`cjk-search-bigrams`](receipts/cjk-search-bigrams.md)). More is refused with `E_SEARCH_TOO_LONG`, naming
the budget, the limit and the terms asked for.

### Re-indexing an existing Node, while the previous version is still writing

Every message records the form its index rows were written in: `search_index_form` for the subject index and
`body_index_form` for the body index (0071, expand-only). The current form is `SEARCH_FORM` in `src/search.ts`;
`0`, the column default, is every form before `searchText`. The writers stamp it (`indexMessage` in the
statement after its insert, under the same predicate; `settleBodyIndex` under the claim's compare-and-swap),
and the backfills select by it rather than by "has no row":

- **Subjects**: `backfillSearchIndex` takes up to 500 messages below `SEARCH_FORM` a minute, deletes whatever
  row each has and writes the current one through `indexMessage`, 149 to a batch. A message waiting has its old
  row meanwhile, and the new query finds less in it than the old one did: its words in Latin and other spaced
  scripts, a Chinese, Japanese or Korean search only when that is a run's first one or two characters (the query
  bigrams the rest, and a phrase of bigrams never equals the one token the old row holds), and no full-width
  text. One never indexed is not found by its subject. `search_index_backlog` counts both in one number and
  names both.
- **Bodies**: each body pass first requeues up to 25 `indexed` bodies below `SEARCH_FORM`, then claims as
  before. The old row **stays** until `indexBody` replaces it, so its Latin words are still found, and its CJK
  text only as a run's first one or two characters, as for subjects. `body_index_backlog` counts the queue and
  the not-yet-requeued separately. A requeued message whose evidence then fails to read six times is settled
  `unindexable` while its old row still answers its Latin words — a disagreement named here rather than fixed.

**Why the order does not matter.** `mailda deploy` applies migrations before it uploads the canary, so the
previous version keeps serving, and writing index rows, after 0071 until promotion, and again after any
rollback. That code knows nothing of the form columns, so every row it writes is on a message left at `0`, and
the backfills re-form it. Its one re-indexing path, the body backfill, bumps `body_index_attempt_version` when
it claims; a trigger on that bump (`msg_body_index_form_claimed`) sets the stamp back to `0`, so an old-form
body written over a current one is caught too. The subject index needs no trigger: the old code writes a
subject row only for mail it has just accepted or mail with no row. 0071 is additive, so `mailda deploy`
applies it without `--contract`, ahead of the code that uses it; like every expansion it must come first, since
the new code's stamps name its columns (a hand `wrangler deploy` before the migration would fail ingest). A later change to `searchText` is a bump of
`SEARCH_FORM` and no migration.

**After a rollback, the mirror image, and nothing repairs it backwards.** The previous version's query is one
prefix token per typed word (`"关于发"*`), and a row this version wrote holds bigrams, so the previous version
finds form-1 rows by their Latin words and by CJK searches of one or two characters, and not by longer CJK
searches or full-width typing, until the code rolls forward. The rows it writes meanwhile are form 0 and are
re-formed then. "The order does not matter" above is about the rows being re-formed, not about what a search
finds while two forms are in the index.

**Restoring from a backup.** The dump carries the form stamps and not the indexes (an fts5 table cannot be
exported), so `mailda backup` ends its dump by setting both stamps back to `0` (`searchIndexReset` in
`packages/cli/src/backup.mjs`), and the restored Node's backfills rebuild both indexes from the evidence while
`doctor` counts down. Without it they would select nothing and `doctor` would call both indexes complete.

**Subjects and senders stored before 30 September 2026 keep the old decoder's reading.** `decodeEncodedWords`
now joins adjacent encoded words, so a subject folded into several words no longer reads back with a space at
each fold, nor with a pair of U+FFFD where a sender split a character across two words. That applies to mail
received from now on. `messages.subject` and `from_name` are decoded once at arrival and the subject backfill
re-indexes the stored column, so older mail keeps its spaces and replacement characters, and a CJK search that
spans one of those folds does not find it. Re-deriving them needs one R2 read per message of the archive, since
which subjects were folded is not visible in the column; not done.

**Cost.** Both selections are indexed ranges (`msg_search_index_form`, `msg_body_index_form`), empty on a Node
that has caught up. They replaced `NOT EXISTS (… message_search s WHERE s.message_id = m.id)`, which FTS5
answers with a scan of the index per message (`message_id` is `UNINDEXED`): measured under vitest-pool-workers
on 3,000 messages, **4,501,465 rows read** per subject pass and 4,501,455 per `doctor` count, every minute on a
caught-up Node. What re-forming costs instead is the old rows' delete, one scan of the subject index per batch
of 149 (3,490 rows read for 500 ids on 3,000 rows, same harness): about N²/149 rows over the whole catch-up of
N messages, once per bump of `SEARCH_FORM`. Local figures, not production D1.

## A searched page is ranked and capped, and has no cursor

Ordered by `bm25` rank, capped at one page, and `next_cursor` is always null. That is a property of the
ordering rather than a limitation anybody settled for. Rank depends on corpus-wide term frequency, so it
shifts every time mail arrives, which in a mail system is continuously, and a cursor into a ranked list
would skip and repeat rows **silently**.

So a search answers one page of the best matches and says so. Narrowing the words is how to see different
mail. Paging is not.

## The date window (#153)

`?q=demurrage&since=2026-08-01&until=2026-08-31` works. It did not until migration 0054, and the reason it
did not is the interesting part.

### Why it was refused, and what changed

A window used to be a residual filter *inside* each ranked arm: the arm scans further through its MATCH
result to fill `LIMIT`. Measured at **4,335 rows read against a 1,000-row budget**, for the same 51-row page
a bare term answered in 771.

Filtering *outside* the arms was rejected for a worse reason than cost. The arms cap by rank first, so the
window would filter an already-capped set, and *"mail about demurrage since October"* would answer
**nothing** whenever October's demurrage mail ranked below the cap. A wrong answer to a reasonable question,
silently.

0054 puts the date in both indexes as a token, `d20260801`, one per row, in its own `day` column, so the
window **narrows** the match before the cap instead of filtering after it. Measured on a 120-day corpus:

| window | tokenised | residual filter |
|:--|--:|--:|
| one day | **20** | 2,386 |
| seven days | 140 | not measured |
| sixty days | 1,188 | 2,970 |
| none | 2,376 | 2,376 |

Tripling the corpus over the same 120 days moved the unwindowed figure to 7,128 while the seven-day window
moved to 416. **Windowed cost tracks the window; unwindowed cost tracks the archive.**

### Day granularity, and why an instant is refused rather than rounded

FTS5 matches tokens, not ranges. `d20260801` is expressible; `2026-08-01T10:30:00.000Z` is not.

So a windowed **search** offers day granularity where a windowed **listing** offers an instant, and
`?q=…&since=2026-08-01T10:30:00Z` is **refused** with `E_MESSAGE_PAGE_WINDOW_SEARCH_INSTANT`. Rounding it
would answer with mail from before the time the caller asked for, which is the same class of quiet wrongness
that ruled out filtering after the cap.

An instant still works on an unsearched listing, which compares `accepted_at` directly.

### Four more refusals, each naming its figure

- **`E_MESSAGE_PAGE_WINDOW_SEARCH_OPEN`.** A searched window needs a `since`. `until` alone is unbounded
  backwards, and the token set is enumerated, so it would be one term per day back to the oldest mail here.
- **`E_MESSAGE_PAGE_WINDOW_SEARCH_WIDE`.** At most `MAX_WINDOW_DAYS` (100) days. A bound on the *query's own
  size*, since the window is one token per day. Sized, not measured, and `message-search-cost.md` says so.
- **`E_MESSAGE_PAGE_WINDOW_SEARCH_BUSY`.** At most `search.max_window_messages` (400) messages in the
  window, **counted before the search runs**.
- **`E_MESSAGE_PAGE_WINDOW_SEARCH_FUTURE`.** A `since` later than the window's end, which covers no days
  at all. Added after it was found to be a **500**: `daysAcross` walks `at <= end` and returns `[]`, the
  impossible-window refusal needs *both* bounds so it never saw this one, and the width check reads
  `0 > 100`. `day:()` reached SQLite, which answers `fts5: syntax error near ")"`. No attack needed. A
  client in UTC+13 sending its own local date is already ahead of this Node's UTC clock.

The `BUSY` one is worth understanding, because #153 said it could not exist:

> selectivity is not knowable before the query runs, so there is no per-request rule that admits the cheap
> case and refuses the expensive one

True of a residual filter, where cost tracks the match set and the match set is the corpus for a term the
index cannot narrow. Tokenised, cost tracks the **intersection**. A rare term in a sixty-day window read 12
rows where a common term read 1,188, at roughly two rows read per message in the window, one per arm. So the
volume in the window bounds the read, and unlike selectivity it *is* knowable in advance: one seek on
`ir_org_accepted`. `listMessages` counts it and refuses with the number.

### The release step, which is the one thing to plan for

**0054 is a contracting migration.** It drops both FTS tables, because FTS5 has no
`ALTER TABLE ADD COLUMN`, so `mailda deploy` refuses it without `--contract` and the order is ADR 13's:
deploy the code, then apply the migration deliberately.

One consequence, stated here because this is where somebody planning a release will look:

**0054 requeues every message for the body backfill.** `message_body_search` is contentless, so it cannot be
rebuilt in SQL. The bodies are in R2 and re-indexing means re-reading and re-parsing each one. That is what
the existing backfill does, so the migration resets `body_index_state` rather than inventing a second
mechanism. On a large mailbox this is real work. `doctor`'s `search_index_backlog` and `body_index_backlog`
findings are what to watch, and it is resumable. (`body_index_state` is a *column* added by 0044, not a
check. An earlier draft of this line named it as a finding, which sent a reader looking for one that does
not exist.)

There is **no window in which a windowed search is broken**, which an earlier draft of this section claimed.
`mailda deploy` applies migrations before it uploads the canary, so the column exists before any new code
serves. The old code is unaffected either way, because it inserts an explicit column list and matches bare
terms.

**Until that backlog drains, body matches inside a window are incomplete.** A body row with no day token
cannot match any window. Subject matches are complete as soon as the migration finishes, because that half
rebuilds in SQL.

## The day token has one spelling

`DAY_TOKEN_SQL` in `src/search.ts`, used by every writer: `indexMessage` and `indexBody`, which the ingress
path and both backfills go through, and 0054's own rebuild. A token computed three ways is a token that eventually disagrees with itself, and the
failure is invisible. A row whose day differs by one character is a row no window matches, and nothing
reports it. The search simply does not return that message.

It comes from the receipt's **`accepted_at`**, never the sender's `Date` header. The listing's window is
`accepted_at` too, and two features windowing by different clocks would disagree about which mail is in a
range. The header is also the sender's claim rather than this Node's observation.

`day` is its own column and never appended to the subject text. `message_search` *stores* its `subject`, so a
synthetic token would be shown to somebody by any excerpt or debug read, and a subject legitimately
containing `d20260801` could otherwise match a window it is not in. Queries filter it as `day:(…)`, which
subject text cannot satisfy.

## Cost

Measured, not counted: [`message-search-cost.md`](./receipts/message-search-cost.md).

| page | rows read |
|:--|--:|
| a term the index cannot narrow (worst case) | 771 |
| the same term with a window covering everything | 771 |
| a selective term | 188 |
| a selective term inside a window | 188 |

Against `authz.list.max_rows_read` of 1,000. The window costs nothing where it excludes nothing, which had to
be checked first. A day token that charged for exclusion it did not perform would be a tax on every windowed
search, and the arms' union is where it would have hidden.

[107]: https://github.com/Straits-AI/mailda/issues/107
[153]: https://github.com/Straits-AI/mailda/issues/153
