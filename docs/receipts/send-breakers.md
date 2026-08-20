---
id: send-breakers
kind: measured-tripwire
measured_on: 2026-08-20
stale_when: >
  a Node produces a first real corpus of attributed delivery outcomes, which is the measurement none of the
  three rate thresholds has today and the one that should replace the arithmetic below; Cloudflare publishes
  a daily sending quota (send.daily_limit_is_published is 0 today), which would give the volume breaker a
  platform ceiling to sit under rather than an order-of-magnitude argument; Cloudflare's per-recipient
  accounting changes (send.counts_per_recipient), which would change what the volume window is counting;
  the breaker evaluation stops being one D1 statement, which is what the cost bound is a bound on; or a
  fourth rate breaker is added, which would add a scalar sub-select to the same statement
values:
  breaker.volume_window_seconds: 3600
  breaker.volume_max_recipients: 500
  breaker.bounce_window_seconds: 21600
  breaker.bounce_min_observations: 20
  breaker.bounce_max_percent: 30
  breaker.complaint_window_seconds: 86400
  breaker.complaint_min_observations: 50
  breaker.complaint_max_percent: 5
  breaker.evaluate_max_subrequests: 2
---

**One receipt, two very different kinds of number, and the split is the first thing to read.**

| | Values | Status |
|:--|:--|:--|
| The cost of asking | `breaker.evaluate_max_subrequests` | **Measured**, in `workerd`, with `metering()` |
| The thresholds | the other eight | **Sized, not measured** — there is no corpus to measure |

Conflating those two is the defect this file is written to avoid. The cost figure has an instrument behind
it and a test that re-runs it. The thresholds have arithmetic behind them, and the arithmetic is written
out below so it can be disputed rather than inherited.

---

## Measured: what evaluating the breakers costs a send

**Measured** in real `workerd` under `vitest-pool-workers` against a real D1, using `src/cost-meter.ts` —
which counts **executions** rather than `prepare`, prices a `batch()` as the one round trip it is, and sees
Durable Object RPCs.

**Every row names the file that produces it**, because these figures come from three different places and a
table that cites one file for all of them is a receipt somebody cannot re-run. Two of the three rows below
are printed by a standing test on every suite run; the third is a one-off delta, and it is labelled as one.

| Scenario | Subrequests | D1 executions | Where it is measured |
|:--|--:|--:|:--|
| `evaluateBreakers`, nothing sent, nothing observed, no pause | **1** | 1 | `test/breaker-cost.measure.test.ts` |
| `evaluateBreakers`, all three rates with rows inside the window | **1** | 1 | `test/breaker-cost.measure.test.ts` |
| `evaluateBreakers`, a pause in force on the sending domain | **1** | 1 | `test/breaker-cost.measure.test.ts` |
| `doctor`, a bare claimed Node, delta for both new checks | **+1** | +1 | one-off, below |

**The `doctor` delta has no standing test and this receipt does not pretend otherwise.** It was measured by
running `runDoctor` on a bare claimed Node with `checkBreakers` in the list and again with it removed — 18
subrequests without, 19 with, 14 → 15 D1 queries, R2 unchanged at 4 — and re-measured the same way on
20 August 2026 during review, reproducing both figures. The standing guard on that path is
`doctor.max_subrequests_per_run` (220), which `test/outbound-recheck.test.ts` asserts on every run and which
this check does not move. The absolute that file *prints* is 20, from a fixture that has mail in it, so it is
not the same number and is not comparable to the 19 above; the **delta** is the evidence, which is how every
figure in `doctor-check-cost.md` is recorded.

**One, in every case, and that is a design property rather than a small number.** All seven questions —
the volume count, the bounce numerator and denominator, the complaint numerator and denominator, whether
*this* domain is paused, and how many domains are paused at all — are scalar sub-selects inside a **single**
`SELECT`, the shape `checkDeliveryVisibility` already uses in `doctor.ts`. Four statements would have cost
four subrequests on the seal path *and* on the dispatch path, and the dispatch path has a measured bound with
four subrequests of headroom in it (`dispatch-recheck-cost.md`).

The seventh sub-select is what keeps `doctor` at +1 rather than +2: it answers *are any domains paused*, so
the listing statement is issued on a Node that has one and skipped on every Node that does not. Measured
before and after — see `doctor-check-cost.md`'s dated correction, where the check was briefly +2 while the
comment beside it claimed +1.

`breaker.evaluate_max_subrequests = 2` is a **bound with headroom, not the measured figure**, for the
reason `butler-step-cost.md` states: an equality on an I/O count fails on every harmless refactor and
gets deleted. Two catches the one change that matters — somebody splitting the statement — without
failing on anything else.

### What this did to the two paths it lands on

Re-measured in the same runtime with the same instrument. **The seal and the dispatch figures are printed by
two different test files**, and the file is named per row rather than once for the table — the seal is
measured here because this ticket added the statement, and the dispatch figures belong to the receipt that
already bounded that path:

| Path | Before | After | Printed by |
|:--|--:|--:|:--|
| `sealManifest`, new thread, no policies | 11 | **12** | `test/breaker-cost.measure.test.ts` |
| `dispatchOne`, unapproved | 16 | **17** | `test/outbound-recheck.test.ts` |
| `dispatchOne`, approved (full §18 recheck) | 24 | **25** | `test/outbound-recheck.test.ts` |
| recheck delta (unchanged, and that is the point) | 8 | **8** | `test/outbound-recheck.test.ts` |

`send.dispatch_unapproved_max_subrequests` is 20 and `send.dispatch_approved_max_subrequests` is 28, so
neither bound moves. Recorded here rather than only in `dispatch-recheck-cost.md` because #60 and #62
have both moved the seal path this week and the next reader should be able to see all three figures in
one table rather than reconstructing them from three receipts.

### Miniflare, not a deployed Node

`vitest-pool-workers`' D1 is a local SQLite. What is measured is the **number of operations Mailda
performs**, which is exactly what the subrequest budget is spent in — not their latency, and not a
deployed Node's behaviour. `doctor-check-cost.md`'s 18 August correction draws the same line for the same
instrument. **No deployed measurement is claimed here.**

---

## Sized, not measured: the three rate thresholds

**No corpus was measured, because none exists.** This Node has never observed a real organization's
bounce rate, and `doctor` reports the reason it might never have — a Node whose Email Sending event
subscription was never created sees zero events for ever (`delivery_visibility`). So the eight numbers
below are **tripwires sized by arithmetic**, in AGENTS.md's sense: placed past where any good widget
goes, so only broken things touch them. Each is stated with what it trades off, and the first real corpus
is this receipt's first `stale_when` clause.

The one external figure used is in-repo and dated: `docs/receipts/cloudflare-email-sending.md` records
`send.paid.included_per_month = 3000` and `send.counts_per_recipient = 1`, measured 4 August 2026. It is
**documented, not measured here**, and nothing below is derived from it arithmetically — it fixes the
order of magnitude an ordinary Node operates at, and that is all it is asked to do.

### Volume — `3600` seconds, `500` recipients

3,000 recipients a month included on Paid is about **100 a day**, so an ordinary Node's hourly rate is
single digits. 500 in an hour is roughly 5× the whole day's ordinary traffic arriving inside one hour,
and 12,000 a day if it were sustained — four months of the included quota in a day. Nothing a person
composes reaches that; a loop, a compromised session, or a Butler with a fan-out bug does.

**What the window trades off.** An hour rather than a day, deliberately. A daily window forgives a spike
at 23:00 at midnight and punishes one at 01:00 for twenty-three hours, and the recovery from a false trip
is a day of stopped mail — which is the outage-waiting-for-somebody this design rejected manual reset
over. An hour bounds the delay to an hour. It also means a genuine bulk announcement of 600 recipients
goes out in two hours instead of one, which is the cost, and it is why volume **gates** rather than
refuses: the mail is still wanted.

**Cost if wrong, in each direction.** Too low: legitimate mail is delayed by up to an hour, visibly, with
`retryAfterSeconds` on the row. Too high: a runaway sends up to 500 messages an hour until somebody
notices. The asymmetry favours generosity, which is why 500 rather than 200.

### Bounce rate — `21600` seconds, at least `20` observations, `30` per cent

A bounce is the receiving server refusing the address. A rate of 30% means **one address in three** is
being refused, which no correctly-maintained recipient list produces; it is what a leaked list, a
mangled merge field or a loop replying to a dead address produces. Deliverability practice treats a
*sustained* few per cent as a reputation problem — this is a tripwire rather than an SLO, so it sits an
order of magnitude past the number anybody would call unhealthy, and a Node whose rate is 8% has a
problem this breaker deliberately will not tell it about. That is what a tripwire is for, and it is why
`doctor` reports the observed rate whether or not it is over.

**`breaker.bounce_min_observations = 20` is the load-bearing one.** One bounce out of two attributed
outcomes is 50% and means nothing at all. Below twenty observed outcomes inside the window the breaker
reports `armed: false, reason: no_observations` and permits the send — the denominator floor, and the
same floor `doctor` reads to refuse to arm a breaker that cannot see.

**Six hours rather than one**, because bounces arrive late: a receiving server may defer for hours before
refusing, so a one-hour window would mostly contain sends whose outcomes have not come back yet and would
compute a rate over the fastest failures only.

### Complaint rate — `86400` seconds, at least `50` observations, `5` per cent

A complaint is a person pressing *this is spam*. It is a far stronger signal than a bounce and far rarer:
mailbox providers act on complaint rates well under one per cent. 5% is therefore already deep into
"this Node is sending mail people did not ask for" — the case an abuse breaker exists for — while
staying an order of magnitude clear of the rate a single annoyed recipient of a small Node can produce
single-handedly.

**Twenty-four hours and fifty observations**, both larger than the bounce breaker's, for one reason:
complaints are rare, so a short window or a low floor would compute a percentage out of two or three
events. Fifty observed outcomes in a day is a Node that is genuinely sending; below that, `armed: false`.

**Why this one still gates rather than refuses**, even though a complaint is the most reputational of the
three: the individual message in front of the breaker is not the one anybody complained about, and
refusing it discards mail somebody wants over a fact about a *different* message. #66's split holds —
rate breakers gate, abuse breakers refuse — and the abuse breaker for this case is the domain pause,
which a person places.

### What has no number here, and why

**Loop detection.** #66 excluded it and this receipt records the reason as an absence rather than a
threshold: detecting a loop needs a per-Butler-run causal record, and nothing records per-run outcomes
at all — Layer 4 is unbuilt. A breaker needs a denominator, and for loops there is nothing to count.
Tracked with the Butler pause on its own issue.

**A `send_counters`-based volume limit.** Rejected in the migration and again here: it is a maintained
cell that can drift from the rows it summarises, and its grain is a calendar day rather than a window.
