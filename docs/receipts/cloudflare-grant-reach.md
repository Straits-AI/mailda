---
id: cloudflare-grant-reach
kind: platform-limit
measured_on: 2026-09-14
stale_when: >
  the Node calls a Cloudflare endpoint not in the table below; `REQUIRED_SCOPES` changes;
  Cloudflare publishes an Accepted Permissions block for the Email Sending subdomain endpoints;
  or any path in the table is observed failing on the six scopes named here
values:
  grant.scopes_asked_for: 6
  grant.scopes_authorizing_a_call: 5
  grant.endpoints_reached: 9
  grant.endpoints_with_documented_permission: 5
  grant.narrowed_grant_probed: 1
  registrar.register_idempotent: 0
  registrar.register_idempotency_documented: 1
---

**Measured:** against the live Node `mailda.swmengappdev.workers.dev` and its real grant on the
`Swmengappdev` Cloudflare account, 14 September 2026. Every endpoint below was reached **through that
grant** during #162 and #163 rather than with a separate token.

## Addition, 15 September 2026: the registrar reads, and one measurement deliberately not taken (#164)

Two endpoints added, both read-only, both exercised live through the grant: `domain-search` (cached
suggestions) and `domain-check` (real-time registry price). `registrar-domains.read` was added to
`REQUIRED_SCOPES`, consented to, and every path below exercised.

`registrar-domains.admin` was **not** added. It authorizes buying domains on the operator's account —
authority to spend their money — and belongs to the change that ships a gated purchase flow, not to one that
wants to see a price.

### The probe was bought, and did not run. 15 September 2026

`mailda.site` was registered through the Node's own grant at **USD 4.99**, auto-renew off. The purchase
succeeded on the first `POST`. The probe did not run, and the reason is recorded because it is the useful
part:

The Node answered **500**. `outcomeOf` read `status.error === undefined` where Cloudflare sends
`"error": null`, so it threw *after* the registration had been created and billed — the operator was told
the purchase failed while Cloudflare had completed it. The status route carried the same fault, so checking
also failed. Twenty tests covered this path and every fixture **omitted** `error`, which is the one shape
the API never sends.

By the time the crash was understood the registration had completed, and the in-flight window a retry must
land in — seconds — had closed. **A probe measuring a retry has to retry in the same breath as the
purchase**; checking status first spends the only window there is. That sequencing error is why the money
bought a domain, a live proof of the flow and a real defect, but not the measurement it was spent for.

**The remaining measurement is declined rather than pending.** A retry after completion would still test
Cloudflare's claim, and its cost is its own result: nothing if the provider is idempotent, USD 4.99 if it is
not. Asked to run it *only if it would not charge*, there is no such run — whether it charges is the
question. So it stays unmeasured by decision, and this receipt says so rather than leaving a box that reads
as pending work.

Two things make that acceptable. `purchase.ts` retries a registration on no path whatsoever, so the answer
changes how redundant the guard is and not whether it is safe. And the audit entry written **before** the
charge is what produced the only record of that USD 4.99 when the response denied it — a design note that
stopped being hypothetical the first time it was needed.

### `registrar.register_idempotency_documented: 1`, `registrar.register_idempotent: 0`

Two values because they are two different facts. Cloudflare's reference now states:

> Cloudflare permits only one registration per domain, making the domain name a natural idempotency key for
> registration requests.

That is a **claim about behaviour under a retry**, and #164 exists because such a claim *"cannot be designed
from documentation"*. It may well be true. It is recorded as documented and **not** as measured, and the
probe that would settle it — a real registration, an abandoned poll, a retry, and the billing outcome — has
not been paid for.

Nothing in `purchase.ts` depends on the answer. No path retries a registration: not on a timeout, not on an
unreadable answer, not on a lifecycle state it does not recognise. Every uncertain outcome ends in *read the
state and tell a person*. If the claim is true the guard is redundant; if it is false the guard is what
stops the second charge. `test/node/purchase-never-retries.test.ts` holds that lexically, because a retry
added later would arrive with tests describing it as correct.

### A parameter the reference does not name

`domain-search` takes **`q`**. The reference names no parameter for it at all; `query` was inferred from its
prose and the first live call answered `1001 Missing required parameter: q`. Cheap to find, because that
endpoint reserves nothing — the same inference against a `POST /registrations` body would have been a
purchase. It is the seventh documented claim in this flow to be silent, incomplete or wrong, and the reason
the idempotency claim above is not being taken on trust.

## What this supersedes, and what it does not

#21's measurement asked whether `mailda deploy` could onboard an Email Routing subdomain, and answered
*dashboard-only*. `email-routing-subdomain-onboarding.md` still holds that answer and three dated additions
to it — including the one where its own `stale_when` fired for the **sending** half. That file remains the
record of what Email Routing and Email Sending can be configured *by API*.

This file is the other half #163 asked for: **what this Node's grant actually reaches, and what it was
granted.** The two are not the same number, which is the finding.

## The eight paths, and the five scopes behind them

Ten rows, nine paths: `GET` and `POST` on the sending subdomains share one. The closed-world test counts
paths, because a scope authorizes a path and the methods on it are not separately reachable.

| endpoint | scope | permission the reference names |
|:--|:--|:--|
| `GET /accounts` | `account-settings.read` | — |
| `GET /accounts/{}` | `account-settings.read` | — |
| `GET /zones?name=` | `zone.read` | `Zone Zone Read` |
| `GET /zones/{}/email/routing` | `zone-settings.read` | `Zone Settings Write \| Read` |
| `GET /zones/{}/email/routing/dns` | `zone-settings.read` | `Zone Settings Write \| Read` |
| `GET /zones/{}/email/sending/subdomains` | `email-sending.write` | **none published** |
| `POST /zones/{}/email/sending/subdomains` | `email-sending.write` | **none published** |
| `GET /zones/{}/email/sending/subdomains/{}/dns` | `email-sending.write` | **none published** |
| `GET /accounts/{}/event_subscriptions/subscriptions` | `queues.write` | `Queues Write \| Read`, or `Workers Scripts Write \| Read` |
| `GET /accounts/{}/queues/{}` | `queues.write` | `Queues Write \| Read`, or `Workers Scripts Write \| Read` |
| `GET /accounts/{}/queues` | `queues.read` | `Queues Write \| Read`, or `Workers Scripts Write \| Read` — listed by #222 to find this Node's own queue by name |
| `POST /accounts/{}/queues/{}/consumers` | `queues.write` (candidate) | `Queues Write`. Attaches a Worker consumer; measured 16 September 2026 with the operator's token on a throwaway queue. Through the grant unmeasured |
| `POST /accounts/{}/event_subscriptions/subscriptions` | `queues.write` | none published for an `email.sending` source. Measured 16 September 2026: refused with `queues.read`, created with `queues.write` |
| `POST /zones/{}/email/routing/enable` | `zone-settings.write` | `Zone Settings Write` — enables routing on the zone. **`PATCH /email/routing { enabled: true }`, which #210 shipped, answers `success: true` and leaves the zone `enabled: false, status: unconfigured`** — measured 16 September 2026 on `mailda.site`; the `POST` answered `enabled: true, status: ready`. Measured with the operator's token; through the grant unmeasured |
| `POST /zones/{}/dns_records` | `dns.write` | `DNS Write` — the MX records receiving needs (#209); measured written on the #92 drill, 16 September 2026 |
| `POST /zones/{}/email/routing/rules` | `email-routing-rule.write` | `Email Routing Rules Write`. Was carried as `zone-settings.write` by inference; measured refused under it (`10000 Authentication error`) on the #92 drill, 16 September 2026 |

Plus `offline_access`, which authorizes no endpoint — it is what makes the token renewable, and a grant
without it would reach every row above exactly once.

`test/node/cloudflare-reach-world.test.ts` asserts this set against the module's source, so a ninth endpoint
is a decision somebody makes rather than a line that appears. It has been wrong three times, always the same way — **naming an
endpoint is not calling one**. A doc comment quoting Cloudflare's own path was counted as an endpoint; so
was a refusal message telling an operator that `/accounts/{id}/subscriptions` answers 403, which no amount
of comment-stripping reaches. And the onboarding `POST` builds a full `https://api.cloudflare.com/…` URL and
was matched by nothing at all — the dangerous direction, since an endpoint the scan cannot see is one the
closed world does not close. It now strips the base URL, requires a literal to be *entirely* a path, and
requires it to sit in argument position.

### Three endpoints have no documented permission at all

The Email Sending subdomain pages carry a *Security* section and **no *Accepted Permissions* block**, where
every other endpoint in this table has one. So nothing published says which scope authorizes them. What is
observed is narrower than it looks: a grant holding `email-sending.write` reaches them. Whether a grant
*without* it would also reach them — via `zone-settings.read`, say — is unmeasured, and
`grant.narrowed_grant_probed: 0` records that rather than letting the table imply it.

That matters because it is load-bearing for the narrowing below: `email-sending.write` cannot be dropped on
the strength of the documentation, because the documentation does not speak.

## Addition, same day: the narrowing was registered, consented to, and exercised

Everything below was written while the grant held **fifteen** scopes. It now holds **six**, and this section
is why `grant.scopes_asked_for` reads 6 and `grant.narrowed_grant_probed` reads 1.

The client's scope list was edited in the dashboard to the five pickable names — `Account Settings Read`,
`Zone Read`, `Zone Settings Read`, `Queues Read`, `Email Sending Write` — and a consent run through
`/api/provider/authorize`'s scope override rather than by changing `REQUIRED_SCOPES` first, so a failure
would have left the constant untouched:

```json
{"consent":{"ok":true,"scopesGranted":["account-settings.read","zone.read","zone-settings.read",
 "queues.read","email-sending.write","offline_access"],"scopesDeclined":[]}}
```

Then **all eight paths against that grant**, on the live Node: the account resolved, Email Routing's verdict
and records read, the sending subdomains listed with their DNS, the event subscription and its queue's
consumer read, a proposal produced — and `POST /zones/{}/email/sending/subdomains` onboarded
`probe2.mailda-test.whymelabs.com`, whose six records were confirmed in public DNS.

So both open questions are answered. **`queues.read` covers the event-subscriptions list and the queue
read**, which the reference suggested and nothing had shown. And the five-scope read set is sufficient for
every read.

### The `POST` had to be re-run rather than argued about

The tempting shortcut was that `email-sending.write` is unchanged between the old grant and the new, so the
write path could not have been affected. **That argument rests on a table Cloudflare does not publish.**
Because these endpoints carry no *Accepted Permissions* block, which scope authorized that `POST` was never
known — it could as easily have been one of the nine being dropped. Onboarding would then have broken for
the next operator with nothing recorded to say why.

Still unmeasured, and the next probe: whether `email-sending.read` suffices for the three read paths, which
would let a Node that never onboards hold no write scope at all. It needs its own re-consent.

## Nine granted scopes authorized nothing this Node called

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

### What the narrowed grant is

**Six** — the write-for-read pair corrected, and `email-sending.write` kept because nothing documents an
alternative:

```text
account-settings.read   zone.read   zone-settings.read   queues.read
email-sending.write     offline_access
```

`account-dns-settings.read` would be a seventh only if L2's write side ever needs to read a zone's
actual records — it does not today, and the reason is recorded in
`email-routing-subdomain-onboarding.md`: onboarding asks Cloudflare what is *onboarded*, not what is
*resolving*.

This was written as *"a proposal, not a measurement"*, with two things that could be wrong: whether
`queues.read` covers the event-subscriptions list, and whether `email-sending.write` is necessary. The first
is now measured and holds. The second is unchanged and still undocumented — see the addition above.
