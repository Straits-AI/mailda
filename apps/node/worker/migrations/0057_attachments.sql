-- Attachments: what each delivery carried, counted and judged at filing, and a second reason to hold it back.
-- phase: expand
--
-- The bytes stay in the original `.eml`; nothing is copied out. What the row records is how many parts were
-- attached and how many of them a mailbox may refuse to queue — an executable, a script, or a program under a
-- document's name (`src/attachments.ts`, by extension *and* magic bytes, since one lies). NULL on a message
-- from before this migration: nobody looked, which is a different fact from "none".
--
-- A second switch on the mailbox, off by default like the first (0056), and the same mechanism when it is on:
-- filed, no case, no queue, listed at GET /api/quarantine with reason `attachment_dangerous`, released by an
-- administrator. Two switches rather than one because they answer to different authorities — DMARC is the
-- sender's own domain speaking; this is a fact about the file.
ALTER TABLE messages ADD COLUMN attachments INTEGER;
ALTER TABLE messages ADD COLUMN attachments_dangerous INTEGER;
ALTER TABLE mailboxes ADD COLUMN quarantine_dangerous_attachments INTEGER NOT NULL DEFAULT 0;
