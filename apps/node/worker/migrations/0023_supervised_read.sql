-- Supervised reading: matters, and the time-boxed grant that is the sanctioned path to somebody
-- else's mail (#63, #64, blueprint 7, Layer 5). Additive (#10 expand/contract): two new tables, one
-- new index on an existing table. No DROP TABLE, no DROP COLUMN, no column rewrite, no bookmark gate.
--
-- ## What blueprint 7 says, and what was only technically true before this
--
-- Blueprint 7 says mailbox administration alone does not imply content access. That was true about the
-- *relation* and false about the *administrator*: org.admin can grant any grantable relation to any
-- subject including itself, so an administrator could give themselves mailbox.content.read on any
-- mailbox in one audited call. #63 decided not to close that, and the reason is worth carrying here
-- because this file is where somebody will come looking for the rule they expect to find:
--
-- Refusing a grant where actor and subject match traps a two-person organization. The only other
-- approver is the person being examined, so the ceremony is either theatre or the read is impossible --
-- and "impossible" for an administrator who is genuinely responsible for a mailbox is the kind of wall
-- that gets solved by editing the database directly, which is strictly worse than an audited
-- self-grant.
--
-- So there are two paths and this migration exists to make them look different:
--
--   supervised.read   the sanctioned path. Matter, scope, expiry, dual approval, and a record.
--   the self-grant    still possible, and now conspicuous: an access.granted entry whose actor and
--                     subject are the same principal is a doctor finding rather than an ordinary
--                     event. The note at the foot of this file records why that finding needs no index
--                     of its own -- and why the one this migration first carried was deleted.
--
-- Stated plainly, because the alternative phrasing would be a claim nothing enforces: **this does not
-- prevent an administrator from reading mail.** It makes the difference between the front door and the
-- back door visible in the record.
--
-- ## Why supervised grants are not relationship_tuples
--
-- Checked rather than assumed: relationship_tuples has **no expiry column**. Adding a nullable one
-- would put a time comparison into *every* authorization check in the product for the benefit of one
-- relation, and docs/receipts/authz-check-rows-read.md measures that path -- 7 rows, two queries, flat
-- under 4x organization growth. A separate table keeps the cost of the ordinary check exactly where it
-- was and pays only on the paths that accept a supervised grant.
--
-- It is also the more honest shape. "Who can read this mailbox" now has two answers with different
-- structures -- a standing relation, and a time-boxed matter-bound grant -- and they **are** different
-- things. One table would have made the answer uniform and wrong.
--
-- ## What is deliberately NOT in this migration
--
-- **No revocation mechanism.** Nothing caches authorization: authz-read.ts re-reads on every call, so
-- expiry is a hard stop by construction -- the next request checks and finds the grant over. The
-- enumeration blueprint 7 asks for (cursors, event streams, presigned attachment URLs, cached
-- previews) came back **empty** on this Node: nothing presigns, nothing streams, and the raw-evidence
-- read is authorized per request in authorize(). So there is nothing here to expire *out* of.
--
-- **No per-act recording and no notification rows.** #63 splits those into its own part: the
-- supervised.query / .opened / .attachment actions, and the notification obligation blueprint 7
-- requires after a matter closes. Both are named absent in src/supervised.ts and src/audit.ts rather
-- than half-built here. What this migration provides is the thing they hang off: a matter that can
-- close, and a grant that cites one.
--
-- **No maximum duration.** A request states its own, and nothing here or in src/supervised.ts caps it. A
-- cap is a number, AGENTS.md admits three kinds and this is none of them -- not a platform limit, not
-- measurable against any corpus, not an objective computed from evidence. What stands in for one is that
-- the deadline is part of what the two approvers are shown before they decide.

-- A matter: the purpose a supervised read is for, as an object rather than free text.
--
-- ## Why this is an object, and it was forced rather than preferred
--
-- Blueprint 7 requires notifying the employee **after the matter closes**. Free text cannot close.
-- One shape simply cannot satisfy the contract, so this was not a choice between two designs. It pays
-- for itself twice more: several grants can belong to one investigation, and blueprint 7's "widening
-- scope requires a new approval" becomes a second grant citing the same matter rather than an edit to
-- a live one -- which matters, because an editable grant is an audit trail that can be rewritten in
-- place.
CREATE TABLE matters (
  id          TEXT PRIMARY KEY,   -- mtr_<ulid>
  org_id      TEXT NOT NULL,

  -- What kind of matter. **The database does not constrain this**, and that is stated rather than
  -- implied: SQLite cannot add a CHECK constraint with ALTER TABLE, and a trigger cannot exist
  -- anywhere in this tree because src/migrate.ts splits migrations on semicolons
  -- (test/node/migrations.test.ts forbids one). Recreating a table to add a CHECK would need a DROP
  -- TABLE, which test/node/content-deletion-world.test.ts refuses in migrations/ on #64's terms.
  --
  -- So the constraint lives one level up, exactly where approvals.subject_kind put it: the TypeScript
  -- union MATTER_TYPES in src/matters.ts, plus test/node/matter-and-scope-world.test.ts, which requires
  -- this table to have exactly one writer and requires that writer to narrow the type before it inserts.
  -- A type that slipped past would be a matter nothing knows how to interpret -- and since #64 makes
  -- legal_hold one of these types, an unrecognised one is a hold whose purpose cannot be read.
  --
  -- No column DEFAULT, unlike approvals.subject_kind: that one exists because SQLite cannot ALTER a
  -- table to add a NOT NULL column without one. This is a fresh table, so the grammar does not force
  -- a value nothing classifies, and a writer that omits the column fails instead of guessing.
  type        TEXT NOT NULL,

  -- What this matter is, in words, for the two approvers who have to decide whether reading somebody's
  -- mail for it is warranted. NOT NULL is the half the database can hold; that the text is not blank
  -- or whitespace is enforced in src/matters.ts, which refuses E_MATTER_DESCRIPTION_REQUIRED -- the
  -- same split hold_lifts.reason records, for the same reason: a mandatory field satisfied by a space
  -- is mandatory in name only.
  description TEXT NOT NULL,

  opened_by   TEXT NOT NULL,
  opened_at   TEXT NOT NULL,

  -- NULL means **open**, and nothing else. It is not "we did not record a closure" -- one statement in
  -- src/matters.ts writes this column and closed_by together, in the same transaction as the
  -- matter.closed audit entry, so a row with one and not the other is not producible.
  --
  -- This is the column the whole object exists for: blueprint 7's notice to the employee is due after
  -- the matter closes, and #63 chose a row as the obligation with an existing cron delivering it. That
  -- row is part B. **This column is not it**, and nothing reads it for notification yet -- said here so
  -- that a reader does not mistake a closable matter for a delivered notice.
  closed_at   TEXT,
  closed_by   TEXT
);

-- One organization's matters, most recent first. Read by GET /api/matters, which is the only reader,
-- and prefixed on org_id like every other index in this schema so one organization's rows are one
-- range. Bounded by matters under investigation, not by mail volume -- the same class of bound
-- 0021 records for holds.
CREATE INDEX mtr_org ON matters (org_id, opened_at);

-- A supervised read: one person, one mailbox, one scope, until one instant.
--
-- ## The row is the request and becomes the grant, and that is the hold-lift shape
--
-- An approval decides on a **subject row** (0021), and keying it on the grant itself would mean one
-- denial makes that grant unrequestable for ever -- the operational trap #64 named, arriving through
-- the schema. So asking again mints a new row here, and the approval's subject is this row.
--
-- granted_at is the analogue of holds.lifted_at: not a mirror of the approval's state, but the
-- separate fact of whether the authorization **took effect**. 0021's "no state column" rule holds --
-- pending, denied, unsatisfiable and cancelled are all read from the approval -- and an approved
-- request whose UPDATE lost a race is approved and granted nothing.
CREATE TABLE supervised_grants (
  id           TEXT PRIMARY KEY,  -- sgr_<ulid>
  org_id       TEXT NOT NULL,

  -- Who may read. **A person, never a team.** A team-held supervised access would defeat the question
  -- this record exists to answer -- who read this mailbox, under what matter -- because team membership
  -- is not part of the record and moves independently of it. authz-read.ts binds who.userId here and
  -- deliberately does not bind the team list it uses for tuples.
  --
  -- Duplicated from the approval's actor_user_id, and that duplication is deliberate where 0021
  -- refused the same thing for hold_lifts.requested_by. The reason is the read path: an authorization
  -- check must not join approvals to learn who may read. Same argument holds.lifted_reason makes for
  -- being a copy rather than a join -- the predicate that stands between a person and somebody else's
  -- mail stays a single-table read. The two are written in one transaction, so they cannot disagree.
  subject_id   TEXT NOT NULL,

  -- The mailbox. The resource scope, at the grain every relation in this schema and every legal hold
  -- already uses.
  mailbox_id   TEXT NOT NULL,

  -- How much of it: metadata (subject lines, sender addresses) or content (the bytes). The declared
  -- set is SUPERVISED_SCOPES in src/supervised.ts, constrained the same way and by the same test as
  -- matters.type above.
  --
  -- These two words are not invented for this table: they are the two read relations this product
  -- already has (mailbox.metadata.read and mailbox.content.read), so a scope maps onto a path that
  -- exists rather than onto one that would have to be built. The column sits **before** expires_at in
  -- sgr_live because it is tested by equality and the deadline by range; see that index. src/authz-read.ts accepts a metadata
  -- grant on the metadata check only, and a content grant on both -- content is strictly the stronger
  -- authority, which is the same asymmetry mayReadMetadata already encodes for relations.
  --
  -- **There is deliberately no date window**, unlike a hold's from_date/to_date. A hold is tested
  -- against the instant of the thing being destroyed, which the destroying call site always has. An
  -- authorization check has a mailbox and no instant -- mayReadMetadata answers a question about a
  -- queue, not about a message -- so a windowed grant would either leak out-of-window subject lines or
  -- grant nothing on that path. Both are worse than the mailbox grain, and #65's export is the ticket
  -- that would need the finer one.
  scope        TEXT NOT NULL,

  -- The matter this grant is for, or NULL. **NULL is a real answer**: #63 settled that a grant cites a
  -- matter or nothing, because the realistic first act -- somebody needs to look at a mailbox now --
  -- precedes any matter. 0018 made the same call for holds.matter_id and this is the same fact about
  -- how investigations actually start.
  --
  -- No foreign key, because this schema declares none anywhere; src/supervised.ts checks the matter
  -- exists, is this organization's and is still open before it will cite one.
  matter_id    TEXT,

  requested_at TEXT NOT NULL,

  -- The hard stop, as an absolute instant, written **at request time** and never moved.
  --
  -- NOT NULL, and that is the whole point of the column: a supervised grant with no end is not
  -- supervised. It is the one place in this schema where a nullable timestamp would have been
  -- indefensible rather than merely awkward.
  --
  -- Stored rather than derived at read time, for 0022's reason: two readers computing the same
  -- deadline is two places for that arithmetic to disagree. An absolute instant rather than a duration
  -- plus a clock start, so that what the two approvers are shown before they decide is exactly what
  -- they authorize -- blueprint 7 makes time part of the bound scope, so the deadline is part of what
  -- is being approved and must not move after they approve it.
  --
  -- The residual, said rather than left to be discovered: an approval decided **after** this instant
  -- produces a grant that is already over. There is no second enforcement point for that and there
  -- deliberately is not one -- 0022 made the same call for approvals.expires_at, because a lapsed
  -- request an approver can still decide has one terminal check rather than two. The deadline travels
  -- on GET /api/approvals with the request, so it is visible to the person being asked before they
  -- answer, and the read path denies from the instant it passes.
  expires_at   TEXT NOT NULL,

  -- When the dual approval completed and this became authority. NULL until then: **a requested grant
  -- grants nothing.** One conditional UPDATE in src/approvals.ts writes it, gated on the approval
  -- having become approved, in the same transaction as the supervised.granted audit entry.
  --
  -- Live is granted_at IS NOT NULL AND expires_at > now. That expression appears once, as
  -- LIVE_SUPERVISED_GRANT in src/supervised.ts, and src/authz-read.ts uses it rather than spelling it
  -- again -- two spellings of "may this person still read" is exactly the drift class this schema's
  -- lifted_at IS NULL predicate was moved into coveringHolds to avoid.
  granted_at   TEXT
);

-- The authorization path's index, and every column in it is there for that one query.
--
-- Partial on granted_at IS NOT NULL, which is the shape #11 established and 0019, 0020 and 0022 all
-- reuse: on a Node where nobody holds supervised access this index is **empty**, so the extra term in
-- an authorization check is a seek into nothing rather than a scan of anything. That is what keeps
-- docs/receipts/authz-check-rows-read.md's measured behaviour intact for every ordinary check --
-- measured, not argued: test/authz.measure.test.ts prices the check with and without a live grant, and
-- the answer is a delta of one row.
--
-- ## The column order was wrong once, and the plan is what said so
--
-- This index was first written (org_id, subject_id, mailbox_id, expires_at, scope), and
-- EXPLAIN QUERY PLAN reported only four of the five columns usable:
--
--   SEARCH supervised_grants USING INDEX sgr_live (org_id=? AND subject_id=? AND mailbox_id=? AND expires_at>?)
--
-- expires_at is a **range** and scope is an **equality**, so putting the range first truncates the usable
-- prefix at it and scope has to be checked off the row. Exactly #11's lesson, one table over: the plan looked
-- fine until it was printed. With scope moved ahead of the range, all five are used.
--
-- granted_at is in the key as well, and it is there for one narrow reason: SQLite's covering-index
-- determination does not reason about a partial index's predicate implying the column it constrains, so
-- without granted_at in the key the plan reads the table row to re-check a column the index already
-- guarantees. Adding it makes the plan say COVERING, which is what the paragraph below claims -- and the
-- claim is checked rather than asserted, in test/explain.test.ts.
--
-- Covering on purpose. The whole test -- this person, this mailbox, still live, wide enough -- is answered
-- from the index with no table row read. The cost is one extra index write per grant, and grants are minted
-- by a ceremony involving three people.
--
-- Ungranted rows are **not** in this index and do not need to be: the "is a request already pending
-- for this person and mailbox" predicate drives from apr_pending (the outstanding approvals, already
-- partial) and reaches this table by primary key. A second index for the ungranted half would serve a
-- query nobody writes, which is the argument 0022 makes for not indexing expires_at.
--
-- Nothing indexes matter_id, for the same reason: no query in part A asks which grants cite a matter.
-- Part B's notification does, and it arrives with the index it needs.
CREATE INDEX sgr_live
  ON supervised_grants (org_id, subject_id, mailbox_id, scope, expires_at, granted_at)
  WHERE granted_at IS NOT NULL;

-- ## There is deliberately **no** index for the self-grant finding, and that is a correction
--
-- This migration first carried one: a partial index on audit_entries over
-- (org_id, at) WHERE action = 'access.granted' AND actor_user_id = subject, described as what made
-- doctor's self_granted_access finding cheap. **SQLite never chose it.** Printed rather than assumed, in
-- test/explain.test.ts:
--
--   SEARCH audit_entries USING INDEX audit_by_action (org_id=? AND action=?)
--
-- and forced with INDEXED BY it was strictly worse -- usable on org_id alone, because SQLite's test for
-- whether a query implies a partial index's predicate does not credit the column-to-column comparison
-- actor_user_id = subject. So the index was dead weight under a comment claiming it was load-bearing, which
-- is the exact defect this repository keeps paying for.
--
-- audit_by_action (0008) serves the finding: it seeks straight to this organization's access.granted
-- entries and the actor-equals-subject test is applied over those. The cost is therefore proportional to
-- **grants made**, not to the age of the audit trail, which is the bound doctor.max_subrequests_per_run
-- cares about. An index that would beat it would have to key on the comparison itself, which SQLite has no
-- way to express without a generated column -- a table rewrite this migration is not allowed to perform.
--
-- What makes the back door visible is therefore the finding, not an index. Nothing here closes it, and
-- nothing here claims to.
