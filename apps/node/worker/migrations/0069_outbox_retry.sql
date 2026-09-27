-- The outbox remembers each event's attempts, so a failed event waits and nothing else does (27 September 2026).
--
-- Until now the sweeper refused every row younger than five seconds, to stay out of the way of an in-request
-- "fast path" that never existed, and retried a failed row every five seconds forever. `src/outbox.ts`'s header
-- has the whole argument; the schema half of it is two columns.
--
-- `attempts` counts claims, and is written **before** the handler runs rather than after it fails. An event
-- that kills the pass it runs in (a CPU or memory limit) never reaches a `catch`, so the count taken first is
-- the only trace it leaves, and the claim orders by it before age: fewest claims first. Without both, the
-- killer, older than everything behind it, would be claimed first again by every pass after.
--
-- `retry_at` is when the event may next be claimed. NULL means it has never been tried and is claimable at
-- once. Set with each claim to the claim time plus a backoff that doubles and is capped, so it is also the
-- lease an interrupted claim holds until.
--
-- Additive (expand): the running Worker never names either column, its claim still runs against the replaced
-- index below (sorting the unpublished rows rather than reading them in order), and every existing row reads
-- as "never tried, claimable now", which is what every unpublished row was.
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN retry_at TEXT;

-- The claim's order in the index, so a pass reads its 25 rows in index order and stops, rather than sorting
-- every unpublished row first (EXPLAIN QUERY PLAN: "SEARCH ... USING INDEX outbox_unpublished" with this
-- index, "USE TEMP B-TREE FOR ORDER BY" with the old one). Replaced rather than joined by a second index, as
-- 0048 did: two indexes over one prefix is one the planner uses and one that is write cost on every event.
DROP INDEX IF EXISTS outbox_unpublished;
CREATE INDEX outbox_unpublished ON outbox (published_at, attempts, created_at);
