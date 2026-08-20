-- The Butler object: a name, and a history of versions (#49, Layer 4, blueprint 16). Additive (#10
-- expand/contract): two new tables, two triggers, no DROP and no rewrite of an existing one, so no
-- bookmark gate.
--
-- ## What this migration does and does not make possible
--
-- After it, a Butler can be authored, checked, drafted, published, superseded and read. **It cannot be
-- run.** The engine is #50's -- one generic `ButlerRun extends WorkflowEntrypoint` interpreting whatever
-- `ast_json` it reads -- and nothing in this Node declares a Workflow binding yet. That is the correct end
-- state for this piece rather than a gap: an AST that nothing executes is still the thing every later
-- ticket is written against, and shipping the store and the checker first is how the run ledger, the taint
-- checker and simulation get something to be checked against. `doctor`'s `butler_execution` check says so
-- out loud, so a reader does not have to infer it from an absence, and
-- `test/node/butler-execution-world.test.ts` fails the day a Workflow binding appears -- which is what
-- stops that sentence outliving its truth.
--
-- **Amended 21 August 2026 (#50): the paragraph above described this migration's day and no longer describes
-- the Node.** A Butler runs. `wrangler.jsonc` declares one `[[workflows]]` binding, `src/butler/run.ts` is
-- the entrypoint, and 0028 adds the run record. Nothing in *this* migration changed -- the tables, the
-- indexes and both triggers are exactly what shipped -- which is why the text is amended rather than
-- rewritten: a migration is history, and history that has been edited to look prescient is worth less than
-- history with a date on it. What the sentence got right is the part that survived: an AST that nothing
-- executed was still the thing #50 was written against, and the engine reads these columns unchanged.
-- `butler-execution-world.test.ts` did fail the day the binding appeared, and the claim it guarded was
-- rewritten rather than deleted -- which is the whole return on having written it.
--
-- ## Two tables, split the way `policies` / `policy_versions` is split
--
-- The name is the durable identity; the versions carry the program. #60 chose that split for a policy and
-- said in its own migration that it was #49's shape reused; this is the other end of the same borrowing.
--
-- ## The AST is a blob, and this is the one place a blob is the right answer
--
-- 0019_policy.sql rejected a JSON blob for policy conditions, and the load-bearing half of its argument was
-- that a blob would **admit a sixth condition nothing evaluates**: any key is storable, so a policy naming
-- `device` would be publishable and silently inert. That argument does not transfer, and the reason it does
-- not is the whole of #49: an AST is not a set of conditions matched in SQL, it is a program, and its
-- vocabulary is closed by a **generated discriminated union** in `packages/butler-ast` plus a checker that
-- refuses every node outside it. A Butler naming `llm.classify` is refused at publication with a reason
-- naming the node -- so the failure a blob invites there is closed here by a type and a check, not by
-- columns. And nothing matches on the inside of an AST: no query filters by node type, no index could help,
-- and the engine reads the whole program or none of it.
--
-- ## Both the AST and the source text are frozen, and "frozen" is enforced by the database
--
-- Publication is the versioning event. Editing produces a draft; publishing mints the version whether or
-- not the AST changed; a published version cannot be edited at all. That **dissolves** the question of what
-- a comment-only edit does rather than answering it -- there is no such thing as editing a published
-- Butler.
--
-- #60 enforced the same property by discipline plus a test: `src/policy.ts` never writes a content column
-- after insert, and `test/policy.test.ts` asserts a superseded version's bytes are byte-identical to what
-- was published. That is a real check and it is one class weaker than what is available here, because it
-- proves the code does not do it rather than that it cannot. This migration makes it **unrepresentable**,
-- and it takes **two** triggers to do it rather than the one the first draft had: `btv_frozen` aborts any
-- UPDATE that changes a published or superseded version's `ast_json`, `source_text`, either digest or its
-- version number, and `btv_forward_only` aborts any UPDATE that walks its lifecycle state backwards --
-- which was the two-statement way round the first, demonstrated rather than imagined. Same
-- structural-over-disciplined choice as ADR 41's `HeaderBlock`, ADR 35's manifest id, and the partial index
-- that makes two current signing keys unrepresentable.
--
-- The write path still never writes those columns -- so the trigger is a tripwire, past where any correct
-- code goes, and only a broken thing touches it.

CREATE TABLE butlers (
  id         TEXT PRIMARY KEY,   -- btl_<ulid>
  org_id     TEXT NOT NULL,
  name       TEXT NOT NULL,

  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One Butler per name per organization, for `pol_name`'s reason: a second "chase unpaid invoices" is
-- either a duplicate somebody forgot about or an edit they meant to make to the first.
CREATE UNIQUE INDEX btl_name ON butlers (org_id, name);

-- A version of a Butler.
--
--   draft        editable, by replacement. Never executed. At most one per Butler.
--   published    the current program. Exactly the set a trigger would look at.
--   superseded   frozen history. Still readable, because a run binds the version it ran under.
--
-- Publishing moves the previous version from published to superseded, which is an UPDATE of a published
-- row -- so what "freezes" means has to be exact rather than a slogan. What freezes is the **content**:
-- `ast_json`, `source_text`, both digests and `version` are never written again after insert, and
-- `btv_frozen` below is what makes that a property of the database. The lifecycle state is a fact about
-- the *set* rather than about the program, and it is the only column that moves.
CREATE TABLE butler_versions (
  id            TEXT PRIMARY KEY,  -- btv_<ulid>
  org_id        TEXT NOT NULL,
  butler_id     TEXT NOT NULL,

  -- NULL while a draft. A draft is not a version -- publication is what mints one -- and a placeholder 0
  -- would make "version 0" a thing every reader has to be told does not exist.
  version       INTEGER,
  state         TEXT NOT NULL,     -- draft | published | superseded

  -- The canonical serialization of the checked AST: sorted keys, no whitespace, null and absent identical,
  -- integers only. The discipline is ADR 35's, reused rather than re-derived. See
  -- packages/butler-ast/src/canonical.ts for why the order is derived from the key names here while
  -- `canonicalConditions` writes six field names out by hand: a hand-written order over a *tree* has an
  -- omission mode a flat record does not.
  --
  -- What canonical bytes buy is stated where it is easy to overstate: they make `ast_sha256` below a
  -- fingerprint of the **program** rather than of the document, so two versions with different source
  -- texts can be shown to be the same program. They are not what decides the no-op-publish refusal --
  -- an AST is derived from its source, so identical source bytes already give an identical AST.
  ast_json      TEXT NOT NULL,

  -- What the author submitted, byte for byte. Frozen with the AST, because invariant 9 plainly says a
  -- published version is immutable and "the YAML you read for version 3 is not the YAML published as
  -- version 3" is exactly what mutating this would mean.
  --
  -- It is **JSON today, and the Node derives the AST from it** rather than accepting the two separately.
  -- A client sending an (ast, source) pair could send a mismatched pair, and nothing here could tell:
  -- storing the author's record beside a program it does not describe is a lie the schema would be
  -- keeping. Deriving one from the other makes correspondence a property rather than a hope. A second
  -- authored form -- §16's YAML -- arrives with a parser in the Worker bundle and a format column, and not
  -- before: a column whose only value is 'json' is the placeholder shape `placeholder-columns.test.ts`
  -- exists to catch.
  source_text   TEXT NOT NULL,

  -- SHA-256 over the canonical AST bytes, and over the source text. **Two digests, not one.**
  --
  -- Publication mints a version whether or not the AST changed, and a publish is refused only when
  -- *both* are byte-identical to the current version. One combined digest would answer the refusal and
  -- nothing else; two answer the question a reader of the history actually asks -- "did the program change
  -- between v3 and v4, or only its formatting?" -- from the columns, with no re-parse.
  ast_sha256    TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,

  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  published_by  TEXT,              -- NULL while a draft
  published_at  TEXT,              -- NULL while a draft
  superseded_at TEXT               -- NULL until a later version replaces this one
);

-- The live set, partial on the published state -- the shape #11 established for the authorization path and
-- 0019 reused for policies. A superseded version falls out of the index entirely, so the index holds one
-- row per live Butler rather than the whole history, and drafts fall out too, which is what makes "a draft
-- is never executed" cheap as well as true.
CREATE INDEX btv_live ON butler_versions (org_id) WHERE state = 'published';

-- One version number per Butler. The conflict is the signal (#9): two concurrent publishes cannot both
-- take version 3, so one loses at the database and re-reads rather than minting a duplicate.
CREATE UNIQUE INDEX btv_version ON butler_versions (butler_id, version);

-- At most one draft per Butler, so editing produces *the* draft rather than another one and an author
-- cannot accumulate three competing unpublished edits with nothing saying which is next.
CREATE UNIQUE INDEX btv_one_draft ON butler_versions (butler_id) WHERE state = 'draft';

-- The history, for "which program ran" -- the question a run ledger (#53) and an audit reader both ask.
CREATE INDEX btv_by_butler ON butler_versions (org_id, butler_id, version);

-- A published or superseded version's content is unwritable. See the header for why this is a trigger
-- rather than a rule the write path follows.
--
-- `IS NOT` rather than `<>` throughout, because `<>` against a NULL yields NULL and the WHEN clause would
-- not fire -- so a change that set a frozen column to NULL would be the one edit this trigger let through.
CREATE TRIGGER btv_frozen
BEFORE UPDATE ON butler_versions
WHEN old.state IN ('published', 'superseded')
  AND (new.ast_json      IS NOT old.ast_json
    OR new.source_text   IS NOT old.source_text
    OR new.ast_sha256    IS NOT old.ast_sha256
    OR new.source_sha256 IS NOT old.source_sha256
    OR new.version       IS NOT old.version)
BEGIN
  SELECT RAISE(ABORT, 'E_BUTLER_VERSION_FROZEN a published Butler version''s AST, source text and version number are unwritable (#49). Publication is the versioning event: edit the draft and publish again.');
END;

-- ## The lifecycle only runs forwards, and without this the trigger above had a two-statement bypass
--
-- `btv_frozen` guards *content while the state is published or superseded*, which is exactly as strong as it
-- sounds and one statement weaker than it reads. Found by trying it: `UPDATE ... SET state = 'draft'` alone
-- committed -- the WHEN clause names no state column -- and the very next UPDATE then saw `old.state =
-- 'draft'` and rewrote the AST. Two statements, no error, and the published program for version 1 was a
-- different program. Worse, the normal edit path would then *delete* that row, because a demoted version is
-- indistinguishable from a draft to `btv_one_draft` and to the `state = 'draft'` predicate in
-- `src/butlers.ts`. Combining both changes in one statement was already refused; splitting them was not.
--
-- So the lifecycle is a one-way street in the database rather than in the write path: draft -> published ->
-- superseded, and nothing goes back. Not a tripwire a good widget touches -- rollback in this product is
-- *republication*, which mints a new version from an old version's source, and pause and retirement are
-- states of a Butler rather than of a version. The `superseded -> published` direction is refused for the
-- same reason: two live versions of one Butler is what `btv_live` and the publish transaction exist to
-- prevent, and resurrecting a frozen row would be the one way to reach it.
CREATE TRIGGER btv_forward_only
BEFORE UPDATE ON butler_versions
WHEN old.state IN ('published', 'superseded')
  AND new.state IS NOT old.state
  AND NOT (old.state = 'published' AND new.state = 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'E_BUTLER_VERSION_FROZEN a published or superseded Butler version cannot return to an earlier state (#49). The lifecycle is draft -> published -> superseded. To go back to an older program, publish its source again as a new version.');
END;

-- ## Deletion is deliberately NOT prevented here, and saying so is the point
--
-- A matching `BEFORE DELETE` trigger was written and then removed, because it was the wrong shape and the
-- wrong shape in an instructive way. **Immutability and indestructibility are different properties.** This
-- migration owns the first: a published version's content cannot *change*, which is what invariant 9
-- requires and what makes a digest a fingerprint. The second is a retention question, and retention in this
-- product runs through legal hold and the closed world in
-- `test/node/content-deletion-world.test.ts` -- machinery that a trigger cannot consult, because no Worker
-- code runs between a trigger's statements.
--
-- The trigger also failed AGENTS.md's own test for a tripwire: *"if a good widget hits it, the tripwire is
-- wrong."* An organization-deletion path and a retention sweep are good widgets and both would hit it,
-- with no override available, from inside SQLite, forever. So the honest statement is the one this comment
-- makes rather than one a `RAISE` would imply: **nothing in this Worker deletes a published or superseded
-- Butler version, and nothing prevents it either** -- exactly the position `policy_versions` is in. The
-- single `DELETE FROM butler_versions` in `src/butlers.ts` is bounded by `state = 'draft'` and is
-- classified in that closed world, which is what makes a second, unbounded one fail a test rather than
-- pass unnoticed.
