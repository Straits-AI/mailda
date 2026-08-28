---
id: doctor-check-cost
kind: measured-tripwire
measured_on: 2026-08-28
stale_when: >
  Cloudflare changes the per-invocation subrequest ceiling on either plan again, the Worker starts declaring a
  limits.subrequests block (which would override the platform default), R2 head stops counting as a
  subrequest, doctor gains a check that costs a subrequest per row, or the measured cost of a
  doctor run changes materially — including any new fixed-cost check, which is what made the
  4 August figure stale
values:
  doctor.evidence_sample_size: 200
  doctor.paid.max_subrequests: 10000
  doctor.free.max_subrequests: 1000
  doctor.max_subrequests_per_run: 220
---

## Correction, 28 August 2026: a third search finding that costs no subrequest

`body_index_failed` (#107's state machine) reports what the body index gave up on, separately from how much
work is left. Measured on the same fixture: **28 subrequests, 26 findings** — one more finding and **the same
cost**.

That is not luck. `bodyIndexState` replaced `unindexedBodies` and answers a `GROUP BY` over the same table in
one query, so two findings now come from where one did. A second query would have been the obvious
implementation and would have cost a subrequest for a number the first query already had.

Worth recording because the previous correction's figure — `findings=25` — went stale the moment the state
machine landed, and a receipt that quietly disagrees with the suite is the thing this file has now written
three paragraphs about.

## Correction, 27 August 2026: two search-index checks, two new subrequests — and a baseline that had drifted unrecorded (#107)

`search_index_backlog` and `body_index_backlog` count the messages not yet in each search index, so a person
searching for last month's mail can tell *"no such message"* from *"this Node is still catching up"*. Each is
one aggregate query with no R2 and no per-row cost.

Measured by removing the check and re-running the same fixtures in the same session:

```
without   subrequests=26  d1=20  r2=6  findings=23
with      subrequests=28  d1=22  r2=6  findings=25
```

**+2 subrequests, +2 D1 queries, +2 findings** — one for the subject index's backlog and one for the body
index's. It was +1 when only the subject index existed; #107's second layer added `body_index_backlog` on the
same day, and this correction records the pair rather than pretending the first measurement is still current.

**Two findings rather than one number, deliberately.** The two backfills have different costs and different
failure modes: the subject index catches up 500 messages a minute from one D1 statement, and the body index 25
because each one is an R2 read, a key unwrap, a decryption and a MIME parse. On any real archive the second
figure falls twenty times more slowly, and a combined number would look alarming while nothing was wrong — so
an operator gets two numbers and can tell which is stuck.

Against `doctor.max_subrequests_per_run = 220` the deployed run now sits at 28, which is 7.9× inside the
tripwire. The figure does not move.

`unindexedMessages` is one prepare and one execution, and `search.ts` is now listed in
`doctor-meter-honesty.test.ts`'s `DOCTOR_PATH`. That file also holds two **writes** — `indexMessage` and
`backfillSearchIndex` — which `runDoctor` never reaches: the first runs only in the ingest batch and the
second only from the scheduled handler. The guard reads the file rather than the call graph, so the argument
has to be that they are unreachable from here rather than that they do not exist, which is the same argument
`recovery.ts` carries.

### The baseline was already stale by three subrequests, and that is worth recording

The correction below records `with subrequests=23 d1=17 r2=6 findings=20` as of 21 August. The measured
baseline immediately before *this* change was **26 / 20 / 6 / 23** — three subrequests and three findings
higher, on the same fixtures.

So checks were added between those two dates without this receipt being corrected, and `stale_when` names
exactly that case: *"including any new fixed-cost check, which is what made the 4 August figure stale"*. The
tripwire did not fire because 220 is generous, which is precisely how a measured figure rots — the assertion
that guards it is a ceiling, and a ceiling says nothing while there is headroom. What this correction can
honestly do is record the current baseline and the delta it measured; attributing the three to particular
checks after the fact would be reconstruction, and this file is for measurements.

**What would have caught it:** an assertion on the *number* rather than on the ceiling. Not proposed here as
a change, because a run cost that must be updated on every legitimate new check is the kind of assertion that
gets muted — but the alternative is this paragraph, and it is the second time this file has had to write one.

## Correction, 21 August 2026: three new checks, one new subrequest — and a second that a Node without Butlers never spends (#75)

The **"any new fixed-cost check"** clause fires again. #75's Butler pause needs `doctor` for a reason the rate
breakers did not: a paused Butler produces **no runs**, so what it looks like is silence, and silence is what
this file exists to distinguish from health. Three findings, from one statement — `butler_paused`,
`butler_run_silence` and `butler_loop_detection`.

**Measured before and after, on the claimed-and-clean fixture in `test/outbound-recheck.test.ts`, by removing
the one line that calls `checkButlerPauses` and putting it back:**

```
without   subrequests=22  d1=16  r2=6  findings=19
with      subrequests=23  d1=17  r2=6  findings=20
```

Restored and re-measured to confirm the figure came back, which is the method every correction in this file
uses.

**+1 and not +3**, because the pause fields, the run counts and both loop-visibility figures are correlated
sub-selects on one read of `butler_versions` — the shape `checkDeliveryVisibility` and `evaluateBreakers`
already use here. And **+1 and not +2** on a Node with no Butlers: the second statement, the per-address
delivery activity that separates *a Butler that stopped running* from *a Butler nothing triggered*, is issued
only when the first read found a published Butler. That is `checkBreakers`' own conditional-listing mechanism,
and the delta from no Butlers to one is asserted as a standing test in `test/butler-pause.test.ts` (**45 → 46**
on its fixture, printed as `MEASURE doctor no-butlers` / `MEASURE doctor one-butler` on every suite run) rather
than by editing source, because it is measurable between two runs in one process. The absolute figures differ
from the 22/23 above because it is a different fixture — what is asserted there is the **delta**, which is the
only part either fixture agrees on.

**The one residual, named rather than glossed:** that second statement is a `GROUP BY` over
`ingress_receipts`, bounded by the earliest publication among live Butlers and **not** by a constant, so its
*rows read* grow with inbound volume. This receipt's `stale_when` watches for "a check that costs a subrequest
per row", which this is not — it is one subrequest whichever it finds — and `checkDeliveryVisibility` has been
in the same position since Layer 2. Stated because the honest form of that clause is about subrequests, and
somebody reading it for rows should find the answer here.

Full receipt for the feature: `docs/receipts/butler-pause.md`.

---

## Correction, 20 August 2026: one new fixed-cost check, `send_evidence_changed` (#62)

The clause **"including any new fixed-cost check"** fires, and this time it fires plainly rather than partly.
#62 gives `doctor` a finding it did not have: sends this Node withheld because a stored body no longer hashed to
what its manifest recorded. Before it, the mechanism had no observable — a hash mismatch produced an outbox row
and a log line, and nothing an operator runs would surface it.

**Measured on the same claimed-and-empty Node, before and after the check existed: 13 → 14 subrequests**
(10 → 11 D1, R2 unchanged at 3), findings 13 → 14. On an **unclaimed** Node the figure does not move at all:
**6 both ways**, because the check returns a literal before spending anything — the shape
`draft_bodies_stranded` and `legal_holds_active` already use.

**Per run, not per row: 14 with one mismatched send and 14 with none.** One query, whichever it finds, and it is
a *seek into an empty index* on a healthy Node — `sm_evidence_changed` (migration 0022) is partial on
`state_reason = 'evidence_changed'`, so nothing has to be scanned to learn that nothing is wrong. That is the
property this receipt's own clause about "a check that costs a subrequest per row" is watching for, and it is
read from the query plan in `test/outbound-recheck.test.ts` rather than asserted here.

Method as in the corrections below: `runDoctor` reading `report.cost` off the run itself under
`vitest-pool-workers`, on 20 August 2026, taken at three catalog states — unclaimed, claimed and clean, claimed
with one withheld send — because a two-point measurement could not have separated the per-run cost from the
per-row one.

`doctor.max_subrequests_per_run = 220` still holds with room to spare and `values:` is untouched, for the reason
the correction below gives: the numbers in it are deployed-Node measurements, and 13 → 14 was taken against
miniflare. **Only the delta transfers**, because it is one extra call on a fixed path.

## Correction, 20 August 2026: the hold check gained a query, and it is conditional on a hold existing (#64)

The clause **"including any new fixed-cost check"** is the one a reader will reach for, and this time it fires
only *partly* — which is the whole content of the measurement, so it is recorded rather than left to be
rediscovered.

`doctor` lost a check and gained two. **Gone:** `legal_hold_lift_path`, whose entire content was the sentence
*"there is no way to lift a legal hold on this Node"* — now false, since #64's lift is built. It cost nothing:
it was a literal. **New:** `legal_hold_lift_pending`, built from columns `holdsForReport` already joins, and
`legal_hold_unliftable`, which asks `decidersByMailbox` who could approve a lift — **one query, for the whole
organization, and only when a hold is in force.**

**Locally measured, on a claimed Node with an empty catalog: 13 → 13 subrequests** (10 D1 / 3 R2, unchanged),
findings 13 → 13. **With one hold in force: 14** (11 D1 / 3 R2). **With three holds: 14** — the same, which is
the per-run-versus-per-row distinction this clause exists to separate, and it is asserted rather than stated
(`test/legal-hold.test.ts`, "costs the same for three holds as for one"). On an **unclaimed** Node the figure
does not move at all: 6 both ways, the same shape `draft_bodies_stranded` has, because the check returns before
it spends anything.

Method, identical to the corrections below so the figures are comparable: `runDoctor` reading `report.cost` off
the run itself under `vitest-pool-workers` (`pnpm vitest run`), on 20 August 2026, taken at four catalog states
rather than two — no organization, claimed and empty, one hold, three holds — because the delta this time is
*conditional* and a two-point measurement would have reported it as either zero or one and been wrong either
way.

The conditionality is deliberate and asserted in the same file ("spends nothing on eligibility when no hold is
in force"): a clean Node must not pay for a question about holds it does not have. It is also why that
neighbouring test now compares **one** hold against three rather than zero against three — its name always said
one, and against zero it would have failed for the right reason with the wrong message.

`doctor.max_subrequests_per_run = 220` still holds with room to spare, and `values:` is untouched: every number
in it is a deployed-Node measurement, and 13 → 14 was taken against miniflare — a different D1, a different R2,
a different catalog. **Only the delta transfers**, because it is one extra call on a fixed path.

## Correction, 13 August 2026: this receipt shipped stale

`doctor.max_subrequests` — since 19 August 2026 `doctor.paid.max_subrequests`, see the correction below headed
*"the cap this file prints was a Paid figure with no plan in its name"* — was **1000**, and the `stale_when`
above named the exact condition that
invalidated it — *"Cloudflare changes the 1,000-subrequest per-invocation cap"*. Cloudflare changed it on
**11 February 2026**, roughly six months **before** this receipt's own `measured_on` of 5 August. So the
figure was wrong on the day it was written, and the staleness condition was already true when it was
recorded.

The Paid default is now **10,000 subrequests per invocation**, configurable up to 10 million via a
`limits.subrequests` block. `apps/node/worker/wrangler.jsonc` declares no `limits` block, and ADR 25 refuses
Workers Free at install, so **10,000 is the live ceiling for every supported Node**.

Two things this had already broken:

1. **`doctor` printed the false number to the operator.** `doctor.ts` renders *"Cap is ${…} per
   invocation"* straight from this value, so every diagnostic run told a human the ceiling was 1,000. It
   reads the budget rather than a literal, so correcting the value here corrects the message.
2. **`reseal.batch_size = 100` was derived from the withdrawn cap** in `evidence-lifecycle.md`. Corrected
   there; the batch size itself is unchanged, deliberately, because a bound that is now generous is not
   thereby wrong and raising it needs its own measurement.

**The transferable finding is about `stale_when` itself.** It is prose describing a condition in the world,
nothing checks it, and this receipt proves that a `stale_when` naming precisely the right trigger provides no
protection on its own. `doctor.max_subrequests_per_run = 220` — the tripwire that actually fires — was never
affected, which is the argument for tripwires over documented conditions and is worth carrying into any
receipt that leans on a platform figure.

## Correction, 18 August 2026: the `stale_when` fired, and the recorded run cost is now stale

The clause **"including any new fixed-cost check"** is true again. `doctor` gained
`draft_bodies_stranded` (#67): one `R2Bucket.list()` of `${orgId}/drafts/` and one `SELECT body_key FROM
drafts`, reporting draft bodies that no code path in the Worker can collect. Recorded here rather than
left for the next reader to notice, because the last time this clause fired the receipt simply carried
the wrong figure for six months.

**Locally measured delta: 10 → 12 subrequests** (8 D1 / 2 R2 → 9 D1 / 3 R2), so **+1 D1 query and +1 R2
`list`**, fixed per run rather than per object. Method: `runDoctor` on a **claimed** Node with an empty
catalog — no receipts, no drafts, no mail — reading `report.cost` from the run itself, under
`vitest-pool-workers` (`pnpm vitest run`), taken twice: once with the new check wired into `runDoctor`
and once with that one line commented out. On an **unclaimed** Node the figure does not move at all (6
both times): with no org there is no draft prefix, and the check returns before it spends anything.

**This is not the deployed number and must not be read as one.** The 20-subrequest figure in *Measured
cost of a full run* below was taken against `mailda.swmengappdev.workers.dev`; 10 → 12 was taken against
miniflare, which is a different D1, a different R2 and a different catalog. The two are not comparable in
absolute terms — only the *delta* transfers, because it is two extra calls on a fixed path. **The
deployed figure needs a redeploy to remeasure**, and `values:` above is deliberately untouched until
that run happens: every number in it is a deployed-Node measurement, and replacing one with a miniflare
reading would quietly change what the file means.

Nothing about the tripwire moved: `doctor.max_subrequests_per_run = 220` still holds with room to spare,
and it is per-run cost — not per-row — that grew, which is the distinction the clause exists to separate.

## Correction, 19 August 2026: the `stale_when` fired again — legal hold added a fixed-cost check

The clause **"including any new fixed-cost check"** is true for the third time. `doctor` gained the legal-hold
findings (#64): one `SELECT … FROM holds LEFT JOIN mailboxes` per run, reporting every active hold with its
scope and age, the holds whose mailbox no longer exists, and the **absent lift path**. Recorded here for the
reason the 13 August correction gives: the last time this receipt let a fired clause pass unrecorded it
carried a wrong figure for six months.

**Locally measured delta: 12 → 13 subrequests** (9 D1 / 3 R2 → 10 D1 / 3 R2), so **+1 D1 query and no R2
call**, fixed per run rather than per hold. Method, identical to the 18 August correction so the two deltas
are comparable: `runDoctor` on a **claimed** Node with an empty catalog — no holds, no receipts, no drafts, no
mail — reading `report.cost` from the run itself under `vitest-pool-workers` (`pnpm vitest run`), taken twice,
once with `checkHolds` wired into `runDoctor` and once with that one line commented out. On an **unclaimed**
Node the figure does not move at all (6 both times): with no organization the check returns before it spends
anything, the same shape as `draft_bodies_stranded`.

**Three holds cost the same as one**, which is the distinction this clause exists to separate, and it is
asserted rather than stated: `test/legal-hold.test.ts` ("costs one fixed query, not one per hold") compares
`report.cost.d1Queries` for a run with one hold against a run with three and requires them equal.

**Not the deployed number.** Same caveat as 18 August: the 20-subrequest figure under *Measured cost of a full
run* was taken against `mailda.swmengappdev.workers.dev`, and 12 → 13 was taken against miniflare — a
different D1, a different R2, a different catalog. Only the delta transfers, because it is one extra call on a
fixed path. `values:` is deliberately untouched: every number in it is a deployed-Node measurement, and
`doctor.max_subrequests_per_run = 220` still holds with room to spare.

Inserting this section displaced an **ordinal** cross-reference: the 13 August correction pointed a reader at
*"the third correction below"*, which meant the #68 one until this became the third. It now names that section
by its heading instead, because a pointer that depends on how many corrections exist breaks every time one is
added — quietly, and in a file whose whole purpose is that a number can be traced to what produced it.

One thing the reconciler deliberately does **not** add to this figure. Orphan collection is now suppressed
org-wide while any hold stands, and that check (`anyActiveHold`) runs **only when `collect` is requested** —
`doctor` calls `reconcileEvidence` read-only, so it spends nothing on it. Had it been placed at the top of the
pass unconditionally, this delta would have been +2 rather than +1, for a query whose answer the diagnostic
does not use.

## Correction, 19 August 2026: the cap this file prints was a Paid figure with no plan in its name (#68)

**No measured value moved.** `doctor.max_subrequests: 10000` is now `doctor.paid.max_subrequests: 10000`, and
`doctor.free.max_subrequests: 1000` is new — **documented, not measured**, from Cloudflare's published Workers
limits read on 19 August 2026 (Free gets **1,000** subrequests to internal services and 50 external; the
full quotation and the labelling are in `butler-step-budget.md`, which owns the measurement of the Paid
figure). No `stale_when` clause fired: the first clause was widened from "the ceiling" to "the ceiling on
either plan", because this file now carries both.

**This value is not doctor's own tripwire, it is the platform's ceiling restated.** It is the *same* figure as
`workflow.paid.subrequest_budget_per_instance`, measured there and taken here on trust, exactly as
`d1.paid.max_queries_per_invocation` restates it a third time. Three names for one ceiling is how the 13
August correction above came to be needed — a name that does not look relevant to the changelog that moved it.
The three are now **pinned equal** in `test/node/budget-plan-scope.test.ts`, per plan, so no copy can move
alone; that check is the mechanism the first correction's "the transferable finding is about `stale_when`
itself" was asking for.

**`doctor` was printing one plan's number as if it were the operator's.** The `doctor_cost` finding read
*"Cap is 10000 per invocation"*, unconditionally, on a Node that **cannot know its plan** — the
`workers_paid_plan` finding in the same report says so in the same breath: `severity: "report"`, *"Not
checkable from inside a Worker"*. An operator on Free was told a ceiling ten times theirs, which is worse
than printing nothing, because a blank prompts a question and a wrong number ends one (AGENTS.md §2). The
detail line now names **both** plans and says the Node cannot tell which applies, and
`test/doctor.test.ts` asserts that both figures and the words that qualify them are in the string.

**The two bounds derived from this ceiling now check against the Free figure**, and that is not a new
decision — it restores the derivation to the number it was actually run against:

| Relation | Where | Arithmetic |
|---|---|---|
| `doctor.evidence_sample_size` ≤ cap / 2 | `test/doctor.test.ts` | 200 ≤ 1,000 / 2 = 500 |
| `reseal.batch_size` × `reseal.subrequests_per_message` + 2 < cap | `test/evidence-lifecycle.test.ts` | 602 < 1,000 |

*"The derivation below is the one that actually produced 200, kept as it was run — against the withdrawn
1,000"* — and 1,000 is now exactly the Free ceiling, so the sample bound and the reseal batch are sound on
**either** plan rather than only on the one nothing can verify. Neither figure changes. This is a different
question from the deferred one in `butler-step-budget.md`: these two relations are checks on numbers that
already exist and hold under both plans, not a bound a checker will impose on a customer's Butler.

## Correction, 19 August 2026: doctor gained a check that spends nothing, and the run cost did not move (#72)

**No value moved and no `stale_when` clause fired** — recorded for the same reason as the correction below
it, that the clause *"including any new fixed-cost check"* is what a reader will reach for on hearing that
`doctor` grew a check.

`sending_events_consumer` reports that a Worker cannot see who consumes its own sending-events queue: since
#72 the queue is provisioned per Node with a derived name and the consumer is attached out of band, so the
question exists and is unanswerable from in here. The finding is built by a function taking **no arguments**
— it touches no binding, so it cannot spend a subrequest, and that is a property of its signature rather
than a claim about its body.

**Locally measured: 6 → 6 subrequests** (5 D1 / 1 R2, unchanged) on an **unclaimed** Node, findings **13 →
14**. Method as in the corrections below so the figures are comparable: `runDoctor` reading `report.cost` off
the run itself under `vitest-pool-workers` (`pnpm vitest run`), taken twice — once with the check wired into
`runDoctor` and once with that one line removed — on 19 August 2026. The finding count moving while the cost
does not is the whole content of the measurement.

## Correction, 19 August 2026: the draft-body scan moved into the reconcile pass, and the run cost did not move (#67)

**No value moved, and this time the `stale_when` did not fire either** — recorded anyway, because the clause
it would have fired on last time (*"including any new fixed-cost check"*) is the one this change is most
likely to be mistaken for. #67 gave `reconcile.ts` the `${orgId}/drafts/` prefix so a stranded draft body is
*collected* rather than only counted. `doctor` calls that pass read-only and `draft_bodies_stranded` now
**reports the pass's scan instead of performing one of its own**, so the two subrequests the 18 August
correction added moved from the check into the pass rather than being spent twice.

**Locally measured: 13 → 13 subrequests** (10 D1 / 3 R2, unchanged). Method identical to the 18 and 19 August
corrections above so the three are comparable: `runDoctor` on a **claimed** Node with an empty catalog — no
holds, no receipts, no drafts, no mail — reading `report.cost` off the run itself under `vitest-pool-workers`
(`pnpm vitest run`), on 19 August 2026. Unclaimed Node: **6 → 6**.

The scan really is still being paid for, which is why "did not move" is not "was removed". Measured the same
way with the one line that calls `scanDraftBodies` disabled inside the pass: **11 subrequests** (9 D1 / 2 R2).
So the draft direction costs **2** on the doctor path — one `R2Bucket.list()` and one `SELECT body_key` — and
it is now spent by the pass that could delete, on behalf of the check that only reports.

**That figure is fixed per run, not per object, and it was measured at two object counts rather than argued.**
`metering()` from `src/cost-meter.ts` around `scanDraftBodies` alone: **2 subrequests** (1 D1 execution, 1 R2
operation) with **0** stranded bodies and **2** with **5** of them. The bulk `SELECT body_key` is what buys
that; the raw direction, by contrast, spends one D1 lookup per listed object, measured in
`evidence-lifecycle.md`'s correction of the same date.

Two sentences elsewhere in this file are now false of the product and are deliberately **not** rewritten,
because a correction that edits the record it corrects destroys the thing the record was for. The 18 August
correction describes `draft_bodies_stranded` as *"reporting draft bodies that no code path in the Worker can
collect"*: true when measured, false since #67. The 19 August legal-hold correction's closing paragraph still
holds exactly as written — `anyActiveHold` runs only when `collect` is requested, so the read-only doctor path
still spends nothing on it, and that is now the reason **two** collectable sets can be suppressed without
this figure moving.

`doctor` verifies the runtime claims other decisions made. Most of its checks cost one query; one
of them — evidence integrity — costs **one R2 `head` per receipt examined**, which is why it has a
bound at all.

## The bound, and why it is a sample

A Worker invocation may issue at most **10,000 subrequests** on Paid — it was **1,000** when this
derivation was run (the same cap #4 sized service-binding fan-out against), and that figure was withdrawn
on 11 February 2026, per the first correction above. Both D1 queries and R2 operations spend one.
`message-metadata-bytes.md` measured that a 10 GB shard holds **~8.5 million messages**, so "check every
receipt" is not a bounded operation and never becomes one.

**200 receipts, most recent first.** The derivation below is the one that actually produced 200, kept as
it was run — against the withdrawn 1,000. Under the live 10,000 it makes 200 *conservative*, not wrong,
and 200 is deliberately **not** re-derived upward: a bound that has become generous is not thereby
incorrect, and raising it needs its own measurement. (Same call as `reseal.batch_size` in the first
correction above.)

| | |
|---:|:---|
| 1,000 | subrequests available — the withdrawn Paid cap this derivation used, which is also the live **Free** ceiling (`doctor.free.max_subrequests`); the live Paid ceiling is 10,000 |
| ~10 | spent by every other check (schema, KEKs, keys, outbox, counts) |
| 200 | R2 `head` calls |
| ~790 | headroom, so adding a check never silently pushes this over the cap — ~9,790 under the live Paid ceiling |

The bound is **visible in the output**, not just in this file. The finding's detail line reads
`200 of 8,500,000 receipt(s) checked, most recent 200` — because a check that examines 200 rows of
8.5 million and reports "ok" is a check that lies, and AGENTS.md forbids a cap the reader cannot
see. Most recent first because a blob that has just gone missing is the one a human can still act
on; older losses need the §24 reconciler, not a diagnostic.

## Measured cost of a full run

Measured against the deployed Node (`mailda.swmengappdev.workers.dev`, 4 August 2026) on a catalog
holding 1 receipt, 14 tables, 1 current signing key:

`doctor` **counts its own cost** and reports it as a finding, so this figure is read off a live run
rather than derived from the source. Measured on the deployed Node with 1 receipt, 14 tables and 1
current signing key:

| | |
|---:|:---|
| **13** | D1 queries |
| **7** | R2 reads — 5 receipts sampled, plus one `head` for `evidence_bucket_reachable` |
| **20** | subrequests total, against a cap of 10,000 — this row read "1,000" until the 13 August correction *recorded* the withdrawal; Cloudflare withdrew the figure itself on 11 February 2026 |

Re-measured 5 August 2026 on a catalog holding 5 receipts, 22 tables and 1 current signing key. The
4 August figure was 7 D1 / 1 R2 / 8 subrequests on a catalog with 1 receipt and 14 tables; the
difference is the checks added since (outbound state, audit chain) plus one new fixed-cost check
below, not a regression in any single check. Recorded rather than quietly replaced, because a receipt
whose number moves without saying why is a receipt nobody trusts the second time.

**`evidence_bucket_reachable` costs one R2 `head` per run, not per row.** That distinction is the one
`stale_when` cares about: a fixed cost is absorbed by the headroom derived above, while a
per-row cost is what `doctor.max_subrequests_per_run` exists to catch. `draft_bodies_stranded` is the
second check of that shape — see the 18 August correction. It was added because the
Deploy to Cloudflare button provisions D1 but **not** R2
(`deploy-button-behaviour.md`), so a binding pointing at a bucket that does not exist is the single
most likely state of a freshly-installed Node — and it previously surfaced as a generic
"Reconciliation failed" whose `fix` sent the reader to migrations and the key vault. Being directed
at two healthy subsystems is worse than a bare failure.

Only **subrequests** are counted, and that is deliberate. `D1PreparedStatement.first()` returns its
row without `meta`, so a rows-read total would silently omit most of this file's queries — and a
partial figure presented as a total is exactly the kind of number this project refuses to write. The
cap is on subrequests anyway.

`doctor.max_subrequests_per_run = 220` is the tripwire: the fixed checks plus a full 200-receipt
sample, with room to spare. It fires if a check becomes proportional to mailbox size, which is how
the authorization path grew a full table scan unnoticed (`authz-check-rows-read.md`). A test asserts
the relationship directly — five more receipts cost five more R2 reads and **zero** extra queries.

## An edge cache served a stale report

Found while taking this measurement: `GET /api/doctor` came back from a Cloudflare edge cache with a
stale verdict, omitting a field the deployed code was already returning. §8 requires
`Cache-Control: no-store` on authentication, admin and content surfaces and nothing was setting it.
It is now applied centrally to every `/api/*` response, with `Vary: cookie`, rather than per-route —
a header each future handler must remember is a header that will be forgotten.

## Why it uses the credentials rather than inspecting them

Two checks deliberately perform a round trip instead of testing for presence:

- **Credential KEK** — wrap then unwrap a probe string. A Secrets Store secret is `pending` for a
  period after creation, so the binding exists and `.get()` throws. This presented as an HTTP 500
  on the first sign-in of a correctly configured Node.
- **Signing key** — mint a token and verify it. A row can exist while being unwrappable, if the
  credential KEK that wrapped it has changed.

Presence is not readability, and a diagnostic that tests presence would have passed in both cases.

## Correction — 20 August 2026: the supervision-notice check, and an absolute figure that had drifted

#63 part B added `supervision_notices_overdue` (and, conditionally, `supervision_notice_missing` and
`supervision_notice_stranded`), which `doctor` computes from **one** statement with five scalar
sub-selects — one `prepare`, one execution, as
`test/node/doctor-meter-honesty.test.ts` requires of everything on this path. `src/notice-delivery.ts` is a
separate file *because of* that guard: the delivering scan needs a `batch()` and named statements, and
`src/deciders.ts` set the precedent for moving the function rather than widening the check.

**Measured delta: +1 D1 query, no R2.** Same fixture before and after, a claimed Node with the check
removed and then restored.

**And the absolute figure in this file had drifted, which the measurement found rather than the reader.**
The same claimed Node reads **15 subrequests before the new check and 16 after** (12 → 13 D1, 3 R2
unchanged). The last correction here recorded **13**. Nothing regressed: checks have been added since that
measurement without it being re-run, so the *number* went stale while every *delta* recorded here stayed
right. Recorded rather than quietly overwritten, because "an unverified number is worse than a blank" cuts
both ways — the deltas in the sections above are still the evidence, and 16 is now the figure.

`doctor.max_subrequests_per_run = 220` is untouched and still holds by more than an order of magnitude, so
no `values:` moved and no `stale_when` clause fired: the new check is a fixed cost that does not grow with
mailbox size, matters, grants or the age of the trail. Its expensive sibling — a per-grant join naming
*which* notice was removed — was deliberately not built, for exactly that reason.

**Re-measured after `supervision_notice_stranded` was added**, because a fifth sub-select is a change to
the statement even when it is not a change to the query count: **still 16 subrequests** (13 D1, 3 R2). The
count of `prepare` calls is what this path is budgeted on, and a sub-select does not add one — which is
why the guard against an inert notice could be paid for at all. It rides `ntf_pending_matter`, the partial
index on `due_at IS NULL`, so it seeks into nothing on a Node whose notices are all dated.


## Correction — 20 August 2026: two new checks, one new subrequest (#66)

The `stale_when` fired on *"any new fixed-cost check"*. #66 added `send_breakers` — the three windowed rate
readings — and, conditionally, `domain_paused`.

**Measured delta: +1 D1 query, no R2.** Same fixture, the check removed and then restored: a claimed Node with
no mail at all reads **18 subrequests without it and 19 with** (14 → 15 D1, 4 R2 unchanged). That absolute is
from a different fixture than the 16 recorded in the correction above — this one is a bare claimed Node, that
one had mail — so the two absolutes are not comparable and neither invalidates the other. **The delta is the
evidence**, measured the way every delta in this file is.

**One query for three breakers, and that is the design rather than a small number.** The volume count, the
bounce numerator and denominator, the complaint numerator and denominator, whether *this* domain is paused, and
how many domains are paused at all — seven questions, seven scalar sub-selects, one `prepare`, one execution.
That is the same shape `checkDeliveryVisibility` and `noticeState` already use, and it is what
`test/node/doctor-meter-honesty.test.ts` requires of everything on this path: `src/breakers.ts` is listed in
`DOCTOR_PATH` and satisfies both rules — no `batch()`, and every prepared statement executed exactly once.
#66's *write* path lives in `src/domain-pause.ts` **because of** that guard, since placing a pause needs a
transaction. `src/deciders.ts` and `src/notice-delivery.ts` set the precedent for moving the function rather
than widening the check.

**`domain_paused` costs a second query only when there is a pause to describe.** The seventh sub-select above
answers *are there any*, so the listing is issued on a Node that has one and skipped on every Node that does
not. A listing on every run would have been a subrequest spent on every Node to report nothing on almost all
of them — and it would have made this a **+2** check while the comment beside it claimed +1, which is how the
delta above was found to be 2 before it was fixed.

`doctor.max_subrequests_per_run = 220` is untouched and still holds by an order of magnitude, so no `values:`
moved: both checks are fixed costs that do not grow with mail volume, mailbox count or the age of the trail.

## Correction — 20 August 2026: the reconciler gained a fourth prefix (#74)

The `stale_when` fires on *"the measured cost of a doctor run changes materially"*. No new check: `doctor`'s
finding count is unchanged at 17. What moved is `checkEvidence`, which performs the reconciler's read-only pass,
and that pass now lists `${orgId}/sent/` as well as `raw/`, `drafts/` and `exports/` — the repair of #74, which
was #67's defect in a second place.

**Measured delta on the same claimed-and-empty Node, the scan removed and then restored: 19 → 20
subrequests** (D1 unchanged at 15, R2 4 → 5, findings unchanged at 17). The added cost on an empty Node is
**one R2 `list()` and no D1 at all**, because `scanSentObjects` asks its referent table nothing when the
listing is empty: the minimum of no manifest ids does not exist.

**With one staged object present the same run reads 21** (16 D1, 5 R2), which is the second half of the cost —
one bounded `SELECT id FROM send_manifests` for the whole page, once, however many objects it contains. So the
delta this receipt records is **+1 on a Node that has never sent and +2 on one that has**, and both were
measured rather than one measured and the other inferred.

Method identical to the corrections above: `metered()` inside `runDoctor` on a claimed Node with an empty
catalog, under `vitest-pool-workers` against **miniflare** — not a deployed Node. The per-prefix figures behind
it, and the flatness this depends on, are in `evidence-lifecycle.md`'s second 20 August correction and are
re-run by `test/sent-evidence.test.ts` rather than transcribed.

**What "the scan removed" has to mean, because the obvious reading of it does not reproduce this figure.**
Dropping `sentPrefix(orgId)` from `scannedPrefixes` leaves the measured cost at **20, not 19**: that function
builds what the report *names*, and `reconcileEvidence` calls `scanSentObjects` on its own line regardless. The
19 is the call removed, not the name — checked, because a receipt whose stated method reproduces a different
number than the one it records is this file's own recurring defect, and the two are only distinguishable by
running both. The coupling the name-only reading assumes is real but lives elsewhere:
`test/node/evidence-prefix-world.test.ts` fails the moment the two sets disagree, which is what the dropped
name actually costs.

`doctor.max_subrequests_per_run = 220` is untouched and still holds by an order of magnitude, so no `values:`
moved.
