-- Places: where *this person* keeps a message — their Inbox, Archive or Trash (ADR 45, 26 September 2026).
-- phase: expand
--
-- Per person, for 0062's reason: a mailbox is shared, and one colleague putting a message away says nothing
-- about whether another has. A row means Archive or Trash; no row means Inbox. Putting a message back in the
-- Inbox deletes the row.
--
-- This is not the folder 0061 refused. The message stays in the mailbox it was delivered to, every other
-- reader keeps it where they left it, GET /api/messages without `place` still lists it, search finds it and
-- its thread shows it. Only this person's own view changes. Trash is a place, not a deletion, and there is
-- no purge: nothing here destroys anything, which is also why a legal hold does not refuse filing.
--
-- Not audited, for 0062's reason: a person's own view of a message they may already read, and the row is
-- the record. An `agt_` token files in its own view (its id is the user_id), never its sponsor's.
--
-- `receipt_id` and `accepted_at` are copies of immutable facts (a receipt's id and acceptance time never
-- change), kept so the Archive and Trash views page from this table's own index and cost a page, not the
-- corpus: `mpl_by_place` drives that plan. The primary key serves the listing's `place` column, the Inbox's
-- NOT EXISTS, the upsert and the delete.
CREATE TABLE message_places (
  org_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  receipt_id  TEXT NOT NULL,   -- ingress_receipts.id of this message (msg_by_receipt makes it one-to-one)
  accepted_at TEXT NOT NULL,   -- copied from the receipt: the listing's order
  place       TEXT NOT NULL CHECK (place IN ('archive', 'trash')),
  placed_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX mpl_by_place ON message_places (user_id, place, accepted_at DESC, receipt_id DESC);
