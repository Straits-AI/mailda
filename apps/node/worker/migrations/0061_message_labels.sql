-- Labels: words a person puts on a message, to find it again.
-- phase: expand
--
-- Flat labels, not folders. A message is in the mailbox it was delivered to and stays there — a folder would
-- be a second place for it to be, and moving mail between places is how it goes missing. A label is a word
-- on the row, any number of them, and the listing filters by one. Lower-cased and bounded in src/labels.ts;
-- no labels table, because a label with no message is nothing to keep.
--
-- Applied by people today, through PUT /api/messages/:id/labels, under read authority on the message's
-- mailbox. A Butler `label` node would write the same row; it is not built.
CREATE TABLE message_labels (
  org_id      TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  label       TEXT NOT NULL,
  applied_by  TEXT NOT NULL,
  applied_at  TEXT NOT NULL,
  PRIMARY KEY (message_id, label)
);
CREATE INDEX mlb_by_label ON message_labels (org_id, label, message_id);
