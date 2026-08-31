---
id: deploy-drill-live-account
kind: platform-limit
measured_on: 2026-08-27
stale_when: >
  wrangler changes whether `versions upload` shifts traffic, whether it can create a Worker that does not
  exist, or whether auto-provisioned D1/R2 bindings are created before a deploy; Cloudflare makes Workflow
  bindings scriptable rather than account-level, or makes a second script claiming one an error; or the
  default for `preview_urls` changes again; or Cloudflare stops excluding Workers with Durable Objects from
  preview URL generation, which would reopen the alias path this drill found closed
values:
  deploy.versions_upload_shifts_traffic: 0
  deploy.versions_upload_creates_worker: 0
  deploy.migrations_before_first_deploy: 0
  deploy.workflow_name_is_account_level: 1
  deploy.second_node_reassigns_workflow: 1
---

**Measured:** a real first install and two deploys into a live Cloudflare account
(`Mystraits.ai@gmail.com`, `dc8d1b7d…`), 27 August 2026, wrangler 4.118.0. A Mailda Node was deployed, all
39 migrations applied, the delivery-events consumer attached, `doctor` run against it, a second Node
deployed alongside it, and everything the second Node created removed afterwards. The first Node was left
running at `https://mailda.mystraits-ai.workers.dev`.

The drill was run because #92, #98 and #99 all rested on assumptions nobody had tested. It found **five
facts, three of which were bugs in code written the day before** — which is the argument for running it
rather than reasoning about it.

## The assumption #98's whole design rests on: confirmed

`deploy.versions_upload_shifts_traffic: 0`. Across three `wrangler versions upload` calls, the version
serving 100% of traffic never changed — it stayed pinned at the previously deployed version until an
explicit `wrangler deploy` or `versions deploy`. Checked with `wrangler deployments status` before and after
each upload.

This is what makes *"a failed check needs no rollback"* true rather than hopeful: the canary is published,
checked, and promoted only on passing, and the previous version is still serving the whole time. There is no
undo step that has to run correctly during an incident.

## `mailda deploy`'s ordering broke the first install

Two separate refusals, both on a fresh account, both fatal to the sequence as it was written:

```
$ wrangler d1 migrations apply CATALOG --remote
✘ Couldn't find an auto-provisioned D1 DB named 'mailda-catalog' for binding 'CATALOG'.
  Run 'wrangler deploy' to provision it, or add 'database_name' / 'database_id' to your config.

$ wrangler versions upload
✘ You cannot upload a new version of a Worker that does not yet exist. Please run the `deploy` command first.
```

`deploy.migrations_before_first_deploy: 0` and `deploy.versions_upload_creates_worker: 0`.

The cause is a decision this project made on purpose: `wrangler.jsonc` declares its D1 and R2 bindings with
**no ids and no names**, because ADR 24 requires the repository byte-identical across installs. So the
resources are provisioned *by the deploy*, and neither of the first two steps of expand-canary-check-shift
can come first on a Node that does not exist yet.

`mailda deploy` now branches. A first install deploys directly — which is safe there for exactly the reason
the canary exists: no previous version to protect and no user to serve a broken one to. Every later deploy
takes the canary path.

## The Workflow collision is real, and it is a silent theft rather than a refusal

`deploy.workflow_name_is_account_level: 1`, `deploy.second_node_reassigns_workflow: 1`.

Every other resource derives from the Worker's name — a second Node called `mailda2` got `mailda2-catalog`,
`mailda2-evidence` and `mailda2-sending-events`, colliding with nothing. The Workflow does not: its name is
written in `wrangler.jsonc` as `mailda-butler-runs`, and `wrangler workflows list` shows a Workflow is owned
by exactly **one** script.

Deploying the second Node **succeeded, exit 0, with no warning**, and the ownership moved:

| | before | after |
|:--|:--|:--|
| `mailda-butler-runs` → `Script name` | `mailda` | **`mailda2`** |

So the first Node kept a `BUTLER_RUNS` binding pointing at a Workflow whose class is now served by the
second Node's code, against the second Node's bindings. That is a cross-Node execution path into another
organization's D1 — the same shape as the queue collision that was already found and fixed, in the one
resource whose name is not derived. #99 suspected this; it is now measured, and the failure mode is the
worse of the two possibilities: it does not refuse, it reassigns.

## The canary has no reachable URL, so #98's gate cannot run here

Not given a `values` key, because it is a **negative result whose cause is not established** and a number
would imply otherwise.

`wrangler versions upload --preview-alias canary` printed a version id and **no preview URL**. Neither the
documented alias form nor the versioned form answered:

```
canary-mailda.mystraits-ai.workers.dev      404
d711b326-mailda.mystraits-ai.workers.dev    404
mailda.mystraits-ai.workers.dev             200   (the live version, for contrast)
```

The 404 body is Cloudflare's generic *"Page not found"* page, so the hostname is not routed at all rather
than reaching a Worker that refused. Declaring `"preview_urls": true` in `wrangler.jsonc` and redeploying —
the documented fix, and worth doing regardless because Cloudflare's default for that setting changed three
times between September 2025 and October 2025 — did not change the result.

**What this means operationally:** `mailda deploy` reaches its own `could not find the canary's preview URL`
refusal, which fails safe — it does not promote, it says the canary is uploaded and serving no traffic, and
it prints the exact `wrangler versions deploy` command. So the sequence degrades to "upload, then promote by
hand after checking yourself", which is weaker than designed and not dangerous.

**Observed a second and third time on 27 August 2026**, deploying migrations 0040 and 0041 with the two
search layers to the same Node. Same result, same refusal, and the refusal did what it was written to do: it printed
`wrangler versions deploy <id>@100`, the previous version kept serving 100% of traffic throughout, and the
schema change ahead of it was additive so nothing was serving against a schema it did not understand. The
sequence degrading to *"upload, check by hand, promote"* is now a measured property of this account rather
than a prediction — weaker than designed, and not dangerous.

**Established on 31 August 2026, and it was none of the three things suspected.** The account's own API had
the answer the whole time:

```text
GET /accounts/{account}/workers/scripts/mailda/subdomain
  → {"enabled": true, "previews_enabled": true}
```

Preview URLs were already enabled, the alias was recorded on every version, and the version API carries no
preview-URL field. The cause is a documented platform limitation — Cloudflare does not generate preview URLs
for Workers that **implement a Durable Object** — and this Worker declares `KEY_VAULT` and `OUTBOX_SWEEPER`,
because ADR 28 put both root keys in a Durable Object. No setting on this account could ever have produced
the hostname, and the dashboard visit this section twice asked for would have shown the toggle already on.

Two drills recorded "cause unestablished, needs the dashboard" when one read of the API and one line of the
Limitations documentation settled it. The lesson worth keeping is not about preview URLs: **the suspected
cause was checkable without the dashboard, and neither drill checked it.**

The gate no longer uses a preview URL. `mailda deploy` places the canary in the deployment at 0% and reaches
it through `Cloudflare-Workers-Version-Overrides` on the production hostname, requiring the report to name
the uploaded version — measured and reasoned in
[`preview-urls-and-durable-objects`](./preview-urls-and-durable-objects.md). The degraded
"upload, check by hand, promote" path recorded above is therefore history, not current behaviour.

## The fourth drill, 31 August 2026: the sequence works, and the gate was wrong

The first drill since the preview-URL cause was established and the gate rebuilt around a version override.
Run against the live Node with `CLOUDFLARE_ACCOUNT_ID` set, seven pending migrations (0045–0051, all
expansion; 0048 swaps an index and recreates it in the same file).

**Every step of the sequence ran, in order, and the mechanism works:**

```text
preflight                    account resolved, wrangler 4.118.0 above the 4.97 floor
workflow guard               mailda-butler-runs owned by mailda — ran, rather than being skipped
migrations                   0045–0051 applied
reading the serving version  d27a228d  (the last percentage line, parsed correctly)
canary upload                c7e7b917
canary at 0%                 SUCCESS: c7e7b917 at 0% and d27a228d at 100%
override probe               answered version: c7e7b917  ← the identity gate passed
```

That seventh line is the result the previous three drills could not reach. The version override **does** reach
a 0% version on the production hostname, and the canary named itself, so the identity check — the thing
standing between this gate and an assertion that cannot fail — works against a real account. The incumbent
still carries no `version` field, which makes a fall-through unmistakable rather than ambiguous.

**Then the gate refused, and the refusal was the defect.** The canary reported `degraded` with one finding,
`signing_key` — *"No current signing key. One is generated on the next sign-in, so this self-heals"*. The
incumbent reported `degraded` with **the same one finding**. So a version neither better nor worse than the
one already taking every request was withheld, and the operator was told to promote it by hand.

An unclaimed Node is in that state by construction until somebody signs in, so every deploy to one would have
gone the same way — which is the weak *"upload, check by hand, promote"* path the earlier drills recorded,
reached from a different direction and for a different reason.

The gate is differential now: a finding the canary has and the incumbent does not blocks; shared findings are
reported as **carried**. `refuse` still refuses whatever the incumbent says, because two broken versions is a
reason to stop rather than to proceed. Re-run against the same account, the gate answers
`promote: true, carried: ["signing_key"]`.

**Left in a deliberate state:** canary at 0%, incumbent serving 100%, schema advanced. Safe by design —
expansion is backward-compatible ahead of the code — and the promotion is an operator's decision rather than
a drill's.

**Completed on the operator's word.** `c7e7b917` promoted to 100%. The Node now reports its own version —
so every future canary gate can run — `migrations_applied` reads *"All 52 expected tables present"*, and the
`mailda-sending-events` consumer was already attached from an earlier deploy, so the step the gate interrupted
had nothing left to do. One finding remains: `signing_key`, self-healing on the next sign-in.

**What the gate can actually see, measured rather than assumed.** The canary check is unauthenticated, so it
reads the reduced report. On this Node that is **9 findings of 21** — the other 12 describe the organization's
mail and are withheld from an anonymous caller. The differential comparison therefore covers 9, and a
regression confined to a data-disclosing finding would not block a promotion.

Fixable and deliberately not fixed: sessions are signed by the Node's own key and that state is shared across
versions, so signing in and then sending the cookie **with** the override header would reach the canary
authenticated and compare all 21. That needs credentials in the deploy path, which is a decision about what
`mailda deploy` may hold.

**A finding-count change that looked alarming and was not.** The report went from 20 findings to 9 across the
promotion, which looks like checks disappearing. It is the opposite: the old route reduced only
`if (orgId !== null && !signedIn)`, so an **unclaimed** Node served its *full* report to anonymous callers.
The current route reduces that case too. Nothing was removed — four checks were added since — and the
tightening is an improvement. Worth recording because the first reading of a shrinking number is that coverage
was lost.

**Both findings above are closed.** `mailda deploy` no longer inherits `doctor`'s exit code — a deploy is
asked whether it happened, so a carried degradation exits 0 while a post-promotion `refuse` exits 2 and prints
the rollback. And the canary check signs in when credentials are present, so the gate compares the whole
report rather than the 9 findings an anonymous caller may see; both sides are asked with the same credentials,
because authenticated-canary against anonymous-incumbent would compare 21 to 9 and block every deploy.

## An unexplained D1 API failure during migration, 28 August 2026

Not given a `values` key, because it is a **negative result whose cause is not established** and a number
would imply otherwise.

Applying migrations 0042–0044 through `mailda deploy` printed the three names twice and then:

```
✘ [ERROR] A request to the Cloudflare API
  (/accounts/…/d1/database/…/query) failed.
```

with no further detail. Re-running immediately reported **"No migrations to apply!"**, and the schema was
verified correct afterwards: the ledger at `0044_body_index_state.sql`, the four new `body_index_*` columns
and `msg_body_index_due` present on `messages`, and both new columns on `recovery_codes`. So the migrations
applied and the error arrived after them.

**What is not established** is which request failed or why. The candidates are the final `UPDATE` in 0044,
some part of the deploy step that follows migration, or a transient API failure with no relationship to
either. It did not reproduce, and it cannot now — the migrations are applied and the path is idempotent.

**Why this Node cannot answer it.** `messages` is empty here, so 0044's classifying `UPDATE` had nothing to
touch: it would have succeeded trivially whether or not it ran. The one place the question matters is a Node
with mail, and this Node deliberately has none.

**What would settle it**, and is worth doing before this migration reaches a Node with an archive: apply
0044 to a scratch database seeded with messages in both states, and check the classification actually ran
rather than leaving every row on the column default. A migration recorded as applied whose last statement
silently did nothing is the shape of failure that shows up months later as "search never found old mail" —
and D1 does not wrap a migration file in a transaction, so it is representable rather than theoretical.

Recorded as unknown rather than guessed at, for the reason the preview-URL section above gives: the next
person to touch this needs to know the difference between *"we measured this and it is broken"* and
*"we measured this and do not know why"*.
