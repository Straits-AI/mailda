---
id: queue-provisioning
kind: platform-limit
measured_on: 2026-08-07
stale_when: >
  automatic resource provisioning leaves beta; wrangler starts provisioning a queue named only by a
  consumer block; a consumers block becomes valid without a `queue` field; a producer binding stops
  validating without one; wrangler gains any way to interpolate the Worker name into a config value;
  `email.sending` appears in `wrangler queues subscription create --source`; or the
  Deploy button's setup page gains a field for event subscriptions
values:
  queues.producer_binding_provisions: 1
  queues.consumer_block_provisions: 0
  queues.consumer_attaches_when_producer_provisions: 1
  queues.producer_queue_name_omissible: 1
  queues.consumer_queue_name_required: 1
  queues.subscription_creatable_by_cli: 0
  queues.email_sending_subscription_is_dashboard_only: 0
  queues.subscription_creatable_by_api: 1
---

## Addition, 19 August 2026: a queue name is account-scoped, and this receipt never asked whether it had to be written down (#72)

Two new values, measured today, and a **narrowing** of one of the values above. No `stale_when` clause
fired — the conditions it names are all still false — but the world this receipt describes changed anyway,
which is worth recording as its own kind of miss: the receipt answered *"can the install create a queue"*
and never asked *"can two installs in one account create two"*.

They cannot, or could not. `wrangler.jsonc` named the queue as a constant, and a queue name is
**account-scoped**, so a second Node in an account that already had one failed its consumer registration
(`Queue 'mailda-sending-events' already has a consumer. [code: 11004]`) and — the serious half — had its
**producer binding attach to the existing queue**. Observed live during the probe: that queue's producer
count read **2**, and dropped back to 1 when the probe Worker was deleted. One Node's sending events were
therefore drained by another Node's consumer, across two separate D1 catalogs, with nothing looking wrong
on either Node. The full argument is in #72.

### The two new values, and how each was measured

Both by `wrangler deploy --dry-run` against a **scratch config**, wrangler 4.118.0, 19 August 2026. A
dry-run rather than a deploy on purpose: what was in question is what the *configuration parser and
binding table* accept, and that is settled without creating anything in anybody's account.

| value | method | result |
|:--|:--|:--|
| `queues.producer_queue_name_omissible: 1` | a producers entry carrying `binding` and no `queue` | validates and builds; the binding table printed `env.SENDING_EVENTS  Queue` **with no name** |
| `queues.consumer_queue_name_required: 1` | a consumers entry carrying batch settings and no `queue` | **refused at config parse**: `"queues.consumers[0]" should have a string "queue" field but got {"max_batch_size":25,…}` |

**The frontmatter `measured_on` deliberately stays 2026-08-07**, which is a limitation of the receipt
format and not an oversight: it carries one date per file and the generator has no per-value date, so
`BUDGET_ORIGINS["queues.producer_queue_name_omissible"].measuredOn` reads **older** than the measurement
actually is. Nothing enforces the table above against that field — it cannot, there is nowhere to put a
second date — and the direction of the error is the reason this is the acceptable half of the choice:
under-reporting freshness invites a re-measurement, while stamping today's date onto the 7 August values
would claim a verification of *those* numbers that nobody performed.

Also checked, and it closes the obvious third option: `--var` and `--define` substitute into the **script**,
not into config values. **There is no way to interpolate the Worker name into a queue name in
`wrangler.jsonc`.** So the choice was never "template the name" — it was between omitting the name and
creating the queue through the API, and omitting it keeps ADR 24's byte-identical fork intact.

`wrangler queues consumer worker add <queue-name> <script-name>` exists, with `remove` and `list` beside it.
That is what makes the out-of-band attachment a CLI step rather than a second hand-rolled API call.

### What `queues.consumer_attaches_when_producer_provisions: 1` does and does not cover

It stays **1** and it is **not widened**. It was measured on 7 August with a **named** queue — a producer
binding and a consumer block both carrying the same literal `mailda-qprov-both` — and it records that
provisioning ran before consumer registration in that configuration. It says nothing about the
omitted-name case, and it cannot: with the name omitted there is **no consumer block to attach**, because
the row above measures that such a block is refused outright. Reading it as "the consumer still attaches
when the name is derived" would be inventing a measurement, and the value would then look like evidence for
the very thing this change had to work around.

### So the section below headed "Declaring both makes one deploy sufficient" is now history, not instruction

Its measurement stands. Its conclusion — *"Mailda can ship bounce consumption in committed configuration
and both install paths still work"* — is **false as of today**, and deliberately so: it was true only for a
single Node per account. The consumer is now attached out of band by
`apps/node/worker/scripts/attach-queue-consumer.mjs`, which **discovers** the queue from the deployed
Worker's `SENDING_EVENTS` binding rather than deriving its name.

That the name is derived at all is **Cloudflare's documentation, not a measurement here**. The
configuration page says automatic provisioning covers Queues and that resources are created with the
Worker's name as a prefix; the **exact derived string is unmeasured**, and this repository has been wrong
twice this week trusting that page in the specific. So nothing in the codebase hardcodes or guesses it,
the script refuses rather than assumes when it finds zero or more than one candidate, and `doctor` reports
the capability instead of pretending to check it.

Two things that follow from "documented, not measured", and both are load-bearing enough to write down.
**Whether a producer binding with no queue name provisions anything at all** is also documented rather than
measured: `queues.producer_binding_provisions: 1` above was measured with a *named* queue, so a deploy that
creates no queue is a real outcome, which is why the script has a refusal for it rather than an assumption.
And the script's branches — discovery, the idempotent re-run, the foreign consumer, an unreadable consumer
list, an ambiguous gradual deployment, and a deploy that provisioned nothing — are exercised on every test
run by `apps/node/worker/test/node/attach-queue-consumer.test.ts`, which puts a stub `npx` on `PATH`
speaking wrangler's documented JSON shapes. That tests the script against the shape; it does not measure
the shape, and it is not a run against an account.

**The accepted cost, stated rather than hidden:** a button-only install has run no such script, so it
observes **no delivery outcomes at all** until somebody runs it. That is not a new *class* of gap — the
`email.sending` subscription this receipt already covers is out of band for the same reason
(`queues.subscription_creatable_by_cli: 0`) — but it is now two steps rather than one, and doctor's
`sending_events_consumer` finding exists so that the first of them is visible rather than silent.

**Measured:** live Cloudflare account, Workers Paid, wrangler 4.118.0 (and 4.119.0 and `latest` for the
CLI-surface checks), 7 August 2026. Three throwaway Workers and three queues created and deleted; the
account was verified back to baseline.

This exists because Layer 2's bounce state depends on a queue, and the obvious question — *does the
one-click install still work if Mailda needs one?* — has an answer that is not guessable and is not what
the documentation implies.

## A producer binding provisions the queue. A consumer block fails the deploy.

The [configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/) lists
Queues among the resources automatic provisioning "currently works for". That is true of only one of the
two ways a Worker names a queue:

| Declared as | Result |
|:--|:--|
| `queues.producers: [{ queue, binding }]` | **Provisioned.** `Provisioning EVENTS (Queue)... 🌀 Creating new Queue` |
| `queues.consumers: [{ queue }]` | **Deploy fails.** `Queue "…" does not exist. To create it, run: wrangler queues create …` |

A consumer is not a binding — it is a subscription of the Worker to a queue — so provisioning never
considers it. Nothing in the documentation says so, and the failure is a hard error rather than a
warning, which means **committing a bare `queues.consumers` block would break every one-click install**
and the first person to find out would be a customer.

## Declaring both makes one deploy sufficient

The useful result. With a producer binding *and* a consumer block for the same queue, a single
`wrangler deploy` against an account where the queue does not exist:

```
The following bindings need to be provisioned:
env.EVENTS         Queue
🌀 Creating new Queue "mailda-qprov-both"...
✨ EVENTS provisioned 🎉
Deployed mailda-qprov-probe triggers
  Consumer for mailda-qprov-both
```

The producer provisions it, then the consumer attaches to it, in that order, unprompted. **So Mailda can
ship bounce consumption in committed configuration and both install paths still work.**

It should be recorded honestly: the producer binding is there as a *provisioning lever*, not because the
Worker has anything to publish. That is a workaround for an asymmetry in somebody else's tool, and it
will read as unexplained clutter to the next person unless the config says so. The alternative — leaving
the consumer out of committed config and having `mailda deploy` add it — costs a divergence between the
CLI and button paths, which is exactly what ADR 18 collapsed to one Worker to avoid.

## The subscription: not in the CLI, but not out of reach either

`email.sending` is **absent from `wrangler queues subscription create --source`** in every version
checked — 4.118.0, 4.119.0 and `latest`. The available sources are `artifacts`, `artifacts.repo`,
`images`, `kv`, `r2`, `superSlurper`, `vectorize`, `workersAi.model`, `workersBuilds.worker`,
`workflows.workflow`.

Cloudflare's own guide for this exact use case
([Sync recipient records](https://developers.cloudflare.com/email-service/examples/email-sending/sync-recipient-records/))
gives dashboard steps and no CLI equivalent: *"In the Cloudflare dashboard, go to the Queues page… select
Subscriptions > Subscribe to events… select Email Sending as the source."*

That is where this receipt originally stopped, concluding the subscription was **dashboard-only**. That
conclusion was wrong, and the correction matters more than the original finding.

**The REST API accepts `email.sending`.** wrangler's `--source` list is stale *client-side* validation,
not a platform limit. Discovered by asking wrangler to create a supported subscription under
`WRANGLER_LOG=debug`, reading the endpoint out of its own request log, then reading back the stored
object to learn the schema:

```
POST /accounts/{account_id}/event_subscriptions/subscriptions
{
  "name": "…", "enabled": true,
  "source":      { "type": "email.sending", "zone_id": "…", "domain": "send.example.com" },
  "destination": { "type": "queues.queue", "queue_id": "…" },
  "events":      ["message.delivered", "message.deferred", "message.bounced",
                  "message.failed", "message.rejected", "message.complained"]
}
```

`source.zone_id` is snake_case — `zoneId`, the spelling the *event payload* uses, is rejected with
`Validation error: Required at "source.zone_id"`. Editing an existing subscription is `PATCH`; `PUT`
returns `7001 PUT not supported for requested URI`.

This was worth chasing rather than accepting, because the dashboard route is **also broken**: clicking
*Subscribe to events* on 7 August 2026 produced `Refresh the page to try again` with
`useModalContext must be used within a ModalContext` in the console — a React error, so the modal cannot
mount at all. Had the CLI gap been taken at face value, the conclusion would have been that bounce
visibility is unobtainable, when in fact it is fully automatable.

**So `mailda deploy` can provision it end to end**, and one-click install needs no manual step for
bounces. What it cannot use is wrangler's subcommand.

## What that means for the product, stated rather than implied

One-click install is *not* broken by this, and it is worth being precise about which of three things is
which, because they are easy to conflate:

1. **Deploying the Node** — Worker, D1, R2, Durable Objects, and now a queue: one click, no manual step
   (`deploy-button-install.md`, and the measurement above).
2. **Mail setup** — DNS and MX, Email Routing onboarding, sending-domain verification, destination
   address confirmation. **Always** an operator step, and not a Mailda limitation: these change DNS and
   require somebody's consent. No installer can or should do them silently.
3. **Bounce visibility** — the event subscription. **Automatable**, via the API above, so `mailda deploy`
   can do it without an operator. Not via wrangler's subcommand, and not via the dashboard while that
   modal is broken.

Item 3 still needs its absence to be **visible**, and that is not a hedge about provisioning — it is
because a subscription can be deleted, disabled, or scoped to the wrong domain long after install. A Node
receiving no events is indistinguishable from one where nothing bounced, which is precisely the ambiguity
Layer 2 exists to remove. So the capability is recorded (§14's "can this Node send" is a capability answer
rather than a crash — the same shape applies) and `doctor` says it is missing rather than letting a Node
look complete.

## Third documentation-versus-reality gap in two days

Recorded because the pattern now has three instances and is worth naming: the button's R2 provisioning
(`r2-auto-provisioning.md`), the `cf-bounce` bounce channel
(`cloudflare-email-sending.md`, corrected), and consumer-block provisioning here. In each case the
documentation was directionally right and wrong in the specific, and only a deploy against a real account
settled it. Platform limits are adapter data (§11B); this corpus should keep treating them as measured
rather than read.
