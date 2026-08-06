---
id: r2-auto-provisioning
kind: platform-limit
measured_on: 2026-08-06
stale_when: >
  automatic resource provisioning leaves beta; wrangler stops provisioning R2 for a binding that
  names a bucket which does not exist; the Deploy Buttons documentation stops listing R2 among the
  resources it provisions; or the Workers Builds build token loses R2 edit
values:
  provisioning.r2_created_without_bucket_name: 1
  provisioning.r2_created_with_missing_bucket_name: 1
  provisioning.r2_requires_interactive_confirmation: 0
---

**Measured:** live Cloudflare account, Workers Paid, wrangler 4.118.0, 6 August 2026. Two throwaway
Workers and two buckets created and deleted; the account was verified back to baseline afterwards and
the production `mailda-evidence` bucket confirmed intact.

## Why this was measured

[`deploy-button-behaviour.md`](./deploy-button-behaviour.md) recorded, from a real button click on
3 August, that the Deploy to Cloudflare button provisions D1 and a Queue but **not** R2 — while writing
a `bucket_name` into the clone for the bucket it had not created. That made "who creates the evidence
bucket" the last thing standing between Mailda and an installable product, since a Node whose
`EVIDENCE` binding points at nothing cannot store mail.

The finding is now doubtful on two independent grounds, which is why it was re-examined rather than
built around.

**Cloudflare's own documentation contradicts it.** The [Deploy Buttons
page](https://developers.cloudflare.com/workers/platform/deploy-buttons/) lists R2 buckets among the
resources provisioned automatically. The
[configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/) documents
the same for `wrangler deploy`, keyed — for R2 specifically — off the *absence of a bucket name*.

**And the production Node already has an auto-provisioned bucket.** `apps/node/worker/wrangler.jsonc`
declares `{ "binding": "EVIDENCE" }` with no name, and `mailda-evidence` exists in APAC holding real
mail. `wrangler deploy` created it without anyone asking.

## Two mechanisms proposed and both eliminated

| Hypothesis | Test | Result |
|:--|:--|:--|
| Provisioning needs a TTY, so a non-interactive build skips it | `CI=true`, stdin closed, no `bucket_name` | **Wrong.** Provisioned silently: `Creating new R2 Bucket "mailda-probe-r2-evidence"` |
| The button's own `bucket_name` rewrite disables provisioning, deadlocking the build | `CI=true`, `bucket_name` naming a bucket that does not exist | **Wrong.** wrangler honours the name and creates it: `Creating new R2 Bucket "mailda-probe-r2b"` |

The second was the more attractive story — the button writing a name for a bucket it failed to create
would have been a self-inflicted deadlock, and it fit the observed facts exactly. It is simply not what
wrangler does: an explicit name for a missing bucket is provisioned under that name, not treated as a
reference to something that must already exist.

So `wrangler deploy` creates the R2 bucket **in every shape tested** — with a name or without one,
interactive or not. There is no configuration of Mailda's own repository in which the CLI install path
leaves the bucket missing.

## What is left, and it is the explanation the original receipt already offered

That receipt recorded the probe's second `wrangler deploy` **failing before it finished** — it
service-bound to a Worker whose name Workers Builds had overridden away. Its own words: *"Whether this
is a bug or ordering artifact is unknown; it is recorded as observed."*

An ordering artifact is now the only surviving explanation. R2 was not created because the deploy that
would have created it never completed — and that deploy failed for a reason ADR 18 has since removed,
by collapsing Mailda to a single Worker. The chained multi-Worker deploy that broke does not exist any
more.

**Conclusion: no provisioning step needs building.** The bucket is created by the deploy itself on both
install paths, and the gap was an artifact of a shape the architecture no longer has.

## What is still genuinely unmeasured

- **A real button click against the current single-Worker repository.** Everything above tests
  `wrangler deploy`, which is what the build *runs*, but not the button's own control-plane
  provisioning that happens before the build. It should not matter — if the control plane skips R2, the
  build's `wrangler deploy` creates it, and the documented Workers Builds token carries R2 edit — but
  "should not matter" is an argument, not a measurement.
- **Whether resource ids are still written into the customer's clone.** The configuration reference now
  states that for dashboard and GitHub deploys, ids are *not* written back to the repository. If true,
  that repairs ADR 24's byte-identical-fork premise, which the 3 August measurement recorded as broken.
  This is the more consequential of the two and is called out in that receipt's `stale_when`.

Both need the button, a paid account, live resources and a teardown. Recorded as the residue rather
than folded into the conclusion, because the conclusion above does not depend on either.

## Naming, and why ADR 24 survives it

Auto-provisioning names the bucket `<worker>-<binding>` lowercased — `mailda-evidence` — matching
[`d1-auto-provisioning.md`](./d1-auto-provisioning.md). The name is *derived*, not committed, so
nothing account-specific enters `wrangler.jsonc` and the fork stays byte-identical to upstream.
`test/node/deployability.test.ts` enforces that no id or name is committed.
