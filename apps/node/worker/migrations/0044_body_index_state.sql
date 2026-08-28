-- A state machine for body indexing, so a recoverable failure is retried and a permanent one is reported
-- (audit follow-up to #107). Additive (#10 expand/contract): four columns, no DROP.
--
-- ## What was wrong with one timestamp
--
-- `body_indexed_at` recorded that the index had *finished* with a message and said nothing about how. The
-- backfill settled every message it reached, including the ones whose evidence it could not fetch -- because
-- an unreadable body does not become readable next minute, and a pass that retries one forever never reaches
-- the mail behind it. That reasoning is right about a *parse* failure and wrong about a momentary R2 error,
-- and the column could not tell them apart. A transient blip therefore made a message permanently
-- unsearchable by its text, with no record of why and no supported repair -- the receipt said so plainly and
-- named clearing the column by hand as the only route.
--
-- ## The five states, and why "empty" is not "unindexable"
--
--   pending      not reached yet. The state every message starts in.
--   indexed      body text is in message_body_search.
--   empty        reached, and there was nothing to index -- a headers-only message, or one whose parts carry
--                no text. Terminal and benign.
--   unindexable  the body could not be parsed, or the read failed on every allowed attempt. Terminal, and
--                worth an operator's attention in a way `empty` is not.
--   retryable    a recoverable failure. Carries an attempt count and the instant to try again.
--
-- `empty` and `unindexable` are separated because "eleven messages have no body text" is ordinary and
-- "eleven messages could not be parsed" is a defect somebody should look at. Collapsing them would put a
-- number in `doctor` that nobody can act on.
--
-- ## Why the columns live here rather than in a table of their own
--
-- One fact per message with the same lifetime as the message. `body_indexed_at` was already here, the backfill
-- already selects from `messages`, and a side table would need a row for every message or an absence-means-
-- pending convention -- which is the convention this migration exists to replace.
--
-- `body_indexed_at` is kept and keeps its meaning: when the index reached a terminal state for this message.
-- It is no longer how the backfill chooses work, so it is a record rather than a control.
ALTER TABLE messages ADD COLUMN body_index_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE messages ADD COLUMN body_index_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN body_index_error TEXT;
ALTER TABLE messages ADD COLUMN body_index_next_attempt_at TEXT;

-- Existing rows: a settled message is `indexed` if it has index rows and `empty` if it does not.
--
-- That is a guess in exactly one case and it is the safe direction. A message settled by the old backfill
-- after a *failed* read has no index rows and becomes `empty` rather than `unindexable` -- so it is recorded
-- as benign when it may have been a failure. The alternative is to mark every bodyless message as needing
-- attention, which would put every headers-only message in front of an operator forever. Repair is available
-- for the ones that matter, and `mailda search repair` is what an operator reaches for when a message they
-- expect to find does not come back.
UPDATE messages SET body_index_state = CASE
  WHEN body_indexed_at IS NULL THEN 'pending'
  WHEN EXISTS (SELECT 1 FROM message_body_search b WHERE b.rowid = messages.rowid) THEN 'indexed'
  ELSE 'empty'
END;

-- The backfill's selector: pending first, then retryables whose time has come.
CREATE INDEX msg_body_index_due ON messages (body_index_state, body_index_next_attempt_at);
