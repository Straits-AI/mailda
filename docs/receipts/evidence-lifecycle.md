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

The table above is the **raw** prefix only. A second prefix with a different referent rule was added on
19 August 2026 — see the correction below.

## Correction, 19 August 2026: the pass gained a second prefix, and `list_limit` is per prefix (#67)

**No value moved.** `reconcile.list_limit: 200` and `reconcile.orphan_grace_seconds: 3600` both still hold,
for the reasons below, and neither was re-derived. What changed is the shape of the pass: #67 gave it
`${orgId}/drafts/`, whose referent is a row in `drafts` keyed by `body_key` rather than an `ingress_receipt`,
so a draft body left behind by `deleteDraft` is now collected through the pass's single `EVIDENCE.delete`
instead of persisting for the lifetime of the bucket. Recorded here because the derivation under *Reconcile
list limit: 200* above is written as though there were one listing, and after this change there are two.

**No `stale_when` clause fired**: `R2Bucket.list()`'s per-call limit did not move, the per-invocation
subrequest cap did not move, and re-seal is untouched. The clause is deliberately **not** widened either,
because the condition that would matter here — a third prefix, or a per-object cost appearing in the draft
direction — is checked by a test below rather than described in prose, and this file already records what a
`stale_when` is worth on its own.

**Measured, on 19 August 2026, with `metering()` from `src/cost-meter.ts` wrapped around one
`reconcileEvidence` call under `vitest-pool-workers` (`pnpm vitest run`), against miniflare:**

| Pass | Subrequests | D1 | R2 |
|---|--:|--:|--:|
| empty bucket, read-only | 5 | 3 | 2 |
| empty bucket, `collect` | 6 | 4 | 2 |
| **5 stranded draft bodies**, read-only | **5** | 3 | 2 |
| 5 raw objects with no receipt, read-only | 10 | 8 | 2 |
| 5 stranded draft bodies, `collect` | 11 | 4 | 7 |

Three figures in that table are the whole cost argument for putting the sweep here:

- **The draft direction is flat.** Five stranded bodies cost exactly what zero cost, because the referents
  come back in **one** bulk `SELECT body_key` with no `LIMIT`. Measured directly on the scan function alone as
  well: 2 subrequests (1 D1, 1 R2 `list`) at 0 objects and 2 at 5.
- **The raw direction is not**, and never was: five objects cost five extra D1 executions, one lookup per
  listed key. That is the asymmetry the `list_limit` derivation above is really about.
- **`collect` costs one D1 query more than read-only**, once per pass: `anyActiveHold` (#64). It is asked only
  when collection was requested, which is why `doctor`'s read-only call pays nothing for it — see
  `doctor-check-cost.md`'s correction of the same date, which measures that path at 13 → 13.

**`list_limit` applies per prefix, so the worst case a full pass can reach roughly doubled.** Derived from the
per-object figures above rather than measured — reaching it needs 400 objects and 200 receipts, which no
fixture here builds:

| Term | Cost | |
|---|--:|:--|
| listings | 2 | one per prefix |
| raw referents | 200 | one D1 lookup per listed object |
| draft referents | 1 | one bulk query |
| hold check | 1 | once, and only under `collect` |
| deletes | 400 | both prefixes drain the same single delete |
| receipt direction | 202 | count, page, one R2 `head` per sampled receipt |
| **806** | | **4 × `list_limit` + 6** |

That is **under the Free ceiling of 1,000** (`doctor.free.max_subrequests`) with 194 to spare, and far under
Paid's 10,000. It was **604** before this change, so the prefix cost up to 202.

**This one is checked, not just written down.** `test/evidence-lifecycle.test.ts` — *"keeps the worst case a
collecting pass can reach inside the ceiling it was derived against"* — computes `4 × list_limit + 6` from the
budget and asserts it stays under the Free ceiling. Verified non-vacuous by temporarily setting
`reconcile.list_limit: 300` in this file and regenerating: the test failed with *"expected 1206 to be less
than 1000"*. That is the protection the 13 August correction in `doctor-check-cost.md` says a `stale_when`
clause cannot give on its own, and it is why raising `list_limit` is now a change that argues with a test
rather than one that quietly reprices a pass. What it bounds is **the pass, not the invocation**: the route
around it authenticates and authorizes first, and that residue lives in the headroom rather than in the sum.

**The grace window did not need re-deriving, and that is a finding rather than an omission.** It was sized by
asymmetry against `ingress.ts` writing R2 before D1; `saveDraft` writes R2 before its row for the same
reason, so the second referent rule inherits the window unchanged. Collecting a draft body inside it would
delete the body of a draft somebody is part-way through saving — the same unrecoverable error as deleting mail
that was about to be accepted, which is what the hour was chosen to make impossible.
