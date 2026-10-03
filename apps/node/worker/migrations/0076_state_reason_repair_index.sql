-- Two partial indexes for the cron's reason repair (#319). They hold only the rows that break the invariant.
-- phase: expand
--
-- `0073_state_reason_invariant.sql` cleared `state_reason` on sends not `awaiting` or `withheld`, and `last_error` on
-- cancelled ones, once. The version that wrote those pairs keeps serving through the canary, and for good if the
-- canary check fails, so a one-time migration cannot be the whole repair, and running it again in a later release
-- would depend on every Node upgrading through that release. So `repairStaleReasons` in `src/outbound/dispatch.ts`
-- runs the same two repairs from the cron, every minute, in whatever version is serving. It repairs whatever any
-- earlier version wrote, however the Node got here.
--
-- A repair that runs every minute must cost nothing once there is nothing to repair. These partial indexes hold only
-- the rows the repair looks for. The fixed writers never produce such a row, so once the repair has caught up both
-- indexes are empty: a pass reads a constant 6 rows, and a write to a valid row touches neither index. Without them,
-- each pass scans the whole of `send_manifests` (1,006 rows read with 500 sends; local D1, `test/breakers.test.ts`).
--
-- Each WHERE is spelled exactly as the repair spells it, because SQLite only uses a partial index for a query whose
-- terms contain the index's. org_id is the key because it is the only column the query binds, the same reasoning
-- as `sm_evidence_changed` in 0022. `test/breakers.test.ts` checks the plan and the rows read.
CREATE INDEX sm_stale_reason ON send_manifests (org_id)
  WHERE state_reason IS NOT NULL AND state NOT IN ('awaiting', 'withheld');

CREATE INDEX sm_cancelled_last_error ON send_manifests (org_id)
  WHERE state = 'cancelled' AND last_error IS NOT NULL;
