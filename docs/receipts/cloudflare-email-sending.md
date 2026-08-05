---
id: cloudflare-email-sending
kind: platform-limit
measured_on: 2026-08-04
stale_when: >
  Email Sending leaves public beta, the legacy EmailMessage API is withdrawn, the structured send()
  header limits change, or Cloudflare publishes the daily sending quota
values:
  send.included_per_month: 3000
  send.cost_per_thousand_cents: 35
  send.max_custom_headers: 20
  send.max_header_value_bytes: 2048
  send.max_headers_total_bytes: 16384
  send.max_references_entries_for_reply: 100
  send.references_emitted_max: 20
  send.hold_window_default_seconds: 15
  send.daily_limit_is_published: 0
---

Read from Cloudflare's documentation and checked against the live account on 4 August 2026. Email
Sending entered **public beta on 16 April 2026** and is Workers Paid only; Email Routing is on both
plans.

## The entitlement is domain onboarding, not the plan

This is the part that is easy to get wrong, because ADR 25 already made Workers Paid mandatory and it
would be natural to assume that settles it. It does not:

> Before you onboard a sending domain, you can send emails only to verified destination addresses in
> your account. After you onboard a sending domain, you can send to any recipient immediately.

So there are **two gates**, and a Node can be on Workers Paid and still unable to reply to a customer.
Onboarding means SPF and DKIM DNS records on the sending domain.

Checked on the development account: `whymelabs.com` is onboarded and enabled (since 20 June 2026,
DKIM selector `cf-bounce`, return path `cf-bounce.whymelabs.com`), as is `infinirewards.com`. Neither
was changed.

Sends to **verified destination addresses** are free on any plan, do not count toward the monthly quota
or the daily limit, and work even when only Email Routing is configured. That makes them the only
zero-cost way to prove the send path works — which matters given the finding below.

## Onboarding is per subdomain, and is not inherited (measured 5 August 2026)

Assumed wrong, then tested against the live API. `whymelabs.com` is onboarded and enabled, and a send
from `inbox@mailda-test.whymelabs.com` was **refused**:

```
email sending not authorized for subdomain 'mailda-test.whymelabs.com'
```

**Onboarding applies to the exact name, not to the zone.** `wrangler email sending list` shows a
`zone` and a `name` column, and the `name` is the unit — a subdomain of a fully onboarded apex is a
separate thing that must be enabled separately.

This is not a footnote. **§10 makes a delegated subdomain (`mail.example.com`) the *default* install
path**, so the default path requires onboarding a subdomain for sending, and #21 already found that
subdomain *routing* onboarding is dashboard-only with no API. Sending appears better served —
`wrangler email sending enable <domain>` accepts "a zone or subdomain" — so the two halves of the same
subdomain may have different automation stories, which `mailda deploy` has to handle rather than
assume.

The string also has to be classified correctly, and was not at first: it went to `outcome_unknown`
because nothing matched it. The safe default behaved as designed — an unclassifiable failure gets the
state that forbids automatic retry — but it is the wrong answer, since the message provably never left
and this is the most *fixable* failure in the set. It is now `refused`, with a message naming
per-subdomain onboarding, because Cloudflare's own wording names a subdomain and no remedy.

## Two APIs, and they record different things

| | `env.EMAIL.send({from, to, subject, html, text})` | `new EmailMessage(from, to, rawMime)` |
|---|---|---|
| Status | Preferred for new code | **"Legacy… supported for backward compatibility"** |
| Who builds the MIME | Cloudflare | Mailda |
| What can be recorded | What we *asked for* | The bytes we *submitted* |
| Custom headers | ≤ 20 non-`X-`, ≤ 2,048 bytes each, ≤ 16 KB total; `From` must use the API field | Whatever the MIME contains |

Neither API can record **what the recipient received**: Cloudflare adds `Received` and `DKIM-Signature`
in transit either way. The honest claim a manifest can make is therefore "these are the bytes Mailda
authored and submitted", never "this is what arrived — and §5C requires the product to say the former.

## `message.reply()` is not the reply API

It looks like exactly what Mailda needs — threaded, same SMTP session, preserves the `Message-ID`
chain — and it is unusable for the product's actual case, because it only exists **inside the
`email()` handler**, during inbound delivery. A human composing a reply an hour later cannot reach it.

Its constraints are recorded anyway, because they describe what Cloudflare considers a legitimate
reply and the outbound path will meet the same scrutiny: valid DMARC on the incoming message, one
reply per event, recipient must match the incoming sender, sending domain must match the receiving
domain, and rejection above **100 `References` entries**.

## The daily limit is deliberately invisible

> New accounts start with a conservative daily quota and scale up over time based on your sending
> behavior, deliverability rates, and account standing.

**No number is published, anywhere.** It is per-account, varies with reputation, and changes without
notice. `send.daily_limit_is_published: 0` records that as a fact rather than leaving a gap that reads
like an oversight.

This is precisely what `AGENTS.md` means by *a limit developers can hit is a limit they must see*, and
it cannot be resolved by reading. So Mailda **measures it**: sends are counted per rolling day in D1,
and the count at which a rate rejection first occurs is recorded. The operator's own limit becomes an
observed number with a date, which is the only form of it that can exist.

A **suppression list** also exists; sends it blocks are rejected at the API boundary and do not count
toward quota. A suppressed recipient means the message will never arrive, which is a distinct state
from a bounce and from an unknown outcome.

## Two derived numbers

`send.references_emitted_max = 20`. Cloudflare rejects a reply whose incoming message carries more
than **100** `References` entries, and ADR 27 stores only two threading anchors — so a reply's chain is
*reconstructed* at composition time rather than carried. Reconstruction must therefore be **bounded**,
not faithful: 20 entries keeps a Node an order of magnitude clear of the ceiling while preserving more
history than any client displays. Long threads lose their middle, which is what every other client
does too, and the root and the immediate parent — the two entries that decide threading — are always
kept.

`send.hold_window_default_seconds = 15`. **This one has no measurement behind it and that is
deliberate.** It is the undo-send window from ADR 39: a preference about human regret, not a limit or a
budget, and no measurement could settle it — which is exactly why it is configurable per mailbox,
including zero. Recorded here so a reader does not conclude the receipt rule was skipped. Fifteen
seconds is long enough to notice the most common regret (the wrong recipient) and short enough that
operational mail does not feel broken.

## Configuration is portable, if one field is avoided

`send_email: [{ "name": "EMAIL" }]` carries **no account-specific value**, so unlike Secrets Store
(ADR 28) it does not collide with ADR 24's byte-identical fork.

That holds only for the unrestricted form. `destination_address` and `allowed_destination_addresses`
take customer addresses, and `allowed_sender_addresses` takes customer domains — putting any of them
in committed configuration reintroduces exactly the problem ADR 28 had to solve. Restriction, where
Mailda wants it, belongs in the adapter and in D1, not in `wrangler.jsonc`.

`remote: true` on the binding lets local development call the real API, which is the only way to
exercise this path outside a deploy.
