-- The format a Butler was authored in (#87, §16, blueprint:311).
--
-- ## Why this column was refused twice before, and is right now
--
-- `docs/butler-ast.md` said, correctly: *"A column whose only value is `'json'` is the placeholder shape
-- `placeholder-columns.test.ts` exists to catch."* Two columns in this schema are exactly that -- a
-- `change_number` that is always `0`, a `thread_id` that never groups -- and both are landmines that took a
-- tripwire to defuse. A third would have been the same mistake with the argument already written down.
--
-- What changed is not the argument. It is that this migration ships in the same commit as a YAML parser, so
-- the column has two live values on the day it exists. `docs/receipts/butler-source-format.md` carries the
-- measurement that decided it: +246.2 KiB raw, +50.8 KiB gzip, about 1% of the Paid script ceiling.
--
-- ## `DEFAULT 'json'` is the truth rather than a backfill guess
--
-- Every existing row is JSON because JSON is the only thing `src/butlers.ts` has ever parsed. So the default
-- is not a plausible value chosen for rows whose real one is unknown -- it is the real one, and no separate
-- backfill statement is needed or would be honest. NOT NULL because a version with no format is a version
-- whose `source_text` cannot be re-parsed, and re-parsing at publication is what makes AST/source
-- correspondence a property instead of a hope.
--
-- The CHECK is the reason there is no `format` lookup table. Two values, both named in one place the parser
-- also switches on, and `test/butlers.test.ts` asserts the database refuses a third -- so a format that no
-- parser handles cannot be stored, which is the failure this column would otherwise introduce: a row the
-- publish path reads and has no branch for.
ALTER TABLE butler_versions
  ADD COLUMN source_format TEXT NOT NULL DEFAULT 'json'
  CHECK (source_format IN ('json', 'yaml'));

-- ## The trigger, recreated: this is 0031's lesson applied rather than relearned
--
-- 0031 exists *because* a column that became content was not in `btv_frozen`'s WHEN clause, and one UPDATE
-- could move a published version's sponsor. Its header states the shape plainly: it became a content column
-- the day the sponsor term was built. `source_format` is a content column from its first row.
--
-- The hole it would leave is specific and worth writing out, because "it is content, freeze it" is a habit
-- and this is a reason:
--
--     UPDATE butler_versions SET source_format = 'yaml' WHERE id = 'btv_...';   -- a published version
--
-- No error. The row's frozen `ast_json`, `ast_sha256` and `source_sha256` are all untouched and all still
-- describe a JSON parse. The next thing to re-derive from that `source_text` reads it with the YAML parser,
-- gets a different AST or a refusal, and `E_BUTLER_DRAFT_INCOHERENT` -- the refusal whose entire job is to
-- catch a row whose halves disagree *before* they are frozen -- reports it after the freezing, about a
-- version nobody edited. The engine meanwhile goes on running the frozen `ast_json`, so the disagreement is
-- between the program and the record of how it was written, which is the pair #49 froze together.
--
-- DROP and CREATE rather than ALTER, because SQLite has no ALTER TRIGGER. Additive for #10's expand/contract
-- in the sense that matters: no table is rewritten, no data is moved, no bookmark gate is needed, and the
-- window between the two statements is inside one ordered statement list applied by `src/migrate.ts`.
--
-- Written out in full rather than patched -- 0031's rule, and 0031 was right about it: a trigger is its whole
-- definition, and a reader comparing this with 0031 should be able to see that exactly one clause moved.
DROP TRIGGER btv_frozen;

-- `IS NOT` rather than `<>` throughout, for 0027's reason: `<>` against a NULL yields NULL, the WHEN clause
-- would not fire, and setting a frozen column to NULL would be the one edit this trigger let through. That
-- cannot happen to `source_format`, which is NOT NULL -- and it is written the same way as its eight
-- neighbours anyway, because a clause that is subtly different from the ones around it is read as meaning
-- something and this one does not.
CREATE TRIGGER btv_frozen
BEFORE UPDATE ON butler_versions
WHEN old.state IN ('published', 'superseded')
  AND (new.ast_json      IS NOT old.ast_json
    OR new.source_text   IS NOT old.source_text
    OR new.source_format IS NOT old.source_format
    OR new.ast_sha256    IS NOT old.ast_sha256
    OR new.source_sha256 IS NOT old.source_sha256
    OR new.version       IS NOT old.version
    OR new.published_by  IS NOT old.published_by
    OR new.published_at  IS NOT old.published_at)
BEGIN
  SELECT RAISE(ABORT, 'E_BUTLER_VERSION_FROZEN a published Butler version''s AST, source text, source format, version number and publisher are unwritable (#49, #51, #87). Publication is the versioning event: edit the draft and publish again. The format is frozen with the text because the AST was derived by that format''s parser, so changing it would leave a frozen program that its own recorded source no longer describes.');
END;
