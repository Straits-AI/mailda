---
id: deploy-button-behaviour
kind: platform-limit
measured_on: 2026-08-03
stale_when: >
  Workers Builds stops overriding the Worker name from the CI project, gains multi-Worker
  support in a single project, or changes what the Deploy button provisions
values:
  builds.workers_deployable_per_project: 1
  builds.provisions_d1: 1
  builds.provisions_queues: 1
  builds.provisions_r2: 0
  builds.writes_resource_ids_to_repo: 1
---

**Measured:** a real Deploy to Cloudflare button click against a live Workers **Paid**
account, 3 August 2026, using a two-Worker probe. All resources deleted afterwards and the
account verified back to baseline.

> **The probe was not kept.** This file originally cited `probes/deploy-button`, which does not
> exist in the repository — the probe was built ad hoc and removed with the resources it created.
> Re-measuring therefore means rebuilding it from the description below, and that is a real cost
> this receipt should not have hidden behind a path that looks checkable. What the probe was: two
> minimal Workers in one repository, one service-binding the other, a root `deploy` script chaining
> `wrangler deploy -c effects/wrangler.jsonc && wrangler deploy`, and binding declarations for D1,
> a Queue and R2 with **no** ids, so the button had to provision each one.

## The finding that matters: one Workers Builds project deploys exactly one Worker

From the build log:

```
Executing user deploy command: npm run deploy
> wrangler deploy -c effects/wrangler.jsonc && wrangler deploy

▲ [WARNING] Failed to match Worker name. Your config file is using the Worker name
"mailda-probe-effects", but the CI system expected "mailda-probe-node". Overriding using
the CI provided Worker name.
```

**Workers Builds pins one Worker name to the CI project and overrides whatever the config
says.** So the first command deployed the `effects` *code* under the name
`mailda-probe-node`. Confirmed by fetching the result:

```
GET https://mailda-probe-node.<subdomain>.workers.dev
{"worker":"effects","role":"credential broker"}
```

The wrong code, under the wrong name. The second `wrangler deploy` then failed — its config
service-binds to `mailda-probe-effects`, which was never created because that name was
overridden away, and it also references an R2 bucket that was not provisioned (below).

**A chained multi-Worker deploy command cannot work in a single Workers Builds project.**
This kills the shape #13 had settled on.

## What the button provisions

| Resource | Declared without id | Created |
|---|---|---|
| D1 database | yes | **yes** — named `mailda-probe-node` |
| Queue | yes, with explicit `queue` name | **yes** — named `mailda-probe-inbound` |
| R2 bucket | yes | **no** |
| Durable Object namespace | via `new_sqlite_classes` migration | not reached (deploy failed) |

**D1 provisioning works.** That answers the question this ticket existed for: the
documented Workers Builds token permissions (Workers Scripts / KV / R2 edit, no D1) do
**not** prevent D1 creation — the button provisions before and independently of the build
token.

**R2 was not created, but its name was written into the config anyway.** The cloned
repository contains `"bucket_name": "mailda-probe-node"` for a bucket that does not exist.
The button produced a configuration that does not match reality, which is a likely cause of
the second deploy's failure. Whether this is a bug or ordering artifact is unknown; it is
recorded as observed.

Naming differs from `wrangler deploy`'s own auto-provisioning, which names resources
`<worker>-<binding>` (receipt: `d1-auto-provisioning.md`). The button names them after the
**Worker** alone, so two bindings of the same type would presumably collide.

## Resource ids ARE written into the customer's repository

Read from the cloned repo afterwards:

```jsonc
"d1_databases": [{ "binding": "CATALOG", "database_id": "f2ddb0ee-…", "database_name": "mailda-probe-node" }],
"r2_buckets":   [{ "binding": "EVIDENCE", "bucket_name": "mailda-probe-node", "preview_bucket_name": "mailda-probe-node" }],
```

**This breaks ADR 24's premise empirically.** That decision rests on the customer's fork
being byte-identical to upstream so `git pull` is a fast-forward *by construction*. The
button writes ids into `wrangler.jsonc` — a file upstream owns and will edit again. The
guarantee is structural no longer.

The ids are unnecessary: the wrangler docs state resources stay linked across deploys
without them, explicitly for shared templates. So the divergence buys nothing.

## Other observations

**Workers Builds used `bun`, not npm or pnpm.** *"Detected the following tools from
environment: bun@1.2.15, nodejs@24.18.0. Installing project dependencies: bun install."*
The probe had no lockfile, so this is the build image's default rather than detection of an
intent. #2 chose pnpm and noted Bun support in Workers Builds was unconfirmed — it is
evidently present and preferred absent other signals. A committed `pnpm-lock.yaml` should
change the detection, but that is untested.

**Subdirectory targeting works.** The build cloned the whole of `Straits-AI/mailda.git`,
logged `Overwriting files`, and pushed the extracted subdirectory to the destination repo —
so a subdirectory button URL does not require the *repository* to be self-contained, only
the subdirectory.

**The clone went to an organization**, `Whyme-Labs/mailda-probe-node`, created **public**.

## What this forces

#13's chosen shape — one Builds project, chained deploy of `effects` then `node` — is dead.
The remaining options are:

1. **One Workers Builds project per Worker**, which is what Cloudflare's own monorepo
   guidance documents ("set the root directory of each Worker to where its Wrangler
   configuration file is located"). Two projects watching one repo, each deploying its own
   Worker, each auto-updating under ADR 24. Install needs two buttons, or one button plus a
   second step.
2. **Abandon the button for install** and use the CLI, keeping Workers Builds only for
   updates — where the same one-project-per-Worker constraint applies, so it is still two
   projects.
3. **Revisit the two-Worker split** (#17). The credential boundary is real and cannot be
   enforced inside one Worker, so this would mean accepting a weaker boundary in exchange
   for a one-click install. Recorded as an option, not a recommendation.

## What now holds this receipt to the config

These findings constrained nothing for two days, which is how a measurement becomes decoration.
`apps/node/worker/test/node/deployability.test.ts` now fails when the Worker's configuration drifts
from them:

- **one deployable Worker** — a second config would resurrect the chained-deploy shape this
  measurement killed
- **every binding block classified** as button-provisioned or carrying a stated alternative route, so
  adding one is a decision about somebody's first five minutes rather than a discovery
- **no account-specific resource id committed**, which is ADR 24's premise and the thing the button
  itself erodes in the customer's clone
- the `test` environment's bindings match the top level, which the config comments claimed was
  "drift-checked" while nothing checked it

It does not test the button. Nothing automated can: the button needs a real paid account, provisions
live resources and has to be torn down afterwards. What it removes is the *cheap* class of breakage —
the config quietly growing a dependency the customer's install cannot satisfy — and leaves the
expensive class where it belongs, in a manual probe with this receipt's `stale_when` to say when.

## Residual

- Durable Object provisioning was never reached, because the deploy failed first. Untested.
- Whether a committed `pnpm-lock.yaml` makes Workers Builds use pnpm is untested.
- Whether the missing R2 bucket is a bug, a permissions artifact, or ordering is unknown.
- The generated build token's actual permission set was not inspected; D1 creation
  evidently did not depend on it.
