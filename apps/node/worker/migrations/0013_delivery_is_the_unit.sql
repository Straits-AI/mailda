-- A delivery, not a message, is what gets filed.
--
-- §12 invariant 3 says *a message may have many deliveries; access is evaluated per delivery/mailbox*.
-- That was assumed rather than implemented. The derived key was the Message-ID alone:
--
--   CREATE UNIQUE INDEX ir_derived_key ON ingress_receipts (org_id, provider_event_id);
--
-- Cloudflare Email Routing invokes the email() handler **once per recipient**, so a customer who Ccs
-- support@ and billing@ produced two invocations carrying the same Message-ID. The first was filed and
-- the second returned `already_accepted` and was discarded. The mailbox that was addressed never received
-- it, and nothing anywhere recorded that.
--
-- ## Why the key rather than a new table
--
-- `ingress_receipts` was already delivery-shaped — it has always stored `envelope_to` — and only the key
-- was message-shaped. So the narrower fix is also the more honest one: it makes the row mean what its
-- columns already say. The alternative, one receipt with N delivery rows hanging off it, stores the bytes
-- once and is the better *evidence* model, but it changes what a receipt is and every read path that
-- derives a mailbox from `envelope_to` — `listMessages` joins `addresses` on exactly that. Those paths need
-- no change here.
--
-- ## ADR 9 is preserved, which is the property that made the old key correct
--
-- The derived key exists so the inbound path is retry-safe: the same delivery arriving twice must file
-- once. Widening the key keeps that exactly — a redelivery carries the same Message-ID *and* the same
-- envelope recipient, so it still collides and still returns `already_accepted`. What changes is only that
-- two **different** deliveries stop colliding, which they never should have.
--
-- ## Expand-only, so no bookmark gate
--
-- #10's expand/contract rule guards migrations that remove something code still reads. This removes
-- nothing: the new index is strictly *wider* than the old one, so it permits every row the old one did.
-- Code written against the old key keeps working — it simply files fewer rows than it could. There is no
-- window in which a deploy is unsafe in either direction.
--
-- Existing rows are unaffected: each already has a distinct `provider_event_id`, so adding a third column
-- to the index cannot make any pair of them collide.
--
-- ## What this does not repair
--
-- Mail already dropped left no receipt, no R2 object and no log line, because the drop happened on the
-- happy path and looked like successful deduplication. There is nothing to backfill and no way to
-- enumerate what was lost. That is stated here rather than left for somebody to hope otherwise.

DROP INDEX ir_derived_key;

-- One receipt per delivery. `envelope_to` last, because the two-column prefix is still the shape the
-- redelivery check reads and a prefix scan on it stays available.
CREATE UNIQUE INDEX ir_derived_key
  ON ingress_receipts (org_id, provider_event_id, envelope_to);
