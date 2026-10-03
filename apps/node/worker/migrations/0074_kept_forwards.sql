-- Kept forwards: an address taken over from a forward rule whose destination keeps receiving (ADR 47).
-- phase: expand
--
-- A Cloudflare rule holds one action (`docs/receipts/email-routing-rule-takeover.md`), so pointing a forward rule
-- at this Node ended the forward. Since 3 October 2026 the take-over may keep it instead: the Worker stores the
-- message as always and then calls `message.forward()` to the destination the rule had
-- (`docs/receipts/email-worker-forward.md`). The destination is organization state written by the take-over,
-- never a request field, and every call leaves one row below.
--
-- Additive: three nullable columns the running Worker never names, and one new table.

-- The verified Email Routing destination the address keeps forwarding to, from the rule the take-over replaced.
-- NULL: nothing is forwarded. Cleared by a put-back once Cloudflare reads the rule back as the forward again.
ALTER TABLE addresses ADD COLUMN kept_forward_to TEXT;
-- What the latest read of the account's destination list said about kept_forward_to: 'verified', 'waiting' (listed,
-- the link not yet clicked) or 'absent' (not listed). NULL when no read has answered since the forward was kept,
-- which is "not checked", never "verified".
ALTER TABLE addresses ADD COLUMN kept_forward_verified TEXT
  CHECK (kept_forward_verified IS NULL OR kept_forward_verified IN ('verified', 'waiting', 'absent'));
-- When that read was made.
ALTER TABLE addresses ADD COLUMN kept_forward_checked_at TEXT;

-- One row per receipt that arrived at an address keeping a forward, written in the receipt's own batch and only
-- when the receipt row was inserted (so a lost race leaves no orphan), then settled once forward() answers.
--
--   outcome_unknown  written before the call: still so means the call never answered (the Worker ended first),
--                    and the destination may or may not have the message. doctor counts these.
--   handed_over      forward() resolved: Cloudflare took the message for the destination. Cloudflare reports no
--                    delivery outcome for verified destinations, so this is the ceiling of what is known.
--   refused          forward() threw; `error` is Cloudflare's words verbatim ("destination address not verified").
--   withheld         not called: the message carries this Node's own X-Mailda-Forwarded-By marker, so forwarding
--                    it again would loop. `error` says so.
--
-- The receipt id is the key: a redelivery of a stored message is `already_accepted` and writes nothing, so one
-- receipt is forwarded at most once.
CREATE TABLE kept_forward_attempts (
  receipt_id    TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  -- The address the message arrived at (the receipt's envelope_to), lowercased.
  address       TEXT NOT NULL,
  -- The destination as the address row held it when the message arrived.
  destination   TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('outcome_unknown', 'handed_over', 'refused', 'withheld')),
  error         TEXT,
  attempted_at  TEXT NOT NULL,
  settled_at    TEXT
);
-- People reads the latest attempt per address, and doctor the unsettled ones.
CREATE INDEX kept_forward_attempts_address ON kept_forward_attempts (org_id, address, attempted_at);
