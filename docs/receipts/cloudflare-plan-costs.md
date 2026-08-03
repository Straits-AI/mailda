---
id: cloudflare-plan-costs
kind: platform-limit
measured_on: 2026-08-03
stale_when: >
  Cloudflare changes Workers Paid base pricing, Email Sending plan availability, the
  included email quota, or Queues free-tier retention configurability
values:
  plan.paid.monthly_usd_minimum: 5
  plan.paid.emails_included_per_month: 3000
  plan.free.queue_operations_per_day: 10000
  plan.free.queue_retention_seconds: 86400
  plan.free.d1_max_database_bytes: 524288000
  plan.free.d1_rows_read_per_day: 5000000
  plan.free.d1_rows_written_per_day: 100000
  plan.free.build_minutes_per_month: 3000
  plan.paid.build_minutes_per_month: 6000
---

**Measured:** read from published Cloudflare pricing on 3 August 2026.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) ·
[Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/) ·
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) ·
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) ·
[Workers Builds limits and pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)

## The headline: a free-plan Node cannot send to arbitrary recipients

> **Outbound emails (Email Sending)** — Workers Free: **Not available**. Workers Paid: 3,000 included per month, then $0.35 per 1,000 emails.
>
> Sending to arbitrary recipients requires the Workers Paid plan.

Inbound is unlimited and free on both plans.

**Corrected by live test, same day** (receipt: `free-plan-node-capability.md`): *"Not
available"* means **arbitrary recipients** are unavailable, not that the send path is dead. A
free-plan Node sends successfully to addresses already **verified** in the account, and is
refused only for arbitrary ones. Reading the plan table alone would lead you to conclude
sending is impossible; it is not.

This corrects an over-correction. §11B was amended earlier the same day to withdraw the
`unavailable` outbound state and the "mark the Node receive-only" escape hatch, on the
grounds that Email Sending is no longer beta or entitlement-gated. That was half right:
it is no longer gated by *beta status*, but it is absolutely gated by **plan**. The
receive-only state is real and has been restored, correctly attributed.

## What a Node actually costs

**Workers Paid: $5/month minimum**, including Workers, Pages Functions, KV, Hyperdrive and
Durable Objects. Then:

| | Included | Overage |
|---|---|---|
| Outbound emails | 3,000/month | $0.35 per 1,000 |
| Requests | 10M/month | $0.30/million |
| CPU time | 30M ms/month | $0.02/million ms |
| Queue operations | 1M/month | $0.40/million |
| Inbound emails | unlimited | — |

A 20-person organization sending 10,000 emails a month: **$5 + $2.45 ≈ $7.45/month**, plus
D1 and R2 usage. §5A's onboarding checklist listed "a paid Workers plan" as a prerequisite
with cost unquantified; this is the quantity.

## Free-plan ceilings

| | Free |
|---|---|
| Email Sending | verified destinations only — see `free-plan-node-capability.md` |
| Email Routing (inbound) | unlimited |
| Queue operations | 10,000/day |
| **Queue retention** | **24 hours, non-configurable** |
| D1 per database | 500 MB |
| D1 rows read / written | 5M / 100k per day |
| Durable Objects | **SQLite backend only** |
| Build minutes | 3,000/month |

Two of these need care.

**Queue retention cannot be set on the free plan.** #9 established that every queue must
declare its retention explicitly, because the 24-hour default silently deletes unread
messages — a mail system's worst failure mode. On the free plan that is not possible: 24
hours is forced. A free-plan Node therefore has a hard 24-hour window for anything stuck in
a queue, and the product must say so rather than let it be discovered.

**Durable Objects are SQLite-only on free**, which is no constraint at all — Cloudflare's
own best practices recommend the SQLite backend, and #4's design assumes it.

## Workers Builds is not a cost consideration

3,000 build minutes/month free, 6,000 on Paid then $0.005/minute. A Mailda update builds
one Worker (ADR 18), so at a generous three minutes that is roughly **1,000 updates per
month inside the free allowance**. Build minutes will not be the constraint on ADR 24's
update channel.

Free plan allows 1 concurrent build, Paid allows 6; 20-minute timeout and 8 GB memory on
both.

## Withdrawn: the free plan as an evaluation tier (see ADR 25)

A free-plan Node receives real mail, stores it, indexes it, and shows it in the web UI. It
can even reply to **verified** addresses, so an evaluator can exercise a round trip to their
own inbox. It cannot reply to a customer. That is a genuine zero-cost evaluation path —
*your own real mail*, no commitment, and no fixtures to discount. Confirmed live:
`free-plan-node-capability.md`.

This looked like the answer `docs/onboarding-journey.md` was searching for, and was tested
live (`free-plan-node-capability.md`). **ADR 25 withdrew it.** The free plan's 24-hour
non-configurable queue retention means a stuck message is silently deleted, and §22 requires
explicit retention for exactly that reason — so a free Node can lose mail rather than merely
do less. Workers Paid is mandatory. The evaluation problem is therefore still open.

## Residual

- R2 storage and operation costs are not recorded here. Raw MIME and attachments live in
  R2 (§12) and are the largest storage line for a mail system, so this receipt is
  incomplete until they are.
- Not verified against a real invoice. These are published figures.
