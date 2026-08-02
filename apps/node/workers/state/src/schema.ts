import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * ReBAC relationship tuples (§12 `relationship_tuples`).
 *
 * §7 forbids trusting a token for ACL state, so every request re-evaluates these
 * server-side. That makes the shape of this table the shape of the p95 budget.
 *
 * Identifiers are typed-prefix ULIDs (#6). The UNIQUE constraint below is what makes a
 * write retry-safe (#9) — it is the derived key, not the row's own identity.
 */
export const relationshipTuples = sqliteTable(
  "relationship_tuples",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    subjectId: text("subject_id").notNull(),
    relation: text("relation").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // One index, three jobs: the derived key that makes a replayed grant retry-safe
    // (#9), the prefix the single-object check needs (all five columns), and the prefix
    // the list case needs (first four, reading object_id out of the index).
    //
    // Column order is load-bearing. An earlier version placed a `subject_type` column
    // second, which truncated the usable prefix to org_id and made every check scan the
    // whole organisation. See docs/receipts/authz-check-rows-read.md.
    uniqueIndex("rt_unique").on(
      table.orgId,
      table.subjectId,
      table.objectType,
      table.relation,
      table.objectId,
    ),
  ],
);

/** Team membership, so a check can resolve subject -> team -> object in one hop. */
export const teamMembers = sqliteTable(
  "team_members",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // user_id before team_id: the hot query is "which teams is this user in".
    uniqueIndex("tm_unique").on(table.orgId, table.userId, table.teamId),
  ],
);
