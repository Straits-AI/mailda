-- Outbound: the composition manifest, its state machine, and the daily send counter.
-- Additive (#10 expand/contract): no DROP, so no bookmark gate.

-- The manifest (§1429, ADR 35). Sealed before dispatch, for **every** send rather than only the
-- approved ones — otherwise "what did we send?" has two answers depending on whether a policy
-- happened to apply, and the path with no record is the majority one.
--
-- `id` is the effect key #9 requires. Not an intent id linked to a manifest: two identifiers that
-- must correspond is a correspondence someone eventually gets wrong, and a duplicate send is visible
-- to the recipient forever.
--
-- Editing a sealed manifest is not an operation. A revision produces a new row with a new id, so an
-- approval bound to the old id is moot by construction rather than by an invalidation step anyone has
-- to remember to perform (ADR 11, ADR 35).
CREATE TABLE send_manifests (
  id                     TEXT PRIMARY KEY,   -- snd_<ulid>; this IS the effect key
  org_id                 TEXT NOT NULL,
  mailbox_id             TEXT NOT NULL,      -- From is the mailbox (ADR 36)
  author_user_id         TEXT NOT NULL,      -- who wrote it: recorded, never in a header (ADR 36)
  in_reply_to_message_id TEXT,               -- our own msg_ id, NULL for a new thread

  envelope_from          TEXT NOT NULL,
  envelope_to            TEXT NOT NULL,      -- JSON array
  envelope_cc            TEXT,               -- JSON array
  envelope_bcc           TEXT,               -- JSON array
  subject                TEXT NOT NULL,
  rfc_message_id         TEXT NOT NULL,      -- the Message-ID this Node authors
  references_header      TEXT,               -- bounded reconstruction (send.references_emitted_max)

  -- ADR 33: which API carried it, and therefore what the record is worth. Required, never inferred.
  fidelity               TEXT NOT NULL,      -- 'authored' | 'reconstructed'

  -- Two bodies (ADR 35). Normalization precedes sealing so the bytes sent are the bytes approved;
  -- the author's original is kept because if normalization ever changes meaning, a record holding
  -- only the normalized form cannot settle the dispute. Both are R2 evidence; only hashes live here.
  body_typed_key         TEXT NOT NULL,
  body_typed_sha256      TEXT NOT NULL,
  body_normalized_key    TEXT NOT NULL,
  body_normalized_sha256 TEXT NOT NULL,
  -- The exact bytes submitted. Present only when fidelity = 'authored', because the structured API
  -- gives us nothing to store (§12 invariant 2: *any materialized* submission representation).
  submitted_key          TEXT,
  submitted_sha256       TEXT,

  sealed_at              TEXT NOT NULL,
  -- When the hold window closes and dispatch becomes permitted (ADR 39). Equal to sealed_at when the
  -- mailbox's window is zero.
  release_at             TEXT NOT NULL,

  -- Exactly the seven states of ADR 39. `sent` and `delivered` are not among them and must never be:
  -- §5C forbids claiming an outcome nobody observed, and the transport reports acceptance, not
  -- arrival.
  --
  -- Extended by 0019_policy.sql, which adds `awaiting` -- a policy gate somebody can clear -- and the
  -- `state_reason` column that says which gate. Read 0019's header for the full vocabulary; this line is
  -- what it was on 6 August 2026 and is left as the historical record rather than rewritten.
  state                  TEXT NOT NULL,      -- held|cancelled|throttled|refused|suppressed|handed_over|outcome_unknown
  state_at               TEXT NOT NULL,
  transport_message_id   TEXT,               -- Cloudflare's messageId, only when handed_over
  last_error             TEXT,
  attempts               INTEGER NOT NULL DEFAULT 0
);

-- The dispatcher's query: what is due for release. Partial, so it is empty once nothing is held —
-- the shape #11 established for the authorization path.
CREATE INDEX sm_due ON send_manifests (org_id, release_at) WHERE state = 'held';
-- Automatic retry is permitted only for states that provably never left (ADR 40).
CREATE INDEX sm_retryable ON send_manifests (org_id, state_at) WHERE state = 'throttled';
CREATE INDEX sm_by_thread ON send_manifests (org_id, in_reply_to_message_id);

-- ADR 34: Cloudflare publishes no daily sending limit — it is per-account, reputation-dependent and
-- changes without notice. AGENTS.md forbids a limit a developer can hit but cannot see, and reading
-- cannot resolve this one, so it gets measured: the count at which throttling first occurred *is* the
-- observed limit, and it is the only form of that number which can exist.
CREATE TABLE send_counters (
  org_id             TEXT NOT NULL,
  day                TEXT NOT NULL,          -- YYYY-MM-DD, UTC
  handed_over        INTEGER NOT NULL DEFAULT 0,
  first_throttled_at TEXT,                   -- NULL until throttled once
  throttled_at_count INTEGER,                -- the observed daily limit, measured rather than read
  PRIMARY KEY (org_id, day)
);

-- The undo-send window, per mailbox (ADR 39). NULL means the default; 0 means send immediately.
-- Configurable because no measurement could settle it: a customer-facing support desk and a
-- password-reset mailbox need different values.
ALTER TABLE mailboxes ADD COLUMN hold_window_seconds INTEGER;

-- What `mailda deploy` verified with an account token, and when (ADR 34). Neither the Workers plan nor
-- whether a sending domain is onboarded is visible from inside a Worker, so a Node reads a *recorded*
-- answer and its date rather than guessing — and `doctor` shows the date, so staleness is visible
-- rather than implied.
CREATE TABLE node_capabilities (
  name        TEXT PRIMARY KEY,   -- 'send'
  value       TEXT NOT NULL,      -- JSON
  recorded_at TEXT NOT NULL
);
