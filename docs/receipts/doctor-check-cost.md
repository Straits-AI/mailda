---
id: doctor-check-cost
kind: measured-tripwire
measured_on: 2026-08-05
stale_when: >
  Cloudflare changes the per-invocation subrequest ceiling again, the Worker starts declaring a
  limits.subrequests block (which would override the platform default), R2 head stops counting as a
  subrequest, doctor gains a check that costs a subrequest per row, or the measured cost of a
  doctor run changes materially — including any new fixed-cost check, which is what made the
  4 August figure stale
values:
  doctor.evidence_sample_size: 200
  doctor.max_subrequests: 10000
  doctor.max_subrequests_per_run: 220
---

## Correction, 13 August 2026: this receipt shipped stale

`doctor.max_subrequests` was **1000**, and the `stale_when` above named the exact condition that
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

`doctor` verifies the runtime claims other decisions made. Most of its checks cost one query; one
of them — evidence integrity — costs **one R2 `head` per receipt examined**, which is why it has a
bound at all.

## The bound, and why it is a sample

A Worker invocation may issue at most **1,000 subrequests** (the same cap #4 sized service-binding
fan-out against). Both D1 queries and R2 operations spend one. `message-metadata-bytes.md` measured
that a 10 GB shard holds **~8.5 million messages**, so "check every receipt" is not a bounded
operation and never becomes one.

**200 receipts, most recent first.** Derivation rather than taste:

| | |
|---:|:---|
| 1,000 | subrequests available |
| ~10 | spent by every other check (schema, KEKs, keys, outbox, counts) |
| 200 | R2 `head` calls |
| ~790 | headroom, so adding a check never silently pushes this over the cap |

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
| **20** | subrequests total, against a cap of 1,000 |

Re-measured 5 August 2026 on a catalog holding 5 receipts, 22 tables and 1 current signing key. The
4 August figure was 7 D1 / 1 R2 / 8 subrequests on a catalog with 1 receipt and 14 tables; the
difference is the checks added since (outbound state, audit chain) plus one new fixed-cost check
below, not a regression in any single check. Recorded rather than quietly replaced, because a receipt
whose number moves without saying why is a receipt nobody trusts the second time.

**`evidence_bucket_reachable` costs one R2 `head` per run, not per row.** That distinction is the one
`stale_when` cares about: a fixed cost is absorbed by the ~790 subrequests of headroom, while a
per-row cost is what `doctor.max_subrequests_per_run` exists to catch. It was added because the
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
