---
id: authz-check-rows-read
kind: measured-tripwire
measured_on: 2026-08-03
stale_when: >
  the relationship_tuples or team_members index definitions change; a team-membership
  model beyond user->team->object is introduced; a check names more than two relations at
  once, since the two-relation figure below is one extra index seek and not a general
  claim about widening; ABAC/policy conditions begin reading additional rows on the
  request path; or the audit append stops costing one tip read plus one batch, which is
  the term the supervised figure adds to the check
values:
  authz.check.max_rows_read: 200
  authz.list.max_rows_read: 1000
  authz.check.max_queries: 2
  authz.supervised_read.max_queries: 4
---

**Measured:** `apps/node/workers/state/test/authz.measure.test.ts`, run under
`@cloudflare/vitest-pool-workers` inside the real Workers runtime against a seeded D1.

Corpus: 400 users, 40 teams, 600 mailboxes, 2,160 relationship tuples, 900 team
memberships. Most users are in 2 teams; every 40th is in 12. Shared mailboxes are granted
to teams rather than individuals, which is how organisations actually do it. A second run
at 4× that size checks scaling.

## What was measured, and why it is not milliseconds

**`performance.now()` cannot measure this.** Inside Workers it is clamped by the same
Spectre mitigation as `Date.now()` — it returns the time of the last I/O and does not
advance during code execution. The first version of this benchmark reported
`p50=1.000ms, p95=1.000ms, max=2.000ms` for every scenario including the pathological
one. Those were the clock's resolution, not a measurement, and reporting them against
§23's 500 ms budget would have been a fabricated number.

`rows_read` from D1's `meta` object is the right metric instead: #5's receipt established
that **D1 bills on rows scanned, not returned**, so this number is simultaneously the cost
metric, the ceiling-pressure metric, and a direct proxy for whether an index is being used.
It is deterministic and immune to clock clamping.

Wall-clock p95 against §23's budget still needs measuring against a **deployed** Node.
That is not possible locally and belongs with #14.

## Observed

| Scenario | rows_read | queries |
|---|---:|---:|
| Single-object check, typical user (2 teams) | 7 | 2 |
| Single-object check, heavy user (12 teams) | 15 | 2 |
| Single-object check, deny | 6 | 2 |
| Two-relation check (`relation IN (?, ?)`), typical user | 12 | 2 |
| Two-relation check, deny | 12 | 2 |
| List visible mailboxes, typical user | 26 | 2 |
| List visible mailboxes, heavy user (96 visible) | 136 | 2 |
| Single-object check at 4× corpus | 11 | 2 |

`d1_duration` reported 0.000 ms locally — miniflare does not populate it. Another reason
the timing claim waits for a deployed Node.

## Sized

- `authz.check.max_rows_read = 200` — 13× the worst observed check (15). A user in 50
  teams would read roughly 53. Only a lost index reaches 200.
- `authz.list.max_rows_read = 1000` — 7× the worst observed list (136), which already
  had 96 visible mailboxes against a 200-row limit.
- `authz.check.max_queries = 2` — team resolution, then the tuple lookup. A third query
  means an N+1 has appeared.

**The two-relation form shares the check budget rather than getting its own** (added
13 August 2026, with `mailbox.metadata.read`). Widening the *fourth* index column to
`relation IN (?, ?)` costs one extra seek — 12 rows against 7 — because the prefix up to
`object_type` is still fully usable — printed rather than argued, in `test/explain.test.ts`:

```
SEARCH relationship_tuples USING COVERING INDEX rt_unique
  (org_id=? AND subject_id=? AND object_type=? AND relation=? AND object_id=?)
```

all five columns, with `relation=?` applied once per `IN` element. Two relations is what the queue needs: its
message-derived columns are satisfied by `mailbox.metadata.read` **or**
`mailbox.content.read`, and the alternative implementation is two sequential single-relation
queries, which would cost the same seeks plus a round trip and break
`authz.check.max_queries = 2`. If a caller ever named enough relations to approach 200 rows,
the honest answer would be a different shape, not a larger budget — so the figure is here to
be checked rather than assumed. Notably the deny case costs the *same* 12: a miss seeks both
relations, where a hit can stop at the first.

These are tripwires in the AGENTS.md sense: good checks never approach them. If routine
work starts hitting one, the tripwire is wrong and should be re-measured — but a *scan*
blows past them by two orders of magnitude, which is the failure they exist to catch.

## What this found

The first run of this benchmark reported **1,864 rows read for a single check** against a
corpus with only 3,060 rows total — nearly a full table scan — growing to 9,308 at 4×
corpus. `EXPLAIN QUERY PLAN` named the cause:

```
SEARCH relationship_tuples USING COVERING INDEX rt_unique (org_id=?)
```

Only `org_id` was usable. The unique index was
`(org_id, subject_type, subject_id, relation, object_type, object_id)`, and every query
filters `subject_id` **without** `subject_type` — so the usable prefix stopped at the
first column and the planner scanned the rest of the organisation. Two purpose-built
secondary indexes were never chosen, because `rt_unique` was covering and won.

The fix came out of #6: **typed-prefix ULIDs make `subject_type` redundant.** `usr_01J…`
and `tm_01J…` already carry their type, so the column was duplicate state that could
disagree with the id — and it was also destroying the index prefix. Dropping it and
reordering to `(org_id, subject_id, object_type, relation, object_id)` lets one index
serve all three jobs: uniqueness for #9's retry-safety, the full five-column prefix for
the single-object check, and the four-column prefix for the list case with `object_id`
read straight out of the index. The two secondary indexes were deleted, which also
removes two index writes per tuple — #5 recorded that each index adds a written row.

Had this shipped unmeasured, every authorization check in the product — on the path of
every request, per §7 — would have scanned the organisation's entire tuple table.

## Residual

- Wall-clock latency against §23's p95 < 500 ms is **not** established here. Only row
  cost is.
- ABAC conditions, policy evaluation and approval state are not yet in the measured path;
  §7 requires all of them per request. Each addition should re-run this benchmark.
- The `USE TEMP B-TREE FOR DISTINCT` in the list plan is not free and was not isolated.
  Worth revisiting if the list case ever dominates a trace.

## Correction — 20 August 2026: supervised reading joined the check path

`stale_when`'s last clause — *"ABAC/policy conditions begin reading additional rows on the
request path"* — **fired**. #63 added `supervised.read`, a time-boxed grant that satisfies a
content or metadata read for a mailbox the reader holds no relation on, so `mayRead`,
`mayReadMetadata` and `listMessages` now consult a second table. The clause said to re-measure,
so it was re-measured before anything shipped.

**The values above are unchanged.** Nothing here is a new number; this is the check the clause
demanded.

**Measured:** `apps/node/worker/test/authz.measure.test.ts`, describe block *"supervised
reading's effect on the authorization path (#63)"*, same corpus as above. The supervised rows
are taken **after** the 4× scaling case has reseeded the database, which is why the
standing-only baselines below read higher than the table above — the comparisons are same-user
and same-moment, which is the only way the delta means anything.

| Scenario | rows_read | queries |
|---|---:|---:|
| Content check, tuple hit, no supervised arm | 11 | 2 |
| Content check, tuple hit, with the arm | 11 | 2 |
| Content check, tuple miss, no arm | 10 | 2 |
| Content check, tuple miss, with the arm (grant hits) | 11 | 2 |
| Heavy user (12 teams), tuple miss, no arm | 50 | 2 |
| Heavy user, tuple miss, with the arm (grant hits) | 51 | 2 |

`mayRead` itself, priced with `metering()` from `src/cost-meter.ts` rather than a copy of its
query: **2 D1 executions** in all four states — no grant anywhere, a grant held, a grant held by
somebody else, and a denial. That is the figure `authz.check.max_queries = 2` bounds, and it is
the one a hand-written benchmark cannot establish.

**Why the delta is one row and not a multiple.** The grant lookup is a `UNION ALL` arm of the
statement the check was already issuing, not a second query, and `sgr_live`
(`migrations/0023_supervised_read.sql`) is **partial** on `granted_at IS NOT NULL` — so on a Node
where nobody holds supervised access the arm seeks an empty index. Where a grant does exist the seek
is fully covered, printed rather than argued in `test/explain.test.ts`:

```
COMPOUND QUERY
LEFT-MOST SUBQUERY
SEARCH relationship_tuples USING COVERING INDEX rt_unique
  (org_id=? AND subject_id=? AND object_type=? AND relation=? AND object_id=?)
UNION ALL
SEARCH supervised_grants USING COVERING INDEX sgr_live
  (org_id=? AND subject_id=? AND mailbox_id=? AND scope=? AND expires_at>?)
```

One compound, two searches, both covering, all five constrained columns used on each. **The first
version of that index was not this**, and printing the plan is what said so: it was ordered
`(…, mailbox_id, expires_at, scope)`, and a *range* ahead of an *equality* truncates the usable
prefix at four columns and reads the scope off the row. Same lesson as #11's column order, one table
over. `granted_at` is in the key as well, purely because SQLite's covering-index test does not credit
a partial index's predicate as supplying the column it constrains — without it the plan reads the
table row to re-check something the index already guarantees. The measured figures above are
unchanged by the fix, which is worth stating: the improvement is in the plan, not in the row count at
this corpus size.

**Where the cost actually is, stated because it is the only real one.** A check that **hits** the
tuple arm is unchanged, because `LIMIT 1` stops there. A check that **misses** it pays one extra
row, because the compound has to exhaust the tuple arm before it can try the grant. Both are
inside `authz.check.max_rows_read = 200` by more than an order of magnitude.

**What is not measured, and is not claimed.** `listMessages` gained a `UNION` inside its mailbox
sub-select and is not separately priced here; it stays two queries by construction, and the list
budget it lives under is `authz.list.max_rows_read = 1000` against a worst observed 136. A
supervised reader listing a mailbox is bounded by the same `LIMIT 50` every other reader is.

## Correction — 20 August 2026: the record joined the read path, and it costs two more

#63 part B put §7's per-act recording **inside** the authorization decision: `mayRead` takes the act it
is about to authorize and appends the entry before it returns, so a read path cannot obtain the
authority without producing the record. That puts an audit append on the hot path, which is exactly
the thing this receipt exists to price, so it was priced rather than reasoned about.

**One new value, `authz.supervised_read.max_queries = 4`.** The other three are unchanged, and that is
the finding rather than an aside: **an ordinary read still costs two round trips.** The record is owed
only when a *grant* answered, and `UNION ALL … LIMIT 1` stops at the tuple arm for everybody holding a
standing relation — so the append is unreachable for every read this product performs today outside a
supervised session.

**Measured** with `metering()` through `mayRead` itself, in the same describe block as the correction
above:

| Scenario | D1 executions |
|---|---:|
| No supervised grant anywhere, tuple hit | 2 |
| No supervised grant anywhere, deny | 2 |
| A bystander, while somebody else holds a grant | 2 |
| **The grant holder, grant answers** | **4** |

The 4 decomposes exactly, which is what makes it a figure rather than an observation: **2** for the
check — team resolution, then the one compound statement, unchanged — plus **2** for the append, which
is `buildEntries` reading the chain tip and one `batch()` carrying the entry. That second pair is
inherent to hash-linking and is already what `audit-and-log-retention.md` describes; it is not a new
mechanism, it is this path now using one.

**Sized:** 4, exactly, and deliberately with no headroom. Every term is fixed — none of the four scales
with the corpus, the organization or the number of grants — so a tripwire that allowed 6 would be one
that permitted a third check query or a second append without saying so. This is a *test-time* bound
(`assertWithinBudget` is called from the measure test, never from `mayRead`), so the one thing that
could legitimately exceed it — `auditedBatchMany` retrying after losing the sequence race, at +2 an
attempt — cannot reach it: the measurement is uncontended by construction.

**Cost if wrong:** too low and the tripwire fires on a legitimate shape and gets raised without being
read. Too high and the recording grows a round trip on the read path unnoticed — which is the failure
`authz.check.max_queries` was written for, one function along.

**What is still not separately priced:** `listMessages`, which gained a `LEFT JOIN` on to the grant
derived table and a `supervised.query` append. It stays two queries when nothing is granted and four
when something is, by the same decomposition, and it lives under `authz.list.max_rows_read = 1000`
against a worst observed 136. A supervised reader listing a mailbox is bounded by the same `LIMIT 50`
every other reader is.

## Correction — 21 August 2026: a Butler's check has three terms, and it is still two queries (#51)

`stale_when` names *"a check names more than two relations at once"* and does **not** name a check over more
than one *subject set*. #51 built exactly that: a Butler's effective authority is

    effective(step) = pinned ceiling ∩ live tuples of the Butler ∩ live tuples of the sponsor

which is one relation set and **two** subject sets. The clause did not fire, and the figures were re-measured
anyway, because *"the clause did not name it"* is not evidence about a number.

**`authz.check.max_queries = 2` is unchanged, and it is unchanged for a reason rather than by luck.** The
three terms decompose into two round trips:

1. **The ceiling is free.** It is the `capabilities:` of the frozen AST the run has already loaded, so the
   term costs no query — only a sub-select over `addresses`, which is UNIQUE on `(org_id, address)`.
2. **The sponsor's subjects: one query**, `readableSubjects`, the same statement every human check makes.
3. **Both tuple terms in one statement.** The Butler needs no team expansion (`team_members.user_id` holds
   users and a Butler's subject is a `btl_`), so the second query carries the ceiling arm and both subject
   sets.

**Measured** with `metering()` in `workerd`, in `test/butler-run-cost.measure.test.ts` — the send node's
decomposition, where the intersection appears as its own term and is asserted as an **equality**:

| what | D1 executions |
|:--|--:|
| the three-term intersection, standalone (`effectiveOnMailbox`) | **2** |
| the same intersection folded into a node's own read (`lookup`, `case.*`) | **1** extra, plus the sponsor query = **2** |
| the ceiling term alone, when it refuses | **0** |

That last row is not a rounding: an action the ceiling never declared is refused in memory, before any
statement is prepared, which is why the reason it produces (`capability_not_declared`) is the cheapest answer
in the system as well as the only one whose remedy is a republish.

**The OR-versus-AND subtlety, recorded here because it is a property of the query rather than of the code
around it.** An `IN` list over subjects answers *"does any of these hold it"*, which is an OR, while the
intersection needs an AND. The standalone shape selects `DISTINCT subject_id` rather than `1`, so the query
returns *which* subjects hold the relation and the AND is evaluated on the result; the folded shape uses two
`EXISTS` clauses joined by SQL's own `AND`, with the OR living inside the sponsor's clause where it belongs.
`test/butler-capability.test.ts` walks all eight combinations of the three terms and asserts the two shapes
answer alike — the two combinations where exactly one subject holds the relation are the ones a single flat
`IN` list would get wrong, and they are the whole defect.

**What is not measured here, and is not claimed.** `rows_read` for the Butler shape was not isolated. The
figures above are D1 *executions*, which is what `authz.check.max_queries` bounds; the row cost is bounded by
the same index prefix as every other check in this file — one relation, one `object_id`, a handful of
subjects — and no scan is possible against `rt_unique` with `org_id`, `object_type`, `relation` and
`object_id` all constrained. Saying so rather than printing a number nobody produced.
