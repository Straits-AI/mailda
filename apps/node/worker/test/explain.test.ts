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
    await explain(
      /*
       * The supervised arm (#63), which is where two index claims can be read rather than trusted.
       *
       * `sgr_live` is described as **covering** and as using all five constrained columns, and the first
       * version of it was neither: with `expires_at` ahead of `scope` the plan stopped at the range and
       * checked the scope off the row. Both halves of the claim are read here rather than trusted, which is
       * how that was found. The arm also rides in the same statement as the tuple lookup, so the plan must
       * show one compound with two searches — not two statements, and not a scan of either table.
       */
      "supervised arm (UNION ALL with the tuple check)",
      `SELECT 1 FROM relationship_tuples
       WHERE org_id = ? AND subject_id IN (?, ?, ?)
         AND object_type = 'mailbox' AND relation IN (?) AND object_id = ?
       UNION ALL
       SELECT 1 FROM supervised_grants
        WHERE org_id = ? AND subject_id = ? AND mailbox_id = ?
          AND granted_at IS NOT NULL AND expires_at > ? AND scope IN (?)
       LIMIT 1`,
      [corpus.orgId, corpus.typicalUser, "a", "b", "mailbox.content.read", corpus.mailboxes[1]!,
        corpus.orgId, corpus.typicalUser, corpus.mailboxes[1]!, new Date().toISOString(), "content"],
    );
    await explain(
      /*
       * `doctor`'s self-grant finding, and this plan is why migration 0023 has **no** index for it. It first
       * carried a partial one keyed on the condition itself; SQLite never chose it, and forced with
       * `INDEXED BY` it was worse — usable on `org_id` alone, because SQLite's test for whether a query
       * implies a partial index's predicate does not credit a column-to-column comparison. `audit_by_action`
       * (0008) wins and is the right answer: the seek lands on this organization's `access.granted` entries,
       * so the cost is proportional to **grants made** rather than to the age of the trail. A plan naming
       * `SCAN audit_entries` here would mean the finding grows with the Node's whole history, which is what
       * `doctor.max_subrequests_per_run` exists to catch.
       */
      "self-grant count (no index of its own, by measurement)",
      `SELECT COUNT(*) AS n, MAX(at) AS last FROM audit_entries
        WHERE org_id = ? AND action = 'access.granted' AND actor_user_id = subject`,
      [corpus.orgId],
    );
  });
});
