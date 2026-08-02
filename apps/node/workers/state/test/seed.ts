import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";

import { createFrozenCtx } from "@mailda/runtime";

import { relationshipTuples, teamMembers } from "../src/schema.ts";

export interface Corpus {
  orgId: string;
  users: string[];
  teams: string[];
  mailboxes: string[];
  /** A user with a typical number of relations. */
  typicalUser: string;
  /** A user in every team and on many mailboxes — the worst realistic case. */
  heavyUser: string;
  tupleCount: number;
  membershipCount: number;
}

/**
 * Builds a corpus shaped like a real mid-size organisation rather than a round number.
 *
 * The shape is the receipt's most important claim: a p95 measured against 100 tuples
 * proves nothing. Sizes here are stated so the receipt can be re-read and disputed.
 */
export async function seed(options?: {
  users?: number;
  teams?: number;
  mailboxes?: number;
}): Promise<Corpus> {
  const userCount = options?.users ?? 400;
  const teamCount = options?.teams ?? 40;
  const mailboxCount = options?.mailboxes ?? 600;

  const ctx = createFrozenCtx();
  const db = drizzle(env.CATALOG);
  const orgId = ctx.id("org");
  const at = new Date(ctx.now()).toISOString();

  const users = Array.from({ length: userCount }, () => ctx.id("usr"));
  const teams = Array.from({ length: teamCount }, () => ctx.id("tm"));
  const mailboxes = Array.from({ length: mailboxCount }, () => ctx.id("mbx"));

  const memberships: Array<typeof teamMembers.$inferInsert> = [];
  for (const [index, userId] of users.entries()) {
    // Most people are in 2 teams; every 40th person is in many.
    const count = index % 40 === 0 ? 12 : 2;
    for (let n = 0; n < count; n++) {
      memberships.push({
        id: ctx.id("tmm"),
        orgId,
        teamId: teams[(index + n * 7) % teams.length]!,
        userId,
        createdAt: at,
      });
    }
  }

  const tuples: Array<typeof relationshipTuples.$inferInsert> = [];
  const relations = ["mailbox.content.read", "mailbox.metadata.read", "send.propose"];

  // Personal mailbox: every user owns one.
  for (const [index, userId] of users.entries()) {
    for (const relation of relations) {
      tuples.push({
        id: ctx.id("rt"),
        orgId,
        subjectId: userId,
        relation,
        objectType: "mailbox",
        objectId: mailboxes[index % mailboxes.length]!,
        createdAt: at,
      });
    }
  }

  // Shared mailboxes are granted to teams, which is how real orgs do it.
  for (const [index, teamId] of teams.entries()) {
    for (let n = 0; n < 8; n++) {
      for (const relation of relations) {
        tuples.push({
          id: ctx.id("rt"),
          orgId,
          subjectId: teamId,
          relation,
          objectType: "mailbox",
          objectId: mailboxes[(index * 8 + n) % mailboxes.length]!,
          createdAt: at,
        });
      }
    }
  }

  await insertChunked(db, teamMembers, memberships);
  await insertChunked(db, relationshipTuples, tuples);

  return {
    orgId,
    users,
    teams,
    mailboxes,
    typicalUser: users[1]!,
    heavyUser: users[0]!,
    tupleCount: tuples.length,
    membershipCount: memberships.length,
  };
}

/**
 * D1 allows 100 bound parameters per query (receipt: d1-platform-limits). Chunking is
 * not an optimisation here, it is the limit — an unchunked insert simply fails.
 */
async function insertChunked<T extends { $inferInsert: Record<string, unknown> }>(
  db: ReturnType<typeof drizzle>,
  table: T,
  rows: Array<T["$inferInsert"]>,
): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!).length;
  const perStatement = Math.max(1, Math.floor(100 / columns));
  for (let index = 0; index < rows.length; index += perStatement) {
    const slice = rows.slice(index, index + perStatement);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic table insert
    await (db.insert(table as any) as any).values(slice).run();
  }
}
