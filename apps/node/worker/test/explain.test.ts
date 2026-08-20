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
       * The same arm after #63 part B, which selects the **grant id** rather than a bare 1 — because an act
       * entry cites the grant that authorized it, and a check that answered a bare yes could not be recorded
       * against anything.
       *
       * `sgr_live` gained `id` as a trailing key column in migration 0024 for exactly this, and the claim
       * that it is still **covering** is what has to be read rather than trusted: without it SQLite reads the
       * table row to fetch a column the index does not carry, and `authz-check-rows-read.md` says COVERING in
       * print. Same lesson as the column-order defect the plan above found, one release later.
       */
      "supervised arm returning the grant id (#63 part B)",
      `SELECT NULL AS grant_id FROM relationship_tuples
       WHERE org_id = ? AND subject_id IN (?, ?, ?)
         AND object_type = 'mailbox' AND relation IN (?) AND object_id = ?
       UNION ALL
       SELECT id FROM supervised_grants
        WHERE org_id = ? AND subject_id = ? AND mailbox_id = ?
          AND granted_at IS NOT NULL AND expires_at > ? AND scope IN (?)
       LIMIT 1`,
      [corpus.orgId, corpus.typicalUser, "a", "b", "mailbox.content.read", corpus.mailboxes[1]!,
        corpus.orgId, corpus.typicalUser, corpus.mailboxes[1]!, new Date().toISOString(), "content"],
    );
    await explain(
      /*
       * The delivering scan's due-row read (#63 part B). `ntf_due` is partial on `delivered_at IS NULL`, so a
       * delivered notice leaves the index for ever and this seek is into something that empties itself —
       * which is the whole reason a scan running sixty times an hour costs one query on an idle Node. A plan
       * naming `SCAN notifications` here would mean the cron's cost grows with everything ever delivered.
       */
      "notifications due (partial index on the undelivered ones)",
      `SELECT id, kind, subject_id, mailbox_id FROM notifications
        WHERE org_id = ? AND delivered_at IS NULL AND due_at IS NOT NULL AND due_at <= ?
        ORDER BY due_at LIMIT ?`,
      [corpus.orgId, new Date().toISOString(), 50],
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
