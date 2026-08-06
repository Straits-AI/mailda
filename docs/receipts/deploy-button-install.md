---
id: deploy-button-install
kind: platform-limit
measured_on: 2026-08-06
stale_when: >
  Workers Builds stops overriding the Worker name from the CI project; the Deploy button starts writing
  resource ids into the clone; the button's setup page gains a root-directory field; Cloudflare stops
  stripping .github/workflows from the clone; the button starts preserving upstream git history; or the
  deploy-command detection starts picking up a `deploy` script
values:
  install.writes_resource_ids_to_clone: 0
  install.preserves_upstream_history: 0
  install.strips_github_workflows: 1
  install.renames_root_package: 1
  install.detects_deploy_script: 0
  install.applies_migrations: 0
  install.provisions_d1_in_build: 1
  install.provisions_r2_in_build: 1
---

**Measured:** a real Deploy to Cloudflare click against the live single-Worker repository, Workers Paid,
6 August 2026. Cloned to `Whyme-Labs/mailda-btn`, Worker named `mailda-btn`, resources
`mailda-btn-catalog` and `mailda-btn-evidence`. Everything torn down afterwards and the production
`mailda` Worker, `mailda-catalog` and `mailda-evidence` verified intact.

This supersedes the R2 and ADR 24 findings in
[`deploy-button-behaviour.md`](./deploy-button-behaviour.md), which were measured against a two-Worker
repository that ADR 18 has since collapsed.

## The build succeeded and the Node was dead

```
Success: Deploy command completed
✨ Success! Build completed.
```

Then every request answered **HTTP 500**, and the catalog held exactly one table — `_cf_KV`, which is
the platform's own. A green build and a non-functional product, with nothing anywhere announcing it.

The cause is one line of the log:

```
Executing user deploy command: npx wrangler deploy
```

Not `pnpm run deploy`. The repository's `deploy` script — `wrangler deploy && pnpm run
migrations:apply` — was present in both the root and the Worker `package.json` at the commit that was
cloned, and Cloudflare documents that it "will automatically detect and pre-populate the build and
deploy fields". It did not. **Cause unknown** and recorded as unknown; what is measured is that the
default ran and the schema was never applied.

## ADR 24: the specific worry was wrong, the premise still fails

The previous receipt recorded resource ids being written into the customer's clone, and called ADR 24
empirically broken. That is **not what happens**:

```
$ diff <clone>/apps/node/worker/wrangler.jsonc <upstream>/apps/node/worker/wrangler.jsonc
IDENTICAL
```

No `database_id`, no `bucket_name`, no `account_id`. The provisioned resources stay linked by binding
name, exactly as the configuration reference now says. **On this point ADR 24 needs no amendment.**

But the premise — "the fork is byte-identical, so `git pull` is a fast-forward *by construction*" —
fails anyway, for two reasons neither receipt anticipated:

| | |
|:--|:--|
| **No shared history** | The clone is a single squashed commit, `source repo import`. `git merge-base HEAD upstream/main` **exits 1** — there is no common ancestor, so a pull is an unrelated-histories merge, not a fast-forward. The button does not fork; it *imports*. |
| **Two files diverge** | `package.json` name → `mailda-btn`, and `.github/workflows/ci.yml` is **deleted entirely** (87 lines). |

The workflow deletion matters beyond ADR 24: a customer's install silently loses every check — receipts
in sync, the ctx seam, types, tests. Anyone editing their own Node is doing it with no CI and no
indication that CI ever existed. (Most likely the GitHub App pushing the clone lacks the `workflows`
permission, but that is an inference, not a measurement.)

Workers Builds also announced a future divergence:

```
Failed to match Worker name. Your config file is using the Worker name "mailda", but the CI system
expected "mailda-btn". Overriding using the CI provided Worker name. Workers Builds connected builds
will attempt to open a pull request to resolve this config name mismatch.
```

So `wrangler.jsonc` is expected to diverge later, by PR. None had been opened when this was recorded.

## R2, which is what this exercise set out to settle

Both resources were provisioned **by the build's `wrangler deploy`**, not by the button's control plane:

```
The following bindings need to be provisioned:
env.CATALOG          D1 Database
env.EVIDENCE         R2 Bucket
🌀 Creating new D1 Database "mailda-btn-catalog"...
🌀 Creating new R2 Bucket "mailda-btn-evidence"...
🎉 All resources provisioned, continuing with deployment...
```

This confirms [`r2-auto-provisioning.md`](./r2-auto-provisioning.md) end to end and closes the R2
question. The 3 August "button does not provision R2" was an artifact of a chained multi-Worker deploy
dying before it reached provisioning, and single-Worker Mailda does not have that shape.

Also settled: **the monorepo works.** `pnpm install --frozen-lockfile` ran with `Scope: all 7 workspace
projects` and resolved `@mailda/budgets 0.0.0 <- ../../../packages/budgets`, so Workers Builds' root
directory handled a repository whose Worker is not at the root. The documented monorepo limitation
applies to *subdirectory button URLs*, which is why this one points at the repository root.

## What the install exposed in Mailda itself

Three defects, all of the same family — the product could not describe its own broken state.

**`doctor` returned 500 on the most likely way for a Node to be broken.** `organizationId()` queried
`node_claim` with no `catch`, so the endpoint whose entire job is saying what is wrong died on the
missing table it should have reported. Fixed; it now returns 503 with a report naming every absent
table and the command that fixes them.

**`/health` returned an opaque 500.** Now 503 with `reason` and `fix`.

**The unhandled-error handler's own logging rejected.** `trimLogs` runs inside `ctx.waitUntil` after a
500 and queried `log_entries`, which also did not exist — so the failure of a request was accompanied by
the failure of the thing reporting it. `trimLogs` is now total, matching `log`'s existing contract.

**And inbound mail threw instead of being refused.** The `email()` handler read `node_claim` unguarded,
so a fresh Node would fail the transport with an opaque error rather than telling the sending server the
message was not accepted. §13 forbids losing accepted mail; a clean reject is the honest answer.

## The worst of it: doctor's expected-table list was two migrations stale

`EXPECTED_TABLES` held **14** entries while the migrations create **19**. Absent: `send_manifests`,
`send_counters`, `node_capabilities`, `audit_entries`, `log_entries` — everything migrations 0007 and
0008 added. So a Node that had applied 0001–0006 and stopped would have been reported **healthy** by the
check whose own `fix` text reads *"a Node with a partial schema accepts mail it cannot file."*

The gap was visible in the install's own output — it said `Missing 14 table(s)` when 19 were missing —
and only because the schema was completely empty did the number look plausible.

Fixed, and `test/node/schema-tables.test.ts` now parses `migrations/*.sql` and fails when the list and
the files disagree. Verified by deleting `audit_entries` from the list and watching it fail by name. The
constant has to stay a literal because a Worker has no filesystem; the guard is what keeps a literal
honest.

## What is still not measured

- **Whether the promised name-mismatch PR arrives**, and what it changes. It would be the first thing to
  put a resource-specific value into the customer's `wrangler.jsonc`.
- **Whether the build token can apply migrations at all.** The deploy command never ran them, so the
  permission question that motivated this — the documented Workers Builds token is *Workers Scripts /
  KV / R2 edit, no D1* — is still open. It becomes answerable once the deploy command is right.
