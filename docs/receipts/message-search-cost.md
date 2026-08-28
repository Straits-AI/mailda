---
id: message-search-cost
kind: measured-tripwire
measured_on: 2026-08-27
stale_when: >
  either arm of messagePageQuery's searched plan stops being driven by its virtual table; an arm's inner
  ORDER BY changes from rank; a third arm is added; messages.page_size moves; RELATIONS_FOR_METADATA or
  BODY_SEARCH_RELATIONS gains a relation; either index gains an indexed column, since MATCH then spans more
  text per row; or authz.list.max_rows_read moves
values:
  search.max_rows_read_per_page: 720
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

## What ships, and what it costs

A searched page is a **union of two arms** — one over the subject/sender index, one over the body index —
each driven by its own virtual table, each `ORDER BY rank LIMIT n`, with the union sorted by arrival.

| | rare term (12 hits) | common term (1,188 hits) |
|:--|--:|--:|
| plain unsearched page, for comparison | 208 | 208 |
| **shipped: two arms, two grant scopes** | **176** | **720** |

Against `authz.list.max_rows_read = 1000`. A rare search still costs **less than not searching**, which is
what an index is for and is asserted as a direction rather than only as a ceiling. The common term at 720 is
the tight one — 72% of the budget — and it is the figure `search.max_rows_read_per_page` pins.

### 616 → 720, and the extra 104 rows bought a closed authorization hole

Each arm now joins **two** supervised-grant subqueries rather than one. That is not an optimisation anybody
would choose; it is what closing a confidentiality defect cost.

The searched page has two arms because a body match and a subject match are different authorities. The
*standing relations* were split correctly from the start — subject on `metadata.read` or `content.read`, body
on `content.read` alone. The **supervised grants were not**: `listMessages` built one subquery from
`SCOPES_FOR_METADATA`, which is `["metadata", "content"]`, and both arms tested it. So a grant of scope
`metadata` reached the body index and became a membership oracle over content — *does "bankruptcy" occur in
any message* — one query at a time, returning the subject and sender of whatever matched.

Every test covered standing relations, so the arms looked correctly separated. Nothing exercised the second
authorization mechanism against the second index, and a third-party audit found it rather than this suite.

Each arm now joins the metadata-scoped subquery **and** the content-scoped one: the first authorizes the
subject arm, the second authorizes the body arm, and both arms attribute
`COALESCE(sgc.grant_id, sgm.grant_id)`. The COALESCE is not decoration — `liveGrantsBySubject` names
`MIN(id)` per mailbox, so a reader holding both grant kinds gets a different id from each subquery, and a
message matching subject *and* body would come back **twice** from `UNION`, differing only in a column the
response strips. Naming the stronger grant in both arms makes them agree.

**72% of the budget is the number to watch.** It is inside, and it has less headroom than anything else this
receipt records. A third arm, or a third read relation, would need re-measuring before it shipped rather
than after.

### Three shapes were measured before this one, on subjects alone

| shape (one arm, subjects only) | rare term | common term |
|:--|--:|--:|
| time-driven, match as a filter | **3,640** | 2,584 |
| index-driven, `ORDER BY rank` | **64** | **258** |
| index-driven, `ORDER BY accepted_at` | 63 | **5,943** |

Only the middle row was inside the budget for both terms, and doubling it for the second arm is where 150 and
616 come from.

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

**The union is ordered by arrival rather than by rank, and that is forced.** bm25 rank is computed from term
frequency within one index, so a subject hit's rank and a body hit's rank are numbers on different scales —
ordering the union by `rank` would be arithmetic on unrelated quantities. Each arm therefore takes its own
best matches by rank, and the union, which is at most twice the page size, is sorted by `accepted_at`. That
sort is over a hundred rows and costs nothing; what would be expensive is sorting the match set, which is the
5,943 shape above.

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

## A fixture with no bodies measured a query that does not exist

The first version of this measurement indexed only subjects, so the body arm probed an empty index and the
figures came back at 77 and 310. Those are the costs of a union whose second arm never matches anything —
which is no Node anybody will run.

With bodies indexed at the same selectivity as the subjects, the real figures are 150 and 616. Recorded
because the mistake is easy to repeat and reads as good news: a search index measured against a corpus that
was never indexed reports the cost of finding nothing.

The second version then made it wrong the other way. Every body said either *"demurrage was claimed"* or
*"cleared without a demurrage claim being raised"* — so the **rare** term matched all 1,200 bodies and
reported 372 rows for what was supposed to be the cheap case. A fixture whose two terms have the same
selectivity measures one thing twice.

## Cross-index queries cannot match, which is the price of the authorization boundary

FTS5 requires every term of a query to appear in the same indexed document, and a subject and a body are two
documents in two tables. So a search for *"hapag cabotage"* finds nothing even when `hapag` is in a message's
subject and `cabotage` is in its body.

Fixing it means one index holding subject and body together — which is exactly what the authorization split
forbids, because then a `mailbox.metadata.read` holder's subject search would match body words. **The
limitation is the price of the boundary**, and it is asserted in `test/message-search.test.ts` so it stays
deliberate rather than being discovered by somebody whose search mysteriously fails.

## What is not measured here

- **The body backfill's cost at scale.** It is bounded by construction — 25 messages per scheduled run, each
  an R2 read, a key unwrap, a decryption and a MIME parse — but how long a large archive takes to catch up is
  not established, because no Node here has one. `doctor`'s `body_index_backlog` is what makes it visible on
  one that does.
- **Nothing re-indexes a message whose body failed to read transiently.** `backfillBodyIndex` settles every
  message it reaches, including the ones whose evidence could not be fetched or parsed, because an unreadable
  body does not become readable next minute and a pass that retries it forever never reaches the mail behind
  it. The cost of that choice: a message whose read failed for a *recoverable* reason — a momentary R2 error,
  a vault hiccup — stays unsearchable by its body until something re-indexes it, and **nothing does**. It is
  still listed, readable, and findable by subject and sender. Clearing `body_indexed_at` is what a repair
  would do; no route or command exposes that, so today the repair is a `wrangler d1 execute` by an operator
  who knows to.
- **The metadata backfill's cost at scale.** One `INSERT … SELECT … LIMIT 500` per run, so its cost is the
  limit. Same gap for the same reason.
- **Index size per message.** How many bytes a body's postings add to D1 is not measured here, and it is the
  figure that decides whether a large Node approaches D1's 10 GB ceiling. Named as absent rather than
  estimated.
- **How the figures move with corpus size.** 1,200 deliveries shows the ranked plan does not track the match
  set and the time-ordered one does. It does not establish the curve.
- **How the figures move with corpus size.** 1,200 deliveries is enough to show that the ranked plan does not
  track the match set and the time-ordered one does. It does not establish the curve.
