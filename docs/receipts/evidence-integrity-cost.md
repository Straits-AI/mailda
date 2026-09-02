---
id: evidence-integrity-cost
kind: measured-tripwire
measured_on: 2026-09-02
stale_when: >
  the per-invocation subrequest cap moves from 1,000; evidence stops being one R2 object per sealed body,
  since the two subrequests per object below assume exactly that; the frame size in evidence-frame-size.md
  changes enough to move the decrypt cost materially; a fifth prefix is added, since the walk-forward cost
  below is bounded by the number of tables; or the vault key cache stops being held for a whole batch, which
  is what keeps the key RPCs off the per-object cost
values:
  evidence.verify_objects: 200
  evidence.verify_subrequests_per_object: 2
  evidence.verify_tables: 4
---

# What it costs to prove the evidence is still what was recorded

Issue [#92](https://github.com/Straits-AI/mailda/issues/92), re-measured for
[#131](https://github.com/Straits-AI/mailda/issues/131). The restore drill's step 5 — *"prove a sampled set
of raw messages decrypt and hash-verify against the manifests"* — is the step the ticket says makes the rest
true. It needs a verifier, and the number that bounds one is how much fits in an invocation.

## Why this was re-measured rather than adjusted

The previous version of this receipt bounded **receipts**, and its own `stale_when` named the condition that
has now happened: *"a verification begins reading rows other than `ingress_receipts`"*. #131 is that change —
the verifier swept inbound mail only while the inventory covered all four prefixes, so a Node whose evidence
is drafts or staged sends verified nothing and said it was clean.

A row bound cannot survive that widening, because rows stopped costing the same. One `send_manifests` row
stages **three** objects; one `ingress_receipts` row stages one. The cost this number exists to bound is the
R2 `get` and the decrypt, and both happen per **object**. So the figure is now an object bound, and the rows
per page are derived from it: `floor(200 / columns)` — 200 rows of receipts, drafts or exports, and 66 rows
of sends.

That is the same underlying measurement, expressed in the unit that stays constant across tables.

## The cost of one object

Two subrequests, and only two:

| Operation | Subrequests | Why not more |
| --- | --- | --- |
| `EVIDENCE.get(key)` | 1 | one R2 object per sealed body, header and frames together |
| vault opening key | 0 amortised | one Durable Object RPC **per generation per batch**, from `runKeyCache` |
| `SHA-256` of the plaintext | 0 | `crypto.subtle`, in the isolate |
| D1 page of rows | 1 per batch | keyset pagination, one query for the whole page |

So a batch of *n* objects costs `n + 2` subrequests. The key cache is what makes the second row zero rather
than *n* — without it a batch of 200 would spend 400, and the reason it is a per-run parameter rather than an
isolate-wide map is argued in `evidence-store.ts`.

**Plus at most three more, and this is new.** A batch begins by walking forward past tables that are empty,
because an empty table must not end a sweep. Each skipped table costs one D1 query, and there are four
tables, so the walk-forward adds at most three. A Node with no drafts, no exports and no sends spends four
queries to discover it has only receipts — once per batch, not once per row.

Worst case per invocation: `200 + 1 + 3 + 1` = **205** subrequests.

## Why 200 and not 900

The per-invocation cap is 1,000 subrequests, so arithmetic alone would allow ~990. The batch is **200**, and
the headroom is deliberate for three reasons:

1. **The route is not alone in its invocation.** Authorization, the audit append and the cost meter all spend
   subrequests before the first `get`. A bound set at the arithmetic maximum is a bound that fails whenever
   anything else in the request grows, and the failure mode is a partial sweep reported as a clean one.
2. **Wall clock, not just subrequests.** 200 objects at the measured frame size is the interval an operator
   will actually wait for a response, and a resumable verifier that times out is not resumable.
3. **A sweep is resumable by design**, so a smaller batch costs nothing but more round trips. The direction
   the number can be wrong in matters: too small wastes requests, too large loses coverage silently.

The figure did not move when the unit changed, and that is worth stating rather than leaving to look like an
oversight: 200 receipts cost 200 `get`s before, and 200 objects cost 200 `get`s now. What changed is that the
number is no longer wrong for three of the four tables.

## Why four tables and not one query

`evidence.verify_tables` is the count this sweep walks, and it is **derived** — the verifier groups
`INVENTORY_REFERENTS` by table rather than listing prefixes again. The number is recorded here so the
walk-forward arithmetic above has a stated basis, and so a fifth prefix stales this receipt instead of
quietly making the worst case five.

A single `UNION ALL` over all six referent columns was not an option: D1 answered *"too many terms in
compound SELECT"* when the inventory tried it, which is why that file groups by prefix and why this one
groups by table.

## What is not measured here

**Wall-clock seconds per batch on a live Node.** It has not been run against one — the Node whose evidence
this would sweep is carrying real mail, and this figure is a bound on work per invocation rather than a
latency promise. `bytesRead` is returned in every verdict precisely so an operator sizing a full sweep reads
a measured number rather than this document.

**Wall-clock seconds for a full sweep.** The CLI pages until the Node stops returning a cursor and prints
the megabytes it read, so the figure an operator needs comes from their own run rather than from here.

**A full-database sweep as one figure (RPO/RTO).** #92 asks for both, and both belong to the restore drill in
a clean account rather than to the verifier. Recording an RTO estimated from a batch bound would be exactly
the kind of number this repository refuses.

**Whether a mixed-generation batch costs more.** The key cache is per generation, so a Node holding evidence
under several content keys spends one extra RPC each. Bounded by the number of generations, which is small
and not measured here.
