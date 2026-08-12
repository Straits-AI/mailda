-- `org.admin`, and the backfill that keeps already-installed Nodes administrable (#39).
--
-- Until now the most privileged principal on a Node could read one mailbox and propose sends from it. There
-- was no administrator and no path by which anybody granted anything to anybody — `drafts.ts` has been
-- telling people to "ask an administrator to grant send.propose", which was advice to seek out a person the
-- system had no concept of.
--
-- ## Why a relation and not a role
--
-- "Administrator" is a relation on the **organization** object, exactly as `send.propose` is one on a
-- mailbox. One authorization system rather than two that must agree, and `hasRelation` already reads it —
-- so admin is not special-cased anywhere in code. A roles table would have been friendlier to administer
-- and would have introduced a second representation of the same truth, with a drift class where the role
-- says one thing and the tuples another.
--
-- Admins may grant `org.admin` itself, so one person leaving cannot leave a Node unadministrable.
--
-- ## The backfill, and the fact it stands in for
--
-- `claim.ts` now mints this tuple for the first owner. Nodes claimed before this migration have no such
-- tuple, and without a backfill their first user could never grant anything — the Node would be permanently
-- unadministrable, which is worse than the state it is in today.
--
-- The owner has to be **inferred**, because `node_claim` records `org_id` and `claimed_at` and *not who
-- claimed*. The earliest `users` row in the organization is the best available answer and it is a
-- reconstruction, not a record. That gap is recorded on the map as its own follow-on rather than being
-- quietly normalised here.
--
-- Deterministic id, because SQLite cannot mint a ULID and a migration must be idempotent under retry. Same
-- shape as 0009's `send.propose` backfill, for the same reason.
--
-- `INSERT OR IGNORE` against `rt_unique`, so re-running this is a no-op rather than a constraint error —
-- #9's derived-key property, reached from a migration instead of a request.

INSERT OR IGNORE INTO relationship_tuples
  (id, org_id, subject_id, relation, object_type, object_id, created_at)
SELECT
  'rt_backfill_admin_' || substr(u.id, 1, 26),
  u.org_id,
  u.id,
  'org.admin',
  'organization',
  u.org_id,
  u.created_at
FROM users u
WHERE u.id = (
  SELECT id FROM users WHERE org_id = u.org_id ORDER BY created_at, id LIMIT 1
);
