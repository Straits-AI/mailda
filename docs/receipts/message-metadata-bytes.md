---
id: message-metadata-bytes
kind: measured-tripwire
measured_on: 2026-08-03
re_measured_on: 2026-08-04
stale_when: >
  the messages or mailbox_items schema changes, an index is added or removed, the
  identifier scheme changes width (#6), or D1's per-database ceiling moves from 10 GB
values:
  message.metadata.bytes_per_message: 1505
  message.metadata.bytes_per_extra_delivery: 457
  shard.plan_warn_messages: 5996643
  shard.plan_stop_messages: 7281638
  shard.plan_route_messages: 7709970
---

**Measured:** against **real remote D1**, not miniflare. A scratch database in a live
Cloudflare account on the **Workers Free** plan, seeded through
`wrangler d1 execute --remote`, with size read from `wrangler d1 info --json`. The database
was deleted after measurement.

Plan does not affect the figure: SQLite page accounting for identical rows and indexes is
the same on either plan, and the free-plan 500 MB per-database ceiling was never approached
(6 MB used). Plan affects *limits*, not storage efficiency. Recorded because a receipt that
does not say where it was measured cannot be disputed.

Local measurement was attempted first and is not possible: D1 rejects `PRAGMA page_count`
with `SQLITE_AUTH`, so page accounting is unavailable from inside a Worker. Remote
`database_size` is the only honest source.

## Method

Marginal cost, not total — two identical batches of 2,000 messages, measuring the delta
between them, so schema and index overhead cancel out rather than being amortised into
the per-message figure.

### Re-measured 4 August 2026, after #27 added threading

The schema-drift guard in `test/schema-drift.test.ts` **fired**, which is what it is for: migration
0006 added `in_reply_to`, `thread_root_rfc_id` and `parse_error`, plus the `msg_by_root` and
`msg_by_rfc_id` indexes. The figure below is the re-measurement; the original is kept underneath it
because the *change* is the interesting part.

| Stage | `database_size` |
|---|---:|
| Empty database | 12,288 |
| Schema only (2 tables, **7** indexes) | 53,248 |
| + 2,000 messages, 1 delivery each | 3,031,040 |
| + 2,000 more messages | 6,041,600 |
| + 2,000 extra deliveries only | 6,955,008 |

- **Marginal per message (with one delivery): (6,041,600 − 3,031,040) / 2,000 = 1,505.3 bytes**
- **Marginal per extra delivery: (6,955,008 − 6,041,600) / 2,000 = 456.7 bytes**

**+252 bytes per message, a 20% increase**, for two threading anchors and a parse-error column. Most
of it is the two new indexes rather than the columns: `msg_by_root` and `msg_by_rfc_id` both carry a
full RFC message-id as their key, and those are long, high-cardinality strings.

That is the cost of being able to thread a conversation, and it is worth paying — but it is also the
reason the **full `References` chain is not stored**. Had it been, this figure would grow with thread
depth rather than being constant, and §11B's arithmetic below would stop being arithmetic.

Extra deliveries got marginally *cheaper* (467 → 457), which is noise in page packing rather than a
real change; `mailbox_items` was not modified.

### Original measurement, 3 August 2026 (schema before threading)

| Stage | `database_size` |
|---|---:|
| Empty database | 12,288 |
| Schema only (2 tables, 5 indexes) | 45,056 |
| + 2,000 messages, 1 delivery each | 2,555,904 |
| + 2,000 more messages | 5,062,656 |
| + 2,000 extra deliveries only | 5,996,544 |

- Marginal per message: 1,253.4 bytes
- Marginal per extra delivery: 466.9 bytes

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
| Shard capacity | 10,737,418,240 | 7,133,171 |
| 70% — warn and plan the next shard | 7,516,192,768 | **4,993,219** |
| 85% — stop optional bulky projections | 9,126,805,504 | **6,063,194** |
| 90% — route new metadata to a new shard | 9,663,676,416 | **6,419,853** |

**A single shard holds roughly 7.1 million messages** — down from 8.5 million before
threading. For most organisations that is still years of mail, which remains the useful
thing to know: sharding is not a day-one problem, and the planner should say so rather than
implying it is imminent. But the direction matters. **Two indexes cost 1.4 million messages
of headroom**, so the next projection added to this table is not free either, and §11B's
"stop optional bulky projections at 85%" now has a concrete meaning.

Against the **1 TB account-level ceiling** that #5 found missing from §11B — the one
sharding cannot relieve — a Node tops out near **730 million messages** across all shards
combined, down from 877 million. That is the boundary where §11B's advice to select the
PostgreSQL `ControlStoreAdapter` actually applies.

## Note on fan-out

A message delivered to five mailboxes costs 1,505 + 4 × 457 = **3,333 bytes**, not 7,525.
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
