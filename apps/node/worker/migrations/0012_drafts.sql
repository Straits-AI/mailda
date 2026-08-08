-- A draft that survives a reload, because the interface has been telling people it does not.
--
-- The composer's first phase reads "this browser only · a reload loses it". That was the honest wording
-- for a draft living in React state, and #32 named it as the thing a user would be angriest to lose. The
-- middle phase it also named — "saved on your node" — was deliberately absent, because a label claiming
-- durability that did not exist would be the interface lying about where somebody's bytes are. This is the
-- table that earns the label.
--
-- ## The body is not in this table
--
-- Every other piece of customer *content* on this Node is encrypted at rest in R2, with D1 holding metadata
-- and a pointer (§12, ADR 28). A draft body is content — it is the message, before it becomes one — so
-- putting it in a D1 column would carve out an exception to the one promise the product is built on, for
-- the convenience of the feature that needed it least. `body_key` points at an R2 object written through
-- the same `putEvidence` path as accepted mail, under the Node's own key.
--
-- The key is **stable per draft**, so an autosave overwrites rather than accumulating an object per
-- keystroke. That bounds storage to one object per draft and keeps the R2 operation count proportional to
-- editing pauses rather than to typing.
--
-- ## Why a draft is not evidence
--
-- It is working state, and it is deleted when the message is sealed: from that moment the manifest and its
-- submitted bytes are the record (§12), and a leftover draft would be a second, divergent account of the
-- same message. Nothing here is hash-chained and nothing here is audited — a draft is not an act with an
-- effect anybody else can see, and one audit entry per save would put hundreds behind a single human
-- action, falsifying `audit-and-log-retention.md`'s sizing as a side effect of an autosave.

CREATE TABLE drafts (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL,

  -- From is the mailbox (ADR 36), so a draft belongs to one and cannot be composed without it.
  mailbox_id              TEXT NOT NULL,
  -- Who is writing. Not who it will be *from* — that is the mailbox — but the person whose unfinished work
  -- this is, and the only person entitled to read it back until Layer 3 decides what sharing a draft means.
  author_user_id          TEXT NOT NULL,

  -- Set when this draft is a reply. Kept so resuming a draft resumes the thread, rather than sending a
  -- correctly-worded reply that threads as a new conversation.
  in_reply_to_message_id  TEXT,

  -- Recipients as authored, JSON arrays of strings. Stored as typed rather than parsed into rows: a draft
  -- is allowed to contain a half-written address, and a schema that could not represent one would force
  -- the interface to either reject it or silently discard it.
  to_addresses            TEXT NOT NULL,
  cc_addresses            TEXT,
  bcc_addresses           TEXT,

  subject                 TEXT NOT NULL,

  -- The body's R2 object, encrypted at rest like any other content. NULL while the body is still empty,
  -- which is different from an empty object: it means nothing has been written, and it avoids an R2 write
  -- for a draft somebody opened and abandoned.
  body_key                TEXT,
  body_sha256             TEXT,
  -- Kept in D1 so a draft list can say how much is there without reading every object out of R2.
  body_bytes              INTEGER NOT NULL DEFAULT 0,

  created_at              TEXT NOT NULL,
  -- What the interface shows as "saved on your node", so it must be the moment the write committed.
  updated_at              TEXT NOT NULL
);

-- The list a person resumes from: their own drafts, newest first.
CREATE INDEX drafts_by_author ON drafts (org_id, author_user_id, updated_at DESC);

-- One draft per reply, per author. Replying to the same message twice should resume the draft that already
-- exists rather than quietly starting a second one and leaving the first to rot — and without this the
-- interface would have to guess which of them to open.
--
-- Partial, because `in_reply_to_message_id` is NULL for a new message and SQLite treats every NULL as
-- distinct: a person may have as many unrelated new messages in progress as they like.
CREATE UNIQUE INDEX drafts_one_per_reply
  ON drafts (org_id, author_user_id, in_reply_to_message_id)
  WHERE in_reply_to_message_id IS NOT NULL;
