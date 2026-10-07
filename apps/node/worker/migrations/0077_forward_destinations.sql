-- Forwards to several destinations (ADR 47, amended 7 October 2026).
-- phase: expand
--
-- A kept forward held one destination, on the address row (`addresses.kept_forward_to`), and one attempt per receipt
-- (`kept_forward_attempts`, keyed by the receipt alone). An address may now forward to several destinations: the one a
-- taken-over forward rule had, and any an administrator chooses, on People or when taking over a rule that sent the
-- address to another Worker. Each destination is called with `message.forward()` and settled on its own.
--
-- Two new tables, filled from the old ones. SQLite cannot widen a primary key in place, and a rebuild under the old
-- name is a rename, which would make this a contraction. The old column and table stay as they are, read and written
-- by nothing once the Worker that names these is deployed; a later contraction drops them. Between this migration and
-- that deploy the Worker still serving keeps using the old ones: a forward it settles in that window is missing from
-- People's history, and none is lost (each one it forwards is forwarded).

-- One row per destination an address forwards to. The address, lowercased, as `addresses.address` holds it.
CREATE TABLE forward_destinations (
  org_id      TEXT NOT NULL,
  address     TEXT NOT NULL,
  -- Lowercased, as `stateIn` and SQLite's lower() fold, so one destination is one row.
  destination TEXT NOT NULL,
  -- What the latest read of the account's destination list said of it: 'verified', 'waiting' (listed, the link not
  -- yet clicked) or 'absent' (not listed). NULL when no read has answered since it was added, which is "not checked".
  verified    TEXT CHECK (verified IS NULL OR verified IN ('verified', 'waiting', 'absent')),
  checked_at  TEXT,
  PRIMARY KEY (org_id, address, destination)
);
INSERT INTO forward_destinations (org_id, address, destination, verified, checked_at)
  SELECT org_id, address, lower(kept_forward_to), kept_forward_verified, kept_forward_checked_at
    FROM addresses WHERE kept_forward_to IS NOT NULL;

-- One row per receipt and destination, written in the receipt's own batch and settled when that forward() answers.
-- The states, `error` and the copy columns mean what migrations 0074 and 0075 say of `kept_forward_attempts`. A copy
-- is one sealed send per receipt (`send_copies.receipt_id` is unique) to every destination whose forward was refused
-- as not verified, so the rows it covers are marked together.
CREATE TABLE forward_attempts (
  receipt_id    TEXT NOT NULL,
  destination   TEXT NOT NULL,
  org_id        TEXT NOT NULL,
  address       TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('outcome_unknown', 'handed_over', 'refused', 'withheld')),
  error         TEXT,
  attempted_at  TEXT NOT NULL,
  settled_at    TEXT,
  copy_state    TEXT CHECK (copy_state IS NULL OR copy_state IN ('sealed', 'refused')),
  copy_error    TEXT,
  copy_at       TEXT,
  PRIMARY KEY (receipt_id, destination)
);
INSERT INTO forward_attempts (receipt_id, destination, org_id, address, state, error, attempted_at, settled_at, copy_state, copy_error, copy_at)
  SELECT receipt_id, lower(destination), org_id, address, state, error, attempted_at, settled_at, copy_state, copy_error, copy_at
    FROM kept_forward_attempts;
-- People reads the latest attempt per address and destination, and doctor the unsettled ones.
CREATE INDEX forward_attempts_address ON forward_attempts (org_id, address, destination, attempted_at);
