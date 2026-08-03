---
id: binding-relink-on-id-removal
kind: platform-limit
measured_on: 2026-08-03
stale_when: >
  wrangler changes how it resolves a binding declared without an id, or automatic resource
  provisioning leaves beta
values:
  binding.relinks_when_id_and_name_removed: 1
  binding.reprovisions_when_id_and_name_removed: 0
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
