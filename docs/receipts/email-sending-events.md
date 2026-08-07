---
id: email-sending-events
kind: platform-limit
measured_on: 2026-08-07
stale_when: >
  Queues event subscriptions leave beta; the email.sending event schema version moves past 1; the six
  event types change; payload.messageId's relationship to the value send() returns changes; or the
  cf-bounce subdomain becomes unlockable, which would make inbound DSNs a second and conflicting source
  of the same truth
values:
  events.schema_version: 1
  events.types_published: 6
  events.is_per_recipient: 1
  events.carries_terminal_flag: 1
  events.carries_bounce_type: 1
  events.subscription_scope_is_one_domain: 1
  events.routing_events_published: 0
  events.submit_id_matches_event_id: -1
---

**Read from Cloudflare's documentation on 7 August 2026**, not measured against a running Node. These are
the platform's stated behaviours and are **adapter data** per §11B. One number —
`events.submit_id_matches_event_id: -1` — is deliberately *unmeasured*, and the sign is the point: it is
the single fact Layer 2's bounce attribution rests on, and this receipt refuses to guess it.

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

The decisive property. A `message.bounced` event names **one** recipient:

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
| `message.delivered` | true | *"the recipient mail server accepts the message"* — a 250 from the receiving host | **accepted** |
| `message.bounced` | true | permanent failure, or temporary retries exhausted | **bounced** |
| `message.failed` | true | internal or non-SMTP delivery error | bounced (distinct reason) |
| `message.rejected` | true | refused before delivery was attempted | bounced (distinct reason) |
| `message.complained` | true | recipient marked it as spam | neither — a fact about reputation |
| `message.deferred` | **false** | temporary failure, retries still pending | still **outcome_unknown** |

**`message.delivered` earns a word, and this is a deliberate departure** from the reflex that §5C forbids
representing success. §5C forbids claiming an outcome *nobody observed*. Here somebody observed it: the
receiving mail server returned 250 and Cloudflare reports the code. That is exactly what "accepted"
means in mail, and it is a strictly stronger fact than `handed_over`, which only says Cloudflare took the
bytes. Withholding it would leave the ladder's `accepted` unrepresentable while the platform hands it
over — refusing to record an observation is as dishonest as inventing one.

What it must never be called is **delivered to a person**. Nothing in this payload knows whether a human
saw the message, and the UI wording has to keep that line: *the receiving server accepted it*, not
*they got it*.

`terminal` is the field that makes `outcome_unknown` honest rather than a shrug: a `deferred` event says
Cloudflare is still trying, so the outcome genuinely is not known yet, and the Node can say so with a
reason instead of silence.

## The join key is unmeasured, and everything rests on it

`payload.messageId` is documented as an opaque handle in every example — `0101018f7d0c4d9a-msg-bounced`.
`apps/node/worker/src/outbound/transport.ts` stores what `env.EMAIL.send()` returns as
`transport_message_id`, and [`cloudflare-email-sending.md`](./cloudflare-email-sending.md) measured that
value as RFC-5322-shaped: `<…@mailda-test.whymelabs.com>`.

**Those two shapes are not obviously the same value**, and if they are not, an event cannot be attributed
to a manifest by key. Hence `events.submit_id_matches_event_id: -1`, meaning *not yet measured* rather
than 0 or 1 — a receipt that guessed here would be the same failure as the one it was written to correct.

Measuring it requires a live event subscription and one real send to a `.invalid` address (RFC 2606
reserves the TLD, so it hard-bounces without involving a third party), then comparing the stored
`transport_message_id` against the arriving `payload.messageId`.

**If they do not match**, the only remaining correlation is `sender` + `recipient` + `subject` within a
time window. That is genuinely weaker — two sends to the same person with the same subject are
indistinguishable — and it must be recorded as a heuristic in the UI, not presented as a key. Deciding
that in advance is what stops a weak join from being quietly described as a strong one.

## What a Node needs before any of this works

- **A queue and an event subscription**, scoped to *one* sending domain — the apex or one verified
  sending subdomain. A Node sending from several subdomains needs several subscriptions.
- **A `queue()` consumer**, which is a `queues.consumers` block in `wrangler.jsonc`. Deploying a consumer
  for a queue that does not exist fails the deploy, so it cannot be committed unconditionally without
  breaking Layer 0's one-click install — see the note in `deploy-button-install.md` about
  `test/node/deployability.test.ts` asserting the install can satisfy every declared binding.
- **Idempotency**, because Queues delivers at least once. `payload.eventId` is the natural key, and the
  consumer example in Cloudflare's own docs uses it in exactly that role.
- **Something to say when events are missing.** Retention and backfill for event subscriptions are
  undocumented. A Node that silently shows no bounces after a consumer outage is indistinguishable from
  one where nothing bounced, which is the ambiguity Layer 2 exists to remove — so the absence has to be
  stated rather than left as silence.

**Email Routing events are not published on this source.** Inbound forwards, replies and Worker-emitted
routing events produce nothing here; this channel is outbound only.
