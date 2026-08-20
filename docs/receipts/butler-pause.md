---
id: butler-pause
kind: measured-tripwire
measured_on: 2026-08-21
stale_when: >
  a Node produces a first real corpus of Butler runs whose triggers are replies to the Node's own sends,
  which is the measurement the threshold does not have today and the one that should replace the arithmetic
  below; the human release gate on a Butler-proposed send stops being unconditional, since that gate is what
  currently stands between a self-provoked chain and a sending loop and the threshold is sized against a
  world where it is there; a second detector is added to `PAUSE_REASONS`, which would need its own threshold
  and its own sizing; the pause or loop questions stop being scalar sub-selects on statements the trigger and
  the run already issue, which is what the cost figure is a count of; or `messages.in_reply_to` stops being
  stored bracket-stripped, which is what makes the causal join an equality
values:
  butler.loop_window_seconds: 3600
  butler.loop_max_self_provoked_runs: 3
  butler.pause_check_added_subrequests: 0
---

**One receipt, two kinds of number, and the split is the first thing to read** — `send-breakers.md`'s
layout, because this is the same ticket's second half.

| | Values | Status |
|:--|:--|:--|
| The cost of asking | `butler.pause_check_added_subrequests` | **Measured**, in `workerd`, with `metering()` |
| The threshold and its window | `butler.loop_max_self_provoked_runs`, `butler.loop_window_seconds` | **Sized, not measured** — there is no corpus |

---

## Measured: what evaluating the pause costs

**Measured** in real `workerd` under `vitest-pool-workers` against a real D1, using `src/cost-meter.ts` —
which counts **executions** rather than `prepare`, prices a `batch()` as the one round trip it is, and sees
Durable Object RPCs. `test/butler-pause-cost.measure.test.ts` prints every figure below on each suite run.

| Scenario | Subrequests | D1 executions | Where |
|:--|--:|--:|:--|
| `triggerButlers`, one published Butler, no pause, no loop | **3** | 2 | `test/butler-pause-cost.measure.test.ts` |
| the same call before this ticket, for comparison | **3** | 2 | `test/butler-run-cost.measure.test.ts`, unchanged |
| `triggerButlers`, one published Butler, **paused** | **2** | 2 | `test/butler-pause-cost.measure.test.ts` |
| `triggerButlers`, the delivery that **places** a pause | **4** | 4 (1 batch) | `test/butler-pause-cost.measure.test.ts` |
| `interpret`, a `stop`-only Butler, pause question included | **3** | 3 | `test/butler-pause-cost.measure.test.ts`, and `butler.run_cost_engine_fixed` unchanged at 3 |
| `runDoctor`, claimed Node, no Butlers, delta for the new checks | **+1** | +1 | one-off, below |
| `runDoctor`, claimed Node, delta from no Butlers to one | **+1** | +1 | `test/butler-pause.test.ts` |

`butler.pause_check_added_subrequests = 0` is **pinned as an equality, not bounded with headroom**, for the
reason `butler.run_cost_engine_fixed` is: it is not a measurement of anything external, it is a count of the
statements the check adds, and that count is **none**. A bound with slack would be a tripwire on our own
arithmetic.

**Why it is zero, which is a design property rather than a small number.** Both evaluation points fold into a
statement that was already being issued:

1. **At trigger time**, into the read of published versions. `triggerButlers` already issues
   `SELECT id, butler_id, ast_json FROM butler_versions WHERE org_id = ? AND state = 'published'`; the pause
   fields and both loop counts become correlated sub-selects on `v.butler_id` in that same `SELECT`. **Five**
   scalar sub-selects — three for the pause, one `COUNT(*)`, one `EXISTS` — seven `SELECT`s in all once the two
   nested `EXISTS` chains are counted, and one statement: the shape `checkDeliveryVisibility` and
   `evaluateBreakers` already use. `PAUSE_AND_LOOP_COLUMNS` in `src/butler/pause.ts` is the five.
2. **Once per invocation of a live run**, into the read of `butler_runs.subrequests_spent`. That read is
   already issued once per invocation and is already deliberately **not** inside a `step.do` — a cached step
   would return the first invocation's figure for ever — so it is exactly the hook a resumed instance needs,
   and the pause question rides on it as three more scalar sub-selects.

**How a zero is asserted without running the same process twice.** The trigger's own statements are
enumerable — the delivery facts, and the published-version listing — so the test asserts it issues exactly
`2 + butler.pause_check_added_subrequests` D1 executions. Written that way the figure is load-bearing: split
the pause read into a statement of its own and the test fails until somebody edits this receipt and re-runs
`pnpm receipts`, which is the only way a number changes here. The run side is asserted the same way against
`butler.run_cost_engine_fixed`, which stays **3**.

The paused figure is **lower** than the unpaused one, and that is not a rounding artefact: a paused Butler
starts no run, so the `create` on the workflow binding does not happen — measured, `workflowCalls = 0`. A
pause makes the ingress path cheaper, which is the right direction for a control that exists to stop a
runaway.

The placing figure is **4**: the trigger's two, plus `auditedBatch`'s read of the audit chain's tip and the
one `batch()` carrying the entry and the `butler_pauses` insert together. Paid **once in a Butler's life**,
never per delivery — every later delivery reads the latched row and refuses at the cheaper figure above.
Asserted structurally rather than against a budget, because it bounds nothing.

### The `doctor` delta

**No standing test, and this receipt does not pretend otherwise** — the same statement `send-breakers.md`
makes about its own delta. Measured by running `runDoctor` through `test/outbound-recheck.test.ts`'s
`MEASURE doctor claimed-and-clean` line with `checkButlerPauses` in the list and again with the one line that
calls it removed, then restoring it and re-measuring to confirm the figure came back:

```
without   subrequests=22  d1=16  r2=6  findings=19
with      subrequests=23  d1=17  r2=6  findings=20
```

That fixture is a claimed Node with mail and **no published Butlers**, which is the +1 case. The +1 from
there to a Node with one Butler is a standing assertion in `test/butler-pause.test.ts` instead, because it is
a delta between two runs in one process and therefore measurable without editing the source.

The standing guard on that path is `doctor.max_subrequests_per_run` (220), which
`test/outbound-recheck.test.ts` asserts on every run and which this check does not move.

**+1 and not +2**, and the mechanism is `checkBreakers`': the second statement — the per-address delivery
activity that distinguishes *a Butler that stopped running* from *a Butler nothing triggered* — is issued only
when the first found at least one published Butler. A Node with no Butlers spends one subrequest and gets a
report; a Node with Butlers spends two and gets an answer.

### Miniflare, not a deployed Node

`vitest-pool-workers`' D1 is a local SQLite. What is measured is the **number of operations Mailda
performs**, which is exactly what the subrequest budget is spent in — not their latency, and not a deployed
Node's behaviour. **No deployed measurement is claimed here.**

---

## Sized, not measured: the loop threshold and its window

**No corpus was measured, because none exists.** No Node has ever run a Butler against a real
organization's mail, so nothing is known about how often a legitimate exchange re-triggers the same Butler.
The two numbers below are **tripwires sized by arithmetic**, in AGENTS.md's sense: placed past where any good
widget goes, so only broken things touch them. The first real corpus is this receipt's first `stale_when`
clause.

### What is counted, exactly

A **self-provoked run**: a run of Butler B whose triggering delivery is a reply to a manifest that a run of
**B itself** sealed. Every hop of that is a stored column, and the chain is spelled out in migration 0029.
The reading is the count of self-provoked runs of B inside the window, **plus one** when the delivery in
front of the trigger is itself self-provoked — so the number is *how many links of a chain this Butler made
itself, counting the one being decided*.

### `butler.loop_max_self_provoked_runs = 3`

A Butler that acknowledges an inbound message provokes a reply from a person perhaps once; that person's
reply re-triggers it, which is **one** self-provoked run and is ordinary correspondence. Two inside an hour
is a brisk exchange with a human on the other end. Three inside an hour is already unusual for a person, and
a machine on the other end — an autoresponder, a ticketing system, a second Butler — produces tens or
hundreds inside the same hour.

The comparison is `>`, so the pause is placed as the **fourth** self-provoked delivery arrives and its run
never starts. At most three self-provoked runs happen, so a chain this Butler is driving reaches at most four
messages including the one that started it.

**Cost if wrong, in each direction.** Too low: a genuinely chatty exchange inside an hour stops the Butler,
and an administrator has to resume it with a reason. **That stops automation, not mail** — the customer's
message still arrives, is still filed, is still visible in the mailbox, and a person can still answer it by
hand. Too high: the chain runs longer before latching, and each extra link is a proposed send, a Workflow
instance and a run record. The asymmetry favours the low number, which is the opposite of the volume
breaker's — and it is the opposite because the two failures are not comparable: a wrongly gated *send* delays
a customer's mail, and a wrongly paused *Butler* delays a convenience.

### `butler.loop_window_seconds = 3600`

An hour, the same window `breaker.volume_window_seconds` uses, and for a reason of its own rather than by
inheritance. A mail loop's round trip is seconds to minutes, so an hour contains many links of one; a
legitimate back-and-forth between two people is hours to days, so an hour does not accumulate one. A daily
window would count Monday's exchange into Tuesday's; a ten-minute window would miss a loop whose other end
retries slowly.

### What this detector cannot see, which is the part that must not be overclaimed

**An unthreaded reply.** The causal link is `messages.in_reply_to` matching `send_manifests.rfc_message_id`.
A replying agent that sets no `In-Reply-To`, or a message whose headers did not parse (`parse_error`), has no
link back and is invisible to this count. So the detector catches a loop between this Node and a correspondent
that threads properly, and **misses one that does not**. That is a real gap, it is not closable from these
columns, and `doctor`'s `butler_loop_detection` reports whether this Node is seeing threaded replies at all —
rather than reporting a reassuring zero, which is the `no_observations` failure #66 named.

**A third party in the middle.** Butler sends to X, X's system emits a *new* message rather than a reply, and
that message re-triggers the Butler. Same absence, same reason: no `In-Reply-To` naming our manifest.

**A loop through two Butlers.** A counts as self-provoked only what **A** sealed. A → B → A is not counted for
either, and would need a chain walk rather than a windowed count. Named rather than built: the recursive form
is a different query with a different cost, and nothing has ever observed the simple form.

### And what the detector's teeth actually are today, stated because the obvious reading overstates them

**A Butler-proposed send cannot leave this Node without a person releasing it.** `proposeSend` sets
`releaseRequired: true` unconditionally, and `sealManifest` seals such a send `awaiting` with
`butler_release_required`, which `movableNow` refuses to move. So a self-provoked chain cannot extend itself:
every link needs an administrator to click release.

What this detector therefore stops **today** is a *human-assisted* loop — an operator releasing a stream of
near-identical replies, which is the muted-check failure this repository already names in three other places —
and the runs, instances and release-queue entries behind it. It is **not**, today, the thing standing between
a Butler and a reputation-burning sending loop, because the release gate is. What it is, is the control that
has to exist **before** that gate is ever removed or outranked by a policy: at the moment a Butler can send
without a person, a chain with nothing counting it is a sending loop with no bound at all. That is why the
threshold is low and why the pause latches instead of gating.

**And what a pause does *not* stop, said in the same breath because the sentence above invites the wrong
inference.** A pause stops the Butler from **starting runs** and stops a run in flight from going on. It does
**not** hold the sends that Butler already proposed: those are `send_manifests` rows sitting `awaiting
butler_release_required`, and `releaseButlerSend` acts on the manifest by its own predicate — which names the
gate and the mailbox and says nothing about `butler_pauses`. So after a pause an administrator can still
release the replies the looping Butler queued before it was stopped, and they will dispatch.

That is deliberate rather than overlooked, and it is the same reasoning `releaseButlerSend` already carries
about ordering: *a manifest outlives its run*, and a release is a **person deciding this particular message
should go**, which is exactly the judgement a machine-placed pause is not entitled to overrule. Releasing one
wakes its instance, which then meets the pause and ends `refused butler_paused` — so the released message
leaves and the rest of that run's program does not. The lever for the other reading is `cancelSend`, which is
what an operator who wants the queue emptied rather than released should reach for; `doctor`'s `butler_paused`
finding names the Butler, and `GET /api/sends` lists what is waiting.

---

## What has no number here, and why

**A runs-per-window breaker** — *"Butler B ran more than N times in an hour"*. It is not built, and
**not for want of substrate**: `butler_runs` supports it in one `COUNT(*)`, which is exactly the shape #66's
rate breakers use. It is absent because it has no threshold anybody can defend. A Butler's legitimate run rate
**is** its trigger mailbox's inbound mail rate, so a bound on runs per hour is a bound on how much mail a
customer may receive, and nothing in this repository has measured that for even one organization. A tripwire
sized above every plausible mailbox is a tripwire nothing reaches; one sized below any real mailbox stops a
Node on a busy Monday. Both readings are worse than the absence, and the absence is recorded here rather than
shipped as a number nobody can dispute.

What that leaves uncovered is a **runaway trigger** — a Butler firing constantly on legitimate deliveries —
and the controls that do cover it are elsewhere and are measured: the volume breaker gates the sends
(`send-breakers.md`), and the per-instance subrequest guard stops each run overspending
(`butler-run-cost.md`).

**An expiry on a pause.** A pause with a deadline would restart a Butler because a clock ran out rather than
because somebody decided the problem was over, which is the flapping this design latched to avoid —
`domain-pause.ts` refuses the same thing one level up, in the same words.
