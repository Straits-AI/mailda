-- The sponsor is frozen with the version it sponsors (#51, §7, blueprint:702).
--
-- ## What this migration adds: nothing. What it closes: a hole in 0027's trigger.
--
-- No table, no column, no index. #51's decision 4 makes a Butler's effective authority
--
--     effective(step) = pinned ceiling ∩ live tuples of the Butler ∩ live tuples of the sponsor
--
-- and this Node's answer to *"who is the sponsor"* is `butler_versions.published_by` — the administrator
-- whose act made this version live, argued in `src/butler/ceiling.ts`. That column already existed and it
-- was **not** in `btv_frozen`'s WHEN clause, so the sponsor of a published version was writable:
--
--     UPDATE butler_versions SET published_by = 'usr_someone_with_more' WHERE id = 'btv_...';
--
-- One statement, no error, and the ceiling term of a frozen program now capped against a different person's
-- authority. That is the same class of hole #49 found and closed twice in 0027 — the AST rewrite, and the
-- two-statement demote-then-rewrite — reached through the one content column 0027 did not know was one.
-- It became a content column the day the sponsor term was built, which is why it is closed here rather than
-- there.
--
-- The **whole value of a pinned ceiling is that it cannot move under a running program**, and a ceiling
-- intersected with a swappable person's authority is not pinned. So `published_by` joins `ast_json`,
-- `source_text`, both digests and `version` in the frozen set.
--
-- `published_at` joins them too, for a smaller reason stated so it is not read as an oversight: it is the
-- other half of one fact. A publication whose *who* is frozen and whose *when* is not is a record that can
-- still be made to lie about the order two versions went live, and there is no act in this Worker that
-- writes either after the promotion.
--
-- ## The ceiling itself needs no column, and that is a decision rather than a saving
--
-- §16 writes `capabilities:` as a top-level key of the Butler document, so the ceiling lives **inside**
-- `ast_json` — already frozen by the clause below, already covered by `ast_sha256`, and already derived from
-- `source_text` by `src/butlers.ts` so it cannot disagree with what its author wrote.
-- `packages/butler-ast/src/capability.ts` carries the argument against a column, which is that a fourth
-- content column is a fourth thing to remember in a trigger whose first draft had a bypass.
--
-- ## DROP and CREATE rather than ALTER, because SQLite has no ALTER TRIGGER
--
-- Additive in the sense that matters for #10's expand/contract: no table is rewritten, no data is read or
-- moved, and no bookmark gate is needed. The window between the DROP and the CREATE is inside one migration
-- statement list applied in order by `src/migrate.ts`, and nothing in this Worker writes `butler_versions`
-- during a migration.
--
-- The recreated trigger is 0027's, **verbatim**, plus two clauses and one sentence in the message. Written
-- out in full rather than patched, because a trigger is its whole definition and a reader comparing this
-- with 0027 should be able to see exactly what moved.

DROP TRIGGER btv_frozen;

-- `IS NOT` rather than `<>` throughout, because `<>` against a NULL yields NULL and the WHEN clause would
-- not fire -- so a change that set a frozen column to NULL would be the one edit this trigger let through.
-- That matters more for the two new columns than for the five old ones: `published_by` is NULL while a
-- draft, so `<>` would have let a published version's sponsor be erased.
CREATE TRIGGER btv_frozen
BEFORE UPDATE ON butler_versions
WHEN old.state IN ('published', 'superseded')
  AND (new.ast_json      IS NOT old.ast_json
    OR new.source_text   IS NOT old.source_text
    OR new.ast_sha256    IS NOT old.ast_sha256
    OR new.source_sha256 IS NOT old.source_sha256
    OR new.version       IS NOT old.version
    OR new.published_by  IS NOT old.published_by
    OR new.published_at  IS NOT old.published_at)
BEGIN
  SELECT RAISE(ABORT, 'E_BUTLER_VERSION_FROZEN a published Butler version''s AST, source text, version number and publisher are unwritable (#49, #51). Publication is the versioning event: edit the draft and publish again. The publisher is frozen because it is the sponsor whose live authority caps this version''s capability ceiling, and a ceiling capped against a swappable person is not pinned.');
END;
