---
id: supervised-notice-scan
kind: measured-tripwire
measured_on: 2026-08-20
stale_when: >
  the notice body gains a field that needs another query per notice; the cron schedule stops being
  one minute; Cloudflare's per-invocation subrequest cap on Workers Free moves away from 1,000; a
  third notification kind arrives whose body costs more than one query to build; or
  cron.propagation_ceiling_seconds moves, since the grace figure below is derived from it
values:
  notify.scan_batch: 50
  notify.overdue_grace_seconds: 3600
---

**Measured:** `apps/node/worker/test/notifications.measure.test.ts`, run under
`@cloudflare/vitest-pool-workers` in the real Workers runtime against a seeded D1, priced with
`metering()` from `src/cost-meter.ts` — the meter that counts **executions** and prices a `batch()`
as the one round trip it is. `doctor.ts`'s meter counts `prepare` and would have been wrong here in
both directions at once, which is what that file's own header warns about.

## What the scan spends

`deliverDueNotifications` is one `SELECT` of the due rows, then per notice the work to freeze what
it says, then **one** `batch()` of conditional `UPDATE`s. So the cost is
`1 + (per-notice body) + 1`, and the per-notice term is the only one that scales.

| Notices due in one tick | D1 executions | batches |
|---|---:|---:|
| nothing due | **1** | 0 |
| 2 × `approval_request` | 4 | 1 |
| 1 × `supervised_read` + 2 × `approval_request` | 6 | 1 |
| 4 × `supervised_read` + 8 × `approval_request` | 18 | 1 |

A `supervised_read` body costs **two** queries: the grant joined to its mailbox, its reader and its
matter, and the grouped count of the three supervised actions in the trail. An `approval_request`
body costs **one**. Every row above is `1 + 2·(supervised) + 1·(requests) + 1`, and the worst case —
a batch that is all supervised notices — is therefore `2n + 2`, which is what the bound is sized
against.

**The idle tick is the figure that matters most and is the easiest to overlook.** This scan runs sixty
times an hour for the lifetime of the Node, and on almost every one of them nothing is due. It costs
**one** query, because `ntf_due` is partial on `delivered_at IS NULL` — a delivered notice leaves the
index for ever, so the seek is into something that empties itself rather than into everything that was
ever owed.

Grants are minted by a three-person ceremony, so the corpus is small by construction; the linearity is
what was checked rather than the absolute size, and it is checked by the decomposition above rather
than by a single total, because a total that drifted would not say which term moved.

## Sized

**50** — a full batch is `2 × 50 + 2 = 102` subrequests against **1,000** on Workers Free
(`doctor-check-cost.md` records that ceiling, and that the 10,000 figure is Paid only). That is
roughly a tenth of the smaller of the two plans' caps, which leaves the same invocation room for
`sweepResponseClocks`, the claim read and anything a later ticket adds to the same trigger. The
`scheduled` handler is one invocation for all of them.

Why 50 rather than the 200 `sweepResponseClocks` uses: that sweep is **one** `UPDATE` for the whole
batch and its cost does not grow with the number of cases, where this one pays two queries per
notice. The two numbers are not the same kind of number and were deliberately not made to match.

**Throughput, which is the thing a bound like this can get wrong.** At one tick a minute, 50 per tick
is 72,000 notices a day. A notice is minted by a supervised grant taking effect — a ceremony
involving three people — or by an approval request, so a Node that owes more than that in a day is
not a Node this figure is failing. A backlog drains at 3,000 an hour and nothing is lost meanwhile:
the scan is a query over due rows, so an unreached notice is simply still due next minute, which is
the property that makes a bound safe here at all.

**Cost if wrong:** too low and a real backlog drains slowly, visible the whole time in `doctor`'s
`supervision_notices_overdue`, which counts what is due and undelivered. Too high and one cron
invocation on Workers Free exhausts its subrequest budget and takes the first-response sweep down
with it — a §7 obligation delivered late is recoverable, and a scheduled handler that dies every
minute is not.

## The grace before `doctor` calls a notice overdue

`notify.overdue_grace_seconds` is **derived**, not measured here, and it exists because the first version
of the check had no grace and reported `degraded` on a Node whose only fault was that the next cron tick
had not happened yet. #61's approval-request notices fall due **immediately** — somebody is waiting on a
decision — so every request opened in the last minute would have made the report degraded. A check that
warns about the ordinary state of a healthy Node is the muted check `DELIVERY_SILENCE_MS` already names in
`doctor.ts`.

Derived from figures `cron-lateness.md` already measured:

| term | value | source |
|---|---:|---|
| trigger propagation after a deploy | **900 s** | `cron.propagation_ceiling_seconds` |
| the schedule itself | 60 s | `wrangler.jsonc`, one-minute crons |
| observed dispatch lateness, p99 | **8.1 s** | `cron.observed_lateness_p99_ms` |
| | **968 s** | the sum: the longest a healthy Node can legitimately owe a due notice |

**Sized:** 3,600 s — 3.7× that sum. The propagation term is the one that dominates and it is the one that
bites hardest, because it applies to a **freshly installed Node**, which is exactly when an operator is
reading `doctor` and least able to tell a real fault from a new one. Below ~1,000 s this check would fire
on every install.

Generous in the direction AGENTS.md asks for: §7's obligation is measured in **days** — the notice falls
due when a matter closes or a grant expires — so an hour of grace costs the person nothing, while a
false `degraded` costs the check its credibility permanently.

**Cost if wrong:** too low and the finding fires on healthy Nodes and gets ignored. Too high and a Node
whose cron trigger was never created looks fine for an hour longer than it should — bounded, and the
`notifications.scan_failed` log line is the faster signal for the case where the scan is running and
failing.
