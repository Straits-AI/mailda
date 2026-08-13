---
id: authz-check-rows-read
kind: measured-tripwire
measured_on: 2026-08-03
stale_when: >
  the relationship_tuples or team_members index definitions change; a team-membership
  model beyond user->team->object is introduced; a check names more than two relations at
  once, since the two-relation figure below is one extra index seek and not a general
  claim about widening; or ABAC/policy conditions begin reading additional rows on the
  request path
values:
  authz.check.max_rows_read: 200
  authz.list.max_rows_read: 1000
  authz.check.max_queries: 2
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
