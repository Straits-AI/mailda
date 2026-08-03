-- Layer 1 ingress. Additive (#10 expand/contract): no DROP, so no bookmark gate.
--
-- §13 requires the raw MIME persisted to R2 and its pointer committed to D1 before the
-- receipt is treated as durable. R2 and D1 are not one transaction, so the order is forced:
-- R2 first. The only reachable partial state is then an orphan blob, which is sweepable —
-- never a message row pointing at nothing (#9).

-- One inbound acceptance. The derived key that makes the whole path retry-safe (#9): the
-- provider's message identity. Replaying the same delivery cannot create a second receipt.
CREATE TABLE ingress_receipts (
  id                TEXT PRIMARY KEY,            -- rcpt_<ulid>
  org_id            TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,               -- the derived key
  envelope_from     TEXT NOT NULL,
  envelope_to       TEXT NOT NULL,
  raw_bytes         INTEGER NOT NULL,
  blob_key          TEXT NOT NULL,               -- R2 object holding the sealed MIME
  blob_sha256       TEXT NOT NULL,               -- of the PLAINTEXT, so integrity survives re-sealing
  accepted_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX ir_derived_key ON ingress_receipts (org_id, provider_event_id);

-- The transactional outbox (§22). Committed in the SAME batch() as the domain write —
-- #5 established batch() is D1's only atomic primitive.
CREATE TABLE outbox (
  id           TEXT PRIMARY KEY,                 -- evt_<ulid>
  org_id       TEXT NOT NULL,
  topic        TEXT NOT NULL,                    -- e.g. mail.ingress.accepted
  payload      TEXT NOT NULL,                    -- references only; never the MIME (§13)
  published_at TEXT,                             -- NULL until the publisher has enqueued it
  created_at   TEXT NOT NULL
);
CREATE INDEX outbox_unpublished ON outbox (published_at, created_at);

-- Which addresses this Node accepts, and where they deliver. §13 resolves this BEFORE
-- touching content.
CREATE TABLE addresses (
  id         TEXT PRIMARY KEY,                   -- addr_<ulid>
  org_id     TEXT NOT NULL,
  address    TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX addr_unique ON addresses (org_id, address);

CREATE TABLE mailboxes (
  id         TEXT PRIMARY KEY,                   -- mbx_<ulid>
  org_id     TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One human, so Layer 1 has someone to authorize. Sessions are opaque; the token is
-- stored hashed so a D1 dump does not yield live sessions.
CREATE TABLE users (
  id         TEXT PRIMARY KEY,                   -- usr_<ulid>
  org_id     TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX users_email ON users (org_id, email);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                   -- ses_<ulid>
  org_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX sessions_token ON sessions (token_hash);

-- Claim state, so the one-time bootstrap secret can be consumed exactly once (§5A).
CREATE TABLE node_claim (
  id          TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  claimed_at  TEXT,
  org_id      TEXT
);
