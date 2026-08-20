-- eDiscovery export: the supervised bulk copy, and the permission that governs the single-message one
-- (#65, blueprint 7 and 22, Layer 5). Additive (#10 expand/contract): one new table, three new indexes,
-- one backfill of an existing table. No DROP TABLE, no DROP COLUMN, no column rewrite, no bookmark gate.
--
-- ## What an export is, in one sentence, because the word is used for two different acts
--
-- Blueprint 698 and 709 declare `message.export` and `ediscovery.export` **separately**, and this file is
-- where that separation becomes real:
--
--   message.export      one message's original .eml, off the Node, by somebody who already reads the
--                       mailbox. No matter, no approval, no ceremony -- and, from this migration onwards,
--                       a record. Governed by a relationship_tuples row like every other mailbox relation.
--   ediscovery.export   a bounded set of messages, copied to sealed objects under a new R2 prefix, for a
--                       named matter, after two people who are not the requester agreed to a canonical
--                       predicate hash and a hard message count. That is what the table below carries.
--
-- Requiring a matter for an ordinary .eml was rejected on #65: it turns forwarding a message into a
-- governance ceremony, and the predictable result is screenshots and copy-paste -- a worse disclosure with
-- no record at all. So the smaller door gets a permission and a trail; the larger one gets the ceremony.
--
-- ## Why the approval binds a hash AND a count, which is the decision this table is shaped by
--
-- 18 (blueprint 1741) binds an approval to "target resource and expected version" plus "referenced artifact
-- hashes", and #62 made the pre-execution recheck re-hash every bound object. An export's target is a
-- **query**, and a query has no version. A predicate can be canonicalised and hashed -- mailbox, date range,
-- query string, in a fixed key order -- so `predicate_sha256` is a real bound object that a recheck can
-- re-derive and compare.
--
-- What a predicate hash cannot do is bound what it **matches**. The same predicate returns more next week, so
-- approving a predicate alone approves an unbounded future disclosure with a recheck that passes cleanly.
-- `max_messages` closes that, and it fails closed: a run that would exceed it aborts and needs a fresh
-- approval rather than quietly exporting more than anyone agreed to.
--
-- Enumerating message ids instead was rejected on two grounds. It inverts the ceremony -- the investigator
-- has to read the mail to decide what to ask permission to export -- and #63 measured the audit detail cap at
-- about 59 typed-prefix ULIDs per entry, so a large export's own approval would need paginating.
--
-- ## Progress lives here, not in the trail
--
-- 1276 requires outright that "search, export, retention, reindex and migration use resumable
-- cursors/checkpoints", so the driver is a cursor and this table carries it. Page progress is deliberately
-- **not** an audit entry: one entry per page would put hundreds of rows behind one act and falsify
-- `audit-and-log-retention.md`'s "a handful per message" sizing, which is the same argument that keeps
-- `send_recipients` unaudited. Two entries per export reach the trail -- `supervised.export_requested` when
-- the approval completes and `supervised.export_completed` when the manifest exists -- plus
-- `supervised.export_aborted` for a run stopped at its bound.
--
-- And resumability is what dissolves the plan arithmetic. A checkpointing run does not need to know its
-- budget in advance: it works until the budget is spent and continues in a fresh instance. The Paid/Free
-- split therefore changes how many instances an export takes, not whether it finishes (#68 is filed and does
-- not block this). What still refuses in advance is `max_messages` against the manifest boundary -- see
-- `src/exports.ts`, which names the boundary rather than working around it (1280).

CREATE TABLE exports (
  -- `exp_<ulid>`. Cited by every object this export stages, by its manifest, and by both audit entries.
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,

  -- **NOT NULL, unlike `holds.matter_id` and `supervised_grants.matter_id`**, and the asymmetry is the
  -- decision rather than an inconsistency. Those two exist because the realistic first act -- preserve this
  -- mailbox, look at it now -- precedes anybody deciding what the matter is, and requiring one would produce
  -- matters named "unknown" within a week. A bulk export is the opposite shape: it is never the first act,
  -- it is always downstream of a matter somebody already opened, and 7 hangs the notice to the people whose
  -- mail was copied on that matter closing. An export citing nothing would be a copy with no purpose to
  -- notice against.
  matter_id        TEXT NOT NULL,

  -- The mailbox the predicate is over, and the mailbox whose `approval.decide` holders decide the approval.
  -- One mailbox per export: a predicate spanning two would need two eligible sets and could be approved by
  -- people with authority over only half of what it copies.
  mailbox_id       TEXT NOT NULL,
  -- The person who asked, and therefore the one person who may never approve it (18's separation of duty,
  -- applied by `planApproval` rather than restated here).
  requested_by     TEXT NOT NULL,

  -- The canonical predicate as stored bytes, and its SHA-256. Both, because the recheck re-derives the hash
  -- from the text and compares: storing only the hash would make a mismatch unexplainable, and storing only
  -- the text would put the canonicalisation rules in the comparison path on every recheck.
  predicate        TEXT NOT NULL,
  predicate_sha256 TEXT NOT NULL,

  -- The hard bound the two approvers agreed to. Exceeding it aborts the run; it is never clamped, because a
  -- clamp would export a prefix of what matched while reporting success.
  max_messages     INTEGER NOT NULL,

  -- The R2 prefix objects are staged under: `<org>/exports/<export id>/`. Stored rather than derived at read
  -- time so the audit entry, the reconciler's referent rule and the download route all name one string --
  -- and so an export written under an older layout stays readable if the layout ever changes.
  destination      TEXT NOT NULL,

  --   requested   the approval is open, or was denied. Nothing has been staged. **A run in this state
  --               produces nothing**: `runExport` requires an approved approval before its first page.
  --   running     at least one page has been emitted and the cursor is live.
  --   completed   every matching message was emitted and the manifest object exists.
  --   aborted     the run stopped without a manifest. `state_reason` says why, and the only reason this
  --               Node produces is `max_messages`.
  -- No CHECK constraint, for `approvals.subject_kind`'s reason: SQLite cannot add one with ALTER TABLE and a
  -- trigger cannot exist in this tree because `src/migrate.ts` splits migrations on semicolons. The
  -- TypeScript union in `src/exports.ts` is the constraint and `test/node/matter-and-scope-world.test.ts`
  -- is what makes it one.
  state            TEXT NOT NULL,
  -- NULL means "this run has not refused anything". Set only alongside `state = 'aborted'`, and it carries
  -- the token rather than a sentence so a reader can filter on it; the sentence is in the audit entry.
  state_reason     TEXT,

  -- The resumable checkpoint (1276): the `(accepted_at, receipt id)` pair the next page resumes **strictly
  -- after**, encoded as one string so the ordering is one comparison. NULL means no page has run yet, which
  -- is a different answer from "the cursor is at the beginning" only in that it is also true before the
  -- approval completes.
  cursor_after     TEXT,
  -- Pages, and messages, so an interrupted export can say how far it got without listing R2. Both are
  -- advanced in the same statement as the cursor, so a cursor that moved without its count is not
  -- representable.
  pages_done       INTEGER NOT NULL,
  messages_emitted INTEGER NOT NULL,

  requested_at     TEXT NOT NULL,
  -- NULL until the first page runs. It is not the approval's instant: an approved export that nobody has
  -- run yet has staged nothing, and reporting a start for it would overstate what left the Node.
  started_at       TEXT,
  -- NULL until the run reaches a terminal state. Set for both `completed` and `aborted`, because both are
  -- ends -- an aborted export is not still running, and treating it as though it were is how a run nobody
  -- can finish reads as work in progress.
  completed_at     TEXT,

  -- NULL until `completed`. The manifest is its own sealed object under the same prefix, and its SHA-256 is
  -- over the **manifest plaintext**, not over the sealed bytes: sealing is envelope-encrypted with a random
  -- nonce, so the sealed bytes differ on every write and a hash over them could not be re-derived by anybody
  -- verifying the export later. Same reason `ingress_receipts.blob_sha256` hashes the plaintext.
  manifest_key     TEXT,
  manifest_sha256  TEXT
);

-- The listing, and `doctor`'s read. `requested_at` second because every question about exports is ordered by
-- when they were asked for, and putting it in the index means the ordering is read out of it rather than
-- sorted afterwards. It is also the prefix the reconciler's referent query consumes -- one bulk
-- `SELECT id FROM exports WHERE org_id = ?`, which is why adding this prefix to the scan costs one
-- subrequest rather than one per listed object.
CREATE INDEX exp_org ON exports (org_id, requested_at);

-- "Which exports could still be resumed": the question a run and a sweep both ask. Partial on the terminal
-- states being absent, so on a Node with a thousand finished exports the index holds only the live ones --
-- the same shape `sgr_live` and `apr_pending` already use, and for the same reason: the set that matters is
-- the small one.
CREATE INDEX exp_runnable ON exports (org_id, state) WHERE completed_at IS NULL;

-- One export per approval, from the other direction. `approvals` already has `apr_subject` over
-- (org_id, subject_kind, subject_id); this is the index that makes "is this export approved" a seek on the
-- export's own id when the run rechecks its grant on **every page**. Without it the per-page recheck would
-- scan the approvals of every subject kind in the organization, which is the cost that decides whether a
-- per-page recheck is affordable at all.
CREATE INDEX exp_approval ON exports (org_id, id, state);

-- ## The backfill, and why this migration writes a table it did not create
--
-- `message.export` is a new relation, and `GET /api/messages/:id/raw` now requires it. Every Node already
-- deployed has people who can download an .eml today because they hold `mailbox.content.read`, and Layer 1's
-- own proof is "a real message from outside, visible in the web UI, original .eml exportable". Shipping the
-- check without the grant would break that on every existing install -- a regression with a roadmap
-- attached, which AGENTS.md's ladder rule forbids outright.
--
-- So the relation arrives already held by exactly the people who could already do the act. What it buys is
-- that it is now **separately revocable**: an administrator can take away the ability to take copies off the
-- Node while leaving the ability to read the mailbox, which was not expressible before, and every download
-- through that door is now recorded as `message.exported`.
--
-- `INSERT OR IGNORE` against `rt_unique` (org_id, subject_id, object_type, relation, object_id), so this is
-- idempotent even though the ledger already makes it run once. The derived id keeps the source tuple's ULID
-- and changes its prefix -- `rtx_` for "a tuple this migration derived" -- so the backfilled rows are
-- distinguishable from granted ones in the trail they do not have. `created_at` is copied from the source
-- rather than set to the migration's instant, because the authority is exactly as old as the read relation
-- it was derived from and pretending otherwise would date every existing install's export permission to the
-- day it upgraded.
INSERT OR IGNORE INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
SELECT 'rtx_' || substr(t.id, 4), t.org_id, t.subject_id, 'message.export', 'mailbox', t.object_id, t.created_at
  FROM relationship_tuples t
 WHERE t.object_type = 'mailbox' AND t.relation = 'mailbox.content.read';
