---
id: preview-urls-and-durable-objects
kind: platform-limit
measured_on: 2026-08-31
stale_when: >
  Cloudflare removes the Durable Object exclusion from preview URL generation, which would make an alias
  hostname available again and the version-override gate an unnecessary indirection; the two-versions-per-
  deployment limit changes, since the gate builds a pair; Cloudflare begins reporting an error rather than
  falling back to traffic percentages when a version override cannot be applied, which is the only reason the
  gate has to check the responder's identity; or Mailda stops implementing Durable Objects, which would mean
  ADR 28's root keys have moved somewhere else and is a much larger change than this receipt
values:
  deploy.canary_preview_url_available: 0
  deploy.canary_traffic_percent: 0
  deploy.versions_per_deployment: 2
---

# The canary has no preview URL, and the reason is not a setting

Issue [#98](https://github.com/Straits-AI/mailda/issues/98). `mailda deploy` uploads a canary version and
checks it before moving traffic. For three deploys the check could not run: the canary's hostname answered
404, and two rounds of the live drill recorded the cause as *"not established — could be an account-level
preview setting, a per-Worker dashboard toggle, or something about a Worker whose first version predates the
alias"*, with a note that settling it needed someone to look at the dashboard.

It did not need the dashboard. Read from the account's own API on 31 August 2026:

```text
GET /accounts/{account}/workers/scripts/mailda/subdomain
  → {"enabled": true, "previews_enabled": true}

GET /accounts/{account}/workers/scripts/mailda/versions/{id}
  → annotations: {"workers/alias": "canary", ...}
    no preview-URL field on the version
    bindings of type durable_object_namespace: ["KEY_VAULT", "OUTBOX_SWEEPER"]
```

So preview URLs were **already enabled**, the alias **was** recorded, and no hostname routed — the 404 body
is Cloudflare's generic page, not a Worker refusing. The suspected toggle was on the whole time.

The cause is a documented platform limitation:

> Preview URLs are not generated for Workers that implement a Durable Object.

— [Preview URLs, Limitations](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)

Mailda implements two, and cannot stop: ADR 28 moved both root keys into the `KeyVault` Durable Object
precisely so a managed secret store could not re-provision them. `OutboxSweeper` is the send path's timer.
**No configuration reaches this**, which is why `wrangler.jsonc` now declares `preview_urls: false` — the
honest value, and the safer one if a later version ever drops its Durable Objects.

## What replaced it

A version override against the production hostname, which works with Durable Objects:

1. `wrangler versions upload` — the canary exists and serves nothing.
2. `wrangler versions deploy <canary>@0 <incumbent>@100` — because an override *"will only be applied if the
   specified version is in the current deployment"*. At 0% nothing reaches it but the override.
3. `GET /api/doctor` with `Cloudflare-Workers-Version-Overrides: mailda="<canary>"`.
4. **Require the report to name that version id.** See below — this is the gate.
5. `wrangler versions deploy <canary>@100`.

Cloudflare serves at most **two** versions in one deployment, which is exactly what step 2 needs and also its
ceiling: this mechanism cannot check two canaries at once.

## Why the gate is an identity check and not a health check

Cloudflare does not error when an override cannot be applied. From the same documentation:

> In the case that a request's version override is not applied, the request will be routed according to the
> percentages set in the gradual deployment configuration.

That is the incumbent, at 100%. No error, no header, nothing to notice. A gate that asked *"is the Node
healthy?"* would therefore be asking the **old** version, receive `ok`, and promote a canary nothing had
examined — an assertion that cannot fail, which `AGENTS.md` §2b forbids.

So the Worker carries a `version_metadata` binding and `/api/doctor` reports `version`, and the CLI refuses
unless the id in the report equals the id it uploaded. A report that names no version is a refusal too: a
Node too old to carry the field is a Node this gate cannot check, and "cannot check" is not "passed".

## Not verified here

That the sequence works end to end against a live account. It is written and unit-tested; the drill needs a
deploy to a Node carrying real mail, and the previous two drills are what produced the measurement above.
The failure mode is safe either way — every refusal in the sequence leaves the incumbent at 100%.

What the canary still does not cover is unchanged and documented in `deploy`: **Durable Object code is the
incumbent's**, because only one version of each object runs at a time and the canary holds 0% of traffic. A
change inside `KeyVault` or `OutboxSweeper` is validated by the post-promotion `doctor` run, not by the gate.
