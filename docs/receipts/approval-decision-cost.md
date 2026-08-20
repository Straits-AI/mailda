---
id: approval-decision-cost
kind: measured-tripwire
measured_on: 2026-08-20
stale_when: >
  the eligible set gains a narrowing constraint — a team-scoped stage is the one #61 named absent, and it would
  add a query or a join to every eligibility check; a decision stops carrying its audit entry, its decision row
  and its state changes in one batch(), which is what makes the act one round trip; the completion predicate
  moves out of SQL into TypeScript, which would turn one batch into a read plus a write; the approvals tables
  gain a column a decision has to read; a D1 batch() stops being one round trip; or the seal's approval path
  gains or loses an I/O operation for any other reason
values:
  approval.eligibility_max_subrequests: 3
  approval.decision_max_subrequests: 10
---

**Measured:** `apps/node/worker/test/approval-cost.measure.test.ts`, in the real `workerd` runtime against a
real D1 and R2, using `src/cost-meter.ts` — which counts **executions** rather than `prepare`, prices a
`batch()` as the one round trip it is, and sees Durable Object RPCs. Not counted by reading: this repository has
had a read-off count be wrong three times this month in ways only execution revealed.

## Observed

| Scenario | Subrequests | D1 executions | batches | R2 ops | DO RPCs |
|:--|--:|--:|--:|--:|--:|
| eligibility check on one mailbox (`decidersOf`) | **1** | 1 | 0 | 0 | 0 |
| approve, stages still open | **6** | 6 | 1 | 0 | 0 |
| approve, closes the last stage and releases the send | **6** | 6 | 1 | 0 | 0 |
| deny | **6** | 6 | 1 | 0 | 0 |
| withdraw, request still satisfiable | **6** | 6 | 1 | 0 | 0 |
| withdraw, leaves it unsatisfiable and withholds the send | **6** | 6 | 1 | 0 | 0 |
| `sealManifest`, gated by a **hold** | **11** | 7 | 1 | 2 | 2 |
| `sealManifest`, gated by an **approval** | **13** | 9 | 1 | 2 | 2 |

## The six, named, because a total nobody can break down is a total nobody can dispute

A decision is five reads and one write:

1. the approval row — its state, its mailbox and its author;
2. the eligible deciders on that mailbox, teams resolved and people de-duplicated;
3. the stage set the approval was requested with;
4. every decision taken so far, withdrawn ones included, because a withdrawn decision still excludes its
   decider;
5. the audit chain's tip, which every audited act pays;
6. **one** `batch()` carrying the audit entry, the decision row, and the conditional state changes to the
   approval, the manifest and its recipients.

**All five decision shapes cost the same 6**, and that is the point of doing the completion in SQL rather than
in TypeScript: closing an approval and releasing its send is two more *statements* inside a batch that was
already going, not a second round trip. Same for the withdrawal that withholds a send — three more statements,
one batch, six operations.

## The seal's approval path costs two more, and only on that path

A gated seal reads the stage set of every matching `require_approval` version and the eligible approvers on the
mailbox: **2 operations**, spent only when a policy actually requires approval. A send gated by a hold, or not
gated at all, pays nothing — the same laziness `policy-evaluation-cost.md` records for the two derived
conditions, and for the same reason.

The `approvals` row and its stage rows are **free**, because they ride in the `batch()` the seal was already
making. So is the second audit entry: `auditedBatchMany` builds both entries against one tip read and both
inserts go into the same transaction, which is what makes "a gated send always has a request to decide" a
property rather than a hope.

## Sized

Both values are **bounds with headroom, not the measured figures**, for the reason `butler-step-cost.md`
states: an equality assertion on an I/O count fails on every harmless refactor and gets deleted, while a bound
catches an operation becoming an order of magnitude more expensive.

- `approval.eligibility_max_subrequests = 3` — measured **1**. The headroom is for exactly one foreseeable
  change: #61 named a team-scoped stage constraint absent because `team_members` is read-only and there is no
  `teams` table, and adding one would put a second predicate or a second read in this path.
- `approval.decision_max_subrequests = 10` — measured **6**. Bounded generously because a decision happens on a
  person's request rather than in a loop, and because #62 will add a recheck to the *dispatch* of an approved
  send, not to the decision itself.

## Miniflare, not a deployed Node

Measured under `vitest-pool-workers`, whose D1 is a local SQLite. So what is measured is the **number of
operations Mailda performs**, which is exactly what the subrequest budget is spent in — not their latency, and
not a deployed Node's behaviour. `policy-evaluation-cost.md` and `doctor-check-cost.md` draw the same line for
the same instrument. **No deployed measurement is claimed here.**

## What this is not a bound against

`authz.check.max_queries = 2` bounds one authorization check. An eligibility check is not one: it answers *who
holds this relation on this object* rather than *does this principal hold it*, which is the many-subjects
direction and inherently a different query. It is closer to `authz.list.max_rows_read`'s question, and it is
recorded here rather than folded into that receipt because the row count it reads is bounded by headcount while
that one's is bounded by mailbox count.

What the seal figures spend from is the per-instance subrequest pot `butler-step-budget.md` measured, which is
plan-conditional. `butler-step-cost.md` carries that arithmetic and has been corrected for the approval path's
figure.
