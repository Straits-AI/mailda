-- One published version per Butler, enforced rather than assumed.
--
-- 0027 says, on the `btv_forward_only` trigger: "two live versions of one Butler is what `btv_live` and the
-- publish transaction exist to prevent". Half of that was true. `btv_live` is
--
--     CREATE INDEX btv_live ON butler_versions (org_id) WHERE state = 'published';
--
-- which is not UNIQUE and is keyed on the **organization**, not the Butler. It is a read index for the live
-- set and it prevents nothing. Only the publish transaction stood between a Butler and two live versions,
-- and a transaction only governs writes that go through it -- which is precisely the assumption
-- `interpret.ts` refuses to make about `ast_json` in its own header: "a stored AST is still data, and data
-- can be edited by somebody with direct database access".
--
-- What that cost, observed rather than imagined: with a published v1 and a published v2 both present,
-- `publishButler` read the live version with `LIMIT 1` and no `ORDER BY`, got v1, computed `1 + 1`, and hit
-- `btv_version` -- surfacing as an **unhandled D1 constraint error and a 500** rather than a refusal
-- anybody could act on. The same two rows would also make `triggerButlers` pick a program arbitrarily,
-- which is worse and silent: the Butler that runs would depend on row order.
--
-- ## The repair comes first, because a unique index over dirty data is a Node that cannot migrate
--
-- Creating the index against a catalog that already holds two live versions would fail the migration and
-- block every later one, turning a rare anomaly into a dead Node. So the anomaly is repaired first, and the
-- rule it repairs to is the lifecycle's own: **the newest publication is the live one.** Older published
-- rows become `superseded`, which is the state they would have been put in had they been replaced through
-- the product -- the same one-way street `btv_forward_only` allows.
--
-- `superseded_at` is set to the row's own `published_at` rather than to now, because "when did this stop
-- being live" is answered by when its successor arrived, and a repair timestamp would claim this happened
-- today. Where `published_at` is NULL -- unreachable through `publishButler`, which writes it in the same
-- statement that promotes the row -- it falls back to `created_at`, so the column is never left NULL on a
-- superseded row.
--
-- On a Node with no anomaly this UPDATE matches nothing, which is the expected case: the publish
-- transaction has been correct all along and this closes the door beside it.
UPDATE butler_versions
   SET state = 'superseded',
       superseded_at = COALESCE(published_at, created_at)
 WHERE state = 'published'
   AND EXISTS (
     SELECT 1 FROM butler_versions AS later
      WHERE later.butler_id = butler_versions.butler_id
        AND later.state = 'published'
        AND later.version > butler_versions.version
   );

-- The same shape as `btv_one_draft`, and for the same reason: a Butler has *the* live version, not a set of
-- them, and the index is what makes that a fact about the database rather than a habit of the write path.
CREATE UNIQUE INDEX btv_one_live ON butler_versions (butler_id) WHERE state = 'published';
