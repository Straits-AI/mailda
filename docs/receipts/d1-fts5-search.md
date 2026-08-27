---
id: d1-fts5-search
kind: platform-limit
measured_on: 2026-08-27
stale_when: >
  D1 changes which SQLite compile-time options it ships — FTS5 itself, `contentless_delete`, or the
  auxiliary functions; D1's SQLite crosses a version boundary that changes contentless-table semantics; or
  Cloudflare begins rejecting `CREATE VIRTUAL TABLE` in migrations
values:
  search.d1_supports_fts5: 1
  search.contentless_index_matches: 1
  search.contentless_stores_body: 0
  search.contentless_delete_supported: 1
  search.contentless_snippet_returns_null: 1
---

**Measured:** probes against the live remote `CATALOG` database of the unclaimed Node in account
`dc8d1b7d…`, 27 August 2026, wrangler 4.118.0. Every probe table was dropped afterwards and its absence
confirmed by reading `sqlite_master`.

These five facts decide whether Mailda can have full-text search at all, and — more importantly — how much
of ADR 28's guarantee it has to give up to get it. The answer to the second question turned out to be much
less than expected, which is why this was measured before the design was written rather than after.

## D1 runs FTS5

`search.d1_supports_fts5: 1`. `CREATE VIRTUAL TABLE … USING fts5(body)` succeeded, `WHERE t MATCH
'demurrage' ORDER BY rank` returned the matching row with `rank: -9.24e-7`, and an FTS5 table joins an
ordinary table in a single statement.

That last clause is the one ADR 11 needs: the authorization predicate rides in the **same** query as the
match, so a search cannot be a read that was authorized separately and then trusted.

## A contentless index matches without storing the text

`search.contentless_index_matches: 1` and `search.contentless_stores_body: 0` — the two that matter most.

`USING fts5(body, content='')` builds the inverted index and stores **no copy of the document**. Both were
checked on the same table:

| probe | result |
|:--|:--|
| `SELECT rowid … WHERE t MATCH 'demurrage' ORDER BY rank` | the matching rowid |
| `SELECT rowid, body FROM t` | `body` is **`null`** for every row |

So the second copy of content that a search index would ordinarily create is **not a copy of the content**.
It is a set of tokens with the message ids they occur in. A D1 dump against a contentless index discloses
*which words appear in which message* — which is a real disclosure and must be written into ADR 28 — but not
the message. The body stays only in R2, encrypted, exactly where ADR 28 put it.

This is a materially smaller concession than "an FTS5 index puts your mail in D1 in plaintext", which is what
the design assumed before anybody checked.

## Deleting from a contentless index works, so the index row can die with the message

`search.contentless_delete_supported: 1`.

This was the probe most likely to sink the design. A contentless FTS5 table historically **cannot** delete
rows — the table has no copy of the document, so it cannot work out which index entries to remove — and a
search index whose rows outlive the messages they describe would defeat content deletion, which
`content-deletion-world.test.ts` exists to guarantee. SQLite added `contentless_delete=1` to make it
possible, and D1 ships a version that has it:

```
CREATE VIRTUAL TABLE t USING fts5(body, content='', contentless_delete=1);   -- accepted
DELETE FROM t WHERE rowid = 1;                                              -- changes: 4
SELECT count(*) FROM t WHERE t MATCH 'demurrage';                           -- 0
```

Without this flag there is no honest full-text search in this product, because there is no way to make the
index forget. The option is therefore **load-bearing and not a detail**: a migration that creates this table
without `contentless_delete=1` produces an index that silently accumulates the text of deleted mail.

## `snippet()` returns null instead of failing

`search.contentless_snippet_returns_null: 1`. The cost of contentless, and the reason it is recorded as a
value rather than a footnote.

`snippet(t, 0, '[', ']', '…', 8)` needs the document to cut an excerpt from, and a contentless table has
none. It does not raise an error. It returns **`null`**:

```
SELECT snippet(fts_probe2, 0, '[', ']', '...', 8) AS s FROM fts_probe2 WHERE fts_probe2 MATCH 'invoices';
  s: null
```

So a search result list built the obvious way ships **blank excerpts and no error anywhere** — a feature that
appears to work, degrades silently, and passes any test that only asserts the query returned rows. That is
this repository's recurring defect (#103) arriving from the platform rather than from our own comments, and
it is why it gets a number: the next person to reach for `snippet()` needs to find this before they ship it,
not after.

**What follows for the design:** showing the matching line means fetching that message's body from R2 and
decrypting it — which is a `mailbox.content.read` operation and authorized as one. Excerpts are therefore a
per-result authorized fetch, bounded by the page size, and never a free read out of the index. Which is the
correct answer on privacy grounds anyway: the cheap path would have let a caller with metadata rights read
body text out of an index, and the platform has removed that path by not having it.

## Confirmed through the migration path on a live Node, 27 August 2026

Everything above was probed with `wrangler d1 execute`, which is not how a Node gets its schema. A migration
is raw SQL applied through `batch()`, and `CREATE VIRTUAL TABLE` is a shape this repository's migration path
had never carried — so it was run for real before anything was built on top of it.

`migrations/0040_message_search.sql` applied to the live Node in account `dc8d1b7d…` via
`mailda deploy` → `wrangler d1 migrations apply`:

```
0040_message_search.sql   ✅
```

The ledger moved to `0040_message_search.sql`, and `sqlite_master` shows **six** tables where the migration
names one:

| table | what it is |
|:--|:--|
| `message_search` | the virtual table the migration declares |
| `message_search_config`, `message_search_content`, `message_search_data`, `message_search_docsize`, `message_search_idx` | FTS5's own storage, created and maintained by SQLite |

That count is why `test/audit-coverage.test.ts` classifies six rather than one: a closed world over tables sees
what SQLite creates, not what the migration wrote. A seventh appearing would mean the table's options changed.

Then the shipped query shapes, against that table on real D1 — using the exact expression `ftsQuery` emits
rather than a hand-written one:

```
MATCH '"demur"*'  AND org_id = 'org_live_probe'  ORDER BY rank
  → msg_live_probe
  → snippet(): [Demurrage] on the Hapag booking
```

Prefix matching, org scoping, rank ordering and **real highlighting** all work in the deployed database. The
probe row was deleted afterwards and the table confirmed empty.

### What this does not establish

**Search has not been exercised through the Worker against real mail.** That needs a claimed Node with a
session, and this Node is deliberately unclaimed. Every probe above is D1-level plus the deployed route
answering `401` rather than `500` for `?q=demurrage`, `?q=` with a malformed cursor, and `?q=AND NOT ( *` —
which shows authorization precedes parsing and the operators reach nothing, and does **not** show that a
signed-in reader gets the right rows. That part is covered by 1,264 tests in workerd and by nothing on this
account.

`doctor` reports no `search_index_backlog` finding here, which is correct rather than missing: the check
returns nothing when there is no organization, the same way `inbound_routing` and `recovery_escrow` do.
