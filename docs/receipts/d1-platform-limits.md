---
id: d1-platform-limits
kind: platform-limit
measured_on: 2026-08-02
stale_when: >
  automatic resource provisioning or read replication leaves beta; the published D1 limits
  page changes (last moved 2026-04-21); or D1 gains interactive transactions
values:
  d1.paid.max_database_bytes: 10737418240
  d1.paid.max_account_storage_bytes: 1099511627776
  d1.paid.max_databases_per_account: 50000
  d1.paid.max_queries_per_invocation: 10000
  d1.paid.time_travel_days: 30
  d1.free.max_database_bytes: 524288000
  d1.free.max_account_storage_bytes: 5368709120
  d1.free.max_queries_per_invocation: 1000
  d1.free.time_travel_days: 7
  d1.max_columns_per_table: 100
  d1.max_sql_statement_bytes: 100000
  d1.max_bound_parameters: 100
  d1.max_sql_function_args: 32
  d1.max_row_bytes: 2000000
  d1.max_query_duration_seconds: 30
  d1.max_time_travel_restores_per_10min: 10
---

## Correction, 13 August 2026: these two figures were never D1 limits

`d1.paid.max_queries_per_invocation` read **1000** and `d1.free.max_queries_per_invocation` read **50**. Both
were wrong, and the reason is worth more than the numbers.

They are the **subrequest** limit restated under a D1-flavoured name. 1,000 was the old paid per-invocation
subrequest ceiling — withdrawn on 11 February 2026, now 10,000 — and 50 is the free plan's *external*
subrequest allowance, which does not apply to D1 at all: D1 is an internal Cloudflare service and free plans
get 1,000 of those. So one figure was stale and the other was attributed to the wrong category.

**Measured, in `butler-step-budget.md`:** a single Worker invocation performed **10,000 D1 queries** and then
failed with `Too many API requests by single Worker invocation` — the subrequest error, not a D1 error. Had a
1,000-query D1 ceiling existed, the run would have stopped at 1,000. D1 imposes **no query ceiling of its
own**; it spends from the subrequest budget like any other binding.

**Why nothing caught it:** the name put the limit on the wrong subsystem. The changelog that invalidated it
was about Workers subrequests, and nobody re-reads a D1 receipt when a Workers limit changes. `stale_when`
below names the D1 conditions it should — and could not name a condition in a subsystem the figure was
mislabelled out of.


**Measured:** Read from Cloudflare's published documentation on 2 August 2026. Not
measured against a running Node — these are the platform's stated ceilings, and per
Blueprint §11B they are **adapter data**, not constants. The Node must detect them at
runtime and display them in Admin and `mailda doctor`. Nothing here belongs in application
code as a literal.

Sources, with their own last-updated dates:

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) — page states last updated 21 April 2026
- [D1 Database Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/) — `batch()`, `withSession()`, `getBookmark()`
- [Debug D1](https://developers.cloudflare.com/d1/observability/debug-d1/) — error classes and automatic retries
- [D1 read replication public beta](https://developers.cloudflare.com/changelog/post/2025-04-10-d1-read-replication-beta/) — 10 April 2025
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — row read/write accounting

## Ceilings

| Limit | Workers Free | Workers Paid |
|---|---:|---:|
| Maximum database size | 500 MB | **10 GB** |
| Databases per account | 10 | 50,000 |
| Account-level storage across all databases | 5 GB | **1 TB** |
| Queries per Worker invocation | 50 | 1,000 |
| Time Travel window | 7 days | 30 days |

Both plans: 100 columns per table · 100,000-byte SQL statement · **100 bound parameters per
query** · 32 SQL function arguments · 50-byte LIKE/GLOB pattern · ~5,000 bindings per Worker
script · **30-second** query duration · **2,000,000-byte** maximum row/BLOB/string · 5 GB
file import · Time Travel restores capped at 10 per 10 minutes per database.

Rows are counted regardless of size: a 1 KB row and a 100 KB row each count as one. An index
adds a second written row whenever the indexed column is written.

## Atomicity

`batch()` is atomic. Verbatim from the Worker API docs:

> D1 operates in auto-commit. Our implementation guarantees that each statement in the list
> will execute and commit, sequentially, non-concurrently. Batched statements are SQL
> transactions. If a statement in the sequence fails, then an error is returned for that
> specific statement, and it aborts or rolls back the entire sequence.

So §22's "data and outbox commit in one transaction" **is achievable** — on the condition
that the domain write and the outbox row are statements in the *same* `batch()` call. That
is a constraint on the repository layer, not a blocker.

Writes are **not** retried automatically. D1 retries read-only queries (`SELECT`, `EXPLAIN`,
`WITH`) up to twice and rolls back if a write slips through; Cloudflare explicitly
recommends application-level retries for idempotent non-read queries. Application-level
idempotency is therefore mandatory, not belt-and-braces.

## Consistency

Read replication is **opt-in**: without the Sessions API every query goes to the primary. A
session obtained via `withSession()` gives sequential consistency; it starts `first-primary`,
`first-unconstrained` (the default), or from a prior bookmark. `session.getBookmark()`
returns a bookmark that links sessions.

Bookmarks are the mechanism §24's backup design needs for "a compatible online cut."

## What this fixes elsewhere

- **§11B's shard thresholds are now sizeable.** The per-database ceiling is 10 GB, so the
  70/85/90% marks are 7 GB / 8.5 GB / 9 GB. This receipt does not size them — that is
  ticket #12's job, and it needs the real per-message byte cost first.
- **§11B does not mention the account-level ceiling.** 1 TB across all databases is the real
  Node limit, and sharding does not relieve it — it relieves only the per-database 10 GB.
  A Node approaching 1 TB needs the PostgreSQL `ControlStoreAdapter`, not another shard.
  Flagged for the blueprint.
- **The 2 MB row limit confirms §12**: raw MIME and attachments cannot live in D1 under any
  reading, and it bounds what "preview and search representations are bounded" can mean.
- **100 bound parameters** forces chunked bulk writes. Relevant to #9 and #12.

## Stale when

- Automatic resource provisioning or read replication leaves beta.
- The published limits page changes — it moved most recently on 21 April 2026.
- D1 gains interactive transactions (see residual unknowns below), which would change the
  outbox design in #9.

Re-read the limits page and update this file; do not let a number here outlive its source.

## Residual unknowns

Recorded rather than glossed, because AGENTS.md treats an unverified assertion as a landmine:

1. **Interactive transactions.** No document found either offering or explicitly denying
   `BEGIN`/`COMMIT` spanning awaits. The auto-commit framing strongly implies they do not
   exist, but "strongly implies" is not a receipt. Verify before #9 relies on it.
2. **Worker eviction mid-`batch()`.** The database either applied the batch or did not — but
   the *caller* may never learn which. That is the `outcome_unknown` shape appearing
   **inside** the Node, not only at the provider boundary. §22 and §24 discuss unknown
   outcomes solely for external effects. If an internal write can also end unknown, the
   reconciler design in #9 is wider than the blueprint currently describes. This is the most
   consequential thing this ticket turned up.
