---
id: worker-custom-domain
kind: platform-limit
measured_on: 2026-09-26
stale_when: >
  wrangler stops attaching `routes: [{ custom_domain: true }]` on a first `wrangler deploy`; `versions
  upload` or `versions deploy` starts dropping a Worker's custom domains; `wrangler triggers deploy` stops
  applying route changes to an existing Worker; or deleting a Worker starts leaving its custom-domain DNS
  record behind
values:
  deploy.custom_domain_attached_by_first_deploy: 1
  deploy.custom_domain_kept_across_versions: 1
  deploy.triggers_deploy_adds_custom_domain: 1
---

# A Node can have its own hostname, attached by the deploy

**The question.** Whether the install and the upgrade can give a Node a hostname of the operator's own
(`mail.example.com` rather than `<worker>.<account>.workers.dev`) without a dashboard visit, through the
deploy sequence this repository already runs: `wrangler deploy` on a first install, `versions upload` then
`versions deploy` through the canary afterwards.

**Measured** on 26 September 2026 (UTC) on a scratch Worker `mailda-probe-custom-domain` in the operator's
account, with `routes: [{ "pattern": "probe-node.mailda.site", "custom_domain": true }]` in its config,
wrangler 4.118.0. The Worker was deleted afterwards.

| act | outcome |
|---|---|
| first `wrangler deploy` with the route in config | `Deployed … triggers`, `probe-node.mailda.site (custom domain)`; three `000`s then `200` within ~30 s |
| `versions upload` then `versions deploy <id>@100` (the canary path) | the hostname kept answering |
| a second hostname added to the config of the existing Worker, then `wrangler triggers deploy` | `probe-node2.mailda.site (custom domain)`, `200` within ~10 s |
| `wrangler delete` | both hostnames answered `522` at once, then `dig` returned nothing: no DNS record lingered |

**What it establishes.** A first deploy attaches the hostname; the canary path keeps it; a hostname added
to a Node already deployed needs one more command, `wrangler triggers deploy`, which the upgrade runs
when the derived config carries routes. So the install and the upgrade ask for a hostname (a zone from
the picker, then the label), write it into the Node's derived config, and the deploy attaches it; the URL
remembered in `.mailda/nodes.json` is then `https://<hostname>`.

**What it does not establish.** Timing on a zone with heavier DNS, and the hostname surviving a Worker
rename, neither of which the install does. And the earlier reason a custom hostname was dashboard-only,
that changing it changed the OAuth client's redirect URI too, is gone with the OAuth client (ADR 42,
amended 26 September 2026).
