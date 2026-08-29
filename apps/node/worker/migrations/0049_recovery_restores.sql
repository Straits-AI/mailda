-- A vault restore becomes an operation with an identity, so it can be resumed rather than half-done.
--
-- `redeemForVault` decrypted the escrow, wrote `recovery.vault_restored / ok` to the audit chain, marked the
-- code spent — and only then made the Durable Object calls that put the keys back. D1 and Durable Object
-- storage cannot share a transaction, so a Worker that died between those steps left:
--
--   * the code spent, one of ten gone;
--   * the trail saying the vault was restored;
--   * some or all of the key generations still absent.
--
-- Ten codes bound the damage and do not make the trail honest. This is the disaster-recovery path: the one
-- operation whose record has to be true, being read during the incident it exists for.
--
-- The shape is a saga, because it cannot be a transaction. The attempt is recorded **before** the Durable
-- Object work and settled after, so an interruption leaves a `started` row that says what was being attempted
-- and with which code. `vault.restore` is idempotent — it reports `identical` for a generation already present
-- and `conflict` for one that disagrees — so resuming means running it again, not reconciling by hand.
--
-- The row is also the **reservation**. A code with a live `started` row is in flight, which is what stops two
-- concurrent redemptions of one code doing the work twice; `started_at` is the lease, so a dead attempt frees
-- the code after `RESTORE_LEASE_MS` rather than parking it for ever. That is the same shape as the body-index
-- lease, and for the same reason: a claim nothing can release is a deadlock wearing a safety argument.
CREATE TABLE recovery_restores (
  id         TEXT PRIMARY KEY,             -- rst_<ulid>
  org_id     TEXT NOT NULL,
  code_id    TEXT NOT NULL,                -- the rcv_ row whose escrow is being installed
  state      TEXT NOT NULL,                -- started | completed | failed
  started_at TEXT NOT NULL,
  settled_at TEXT,
  -- What actually happened, as JSON: the generations installed, the ones that collided with a live key, and
  -- the error when there was one. Never a secret and never a code -- the same rule the audit detail follows.
  detail     TEXT
);

-- The reservation lookup: is this code already in flight, and is that attempt still alive?
CREATE INDEX recovery_restores_by_code ON recovery_restores (org_id, code_id, state, started_at);
