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

## The headline: a free-plan Node cannot send mail

> **Outbound emails (Email Sending)** — Workers Free: **Not available**. Workers Paid: 3,000 included per month, then $0.35 per 1,000 emails.
>
> Sending to arbitrary recipients requires the Workers Paid plan.

Inbound is unlimited and free on both plans. So a free-plan Node **receives** mail and
cannot **send** it.

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
| Email Sending | **not available** |
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
two Workers, so at a generous three minutes each that is roughly **500 updates per month
inside the free allowance**. Build minutes will not be the constraint on ADR 24's update
channel.

Free plan allows 1 concurrent build, Paid allows 6; 20-minute timeout and 8 GB memory on
both.

## An unplanned consequence: the free plan is an evaluation tier

A free-plan Node receives real mail on a delegated subdomain, stores it, indexes it, and
shows it in the web UI. It simply cannot reply. That is a genuine zero-cost evaluation
path — *your own real mail*, one DNS record on a subdomain that carries nothing, no
commitment, and no fixtures to discount.

`docs/onboarding-journey.md` spent considerable effort looking for an evaluation path that
did not require betting live mail, and rejected Provider Connected as more setup than a
subdomain. This appears to be the answer, and it was sitting in the pricing table. It is
recorded as an observation rather than a decision; it deserves its own ticket.

## Residual

- R2 storage and operation costs are not recorded here. Raw MIME and attachments live in
  R2 (§12) and are the largest storage line for a mail system, so this receipt is
  incomplete until they are.
- Not verified against a real invoice. These are published figures.
