---
id: cloudflare-grant-reach
kind: platform-limit
measured_on: 2026-09-14
stale_when: >
  the Node calls a Cloudflare endpoint not in the table below; `REQUIRED_SCOPES` changes;
  Cloudflare publishes an Accepted Permissions block for the Email Sending subdomain endpoints;
  or a grant narrowed to the five scopes named here is observed failing on any of them
values:
  grant.scopes_asked_for: 15
  grant.scopes_authorizing_a_call: 5
  grant.endpoints_reached: 8
  grant.endpoints_with_documented_permission: 5
  grant.narrowed_grant_probed: 0
---

**Measured:** against the live Node `mailda.swmengappdev.workers.dev` and its real grant on the
`Swmengappdev` Cloudflare account, 14 September 2026. Every endpoint below was reached **through that
grant** during #162 and #163 rather than with a separate token.

## What this supersedes, and what it does not

#21's measurement asked whether `mailda deploy` could onboard an Email Routing subdomain, and answered
*dashboard-only*. `email-routing-subdomain-onboarding.md` still holds that answer and three dated additions
to it — including the one where its own `stale_when` fired for the **sending** half. That file remains the
record of what Email Routing and Email Sending can be configured *by API*.

This file is the other half #163 asked for: **what this Node's grant actually reaches, and what it was
granted.** The two are not the same number, which is the finding.

## The eight paths, and the five scopes behind them

Nine rows, eight paths: `GET` and `POST` on the sending subdomains share one. The closed-world test counts
paths, because a scope authorizes a path and the methods on it are not separately reachable.

| endpoint | scope | permission the reference names |
|:--|:--|:--|
| `GET /accounts` | `account-settings.read` | — |
| `GET /zones?name=` | `zone.read` | `Zone Zone Read` |
| `GET /zones/{}/email/routing` | `zone-settings.read` | `Zone Settings Write \| Read` |
| `GET /zones/{}/email/routing/dns` | `zone-settings.read` | `Zone Settings Write \| Read` |
| `GET /zones/{}/email/sending/subdomains` | `email-sending.write` | **none published** |
| `POST /zones/{}/email/sending/subdomains` | `email-sending.write` | **none published** |
| `GET /zones/{}/email/sending/subdomains/{}/dns` | `email-sending.write` | **none published** |
| `GET /accounts/{}/event_subscriptions/subscriptions` | `queues.write` | `Queues Write \| Read`, or `Workers Scripts Write \| Read` |
| `GET /accounts/{}/queues/{}` | `queues.write` | `Queues Write \| Read`, or `Workers Scripts Write \| Read` |

Plus `offline_access`, which authorizes no endpoint — it is what makes the token renewable, and a grant
without it would reach every row above exactly once.

`test/node/cloudflare-reach-world.test.ts` asserts this set against the module's source, so a ninth endpoint
is a decision somebody makes rather than a line that appears. It strips comments first, after the doc comment
quoting `/zones/{zone_id}/email/sending/subdomains` was counted as a ninth: **prose about an endpoint is not
a call to it.**

### Three endpoints have no documented permission at all

The Email Sending subdomain pages carry a *Security* section and **no *Accepted Permissions* block**, where
every other endpoint in this table has one. So nothing published says which scope authorizes them. What is
observed is narrower than it looks: a grant holding `email-sending.write` reaches them. Whether a grant
*without* it would also reach them — via `zone-settings.read`, say — is unmeasured, and
`grant.narrowed_grant_probed: 0` records that rather than letting the table imply it.

That matters because it is load-bearing for the narrowing below: `email-sending.write` cannot be dropped on
the strength of the documentation, because the documentation does not speak.

## Nine granted scopes authorize nothing this Node calls

```text
account-api-gateway.read         email-routing-address.write      user-details.read
account-dns-settings.read        email-routing-rule.write         workers-scripts.read
d1.write                         email-routing-suppression.write
email-routing-account-rule.read
```

`REQUIRED_SCOPES` already says why, about two of them: they are *"what the picker had checked"* when a real
client was registered, *"where L1 would rather have had the reads Cloudflare does offer"*. This is that
admission counted. Nine of fifteen is not a rounding error — it is a set of permissions on a customer's
Cloudflare account that no code path in this repository uses.

Two of the five that *are* used are **write** scopes where a read exists and would do: `queues.write` backs
two `GET`s, and nothing writes to a queue through this grant.

### What a narrowed grant would be

**Six**, if the write-for-read pair is corrected and `email-sending.write` is kept because nothing documents
an alternative:

```text
account-settings.read   zone.read   zone-settings.read   queues.read
email-sending.write     offline_access
```

`account-dns-settings.read` would be a seventh only if L2's write side ever needs to read a zone's
actual records — it does not today, and the reason is recorded in
`email-routing-subdomain-onboarding.md`: onboarding asks Cloudflare what is *onboarded*, not what is
*resolving*.

**This is a proposal, not a measurement.** `grant.narrowed_grant_probed: 0` is the honest value: no grant
has been registered with this set and observed to work. Two things could be wrong with it — `queues.read`
might not cover the event-subscriptions list (the reference names Queues Read, so probably), and
`email-sending.write` might be unnecessary (undocumented, so unknowable without trying). Both are settled by
one re-consent with the narrower set, and both would otherwise be *assumed*, which is the shape this
repository keeps finding defects in.
