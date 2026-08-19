-- Per-recipient outcome. Layer 2's proof line: accepted / bounced / outcome_unknown, never blurred.
--
-- Until now a send to three people had ONE state column and a JSON array of addresses
-- (0007_outbound.sql:22-25), so "one bounced and two were accepted" was not representable. The ladder
-- requires "honest per-recipient state", and a single column cannot carry it.
--
-- ## Submission stays per manifest. Only the outcome is per recipient.
--
-- The tempting design is one send() per recipient. It is wrong and expensive: it would break the
-- manifest id as ADR 9's effect key, split submitted_key into N evidence pairs against §12's one-pair
-- rule, destroy the Bcc header/envelope asymmetry, change what send_counters.handed_over counts (which
-- would silently invalidate cloudflare-email-sending.md's observed-daily-limit figure), and multiply the
-- duplicate-delivery hazard ADR 40 exists to contain.
--
-- None of it is necessary, because Cloudflare emits one event per recipient
-- (receipt: email-sending-events.md, measured). So submission remains one act with one outcome, and that
-- outcome is *true of every recipient in the envelope* — mirroring it into these rows fabricates nothing.
-- Delivery, which genuinely differs per recipient, arrives later on the event channel.
--
-- Hence two state columns rather than one, and the split is the point:
--
--   submission_state  what happened when this Node handed the envelope over. Same for every row of a
--                     manifest, because it is a fact about the envelope.
--   delivery_state    what the receiving server did with this recipient. Differs per row. NULL until an
--                     event says otherwise, and NULL means unobserved rather than fine.

CREATE TABLE send_recipients (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL,
  manifest_id          TEXT NOT NULL,

  -- to | cc | bcc. Kept because a Bcc recipient must never be rendered beside a To recipient, and the
  -- envelope alone cannot tell them apart once submitted.
  kind                 TEXT NOT NULL,
  address              TEXT NOT NULL,

  -- Mirrors send_manifests.state at hand-over: held|cancelled|withheld|throttled|refused|suppressed|
  -- handed_over|outcome_unknown -- plus `awaiting`, added by 0019_policy.sql, because a manifest a policy
  -- gated must not have recipients reading `held`: that would show a person a message which is
  -- simultaneously stopped and pending.
  submission_state     TEXT NOT NULL,
  submission_state_at  TEXT NOT NULL,

  -- accepted | bounced | deferred | complained, or NULL for not yet observed. Deliberately NOT defaulted
  -- to anything: a default would make "we have heard nothing" indistinguishable from a real outcome,
  -- which is the ambiguity this whole table exists to remove.
  delivery_state       TEXT,
  delivery_state_at    TEXT,
  -- hard | soft, only when delivery_state = 'bounced'. A soft bounce is retries exhausted, not a
  -- permanent address failure, and suppressing an address on a soft bounce loses mail.
  bounce_type          TEXT,
  -- The provider's own words. Shown to a person rather than paraphrased, because a paraphrase of
  -- "550 5.1.1 User unknown" is a guess about somebody else's mail server.
  last_error           TEXT,
  -- payload.eventId of the event that last moved delivery_state. Lets a reader trace a state to its cause.
  last_event_id        TEXT,

  created_at           TEXT NOT NULL
);

-- One row per address per manifest. The same address appearing as both To and Cc is one recipient in
-- SMTP terms, and two rows would double-count a bounce.
CREATE UNIQUE INDEX sr_unique ON send_recipients (manifest_id, address);
CREATE INDEX sr_by_manifest ON send_recipients (org_id, manifest_id);
-- The outbox lists sends with a mixed outcome first; a partial index keeps that from scanning the rest.
CREATE INDEX sr_bounced ON send_recipients (org_id, manifest_id) WHERE delivery_state = 'bounced';

-- Every event, kept.
--
-- The primary key is the provider's own eventId, which is what makes at-least-once queue delivery safe:
-- a redelivered event loses on INSERT rather than applying twice. Same shape as #9's inbound receipts and
-- the audit chain — the conflict is the signal.
--
-- Stored rather than folded into send_recipients and discarded, for two reasons. A deferred event is
-- followed by a bounce or an acceptance, and the sequence is the evidence for what the Node believed
-- when; and an event that cannot be attributed to any manifest must be kept, or an unattributed bounce
-- becomes silence.
CREATE TABLE send_recipient_events (
  event_id             TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL,
  -- NULL when the event could not be matched to a manifest. Not an error, and not discardable:
  -- a bounce nobody can attribute is still a bounce, and it must be visible.
  manifest_id          TEXT,
  recipient            TEXT NOT NULL,
  -- The provider's type verbatim: cf.email.sending.message.bounced and so on. Not normalised, so a new
  -- event type Cloudflare adds is recorded rather than rejected.
  event_type           TEXT NOT NULL,
  -- Cloudflare's own message handle. Measured byte-identical to what send() returned, angle brackets
  -- included (receipt: email-sending-events.md) — which is why attribution is a key and not a heuristic.
  transport_message_id TEXT,
  terminal             INTEGER NOT NULL,
  payload              TEXT NOT NULL,
  received_at          TEXT NOT NULL
);

CREATE INDEX sre_by_manifest ON send_recipient_events (org_id, manifest_id);
-- Unattributed events are the ones a person has to go and look at, so they get their own index rather
-- than a scan.
CREATE INDEX sre_unattributed ON send_recipient_events (org_id, received_at) WHERE manifest_id IS NULL;

-- The join the event consumer performs, and it had no index at all: transport_message_id was written by
-- dispatch and never read back. Without this, every arriving event scans send_manifests.
CREATE INDEX sm_by_transport_id ON send_manifests (transport_message_id);
