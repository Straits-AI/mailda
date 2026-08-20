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
  reconcile.list_limit: 150
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

## Correction, 20 August 2026: a third prefix, and `list_limit` comes down from 200 to 150 (#65)

**A value moved, and it moved because the check written on 19 August fired.** That is the whole point of the
paragraph above which says the `stale_when` clause was *deliberately not widened* to cover a third prefix,
because "the condition that would matter here is checked by a test below rather than described in prose". The
condition arrived: #65's eDiscovery export gave the reconciler `${orgId}/exports/`, whose referent is a row in
`exports` keyed by the id in the object key's own second segment — a third rule again, and "no receipt" is not
the test for one of those either.

**No `stale_when` clause fired**, and both are still true: `R2Bucket.list()`'s per-call limit did not move
(it is now recorded as a value of its own in `r2-list-page-size.md`), the per-invocation subrequest cap did
not move, and re-seal is untouched. What fired was `test/evidence-lifecycle.test.ts`.

### The arithmetic, generalised, because it has now been re-derived twice

For `n` scanned prefixes, of which exactly one (`raw/`) samples per object and the rest answer in one bulk
query:

| Term | Cost | |
|---|--:|:--|
| listings | `n` | one `R2Bucket.list()` per prefix |
| raw referents | `list_limit` | one D1 lookup per listed object |
| bulk referents | `n − 1` | one query each for drafts and for exports |
| hold check | 1 | once, and only under `collect` |
| deletes | `n × list_limit` | every prefix drains the same single delete |
| receipt direction | `2 + list_limit` | count, page, one R2 `head` per sampled receipt |
| **total** | **`(n + 2) × list_limit + (2n + 2)`** | |

At `n = 2` that is `4 × list_limit + 6` — **806** at 200, which is exactly the figure the 19 August correction
recorded, so the generalisation is checked against the measurement that already existed rather than replacing
it.

At `n = 3` it is `5 × list_limit + 8`. **At a `list_limit` of 200 that is 1,008, which is over the Free
ceiling of 1,000.** Adding the prefix without touching this value would have left the assertion protecting it
false — the exact outcome the 19 August correction said a `stale_when` clause cannot prevent on its own and a
test can.

### Why 150 rather than 198

198 is the largest value satisfying `5 × list_limit + 8 < 1000`, and it is the wrong answer: it leaves 2
subrequests of headroom, and the **fourth** prefix is already known to be missing. `${orgId}/sent/` holds
submitted bytes (`src/outbound/dispatch.ts`, `src/outbound/manifest.ts`) and is not scanned; #65's grounding
found it and filed it rather than repairing it, because its referent question is its own decision.

So the value is sized for `n = 4`: `6 × 150 + 10 = 910`, under 1,000 with 90 to spare, and `5 × 150 + 8 = 758`
today with 242. Sizing for the prefix that is already coming is what stops this being re-derived a third time
by whoever adds it — which is the same reasoning `reseal.batch_size` uses when it declines to rise to meet a
ceiling that moved.

**What it costs.** A pass examines 150 objects per prefix instead of 200 and 150 receipts instead of 200. The
pass was never exhaustive — `truncated` is reported precisely because it is a sample — so the change is that
a very large bucket takes proportionally more passes to sweep. Being slow to collect is free; the asymmetry
recorded under *Orphan grace* above applies to this direction too.

**Verified non-vacuous.** Setting `reconcile.list_limit: 200` in this file and regenerating fails
`test/evidence-lifecycle.test.ts` with *"expected 1008 to be less than 1000"*, and setting it back passes.
That is the check doing its job on the change it was written for.

### The export prefix's per-object cost, measured

Same instrument as the 19 August table — `metering()` around one `reconcileEvidence` call under
`vitest-pool-workers`, against miniflare, on 20 August 2026:

| Pass | Subrequests | D1 | R2 |
|---|--:|--:|--:|
| empty bucket, read-only | 7 | 4 | 3 |
| **5 stranded export objects**, read-only | **7** | 4 | 3 |
| 5 stranded export objects, `collect` | 13 | 5 | 8 |

**Flat, like the draft direction and for the same reason**: the referents come back in one bulk
`SELECT id FROM exports` with no `LIMIT`. Five stranded objects cost exactly what zero cost. The read-only
pass moved from 5 to 7 — one `list` and one bulk query — which is the +2 the arithmetic above charges for a
bulk prefix, confirmed rather than assumed.

## Correction, 20 August 2026 (second of the day): a fourth prefix, and the limit does not move (#74)

**No value moved, and that is the whole point of the correction above it.** The #65 section chose 150 over the
arithmetically permitted 198 *specifically* so a fourth prefix would not force a third re-derivation. The
fourth prefix has arrived — `${orgId}/sent/` — and the sum goes from 758 to **910**, under the Free ceiling of
1,000 with 90 to spare, exactly as that paragraph priced it. `reconcile.list_limit: 150` and
`reconcile.orphan_grace_seconds: 3600` both stand unchanged, and neither was re-derived.

**No `stale_when` clause fired**: `R2Bucket.list()`'s per-call limit did not move, the per-invocation
subrequest cap did not move, and re-seal is untouched.

#74 is **#67's defect in a second place**: a prefix this Worker wrote and no listing covered, invisible for
exactly the reason #67 was invisible — nothing reported the gap. That pattern is now closed as a class rather
than a third time: `test/node/evidence-prefix-world.test.ts` derives every `${orgId}/<segment>/` any writing
file in `src/` spells and fails if `scannedPrefixes` does not cover it, in both directions. It is what lets
`formatReconcile` say *"every prefix this Worker writes for this organization"* instead of hedging about
objects it did not list — a claim about the whole source tree, so a claim that had to be enforced somewhere
rather than asserted in the sentence itself.

### The fourth referent rule, and the one query shape in this pass that is not a whole-column read

An object here is `${orgId}/sent/${manifestId}/{typed.txt,normalized.txt,submitted.eml}`, so the referent is a
`send_manifests` row keyed by the id in the key's **second segment**: three objects resolve to one row, and the
lookup is therefore per manifest rather than per object. Same key shape as `exports/`, deliberately not the
same argument — nothing in this product deletes a `send_manifests` row, so an object with no row is only
reachable through a lost transaction, which is the `raw/` story. It takes the **orphan rule**: the grace
window, and #64's org-wide hold suppression.

`scanDraftBodies` and `scanExportObjects` each read one whole column with no `LIMIT`, justified by what their
table is — `drafts` is working state deleted at seal, `exports` grows with investigations. **Neither reason
survives here.** `send_manifests` grows with every message this Node has ever sent, for ever, so the same
shape would be a table scan that gets slower for the life of the Node. So the referents are bounded by the
page's own id span, as one `BETWEEN` over the primary key: `WHERE org_id = ? AND id >= ? AND id <= ?` over the
minimum and maximum manifest id in the listing. One query, flat in the object count, and the completeness
argument is *stronger* than a whole-column read rather than weaker — every id the page will judge lies between
the minimum and maximum of that same set by construction, with no dependence on R2 returning keys in order.
Its stated limit: a page whose ids span the whole table reads the whole column, so it is never worse than the
other two and usually far better, and it is not a constant.

An empty page asks the referent table **nothing**, because the minimum of no ids does not exist. That is why
this scan costs 1 subrequest on a Node that has never sent and 2 on one that has.

### Measured

Same instrument and the same boundary as the two tables above — `metering()` from `src/cost-meter.ts` around
one call under `vitest-pool-workers` (`pnpm vitest run`), against **miniflare**, on 20 August 2026. Re-runnable
rather than transcribed: `test/sent-evidence.test.ts` — *"what the fourth prefix costs the pass, metered"* —
prints these and asserts the flatness.

| Pass | Subrequests | D1 | R2 |
|---|--:|--:|--:|
| `scanSentObjects`, 0 objects | **1** | 0 | 1 |
| `scanSentObjects`, 6 objects across 2 manifests | **2** | 1 | 1 |
| whole pass, empty bucket, read-only | 8 | 4 | 4 |
| whole pass, empty bucket, `collect` | 9 | 5 | 4 |
| whole pass, 3 stranded sent objects, read-only | 9 | 5 | 4 |
| whole pass, 3 stranded sent objects, `collect` | 13 | 6 | 7 |

**Flat, like the other two bulk directions**, and for a bounded query rather than an unbounded one: six objects
across two manifests cost one referent query, not six and not two. The empty-bucket read-only pass moved from
**7 to 8** — one `list`, and no D1 at all, because an empty page asks nothing — so the +2 the arithmetic charges
for a bulk prefix is only spent once the prefix has objects in it. `collect` costs the hold check plus one
`EVIDENCE.delete` per collected object and nothing else: 9 → 13 for three objects.

### How much `sent/` grows relative to mail sent — the figure nobody had

Measured the same way, on 20 August 2026, in `test/sent-evidence.test.ts` — *"what one send costs under the
fourth prefix, measured"*, which prints the numbers on every run:

| | |
|---:|:---|
| **3** | objects per handed-over send: `typed.txt` and `normalized.txt` at seal, `submitted.eml` at hand-over |
| **2** | objects per send that never hands over — cancelled, withheld, or still held |
| **48** | bytes of frame overhead per object, isolated by differencing a 47-byte plaintext against its 95-byte object |
| **532** | stored bytes for one send of a 47-byte body: 95 + 93 + 344 |
| **188** | stored bytes a cancelled send of the same body leaves staged |

One object per manifest whatever the recipient count — the same bytes go to every recipient — so this is linear
in **sends**, not in deliveries. The body is carried three times (typed, normalized, and inside the submitted
RFC 822 bytes), so the rule of thumb is *three copies of the message plus its headers plus 144 bytes*, per send.

**The growth is unbounded and nothing reports it, and that is a finding rather than a footnote.** Nothing in
this product deletes a `send_manifests` row, so every one of these objects is **referenced** for the life of
the Node — the reconciler will never collect them, and it is not supposed to: two of the three are the
composition evidence §12 invariant 2 calls immutable. A Node that composes heavily and sends rarely still
accumulates two objects per attempt for ever, `doctor` has no figure that names it, and the cost meter does not
price stored bytes. Filed as **#76** rather than recorded here as an aside, because a growth term with no
observable is the same shape of defect as a prefix with no listing.

### A fifth prefix does not fit, and the assertion now says so

`test/evidence-lifecycle.test.ts` used to assert the *next* prefix still fitted, which was true at `n = 3` and
is false at `n = 4`: `7 × 150 + 12 = 1,062`, over the ceiling. Keeping that shape would have left the test
claiming headroom it no longer has — a sentence describing a state the code had left, which is the defect #74
is about. It asserts the negative instead, so whoever adds a fifth prefix re-derives `list_limit` deliberately
rather than discovering it under load.

**Verified non-vacuous.** Setting `reconcile.list_limit: 140` here and regenerating fails that test with
*"a fifth prefix at this list_limit is over the Free ceiling — re-derive it, do not widen the scan: expected 992
to be greater than 1000"*, and setting it back to 150 passes. The main inequality was verified the same way on
20 August at 200, recorded above.
