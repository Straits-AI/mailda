-- Hash-linked audit (§23, Layer 5).
-- Additive (#10 expand/contract): no DROP, so no bookmark gate.
--
-- Built now rather than at Layer 5 for one reason: an audit log added later has a hole exactly where
-- the past should be. Everything already shipped — sign-in, key rotation, sealing, dispatch,
-- cancellation, re-sealing, reconciliation — produces events an administrator would need, and none of
-- them were recorded. The shape is Layer 5's so it does not have to be replaced.
--
-- **Hash-linked, not merely timestamped.** Each entry carries the hash of the one before it, so the
-- chain is a claim that can be *checked*: deleting an entry, reordering two, or editing a field all
-- break verification at a nameable point. A log an administrator has to trust is not evidence; one
-- they can verify is. This does not stop a determined operator with database access from rewriting the
-- whole chain — nothing in a self-hosted system can — and `verifyAuditChain` reports the first entry
-- where it breaks rather than a bare pass/fail, because "where" is what an investigation needs.
CREATE TABLE audit_entries (
  id          TEXT PRIMARY KEY,          -- aud_<ulid>
  org_id      TEXT NOT NULL,
  -- Position in the chain. UNIQUE per organization, so two concurrent writers cannot both claim the
  -- same slot: one loses at the database and retries, which is #9's shape — the conflict is the signal.
  seq         INTEGER NOT NULL,
  at          TEXT NOT NULL,

  -- Who. NULL when the actor is the Node itself (an alarm, a sweeper), which is a real and distinct
  -- case from an unknown actor and must not be conflated with one.
  actor_user_id TEXT,
  actor_kind    TEXT NOT NULL,           -- user | node | installer

  action      TEXT NOT NULL,             -- dotted, e.g. auth.signed_in, send.dispatched
  subject     TEXT,                      -- the thing acted on: manifest id, key id, mailbox id
  outcome     TEXT NOT NULL,             -- ok | refused | failed
  -- Bounded JSON. Never message content, never a credential: §12 keeps content in R2 and this table is
  -- read by anyone who may audit, which is a wider set than those who may read the mail.
  detail      TEXT,

  prev_hash   TEXT NOT NULL,             -- hex; the genesis entry uses 64 zeroes
  hash        TEXT NOT NULL              -- sha256(prev_hash || canonical fields)
);
CREATE UNIQUE INDEX audit_seq ON audit_entries (org_id, seq);
CREATE INDEX audit_by_time ON audit_entries (org_id, at);
CREATE INDEX audit_by_action ON audit_entries (org_id, action, at);
CREATE INDEX audit_by_actor ON audit_entries (org_id, actor_user_id, at);

-- Operational logs (§23). A *different* thing from the audit trail above, and kept separate on
-- purpose — conflating them produces a log too noisy to audit and an audit too sparse to debug.
--
--   audit_entries  what happened, who did it, hash-linked, kept, read by anyone who may audit
--   log_entries    why something behaved oddly, high volume, bounded, read by whoever operates it
--
-- The only logging before this was `console.error` into Cloudflare's dashboard, which meant an
-- operator had to leave the product to find out why it misbehaved — and meant nothing was queryable
-- by the Node itself, so `doctor` could not see its own failures.
CREATE TABLE log_entries (
  id         TEXT PRIMARY KEY,           -- log_<ulid>
  org_id     TEXT,                       -- NULL before a Node is claimed, or for pre-auth failures
  at         TEXT NOT NULL,
  level      TEXT NOT NULL,              -- error | warn | info
  event      TEXT NOT NULL,              -- dotted and stable, so it can be counted over time
  message    TEXT NOT NULL,
  detail     TEXT,                       -- bounded JSON; never content, never a credential
  -- Ties every record produced while handling one request together, so a failure can be followed
  -- rather than guessed at. §23 wants a trace; this is the smallest thing that is one.
  request_id TEXT
);
CREATE INDEX log_by_time ON log_entries (at);
CREATE INDEX log_by_level ON log_entries (level, at);
CREATE INDEX log_by_request ON log_entries (request_id);
