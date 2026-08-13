---
id: butler-step-cost
kind: measured-tripwire
measured_on: 2026-08-14
stale_when: >
  a node's implementation gains or loses an I/O operation; the vault key fetches become cached, which would
  remove one to two subrequests from every evidence read and write; the per-instance subrequest budget in
  butler-step-budget.md changes; a batch stops being one round trip; or a node type is added to the shipped
  set without a measurement here
values:
  butler.step_cost_max_case_assign: 8
  butler.step_cost_max_case_close: 3
  butler.step_cost_max_draft: 10
  butler.step_cost_max_send_propose: 20
---

**Measured:** `test/butler-step-cost.measure.test.ts`, in the real `workerd` runtime against a real D1 and R2,
using `src/cost-meter.ts`. Not counted by reading — the counts were read first, and one of them was wrong.

## Why a new instrument was needed before a number

`doctor.ts` already had a cost meter and it could not do this job. It counts **`prepare`** rather than
execution, prices a `batch()` at its statement count rather than as one round trip, and cannot see Durable
Object RPCs at all. For `mail.send.propose` it would have reported **6** against a measured **10** — a 40%
undercount, and a `maxItems` derived from it would have been 40% too permissive, which is the direction that
fails under load.

`test/node/doctor-meter-honesty.test.ts` pins why doctor's own figure is nonetheless true, and says the meter
must not be reused. `src/cost-meter.ts` is what to use instead.

## Observed

| Node | Subrequests | D1 executions | batches | R2 ops | DO RPCs |
|:--|--:|--:|--:|--:|--:|
| `case.close` | **1** | 1 | 0 | 0 | 0 |
| `case.assign` | **5** | 5 | 0 | 0 | 0 |
| `draft` | **5** | 3 | 0 | 1 | 1 |
| `mail.send.propose`, new thread | **10** | 6 | 1 | 2 | 2 |
| `mail.send.propose`, reply | **14** | 8 | 1 | 3 | 3 |
| `guard`, `switch`, `join`, `wait`, `stop`, `transform`, `validate` | **0** | — | — | — | — |

Three results worth more than the totals.

**Fifty recipients cost exactly what one costs — 10 either way, measured.** The per-recipient inserts ride
inside a single `batch()`, so recipients are free. The old meter would have counted fifty, and a loop sized
against that would have been wrong by a factor of fifty in the *conservative* direction, which is its own
problem: an unusably small bound gets raised by whoever hits it, without re-measuring.

**A reply costs 14, not the 13 that was counted by reading.** One operation was missed. The gap is small and
the lesson is not: a figure read off the source is a hypothesis, and this is the second time today that
counting-by-reading has been off by one in a way only execution revealed.

**Both vault key fetches are uncached, and they are visible now.** `openingKey` on every evidence read,
`sealingKey` on every write, each a fresh Durable Object RPC — 2 of the 10 for a new-thread send and 3 of the
14 for a reply. This is the single most promising thing to change if a Butler ever needs a cheaper send, and
it was invisible to the previous instrument.

## The arithmetic a checker has to do

`butler-step-budget.md` measured **10,000 subrequests per Workflow *instance*** — one pot for the whole run,
not per step. At the reply-send bound of 20:

```
10,000 / 20  =  500 sends exhausts an entire run
```

So **a `foreach` of 500 sending items consumes the whole budget**, and a loop of 200 — the number this
repository reaches for elsewhere — spends 4,000, which is 40% of the run in one step.

**This is why the checker cannot price a loop in isolation.** `maxItems` must be checked against what the
rest of the AST already spends, and the AST ticket's publication-time refusal therefore needs the whole
graph's cost, not the loop's. Stated as a rule: *sum the fixed cost of every non-loop node, add
`maxItems × per-item cost` for each loop, and refuse if the total exceeds the budget with headroom.*

## Sized

The four values are **bounds with headroom, not the measured figures**, and deliberately so. An equality
assertion on an I/O count fails on every harmless refactor and gets deleted; these exist to catch a node
becoming an order of magnitude more expensive, which is what makes a derived `maxItems` unsafe.

- `butler.step_cost_max_case_assign = 8` — measured 5.
- `butler.step_cost_max_case_close = 3` — measured 1.
- `butler.step_cost_max_draft = 10` — measured 5.
- `butler.step_cost_max_send_propose = 20` — measured 10 new-thread, 14 reply. The bound covers the reply
  with room, and is the figure the loop arithmetic above uses.

## What is deliberately not here

**CPU.** It cannot be metered from inside a Worker: `authz-check-rows-read.md` records that
`performance.now()` is Spectre-clamped and reported `p50 = 1.000ms` for every scenario including the
pathological one. The one measured CPU cliff in this repository is in the render path —
`body-render-bounds.md` measured 34,952 ms for 50,000 attributes, past the limit, request killed — and no node
in the shipped set reaches it, because `template.render` was moved to reserved-and-rejected on finding that
no template subsystem exists. **Which limit binds first, CPU or subrequests, is therefore unestablished**, and
the two CPU figures in circulation for a Workers invocation (5 minutes, 30 seconds) have not been reconciled
either. The subrequest bound is the one with a measurement behind it, so it is the one the checker uses.
