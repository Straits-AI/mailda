-- A set of recovery codes gains an identity (#109 follow-up, audit P1-2).
--
-- `recovery_codes` held rows for an organization and nothing more, so "the current set" meant "every row for
-- this org", and both the confirmation and the rotation were written in those terms. Two defects followed from
-- the one absence:
--
-- 1. Confirmation verified a code against the current rows and then ran
--    `UPDATE recovery_codes SET confirmed_at = ? WHERE org_id = ? AND confirmed_at IS NULL` — org-wide. A
--    rotation landing between the two statements marked the **new** set confirmed on the strength of a code
--    from the old one, and `doctor` then reported a healthy escrow over a sheet nobody had read. There was no
--    way to write that UPDATE correctly, because there was nothing to name the set with.
--
-- 2. Rotation deleted the working set before inserting its replacement. The batch made that atomic, so a
--    partial write was impossible — but a **lost response** is not, and it leaves the operator holding an old
--    sheet that no longer works and a new one they never saw. The escrow stays intact and becomes unreachable
--    by anybody. Keeping the previous set spendable until the replacement is *confirmed* needs two sets to be
--    able to coexist, which needs this column.
--
-- Nullable, and NULL is the legacy set — the same shape and the same reason as migration 0042's
-- `code_characters`. Existing rows are one set per organization by construction, so there is nothing to
-- classify and no identifier to synthesize; a migration inventing ULIDs would also be the third place this
-- repository has hand-written the Crockford alphabet.
--
-- Every predicate against this column therefore uses SQLite's null-safe `IS` and `IS NOT` rather than
-- `=` and `<>`, which would silently match nothing for a legacy row. `recovery.ts` says so at each site.
ALTER TABLE recovery_codes ADD COLUMN set_id TEXT;

-- The lookup confirmation and retirement both make: every row of one set, or every row that is *not* of it.
-- `org_id` first because it is always equality-bound and `set_id` is compared both ways.
CREATE INDEX IF NOT EXISTS recovery_codes_by_set ON recovery_codes (org_id, set_id);
