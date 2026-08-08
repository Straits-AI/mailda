-- Each recipient gets its own submission, and therefore its own message id.
--
-- ## Why the shape changes
--
-- `new EmailMessage(from, to, raw)` takes **one** address. Joining recipients with commas produced a
-- single malformed address, so multi-recipient sending had never worked (receipt:
-- `cloudflare-email-sending.md`). The two ways out were the structured API — which builds its own MIME and
-- so cannot carry `authored` fidelity, ruled out by ADR 33 for customer mail — or one submission per
-- recipient of the same stored bytes. This migration is the second.
--
-- The objection to it was that submitting N times would multiply a customer's usage. **Measured, and it
-- was wrong**: one structured send to three recipients moved the zone's count from 0 to 3, so Cloudflare
-- already bills per recipient and splitting submission costs nothing extra.
--
-- ## What per-recipient submission is *not* doing
--
-- It does not split the evidence. The same R2 object is submitted N times, so `submitted_key` remains one
-- pair per manifest and §12's invariant holds unchanged. It does not split the manifest either: the
-- manifest id remains ADR 9's effect key, and the raw bytes remain the thing recorded.
--
-- It also *fixes* Bcc rather than complicating it. `Bcc` is deliberately absent from the emitted headers
-- while present in the manifest, and a correct Bcc requires a separate envelope per recipient — which is
-- exactly what this produces. The previous single-envelope shape could not have done it properly.

-- Cloudflare returns a distinct message id per submission, and the delivery event quotes it. Attribution
-- therefore belongs here rather than on the manifest: an event names one recipient, and this is the row it
-- is about.
ALTER TABLE send_recipients ADD COLUMN transport_message_id TEXT;

-- The join the event consumer now performs. One row per submission, so this is the direct match — where
-- joining via the manifest would have needed a second step and could not distinguish two recipients whose
-- outcomes differ.
CREATE INDEX sr_by_transport_id ON send_recipients (transport_message_id);

-- Attempts move to the recipient too. A retry must skip recipients already handed over — ADR 40's rule
-- that a duplicate *delivery* must not be reachable — and a per-manifest count cannot express "two of
-- three succeeded, try the third".
ALTER TABLE send_recipients ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

-- `send_manifests.transport_message_id` is deliberately kept, with a narrowed meaning: the id of the
-- *last* submission made for this manifest. Not dropped, for two reasons. Every send made before this
-- migration has one and it is the only attribution those rows will ever have, so removing the column
-- would destroy the history of already-sent mail. And `sm_by_transport_id` still serves the event
-- consumer's fallback path for exactly those older sends.
--
-- What it must not be read as is "the message id of this send". With several recipients there is no such
-- thing, and code that treats it as one is reading a value that describes whichever submission happened
-- to be last.
