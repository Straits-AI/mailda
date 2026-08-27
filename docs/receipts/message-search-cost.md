---
id: message-search-cost
kind: measured-tripwire
measured_on: 2026-08-27
stale_when: >
  messagePageQuery's searched plan stops being driven by the message_search virtual table; the ORDER BY on
  that plan changes from rank; messages.page_size moves; RELATIONS_FOR_METADATA gains a relation; the index
  gains an indexed column, since MATCH then spans more text per row; or authz.list.max_rows_read moves
values:
  search.max_rows_read_per_page: 258
---

**What a searched inbox page costs, and the design it took three measurements to find.**

**Measured:** `apps/node/worker/test/message-search.measure.test.ts`, under `@cloudflare/vitest-pool-workers`
in the real Workers runtime against a seeded D1. It imports `messagePageQuery` from `src/authz-read.ts` rather
than restating the statement, so the figures describe the query that ships.

Corpus: **1,200 deliveries**, the same size as `message-page-size.md`'s, so the two figures are comparable — a
search measured on a smaller corpus would be the more flattering number for no reason. One message in a
hundred carries a rare term (`demurrage`, 12 hits); every other one carries a common term (`shipment`, 1,188
hits). Two terms because they price different things: the rare one is the search people actually run, and the
common one is the worst case, where the index excludes nothing and the page is the cost of having asked.

`rows_read`, not milliseconds, for the reason `authz-check-rows-read.md` established: `performance.now()`
inside workerd is clamped by the Spectre mitigation, and D1 bills on rows scanned.

## The three shapes

| shape | rare term (12 hits) | common term (1,188 hits) |
|:--|--:|--:|
| time-driven, match as a filter | **3,640** | 2,584 |
| **index-driven, `ORDER BY rank`** — shipped | **64** | **258** |
| index-driven, `ORDER BY accepted_at` | 63 | **5,943** |

Against `authz.list.max_rows_read = 1000`, **only the middle row is inside the budget for both terms.** The
plain unsearched page reads 208, so a rare search now costs less than not searching — which is what an index
is for, and is asserted as a direction rather than only as a ceiling.

## Why the first shape was chosen, and why it was wrong

Search was built first as **one plan**: the FTS match added to the existing listing as one more `WHERE`
predicate, keeping the `accepted_at` ordering and the keyset cursor. The argument was that
`AND m.id IN (SELECT message_id FROM message_search WHERE … MATCH ?)` is a semi-join, so `ingress_receipts`
keeps driving, the keyset seek is untouched, and a searched page pages exactly like an unsearched one.

The first half of that is true. The second half is the mistake, and it is not subtle once measured:

**Ordering by time while filtering by match costs O(corpus), not O(matches).** To fill a page with the twelve
newest matching messages, the scan walks all 1,200 receipts in `accepted_at` order, because nothing about the
time index knows which of them match. Twelve results, 3,640 rows read — seventeen times the plain page, and
three and a half times over the budget, from a query whose entire purpose is to read less.

An intermediate attempt made it slightly worse. `WITH matched AS MATERIALIZED (…)` was added on the theory
that SQLite was re-running the match per candidate row, which the query plan supported — `SCAN message_search
VIRTUAL TABLE` appeared *after* the receipt access. It removed the repeated match and the figure went from
3,640 to 3,640: the repeated match was never the expensive part. **The walk was.**

Two things are worth taking from this beyond the number:

- **The losing design read correctly in review** and carried a confident comment explaining why it was safe.
  That comment is in this repository's history and it is wrong. Nothing but a measurement was going to find it.
- **The common term hid it.** At 2,584 the common term was over budget but only 2.5×, and the rare term — the
  one a person actually types — was the worse case by a wide margin. A single-term measurement would plausibly
  have picked the common one, since it looks like the worst case, and understated the problem.

## Why ranked and capped, and what that costs the reader

`ORDER BY rank LIMIT n` is the only shape that stays flat, because FTS5 returns the best matches without
fetching and sorting the whole match set. Ordering the index-driven plan by time instead costs **5,943** on a
common term for exactly that reason: all 1,188 matches must be materialised before fifty can be returned.

So a searched page is **one page of the best matches, with no cursor**. `next_cursor` is always null for a
search, and the interface says *"best matches — narrow the words to see others"* when a page comes back full.

**This is the same answer the search scoping had already chosen, for an unrelated reason** — bm25 rank depends
on corpus-wide term frequency, so it shifts every time mail arrives, and a cursor into a ranked list would
skip and repeat rows silently. The correctness argument was made first and believed on its own. The cost
argument arrived a day later and landed in the same place, which is the only reason this receipt does not have
to argue with a decision.

Worth being plain about the loss: **there is no way to reach the fifty-first best match.** Narrowing the words
is the only route, and that is a real limitation rather than a hidden one — it is on the screen.

## The plan, printed rather than trusted

```
SEARCH supervised_grants USING COVERING INDEX sgr_live (org_id=? AND subject_id=?)
SCAN s VIRTUAL TABLE INDEX 32:M4
SEARCH m USING INDEX sqlite_autoindex_messages_1 (id=?)
SEARCH r USING INDEX sqlite_autoindex_ingress_receipts_1 (id=?)
SEARCH a USING INDEX addr_unique (org_id=? AND address=?)
SEARCH sg USING AUTOMATIC COVERING INDEX (mailbox_id=?) LEFT-JOIN
SEARCH relationship_tuples USING COVERING INDEX rt_unique (…)
SEARCH c USING INDEX cas_unique (conversation_id=? AND mailbox_id=?)
```

The virtual table is the outer loop and everything else is a seek off it. The measurement asserts that
`VIRTUAL TABLE` appears **before** `ingress_receipts` in the plan, which is what would catch a future edit
turning this back into the O(corpus) shape — and it asserts the plain listing still seeks on `ir_org_accepted`
with no temp b-tree, because the two plans share a column list and an authorization predicate and a change to
either could quietly re-plan the listing.

## A misordered bind is a search that silently finds nothing

Recorded because the failure mode is the dangerous kind. The searched plan puts the FTS table first in the
`FROM`, so the `MATCH` placeholder was bound first — but the supervised-grant subquery is interpolated into a
`LEFT JOIN`, which precedes the `WHERE` in the **statement text**, and text order is what binding follows.

The query returned **zero rows for every term** and raised nothing. A search that finds nothing is
indistinguishable from a mailbox with no matching mail, so this would have shipped as "search does not work"
with no error anywhere to explain it. It was caught because the measurement asserts the rare term matches more
than one row — an anti-vacuity check written for a different reason entirely.

## What is not measured here

- **Body search.** This index holds `subject` and `from_addr` only. Message bodies are a separate index with a
  real disclosure cost, and it is a later layer — see `d1-fts5-search.md` for the contentless form it needs.
- **The backfill's cost at scale.** `backfillSearchIndex` is one `INSERT … SELECT … LIMIT 500` per scheduled
  run, so its cost is the limit and it is bounded by construction rather than by measurement. What is not
  established is how long a large archive takes to catch up, because no Node here has one.
- **How the figures move with corpus size.** 1,200 deliveries is enough to show that the ranked plan does not
  track the match set and the time-ordered one does. It does not establish the curve.
