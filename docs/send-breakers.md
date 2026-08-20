# Send circuit breakers

What stops this Node sending when something has gone wrong with the sending itself: three windowed rates it
applies to its own traffic, one latched pause a pair of administrators place on a domain, and the split
between them that decides every other question.

Implemented by `apps/node/worker/src/breakers.ts` (the rates and the pause *read*) and
`src/domain-pause.ts` (the pause *write*) with `migrations/0026_send_breakers.sql`, evaluated at the seal in
`src/outbound/manifest.ts` and again at the hand-over in `src/outbound/recheck.ts`. Numbers:
[`docs/receipts/send-breakers.md`](receipts/send-breakers.md). Decision record: [#66][66], on top of
[#60][60]'s policy outcomes and states, [#61][61]'s approval machinery and [#62][62]'s withholding
vocabulary.

## Two kinds of breaker, and the split runs down the middle of every other question

|  | Volume, bounce rate, complaint rate | Domain pause |
|:--|:--|:--|
| **What it means** | too much, too fast | this must not be sent at all |
| **State** | none — a question re-asked per send | a latched `domain_pauses` row |
| **Outcome** | `awaiting` + a reason ([#60][60]'s gate) | `withheld` + a reason ([#62][62]'s refusal) |
| **Recovery** | failures age out of the window | one administrator lifts it |
| **Who ends it** | nobody — it ends itself | a person |

Collapsing them fails in a specific way in each direction. All-hold lets a runaway build a backlog somebody
eventually releases in bulk, which is how a loop finally sends its thousands. All-refuse discards perfectly
good invoices on a busy afternoon, and the sender's only remedy is composing them again, immediately, into the
same breaker.

**The classification is per breaker and explicit in code** — `RATE_BREAKERS` carries `outcome: "gate"` on each
of the three, written out rather than implied by which list a breaker is declared in. It is not inferred from
a severity or a threshold, because that is the one place this design could rot into *whatever the last person
assumed*.

## The counter is a windowed `COUNT(*)` over rows that already exist

There is **no counter table and nothing to increment**. Each rate is a count of append-only rows inside a
window, which is the shape this repository's only working rate limiter already has — `login` counts
`login_attempts` rows at `src/auth/session.ts:164`. Nothing to increment means nothing to contend on, no
compare-and-swap, and no cell that can drift from the events it claims to summarise: **the number is derived,
not maintained.**

| Breaker | Numerator | Denominator | Window | Limit |
|:--|:--|:--|--:|--:|
| `volume` | `send_recipients` handed over | — it is a count | 1h | 500 recipients |
| `bounce_rate` | `bounced` events | `delivered` + `bounced` | 6h | 30% over ≥20 |
| `complaint_rate` | `complained` events | `delivered` | 24h | 5% over ≥50 |

`failed` and `rejected` are in neither half of the bounce rate. `src/outbound/events.ts` keeps them as their
own words precisely because they are the provider's internal problems rather than a receiving server
refusing, and telling somebody their recipients are bouncing when Cloudflare had an outage is a false
statement about a third party's mail server.

A Durable Object was rejected despite §12 explicitly permitting one for *"presence, counters, rate state"*: it
adds a subrequest to every send, it is opaque to `doctor` in a way a table is not, and any timer-based reset
would inherit the DO alarm's documented absorbing failure state — *stop re-arming and nothing external
notices, ever* — inside the one component whose job is to notice things.

`send_counters` was rejected as the volume substrate for two reasons: it is a **maintained** cell
(`handed_over = handed_over + 1`) that can drift from the rows it summarises, and its grain is a calendar day
— so a spike at 23:00 is forgiven at midnight and a spike at 01:00 blocks the rest of the day.

## Every rate counts attributed events only, and there are two kinds of foreign row

`send_recipient_events` has a **second writer**, and this is the trap the whole feature was built around.

`recordDeliveryReport` (`src/outbound/delivery-report.ts`) inserts `event_type = "inbound.delivery_report"`
with `terminal = 1` and `manifest_id` **NULL** for delivery reports about *other systems' mail* — its own
header names the three ways one arrives: mail sent by another system on the same domain, a report forwarded
by a person, a report for something relayed before Mailda existed. A naive `COUNT(*)` counts those into this
Node's rate and disables a working Node on a number it read wrong, which is exactly the inversion a circuit
breaker exists to prevent.

Two predicates are on every counting sub-select, and **each excludes a different kind of foreign row**. That
was established by deleting one of them and watching what still passed, not by reasoning about it:

| Foreign row | Written by | Excluded by |
|:--|:--|:--|
| `inbound.delivery_report`, NULL `manifest_id` | `recordDeliveryReport` | the **event-type** filter — it is not one of Cloudflare's type strings |
| `cf.email.sending.message.bounced`, NULL `manifest_id` | `applySendingEvent`, when it cannot tie an event to anything this Node sent | `manifest_id IS NOT NULL` |

The second is the one the attribution clause is load-bearing for, and `doctor` already reports those rows as
`delivery_attribution` — whose fix names the usual cause: *a subscription covering a domain sent from
elsewhere, whose events arrive here with no matching manifest*. A test built only from the first kind passes
against a breaker with **no attribution clause at all**; `test/breakers.test.ts` builds both corpora, and
`test/node/breaker-attribution-world.test.ts` reads the source so a seventh sub-select added later cannot
slip past a behavioural test that only asks about the six that exist today.

Layer 4 already applied this exact split for `doctor`'s blindness check, after an unattributable delivery
event made the Node look less blind than it was.

## Nothing resets, because nothing is armed

There is no open/half-open/closed state machine, no timer, no cron dependency, and nothing that must keep
re-arming. Recovery happens because **failures age out of the window**.

`retryAfterSeconds` is derived from the oldest row still inside it, so the refusal tells somebody when it
clears instead of leaving them to poll. It carries a companion field rather than a claim it cannot support:

- `retryAfterExact: true` for **volume** — the count is what is compared, so the instant the oldest hand-over
  ages out the count is strictly lower.
- `retryAfterExact: false` for a **rate** — the oldest bounce leaving the window drops the numerator, but the
  denominator moves with it, so the rate may still be over. It is a lower bound on when the answer can
  change, which is the strongest true statement available.

Manual-reset-only was rejected on its second-order effect rather than its first: a bounce spike at 2am becomes
an outage waiting for somebody to wake up, and the realistic response after that happens twice is that the
limits get raised until the breaker never fires — the muted-check failure `DELIVERY_SILENCE_MS` already names
in `doctor.ts`.

**Two costs, accepted and named.** A windowed breaker can **flap** at the boundary: a send refused at 09:59:59
goes at 10:00:00. That is tolerable for a gate whose whole effect is a short delay and intolerable for a
refusal, which is exactly why the pause latches instead. And because nothing persists, **the trip leaves no
row** — so it is audited explicitly or it never happened.

## Where it evaluates, and what the total order is

[#66][66] settled **both** points. The seal sets the state and produces the error carrying budget, limit and
remedy; the dispatch re-asks and fails closed if the answer has become stricter.

At the seal, two breakers join [#60][60]'s four outcomes in one total order:

```
policy deny  >  domain pause  >  require_approval  >  policy hold  >  rate gate  >  allow
```

Each end of that is a decision:

- **A policy denial keeps its reason** even on a paused domain: it is the older and more specific decision —
  somebody wrote a rule about this send — and overwriting it hides it.
- **A pause outranks both gates**, because a gate says *wait* and a pause says *never*, and telling somebody
  to wait for a condition no amount of waiting clears is the worst of the four available wordings.
- **A rate gate ranks below the policy gates**, and this one is load-bearing. A policy gate needs a *person*
  to clear it and a rate gate needs *time*. If both apply, the reason a reader must act on is the human one —
  and the rate is re-asked at dispatch anyway, once the approval releases the send.

"Stricter" at dispatch is **not** a comparison against a value frozen at the seal, and that is deliberate
rather than an omission: a rate has no bound value, because nothing was frozen. There is only the current
answer, and it either permits the hand-over or does not.

## `awaiting` gained a drain, and that is a check now rather than an omission

Before [#66][66], `awaiting` was unreachable by the dispatcher **by omission**: the predicate that lets a send
move admitted `held`-and-due or `throttled`, and `awaiting` was neither. That is what made a policy gate a
real gate.

A rate gate breaks the premise — it parks a send in `awaiting` and promises it *goes when the window clears*,
and nothing sweeps `awaiting`. Without a drain that sentence would have been false and the gate would have
been a queue with no drain, which is the exact failure [#60][60] kept `deny` out of `awaiting` to avoid,
arriving through the other door.

So the predicate gained one arm — `state = 'awaiting' AND state_reason IN (BREAKER_REASONS)` — and every
place that decides whether a send may move is now built by one function, `movableNow` in
`src/outbound/dispatch.ts`, with three call sites. One function, because a widening that had to reach three
identical hand-written predicates is a widening that reaches two of them.

**The policy gates stay closed, twice over.** `BREAKER_REASONS` is derived from `RATE_BREAKERS`, so
`policy_hold` and `policy_approval_required` are not in it and could only get there by somebody declaring a
policy outcome to be a rate breaker; and `sealManifest` will not write a breaker reason over a policy gate at
all. Both halves are asserted: `test/policy.test.ts` proves a policy-gated send still cannot leave, and
`test/breakers.test.ts` proves a policy-gated send whose rate window has cleared *still* does not leave.

## The domain pause: ceremony to place, one administrator to lift

[#64][64] made **placing** a legal hold easy — one administrator, immediate, no justification — because
placing only ever preserves, and ceremony in front of it is how evidence is lost in the hour after somebody
realises they need it. Lifting re-permits destruction, so it takes two people and a reason.

Placing a domain pause **stops a customer's mail**. The safe direction reverses, and the conclusion reverses
with it:

| | Legal hold ([#64][64]) | Domain pause ([#66][66]) |
|:--|:--|:--|
| **Place** | one administrator, immediate | **two** administrators, mandatory reason |
| **Lift** | **two** administrators, mandatory reason | **one** administrator, alone, no reason required |

Same principle, opposite conclusion, which is what a principle looks like when it is real rather than a habit.
What [#66][66] removed from the lift is the *ceremony*, not the *record*: `domain.pause_lifted` names who did
it and when.

The pause is on the **sending** domain — the domain of the envelope From. That is the domain a Node can
actually stop; pausing a *recipient* domain would be a suppression list, and this product has none of its own.

`placed_at` is NULL until two administrators say so, which is what makes a request not a pause: the
`domain_pauses` row is written when somebody *asks*, in the same transaction as the approval, so the reason
the approvers read is a stored fact rather than a parameter travelling beside the request. A denied request
leaves `placed_at` NULL for ever and the row stays as the record that somebody asked to stop a domain's mail
and was refused.

**If a pause cannot be placed, the domain keeps sending** — and that is the opposite of the hold's safe
direction, so it is stated rather than left to be discovered. An organization with fewer than two other
administrators gets `E_DOMAIN_PAUSE_UNSATISFIABLE` before anything is written, and the refusal names the two
acts one administrator still has: publish a policy that denies, and cancel the sends in flight.

## The fifth approval subject, and the column that had to stop lying

A pause is decided at `POST /api/approvals/:id/decide`, by the same fold, the same eligible-set computation,
the same completion predicate and the same conditional UPDATE every other subject uses. Adding it was a
compile error in six places, which is the machinery working rather than a coincidence.

What is new is where the eligible set comes from. Every other subject is about a **mailbox**, and its
approvers are that mailbox's `approval.decide` holders. A pause is about a **domain**, which every mailbox
with an address on it sends from — so no single mailbox's holders have authority over it, and naming one
would be picking an arbitrary mailbox to decide something about all of them.

Migration 0021 named this case on the column and deferred it: *"a nullable `mailbox_id` would make 'who is
eligible' a question nothing validates … that kind either names a mailbox or brings a second source for its
eligible set, and that is its ticket's work."*

So `approvals.mailbox_id` becomes **`scope_id`**, and the second source is `adminsOf` — `org.admin` holders on
the organization, resolved through teams and de-duplicated on the person, which is the property dual control
rests on. The column always meant *the object whose relation-holders are eligible to decide*; `scope_id` is
that sentence, and a column named `mailbox_id` holding an organization id would be the overclaiming name
AGENTS.md calls a landmine — the join to `mailboxes` returns nothing, and a join that returns nothing is the
one nobody notices. **Which relation on which object is not a column**: it is `SCOPE_OF`, a total map keyed on
the subject-kind union, so a sixth kind is a compile error until it says where its approvers come from.

## What is audited, since a rate breaker keeps no state

| Action | When | Why it is not something else |
|:--|:--|:--|
| `send.rate_limited` | a rate gate fires, at the seal or at the dispatch | see below |
| `domain.pause_placed` | beside the one `UPDATE domain_pauses` that sets `placed_at` | `approval.decided` says two people agreed and cannot say *what to* |
| `domain.pause_lifted` | beside the single conditional UPDATE that clears it | |

**`send.rate_limited` is not `send.suppressed`**, and reusing that one was the tempting wrong answer. It says
*"the Node declined to hand over, by its own rule"*, which is nearly right — but it is the entry for the
`suppressed` **state**, which `dispatch.ts` defines as *"on the suppression list — will never arrive, and that
is knowable now"*. A rate gate claims the opposite on both halves: the mail **will** arrive, and nothing about
this recipient is known to be wrong. Filing a delay under a name that means permanent non-arrival is the
overclaim AGENTS.md §4 forbids, and it would have made *"how much mail did this Node discard"* unanswerable
from the trail.

**It is emitted on the transition, never on every sweep**, and that is enforced rather than intended: the
entry and the state change share one `auditedBatch` whose gate excludes a manifest already `awaiting` with the
same reason. A send held for an hour behind a one-minute sweep files **one** entry, not sixty — which is what
keeps `audit-and-log-retention.md`'s *"a handful per message"* true.

There is deliberately no `domain.pause_requested`: requesting a pause **is** requesting an approval, and
`approval.requested` records it in the same transaction as the row, with the domain, the reason, the stages
and the eligible count in its detail.

## `doctor` refuses to arm a breaker with no observations

A rate breaker keeps no state, which is what makes it impossible to leave un-armed by accident and also what
makes it **invisible**: there is no row anywhere saying whether the thing works, and a tripped breaker nobody
can see is the failure shape this repository has hit repeatedly. So `send_breakers` prints all three readings
on every claimed run, tripped or not.

The reading is `armed: false, reason: no_observations` rather than a reassuring **0%**. A bounce-rate breaker
reading 0% because the delivery channel is dead is the silent failure the whole feature exists to prevent.

**And the `percent` field is blank, not `0`, wherever it is served.** That is the half a review caught: the
report never printed a percentage for an unarmed rate, but `GET /api/breakers` served `percent: 0` beside
`armed: false`, so a client reading one field and not the other was handed exactly the reassuring number the
sentence above refuses. `null` now means *no trustworthy percentage* for an unarmed rate and *no denominator
at all* for volume — which are the same answer to a caller, and both are AGENTS.md's blank that prompts a
question rather than a number that ends one.

**Whether that is a fault depends on one thing, and the check reads `delivery_visibility`'s own predicate
rather than recomputing it:**

- unarmed, and the Node has handed mail over long enough ago to have been answered with **zero** attributed
  events — the breakers *cannot fire*. `degraded`, with a fix pointing at the same event subscription that
  finding names.
- unarmed, and the Node simply has not sent much — nothing is wrong. `report`, `ok: true`. Failing here would
  put a permanent WARN on every freshly deployed Node, and `DELIVERY_SILENCE_MS` names the consequence in the
  same file: a finding that fails on every Node forever is one somebody mutes, and a muted check is worse than
  no check because it still reads as verified.

Failing **closed** on no observations was rejected in one line: a Node that has never sent would refuse to
send.

`domain_paused` is a second, separate finding, because it answers a different question — *is a human decision
currently stopping a customer's mail* — and it is `degraded` even though nothing is broken: mail is not
leaving, somebody has to know, and the pause's own reason and age are what they need.

## Cost

One D1 statement, measured at **1 subrequest**, in every case — empty tables, full tables, paused or not.
Every question is a scalar sub-select inside a single `SELECT`, the shape `checkDeliveryVisibility` already
uses.

| Path | Before | After | Bound | Printed by |
|:--|--:|--:|--:|:--|
| `evaluateBreakers`, empty / full / paused | — | **1** | 2 | `test/breaker-cost.measure.test.ts` |
| `sealManifest`, no policies | 11 | **12** | — | `test/breaker-cost.measure.test.ts` |
| `dispatchOne`, unapproved | 16 | **17** | 20 | `test/outbound-recheck.test.ts` |
| `dispatchOne`, approved | 24 | **25** | 28 | `test/outbound-recheck.test.ts` |

Four statements would have cost four on the seal path *and* on both dispatch paths, consuming the entire
headroom of a bound that exists to catch the cheap path becoming expensive. Measured with `src/cost-meter.ts`
in real `workerd`, which counts executions rather than `prepare` and prices a `batch()` as the one round trip
it is. **The file that prints each figure is named per row**, because the seal and the dispatch numbers come
from two different tests and one citation covering both would be a receipt nobody could re-run. `doctor`'s
+1 has no standing test at all and the receipt says so rather than implying one. Not a deployed Node:
miniflare's D1 is a local SQLite, so what is measured is the number of operations, not their latency.

## The numbers are sized, not measured, and the receipt says so in those words

There is no corpus. This Node has never observed a real organization's bounce rate, and `doctor` reports the
reason it might never have. So the eight thresholds are **tripwires sized by arithmetic**, each with what it
trades off written out in [`docs/receipts/send-breakers.md`](receipts/send-breakers.md), and the first real
corpus is that receipt's first `stale_when` clause. The one external figure used is in-repo and dated —
`send.paid.included_per_month = 3000` — and it is context for the order of magnitude rather than an input
anything is computed from.

The **cost** figure in the same receipt *is* measured, and the receipt opens by separating the two, because
conflating them is the defect this month's house rules were written about.

## Named absent

**Loop detection**, which [#66][66] excluded and this records as an absence rather than a threshold: detecting
a loop needs a per-Butler-run causal record, and nothing records per-run outcomes at all — Layer 4 is unbuilt.
A breaker needs a denominator, and for loops there is nothing to count.

**The Butler pause.** [#66][66]'s resolution keys a pause on `butler_id`, precisely so that republishing a
fixed Butler cannot silently clear a pause the machine placed — a good decision about an object that does not
exist yet. `grep "CREATE TABLE" migrations/` returns nothing for butler: **there are no Butler tables at
all**. A `butler_pauses` table would be *expressible and unusable* — no Butler can be created, no run can be
recorded, nothing could ever write a row, and a pause referencing a `butler_id` could not be validated against
anything. That is [#60][60]'s governing failure, which this repository has now hit five times: *a condition
backed by no data is a policy that silently never fires*, which reads as governance and is not. Same call
[#61][61] made for team-scoped stages, tracked as [#73][73]. Filed as [#75][75] with the evidence.

What survives is not diminished, and it is worth saying so plainly rather than implying the feature is
crippled: volume, bounce rate and complaint rate all have real substrate today, and the domain pause is a
human act that needs no Butler at all.

## Surface

```
GET  /api/breakers                 what every rate is at right now, armed or not
POST /api/domain-pauses            ask two other administrators to stop a domain's mail
GET  /api/domain-pauses            every pause in force, with its reason and its age
POST /api/domain-pauses/:id/lift   restart a domain. One administrator, alone
POST /api/approvals/:id/decide     decide a pause request — #61's machinery, not duplicated
```

`GET /api/breakers` exists because of AGENTS.md's third principle rather than for a dashboard: *a limit
developers can hit is a limit they must see*, and the refusal on a gated send is only half of that. A client
composing in a loop should be able to read the rate **before** it gates. An agent that can see
`volume: 480 of 500, 900s until the oldest falls out` backs off; an agent that can only see refusals retries
into the wall.

There is deliberately **no endpoint that pauses a domain outright** — one would contradict [#66][66]'s whole
asymmetry.

[60]: https://github.com/Straits-AI/mailda/issues/60
[61]: https://github.com/Straits-AI/mailda/issues/61
[62]: https://github.com/Straits-AI/mailda/issues/62
[64]: https://github.com/Straits-AI/mailda/issues/64
[66]: https://github.com/Straits-AI/mailda/issues/66
[73]: https://github.com/Straits-AI/mailda/issues/73
[75]: https://github.com/Straits-AI/mailda/issues/75
