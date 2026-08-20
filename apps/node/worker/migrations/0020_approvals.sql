-- Approvals: ordered stages with a count, and the decisions taken against them (#61, Layer 5, blueprint 18).
-- Additive (#10 expand/contract): four new tables and their indexes. No DROP, no column rewrite, no new column
-- on an existing table, no bookmark gate.
--
-- ## Ordered stages with a count express all three of blueprint 18's review shapes
--
-- 18 asks for sequential, parallel and dual review. They are not three features:
--
--   parallel    one stage of count 2
--   sequential  two stages of count 1
--   dual        either, depending on whether the order matters
--
-- The order is on the **stages**, not on the people, which is what dissolves the doubt #61 opened with: a set
-- defined by a relation has no natural sequence, and naming people in a policy would widen authority. Each
-- stage's membership stays derived from relations; only the stages themselves are ordered.
--
-- ## A stage carries a count and nothing else, and the absent constraint is named here
--
-- #61's resolution wanted one narrowing constraint on a stage -- "a member of team T" -- and it is **not
-- shipped**, deliberately, with the reason recorded rather than left as a gap:
--
--   team_members (0001_init.sql) is id, org_id, team_id, user_id, created_at, and it is **read-only in the
--   product**: three SELECTs in src/authz-read.ts, and nothing anywhere writes it. There is **no teams table
--   at all**, so a team has no name and no existence of its own; it is only an id that happens to appear in
--   membership rows.
--
-- So a team-scoped stage would be expressible and unusable: no team can be created through any surface, and
-- publication could not verify that a named team exists -- only that it currently has members, which is a
-- different question. That is #60's governing failure, which this repository has now hit four times: **a
-- condition backed by no data is a policy that silently never fires**. A nullable team_id that is always NULL
-- is the same defect wearing a column, so there is no such column. What would have to exist first: team
-- creation, membership management, and a decision about whether a team is a first-class object or stays an
-- implicit id. Tracked as #73 rather than remembered.
--
-- What this does not cost, said plainly: ordered stages of count 1 still give sequential review by two
-- distinct people in a fixed order, which is 18's sequential shape minus the team labels.
--
-- ## Distinctness is on user_id, and that is the subtle one
--
-- src/authz-read.ts:104 returns [userId, ...teamIds] as the subjects a principal authorizes as, so a relation
-- can be held **through a team**. The holder set is therefore a set of tuples while a decider is a person, and
-- one person wearing two team hats would satisfy a count of 2 if distinctness were measured at the tuple
-- layer. It is measured on user_id: apd_one_per_person below is the database's half of that, and
-- src/approvals.ts resolves tuples to people before counting.

-- A stage of a policy version: an ordinal and how many distinct decisions it takes.
--
-- Part of a version's frozen content, so it is covered by canonical_sha256 (src/policy.ts's
-- canonicalConditions) -- otherwise a publish that changed only the stages would be refused as "identical to
-- the published version", which is the one way this table could have made #49's no-op refusal lie.
--
-- Only require_approval versions have rows here. src/policy.ts refuses stages on any other outcome, because a
-- stage set nothing ever reads is the same silent-inertness failure as a condition backed by no data.
--
-- A require_approval version with **no rows here** means one stage of count 1: one decision by somebody other
-- than the author, which is the minimum the words "requires approval" can mean. That is also what every
-- version published before this migration means, which is why absence is a defined answer rather than a
-- missing one.
CREATE TABLE policy_stages (
  id                TEXT PRIMARY KEY,   -- pst_<ulid>
  org_id            TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,

  -- 1-based, in review order. Contiguity is a property of the single writer (src/policy.ts inserts one row
  -- per element of an array), **not** of this schema, and nothing here enforces it: readers order by this
  -- column rather than indexing into it, so a gap would degrade to "the stages in order" rather than to a
  -- wrong answer. Stated because a claim about contiguity would be a claim nothing checks.
  ordinal           INTEGER NOT NULL,
  -- Distinct decisions required at this stage, at least 1. No upper bound is written here: what bounds it is
  -- the eligible set, checked at publication and again at evaluation, which is a real quantity rather than a
  -- number somebody would have to justify with a receipt.
  required_count    INTEGER NOT NULL,

  created_at        TEXT NOT NULL
);

-- One stage per ordinal per version, which is what makes "the stages in order" a well-defined sequence: two
-- rows claiming stage 2 would be an order with a tie, and a tie in a review order is not a review order.
-- Also the read path: stages of a version, in order.
CREATE UNIQUE INDEX pst_ordinal ON policy_stages (policy_version_id, ordinal);

-- One approval: the request that a manifest be decided on, and where its lifecycle lives.
--
-- ## Why the manifest is not enough on its own
--
-- The manifest already carries the gate (state awaiting, state_reason policy_approval_required). What it
-- cannot carry is the *fold*: several require_approval policies may match one send, so the stage set an
-- approver faces is a fact about **this seal** rather than about any single policy version -- max(count) per
-- ordinal over every matching version, the same maximum #60 uses to resolve conflicting outcomes. Recomputing
-- it later would mean re-deriving which policies matched, and send_manifests.policy_versions is a JSON record
-- nothing joins on. So the fold is materialised once, here, at request time.
--
-- It is also the row the completion transition updates conditionally, which is what settles the
-- withdraw-versus-final-approval race (#9 -- the conflict is the signal).
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,   -- apr_<ulid>
  org_id          TEXT NOT NULL,
  manifest_id     TEXT NOT NULL,

  -- Copied from the manifest at request time, because every question this table answers needs them and a join
  -- to send_manifests on each one would be a second read of a row that cannot change: the mailbox decides who
  -- is eligible, and the author is the one person who never is.
  mailbox_id      TEXT NOT NULL,
  author_user_id  TEXT NOT NULL,

  -- pending | approved | denied | unsatisfiable | cancelled
  --
  --   pending        stages remain unsatisfied and somebody eligible can still decide.
  --   approved       every stage satisfied by distinct people. The send returned to held.
  --   denied         one eligible person denied. Terminal -- re-seal is the only remedy, which is the
  --                  invalidation mechanism Layer 5's answer 1 already rests on.
  --   unsatisfiable  a withdrawal left fewer eligible people than the stages need. The send was withheld
  --                  with approval_unsatisfiable rather than parked, because a request nobody can decide is
  --                  not pending.
  --   cancelled      the author cancelled the send while the request was open. Written by cancelSend in the
  --                  same transaction as the manifest, because a request whose send no longer exists is dead
  --                  work in an approver's queue -- and because the decision path's conditional UPDATE keys
  --                  on this column, so leaving it pending let an approval of a cancelled send report the
  --                  send as released.
  --
  -- There is no withdrawn state: withdrawal is an act on one **decision**, not on the request. An approver
  -- who withdraws leaves the request open for whoever else is eligible -- which is the whole point of the
  -- asymmetry #61 chose, since the alternative remedy is persuading a colleague to deny and so recording
  -- somebody else's judgement in a trail whose value is that it does not do that.
  state           TEXT NOT NULL,

  requested_at    TEXT NOT NULL,
  -- NULL exactly while state is pending. A resolved_at with no terminal state, or a terminal state with no
  -- resolved_at, is a row src/approvals.ts cannot produce: both are written by the same UPDATE.
  resolved_at     TEXT
);

-- One approval per manifest. A second would be two answers to one question, and re-sealing already mints a
-- new manifest id (ADR 35), so "ask again" has a representation that does not need this to be relaxed.
-- Also the lookup #62's recheck needs: the approval of a manifest, in one query.
CREATE UNIQUE INDEX apr_manifest ON approvals (manifest_id);

-- The queue an approver reads. Partial on pending, the shape #11 established for the authorization path: a
-- decided approval falls out of the index entirely, so the index holds exactly the outstanding set rather
-- than the whole history of everything ever approved.
CREATE INDEX apr_pending ON approvals (org_id) WHERE state = 'pending';

-- The stage set this approval was requested with: the fold, frozen at request time.
--
-- Frozen rather than read through to policy_stages on every decision. Publishing a new policy version must not
-- change what an approver already in the middle of deciding was asked for -- #60 rejected re-evaluating
-- in-flight sends on publication for the same reason, that it "changes the question under an approver
-- part-way through deciding".
CREATE TABLE approval_stages (
  id             TEXT PRIMARY KEY,   -- ast_<ulid>
  org_id         TEXT NOT NULL,
  approval_id    TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  required_count INTEGER NOT NULL
);

-- One stage per ordinal, for the same reason as pst_ordinal, and the read path for "which stage is current".
CREATE UNIQUE INDEX ast_ordinal ON approval_stages (approval_id, ordinal);

-- One decision by one person against one stage.
--
-- Rows are never deleted and never rewritten except to withdraw. A withdrawal sets withdrawn_at; it does not
-- remove the row, because "I approved this and then withdrew it" is a fact an investigation asks about and
-- a deletion would answer with silence.
CREATE TABLE approval_decisions (
  id              TEXT PRIMARY KEY,   -- apd_<ulid>
  org_id          TEXT NOT NULL,
  approval_id     TEXT NOT NULL,

  -- Which stage this decision was taken against, resolved at the moment it was taken. Recorded rather than
  -- derived, because the current stage moves as decisions arrive: a decision that only said "approve" would
  -- be unattributable to the stage it satisfied the moment a later stage opened.
  stage_ordinal   INTEGER NOT NULL,
  decider_user_id TEXT NOT NULL,
  -- approve | deny. A denial is terminal for the whole approval, so at most one can exist.
  decision        TEXT NOT NULL,
  decided_at      TEXT NOT NULL,
  -- NULL means standing. Only an approve is ever withdrawn -- a denial is terminal, and there is nothing left
  -- to withdraw from once the request is resolved.
  withdrawn_at    TEXT
);

-- **Dual control's guarantee, at the database.** One decision per person per approval, standing or withdrawn.
--
-- src/approvals.ts also subtracts whoever has decided from the eligible set, and that is for the *message*:
-- this index is what makes it true under concurrency, where two requests can both read an eligible set that
-- is stale by the time either writes. The same division of labour policy naming already uses -- checked in
-- code for the wording, enforced by a UNIQUE index for the property (#9, the conflict is the signal).
--
-- It also makes withdrawal terminal for the withdrawer: they cannot re-decide, so no amount of
-- withdraw-and-approve oscillation can let one person fill two slots. That is why the eligible set only ever
-- shrinks within one approval.
CREATE UNIQUE INDEX apd_one_per_person ON approval_decisions (approval_id, decider_user_id);

-- Standing decisions of one approval, which is the count every predicate in src/approvals.ts is built on:
-- how many distinct people have approved at each stage. Partial on standing, so a withdrawn decision falls
-- out of the index that answers "is this stage satisfied" while staying in the table that answers "what
-- happened".
CREATE INDEX apd_standing ON approval_decisions (approval_id, stage_ordinal) WHERE withdrawn_at IS NULL;

-- ## No new index on team_members, and the reason is measured rather than assumed
--
-- Resolving a relation held **by a team** to the people who hold it is the reverse of the only question this
-- Node used to ask of team_members, and tm_unique is (org_id, user_id, team_id) -- so the obvious move was an
-- index on (org_id, team_id, user_id) to make the reverse lookup a seek. It was written, and then the query
-- plan was read, and it earns nothing:
--
--   with (org_id, team_id, user_id)   SEARCH m USING COVERING INDEX tm_by_team (org_id=?)
--   without it                        SEARCH m USING COVERING INDEX tm_unique  (org_id=?)
--
-- The planner drives from team_members either way and probes relationship_tuples per row, because
-- rt_unique puts subject_id **before** relation (0001, for the authorization check #11 measured) -- so with the
-- subject unknown, only org_id is a usable prefix on that side and the tuple table cannot be the outer loop.
-- Both plans therefore range over the organization's membership rows inside a covering index and neither reads
-- a table. An index that changes which covering index is named and nothing else is a cost with no reader, which
-- is the same argument 0019 makes for not indexing a policy condition.
--
-- What that leaves, stated because it is the figure to watch: one eligibility check ranges over
-- team_members within one organization. That is bounded by headcount, not by mail volume, and nothing writes
-- the table at all today. If it ever stops being small, the fix is rt_unique's column order rather than a
-- second membership index -- and that belongs to authz-check-rows-read.md, which owns that column order and the
-- measurement behind it. test/approvals.test.ts reads the plan rather than trusting this comment.
