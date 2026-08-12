-- Layer 3's spine: a conversation to group by, and a case to work.
--
-- Both shapes were decided on the wayfinder map before any of this was written. What each column is for is
-- recorded here; *why* it beat the alternative is in the ticket named beside it.

-- ## Conversations (#38)
--
-- Identity is this Node's own id, not the sender's `thread_root_rfc_id`. A case's identity must not derive
-- from a header an outside party controls: group directly on the sender's root and a broken or spoofed
-- `References` moves a message into a different case. Owning the id means a bad header changes only the
-- *join*, which is repairable.
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,          -- cnv_<ulid>
  org_id        TEXT NOT NULL,

  -- The sender's root: the join key, deliberately not the identity. NULL is legal, and means a message
  -- arrived with no readable Message-ID at all (§24 keeps it, visibly unparsed) — such a conversation can
  -- never be joined by a later reply, which is the honest consequence of having nothing to join on.
  root_rfc_id   TEXT,

  -- How this grouping came about. `root` is the join; `manual` is a human merge. There is deliberately no
  -- `subject` value: subject matching is a guess about identity whose failure puts one customer's message
  -- inside another's case, and fragmentation is the visible, fixable error instead. A heuristic, if it ever
  -- arrives, is a third value with its own receipt — never a change to what `root` means.
  grouped_by    TEXT NOT NULL,

  -- Set when this conversation was merged away (#43). The row is kept rather than deleted, because merge is
  -- an audited act and the trail must not disagree with the data about whether there used to be two.
  -- Resolved to the terminal conversation at write time, so this chain is always length 1 and no read walks
  -- it.
  merged_into   TEXT,

  created_at    TEXT NOT NULL
);

-- The join a later reply performs. Partial, because a NULL root joins nothing and indexing those wastes
-- space on rows the lookup can never match.
CREATE UNIQUE INDEX cnv_by_root
  ON conversations (org_id, root_rfc_id)
  WHERE root_rfc_id IS NOT NULL AND merged_into IS NULL;

ALTER TABLE messages ADD COLUMN conversation_id TEXT;
CREATE INDEX msg_by_conversation ON messages (org_id, conversation_id, sent_at);

-- ## Cases (#38, #40)
--
-- One case per conversation **per mailbox**, which is the refinement #38 made to the charted 1:1. §12
-- invariant 3 evaluates access per delivery, so a single case spanning `support@` and `billing@` would be
-- partially visible to its own holder — judging an SLA on messages they cannot see — and the rail could not
-- attribute it to a queue without picking one arbitrarily. Grouping is a fact about mail and spans the
-- organization; ownership of work is a fact about a queue and does not.
CREATE TABLE cases (
  id              TEXT PRIMARY KEY,        -- cas_<ulid>
  org_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  mailbox_id      TEXT NOT NULL,

  -- open | claimed | closed. Three, and nothing else at this layer: `waiting-on-customer` only earns a
  -- state if it changes what an SLA clock does, which is still undecided, and adding it now would decide
  -- that from the outside.
  state           TEXT NOT NULL,
  state_at        TEXT NOT NULL,

  -- The claim. NULL is unclaimed, and it is the guard the compare-and-swap tests — `WHERE assignee IS NULL`
  -- — so contention needs no Durable Object: D1 is SQLite, the UPDATE is atomic, and `changes = 0` means
  -- somebody else won. The same pattern as the audit sequence and the migration-ledger race: the conflict
  -- *is* the signal.
  assignee        TEXT,
  -- Shown to a person and **never enforced** (#40). There is no timeout: an expiry is a policy guess
  -- dressed as a limit, while a claim's age is a fact, so the queue displays how long it has been held and
  -- a colleague judges whether that is stale. Stealing is the remedy, and it is audited.
  claimed_at      TEXT,

  created_at      TEXT NOT NULL
);

-- The refinement, enforced rather than described. Two cases over one conversation in one mailbox is the
-- state the whole per-mailbox model exists to prevent.
CREATE UNIQUE INDEX cas_unique ON cases (conversation_id, mailbox_id);

-- The queue read: one mailbox's work, unclaimed first, oldest first. This is what the rail counts and what
-- variant B's rail was chosen to carry.
CREATE INDEX cas_queue ON cases (org_id, mailbox_id, state, created_at);
-- Everything one person is holding, for "what am I working on".
CREATE INDEX cas_by_assignee ON cases (org_id, assignee) WHERE assignee IS NOT NULL;
