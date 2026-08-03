---
id: free-plan-node-capability
kind: platform-limit
measured_on: 2026-08-03
stale_when: >
  Cloudflare changes free-plan Email Sending behaviour, extends sending beyond verified
  destination addresses on free, or changes the wording of the verified-destination error
values:
  freeplan.inbound_to_worker: 1
  freeplan.send_to_verified_destination: 1
  freeplan.send_to_arbitrary_recipient: 0
  freeplan.send_error_names_the_plan: 0
---

**Measured:** live test on a **Workers Free** account, 3 August 2026. A probe Worker with an
`email()` handler, a D1 binding and a `send_email` binding, deployed to
`mailda-freeplan-probe`, with one Email Routing rule pointing `mailda-test@straits-ai.com`
at it. All test resources removed afterwards.

## Inbound works, end to end, at zero cost

A real message sent from Gmail arrived and was persisted:

```json
{ "from_addr": "swmengappdev@gmail.com",
  "to_addr":   "mailda-test@straits-ai.com",
  "subject":   "Testing 123",
  "raw_bytes": 7072,
  "at":        "2026-08-03T14:00:00.694Z" }
```

Public internet → Cloudflare MX → Email Routing rule → Worker `email()` handler → D1 write.
Nothing about that path required a paid plan.

## Outbound: this corrects an earlier receipt

`cloudflare-plan-costs.md` recorded, from the pricing table's *"Outbound emails (Email
Sending) — Workers Free: Not available"*, that a free-plan Node **cannot send**. That is too
blunt. Measured:

| Destination | Result |
|---|---|
| `mystraits.ai@gmail.com` — a **verified** Email Routing destination | **sent successfully** |
| `someone@example.com` — arbitrary | refused |

The `send_email` binding also deployed without complaint and was reported as
`env.OUTBOUND (unrestricted)`.

So *"not available"* in the pricing table means **arbitrary recipients** are unavailable, not
that the send path is dead. A free-plan Node can send to addresses already verified in the
account, which is consistent with the pricing note that *"sends to verified destination
addresses are always free … on any plan"* — but a reader of the plan comparison alone would
conclude sending is impossible. It is not.

## The refusal does not name the plan

Verbatim, on an arbitrary recipient:

```
destination address is not a verified address
```

Accurate, and unhelpful. It does not mention the plan, a paid upgrade, or domain
verification — the probe checked explicitly and `namesThePlan` was false.

This is precisely the failure mode §5C exists to prevent and `AGENTS.md` calls a landmine: a
refusal that names neither the cause the user can act on nor the way to fix it. Mailda must
**not** surface this string. §11B requires `doctor` to distinguish
`outbound_verified_destinations_only` from `outbound_send_enabled`; the send path must
translate this error into that state and say which of *verify the domain* or *upgrade the
plan* applies.

## What this means for #19

The free plan is a **genuinely functional receive-only Node**, not a crippled one:

- receives real mail from the public internet, unlimited and free
- stores, parses and indexes it
- can reply to **verified** addresses — so an evaluator can test a round trip to their own
  inbox without paying
- cannot reply to a customer

That is a stronger evaluation story than "receive-only" suggested. An evaluator points one
address at a free Node, receives their own real mail, and can even exercise a reply to
themselves before deciding to pay.

## Residual

- Subdomain onboarding (`mailda-test.straits-ai.com`) was **not** tested. Cloudflare
  documents it as a dashboard-only flow — *"select the apex domain, open Settings, under
  Subdomains enter the subdomain"* — with no API or wrangler path, so it could not be
  automated. §10's domain topology recommends a delegated subdomain as the default install,
  so this gap matters and should be closed.
- Free-plan queue behaviour (10,000 operations/day, 24-hour non-configurable retention) was
  not exercised; the probe used no queue.
- Whether the verified-destination allowance is per-account or per-zone was not tested.
