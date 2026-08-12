-- Puts the mail that already arrived into a queue.
--
-- 0014 added `conversations` and `cases` and wired them into the *ingress* path, so Layer 3 could only see
-- mail arriving after it was deployed. Everything already accepted had `conversation_id` NULL, no
-- conversation and no case — an inbox with five messages and a queue with none, which reads as a broken
-- feature rather than a new one.
--
-- ## What state a backfilled case starts in, and why there is only one honest answer
--
-- `open`, unclaimed. Anything else asserts something nobody did: `claimed` would invent a holder, and
-- `closed` would declare work finished on the strength of it being old. A backfilled case is exactly as
-- unhandled as the mail was before this ran.
--
-- `created_at` comes from **the mail**, not from the migration, because the queue orders by it — stamping
-- everything with the migration's timestamp would present a year of history as having all arrived at once,
-- and the ordering is the thing a person reads a queue by.
--
-- ## Deterministic ids, because SQLite cannot mint a ULID
--
-- Same constraint 0009 and 0015 hit, same shape. A conversation's id derives from **the earliest message
-- sharing its root**, not from any one message, so messages that belong together land in one conversation
-- rather than one each. That is the whole point of grouping and it is the part a naive per-message backfill
-- would get wrong.
--
-- Every statement is `INSERT OR IGNORE` or guarded by `IS NULL`, so re-running this is a no-op — a migration
-- must be idempotent under retry, and this one may also run after some cases already exist.
--
-- ## What it deliberately does not do
--
-- It does not group by subject. The live rule refuses that (`conversations.ts`) because subject matching is
-- a guess whose failure puts one customer's message inside another's case, and a backfill inherits the rule
-- rather than being allowed a looser one — a historical mis-group is no more repairable than a live one.

-- 1. One conversation per distinct root. `MIN(id)` makes the id deterministic *and* shared by every message
--    under that root.
INSERT OR IGNORE INTO conversations (id, org_id, root_rfc_id, grouped_by, merged_into, created_at)
SELECT
  'cnv_backfill_' || substr(MIN(m.id), 5, 26),
  m.org_id,
  m.thread_root_rfc_id,
  'root',
  NULL,
  MIN(m.received_at)
FROM messages m
WHERE m.conversation_id IS NULL AND m.thread_root_rfc_id IS NOT NULL
GROUP BY m.org_id, m.thread_root_rfc_id;

-- 2. A message whose root could not be read joins nothing, now or ever, so it gets its own conversation —
--    the same answer the live path gives, and the same visible fragmentation a person can merge later.
INSERT OR IGNORE INTO conversations (id, org_id, root_rfc_id, grouped_by, merged_into, created_at)
SELECT
  'cnv_backfill_' || substr(m.id, 5, 26),
  m.org_id,
  NULL,
  'root',
  NULL,
  m.received_at
FROM messages m
WHERE m.conversation_id IS NULL AND m.thread_root_rfc_id IS NULL;

-- 3. Point the messages at them.
UPDATE messages SET conversation_id = (
  SELECT c.id FROM conversations c
   WHERE c.org_id = messages.org_id
     AND c.root_rfc_id = messages.thread_root_rfc_id
     AND c.merged_into IS NULL
   LIMIT 1
)
WHERE conversation_id IS NULL AND thread_root_rfc_id IS NOT NULL;

UPDATE messages SET conversation_id = 'cnv_backfill_' || substr(id, 5, 26)
WHERE conversation_id IS NULL AND thread_root_rfc_id IS NULL;

-- 4. One case per (conversation, mailbox), driven by the deliveries that actually happened. A message
--    delivered to two mailboxes therefore gets two cases, which is the (conversation, mailbox) model applied
--    to history rather than a special rule for it.
INSERT OR IGNORE INTO cases
  (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at, created_at)
SELECT
  'cas_backfill_' || substr(MIN(i.id), 5, 26),
  m.org_id,
  m.conversation_id,
  i.mailbox_id,
  'open',
  MIN(i.created_at),
  NULL,
  NULL,
  MIN(i.created_at)
FROM mailbox_items i
JOIN messages m ON m.id = i.message_id
WHERE m.conversation_id IS NOT NULL
GROUP BY m.org_id, m.conversation_id, i.mailbox_id;
