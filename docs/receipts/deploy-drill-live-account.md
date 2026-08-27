---
id: deploy-drill-live-account
kind: platform-limit
measured_on: 2026-08-27
stale_when: >
  wrangler changes whether `versions upload` shifts traffic, whether it can create a Worker that does not
  exist, or whether auto-provisioned D1/R2 bindings are created before a deploy; Cloudflare makes Workflow
  bindings scriptable rather than account-level, or makes a second script claiming one an error; or the
  default for `preview_urls` changes again
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

**What is not established:** whether this is an account-level preview setting, a dashboard toggle this
account has never had enabled, or something about a Worker whose first version predates the alias. Recorded
as unknown rather than guessed at, because the next person to touch #98 needs to know the difference between
"we measured this and it is broken" and "we measured this and do not know why".
