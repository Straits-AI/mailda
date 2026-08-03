---
id: d1-auto-provisioning
kind: platform-limit
measured_on: 2026-08-03
stale_when: >
  automatic resource provisioning leaves beta, wrangler gains a way to declare a shared
  resource across Workers, or account-owned Workers Builds tokens ship
values:
  provisioning.databases_created_per_worker: 1
  provisioning.shared_across_workers: 0
  provisioning.ids_written_back_to_config: 0
---

**Measured:** live Cloudflare account, wrangler 4.118.0, 3 August 2026. Two throwaway
Workers deployed and deleted; the account was verified back to baseline afterwards.

## The question

§11B and #4 both assume one Mailda Node shares **one** D1 catalog across its Workers.
Cloudflare's [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/)
creates resources for bindings declared without an id. Does that produce one shared
database, or one per Worker?

## Method

Two Workers, `mailda-provision-probe-a` and `-b`, with **byte-identical** binding
declarations and no `database_id` or `database_name`:

```jsonc
"d1_databases": [{ "binding": "SHARED" }]
```

Deployed in sequence with `wrangler deploy`.

## Result: one database per Worker, not shared

```
Provisioning SHARED (D1 Database)...
🌀 Creating new D1 Database "mailda-provision-probe-a-shared"...
env.SHARED (9ad8a742-daff-4e81-a512-b035b9c121d8)

Provisioning SHARED (D1 Database)...
🌀 Creating new D1 Database "mailda-provision-probe-b-shared"...
env.SHARED (241a7344-845a-473c-aa96-b1ef4cc06fb1)
```

Two databases. The second deploy did not detect, reuse or even mention the first. Naming
is `<worker-name>-<binding-name>`, confirming the documented behaviour that "resources
will be created with the name of your worker as the prefix" — and that prefix is exactly
what makes sharing impossible.

Both Workers deployed successfully and `probe-a` returned `{"worker":"a","ok":{"ok":1}}`,
so each reached *a* working database. Nothing errors. **That is what makes this
dangerous**: a nine-Worker Node would deploy cleanly, report success, and quietly run on
nine disconnected databases.

## Second finding: ids are not written back

The docs state that on `wrangler deploy` "their IDs will be written back to your
configuration file", with write-back failing only on the dashboard/GitHub path. Observed
here on a **local** `wrangler deploy`, `a/wrangler.jsonc` was unchanged — still no
`database_id`. So a redeploy has nothing pinning it to the database it created.

## What this settles

**Automatic provisioning cannot build a Mailda Node.** #4's single-owner rule gives D1 to
the `state` Worker alone, and every other Worker reaches it by service-binding RPC — but
any Worker that *declares* a D1 binding without an id gets its own database. Resources
must therefore be created deliberately, by name, before or during deploy, with ids pinned
explicitly. That is a requirement on #13's install script, not an option.

It also removes reading 1 from #13's three candidate shapes: nine independent Workers
Builds projects, each auto-provisioning, would produce nine catalogs.

## What this does *not* settle

The button-specific half of #14 remains open, and this probe cannot reach it:

- Whether the Workers Builds auto-generated token can create D1 **at all**. Its documented
  permissions are Workers Scripts / KV / R2 edit, with **no D1** — while the provisioning
  docs claim D1 works "from the dashboard (for example, via GitHub)". This probe used a
  local OAuth token that *does* hold `d1 (write)`, so it proves nothing about the build
  token.
- Whether a custom `deploy` script chaining several `wrangler deploy` calls runs in
  Workers Builds.
- Whether Durable Object namespaces and Workflows are provisioned — neither appears on the
  supported list.

Those need a real Deploy button click against an account, which is a browser flow.
