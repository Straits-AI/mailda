---
id: queue-provisioning
kind: platform-limit
measured_on: 2026-08-07
stale_when: >
  automatic resource provisioning leaves beta; wrangler starts provisioning a queue named only by a
  consumer block; `email.sending` appears in `wrangler queues subscription create --source`; or the
  Deploy button's setup page gains a field for event subscriptions
values:
  queues.producer_binding_provisions: 1
  queues.consumer_block_provisions: 0
  queues.consumer_attaches_when_producer_provisions: 1
  queues.subscription_creatable_by_cli: 0
  queues.email_sending_subscription_is_dashboard_only: 1
---

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

## What is genuinely NOT automatable: the subscription

`email.sending` is **absent from `wrangler queues subscription create --source`** in every version
checked — 4.118.0, 4.119.0 and `latest`. The available sources are `artifacts`, `artifacts.repo`,
`images`, `kv`, `r2`, `superSlurper`, `vectorize`, `workersAi.model`, `workersBuilds.worker`,
`workflows.workflow`.

Cloudflare's own guide for this exact use case
([Sync recipient records](https://developers.cloudflare.com/email-service/examples/email-sending/sync-recipient-records/))
gives dashboard steps and no CLI equivalent: *"In the Cloudflare dashboard, go to the Queues page… select
Subscriptions > Subscribe to events… select Email Sending as the source."*

So linking Email Sending events to a queue is a **dashboard-only action today**. Neither
`mailda deploy` nor the Deploy button can perform it.

## What that means for the product, stated rather than implied

One-click install is *not* broken by this, and it is worth being precise about which of three things is
which, because they are easy to conflate:

1. **Deploying the Node** — Worker, D1, R2, Durable Objects, and now a queue: one click, no manual step
   (`deploy-button-install.md`, and the measurement above).
2. **Mail setup** — DNS and MX, Email Routing onboarding, sending-domain verification, destination
   address confirmation. **Always** an operator step, and not a Mailda limitation: these change DNS and
   require somebody's consent. No installer can or should do them silently.
3. **Bounce visibility** — the event subscription. An operator step *today*, because of the CLI gap
   above, not because it needs consent.

Item 3 is the new one, and the only honest way to carry it is to make its absence **visible**: a Node
with no subscription receives no events, and no events is indistinguishable from nothing having bounced.
That ambiguity is precisely what Layer 2 exists to remove, so the capability has to be recorded (§14's
"can this Node send" is a capability answer rather than a crash — the same shape applies here) and
`doctor` has to say it is missing rather than let a Node look complete.

## Third documentation-versus-reality gap in two days

Recorded because the pattern now has three instances and is worth naming: the button's R2 provisioning
(`r2-auto-provisioning.md`), the `cf-bounce` bounce channel
(`cloudflare-email-sending.md`, corrected), and consumer-block provisioning here. In each case the
documentation was directionally right and wrong in the specific, and only a deploy against a real account
settled it. Platform limits are adapter data (§11B); this corpus should keep treating them as measured
rather than read.
