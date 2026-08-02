---
id: message-metadata-bytes
kind: measured-tripwire
measured_on: 2026-08-03
stale_when: >
  the messages or mailbox_items schema changes, an index is added or removed, the
  identifier scheme changes width (#6), or D1's per-database ceiling moves from 10 GB
values:
  message.metadata.bytes_per_message: 1253
  message.metadata.bytes_per_extra_delivery: 467
  shard.plan_warn_messages: 5996643
  shard.plan_stop_messages: 7281638
  shard.plan_route_messages: 7709970
---

**Measured:** against **real remote D1**, not miniflare. A scratch database in a live
Cloudflare account, seeded through `wrangler d1 execute --remote`, with size read from
`wrangler d1 info --json`. The database was deleted after measurement.

Local measurement was attempted first and is not possible: D1 rejects `PRAGMA page_count`
with `SQLITE_AUTH`, so page accounting is unavailable from inside a Worker. Remote
`database_size` is the only honest source.

## Method

Marginal cost, not total — two identical batches of 2,000 messages, measuring the delta
between them, so schema and index overhead cancel out rather than being amortised into
the per-message figure.

| Stage | `database_size` |
|---|---:|
| Empty database | 12,288 |
| Schema only (2 tables, 5 indexes) | 45,056 |
| + 2,000 messages, 1 delivery each | 2,555,904 |
| + 2,000 more messages | 5,062,656 |
| + 2,000 extra deliveries only | 5,996,544 |

- **Marginal per message (with one delivery): (5,062,656 − 2,555,904) / 2,000 = 1,253.4 bytes**
- **Marginal per extra delivery: (5,996,544 − 5,062,656) / 2,000 = 466.9 bytes**

One "message" here is one `messages` row plus one `mailbox_items` row plus every index
entry both create. An extra delivery is one further `mailbox_items` row and its index
entries — the shared-mailbox case, where one arriving message lands in several mailboxes.

## Corpus realism

Field widths dominate the cost, so placeholder data would have produced a fictional
number. The corpus used: 64-character hex SHA-256 digests, RFC Message-ID headers of
realistic length (`<CAJ123.xxxxxxxxxxxxxxxxxxxx@mail.example-supplier.com>`), a 70-character
real-world subject line, org-scoped R2 blob keys, ISO-8601 timestamps, and typed-prefix
ULIDs at their true 30-character width (#6). 20 mailboxes, quarterly time buckets.

## What this sizes

§11B specifies warn at 70%, stop bulky projections at 85%, and route new metadata
elsewhere at 90% — three numbers that until now had no measurement behind them. Against
D1's 10 GB per-database ceiling (receipt: `d1-platform-limits`):

| Threshold | Bytes | Messages |
|---|---:|---:|
| Shard capacity | 10,737,418,240 | 8,566,633 |
| 70% — warn and plan the next shard | 7,516,192,768 | **5,996,643** |
| 85% — stop optional bulky projections | 9,126,805,504 | **7,281,638** |
| 90% — route new metadata to a new shard | 9,663,676,416 | **7,709,970** |

**A single shard holds roughly 8.5 million messages.** For most organisations that is
years of mail, which is the useful thing to know: sharding is not a day-one problem, and
the planner should say so rather than implying it is imminent.

Against the **1 TB account-level ceiling** that #5 found missing from §11B — the one
sharding cannot relieve — a Node tops out near **877 million messages** across all shards
combined. That is the boundary where §11B's advice to select the PostgreSQL
`ControlStoreAdapter` actually applies.

## Note on fan-out

A message delivered to five mailboxes costs 1,253 + 4 × 467 = **3,121 bytes**, not 6,265.
The `messages` row is written once and shared; only `mailbox_items` multiplies. Shared and
role mailboxes are therefore much cheaper than a naive per-delivery estimate suggests,
which matters because §9's shared-inbox model makes multi-delivery the normal case for
operational mail rather than an edge case.

## Caveats

- Raw MIME and attachments are **not** included and never live in D1 (§12). This measures
  metadata only. R2 storage is a separate and far larger cost.
- Search projections are not included. §7 keeps subject and body tokens plaintext in the
  default profile, and an FTS index over them will add materially to per-message cost.
  That belongs in its own receipt when search is built.
- Measured with 20 mailboxes and one org. Very high mailbox counts would change index
  cardinality and should be re-measured if a Node's shape differs sharply.
