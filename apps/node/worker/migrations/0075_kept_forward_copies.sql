-- Copies: a sealed send of the original when a kept forward cannot be used (ADR 47, amended 3 October 2026).
-- phase: expand
--
-- A kept forward calls `message.forward()`, which throws "destination address not verified" for a destination the
-- account does not list as verified (`docs/receipts/email-worker-forward.md`). An administrator may now opt an address
-- in to a copy for that case: the stored message goes out again through this Node's own outbound path, from the
-- address itself, with the original sender's name in the From display name and their address in Reply-To.
--
-- Additive: two nullable columns on `addresses`, three on `kept_forward_attempts`, and one new table. The running
-- Worker names none of them.

-- Who turned copies on for this address, and when. NULL: off, which is the default. The opt-in is the authority each
-- copy is sealed under, re-checked live at every copy and again at dispatch: still set, and its administrator still one.
ALTER TABLE addresses ADD COLUMN copy_by TEXT;
ALTER TABLE addresses ADD COLUMN copy_at TEXT;

-- What became of the copy a refused forward asked for, beside the forward's own `state`, which keeps saying `refused`
-- with Cloudflare's words. NULL: no copy was asked for (copies off, or the forward was not refused for that reason).
--
--   sealed    a copy was sealed as a send; `send_copies.manifest_id` names it, and the send's own state says the rest
--             (held, handed over, refused by the provider ...). Not "copied": sealing is not delivery.
--   refused   no copy was sealed; `copy_error` names the rule that stopped it (too large, a dangerous attachment, the
--             message quarantined or failing DMARC, the opt-in withdrawn, a loop ...).
ALTER TABLE kept_forward_attempts ADD COLUMN copy_state TEXT CHECK (copy_state IS NULL OR copy_state IN ('sealed', 'refused'));
ALTER TABLE kept_forward_attempts ADD COLUMN copy_error TEXT;
ALTER TABLE kept_forward_attempts ADD COLUMN copy_at TEXT;

-- One row per copy sealed, written in the seal's own batch. The receipt is unique, so a second seal of the same
-- delivery (the outbox is at-least-once) fails its whole batch instead of sealing a second send. What the copy's
-- headers say about the original is frozen here at the seal, so a later reparse of the original cannot change the
-- bytes of a sealed send.
CREATE TABLE send_copies (
  manifest_id  TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  receipt_id   TEXT NOT NULL UNIQUE,
  -- The stored message whose body the copy carries (its evidence is read at render).
  message_id   TEXT NOT NULL,
  -- The From display name, "<sender's name> via <mailbox name>", as sealed.
  from_name    TEXT NOT NULL,
  -- The original sender, as Reply-To and X-Original-From carry them: their address, and their name when it had one.
  reply_to     TEXT NOT NULL,
  reply_to_name TEXT,
  -- The original's In-Reply-To, so a thread holds; NULL when it had none. References is the manifest's own column.
  in_reply_to  TEXT,
  -- This Node's claim id, carried as X-Mailda-Copy-Of: a copy that comes back is stored and never copied again.
  marker       TEXT NOT NULL,
  -- The administrator whose opt-in this copy was sealed under, and when that opt-in was made.
  opted_in_by  TEXT NOT NULL,
  opted_in_at  TEXT NOT NULL
);
