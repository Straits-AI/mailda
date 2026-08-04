---
id: binding-relink-on-id-removal
kind: platform-limit
measured_on: 2026-08-03
measured_again_on: 2026-08-04
stale_when: >
  wrangler changes how it resolves a binding declared without an id, automatic resource
  provisioning leaves beta, or Secrets Store bindings gain per-account relinking
values:
  binding.relinks_when_id_and_name_removed: 1
  binding.reprovisions_when_id_and_name_removed: 0
  binding.secrets_store_relinks_when_id_removed: 0
---

**Measured:** live test on a Workers **Paid** account, 3 August 2026, wrangler 4.118.0.
Resources deleted afterwards.

## The question

ADR 24 and #13 decided that conflicts in `wrangler.jsonc` resolve to **upstream,
unconditionally** — discarding the resource ids the Deploy button writes into a customer's
fork (receipt: `deploy-button-behaviour.md`). That rests on wrangler relinking the existing
resource rather than provisioning a new one.

The wrangler docs say *"resources will stay linked across future deploys even without adding
the resource IDs to the config file"*, but that statement concerns wrangler's own
provisioning flow, not a config that previously **named** a resource and then stopped. If it
re-provisioned instead, a routine auto-update under ADR 24 would silently orphan a Node's
catalog — the worst outcome available in that design.

## Method

1. Created D1 `mailda-relink-probe` (`e8ed5fd1-a710-45b8-afa6-2d6f157ff5ef`).
2. Deployed a Worker declaring the binding with **both** `database_id` and `database_name`,
   exactly as the button writes them.
3. Wrote a marker row into that database.
4. Rewrote the config to upstream's form — `{ "binding": "CATALOG" }`, no id, no name —
   which is precisely what an upstream-wins merge produces.
5. Redeployed and inspected.

## Result: it relinks

```
env.CATALOG (inherited)
```

| Check | Observed |
|---|---:|
| D1 databases matching the name after redeploy | **1** (same UUID) |
| Worker reading the pre-existing row | `{"marker":"original-catalog"}` |

One database, the original UUID, data intact. Wrangler resolved the binding by name held
server-side against the Worker, not from the configuration file.

## Consequence

**ADR 24's residual risk is closed, and the merge rule is safe.** Discarding
button-written ids and names on merge keeps the existing catalog. The fork can be returned
to upstream's exact content without data loss, which restores the property #18 wanted — a
guarantee held by the platform rather than by discipline.

## Residual

- Tested for D1 only. R2, KV and queue bindings were not tested and should not be assumed to
  behave identically.
- Tested with the Worker already deployed and bound. Whether a **first** deploy with no id
  and no name behaves the same is a different question, and is what
  `d1-auto-provisioning.md` covers: it provisions a new database named after the Worker.


## Secrets Store bindings do **not** relink (measured 4 August 2026)

The relink property above is what makes ADR 24 survivable: the Deploy button writes resource ids into
the customer's fork, and conflicts resolve to upstream unconditionally because wrangler re-links the
binding server-side when the id is absent.

**That does not extend to Secrets Store.** Removing the `secrets_store_secrets` block from
`wrangler.jsonc` and redeploying produced:

```
env.OUTBOX_SWEEPER (OutboxSweeper)      Durable Object
env.CATALOG (inherited)                 D1 Database
env.EVIDENCE (inherited)                R2 Bucket
```

`CREDENTIAL_KEK` is **silently absent** — no warning, no error, exit code 0. D1 and R2 say
`(inherited)`; the secret binding is simply gone.

### What that cost, live

The Node kept serving. Sign-in returned HTTP 500, because every signing key was wrapped under the
real KEK and the code fell back to the published development constant, which cannot unwrap them.

And `doctor` — which requires authentication on a claimed Node — became **unreachable at exactly the
moment it was needed**. A diagnostic only available while the system is healthy is not a diagnostic.
Fixed by serving a reduced report unauthenticated when the Node cannot authenticate anyone at all:
`infrastructure` findings only, since their contents are already published in this repository, while
anything derived from an organization's mail is withheld and *said* to be withheld.

One further operational note, observed rather than designed: during the redeploy that restored the
binding, a still-draining old isolate minted a signing key under the development constant, which the
new build then could not unwrap. A KEK binding change is therefore not atomic with respect to key
generation.

**Consequence for ADR 28:** the mechanism that dissolves the D1 id problem does not exist for
Secrets Store, so `store_id` in committed configuration cannot be made decorative the same way. The
decision on #22 has to come from somewhere else.
