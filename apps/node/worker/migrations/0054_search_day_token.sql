-- A date a search can narrow by, as an indexed token (#153).
-- phase: contract
--
-- **Contracting, because it drops two tables** — so `mailda deploy` refuses it without `--contract`, and the
-- release order is the one ADR 13 sets: deploy the code, then apply this deliberately. That order is right
-- for the expensive half as well: this requeues every message for the body backfill, and an operator should
-- start that when they mean to rather than as a side effect of a deploy.
--
-- **There is no gap, and the first live run is why this paragraph changed.** It used to say a windowed search
-- fails between the deploy and this migration. It does not: `mailda deploy` applies migrations **before** it
-- uploads the canary, so the column exists by the time any new code serves. The old code meanwhile is
-- unaffected — it inserts an explicit column list, which stays valid when a column is added, and matches bare
-- terms, which never names `day`.
--
-- What `--contract` buys is therefore deliberation rather than ordering: this requeues every message for the
-- body backfill, and an operator should start that when they mean to.
--
-- ## What this buys, measured before it was built
--
-- `q` with `since`/`until` refused with `E_MESSAGE_PAGE_WINDOW_SEARCH`, because a window was a residual
-- filter *inside* each ranked arm: the arm scans further through its MATCH result to fill `LIMIT`, and a
-- common term went from 771 rows read to 4,335 against a 1,000-row budget. Filtering *outside* the arms was
-- rejected for a worse reason than cost — the arms cap by rank first, so the window would filter an
-- already-capped set and "mail about demurrage since October" would answer **nothing** whenever October's
-- demurrage mail ranked below the cap.
--
-- #153 measured three directions and this is the only one that narrows **inside** the index. The probe
-- (`test/message-search-window.probe.test.ts`, run before this migration existed):
--
--   | window                | tokenised | residual filter |
--   |:----------------------|----------:|----------------:|
--   | one day               |    **20** |           2,386 |
--   | seven days            |       140 |               — |
--   | sixty days            |     1,188 |           2,970 |
--   | none                  |     2,376 |           2,376 |
--
-- And tripling the corpus over the same 120 days moved the unwindowed figure to 7,128 while a seven-day
-- window moved to 416: **windowed cost tracks the window, unwindowed cost tracks the archive.** That is the
-- property the other two directions could not deliver.
--
-- ## Why both tables are recreated rather than altered
--
-- SQLite's FTS5 has no `ALTER TABLE … ADD COLUMN`. A virtual table's column set is fixed at creation, so a
-- new column means a new table — there is no cheaper path and pretending otherwise would mean storing the
-- day inside an existing column's text, which is worse for two reasons: `message_search` **stores** its
-- `subject`, so a synthetic token would be shown to somebody by any excerpt or debug read, and a subject
-- legitimately containing `d20260501` could match a window it is not in.
--
-- So `day` is its own column, and every query filters it with FTS5's column syntax — `day:(...)` — which
-- cannot be satisfied by subject text.
--
-- ## The two tables rebuild differently, and one of them is expensive
--
-- **`message_search` rebuilds in SQL.** Its content comes from `messages`, so the rebuild is one
-- `INSERT … SELECT` and it is complete when this migration finishes.
--
-- **`message_body_search` cannot.** It is contentless (`content = ''`), so it stores no text to rebuild
-- from — the bodies live in R2 and re-indexing means re-reading and re-parsing every one. That is exactly
-- what the existing backfill does, so this migration resets `body_index_state` to put every message back in
-- its queue rather than inventing a second mechanism.
--
-- **A windowed search is therefore refused while that backlog is non-zero**, and that is not caution, it is
-- the same correctness argument as above. A body row with no day token cannot match any window, so a windowed
-- search run mid-rebuild would silently omit real matches — the quiet wrongness #153 refused when it rejected
-- filtering outside the arms. `doctor`'s `search_index_backlog` and `body_index_state` findings are what an
-- operator watches; the feature turns itself on when the index can answer honestly.
--
-- ## The granularity this fixes at, which is a product decision and not a limit anybody worked around
--
-- FTS5 matches tokens, not ranges. `d20260501` is expressible; `2026-05-01T10:30:00.000Z` is not. So a
-- windowed **search** offers day granularity where a windowed **listing** offers an instant, and the API
-- **refuses** an instant on a searched page rather than rounding it. Rounding would answer with mail from
-- before the time the caller asked for, which is the class of silent wrongness this whole ticket is about.

-- ## `message_search`, with the day
--
-- Dropped and recreated. The old table's rows are derivable from `messages`, so nothing is lost that the
-- statement below does not put back.
DROP TABLE IF EXISTS message_search;

CREATE VIRTUAL TABLE message_search USING fts5(
  subject,
  from_addr,
  -- One token per row: `d20260501`, from the receipt's `accepted_at`. Alphanumeric, so `unicode61` keeps it
  -- whole — a hyphenated `2026-05-01` would tokenise into three numbers and `01` would match every first of
  -- every month.
  day,
  message_id UNINDEXED,
  org_id UNINDEXED,
  tokenize = 'unicode61'
);

-- Rebuilt from `messages` joined to the receipt that dates it. `accepted_at` rather than `sent_at`, because
-- the listing's window is `accepted_at` — a search and a listing that windowed by different clocks would
-- disagree about which mail is in a range, and the sender controls `sent_at`.
INSERT INTO message_search (subject, from_addr, day, message_id, org_id)
SELECT m.subject,
       m.from_addr,
       'd' || replace(substr(r.accepted_at, 1, 10), '-', ''),
       m.id,
       m.org_id
  FROM messages m
  JOIN ingress_receipts r ON r.id = m.ingress_receipt_id;

-- ## `message_body_search`, with the day
--
-- Contentless, so this drop loses the index and nothing can rebuild it here. The reset below is what rebuilds
-- it, over R2, through the machinery that already exists for it.
DROP TABLE IF EXISTS message_body_search;

CREATE VIRTUAL TABLE message_body_search USING fts5(
  body,
  day,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61'
);

-- ## Every message goes back in the body queue
--
-- `pending` rather than `NULL`: 0041's own header says null means *not yet considered* and is the state a
-- message arrives in, while `body_index_state` is what the backfill selects on. Setting the state is what
-- makes these messages appear in the backlog `doctor` reports and the pass claims, so the rebuild is visible
-- and resumable rather than silent.
--
-- `blob_key IS NOT NULL` matches `bodyIndexState`'s own predicate: a message with no stored bytes has no body
-- to index, and putting it in the queue would create a backlog no amount of work drains — the non-terminating
-- backfill 0041 was careful to avoid.
-- **Every column the backfill's selection depends on**, not only the state. A row left with a stale
-- `body_index_next_attempt_at` in the future would not be claimed until that time passed, and one left with
-- a live `body_index_lease_until` would look claimed by a pass that is not running — either way the rebuild
-- stalls on rows nobody is working on, which is a backlog that does not drain and reads as a broken backfill.
-- `body_index_attempts` and `body_index_error` are cleared for the same reason `attempts` exists: a message
-- that previously exhausted its retries is being asked afresh, not resumed.
UPDATE messages
   SET body_index_state = 'pending',
       body_indexed_at = NULL,
       body_index_attempts = 0,
       body_index_error = NULL,
       body_index_next_attempt_at = NULL,
       body_index_lease_until = NULL
 WHERE blob_key IS NOT NULL;
