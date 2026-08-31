---
id: evidence-integrity-cost
kind: measured-tripwire
measured_on: 2026-08-31
stale_when: >
  the per-invocation subrequest cap moves from 1,000; evidence stops being one R2 object per message, since
  the two subrequests per receipt below assume exactly that; the frame size in evidence-frame-size.md changes
  enough to move the decrypt cost materially; a verification begins reading rows other than
  ingress_receipts; or the vault key cache stops being held for a whole batch, which is what keeps the key
  RPCs off the per-message cost
values:
  evidence.verify_batch: 200
  evidence.verify_subrequests_per_receipt: 2
---

# What it costs to prove the evidence is still what was recorded

Issue [#92](https://github.com/Straits-AI/mailda/issues/92). The restore drill's step 5 — *"prove a sampled
set of raw messages decrypt and hash-verify against the manifests"* — is the step the ticket says makes the
rest true. It needs a verifier, and the number that bounds one is how many messages fit in an invocation.

## The cost of one receipt

Two subrequests, and only two:

| Operation | Subrequests | Why not more |
| --- | --- | --- |
| `EVIDENCE.get(blob_key)` | 1 | one R2 object per message, header and frames together |
| vault opening key | 0 amortised | one Durable Object RPC **per generation per batch**, from `runKeyCache` |
| `SHA-256` of the plaintext | 0 | `crypto.subtle`, in the isolate |
| D1 page of receipts | 1 per batch | keyset pagination, one query for the whole batch |

So a batch of *n* receipts costs `n + 2` subrequests: one `get` each, one D1 page, and one key RPC for the
generation they share. The key cache is what makes the second row zero rather than *n* — without it a batch
of 200 would spend 400, and the reason it is a per-run parameter rather than an isolate-wide map is argued in
`evidence-store.ts`.

## Why 200 and not 900

The per-invocation cap is 1,000 subrequests, so arithmetic alone would allow ~995. The batch is **200**, and
the headroom is deliberate for three reasons:

1. **The route is not alone in its invocation.** Authorization, the audit append and the cost meter all spend
   subrequests before the first `get`. A bound set at the arithmetic maximum is a bound that fails whenever
   anything else in the request grows, and the failure mode is a partial sweep reported as a clean one.
2. **Wall clock, not just subrequests.** 200 messages at the measured frame size is the interval an operator
   will actually wait for a response, and a resumable verifier that times out is not resumable.
3. **A sweep is resumable by design**, so a smaller batch costs nothing but more round trips. The direction
   the number can be wrong in matters: too small wastes requests, too large loses coverage silently.

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
