---
id: evidence-lifecycle
kind: measured-tripwire
measured_on: 2026-08-04
stale_when: >
  R2 list() changes its per-call object limit, the 1,000-subrequest per-invocation cap changes, or a
  measured re-seal of one message moves materially from 6 subrequests
values:
  reseal.batch_size: 100
  reseal.subrequests_per_message: 6
  reconcile.list_limit: 200
  reconcile.orphan_grace_seconds: 3600
---

Two bounded operations over stored evidence: **re-sealing** it under a new content key (ADR 28), and
**reconciling** R2 against `ingress_receipts` (§13, §24). Both are bounded by the same thing —
1,000 subrequests per invocation — and both must say what they examined.

## Re-seal batch: 100 receipts

Measured per message on the deployed Node, re-sealing the 7,053-byte Gmail message from generation 0
to generation 1:

| | |
|---:|:---|
| 1 | R2 `head` — read the object's generation, which is authoritative |
| 1 | R2 `get` — fetch the sealed bytes |
| 1 | R2 `put` — write the re-sealed object |
| 1 | D1 update — advance the index |
| 2 | vault RPC — sealing key, opening key |
| **6** | **subrequests per message** |

Plus 2 fixed (candidate query, remaining count). At 100 per batch that is **602 subrequests**.

**Corrected 13 August 2026.** This originally read "inside the 1,000 cap", and 1,000 has not been the
per-invocation ceiling since **11 February 2026** — the Paid default is now **10,000**, configurable to 10
million. See the correction in `doctor-check-cost.md`, which carried the same withdrawn figure as a value.

So the subrequest ceiling **no longer binds this choice**: 602 sits at 6% of it, and even 200 per batch
(1,202) would fit ten times over. `reseal.batch_size` stays **100** anyway, and the reason is now explicit
rather than inherited — the original derivation's *other* half still holds, which is that a failing message
costs a retry, and nothing has measured the CPU or wall-clock cost of a 200-message batch against the
5-minute CPU limit. **A bound that has become generous is not thereby wrong.** Raising it is a fresh
measurement, not an arithmetic consequence of somebody else's cap changing.

A shard holds ~8.5M messages (`message-metadata-bytes.md`), so a full re-seal is **~85,000
invocations**. That is why the operation is resumable rather than a script, and why progress lives in
an indexed column instead of in memory.

## Reconcile list limit: 200

`R2Bucket.list()` accepts up to 1,000 keys per call, but each listed object then costs a D1 lookup to
decide whether it is an orphan, and each sampled receipt costs an R2 `head`. So the real bound is
subrequests, not the list API: 200 objects + 200 receipts ≈ 400 subrequests plus fixed overhead.

`truncated` is reported in the output. A pass that examined 200 of 8.5M objects and said "no orphans"
would be a lie, and the same rule applies here as to `doctor`'s evidence sample.

## Orphan grace: 3,600 seconds

**Sized by asymmetry, not by measurement, and that is the honest description.** A blob without a
receipt is either a lost transaction or *a delivery still in flight* — `ingress.ts` writes R2 before
D1, so the gap between the two is a real window.

The grace period must exceed the longest possible gap. Being slow to collect an orphan costs an hour
of R2 storage for a few kilobytes. Being fast deletes mail that was about to be accepted, and that is
unrecoverable. With a cost ratio like that, the correct sizing is "generous by a wide margin" rather
than "tight and measured" — an hour is orders of magnitude beyond a Worker invocation's own lifetime.

## What each direction is allowed to do

| Found | Meaning | Action |
|---|---|---|
| Object with no receipt, past grace | A write that lost its transaction | Delete, but only when explicitly asked |
| Object with no receipt, inside grace | Possibly a delivery in flight | Count it, touch nothing |
| Receipt with no object | **Lost mail** | Enumerate and report. Never repaired, never deleted |

Deleting a receipt whose evidence is gone would convert a *detectable* data loss into an undetectable
one. It is also the tempting option, because it is the one that makes the report go green.
