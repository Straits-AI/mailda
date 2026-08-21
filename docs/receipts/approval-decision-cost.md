---
id: approval-decision-cost
kind: measured-tripwire
measured_on: 2026-08-21
stale_when: >
  the eligible set gains a second narrowing constraint beyond #73's team, or the team constraint stops being
  resolved by one query over teams and team_members; a decision stops carrying its audit entry, its decision
  row and its state changes in one batch(), which is what makes the act one round trip; the completion
  predicate moves out of SQL into TypeScript, which would turn one batch into a read plus a write; the
  approvals tables gain a column a decision has to read; a D1 batch() stops being one round trip; or the
  seal's approval path gains or loses an I/O operation for any other reason
values:
  approval.eligibility_max_subrequests: 3
  approval.decision_max_subrequests: 10
---

## Correction, 21 August 2026: the team-scoped stage arrived, and the clause that named it fired (#73)

The clause **"the eligible set gains a narrowing constraint — a team-scoped stage is the one #61 named absent,
and it would add a query or a join to every eligibility check"** is now true. #73 built the `teams` table,
membership administration and `policy_stages.team_id`, so a stage may require a member of a named team.

**The clause's prediction was half right, which is why it had to be measured rather than reasoned about.** It
adds a query — `rostersOf`, one statement over `teams LEFT JOIN team_members` — and it adds it **only where a
team is actually named**. `teamsNamedBy` returns nothing for a stage set with no constraint and `rostersOf`
short-circuits an empty request before it prepares anything, so an ordinary gated send pays zero.

**No value moves.** `approval.eligibility_max_subrequests = 3` was sized in the section below with this exact
change named as the one foreseeable use of its headroom; the headroom was spent as predicted, from 1 to 2.
`approval.decision_max_subrequests = 10` covers a team-scoped decision at 7.

**Measured:** same instrument, same file, same run — `metering()` from `src/cost-meter.ts`, in the real
`workerd` runtime, counting executions and pricing a `batch()` as the one round trip it is. Run on
21 August 2026.

| Scenario | Subrequests | D1 executions | batches | R2 ops | DO RPCs |
|:--|--:|--:|--:|--:|--:|
| resolve one team's roster (`rostersOf`) | **1** | 1 | 0 | 0 | 0 |
| resolve **no** teams — a stage set that names none | **0** | 0 | 0 | 0 | 0 |
| `sealManifest`, gated by a team-less approval (control) | **14** | 10 | 1 | 2 | 2 |
| `sealManifest`, gated by a **team-scoped** approval | **15** | 11 | 1 | 2 | 2 |
| a decision on a team-scoped stage | **7** | 7 | 1 | 0 | 0 |
| publishing a team-scoped `require_approval` version | **11** | 11 | 1 | 0 | 0 |

The two seal figures come from **one run of one test**, deliberately, and the assertion is an equality on their
difference rather than a bound on either: the claim being made is *"exactly one more"*, and a bound cannot
express it. The control is measured beside the subject because a figure compared against a number written down
last week is a comparison against a stale receipt, which is the correction this file has now made four times.

**Where the one operation goes, per act:**

- **The seal.** `rostersOf` is called once with every team the folded stage set names, so a chain of two
  team-scoped stages still costs one query, not two.
- **The decision.** One roster read, and only when the **open** stage names a team — a two-stage chain whose
  first stage is unconstrained pays nothing for its first decision and one for its second.
- **The withdrawal.** Same shape, and only for the stages still outstanding: a withdrawal from a fully
  satisfied team-scoped stage asks nothing.
- **Publication.** One `readTeam` per named team plus one `rostersOf`, which is where the existence check
  #73 says was impossible before a `teams` row existed actually happens. Publication is an administrator
  writing a rule, so this is the cheapest place to put the strictest check.

**The team-less seal reads 14 against the 13 recorded in the section below, and that +1 is not this change.**
The evidence is the `seal/hold-gate` control — a path #73 does not touch, with no approval stages in it at all
— which reads **12** against the 11 recorded below, the same +1. It was re-measured on this working tree with
the #73 source changes stashed and read **12** there as well, so the drift predates #73. What was **not**
re-measured stashed is the approval-gate figure, because the stashed tree does not compile against these
tests; that is stated rather than glossed, and the hold-gate control is what the inference rests on.

The drift is recorded here as unexplained rather than folded silently into the new numbers, which is the whole
point of a control: this change's claim is the **difference** of 1 between the two seal rows above, measured in
one run, and that claim does not depend on where the shared 14 came from. Both figures are inside
`butler.step_cost_max_send_propose`, which is what a gated seal is actually bounded by and what
`test/approval-cost.measure.test.ts` asserts.

## Correction, 20 August 2026: the same clause fired again — `expires_at` (#62)

The clause **"the approvals tables gain a column a decision has to read"** fired a second time on the same day,
and for the same structural reason as the first: #62 added `approvals.expires_at` (migration 0022), which is in
`APPROVAL_COLUMNS` and therefore in every `SELECT` `readApproval` and `pendingApprovals` issue.

**No value moves and no measured figure moves: eligibility 1, every decision shape 6, every withdrawal 6, a
gated seal 13, a hold-gated seal 11, a lift request 5, a lift's completing decision 7.** Re-measured the same
way in the same file on 20 August 2026, after the column existed. A column added to a `SELECT` that was already
being issued is free — which is exactly the distinction this clause exists to have *checked* rather than
assumed, and it is the second time checking it has been the whole content of a correction.

**Where the deadline does cost something is the dispatch, not the decision.** `expires_at` is compared by #62's
recheck in `dispatchOne`, whose figures are in `dispatch-recheck-cost.md`. Recorded here so a reader following
the column does not conclude the cost of expiry is missing: it is 0 on this path and part of the 8 on that one.

## Correction, 20 August 2026: the `stale_when` fired — the approvals table gained a column a decision reads

The clause **"the approvals tables gain a column a decision has to read"** is true. #64's legal-hold lift is
this mechanism's second caller, and it does not fit a table keyed on a manifest, so `migrations/0021_hold_lift.sql`
renamed `manifest_id` to `subject_id`, added `subject_kind`, and renamed `author_user_id` to `actor_user_id`.
Every decision now reads `subject_kind` — it is in `APPROVAL_COLUMNS` and it decides which completion statements
run — so the clause names exactly what happened.

**No value moved, and the measured figures for a send are unchanged: 1 for eligibility, 6 for every decision
shape.** A column in a `SELECT` that was already being issued costs nothing, which is the distinction this
receipt's own *"a column a decision has to read"* clause exists to have checked rather than assumed. Re-measured
the same way, in the same file, on 20 August 2026.

### What a lift costs

Same instrument, same file, same run — `metering()` from `src/cost-meter.ts`, counting executions, pricing a
`batch()` as the one round trip it is:

| Scenario | Subrequests | D1 executions | batches | R2 ops | DO RPCs |
|:--|--:|--:|--:|--:|--:|
| request a lift (`requestHoldLift`) | **5** | 5 | 1 | 0 | 0 |
| approve a lift, stage still open | **6** | 6 | 1 | 0 | 0 |
| the approval that **applies** the lift | **7** | 7 | 1 | 0 | 0 |
| the coverage check on the deletion path (`coveringHolds`) | **1** | 1 | 0 | 0 | 0 |

The request is five: the administrator check, the hold row, the eligible set, the audit chain's tip, and **one**
`batch()` carrying the `approval.requested` entry, the `hold_lifts` row, the `approvals` row and its stage.

The completing decision is **one more than a send's 6**, and the one is the `hold_lifts` row — read because the
`hold.lifted` entry has to name the reason the lift was asked for, and an investigator should not have to join
two tables to learn why destruction was re-permitted. Everything else is free for the reason the section below
gives about the seal: the second audit entry and the `UPDATE holds` ride in the `batch()` the decision was
already making. That is what makes *"the lift and its record are one act"* a property of the transaction rather
than a claim.

**Both are bounded against `approval.decision_max_subrequests = 10`, and no new budget key was minted.** A lift
request is an approval request; a separate key would be a number with no separate measurement behind it, and
`budget-plan-scope.test.ts` would have had to classify a key that means the same thing as one that exists.
Headroom against the measured 7 is 3.

**Miniflare, not a deployed Node** — the same boundary the section at the end of this file states, for the same
reason.

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

- `approval.eligibility_max_subrequests = 3` — measured **1**, and **2** once a stage names a team (#73). The
  headroom was reserved for exactly one foreseeable change — *"#61 named a team-scoped stage constraint absent
  because `team_members` is read-only and there is no `teams` table, and adding one would put a second
  predicate or a second read in this path"* — and that change has now landed and spent it as predicted. One of
  the three remains.
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
