-- Per-act recording and the employee notice: the half of blueprint 7 that 0023 named absent
-- (#63 part B, #61, Layer 5). Additive under #10's expand/contract: one new table, three new
-- indexes, one index widened by a DROP INDEX / CREATE INDEX pair. No DROP TABLE, no DROP COLUMN,
-- no column rewrite, no bookmark gate.
--
-- ## What 0023 left, and what this closes
--
-- 0023 built the authorization: a matter that can close, and a time-boxed grant that cites one. It
-- deliberately built neither of the two things blueprint 7 also requires, and said so in its own
-- text: **no per-act recording** (every query, result opened and attachment read) and **no
-- notification rows** (the notice due to the person whose mail was read, after the matter closes).
-- Both arrive here, and they arrive together because the second is computed from the first: the
-- notice tells somebody what was done, and what was done is what the three new audit actions record.
--
-- ## The collision this migration resolves, and the shape it chose
--
-- 0023's close does **not** revoke a live grant -- a grant's authority ends at its own expires_at
-- and nowhere else, because a cascade would be a second answer to "may this person still read".
-- That is sound, and it collides with blueprint 7: the notice is due *after the matter closes*, and
-- a close can precede the reading it describes. Left alone, a notice would tell somebody their mail
-- was read while it was still being read.
--
-- Two shapes were available. **Refusing the close while a grant citing the matter is live** was
-- rejected: closing is the act the notice hangs on, src/matters.ts deliberately lets an org.admin
-- close somebody else's matter *because the investigator is the party with a reason to delay it* --
-- and a live grant that only the investigator asked for would hand that delay straight back. There
-- is no revocation path by design, so the block could not even be cleared; the only remedy would be
-- waiting out a deadline nobody may move. A notice that never becomes due is worse than a late one.
--
-- So: **hold the notice.** due_at is never earlier than the instant the reading stopped. For a grant
-- citing a matter that is max(the matter's closed_at, the grant's own expires_at), computed in the
-- close's own transaction; for a grant citing nothing it is the grant's expires_at, known when the
-- grant takes effect. "After the matter closes" therefore means after the reading actually stopped,
-- which is what the sentence was for.
--
-- ## Why a row and not a Workflow, restated here because this is the table
--
-- docs/receipts/workflow-provisioning.md records that a Workflow instance is **not a durable
-- record**: state is retained 3 days on Free and 30 on Paid, configurable per instance. A matter can
-- stay open for months. A DO alarm is worse -- wrangler.jsonc already records its absorbing failure
-- state, *stop re-arming and nothing external notices, ever*, which is precisely wrong for an
-- obligation that must not be suppressible.
--
-- The deciding property is that **doctor can count rows and cannot see inside a sleeping instance.**
-- A row that is due and undelivered is a number; an instance silently culled by retention and one
-- patiently waiting look identical from outside. Suppressing a notice now means deleting an audited
-- row -- and doctor's supervision_notice_missing finding compares the count of supervised.granted
-- entries in the hash-linked trail against the rows here, so the deletion is loud.

-- A durable obligation to tell somebody something, and the queue the one-minute cron drains.
--
-- Two kinds share this table because #61 asked for exactly that: its resolution deferred its own
-- notification to #63 and said an approval request should be a row here with due_at now, delivered
-- by the same scan -- one mechanism rather than a second invention alongside it.
CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,  -- ntf_<ulid>
  org_id       TEXT NOT NULL,

  -- What this notice is about. The declared set is NOTIFICATION_KINDS in src/notifications.ts,
  -- constrained the same way and for the same reasons as matters.type and supervised_grants.scope
  -- one migration back: SQLite cannot add a CHECK with ALTER TABLE, a trigger cannot exist in this
  -- tree because src/migrate.ts splits migrations on semicolons, and recreating the table would need
  -- a DROP TABLE that test/node/content-deletion-world.test.ts refuses in migrations/. The union is
  -- the constraint and test/node/matter-and-scope-world.test.ts makes it one.
  --
  --   supervised_read    blueprint 7's notice to the person whose mail was read.
  --   approval_request   #61's: somebody is being asked to decide.
  kind         TEXT NOT NULL,

  -- The row this notice is about: a supervised_grants id, or an approvals id. No foreign key,
  -- because this schema declares none anywhere.
  subject_id   TEXT NOT NULL,

  -- Who is told, and the two addressing modes are the reason this column is nullable.
  --
  --   NOT NULL   exactly this person. #61's approval requests, one row per eligible decider, so the
  --              set is frozen at the instant of asking rather than recomputed later.
  --   NULL       everybody holding a standing mailbox.content.read on mailbox_id, resolved **live**
  --              when the feed is read.
  --
  -- The NULL form is what blueprint 7's notice needs, and it was chosen rather than settled for. A
  -- Mailda mailbox has no single owner column -- it is shared by construction (Layer 3) -- so "the
  -- employee whose mail was read" is, on this Node, whoever the mailbox belongs to. Freezing that
  -- set at grant time would tell somebody who has since left and stay silent to whoever took the
  -- mailbox over; resolving it live tells the people whose mail it is now.
  --
  -- **The investigator is structurally excluded from that set**, and this is the property "cannot be
  -- switched off by the investigator" rests on: a supervised grant is a supervised_grants row, never
  -- a relationship_tuples one, so a supervised reader never satisfies the EXISTS the feed applies.
  user_id      TEXT,

  -- The mailbox the notice is about; the addressing key for the NULL user_id form. NULL for an
  -- approval request addressed to a named person.
  mailbox_id   TEXT,

  -- The matter, copied from the grant when it takes effect. Copied rather than joined because it is
  -- what decides **when** this notice becomes due, and the scan must not have to join to find out.
  -- NULL means either "no matter was cited" or "this is an approval request"; in both cases due_at
  -- is written at insert time and never moves.
  matter_id    TEXT,

  created_at   TEXT NOT NULL,

  -- When this becomes deliverable. **NULL means not yet due**, and nothing else.
  --
  --   approval_request                created_at. Somebody is waiting on a decision now.
  --   supervised_read, no matter      the grant's own expires_at: the only end that exists.
  --   supervised_read, matter open    NULL until the matter closes, then
  --                                   max(matter.closed_at, grant.expires_at) -- the collision
  --                                   resolved at the top of this file.
  --   supervised_read, matter         max(matter.closed_at, grant.expires_at), written when the grant
  --   already closed                  takes effect. Not symmetry: a matter can close while the grant
  --                                   citing it is still waiting for its second approver, and without
  --                                   this arm that notice was left NULL with nothing that would ever
  --                                   write it -- suppressed, permanently, with no audited row deleted
  --                                   and by the one party section 7 names. doctor's
  --                                   supervision_notice_stranded counts the state.
  --
  -- A matter left open therefore defers its notices indefinitely. That is blueprint 7's own shape
  -- rather than a gap in this one -- pre-close confidentiality is what makes the notice meaningful,
  -- and src/matters.ts already lets any org.admin close somebody else's matter precisely because the
  -- investigator is the party with a reason not to.
  due_at       TEXT,

  -- When the cron scan delivered it. NULL means owed.
  --
  -- The scan is what makes "delivered" a fact about the Node rather than about whether anybody
  -- happened to look. The person whose mail was read may never sign in again -- departure_handover
  -- is one of the matter types -- and a notice that only exists while its recipient is looking at it
  -- is not a notice. This column is also the only thing that makes "overdue" computable, which is
  -- what doctor counts.
  delivered_at TEXT,

  -- What the notice says, frozen as JSON at delivery.
  --
  -- Computed once rather than joined on every read, for two reasons that pull the same way: a notice
  -- must say the same thing for ever, and reading the feed must not re-aggregate an audit trail that
  -- is never trimmed. What goes in it is decided in src/notifications.ts, which argues the
  -- disclosure -- counts of what was done, the reader's identity, the scope and the window, and
  -- deliberately **not** the matter's description or a list of message ids.
  body         TEXT
);

-- The scan's index. Partial on delivered_at IS NULL, which is #11's shape and every migration since
-- 0019 reuses: once a notice is delivered it leaves this index for ever, so the cron's cost is
-- proportional to what is **owed** rather than to everything that was ever owed. On a Node that is
-- up to date the seek reads nothing.
CREATE INDEX ntf_due ON notifications (org_id, due_at) WHERE delivered_at IS NULL;

-- One person's feed, most recent first. org_id first like every other index in this schema.
CREATE INDEX ntf_feed ON notifications (org_id, user_id, due_at);

-- The close's index: the notices whose due date this matter's close settles. Partial on the same
-- predicate the UPDATE carries, so a matter that has already had its notices dated costs a seek into
-- nothing. 0023 said "nothing indexes matter_id ... part B's notification does, and it arrives with
-- the index it needs" -- this is it, on the table that actually asks the question.
CREATE INDEX ntf_pending_matter ON notifications (org_id, matter_id) WHERE due_at IS NULL;

-- ## sgr_live gains the grant's own id, and that is a measured decision rather than tidiness
--
-- Part B records **which grant** authorized each supervised act, so the authorization check has to
-- return the grant id rather than a bare 1. Without id in the key, SQLite has to read the table row
-- to fetch it -- the plan stops saying COVERING, and docs/receipts/authz-check-rows-read.md's
-- correction claims covering in print. One trailing key column keeps the claim true.
--
-- The cost is one wider index entry per grant, and grants are minted by a ceremony involving three
-- people. DROP INDEX rather than a second index beside it: two overlapping indexes on one table is
-- dead weight under a comment claiming it is load-bearing, which is the exact defect 0023 recorded
-- when it deleted the self-grant index nobody's planner chose. DROP INDEX is deliberately outside
-- content-deletion-world.test.ts's scan, which that file states and asserts.
DROP INDEX sgr_live;

CREATE INDEX sgr_live
  ON supervised_grants (org_id, subject_id, mailbox_id, scope, expires_at, granted_at, id)
  WHERE granted_at IS NOT NULL;
