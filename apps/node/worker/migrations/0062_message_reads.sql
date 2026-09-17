-- Read state: whether *this person* has opened a message. Per person, because a mailbox is shared and one
-- colleague opening a message says nothing about whether another has.
-- phase: expand
--
-- A row means read; no row means not. Written when the reading pane fetches the body, and by
-- PUT /api/messages/:messageId/read {read: false} to put it back. Not audited: a person's own bookmark on
-- a message is not an act on the mail, and one entry per open would drown the trail
-- (audit-and-log-retention.md's "a handful per message"). The listing carries `read` for the caller.
CREATE TABLE message_reads (
  org_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  read_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX mrd_by_message ON message_reads (org_id, message_id);
