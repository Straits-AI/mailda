-- Finding mail by sender and subject (#107, map #105). Additive (#10 expand/contract): one table, no DROP.
--
-- ## Why an index rather than a LIKE
--
-- `subject LIKE '%term%'` cannot use an index -- the left side is an expression, so the planner scans -- and
-- `docs/receipts/message-page-size.md` records this listing already reading 210 rows of a 1,000-row budget,
-- with a mailbox-filtered page on a quiet mailbox reading 2,412. A substring scan on top of that was never
-- affordable, so L1 needed an index whether or not anybody wanted one here.
--
-- ## Why this costs nothing against ADR 28, which the body index will
--
-- `subject` and `from_addr` have been columns of `messages` in **plaintext** since `0002_message_metadata`.
-- An index over them discloses nothing a D1 dump does not already disclose, so this table is a storage cost
-- and not a confidentiality one -- which is why the search machinery is built, measured and tested here
-- first, and why #105's ADR 28 amendment belongs wholly to the body index that comes later.
--
-- The contrast is the whole reason the layers split: `docs/receipts/d1-fts5-search.md` measures that a
-- **contentless** FTS5 table (`content=''`) indexes without storing the document, which is mandatory for
-- bodies -- there, duplicating the text into D1 *is* the disclosure. Here duplication is free, so this is an
-- ordinary content-bearing FTS5 table, and that buys two things a contentless one cannot give:
--
--   * `snippet()` **works**. Measured on both forms: contentless returns `null` -- not an error, `null`, so a
--     result list built the obvious way ships blank highlights and passes any test that only checks for rows.
--     Content-bearing returns `[Demurrage] clause on the Hapag booking`.
--   * `DELETE ... WHERE message_id = ?` works without `contentless_delete=1`, so the index row dies with its
--     message through an ordinary statement rather than a flag somebody can omit.
--
-- ## The columns
--
-- `subject` and `from_addr` are the indexed ones, so `MATCH` searches those and only those. Recipient is not
-- here: a recipient address resolves to a mailbox, and the mailbox filter already narrows by it.
--
-- `message_id UNINDEXED` is the join key back to `messages`. Not the FTS rowid: an external-content or
-- rowid-keyed table needs an integer, `messages.id` is a text ULID, and mapping through SQLite's implicit
-- rowid would make this index depend on a value no column names. An UNINDEXED column is stored, returned and
-- filterable, and `DELETE ... WHERE message_id = ?` was measured against a live D1 rather than assumed.
--
-- `org_id UNINDEXED` is defence in depth and is deliberate duplication. Every query here joins `messages`,
-- which is org-scoped, so the join already confines the result -- but `MATCH` is evaluated before that join,
-- and a search subsystem whose rows do not say which organization they belong to is one refactor away from
-- matching across organizations and relying on a later clause to hide it. Every other table in this schema
-- carries `org_id`; a virtual one is not the place to start making an exception.
--
-- ## No trigger, and that is a choice
--
-- The textbook FTS5 pattern keeps the index in sync with triggers on the content table. Rejected here: a
-- trigger writes and deletes content invisibly to `test/node/content-deletion-world.test.ts`, which scans
-- `src` for `DELETE FROM <table>` and is this repository's inventory of everything that destroys content. A
-- guarantee the database enforces but the inventory cannot see trades one kind of safety for another, and the
-- inventory is the one that has actually caught things here. So the writes are ordinary statements in
-- `src/search.ts`, in the same batch as the message they describe.
CREATE VIRTUAL TABLE message_search USING fts5(
  subject,
  from_addr,
  message_id UNINDEXED,
  org_id UNINDEXED,
  tokenize = 'unicode61'
);
