-- Row projections: the sender's display name and one sealed line of the body, for the list (ADR 45).
-- phase: expand
--
-- (1) Columns of `messages`, following 0044 (body-index state) and 0055 (authentication results): one fact
-- per message with the message's own lifetime. A side table was considered and rejected. Keyed by
-- `messages.rowid` it would pair a plaintext `from_name` with the wrong message after a `mailda backup`
-- restore, because `exportableTables` (packages/cli/src/backup.mjs) exports every non-virtual table while the
-- implicit rowid of `messages` (a TEXT primary key) is reassigned on import; and it would have stepped around
-- test/schema-drift.test.ts, the guard that forces the per-message bytes question. A column dies with its row,
-- so content deletion, when it exists, owes it nothing.
--
-- (2) `from_name` is plaintext because it is the same class of fact as `from_addr`, plaintext since 0002.
--
-- (3) `preview_sealed` is sealed under the ADR 28 content key with the message id as additional data, because
-- a plaintext excerpt would hand a D1 dump the most-read text of every message. 0041's "no snippet() from a
-- contentless index" stands: this is not from the index. Base64 TEXT, not BLOB: no catalog column is a BLOB
-- today and D1's BLOB shape through .all() is not what WebCrypto takes; base64 costs 4/3.
--
-- (4) `preview_state` is pending -> projected | failed. DEFAULT 'pending' makes every existing row, and every
-- row any code version inserts (a canary's incumbent, an older deploy), owe a projection, so the backfill has
-- no holes to find.
--
-- (5) The partial index costs bytes only for rows not yet projected (zero once caught up). SQLite uses a
-- partial index only when the query's WHERE repeats the index's terms, so every query meant to use it spells
-- `preview_state <> 'projected'` verbatim: measured with SQLite 3.51 EXPLAIN QUERY PLAN, `preview_state =
-- 'pending'` alone is SCAN messages, and with the index term repeated it is SEARCH USING INDEX
-- msg_preview_open, and ORDER BY rowid DESC needs no sort.
--
-- (6) Not audited: a projection the Node writes; no person acts on it. No CHECK on the new columns, as in
-- 0044; the domain (src/preview.ts, src/preview-backfill.ts) writes them.
ALTER TABLE messages ADD COLUMN from_name TEXT;              -- the From header's display name; NULL when none
ALTER TABLE messages ADD COLUMN preview_sealed TEXT;         -- base64(12-byte IV || AES-256-GCM(ct || tag)), AAD = messages.id
ALTER TABLE messages ADD COLUMN preview_generation INTEGER;  -- content-key generation; NULL iff preview_sealed is NULL
ALTER TABLE messages ADD COLUMN preview_state TEXT NOT NULL DEFAULT 'pending';  -- pending | projected | failed
ALTER TABLE messages ADD COLUMN preview_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX msg_preview_open ON messages (preview_state) WHERE preview_state <> 'projected';
