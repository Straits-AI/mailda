-- The body-index pass takes a lease, and settles under compare-and-swap (audit P1-3).
--
-- The pass runs from cron every minute and costs, per message, an R2 read plus a vault unwrap plus a full MIME
-- parse. So a pass can take longer than a minute, and when it does it overlaps the next one — which selected
-- the same rows, because `body_index_state` stays `pending` until the first pass's batch commits at the very
-- end of its work.
--
-- The duplicated reads and parses are waste, not the defect. `body_index_attempts` was computed in the Worker
-- as `attempts + 1` from a value read at selection time, so two overlapping passes both wrote `attempts = 1`:
-- **the counter stops advancing**, and `BODY_INDEX_MAX_ATTEMPTS` — the bound that exists precisely so a pass
-- cannot spend its whole budget on the same failure for ever — never trips. A permanently failing message
-- would be retried without end while the mail behind it waited its turn.
--
-- Two columns, each doing one job:
--
--   * `body_index_lease_until`  when the claim lapses, so a pass that dies mid-flight does not park its rows
--                               for ever. Held rows are simply not selected until this instant passes.
--   * `body_index_attempt_version` bumped on every claim, and settlement is conditional on the value the
--                               claim returned. That is what makes a *lapsed* lease safe: a slow pass whose
--                               lease expired and whose rows were re-claimed and re-settled by a later pass
--                               cannot then overwrite the newer answer with its stale one. A lease alone
--                               bounds the overlap; the version is what makes the write correct when the
--                               bound is exceeded.
--
-- **There is deliberately no `body_index_lease_id`.** The first draft had one, on the argument that a lease
-- which cannot say who holds it is a diagnostic an operator cannot act on. That argument is wrong here: a
-- pass is an anonymous cron tick with nothing to correlate an id against, so an operator would read
-- `idx_01JQ…` and have nowhere to look it up — and a claim lapses in five minutes regardless. An identifier
-- nobody can resolve is not attribution, and `messages` is the table whose per-row cost sets §11B's shard
-- thresholds (`docs/receipts/message-metadata-bytes.md`). A column on every message in the product has to
-- earn more than that.
--
-- `NOT NULL DEFAULT 0` on the version because every existing row starts at claim zero, and a nullable counter
-- would make the compare-and-swap's predicate `= NULL` for exactly the rows that predate the column — the
-- null-safety trap migration 0047 has a paragraph about.
ALTER TABLE messages ADD COLUMN body_index_lease_until TEXT;
ALTER TABLE messages ADD COLUMN body_index_attempt_version INTEGER NOT NULL DEFAULT 0;

-- The selector's predicate, extended by the lease.
--
-- `msg_body_index_due` (0044) covers state and due-time; the lease is a third term in the same `WHERE`, so it
-- belongs in the same index or the planner reads held rows only to discard them. Replacing rather than adding
-- a second index: two indexes over overlapping prefixes of one predicate is one the planner uses and one that
-- is pure write cost on every message that arrives.
DROP INDEX IF EXISTS msg_body_index_due;
CREATE INDEX msg_body_index_due
  ON messages (body_index_state, body_index_lease_until, body_index_next_attempt_at);
