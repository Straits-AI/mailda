---
id: email-routing-subdomain-onboarding
kind: platform-limit
measured_on: 2026-08-03
stale_when: >
  Cloudflare ships an API or wrangler command for adding a subdomain to Email Routing, or
  exposes Email Routing's managed MX records through the DNS records API
values:
  routing.subdomain_api_available: 0
  routing.subdomain_dashboard_only: 1
  routing.mx_records_visible_in_dns_api: 0
  routing.subdomain_receives_external_mail: 1
  routing.cf_sending_reaches_own_routing_domain: 0
---

**Measured:** against `whymelabs.com` on a Workers Paid account, 3 August 2026. A probe
Worker was deployed and deleted; no DNS record was created, and the zone's 15 routing rules
and enabled catch-all were left untouched.

## The question

§10's domain topology makes a **delegated operational subdomain** — `ops.example.com`,
`mail.example.com` — the default for a new installation, so an existing root-domain MX is
never disturbed. #20 may promote it further, to the recommended evaluation path. Can
`mailda deploy` onboard one, or does it need a human in the dashboard?

## Result: dashboard-only, on current evidence

**No API endpoint exists.** Probed against a real zone with a working token:

| Endpoint | Result |
|---|---|
| `GET /zones/{zone}/email/routing` | 200 |
| `GET /zones/{zone}/email/routing/dns` | 200 |
| `GET /zones/{zone}/email/routing/subdomains` | **404** |
| `GET /zones/{zone}/email/routing/domains` | **404** |
| `GET /accounts/{acct}/email/routing` | 400 |
| `GET /accounts/{acct}/email/sending/domains` | **404** |

**Wrangler cannot reach it either.** `wrangler email routing settings mailda-test.whymelabs.com`
fails with *"Could not find zone for mailda-test.whymelabs.com"* — its email commands resolve
a **zone**, and a subdomain is not one.

Cloudflare documents only the dashboard flow: *"Select the apex domain, then open Settings.
Under Subdomains, enter the subdomain you want to enable in the inline form and submit it."*

## Why the DNS route is not an obvious workaround

`whymelabs.com` already has a working Email Routing subdomain, `medstocks.whymelabs.com`.
Comparing the two sources of truth:

```
GET /zones/{zone}/dns_records?type=MX   ->  0 records
dig +short MX whymelabs.com             ->  25 route1.mx.cloudflare.net, 34 route2…
dig +short MX medstocks.whymelabs.com   ->  12 route3.mx.cloudflare.net, 25 route1…
```

Real MX records exist in public DNS for both the apex and the subdomain, and **none of them
appear in the DNS records API.** Email Routing's records are service-managed rather than
ordinary zone records, which is consistent with the documented "locked records" behaviour.
So the subdomain's MX is not something that was added through the DNS API and cannot be
inspected or reproduced through it.

## Confirmed after dashboard onboarding: a subdomain behaves exactly like the apex

The subdomain was onboarded through the dashboard, and MX records appeared in public DNS:

```
dig +short MX mailda-test.whymelabs.com
  12 route3.mx.cloudflare.net.  25 route1.mx.cloudflare.net.  34 route2.mx.cloudflare.net.
```

A routing rule created with `--match-value probe@mailda-test.whymelabs.com --action-type worker`
was accepted with identical syntax to an apex rule, and a real message from Gmail was
delivered to the Worker:

```json
{ "f": "wmhy.tech@gmail.com", "t": "probe@mailda-test.whymelabs.com",
  "s": "Testing", "bytes": 7154, "at": "2026-08-03T15:17:53.827Z" }
```

So once onboarded, **nothing about a subdomain is special** — same rule syntax, same `worker`
action, same delivery. The only obstacle is the onboarding step itself, which has no API.

## A separate finding that matters more: Cloudflare cannot test its own inbound

Two sends via `wrangler email sending send` from `weimeng.soh@whymelabs.com` — one to the
subdomain, one to an **apex** control address — **never arrived**, while the external Gmail
message arrived within seconds. Both sends reported `Email sent successfully.`

Cloudflare Email Sending therefore does not deliver to a domain whose MX points at Cloudflare
Email Routing in the same account. Loop protection is the obvious explanation; the mechanism
was not confirmed.

**This constrains §5A directly.** Step 6's synthetic inbound test is the step that proves a
Node actually receives mail — and it **cannot generate its own test message using Cloudflare
Email Sending**, because that message will be accepted, reported as sent, and never delivered.
The test needs an external sender or it proves nothing while appearing to pass, which is the
worst kind of test.

Recorded as a requirement rather than a curiosity: whatever performs the synthetic inbound
check must originate outside the Node's own account.

## What could not be tested, and why

One question remains unanswered: whether adding *ordinary* MX records for a subdomain would
be sufficient on its own, or whether the dashboard flow also registers the subdomain
internally. The subdomain used here was onboarded through the dashboard, so both happened
together. Creating records directly failed:

```
POST /zones/{zone}/dns_records  ->  Authentication error
```

The available OAuth token holds `zone (read)` and no DNS write scope. So this remains open,
and it matters: if plain MX records suffice, install could automate subdomain onboarding with
a DNS-capable token. If they do not, no token helps and the dashboard is mandatory.

## Consequence

**§5A's default install path cannot currently be automated.** `mailda deploy` must either
hand the user a dashboard instruction mid-install, or fall back to an apex domain — which is
exactly the higher-stakes DNS change §10's subdomain default exists to avoid.

That is a real cost on #20's "promote the subdomain to default" option, and it should be
weighed there rather than discovered during implementation.

## Incidental finding worth its own attention

`whymelabs.com` has **four routing rules for `medstocks.whymelabs.com` addresses**, and that
subdomain does resolve MX — so those are live. But nothing in the API prevents creating a
routing rule for a subdomain that has **no** MX records at all. Such a rule would be accepted,
appear healthy in every listing, and silently never receive anything.

Mailda must not reproduce that. A route is not proven by its existence — §5A step 8's
synthetic inbound test exists precisely to prove delivery, and this is a concrete example of
why configuration alone is not evidence.

## Residual

- Whether plain MX records suffice for subdomain acceptance: **untested**, blocked on DNS
  write permission.
- Email **Sending** on a subdomain is separately onboarded per the docs, with its own
  `cf-bounce` MX, SPF, DKIM and DMARC records. Untested.
- How subdomains count against the 30-domains-per-zone limit: untested.
