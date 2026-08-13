import { env } from "cloudflare:test";
import { beforeAll, describe, it } from "vitest";

import { seed, type Corpus } from "./seed.ts";

let corpus: Corpus;
beforeAll(async () => {
  corpus = await seed();
});

async function explain(label: string, sql: string, binds: unknown[]): Promise<void> {
  const plan = await env.CATALOG.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...binds)
    .all<{ detail: string }>();
  console.log(`PLAN ${label}`);
  for (const row of plan.results) console.log(`  ${row.detail}`);
}

describe("query plans", () => {
  it("shows what the planner actually does", async () => {
    await explain(
      "team_members by user",
      "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
      [corpus.orgId, corpus.typicalUser],
    );
    await explain(
      "tuple check (IN list of 3)",
      `SELECT 1 FROM relationship_tuples
       WHERE org_id = ? AND subject_id IN (?, ?, ?)
         AND object_type = 'mailbox' AND object_id = ? AND relation = ? LIMIT 1`,
      [corpus.orgId, corpus.typicalUser, "a", "b", corpus.mailboxes[1]!, "mailbox.content.read"],
    );
    await explain(
      "tuple check (single subject, no IN)",
      `SELECT 1 FROM relationship_tuples
       WHERE org_id = ? AND subject_id = ?
         AND object_type = 'mailbox' AND object_id = ? AND relation = ? LIMIT 1`,
      [corpus.orgId, corpus.typicalUser, corpus.mailboxes[1]!, "mailbox.content.read"],
    );
    await explain(
      // The two-relation form from `hasAnyRelation`. The receipt claims the prefix up to `object_type` stays
      // usable when the *relation* column is widened, and this is where that claim can be read rather than
      // trusted — #11's whole lesson being that a plan looked fine right up until it was printed.
      "tuple check (relation IN list of 2)",
      `SELECT 1 FROM relationship_tuples
       WHERE org_id = ? AND subject_id IN (?, ?, ?)
         AND object_type = 'mailbox' AND relation IN (?, ?) AND object_id = ? LIMIT 1`,
      [corpus.orgId, corpus.typicalUser, "a", "b",
        "mailbox.metadata.read", "mailbox.content.read", corpus.mailboxes[1]!],
    );
    await explain(
      "list visible (IN list of 3)",
      `SELECT DISTINCT object_id FROM relationship_tuples
       WHERE org_id = ? AND subject_id IN (?, ?, ?)
         AND object_type = 'mailbox' AND relation = ? LIMIT 200`,
      [corpus.orgId, corpus.typicalUser, "a", "b", "mailbox.content.read"],
    );
  });
});
