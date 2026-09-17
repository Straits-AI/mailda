---
id: email-sending-events
kind: platform-limit
measured_on: 2026-08-07
stale_when: >
  Queues event subscriptions leave beta; the email.sending event schema version moves past 1; the six
  event types change; payload.messageId's relationship to the value send() returns changes; or the
  cf-bounce subdomain becomes unlockable, which would make inbound DSNs a second and conflicting source
  of the same truth; or the create-subscription endpoint stops accepting an email.sending source, or
  wrangler starts offering one
values:
  events.schema_version: 1
  events.types_published: 6
  events.is_per_recipient: 1
  events.carries_terminal_flag: 1
  events.carries_bounce_type: 1
  events.subscription_scope_is_one_domain: 1
  events.routing_events_published: 0
  events.submit_id_matches_event_id: 1
  events.bounce_event_seconds_observed: 60
  events.delivery_silence_minutes: 15
  events.subscription_creatable_by_api: 1
  events.subscription_creatable_by_wrangler: 0
---

**Read from Cloudflare's documentation on 7 August 2026, and the load-bearing part then measured against
the deployed Node the same day.** Platform behaviours here are **adapter data** per §11B.

The one fact Layer 2's bounce attribution rests on, whether an event can be joined to a manifest by key,
was carried as `events.submit_id_matches_event_id: -1`, meaning *not yet measured*, rather than guessed at
0 or 1. It is now **1**, established by a real bounce; see "The join key is real" below. The negative
sentinel is kept in this history deliberately: it is what stopped the schema being designed around an
assumption.

Sources, each read directly:

- [Event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)
- [Events schemas](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/)
- [Sync recipient records](https://developers.cloudflare.com/email-service/examples/email-sending/sync-recipient-records/)
- [Changelog, 15 July 2026](https://developers.cloudflare.com/changelog/post/2026-07-15-event-subscriptions/)

## Why this receipt exists

[`cloudflare-email-sending.md`](./cloudflare-email-sending.md) asserted that a bounce arrives as inbound
mail to `cf-bounce.<subdomain>`. That is corrected there: the `cf-bounce` MX points at Cloudflare and its
records are service-managed for the lifetime of the domain, so **a Node cannot receive its own bounces**.

This is the channel that does exist, and it is better than the one that does not.

## One event per recipient, which changes the design rather than merely enabling it

The decisive property. A `message.bounced` event names **one** recipient. This is Cloudflare's own
documented example, kept as published; note that its `messageId` is *not* the shape a real event carries
(measured below) and its `source` uses `zoneId` where the creation API requires `zone_id`:

```json
{
  "type": "cf.email.sending.message.bounced",
  "source": { "type": "email.sending", "zoneId": "…", "domain": "send.example.com" },
  "payload": {
    "eventId": "0190d0c4-7ea1-7af2-8b88-c1d2e3f4a5b6",
    "messageId": "0101018f7d0c4d9a-msg-bounced",
    "sender": "receipts@send.example.com",
    "recipient": "user@example.net",
    "subject": "Your receipt",
    "terminal": true,
    "delivery": { "status": "bounced", "smtpStatusCode": "550",
                  "smtpEnhancedStatusCode": "5.1.1", "smtpResponse": "550 5.1.1 User unknown" },
    "bounce": { "type": "hard", "classification": "permanent_failure", "reason": "550 5.1.1 User unknown" }
  },
  "metadata": { "eventSubscriptionId": "…", "eventSchemaVersion": 1, "eventTimestamp": "…" }
}
```

Because Cloudflare attributes the outcome to a recipient itself, **per-recipient state does not require
per-recipient submission.** That retires the expensive design: one `send()` per manifest stays, so the
manifest id stays the effect key (ADR 9), `submitted_key` stays one evidence pair (§12), the Bcc
header/envelope asymmetry stays intact, `send_counters.handed_over` keeps its unit, and the existing
conditional-UPDATE claim stays the only lock. Splitting submission would have broken all five to obtain
something the platform already provides.

## The six event types, and how they map onto the ladder

Layer 2's proof is *"`accepted` / `bounced` / `outcome_unknown` distinguished, never blurred"*.

| Event | `terminal` | What it observes | Layer 2 word |
|:--|:--|:--|:--|
| `message.delivered` | true | *"the recipient mail server accepts the message"*, a 250 from the receiving host | **accepted** |
| `message.bounced` | true | permanent failure, or temporary retries exhausted | **bounced** |
| `message.failed` | true | internal or non-SMTP delivery error | bounced (distinct reason) |
| `message.rejected` | true | refused before delivery was attempted | bounced (distinct reason) |
| `message.complained` | true | recipient marked it as spam | neither; a fact about reputation |
| `message.deferred` | **false** | temporary failure, retries still pending | still **outcome_unknown** |

**`message.delivered` earns a word, and this is a deliberate departure** from the reflex that §5C forbids
representing success. §5C forbids claiming an outcome *nobody observed*. Here somebody observed it: the
receiving mail server returned 250 and Cloudflare reports the code. That is exactly what "accepted"
means in mail, and it is a strictly stronger fact than `handed_over`, which only says Cloudflare took the
bytes. Withholding it would leave the ladder's `accepted` unrepresentable while the platform hands it
over. Refusing to record an observation is as dishonest as inventing one.

What it must never be called is **delivered to a person**. Nothing in this payload knows whether a human
saw the message, and the UI wording has to keep that line: *the receiving server accepted it*, not
*they got it*.

`terminal` is the field that makes `outcome_unknown` honest rather than a shrug: a `deferred` event says
Cloudflare is still trying, so the outcome genuinely is not known yet, and the Node can say so with a
reason instead of silence.

## The join key is real, and it is byte-identical

Measured 7 August 2026 on the deployed Node with a live subscription, by sending to
`nobody@example.invalid` (RFC 2606 reserves the TLD, so it hard-bounces without involving anyone) and
comparing what `env.EMAIL.send()` returned against what arrived:

```
submit  transport_message_id : '<pIlEAeNiwq8Yqda1hdkDyqtTdfdzfrhVHHKb@mailda-test.whymelabs.com>'
event   payload.messageId    : '<pIlEAeNiwq8Yqda1hdkDyqtTdfdzfrhVHHKb@mailda-test.whymelabs.com>'
                    identical: yes, angle brackets included
```

**Not** the opaque `0101018f7d0c4d9a-msg-bounced` shape every documented example shows. That appears to
be illustrative rather than the format in use. Compare with and without the angle brackets: the match is
exact *with* them, so a join must not strip them.

So bounce attribution is a **key**, and the weaker fallback (`sender` + `recipient` + `subject` within a
time window, which cannot tell two identical-subject sends apart) is not needed. Recorded because the
design was prepared to accept the weak version, and the strong one is what shipped.

The full bounce event, verbatim:

```json
{
  "type": "cf.email.sending.message.bounced",
  "payload": {
    "eventId": "019fdc6a-d796-7e20-aba0-629ecb45f100",
    "messageId": "<pIlEAeNiwq8Yqda1hdkDyqtTdfdzfrhVHHKb@mailda-test.whymelabs.com>",
    "sender": "inbox@mailda-test.whymelabs.com",
    "recipient": "nobody@example.invalid",
    "subject": "Mailda bounce probe 3",
    "terminal": true,
    "delivery": { "status": "bounced",
      "smtpResponse": "Permanent: no available upstream: unknown public suffix: example.invalid" },
    "bounce": { "type": "hard", "classification": "permanent_failure",
      "reason": "Permanent: no available upstream: unknown public suffix: example.invalid" }
  }
}
```

Two details worth keeping. `delivery` carried **no** `smtpStatusCode` or `smtpEnhancedStatusCode`. The
failure never reached SMTP, so a consumer must treat those as optional rather than assume the documented
shape. And the event arrived **about 60 seconds** after hand-over, so a UI cannot expect a synchronous
answer; `outcome_unknown` is the true state in between, which is exactly why it exists.

## How long silence has to last before it means something

`events.delivery_silence_minutes: 15`, used by `doctor`'s `delivery_visibility` check.

Derived from the 60 seconds measured above, not chosen: **15x** the one observed arrival. The asymmetry
justifies the generosity. Being wrong short means telling an operator their delivery channel is broken
while an answer is still in flight, a false alarm, and a check that cries wolf gets muted, after which it
guards nothing. Being wrong long means a blind Node goes unreported for a quarter of an hour,
which costs an operator fifteen minutes of not knowing something they were not looking at anyway.

One measurement is thin evidence for a distribution, and this number should tighten once there are more.
A `deferred` event in particular can precede a terminal one by much longer than a minute, since Cloudflare
retries temporary failures, so the window bounds *"heard nothing at all"* rather than *"reached a final
answer"*, which is why the check tests for zero events rather than for unresolved ones.

## A first subscription that observed nothing, and why

The first attempt subscribed to `message.bounced` and `message.delivered` only, and saw nothing at all,
which momentarily looked like the channel not working. It was the subscription being too narrow: a
non-resolving domain is not an SMTP rejection, so `message.failed` looked like the likely type. Widening
to all six produced a `message.bounced` after all.

The lesson is for the product, not just the probe: **subscribe to all six events, always.** A narrow
subscription is indistinguishable from a broken one, and a Node that silently observes nothing is the
ambiguity Layer 2 exists to remove.

## What a Node needs before any of this works

- **A queue and an event subscription**, scoped to *one* sending domain, the apex or one verified
  sending subdomain. A Node sending from several subdomains needs several subscriptions.
- **A `queue()` consumer.** This said "which is a `queues.consumers` block in `wrangler.jsonc`", and as of
  19 August 2026 it is **not**: a queue name is account-scoped, so naming one in committed config made the
  second Node in an account bind its producer to the first Node's queue (#72, and
  `queue-provisioning.md`'s addition of that date). The producer binding now names no queue, the deploy
  derives one per Worker, and a consumers block cannot name a derived queue, so the consumer is attached
  out of band by `pnpm --filter @mailda/worker run queue:attach-consumer`. The older point still holds and
  is now moot for a different reason: deploying a consumer for a queue that does not exist fails the deploy,
  which is why a bare consumers block could never have been committed either.
- **Idempotency**, because Queues delivers at least once. `payload.eventId` is the natural key, and the
  consumer example in Cloudflare's own docs uses it in exactly that role.
- **Something to say when events are missing.** Retention and backfill for event subscriptions are
  undocumented. A Node that silently shows no bounces after a consumer outage is indistinguishable from
  one where nothing bounced, which is the ambiguity Layer 2 exists to remove, so the absence has to be
  stated rather than left as silence.

**Email Routing events are not published on this source.** Inbound forwards, replies and Worker-emitted
routing events produce nothing here; this channel is outbound only.

## The subscription can be created through the API, and the API says when it cannot

**Measured 16 September 2026**, against `Swmengappdev@gmail.com`'s account, with the operator's own
`wrangler` OAuth token. Until this measurement the doctor's `sending_events_consumer` finding said the
subscription could not be created at all, and `cloudflare-settings.md` carried it as one of the two rows a
person must do by hand, both resting on `wrangler queues subscription create --source` not offering
`email.sending` and the create-subscription schema not documenting the `source` shape the account's existing
subscription carries (`cloudflare-grant.md`, *The subscription is in no menu, and exists*).

`POST /accounts/{id}/event_subscriptions/subscriptions` with that undocumented shape, copied from the
listing rather than guessed:

```
{ "name": "…", "enabled": true,
  "source": { "type": "email.sending", "zone_id": "<zone>", "domain": "<sending domain>" },
  "destination": { "type": "queues.queue", "queue_id": "<queue>" },
  "events": ["message.delivered", "message.deferred", "message.bounced",
             "message.failed", "message.rejected", "message.complained"] }
```

Two calls, in this order:

| domain | state at the time | answer |
|:--|:--|:--|
| `mailda.site` | zone in the account, **not** onboarded for sending | `400`, `"domain is not an enabled sending subdomain"` |
| `mailda.site` | onboarded through the Node (`mailda provider --onboard-sending`) one minute later | `200`, subscription `336c8b5e…`, listed back with `source.name: "Email Service"` filled in |

So the endpoint understands the source, validates the domain against Email Sending's own state, and refuses
with a sentence rather than an unknown-type error. **`events.subscription_creatable_by_api = 1`**, and the
refusal is the shape a Node can act on: onboard first, subscribe second, and the second cannot succeed
before the first. `events.subscription_creatable_by_wrangler` stays **0** (re-measured the same day, wrangler
4.118.0 still lists no such source), which is why the settings table names the API path and not a command.

**Measured the same afternoon, through the Node's own grant** (#222 built, deployed as version `22d44c2b`):
the `POST` with a grant holding `queues.read`, and every other scope the ceremony asked for, answered
`10000 Authentication error`. So the read scope that lists subscriptions does not create one, and the
ceremony now asks for `queues.write` instead.

**And `queues.write` is enough**, measured 16 September 2026, 12:50 UTC, after a re-consent. The
re-consent itself cost one more measurement: the client had never been registered with
`zone-settings.write`, `dns.write` or `queues.write`, so the first attempt answered *"The OAuth 2.0 Client
is not allowed to request scope 'zone-settings.write'"*, `invalid_scope`, the same refusal
`cloudflare-oauth-endpoints.md` recorded for `offline_access`. Adding the three to the client in the
dashboard and consenting again granted all eight, which also confirms `zone-settings.write` and `dns.write`
are real ids. `mailda provider --subscribe mailda.site --confirm <digest>` through the Node's own grant then
created subscription `mailda-sending-events-mailda.site`, and `--delivery-events` reads it back. The row
in `cloudflare-settings.md` is closed: the Node creates the subscription, and a button-only install can
observe its delivery outcomes without a dashboard.

**Was not measured before that:** which OAuth scope authorises the `POST`. This run used the operator's token, which holds
every scope. The Node's grant holds `queues.read`, which `cloudflare-grant-reach.md` established is enough
to *list*; whether `queues.write` is enough to create, or whether it needs something Email Service owns as
the sending endpoints turned out to, is one probe with a re-consent in front of it, and it is what building
`POST /api/provider/delivery-events` waits on.

The subscription created for the second row was kept: `mailda.site` is onboarded for sending now, and a
sending domain with no subscription is exactly the blind state `delivery_visibility` exists to name.

