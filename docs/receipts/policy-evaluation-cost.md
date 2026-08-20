---
id: policy-evaluation-cost
kind: measured-tripwire
measured_on: 2026-08-20
stale_when: >
  Cloudflare Email Routing stops restricting accepted addresses to domains in the customer's own account,
  which is the platform property that makes recipient_external exact without a domains table; a sixth
  condition is added to the five, or one of the five stops being answerable from a column; the two derived
  inputs stop being fetched lazily, which would make every evaluation cost three rather than one;
  send_counters gains a finer grain than org-and-day (#66), which would add a query per grain; a D1 batch()
  stops being one round trip; or evaluation gains or loses an I/O operation for any other reason
values:
  policy.evaluate_max_subrequests: 5
  policy.publish_max_subrequests: 8
---

**Measured:** `apps/node/worker/test/policy-cost.measure.test.ts`, in the real `workerd` runtime against a
real D1 and R2, using `src/cost-meter.ts`. Not counted by reading — the count was read first, in #60's own
resolution, and it was right about the ceiling and wrong about the cost.

## The receipt #60 recorded as owed

#60's resolution stated the figure and then stated its own status, which is why this file exists:

> Evaluation adds at most **three** queries to a seal: one to read matching policies, one for the domain set
> behind `recipient_external`, one for `send_counters`. Two of the three are cacheable within a request.
>
> **Counted by reading, not measured — and that is a hypothesis.** … It cannot be measured before there is an
> implementation, so the figure is recorded as an expectation with a receipt owed.

There is an implementation. `src/cost-meter.ts` exists precisely to settle this class of question: it counts
**executions** rather than `prepare`, prices a `batch()` as the one round trip it is, and sees Durable Object
RPCs — the last of which `doctor`'s meter cannot see at all.

## Observed

| Scenario | Subrequests | D1 executions | batches | R2 ops | DO RPCs |
|:--|--:|--:|--:|--:|--:|
| `evaluate`, no policies at all | **1** | 1 | 0 | 0 | 0 |
| `evaluate`, three column-answerable conditions | **1** | 1 | 0 | 0 | 0 |
| `evaluate`, `recipient_external` in play | **2** | 2 | 0 | 0 | 0 |
| `evaluate`, all five conditions in play | **3** | 3 | 0 | 0 | 0 |
| `evaluate`, thirty published policies | **1** | 1 | 0 | 0 | 0 |
| `publishPolicy` | **5** | 5 | 1 | 0 | 0 |
| `sealManifest`, new thread, no policies | **11** | 7 | 1 | 2 | 2 |
| `sealManifest`, new thread, both derived conditions | **13** | 9 | 1 | 2 | 2 |
| `sealManifest`, reply, both derived conditions | **17** | 11 | 1 | 3 | 3 |

## The hypothesis was right about the ceiling and wrong about the cost

**Three is the ceiling and it is reached only at the worst case.** The ordinary cost is **one**, and the
difference is not an accident of the fixture — it is the reason the matching predicate is evaluated in
TypeScript rather than pushed into SQL.

Every one of the five conditions is a column, so the whole predicate *is* expressible as
`AND (when_x IS NULL OR when_x = ?)`. Two of the five are **derived**: `recipient_external` needs the
organization's domain set, `org_daily_volume` needs today's counter. A pushed-down predicate would have to
bind both inputs before the query could run, spending both queries **whether or not any live policy asks for
them**. Reading the candidate rows first lets each derived input be fetched only when some published policy
constrains it. So a Node with no policies, or with policies on mailbox, actor and reply only, spends **one**
query — and the rows have to be read anyway, because the decision must name *which* policy matched for the
audit trail to answer "which rule applied".

**Two of the three are not cached, and the resolution's word "cacheable" is doing less work than it looks
like.** Nothing here caches anything: laziness is what buys the saving, and it buys more than a cache would,
because a cache still pays once per request while laziness pays zero. Worth stating because *"two of the three
are cacheable within a request"* would otherwise read as an implemented optimization.

**Thirty published policies cost the same as three.** One query either way. What grows with the policy count
is rows read inside one query, not queries — and the subrequest budget is spent in queries. That is the cost
this design accepts, and it is bounded by what a human writes. The figure to watch: if an organization ever
carries hundreds of published policies, the predicate moves into SQL and both derived inputs become
unconditional, trading the common case for the pathological one.

## Sized

The two values are **bounds with headroom, not the measured figures**, for the reason
`butler-step-cost.md` states: an equality assertion on an I/O count fails on every harmless refactor and gets
deleted, while a bound catches a step becoming an order of magnitude more expensive.

- `policy.evaluate_max_subrequests = 5` — measured 1 typical, 3 at the worst case. The bound covers a sixth
  derived condition arriving before this receipt is redone.
- `policy.publish_max_subrequests = 8` — measured 5, and the five are named because a total that cannot be
  broken down is a total nobody can dispute: the `org.admin` check, the draft read, the current-version read,
  the audit chain's tip read, and **one** batch carrying the entry plus both updates. Bounded generously
  because a publication happens on an administrator's request, not in a loop.

## What this is *not* a bound against

**`authz.check.max_queries = 2` is not the budget this spends from**, and #60's resolution says so
explicitly. That receipt bounds one authorization check; policy evaluation is a separate step on the same
request. What this spends from is the per-instance subrequest pot `butler-step-budget.md` measured, which is
plan-conditional — `workflow.paid.subrequest_budget_per_instance` is 10,000 and the Free sibling is 1,000 —
and it matters because a Butler seals in a loop. `butler-step-cost.md` carries that arithmetic and has been
corrected for the seal's new figure.

## Miniflare, not a deployed Node

Measured under `vitest-pool-workers`, whose D1 is a local SQLite. So what is measured is the **number of
operations Mailda performs**, which is exactly what the subrequest budget is spent in — not their latency,
and not a deployed Node's behaviour. `doctor-check-cost.md`'s 18 August correction draws the same line for
the same instrument, and it is the honest boundary of this measurement rather than a caveat added to be safe.

**No deployed measurement is claimed here.** A remote figure would need a Node with policies published on a
real account, and it would measure round-trip latency rather than operation count — a different question from
the one #60 asked.

## The one figure in this file that is not measured, and could not be

`recipient_external` is **exact**, and its exactness is a platform property rather than a measurement:
Cloudflare Email Routing only accepts addresses on domains in the customer's own account, so every domain
appearing in `addresses` is a domain the customer controls, and the internal set derives from those domains
with no new storage. There is no number to measure there — which is why it is the first clause of this
receipt's `stale_when` instead. If that platform behaviour changes, the condition silently starts
mis-classifying internal mail as external, in the *restrictive* direction, and nothing in this Node could
detect it.

## Correction — 20 August 2026 (#61)

The `stale_when` above fired on its last clause: **the seal gained two I/O operations on the
`require_approval` path.** `evaluate()` itself is unchanged — still 1 operation typically and 3 at the worst
case, and every `evaluate` row in the table above was re-measured and is still exact. What changed is what a
*seal* does after evaluation, because #61 made a `require_approval` outcome request an approval.

Re-measured in the same test, same instrument, same runtime:

| Scenario | Was | Now |
|:--|--:|--:|
| `sealManifest`, new thread, no policies | 11 | **11** |
| `sealManifest`, new thread, both derived conditions (`require_approval` + `hold`) | 13 | **15** |
| `sealManifest`, reply, both derived conditions (`require_approval` + `hold`) | 17 | **19** |
| `sealManifest`, gated by a `hold` only | — | **11** |
| `sealManifest`, gated by an approval | — | **13** |

The two new operations are the stage set of every matching `require_approval` version and the eligible
approvers on the mailbox, and they are spent **only on that path** — a hold-gated seal is still 11, measured,
which is the same laziness this receipt already records for the two derived conditions. The `approvals` row, its
stage rows and the second audit entry are free, because they ride in the `batch()` the seal was already making.
Detail in `approval-decision-cost.md`.

**No value in this file changed.** `policy.evaluate_max_subrequests` bounds `evaluate`, which did not move, and
the seal figures were never budget values here — they are the reason `butler-step-cost.md` exists, and that
receipt has its own dated correction for the new worst case.
