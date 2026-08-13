---
id: cron-lateness
kind: platform-limit
measured_on: 2026-08-13
stale_when: >
  Cloudflare changes how it distributes cron invocations within the scheduled interval; the per-Worker
  offset into the minute stops being stable; controller.scheduledTime starts carrying sub-second
  precision, which would mean it has become an observed dispatch rather than a computed schedule; the
  documented per-account Cron Trigger ceiling changes; or wrangler stops replacing a Worker's triggers
  wholesale on deploy
values:
  cron.trigger_ceiling_per_account: 250
  cron.propagation_ceiling_seconds: 900
  cron.observed_lateness_p99_ms: 8093
---

**Measured:** a scratch Worker (`mailda-cron-probe`) with `triggers.crons: ["* * * * *"]` and a D1 table,
deployed **once** and never redeployed — a redeploy mid-sample is what confounded the Workflow figures in
`workflow-provisioning.md`, and this receipt exists partly to do better.

Three clocks recorded per firing: `controller.scheduledTime`, `Date.now()` at handler entry, and D1's own
server clock taken during the INSERT. The third is there because Workers clamps `Date.now()` to the last
I/O — the hazard `authz-check-rows-read.md` records — so the isolate's clock needed an independent check
rather than trust.

## `* * * * *` does not fire on the minute, and that is not lateness

The headline, because it invalidated this receipt's own first method.

Cloudflare scheduled this Worker at **:38 past each minute**, and the offset was **identical on every
firing**. `controller.scheduledTime` reported a clean whole-second instant with **zero milliseconds every
time** — which is the signature of a *computed schedule*, not an *observed dispatch*.

The first version of the analysis computed lateness against the minute boundary, on the assumption that
`* * * * *` means `:00`. That produced **~40 s of lateness that does not exist**, and made
`controller.scheduledTime` look like it was lying by 38 s. The flawed instrument was ours.

This is consistent with the documented intent — cron-triggered Workers "run on underutilized machines to
make the best use of Cloudflare's capacity and route traffic efficiently" — so a stable per-Worker offset
is load-spreading working as designed. **Two consequences worth stating:**

1. **Nothing may assume a cron runs at the top of its interval.** A `*/1` sweep runs 38 s into the minute
   on this Worker; another Worker will draw a different offset. Anything whose correctness depends on the
   phase of the schedule rather than its period is relying on an accident.
2. **`controller.scheduledTime` is the correct reference for lateness**, and it is honest here.

**This is the opposite of the Workflow result** in `workflow-provisioning.md`, where
`event.schedule.scheduledTime` carried sub-second precision and disagreed with the boundary in the
instance id by ~32 s. The two subsystems genuinely differ, and neither may be assumed from the other —
which is exactly what this ticket was told not to assume, in the direction opposite to the guess.

## Observed lateness

Lateness = handler entry minus `controller.scheduledTime`.

| Scheduled for | Lateness | Isolate clock vs D1 clock |
|---|---:|---:|
| `06:44:38.000` | 1.479 s | +0.110 s |
| `06:45:38.000` | 2.387 s | +0.131 s |
| `06:46:38.000` | 1.391 s | +0.107 s |
| `06:47:38.000` | 1.183 s | +0.130 s |
| `06:48:38.000` | 1.677 s | +0.119 s |
| `06:49:38.000` | 1.283 s | +0.113 s |
| `06:50:38.000` | 2.293 s | +0.123 s |
| `06:51:38.000` | 1.389 s | +0.121 s |
| `06:52:38.000` | 1.492 s | +0.128 s |
| `06:53:38.000` | 1.278 s | +0.112 s |
| `06:54:38.000` | 3.493 s | +0.125 s |
| `06:55:38.000` | 2.987 s | +0.158 s |

(last 12 of 40 shown; statistics below are over all 40)

**n=40** — lateness against `controller.scheduledTime`:
min **1.095 s**, p50 **1.483 s**, p90 **3.379 s**, p99 **8.093 s**, max **8.093 s**

Offset into the minute: 38s — **stable across every firing**
scheduledTime carrying sub-second precision: 0 of 40 — **always whole seconds, i.e. a computed schedule**

no skipped minutes across 40 consecutive firings

## Offset is drawn per Worker

| Worker | Offset into the minute | Firings | Lateness min / p50 / max |
|---|---:|---:|---:|
| `mailda-cron-probe` | :38 | 40 | 1.095 / 1.483 / 8.093 s |
| `mailda-cron-probe-2` | :45 | 26 | 0.387 / 0.389 / 3.917 s |

Two Workers, the same `* * * * *` expression, the same account, **different offsets** — so the offset is a property of the **Worker**, not of the schedule expression.

Both probes together: **66 consecutive firings, no skipped minute in either.** Worth stating because cron
documents no retry at all, so a dropped invocation is the failure mode with no remedy — and across this
sample there were none. That is not a guarantee, it is an absence of counter-evidence over under an hour.

The two Workers also differ in *latency*, not only in phase: p50 1.483 s against 0.389 s for identical
code on identical schedules. So neither the phase nor the spread of a cron is a property a design may
treat as fixed.

The isolate's `Date.now()` and D1's server clock agreed to within ~0.14 s on every firing, and that gap is
the D1 round trip rather than clock skew. So the **Spectre clamp is not distorting these readings** — a
worry that had to be ruled out rather than waved away.

## Propagation: the 15-minute figure is a documented ceiling, and the typical case is far better

`wrangler.jsonc` carries the note *"Changes take up to 15 minutes to propagate, so a freshly installed
Node notices no breaches for that long."* That quotes the documentation correctly: *"Changes such as
adding a new Cron Trigger, updating an old Cron Trigger, or deleting a Cron Trigger may take several
minutes (up to 15 minutes) to propagate to the Cloudflare global network."*

Observed on this deploy: the deploy returned at **06:14:46Z**, the schedule missed the 06:15 slot, and the
first firing was scheduled for **06:16:38Z** — live within **~74 seconds**.

**One deploy cannot refute an "up to" bound**, and this receipt does not claim it does. What it shows is
that the *typical* case is an order of magnitude better than the ceiling, which makes the config comment
pessimistic rather than wrong. `cron.propagation_ceiling_seconds = 900` records the documented bound,
because that is the number a design must survive; the 74 s is a single observation and is not recorded as
a value.

## The trigger ceiling: the docs contradict themselves, and it does not matter

Two Cloudflare pages disagree, and both were read:

| Page | Says |
|---|---|
| `/workers/platform/limits/` | "Number of Cron Triggers **per account**" — 5 Free, 250 Paid |
| `/workers/configuration/cron-triggers/` | "the maximum number of Cron Triggers **per Worker**" — linking to the page above |

The Free figure does not bind: **ADR 25 makes Workers Paid mandatory**, and `mailda deploy` refuses on
Free. So the number in play is **250**.

**This was not settled by measurement, deliberately.** Distinguishing per-account from per-Worker requires
approaching the ceiling, which on the account available here means declaring ~250 cron triggers alongside
**60+ unrelated Workers, one of which carries live production mail**. If the limit is per-account, doing
that consumes budget shared with those Workers and their next deploy could be refused — breaking somebody
else's production to settle a documentation question. There is also no way to size a safe-but-decisive
experiment from here: enumerating the account's current cron usage needs a REST API token, and only
interactive OAuth was available. **Settling it needs a throwaway account with nothing else in it.**

`cron.trigger_ceiling_per_account = 250` therefore records the **conservative reading**, and the name says
which reading it is. Designing for per-account is safe under both readings; designing for per-Worker is
broken under one. A Node must not assume it owns the budget in any case, because it cannot discover from
inside the Worker how much of it the customer's other Workers already hold.

## Why the ceiling is nearly moot: a schedule is deploy-time config and a Butler is runtime data

The more decisive fact, and it settles the design question the count was being asked for.

- *"If a Worker is managed with Wrangler, Cron Triggers should be **exclusively managed through the
  Wrangler configuration file**."*
- *"When deploying a Worker with Wrangler **any previous Cron Triggers are replaced** with those specified
  in the `triggers` array."* An empty `crons` array removes all of them; an **undefined** `triggers` or
  `crons` leaves the deployed ones in place.

Workflow `schedules` live in the same file, so they inherit the same property.

A Butler is **published at runtime** — that is what invariant 9's immutable versions are about. A cron
trigger is **deploy-time configuration**. So a per-Butler platform schedule would mean either a `wrangler
deploy` every time somebody publishes a Butler, or managing triggers through the API — where the next
ordinary update **replaces them wholesale**, because this Node's config declares `crons`. ADR 24 makes
updates routine (`git pull`, deploy), so that second path means a routine update silently deletes every
Butler schedule.

**So Butler schedules have to be multiplexed through a small, fixed number of Node-owned triggers**, with
the schedules themselves as rows the Node evaluates — which is the shape `response-clock.ts` already has,
and the reason its module header insists the sweep stay a scan. The count ceiling stops being the binding
constraint; the deploy-time nature of the config is.

## What this found in shipped code

`src/index.ts`'s scheduled handler takes `_controller` — the underscore is real, the parameter is
discarded — and writes a log line **only when a breach occurs**. So the Node keeps **no record of its own
cron firings**, and therefore:

- It cannot say when its sweep last ran, or whether the cron is firing at all. A cron that silently
  stopped would look exactly like a Node with nothing overdue.
- That is the same failure the `wrangler.jsonc` comment worries about — *"`doctor` should report the
  capability rather than let silence read as 'nothing is late'"* — and it is currently unaddressed,
  because `doctor` has nothing to read.

**Recommendation on record, not built here** (Layer 4 is being planned, not implemented, and this is a
Layer 3 gap): the sweep should record each firing's `scheduledTime` and actual entry time, so `doctor` can
report *"last swept N seconds ago"* and turn cron liveness into an observable. The measurement above shows
what a healthy reading looks like — sub-second-to-single-digit lateness against a stable offset — so a
threshold has a receipt behind it rather than a guess.

## Sized

- `cron.trigger_ceiling_per_account = 250` — documented, Workers Paid, and the **conservative** reading of
  two contradictory pages. Not measured; the measurement is unsafe on a shared production account.
- `cron.propagation_ceiling_seconds = 900` — the documented "up to 15 minutes". A design must survive it;
  one observation of 74 s does not lower it.
- `cron.observed_lateness_p99_ms` — from the sample below, against `controller.scheduledTime`. A
  **sighting figure, not a service level**: one Worker, one account, one schedule, over well under an hour.
  It is recorded so that a later, longer run has something to disagree with.
