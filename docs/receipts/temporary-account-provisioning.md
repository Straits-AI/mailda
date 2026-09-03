---
id: temporary-account-provisioning
kind: platform-limit
measured_on: 2026-09-03
stale_when: >
  Cloudflare adds R2, Workflows or Email Sending to the products a temporary preview account supports;
  temporary accounts stop being created on the Workers Free plan, which ADR 25 requires to be Paid; the
  60-minute claim window changes; `wrangler deploy --temporary` begins validating bindings before creating
  an account rather than failing part way through provisioning; or this Node stops declaring an `r2_buckets`
  binding, which is the binding the refusal below lands on
values:
  temporary.supports_mailda_node: 0
  temporary.claim_window_minutes: 60
  temporary.bindings_provisioned_before_refusal: 1
---

# A temporary Cloudflare account cannot host a Mailda Node

Issue [#108](https://github.com/Straits-AI/mailda/issues/108) charts an onboarding path in which Mailda
provisions an account for a customer who has none, deploys into it, and hands over a claim URL. This is the
measurement of whether that path exists for **this** product. It does not.

Run against this repository's own `wrangler.jsonc`, unauthenticated, with wrangler's configuration directory
redirected to a temporary path so the operator's own session was untouched.

## What happened, in order

```text
Continuing means you accept Cloudflare's Terms of Service and Privacy Policy.
Solving proof-of-work challenge…
Temporary account ready:
        Account:      Rectangular Clipper (created)
        Claim within: 60 minutes
        Claim URL:    https://dash.cloudflare.com/claim-preview?claimToken=…

The following bindings need to be provisioned:
  env.SENDING_EVENTS   Queue
  env.CATALOG          D1 Database
  env.EVIDENCE         R2 Bucket

Provisioning CATALOG (D1 Database)...
✨ CATALOG provisioned 🎉
✘ [ERROR] A request to the Cloudflare API (/accounts/…/r2/buckets) failed.
  Authentication error [code: 10000]
```

Exit 1. **The account was created and one binding was provisioned before the refusal.**

## Three things this measurement establishes that the product list does not

Cloudflare documents the supported products as *"Workers, Workers Static Assets, Workers KV, D1, Durable
Objects, Hyperdrive, Queues, and SSL/TLS certificates"*. Reading that list tells you R2 is absent. Running it
tells you three further things, and each changes how an implementation would go wrong.

**1. The refusal is an authentication error, not a capability error.** `Authentication error [code: 10000]`
is what a wrong token looks like. Nothing in the message says *"temporary accounts do not support R2"*, so an
implementer reads it as a credential problem and goes looking for a scope to add. There is no scope to add.

**2. It fails part way through, and the failure is not idempotent.** D1 was created first. Wrangler caches and
reuses the temporary account while its credentials hold, and auto-provisioning
[never adopts an existing resource](./deploy-drill-live-account.md) — so the **second** attempt fails
differently:

```text
✘ [ERROR] You have reached the maximum number of D1 databases for your account.
  On the Workers Free plan? Upgrade to create more:
```

Attempt one blames authentication on R2. Attempt two blames a plan limit on D1 and offers an upgrade link.
Neither names the actual cause, and the second is actively misleading — it points at billing for a problem
that is a product-support gap.

**3. The account is on the Workers Free plan**, which attempt two's message states outright. ADR 25 requires
Workers Paid. So even if R2, Workflows and Email Sending were added to the supported list tomorrow, a
temporary account would still not satisfy this Node's own plan requirement.

## Which of this Node's bindings the path can serve

`wrangler.jsonc` declares six binding kinds. Three are unsupported, and the deploy only got as far as
naming the first three because it refused before reaching the rest.

| binding | temporary account |
|:--|:--|
| `d1_databases` | supported — provisioned in this run |
| `durable_objects` | supported per the product list; not reached |
| `queues` | supported per the product list; not reached |
| `r2_buckets` | **refused, measured** |
| `workflows` | absent from the product list; not reached |
| `send_email` | absent from the product list; not reached |

`EVIDENCE` is not optional: it is where every message body lives. There is no reduced Node that fits, and no
useful preview of one either — without `send_email` and Email Routing a preview could neither receive nor
send mail, which is the whole product.

## The claim window collides with ADR 28, and that survives any product-list change

*"If the user does not complete the claim, Cloudflare deletes the account and its resources."* Sixty minutes.

ADR 28 puts both root keys in Durable Object storage, generated on first use, and
[#92's drill measured](./deploy-drill-live-account.md) that Durable Object storage is not carried by a D1
export — which is why ADR 29's escrow exists at all. ADR 29's ten recovery codes are shown when the **Node**
is claimed.

So a Node claimed inside a temporary account that then expires unclaimed leaves the customer holding **ten
recovery codes for a vault that no longer exists**: the escrow's premise inverted, silently, and discovered
only by somebody attempting to recover. Two claims in two systems need an enforced order, and nothing
enforces one.

## What was handled for us, and what a REST orchestrator would owe

Two costs are invisible when wrangler does it and land on any backend that does not:

- **Terms acceptance is implicit in continuing.** *"Continuing means you accept Cloudflare's Terms of Service
  and Privacy Policy."* A platform accepting Cloudflare's terms on a customer's behalf is a legal question,
  not an integration detail, and #108 already requires that acceptance be recorded *"only where Cloudflare
  permits an orchestrator to do so"*.
- **A proof-of-work challenge is solved before an account is created.** Wrangler does it; the documentation
  states a REST integration must submit a solution itself.

And the claim URL is a **bearer credential** — anyone holding it can claim the account. This run's URL and the
temporary API token were written to disk by wrangler and deleted immediately afterwards; neither belongs in a
log, an analytics event or a support transcript.

## What this does not establish

**Nothing about the `existing_oauth` path**, which is the one #108 calls first to ship and which this
measurement leaves untouched.

**Nothing about a Worker that does not need R2.** This is a measurement about *this* Node's bindings, not a
general claim about the temporary-account path, which works as documented for the products it lists.

The residue: one temporary account named *Rectangular Clipper* holding an empty D1, unclaimed, which
Cloudflare deletes within the hour.
