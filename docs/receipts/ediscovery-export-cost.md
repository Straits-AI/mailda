---
id: ediscovery-export-cost
kind: measured-tripwire
measured_on: 2026-08-20
stale_when: >
  the staging step gains or loses an R2 or D1 operation per message, the run-scoped key cache is removed or
  widened, or r2.list_max_keys_per_call moves
values:
  export.subrequests_per_message: 4
  export.subrequests_per_message_cached: 2
  export.page_size: 100
  export.max_messages_ceiling: 1000
---

What one message costs an eDiscovery export (#65), and the two figures derived from it: how many messages one
invocation copies before checkpointing, and the largest export this Node will authorize at all.

## Per message: 4 subrequests, and 2 with the run-scoped key cache

Measured with `metering()` from `src/cost-meter.ts` wrapped around one `runExport` call under
`vitest-pool-workers` (`pnpm vitest run`), against miniflare, on 20 August 2026 —
`test/export-cost.measure.test.ts`, which prints both figures and asserts them against these values:

| | Without the cache | With it |
|---:|---:|---:|
| R2 `get` — fetch the sealed source object | 1 | 1 |
| R2 `put` — write the re-sealed object under `exports/` | 1 | 1 |
| vault RPC — opening key for the source's generation | 1 | 0 |
| vault RPC — sealing key for the export's object | 1 | 0 |
| **per message** | **4** | **2** |

Plus a fixed cost per page that does not scale with the page: 1 D1 for the export row and its live approval,
2 D1 for the `ediscovery.export` recheck (team lookup and tuple lookup, the shape
`authz-check-rows-read.md` measured), 1 D1 for the page itself and 1 D1 for the checkpoint — **5 per page**.
The completing page spends a further `ceil(objects / r2.list_max_keys_with_metadata)` R2 listings — one per
hundred staged objects, because a metadata listing pages — an R2 `put` for the manifest, and the audit
append's 2 D1 (chain tip, then the gated `batch()`).

The four whole runs those figures were differenced from, printed by the test:

| Run | Subrequests | D1 | R2 | DO RPC |
|---|--:|--:|--:|--:|
| 2 messages, no cache | 18 | 7 | 6 | 5 |
| 8 messages, no cache | 42 | 7 | 18 | 17 |
| 2 messages, cached | 15 | 7 | 6 | 2 |
| 8 messages, cached | 27 | 7 | 18 | 2 |

**D1 is flat at 7 across all four**, which is the checkpoint doing its job: the page is one query and the
cursor is one update however many messages the page carries, so an export's D1 cost is per page and never per
message. **DO RPCs are flat at 2 with the cache and 2n + 1 without it**, which is what the two figures above
are. Differencing is what isolates them: `(42 − 18) / (8 − 2) = 4` and `(27 − 15) / (8 − 2) = 2`.

**How "without the cache" is measured, since `runExport` always has one.** There is deliberately no
production switch to turn it off — one would be a landmine, because somebody would eventually pass it. The
uncached arm is measured by handing the real run a cache **double that reports every lookup as a miss**, so
the code path under measurement is the shipped one and the only difference is whether the vault is asked
again.

### The 6-per-message figure this was sized against, and why the measurement is lower

#65's resolution costed a read-decrypt-re-emit at **6** subrequests per message, taken from
`evidence-lifecycle.md`'s re-seal shape: head, get, put, one D1, and two uncached vault RPCs. The export
measures **4** uncached, and the two missing terms are real differences rather than a better implementation:

- **no R2 `head`.** Re-sealing heads the object first because the object's `customMetadata` is the
  authoritative answer to which key opens it *and* the thing it is about to overwrite. An export reads the
  source with `get`, which returns the metadata in the same response, and writes somewhere else.
- **no per-message D1.** Re-seal advances an index row per message. An export advances **one checkpoint per
  page**, which is the whole point of the cursor (blueprint:1276), so the D1 cost is amortised across the
  page rather than paid per message.

So the resolution's capacity arithmetic was **conservative by 50%**, not wrong: it sized the feature against a
per-message cost higher than the one the feature has. The claim it made about the cache is exactly right —
caching removes **2 of the per-message subrequests**, which here is a halving rather than a third off.

### Why the cache is scoped to one run

`openingKey` and `sealingKey` are Durable Object RPCs, and the same two are asked for every message in a run.
Caching them within one `runExport` call removes both. The cost of caching a content key is **staleness of
that key against revocation**, and confining it to one run bounds that at one run — which is already the unit
the export's approval authorizes.

An isolate-wide cache was rejected despite a good precedent (`auth/keys.ts:200` caches signing keys with its
TTL reasoned explicitly as *"a staleness bound on key revocation"*). It would make content-key revocation
eventually-consistent **product-wide** in order to speed up one feature — a heavier promise than the one being
asked for, and one that would have to be argued for on every read path rather than on this one.

## Page size: 100 messages

Derived, not measured separately: `100 × 2 + 5 = 205` subrequests for a full page with the cache, which is
**20% of the Workers Free ceiling** (`doctor.free.max_subrequests = 1000`) and 2% of Paid's. It is the same
figure and the same argument `reseal.batch_size` records: the subrequest ceiling no longer binds this choice,
and what does is that a failing page costs a retry of the whole page, and nothing has measured the CPU or
wall-clock cost of a 500-message page against the 5-minute limit. **A bound that has become generous is not
thereby wrong** — raising it is a fresh measurement rather than an arithmetic consequence.

Sizing it *lower* would be wrong for a reason worth stating: the fixed 5 per page is paid whichever page size
is chosen, so a page of 10 spends a third of its budget on rechecking rather than on copying. The recheck is
non-negotiable — §7 requires revocation to terminate an export — so the page has to be big enough that the
recheck is a rounding error, and at 100 it is 2.4%.

## Ceiling: 1,000 messages per export, and the boundary it names

Derived from `r2.list_max_keys_per_call` and equal to it: the manifest build pages one `R2Bucket.list()` over
the export's own prefix and stops at that many objects, so an export that staged more could not have a
manifest naming all of them.

`requestExport` refuses `maxMessages` above this **at request time**, with both numbers and the reason, rather
than letting a long run end in a short manifest. That is blueprint:1280 applied literally: *"Mailda exposes
that boundary rather than building an unreliable workaround"*.

### Correction, 20 August 2026: the build was a single call and could not have been

The first version of this section said the manifest was built from **one** listing, and derived the ceiling
from a bare listing's cap of 1,000. Both halves were wrong together, and the second hid the first: a listing
that asks for `include: ["customMetadata"]` returns at most `r2.list_max_keys_with_metadata` keys — a hundred,
measured — so a single call could name a hundred objects and the ceiling authorized ten times that. An export
above a hundred messages staged every byte and then threw `E_EXPORT_MANIFEST_TRUNCATED` on every attempt to
finish. See `docs/receipts/r2-list-page-size.md`, which now carries both figures and the measurement.

**The build pages the listing** and the ceiling keeps its meaning and its number. Paging is not the
"unreliable workaround" the blueprint clause warns about — the cursor is the documented way to finish a
listing, Cloudflare's own reference tells callers to read `truncated` rather than compare counts, and the
build is idempotent: an invocation that dies mid-manifest leaves the export `running`, and the next one finds
an empty page and rebuilds the whole thing from R2. What it costs is `ceil(objects / 100)` subrequests
**once**, at completion — 10 at the ceiling, against a completing page that already spends about 205.

The failure this refuses is specific: a manifest that omitted messages would be **worse than no manifest**,
because it reads as a complete account of what was disclosed. That is the same asymmetry that makes the run
abort at `max_messages` rather than truncate to it.

**Both bounds are checked rather than described.** `test/ediscovery-export.test.ts` refuses a request above
the ceiling and asserts the message names `export.max_messages_ceiling`; *"carries the cursor across pages"*
exports 105 messages — more than one metadata listing can name — and asserts the manifest names all 105; and
`test/export-cost.measure.test.ts` asserts the per-message figures with and without the cache — so the cache's
saving is a measurement this repository re-runs, not a sentence in a resolution.
