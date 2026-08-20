-- Lifting a legal hold, and approvals generalised from a manifest to a subject (#64, #61, Layer 5).
-- Additive (#10 expand/contract): one new table, three new columns, two renamed columns, one index
-- replaced. No DROP TABLE, no DROP COLUMN, no bookmark gate.
--
-- ## This is a rename, not a backfill, and the reason is a date
--
-- 0020_approvals.sql is one commit old and has never been part of a released Node: the approvals tables
-- were created and this migration reshapes them in the same week. So there is **no data to move**. Every
-- statement below is DDL, and the absence of an UPDATE ... SET statement here is a fact about the age of
-- the table rather than an omission -- if approvals rows could exist, subject_kind would need a backfill
-- and this file would carry it.
--
-- The one place that shows through is the DEFAULT on subject_kind. SQLite cannot add a NOT NULL column
-- without one, so the default exists to satisfy the grammar, not to classify data. Nothing relies on it:
-- src/approvals.ts is the only writer, it names every column, and
-- test/node/content-deletion-world.test.ts asserts both -- that approvals is written from that one file
-- and that the INSERT names subject_kind -- because a default that a forgotten column falls back on is
-- how a hold lift would silently become a send approval.
--
-- ## Why the approval's target became a subject rather than growing a second id column
--
-- The lift is #61's second caller and it found the shape wrong on its first day, which is the cheapest
-- moment. approvals.manifest_id was TEXT NOT NULL with a UNIQUE index; a hold lift is not a manifest.
-- The alternatives, and why they lose:
--
--   a nullable hold_id beside manifest_id   starts a column per subject kind and makes "which subject"
--                                           a question nothing validates. #60 refused a condition blob
--                                           for the same reason.
--   a separate hold_lift_approvals table    duplicates the fold, the eligibility computation and the
--                                           conditional UPDATE that settles completion. All three of
--                                           #61's defects were in that race logic, so a second copy is a
--                                           second place for them.
--
-- So the target is (subject_kind, subject_id), and every subject is a row in a table of its own: a send's
-- subject is a send_manifests row, a lift's is the hold_lifts row below. That is what keeps the UNIQUE
-- index below as strong as apr_manifest was -- see it for the argument.
--
-- This is not speculative generality. Blueprint 18 names connector writes, forwarding, export and
-- domain/routing changes as approval subjects, and #65's eDiscovery export is already charted as a
-- supervised act needing approval. The second and third callers are known, not imagined.
--
-- ## What subject_kind is allowed to be, and what does not enforce it
--
-- The declared set is send_manifest and hold_lift. **The database does not constrain it**, and that is
-- stated rather than implied: SQLite cannot add a CHECK constraint with ALTER TABLE, and a trigger cannot
-- exist anywhere in this tree at all -- test/node/migrations.test.ts forbids one, because src/migrate.ts
-- splits migrations on semicolons and a trigger body carries its own. Recreating the table would need a
-- DROP TABLE, which test/node/content-deletion-world.test.ts refuses in migrations/ on #64's terms.
--
-- So the constraint lives one level up, in two places that are checked: the TypeScript union
-- APPROVAL_SUBJECT_KINDS in src/approvals.ts, and the closed world in
-- test/node/content-deletion-world.test.ts which requires every subject-kind literal in src/ to be a
-- declared one and requires this table to have exactly one writer. That is weaker than a CHECK against a
-- hand-written INSERT run through wrangler d1 execute, which is the same boundary the whole hold
-- mechanism has (#64) and is not fixable from inside a Worker.
ALTER TABLE approvals RENAME COLUMN manifest_id TO subject_id;

-- The kind of thing being decided on. See the section above for what constrains it and what does not.
--
-- The DEFAULT is the grammar's, not a classification: no row exists to receive it.
ALTER TABLE approvals ADD COLUMN subject_kind TEXT NOT NULL DEFAULT 'send_manifest';

-- author_user_id becomes actor_user_id, because a lift has no author.
--
-- The column always meant one thing: **the person whose act this approval gates, and therefore the one
-- person who may never decide it** (blueprint 18's separation of duty). For a send that is the author of
-- the manifest; for a lift it is the administrator who requested it. Keeping the name "author" would have
-- made every reader of a hold_lift row ask what a lift's author is, and the honest answer is that there
-- is not one -- a name that overclaims by one word is how a reader is handed a landmine.
--
-- mailbox_id keeps both its name and its meaning, checked rather than assumed: for a send it is the
-- mailbox the message is from, for a lift it is the **held** mailbox, and in both cases it answers exactly
-- one question -- who holds approval.decide here, and is therefore eligible. A future subject kind with
-- no mailbox at all (a domain or routing change, blueprint 18) is a real question and it is **not**
-- answered here: a nullable mailbox_id would make "who is eligible" a question nothing validates, which
-- is the defect this migration's own subject_id exists to avoid. That kind either names a mailbox or
-- brings a second source for its eligible set, and that is its ticket's work.
ALTER TABLE approvals RENAME COLUMN author_user_id TO actor_user_id;

-- apr_manifest is replaced rather than kept: it indexes one subject kind's half of a two-column key.
DROP INDEX apr_manifest;

-- One approval per subject, which is exactly what apr_manifest guaranteed for sends, generalised.
--
-- It stays a full UNIQUE rather than becoming "one *pending* approval per subject", and that is the whole
-- reason a lift has a hold_lifts row of its own instead of naming its hold directly. Asking again has to
-- have a representation: a send re-seals and mints a new manifest id (ADR 35), and a lift whose first
-- request was denied mints a new hold_lifts row. Had subject_id been the hold id, a single denial would
-- have made that hold unliftable for ever -- the operational trap #64 named, arriving through the schema
-- instead of through the code.
--
-- Also the read path: the approval of one subject, in one query (src/approvals.ts approvalOfManifest,
-- which #62's dispatch recheck needs, and the pending-lift lookup in src/holds.ts).
CREATE UNIQUE INDEX apr_subject ON approvals (subject_kind, subject_id);

-- One request to lift one hold: the subject an approval of kind hold_lift points at.
--
-- ## Why the lift is a row and not a column on holds
--
-- Three reasons, and the third is the one that decided it:
--
--   1. A lift request is asked for and may be refused. Its history matters -- "who asked to lift this
--      hold, when, why, and who said no" is exactly the class of fact an investigation asks about, which
--      is the same argument #64 used to classify a case merge as content-carrying.
--   2. It may be asked twice. Columns on holds would make the second request overwrite the first.
--   3. Requesting a lift must not write to holds at all. The only UPDATE holds in this product is the
--      lift being *applied*, and test/node/content-deletion-world.test.ts fails on a second one --
--      because narrowing a hold's window is a silent lift.
--
-- ## What is deliberately not here
--
-- **No requested_by and no requested_at.** They are on the approval row (actor_user_id, requested_at),
-- written in the same transaction as this one, and duplicating them here would make "who asked" a
-- question answerable from two places that can disagree. Nothing can write one row without the other:
-- src/holds.ts requestHoldLift builds both inserts into one batch behind one predicate.
--
-- **No state column.** The state of a lift request is the state of its approval -- pending, approved,
-- denied, unsatisfiable, cancelled -- and a second copy of it here is the field named synced that only
-- forwards. Whether a lift *took effect* is holds.lifted_at, which is a different fact: an approved
-- request whose UPDATE lost to an earlier lift is approved and did not lift anything.
CREATE TABLE hold_lifts (
  id      TEXT PRIMARY KEY,   -- hlf_<ulid>
  org_id  TEXT NOT NULL,

  -- The hold this asks to lift. No foreign key, for the reason 0018 gives about matter_id: this schema
  -- declares none anywhere, and the referent here is written in the same transaction that reads it.
  hold_id TEXT NOT NULL,

  -- **Mandatory, and non-empty.** #64 made a reason part of what lifting *is*: placing preserves and
  -- needs no justification, lifting re-permits destruction and does. NOT NULL is the half the database
  -- can hold; that the text is not blank or whitespace is enforced in src/holds.ts, which refuses
  -- E_HOLD_LIFT_REASON_REQUIRED -- a mandatory field satisfied by a space is a mandatory field in name
  -- only, and SQLite cannot express the difference without the CHECK this table could have had and the
  -- ALTERed one above could not.
  --
  -- Read by an approver **before** they decide, which is why it lives here rather than only in the audit
  -- trail: a person being asked to re-permit destruction has to be able to see what they are being asked
  -- for, and a trail is where a decision is accounted for afterwards.
  reason  TEXT NOT NULL
);

-- The lifts of one hold. Two readers, both narrow: "is a lift already pending on this hold" (the
-- predicate src/holds.ts requests behind, which is what stops two open questions about one hold), and
-- doctor reporting a pending lift beside the hold it would release. Prefixed on org_id like every other
-- index in this schema, so one organization's rows are one range.
CREATE INDEX hlf_hold ON hold_lifts (org_id, hold_id);

-- The two columns 0018 deliberately left out, and the link between them and the act that wrote them.
--
-- 0018's argument for their absence was that "a column nothing writes cannot tell a reader whether NULL
-- means in force or never built". That is now settled in the direction that makes NULL readable: something
-- writes them, so NULL means **in force**. The writer is one conditional UPDATE in src/approvals.ts, in
-- the same transaction as the hold.lifted audit entry and gated on the approval having become approved.
--
-- lifted_reason is a **copy** of hold_lifts.reason taken at the instant of the lift, not a join to it.
-- Two reasons: the coverage predicate and every hold report stay single-table reads on the path that
-- stands between a held mailbox and a deletion, and evidence is immutable (blueprint 13) -- what the lift
-- said when it happened cannot be changed by anything that later touches the request row.
ALTER TABLE holds ADD COLUMN lifted_at TEXT;
ALTER TABLE holds ADD COLUMN lifted_reason TEXT;

-- Which hold_lifts row took effect. NULL exactly while lifted_at is NULL -- one UPDATE writes all three,
-- so a row with one and not the others is one no path in this Node produces. Several hold_lifts rows may
-- cite one hold, because a denied request may be followed by another; this names the one that lifted it.
ALTER TABLE holds ADD COLUMN lift_id TEXT;

-- ## No new index on holds, and no partial one either
--
-- Coverage is now
-- mailbox_id = ? AND lifted_at IS NULL AND (from_date IS NULL OR ...) AND (to_date IS NULL OR ...),
-- so the obvious move was to make hld_coverage partial on lifted_at IS NULL, the shape apr_pending uses
-- for the outstanding approvals. It is not taken, and the argument is 0018's own for leaving from_date
-- out of that index: the row has to be read anyway to test to_date, a mailbox realistically carries one
-- or two holds, and a lifted hold does not stop being one of a handful. A partial index would sort the
-- same handful behind a second B-tree.
--
-- What that costs, said plainly rather than left for a reader to discover: anyActiveHold is no longer
-- answerable from the index alone -- SELECT id FROM holds WHERE org_id = ? AND lifted_at IS NULL reads
-- the rows in that range. Bounded by holds per organization, which is bounded by custodians under matter,
-- not by mail volume. If an organization ever carries so many lifted holds that this matters, the
-- measurement to take first is how many, and the fix is this index becoming partial.
