import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { relationshipTuples, teamMembers } from "./schema.ts";

export interface CheckInput {
  orgId: string;
  userId: string;
  relation: string;
  objectType: string;
  objectId: string;
}

type Db = DrizzleD1Database<Record<string, never>>;

/**
 * Single-object check: may this user act on this object, directly or through a team?
 *
 * §7: "resource relations are evaluated server-side on every operation" and sensitive
 * facts are "never trusted from a token claim". So this runs on the request path, and
 * its cost is inside §23's p95 < 500 ms budget.
 */
export async function check(db: Db, input: CheckInput): Promise<boolean> {
  const teams = await teamIdsFor(db, input.orgId, input.userId);
  const subjects = [input.userId, ...teams];

  const rows = await db
    .select({ one: sql<number>`1` })
    .from(relationshipTuples)
    .where(
      and(
        eq(relationshipTuples.orgId, input.orgId),
        inArray(relationshipTuples.subjectId, subjects),
        eq(relationshipTuples.objectType, input.objectType),
        eq(relationshipTuples.objectId, input.objectId),
        eq(relationshipTuples.relation, input.relation),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * List case: which objects of this type may this user act on?
 *
 * §5 requires authorization *before* returning counts, snippets, participants or
 * existence — so list endpoints cannot filter after the fact. This is the query that
 * decides whether the p95 budget holds.
 */
export async function listVisible(
  db: Db,
  input: Omit<CheckInput, "objectId">,
  limit = 200,
): Promise<string[]> {
  const teams = await teamIdsFor(db, input.orgId, input.userId);
  const subjects = [input.userId, ...teams];

  const rows = await db
    .selectDistinct({ objectId: relationshipTuples.objectId })
    .from(relationshipTuples)
    .where(
      and(
        eq(relationshipTuples.orgId, input.orgId),
        inArray(relationshipTuples.subjectId, subjects),
        eq(relationshipTuples.objectType, input.objectType),
        eq(relationshipTuples.relation, input.relation),
      ),
    )
    .limit(limit);

  return rows.map((row) => row.objectId);
}

/**
 * Both queries above need the user's teams first. Kept as one round trip rather than a
 * join so the cost is visible in a trace — #10 noted D1 bills on rows *scanned*, and an
 * accidental scan hidden inside a join is exactly the cost that goes unnoticed.
 */
async function teamIdsFor(db: Db, orgId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.orgId, orgId), eq(teamMembers.userId, userId)));
  return rows.map((row) => row.teamId);
}

/** Variant that resolves teams inside a single SQL statement, for comparison. */
export async function checkSingleStatement(db: Db, input: CheckInput): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(relationshipTuples)
    .where(
      and(
        eq(relationshipTuples.orgId, input.orgId),
        eq(relationshipTuples.objectType, input.objectType),
        eq(relationshipTuples.objectId, input.objectId),
        eq(relationshipTuples.relation, input.relation),
        or(
          eq(relationshipTuples.subjectId, input.userId),
          inArray(
            relationshipTuples.subjectId,
            db
              .select({ teamId: teamMembers.teamId })
              .from(teamMembers)
              .where(and(eq(teamMembers.orgId, input.orgId), eq(teamMembers.userId, input.userId))),
          ),
        ),
      ),
    )
    .limit(1);

  return rows.length > 0;
}
