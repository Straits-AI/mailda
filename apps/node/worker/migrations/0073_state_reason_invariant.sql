-- A send's `state_reason` describes the state it is in now, and only a gate or a refusal has one.
-- phase: expand
--
-- `0019_policy.sql` made `state_reason` "the machine token behind a state": gates are `awaiting` plus a reason,
-- refusals are `withheld` plus a reason, and no other state has a reason vocabulary. So a reason exists exactly on
-- `awaiting` and `withheld`. Until 1 October 2026 two writers in `src/outbound/dispatch.ts` broke that. The claim
-- that admits a send (`held`, `throttled`, or `awaiting` a rate breaker, to `outcome_unknown`) and `cancelSend`
-- (`held` or `awaiting`, to `cancelled`) kept the reason they found, so a send admitted after a rate breaker read
-- `handed_over` with `breaker_volume`, and a cancelled `policy_hold` still said anybody could release it. Both now
-- clear it. This repairs the rows those writers left behind before it ran.
--
-- **Not every row, and not in this release.** `mailda deploy` applies this in its expand step, then uploads the new
-- Worker at 0% and checks it. Until promotion the incumbent still serves: the cron backstop and the `OutboxSweeper`
-- Durable Object run its claim, and its `cancelSend` serves the API, so they can write a stale pair after this has
-- run. If the canary check fails, traffic never moves and the incumbent keeps writing them until some later deploy
-- promotes. This file is in `d1_migrations` by then and never runs again. CLOSED (#319): running these statements
-- again as a migration in a later release would depend on every Node upgrading through that release, so that was not
-- done. Instead `repairStaleReasons` in `src/outbound/dispatch.ts` runs the same two statements from the cron every
-- minute, in a limited batch, indexed by `0076_state_reason_repair_index.sql`. Once a version containing it is
-- promoted, every stale pair any earlier version wrote is cleared within a minute, whatever order the Node upgraded
-- in. This file remains the first pass, which clears what the old writers left before any deploy.
--
-- A projection repair, not a loss of evidence: the history of a gate is in the trail (`send.rate_limited`, the
-- seal entry, `send.withheld`), in `approvals`, and in `policy_outcome`, none of which this touches.
UPDATE send_manifests SET state_reason = NULL
 WHERE state_reason IS NOT NULL AND state NOT IN ('awaiting', 'withheld');

-- `last_error` on a cancelled send. Cancel never writes it, so every one a cancelled row carries was written while
-- the send was still `held` or `awaiting`: a rate gate's "it goes when the window clears", or the words of a refusal
-- a retry moved on from. Both are false of a cancelled send, and the cancel now clears it too. `last_error` on the
-- other terminal states is left alone: after the old claim it can be a previous state's words or a true account of
-- the outcome, and nothing in the row tells the two apart.
UPDATE send_manifests SET last_error = NULL
 WHERE state = 'cancelled' AND last_error IS NOT NULL;
