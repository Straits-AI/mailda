-- Additive migration (#10 expand/contract). No DROP, so no bookmark gate required.
--
-- There is deliberately no `subject_type` column. Identifiers are typed-prefix ULIDs
-- (#6), so `usr_01J...` and `tm_01J...` already carry their type. A separate column
-- would be duplicate state that can disagree with the id, and an earlier version of
-- this schema put it second in the unique index, which truncated the usable index
-- prefix to `org_id` alone and made every authorization check scan the whole org.
-- See docs/receipts/authz-check-rows-read.md.
CREATE TABLE relationship_tuples (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  relation    TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- One index serves three jobs: it enforces the derived-key uniqueness that makes a
-- replayed grant retry-safe (#9), and its column order is the prefix both query shapes
-- need -- the single-object check consumes all five columns, and the list case consumes
-- the first four and reads object_id straight out of the index.
CREATE UNIQUE INDEX rt_unique
  ON relationship_tuples (org_id, subject_id, object_type, relation, object_id);

CREATE TABLE team_members (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- user_id before team_id: the hot query is "which teams is this user in", never the
-- reverse. Same prefix lesson as above.
CREATE UNIQUE INDEX tm_unique ON team_members (org_id, user_id, team_id);
