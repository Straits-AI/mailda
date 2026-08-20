---
id: r2-list-page-size
kind: platform-limit
measured_on: 2026-08-20
stale_when: >
  Cloudflare changes the maximum number of keys one R2Bucket.list() call returns, changes how many keys a
  listing that asks for customMetadata returns, or the Workers R2 binding gains a way to page a listing
  without a second subrequest
values:
  r2.list_max_keys_per_call: 1000
  r2.list_max_keys_with_metadata: 100
---

**How many keys one `R2Bucket.list()` returns at most — and the second number, which is the one that
mattered.** A bare listing caps at **1,000**. A listing that asks for `customMetadata` caps at **100**, and
those are different calls with different limits even though they are the same method.

`r2.list_max_keys_per_call` was prose in `evidence-lifecycle.md` from the day the reconciler was written
(*"`R2Bucket.list()` accepts up to 1,000 keys per call"*) and was never a value, because nothing divided by
it. #65 made something divide by it: an eDiscovery export's **manifest** is built from a listing of the
export's own prefix, so how many keys a listing can name decides how large an export can be. A number that
decides a refusal is a number that needs a receipt (AGENTS.md §2), so it is one now.

## Measured, on 20 August 2026, against workerd under `vitest-pool-workers`

Not read off a page and trusted, because the thing being relied on is what the *runtime this code runs
against* does when asked for more. 260 objects staged under one prefix, each with `customMetadata`, then
listed four ways:

| `limit` asked for | bare listing | with `include: ["customMetadata"]` |
|---:|:--|:--|
| 100 | 100 keys, `truncated: true` | 100 keys, `truncated: true` |
| 101 | 101 keys, `truncated: true` | **100 keys**, `truncated: true` |
| 150 | 150 keys, `truncated: true` | **100 keys**, `truncated: true` |
| 1000 | 260 keys, `truncated: false` | **100 keys**, `truncated: true` |

**A metadata listing ignores any `limit` above 100.** Cloudflare's Workers API reference says the same thing
in weaker words — *"if you request data, you may receive fewer than `limit` results in your response to
accommodate metadata"*, and tells callers to *"use the `truncated` property to determine if the `list`
request has more data to be returned"* rather than comparing counts against the limit. So 100 is what this
runtime does today and `truncated` is the only thing a caller may rely on; the value is recorded because the
export's cost arithmetic needs a figure, and the loop is written against `truncated` because the figure is
not a guarantee.

**The cursor pages it correctly**, which is what makes the loop possible at all: the same 260 objects came
back in **3 calls**, in key order, with every `customMetadata` intact.

`test/ediscovery-export.test.ts` — *"carries the cursor across pages, so a second page continues rather than
restarting"* — exports 105 messages, which is more than one metadata listing can name, and asserts the
manifest names all 105. That is the assertion that keeps the paged build honest.

## Correction, 20 August 2026: this receipt's first version was a hypothesis wearing a measurement's clothes

The version filed with #65 recorded a single value, `r2.list_max_keys_per_call: 1000`, under the heading
*"Measured, on 20 August 2026, against miniflare under `vitest-pool-workers`"*, with a table reading
*"`limit: 1000` over 1,004 objects → 1,000 returned, `truncated: true`"*, and cited a test called *"refuses an
export whose manifest one listing could not name"*.

**No such measurement was run and no such test exists.** The figure was read off Cloudflare's R2 limits table
and presented as an observation, which is the one thing AGENTS.md §2 does not allow — *"a number read off
source is a hypothesis"* — and the citation made it look checked.

The cost of that was not cosmetic. `export.max_messages_ceiling` is **derived** from this figure, so the
export authorized up to 1,000 messages while `completeExport` asked for them with `include:
["customMetadata"]` and got 100. Every export above a hundred messages staged all of its bytes and then threw
`E_EXPORT_MANIFEST_TRUNCATED` for ever — no manifest, no `supervised.export_completed`, a hundred-plus copies
of somebody's mail sitting in R2, and a refusal whose text blamed whoever authorized a bound the code itself
had permitted. The repair is in `completeExport`: the build pages the listing, bounded by the ceiling, so the
refusal is unreachable rather than routine.

**Why it is `single_figure` and not plan-scoped.** R2's operation limits carry no plan column: the R2 limits
table states one number per row, and the Workers plan changes what an account is billed for, not how many
keys one API call returns. The plan-scoped figure in this neighbourhood is the *subrequest ceiling*
(`doctor.{free,paid}.max_subrequests`), which is what bounds how many listings a pass may make — a different
question, recorded elsewhere, and deliberately not restated here.

**What would change if either moved.** `r2.list_max_keys_per_call` is what
`export.max_messages_ceiling` is derived from, so raising it raises the largest export this Node will
authorize and lowering it refuses exports that used to be allowed — which is the direction that has to be
loud, and is, because `E_EXPORT_TOO_LARGE` names both numbers.
`r2.list_max_keys_with_metadata` changes only how many subrequests the manifest build spends —
`ceil(objects / 100)`, once, at completion — because the loop terminates on `truncated` rather than on the
count.
