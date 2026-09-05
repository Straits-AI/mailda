# Searching mail

How a search narrows this Node's listing, what it costs, what it refuses, and the one release step a windowed
search needs.

Implemented by `apps/node/worker/src/search.ts` (the indexes and their writers), `src/search-backfill.ts`
(the body pass), and `messagePageQuery` in `src/authz-read.ts` (the query). Migrations
`0040_message_search.sql`, `0041_body_search.sql`, `0044_body_index_state.sql`,
`0048_body_index_lease.sql` and `0054_search_day_token.sql`. Decision record: [#107][107] for the search,
[#153][153] for the date window.

## Two indexes, authorized differently

| index | holds | authorized by |
|:--|:--|:--|
| `message_search` | subject and sender, stored | `metadata.read` or `content.read` |
| `message_body_search` | a term index of the body, **contentless** | `content.read` only |

A searched page is the union of two arms, each driven by its own virtual table, each ranked and capped. They
are separate because a grant of scope `metadata` must reach the subject index and **not** the body one — a
person permitted to see who wrote and what about is not thereby permitted the text.

`message_body_search` is `content = ''`, so it stores no body text. That is deliberate and it has a
consequence worth knowing: there are no body excerpts in a result list, and `snippet()` returns null rather
than failing. Showing the matching line means fetching the message from R2 and decrypting it, which is a
`mailbox.content.read` operation and is authorized as one.

## A searched page is ranked and capped, and has no cursor

Ordered by `bm25` rank, capped at one page, and `next_cursor` is always null. That is a property of the
ordering rather than a limitation anybody settled for: rank depends on corpus-wide term frequency, so it
shifts every time mail arrives — which in a mail system is continuously — and a cursor into a ranked list
would skip and repeat rows **silently**.

So a search answers one page of the best matches and says so. Narrowing the words is how to see different
mail; paging is not.

## The date window (#153)

`?q=demurrage&since=2026-08-01&until=2026-08-31` works. It did not until migration 0054, and the reason it
did not is the interesting part.

### Why it was refused, and what changed

A window used to be a residual filter *inside* each ranked arm: the arm scans further through its MATCH
result to fill `LIMIT`. Measured at **4,335 rows read against a 1,000-row budget**, for the same 51-row page
a bare term answered in 771.

Filtering *outside* the arms was rejected for a worse reason than cost. The arms cap by rank first, so the
window would filter an already-capped set — and *"mail about demurrage since October"* would answer
**nothing** whenever October's demurrage mail ranked below the cap. A wrong answer to a reasonable question,
silently.

0054 puts the date in both indexes as a token — `d20260801`, one per row, in its own `day` column — so the
window **narrows** the match before the cap instead of filtering after it. Measured on a 120-day corpus:

| window | tokenised | residual filter |
|:--|--:|--:|
| one day | **20** | 2,386 |
| seven days | 140 | — |
| sixty days | 1,188 | 2,970 |
| none | 2,376 | 2,376 |

And tripling the corpus over the same 120 days moved the unwindowed figure to 7,128 while the seven-day
window moved to 416: **windowed cost tracks the window, unwindowed cost tracks the archive.**

### Day granularity, and why an instant is refused rather than rounded

FTS5 matches tokens, not ranges. `d20260801` is expressible; `2026-08-01T10:30:00.000Z` is not.

So a windowed **search** offers day granularity where a windowed **listing** offers an instant, and
`?q=…&since=2026-08-01T10:30:00Z` is **refused** with `E_MESSAGE_PAGE_WINDOW_SEARCH_INSTANT`. Rounding it
would answer with mail from before the time the caller asked for, which is the same class of quiet wrongness
that ruled out filtering after the cap.

An instant still works on an unsearched listing, which compares `accepted_at` directly.

### Three more refusals, each naming its figure

- **`E_MESSAGE_PAGE_WINDOW_SEARCH_OPEN`** — a searched window needs a `since`. `until` alone is unbounded
  backwards, and the token set is enumerated, so it would be one term per day back to the oldest mail here.
- **`E_MESSAGE_PAGE_WINDOW_SEARCH_WIDE`** — at most `MAX_WINDOW_DAYS` (100) days. A bound on the *query's own
  size*, since the window is one token per day. Sized, not measured, and `message-search-cost.md` says so.
- **`E_MESSAGE_PAGE_WINDOW_SEARCH_BUSY`** — at most `search.max_window_messages` (400) messages in the
  window, **counted before the search runs**.

That last one is the one worth understanding, because #153 said it could not exist:

> selectivity is not knowable before the query runs, so there is no per-request rule that admits the cheap
> case and refuses the expensive one

True of a residual filter, where cost tracks the match set and the match set is the corpus for a term the
index cannot narrow. Tokenised, cost tracks the **intersection** — a rare term in a sixty-day window read 12
rows where a common term read 1,188 — at roughly two rows read per message in the window, one per arm. So the
volume in the window bounds the read, and unlike selectivity it *is* knowable in advance: one seek on
`ir_org_accepted`. `listMessages` counts it and refuses with the number.

### The release step, which is the one thing to plan for

**0054 is a contracting migration.** It drops both FTS tables, because FTS5 has no
`ALTER TABLE ADD COLUMN`, so `mailda deploy` refuses it without `--contract` and the order is ADR 13's:
deploy the code, then apply the migration deliberately.

One consequence, stated here because this is where somebody planning a release will look:

**0054 requeues every message for the body backfill.** `message_body_search` is contentless, so it cannot be
rebuilt in SQL — the bodies are in R2 and re-indexing means re-reading and re-parsing each one. That is what
the existing backfill does, so the migration resets `body_index_state` rather than inventing a second
mechanism. On a large mailbox this is real work; `doctor`'s `search_index_backlog` and `body_index_state`
findings are what to watch, and it is resumable.

There is **no window in which a windowed search is broken**, which an earlier draft of this section claimed.
`mailda deploy` applies migrations before it uploads the canary, so the column exists before any new code
serves — and the old code is unaffected either way, because it inserts an explicit column list and matches
bare terms.

**Until that backlog drains, body matches inside a window are incomplete** — a body row with no day token
cannot match any window. Subject matches are complete as soon as the migration finishes, because that half
rebuilds in SQL.

## The day token has one spelling

`DAY_TOKEN_SQL` in `src/search.ts`, used by all three writers: the ingress path, the subject backfill, and
0054's own rebuild. A token computed three ways is a token that eventually disagrees with itself, and the
failure is invisible — a row whose day differs by one character is a row no window matches, and nothing
reports it. The search simply does not return that message.

It comes from the receipt's **`accepted_at`**, never the sender's `Date` header. The listing's window is
`accepted_at` too, and two features windowing by different clocks would disagree about which mail is in a
range. The header is also the sender's claim rather than this Node's observation.

`day` is its own column and never appended to the subject text. `message_search` *stores* its `subject`, so a
synthetic token would be shown to somebody by any excerpt or debug read — and a subject legitimately
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
be checked first: a day token that charged for exclusion it did not perform would be a tax on every windowed
search, and the arms' union is where it would have hidden.

[107]: https://github.com/Straits-AI/mailda/issues/107
[153]: https://github.com/Straits-AI/mailda/issues/153
