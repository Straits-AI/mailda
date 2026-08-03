---
id: cloudflare-email-service-limits
kind: platform-limit
measured_on: 2026-08-03
stale_when: >
  Cloudflare publishes different Email Service limits, raises the 5 MiB outbound ceiling
  for arbitrary recipients, or changes the domain-verification requirement for sending to
  unverified destinations
values:
  email.inbound.max_bytes: 26214400
  email.outbound.max_bytes: 5242880
  email.outbound.max_bytes_verified_destination: 26214400
  email.max_recipients_per_message: 50
  email.max_subject_chars: 998
  email.max_custom_header_bytes: 16384
  email.max_routing_rules_per_domain: 200
  email.max_destination_addresses_per_account: 200
  email.max_domains_per_zone: 30
---

**Measured:** read from published Cloudflare documentation on 3 August 2026.

Sources:

- [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [Send emails — REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
- [Send emails — SMTP](https://developers.cloudflare.com/email-service/api/send-emails/smtp/)
- [Authenticated SMTP submission changelog](https://developers.cloudflare.com/changelog/post/2026-06-08-smtp-submission/), 8 June 2026

## Why these are product limits, not adapter data

§11B previously treated Cloudflare Email limits as adapter data — one transport among
several, detected at runtime. ADR 23 makes Cloudflare Email Service the **only** transport.
These numbers are therefore the product's limits, and belong on a pricing page rather than
in a capability manifest nobody reads.

## The one that matters

**5 MiB outbound to arbitrary recipients.** The 25 MiB figure applies only to
*verified destination addresses* — addresses pre-verified through Email Routing, not
ordinary customers. So a Node can **receive** a 25 MiB attachment and be unable to reply
with it or forward it.

This was put to the product owner explicitly before ADR 4 and ADR 5 were reversed, and
accepted. It must be stated plainly to prospects rather than discovered.

## Everything else

| Limit | Value |
|---|---:|
| Inbound message size | 25 MiB |
| Outbound, arbitrary recipients | **5 MiB** |
| Outbound, verified destinations | 25 MiB |
| Recipients per message (to + cc + bcc) | 50 |
| Subject line | 998 characters |
| Custom headers, combined | 16 KB |
| Routing rules per domain | 200 |
| Destination addresses per account | 200 |
| Domains per zone | 30 |

## Availability — the blueprint was out of date

§11B described Email Sending as "a beta capability whose availability, arbitrary-destination
entitlement and required paid account features must be detected—not assumed."

That no longer holds. The limits documentation carries **no beta designation and no
availability gating**. Sending to arbitrary recipients requires only that the sending
domain be onboarded and verified: *"Once a domain is verified, you can send to any
recipient immediately."* Before verification, sends are restricted to verified destination
addresses, and those *"are always free: they do not count toward your monthly quota or
your daily sending limits, on any plan."*

Daily quota is not a fixed number — *"new accounts start with a conservative daily quota
and scale up over time"* based on sending behaviour and deliverability. That is a real
constraint on a brand-new Node and is not expressible as a constant, so it is deliberately
absent from `values` above. `doctor` must read it from the account rather than assume it.

Three send paths exist: the Workers binding, the REST API
(`POST /accounts/{id}/email/sending/send`), and authenticated SMTP submission on
`smtp.mx.cloudflare.net:465`, which entered beta on 8 June 2026. All three share one
delivery pipeline, one set of limits, and automatic DKIM and ARC signing.

## Residual

- Daily sending quota is account-specific and reputation-dependent; unmeasured here.
- SMTP submission is the one component still marked beta. Mailda uses the Workers binding
  by default, so this is not on the critical path.
- Not verified against a live send. These are published figures, not observed behaviour —
  a send test against a verified domain would upgrade this receipt.
