-- Which form each message's search rows were written in, so rows the previous version writes after this
-- migration are re-formed too. Additive (#10 expand/contract): three columns, two indexes and a trigger; no DROP,
-- no rewrite. Like every expansion it must precede the code that uses it (the new code's stamps name these
-- columns), which `mailda deploy` does by applying it before the canary.
--
-- ## Why the form has to be recorded
--
-- `src/search.ts` now writes every indexed text through `searchText` (NFKC, and Chinese, Japanese and Korean
-- runs as overlapping bigrams), and reads every query through the same function. A row written before it holds
-- `unicode61`'s view of the raw text, with a CJK run as one token. Searched by the new query it is found by its
-- words in Latin and other spaced scripts, by a CJK search only when that is a run's first one or two characters
-- (the query bigrams the rest, and a bigram phrase never equals the old token), and not by full-width text. Such
-- rows have to be rewritten, and the question is how the rewriter finds them.
--
-- The first version of this migration emptied the subject index and requeued indexed bodies, and the backfills
-- refilled what was missing. That was correct only if no old-form writer ran afterwards, and one does:
-- `mailda deploy` applies migrations **before** it uploads the canary, so the old code keeps serving, and
-- indexing, until promotion. Its rows (and its subject backfill refilling the emptied index) landed in the old
-- form on messages that then *had* a row, which is all either backfill asked. Correct only if operators ship
-- it a release late is a stopgap, not an order (AGENTS.md principle 5).
--
-- So each message records the form of its rows, and "is this row current" stops being inferred from whether
-- it exists:
--
--   search_index_form   the form of the message's `message_search` row. Stamped by `indexMessage` in the
--                       statement after its insert, under the same predicate, so it is set only where the row
--                       was written.
--   body_index_form     the form of its `message_body_search` row. Stamped by `settleBodyIndex` when it settles
--                       an attempt, in the batch that wrote (or found nothing to write) under the same claim.
--
-- `0` is every form before this one, and it is the default, so **code that knows nothing of these columns
-- leaves them at "old"**, whether it runs before promotion or after a rollback. That is the whole design: the old code's INSERT into `messages` names its columns
-- and never these, so mail it accepts is form 0 and gets re-formed; and the backfills select `form < current`
-- rather than "no row", so a row the old code wrote after this migration is revisited like one it wrote
-- before. The current form is `SEARCH_FORM` in `src/search.ts`; a later change to `searchText` is a bump of
-- that constant, and nothing here changes.
--
-- ## Why a trigger clears the body stamp on every claim
--
-- The old code can also *re*-index a body: its backfill claims a `pending` or `retryable` message and writes its
-- row in the old form. It settles without touching `body_index_form`, so a message stamped current before that
-- claim (reachable by the old code's repair route, during a canary or after a rollback) would keep a current
-- stamp over an old-form row, and nothing would revisit it.
--
-- Every claim, old code's or new, bumps `body_index_attempt_version`; that is the version compare-and-swap
-- `settleBodyIndex` answers to. The trigger sets the stamp back to 0 whenever that version moves, so the stamp
-- is current only when **the settlement of the latest claim** was written by code that stamps. The same bump
-- is what `repairBodyIndex` and the backfill's re-form requeue do, and for both 0 is also the truth. The
-- subject index needs no trigger: the old code writes a subject row only for a message it has just accepted
-- or one with no row at all, and neither can be stamped current.
--
-- ## The indexes, and the cost they remove
--
-- The subject backfill and `doctor`'s subject count used to ask `NOT EXISTS (SELECT 1 FROM message_search s
-- WHERE s.message_id = m.id)`. `message_id` is `UNINDEXED` in FTS5, so each probe scans the table: measured
-- under vitest-pool-workers on 3,000 messages with ten unindexed, **4,501,465 rows read** for one backfill
-- select and 4,501,455 for one doctor count, every minute and every doctor run, on a Node that was caught up.
-- `search_index_form < ?` on `msg_search_index_form` reads the backlog and nothing else.
--
-- `msg_body_index_form` is `(body_index_state, body_index_form)` because the re-form requeue asks for `indexed`
-- rows below the current form: `empty` and `unindexable` rows never have a row to re-form and stay at whatever
-- form they were settled in, and a single-column index would read them on every pass.
--
-- ## The cut, recorded
--
-- `body_index_cut_from_bytes` is the size in UTF-8 bytes of a body's indexed text when it was longer than one
-- D1 string (`d1.max_row_bytes`, `docs/receipts/d1-platform-limits.md`) and so was cut to fit; NULL when the
-- whole text is in the index. The ingest batch binds that text, so past the limit the message itself would not
-- arrive; the cut keeps it arriving, and this column is what keeps the cut from being silent (`doctor`'s
-- `body_index_partial`). Not `body_index_error`: that is why a message is *not* indexed, and a cut message is.
--
-- ## Cost of applying it
--
-- Three `ADD COLUMN`s with constant defaults, which SQLite records in the schema without rewriting a row; two
-- index builds over `messages`, which read it once each (0044 built `msg_body_index_due` the same way); and a
-- trigger. Nothing is emptied and nothing is requeued here: the backfills find the old rows by their form,
-- 500 subjects and 25 bodies a minute, and `doctor`'s `search_index_backlog` and `body_index_backlog` count
-- them meanwhile. Until they reach a message, the previous version finds it as it always did, and this version
-- finds it only as described at the top: by its Latin words, not by its CJK words.
--
-- ## After a rollback
--
-- The mirror image, and nothing repairs it backwards. The previous version's query is one prefix token per word
-- (`"关于发"*`), and a row this version wrote holds bigrams, so rows in form 1 are found by the previous version
-- through their Latin words and through CJK searches of one or two characters, and not through longer CJK
-- searches or full-width typing, until the code rolls forward. Rows the previous version writes meanwhile are
-- form 0 and are re-formed then.
ALTER TABLE messages ADD COLUMN search_index_form INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN body_index_form INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN body_index_cut_from_bytes INTEGER;

CREATE INDEX msg_search_index_form ON messages (search_index_form);
CREATE INDEX msg_body_index_form ON messages (body_index_state, body_index_form);

CREATE TRIGGER msg_body_index_form_claimed
AFTER UPDATE OF body_index_attempt_version ON messages
WHEN new.body_index_attempt_version IS NOT old.body_index_attempt_version
BEGIN
  UPDATE messages SET body_index_form = 0 WHERE rowid = new.rowid;
END;
