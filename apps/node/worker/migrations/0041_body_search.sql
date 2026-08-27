-- Finding mail by what it says (#107 L2, map #105). Additive (#10 expand/contract): one table, no DROP.
--
-- ## This one costs something against ADR 28, and 0040 did not
--
-- `0040_message_search.sql` indexes `subject` and `from_addr`, which have been plaintext columns of
-- `messages` since 0002 — so it discloses nothing a D1 dump did not already disclose. **This table is
-- different.** Message bodies live in R2, encrypted under keys held in a Durable Object, and ADR 28 says that
-- arrangement "defends against a D1 dump or a configuration leak". An index over body text puts something
-- derived from those bodies into D1.
--
-- ADR 28 is amended in the same change rather than left contradicting the schema. What the amendment says,
-- and what this table is built to make true, is that the disclosure is **tokens and not text**.
--
-- ## `content=''` is the whole design, not a tuning option
--
-- A contentless FTS5 table builds the inverted index and stores **no copy of the document**
-- (`docs/receipts/d1-fts5-search.md`, measured: `SELECT body` returns `null` for every row). So a D1 dump
-- against this table reveals *which words occur in which message* — enough to confirm a guess, which is a
-- real disclosure and is written into ADR 28 — and not the message. The bodies stay in R2, encrypted, where
-- ADR 28 put them.
--
-- Without `content=''` this migration would copy every message body into D1 in plaintext and defeat the exact
-- threat the vault exists for. The option is load-bearing and a future edit removing it would be a silent
-- reversal of a contract decision.
--
-- ## `contentless_delete=1` is what makes deletion possible at all
--
-- A contentless table has no copy of the document, so historically it could not work out which index entries
-- to remove and **could not delete rows**. An index whose rows outlive the messages they describe would
-- defeat content deletion. SQLite added this option; D1 ships a version that has it, measured rather than
-- assumed. A migration that created this table without it would produce an index that silently accumulates
-- the words of deleted mail.
--
-- ## Addressed by rowid, because a contentless table cannot hold a join key
--
-- The obvious shape is an `UNINDEXED` column carrying `message_id`, the way 0040 does. **It does not work
-- here:** an `UNINDEXED` column in a contentless table stores nothing and reads back `null` — measured on
-- live D1 before this was written. The same is true of `org_id`, so this table cannot carry its own
-- organization either.
--
-- So the row's identity is its **rowid, set equal to `messages.rowid`**, and every read joins
-- `messages` on it. That join is also what scopes the read to one organization, which is why the
-- `search-scope-world` tripwire has a separate rule for this table: 0040's requires `org_id` in the same
-- statement as the `MATCH`, and this one requires the join to `messages` there instead. Both are the same
-- property — a match is never trusted without something that knows whose mail it is — reached differently
-- because the storage differs.
--
-- ## No `snippet()`, and that is a feature boundary rather than a defect
--
-- `snippet()` needs the document to cut an excerpt from and returns **`null`** on a contentless table rather
-- than failing (measured). So there are no body excerpts in a result list, and there must not be an attempt
-- at one: showing the matching line means fetching that message from R2 and decrypting it, which is a
-- `mailbox.content.read` operation and authorized as one. That is the correct answer on privacy grounds
-- anyway — the cheap path would have let the index hand back body text.
CREATE VIRTUAL TABLE message_body_search USING fts5(
  body,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61'
);

-- ## `messages.body_indexed_at`, and why the index cannot answer this question itself
--
-- The backfill has to find messages it has not reached yet, and the obvious test is "no row in
-- `message_body_search`". That does not terminate: a message with **no body at all** — headers only, or a
-- body the parser cannot read — produces no index row however many times it is attempted, so it would be
-- selected by every pass forever. The backlog figure would never reach zero and `doctor` would report
-- outstanding work that no amount of work removes, which is precisely the shape of dishonest number this
-- repository keeps removing.
--
-- So the fact recorded is **"the body index has finished with this message"**, which is not the same as "this
-- message has an index row" — the difference is exactly the empty-body case. Null means not yet considered; a
-- timestamp means considered, whether or not it produced a row.
--
-- Set by the ingest batch and by the backfill, both through `search.ts`. A column rather than a separate
-- table because it is one fact about one message with the same lifetime as the row it sits on.
ALTER TABLE messages ADD COLUMN body_indexed_at TEXT;
