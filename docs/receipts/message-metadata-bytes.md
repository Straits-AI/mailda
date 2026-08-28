---
id: message-metadata-bytes
kind: measured-tripwire
measured_on: 2026-08-03
re_measured_on: 2026-08-29
stale_when: >
  the messages or mailbox_items schema changes, an index is added or removed, the
  identifier scheme changes width (#6), the `values:` block stops being derived from the most recent
  measurement in this file, or D1's per-database ceiling moves from 10 GB
values:
  message.metadata.bytes_per_message: 1649
  message.metadata.bytes_per_extra_delivery: 410
  shard.plan_warn_messages: 4558030
  shard.plan_stop_messages: 5534751
  shard.plan_route_messages: 5860325
---


## Re-measured 29 August 2026: the body-index lease, and the figure held

Migration 0048 (audit P1-3) added `body_index_lease_until` and `body_index_attempt_version` to `messages`, and
**replaced** `msg_body_index_due` with a three-column version rather than adding a second index.
**1,648.6 bytes per message — unchanged**, and an extra delivery unchanged at 409.6.

| stage | reported | previous round |
|:--|--:|--:|
| empty database | 12,288 | 12,288 |
| schema only (2 tables, 9 indexes) | 61,440 | 57,344 |
| + 2,000 messages, one delivery each | 3,375,104 | — |
| + 2,000 more messages | 6,672,384 | — |
| + 2,000 extra deliveries only | 7,491,584 | — |

**The schema alone grew by exactly one 4,096-byte page**, and that is the whole visible cost: a wider index
entry needs a wider B-tree, and the root page is where that showed up. Per *row* it is invisible, which is
what the marginal figure measures — 3,297,280 bytes across 2,000 messages.

**Why this one was free where 0044's index was not.** The previous round's index was a **second** B-tree with
an entry per row, and 17 bytes a message is what a new per-row structure costs. This round adds no structure:
the same index gains a nullable third column that is NULL on every settled row, and a NULL in an index entry
costs a serial type in the entry header rather than payload. Two columns on the table are the same story —
`body_index_lease_until` NULL everywhere and `body_index_attempt_version` an integer `0`, which SQLite stores
as a header-only serial type with no payload bytes at all.

**What this does not establish.** The instrument's resolution is a page, and this file has said since 27
August that *"the next small column will look free too"*. `1,648.6` against the previous `1,649` is a
difference of four tenths of a byte, which is noise at page granularity rather than a measured decrease. The
honest reading is *"this change fits in space already paid for"*, not *"nullable columns are free"* — and the
figure that will move is the one pushing a row past the point where two no longer share a page. Nothing here
knows how close the current row is to that boundary.

`values:` is therefore unchanged and the shard arithmetic below it stands.

### The script was wrong once more, and now something watches it

`scripts/measure-message-bytes.mjs` restates this schema rather than reading `migrations/`, and it omitted
`body_index_attempt_version` from its corpus — the **fourth** round in a row it has left something out, and
the fourth time the omission would have reported the missing thing as free. It was caught by reading the
script before running it rather than by anything failing.

So the third copy is now guarded. `test/node/byte-measurement-corpus.test.ts` compares the script's `SCHEMA`
against `test/schema-drift.test.ts`'s `MEASURED_SHAPE` — columns in declaration order, indexes, and every
`NOT NULL` column's presence in the `INSERT`, since a column that exists in the scratch table and not in the
corpus takes its default and gets priced at zero. `MEASURED_SHAPE` is already pinned to the migrated database
by the drift guard, so the two compose: drift catches the schema moving, and this catches the script failing
to follow.

Four rounds of a comment warning about a hazard did not prevent the hazard a fourth time. That is the whole
argument for the check.

**Measured:** against **real remote D1**, not miniflare. A scratch database in a live Cloudflare account on
the **Workers Free** plan, seeded through `wrangler d1 execute --remote`, with size read from
`wrangler d1 info --json`. The database was deleted after measurement.

## Re-measured 28 August 2026: the body index's state machine, and an index that was not free

#107's state machine (`0044`) added four columns to `messages` and one index. **1,632 → 1,649 bytes per
message**, and the split between those two causes is the finding.

**The four columns cost nothing measurable.** Two are `NOT NULL DEFAULT`, so every row carries them, and the
figure did not move — the same page-slack explanation as `body_indexed_at` below: `database_size` is reported
in 4,096-byte pages, two ~1,632-byte rows share one with roughly 830 bytes spare, and a short state string
plus an integer fit in space already paid for.

**The index cost 17 bytes a message.** `msg_body_index_due` on `(body_index_state,
body_index_next_attempt_at)` is a second B-tree with an entry per row, and unlike a column it cannot hide in
slack. That is 68,000 messages of shard capacity — about 1% — and it is the third time this receipt has
recorded an index doing this. The note below already says **"two indexes cost 1.4 million messages of
headroom"**; this is a third, and it is smaller only because the columns it covers are narrow.

Worth stating because the trade was made without the number in hand: the index exists so the backfill can
find `pending` and due `retryable` messages without scanning `messages`, which on a Node with millions of
rows is the difference between a bounded pass and a full scan every minute. It is the right trade. It was not
a free one, and the shard thresholds moved.

### The measuring script was wrong twice more, in the way its own comment predicted

`scripts/measure-message-bytes.mjs` restates this schema rather than reading `migrations/`, and the comment
above its `SCHEMA` constant — added on 27 August after the same thing happened — says so. It happened twice
more in one sitting:

1. The first re-run omitted all four new columns and reported 1,632 unchanged.
2. The second added the columns and still reported 1,632 unchanged, because it omitted the **index**.

Only the third run measured the shape a Node actually has. Each intermediate result looked like good news,
which is exactly what makes this failure mode expensive: a measurement that omits something reports that the
thing costs nothing. The guard remains what it was — `test/schema-drift.test.ts` compares its own copy against
the migrated database and is what forces a re-measure at all — and it does not watch the script's copy, which
is now a documented hazard rather than a discovered one.

## Re-measured 27 August 2026: `body_indexed_at` added, and the figure did not move

#107 L2 added `messages.body_indexed_at`, which fired this receipt's `stale_when` — *"the messages or
mailbox_items schema changes"* — through `test/schema-drift.test.ts`. Re-measured with the script, and
**1,632.3 bytes per message, unchanged to the tenth of a byte.**

That is a real result and not a skipped measurement, but it needs its reasoning shown, because "we added a
column and nothing changed" is the shape of a measurement that did not happen.

**The first run genuinely did not measure the change.** `scripts/measure-message-bytes.mjs` **restates** the
schema rather than reading `migrations/`, and that copy is compared against nothing — `schema-drift.test.ts`
guards the *test's* copy, not the script's. So the first re-run built the old table and reported an unchanged
figure that was unchanged because the column was absent. A third copy of a schema, and the only one with no
tripwire on it; the script now says so in the comment above its `SCHEMA` constant.

**With the column present and populated it is still 1,632.3.** Populated, not null — a null column costs about
a byte of row header and a Node that has run its backfill has an ISO timestamp on every row, so measuring
nulls would have understated the deployed table.

The explanation is page slack, and it is the one consistent with every figure in the table:

| stage | reported |
|:--|--:|
| schema only | 57,344 |
| + 2,000 messages | 3,325,952 |
| + 2,000 more | 6,590,464 |

`database_size` is reported in **4,096-byte pages**. At ~1,632 bytes a row, a page holds two rows and carries
roughly 830 bytes of slack. Adding ~25 bytes per row adds ~50 bytes per page, which fits in that slack
without allocating a single new page — so the total is byte-identical, twice, across two independently
created scratch databases.

**What this means for the instrument, stated because the next small column will look free too.** This
measurement's resolution is a page, and at this row size that is about 830 bytes of headroom per two rows.
Any addition below that is invisible to it. So *"the figure did not move"* here means **"this column fits in
space already paid for"** — not that it is free in principle, and not that the next one will be. The figure
that would move is one that pushes a row past the point where two no longer share a page, and nothing here
knows how close the current row is to that boundary.

`values:` is therefore unchanged, and the shard arithmetic below it stands.

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

### Re-measured 12 August 2026, after Layer 3 added conversations

The guard fired again: migration 0014 added `conversation_id` and the `msg_by_conversation` index, because
a case is created per conversation and the grouping needed somewhere to live.

| Stage | `database_size` |
|---|---:|
| Empty database | 12,288 |
| Schema only (2 tables, **8** indexes) | 57,344 |
| + 2,000 messages, 1 delivery each | 3,325,952 |
| + 2,000 more messages | 6,590,464 |
| + 2,000 extra deliveries only | 7,409,664 |

- **Marginal per message (with one delivery): (6,590,464 − 3,325,952) / 2,000 = 1,632.3 bytes**
- **Marginal per extra delivery: (7,409,664 − 6,590,464) / 2,000 = 409.6 bytes**

**+127 bytes per message, an 8% increase**, for one nullable column and one index. Cheaper than threading's
+252 because `msg_by_conversation` keys on a 30-character ULID rather than a full RFC message-id — the same
reason the receipt has always given for not storing the `References` chain, visible from the other side.

Extra deliveries drifted 457 → 410. `mailbox_items` was not modified, so that is page packing rather than a
real change, and the direction is worth noting only because it is *down*.

**Now measured by a script**, `scripts/measure-message-bytes.mjs`, rather than by hand. Three measurements
in nine days made the manual procedure the weak part: field widths dominate the figure, so a corpus rebuilt
by hand each time produces numbers that are not comparable to each other. Four mechanical failures on the
way are recorded in the script, since each cost a round trip to remote D1: statement-size limit at 200 rows,
account selection with several accounts available, `--yes` not being the delete flag, and an "extra delivery"
needing a *different mailbox* because `mbi_unique` is on `(mailbox_id, message_id)` — the last being the
schema correctly refusing a row the corpus should never have generated.

### A stale value block, found while doing this

**The `values:` block was still deriving its shard thresholds from the original 1,253-byte figure**, not
from 4 August's 1,505. The re-measurement updated the table and the prose above it and left the machine-
readable half behind, so `packages/budgets/src/generated.ts` has carried
`shard.plan_warn_messages: 5996643` since 4 August — a threshold roughly **30% too optimistic** against the
schema that actually shipped, and nothing was wrong with the prose a reader would have checked it against.

That is this receipt's own `stale_when` clause failing in the one way the drift guard cannot see: the guard
watches the *schema*, so it fires when the shape changes, and it has nothing to say about a number inside the
receipt disagreeing with the paragraph beneath it. Both halves are now derived from the same measurement,
and the arithmetic below states the divisor it used so the next reader can check it in one line.

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

Divisor: **1,649 bytes per message**, from the 28 August measurement above. Every figure in this table is
that ceiling divided by that number, so it can be checked in one line.

| Threshold | Bytes | Messages |
|---|---:|---:|
| Shard capacity | 10,737,418,240 | 6,511,472 |
| 70% — warn and plan the next shard | 7,516,192,768 | **4,558,030** |
| 85% — stop optional bulky projections | 9,126,805,504 | **5,534,751** |
| 90% — route new metadata to a new shard | 9,663,676,416 | **5,860,325** |

**A single shard holds roughly 6.5 million messages** — down from 7.1 million after threading, and from 8.5
million before it. For most organisations that is still years of mail, which remains the useful
thing to know: sharding is not a day-one problem, and the planner should say so rather than
implying it is imminent. But the direction matters. **Two indexes cost 1.4 million messages
of headroom**, so the next projection added to this table is not free either, and §11B's
"stop optional bulky projections at 85%" now has a concrete meaning.

Against the **1 TB account-level ceiling** that #5 found missing from §11B — the one
sharding cannot relieve — a Node tops out near **674 million messages** across all shards
combined, down from 730 million after threading and 877 million before it. That is the boundary where §11B's advice to select the
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
