import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { assertWithinBudget } from "@mailda/budgets";

import { seed, type Corpus } from "./seed.ts";

let corpus: Corpus;

beforeAll(async () => {
  corpus = await seed();
});

/**
 * Why this file measures rows scanned rather than milliseconds.
 *
 * `performance.now()` inside Workers is clamped by the same Spectre mitigation as
 * `Date.now()` — it returns the time of the last I/O and does not advance during code
 * execution. An earlier version of this test reported p50=1.000ms, p95=1.000ms across
 * every scenario, which is the clock's resolution rather than a measurement.
 *
 * D1 reports `meta.rows_read` per query, and #5's receipt recorded that D1 bills on
 * rows *scanned*, not returned. That number is deterministic, ties directly to cost and
 * to the 10 GB / 1 TB ceilings, and cannot be faked by a clamped clock. Wall-clock p95
 * against §23's 500 ms budget needs a deployed Node and belongs with #14.
 */
interface Cost {
  rowsRead: number;
  rowsWritten: number;
  /** Duration as reported by D1 itself, not by the clamped in-isolate clock. */
  d1Duration: number;
  queries: number;
}

async function costOf(run: () => Promise<Array<{ meta: D1Meta }>>): Promise<Cost> {
  const results = await run();
  return results.reduce<Cost>(
    (total, result) => ({
      rowsRead: total.rowsRead + (result.meta.rows_read ?? 0),
      rowsWritten: total.rowsWritten + (result.meta.rows_written ?? 0),
      d1Duration: total.d1Duration + (result.meta.duration ?? 0),
      queries: total.queries + 1,
    }),
    { rowsRead: 0, rowsWritten: 0, d1Duration: 0, queries: 0 },
  );
}

function report(label: string, cost: Cost): void {
  console.log(
    `MEASURE ${label}  queries=${cost.queries}  rows_read=${cost.rowsRead}  ` +
      `rows_written=${cost.rowsWritten}  d1_duration_ms=${cost.d1Duration.toFixed(3)}`,
  );
}

/** The two-round-trip check from src/authz.ts, instrumented. */
async function checkCost(userId: string, objectId: string): Promise<Cost> {
  return costOf(async () => {
    const teams = await env.CATALOG.prepare(
      "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
    )
      .bind(corpus.orgId, userId)
      .all<{ team_id: string }>();

    const subjects = [userId, ...teams.results.map((row) => row.team_id)];
    const placeholders = subjects.map(() => "?").join(", ");
    const tuple = await env.CATALOG.prepare(
      `SELECT 1 FROM relationship_tuples
       WHERE org_id = ? AND subject_id IN (${placeholders})
         AND object_type = 'mailbox' AND object_id = ? AND relation = ?
       LIMIT 1`,
    )
      .bind(corpus.orgId, ...subjects, objectId, "mailbox.content.read")
      .all();

    return [teams, tuple];
  });
}

/**
 * The two-relation form, from `hasAnyRelation` — a widened `relation IN (?, ?)`.
 *
 * Measured rather than assumed. The index #11 settled is
 * `(org_id, subject_id, object_type, relation, object_id)`, so widening the *fourth* column turns one seek
 * into one per relation named. That is a small multiple by construction, but "by construction" is what the
 * full-table scan #11 found also looked like: the column order was wrong and every check read 1,864 rows of a
 * 3,060-row corpus. So this is a number rather than an argument, and it shares the same budget — if the
 * two-relation form ever needed a larger one, the honest answer would be two single-relation queries.
 */
async function twoRelationCost(userId: string, objectId: string): Promise<Cost> {
  return costOf(async () => {
    const teams = await env.CATALOG.prepare(
      "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
    )
      .bind(corpus.orgId, userId)
      .all<{ team_id: string }>();

    const subjects = [userId, ...teams.results.map((row) => row.team_id)];
    const placeholders = subjects.map(() => "?").join(", ");
    const tuple = await env.CATALOG.prepare(
      `SELECT 1 FROM relationship_tuples
       WHERE org_id = ? AND subject_id IN (${placeholders})
         AND object_type = 'mailbox' AND relation IN (?, ?) AND object_id = ?
       LIMIT 1`,
    )
      .bind(corpus.orgId, ...subjects, "mailbox.metadata.read", "mailbox.content.read", objectId)
      .all();

    return [teams, tuple];
  });
}

async function listCost(userId: string): Promise<Cost> {
  return costOf(async () => {
    const teams = await env.CATALOG.prepare(
      "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
    )
      .bind(corpus.orgId, userId)
      .all<{ team_id: string }>();

    const subjects = [userId, ...teams.results.map((row) => row.team_id)];
    const placeholders = subjects.map(() => "?").join(", ");
    const visible = await env.CATALOG.prepare(
      `SELECT DISTINCT object_id FROM relationship_tuples
       WHERE org_id = ? AND subject_id IN (${placeholders})
         AND object_type = 'mailbox' AND relation = ?
       LIMIT 200`,
    )
      .bind(corpus.orgId, ...subjects, "mailbox.content.read")
      .all();

    return [teams, visible];
  });
}

describe("authz evaluation cost (#11)", () => {
  it("states the corpus shape, so the receipt can be disputed", () => {
    console.log(
      `CORPUS  users=${corpus.users.length}  teams=${corpus.teams.length}  ` +
        `mailboxes=${corpus.mailboxes.length}  tuples=${corpus.tupleCount}  ` +
        `memberships=${corpus.membershipCount}`,
    );
    expect(corpus.tupleCount).toBeGreaterThan(1000);
  });

  it("single-object check scans a bounded number of rows", async () => {
    const db = drizzle(env.CATALOG);
    const visible = await db.run(
      `SELECT DISTINCT object_id FROM relationship_tuples WHERE org_id = '${corpus.orgId}' LIMIT 1`,
    );
    expect(visible).toBeDefined();

    const typical = await checkCost(corpus.typicalUser, corpus.mailboxes[1]!);
    report("check.typical", typical);

    const heavy = await checkCost(corpus.heavyUser, corpus.mailboxes[0]!);
    report("check.heavy", heavy);

    const deny = await checkCost(corpus.typicalUser, "mbx_DOES_NOT_EXIST");
    report("check.deny", deny);

    // The tripwire from docs/receipts/authz-check-rows-read.md. A lost index blows
    // past this by two orders of magnitude, which is exactly the regression that was
    // present when this benchmark was first written.
    for (const [label, cost] of [["typical", typical], ["heavy", heavy], ["deny", deny]] as const) {
      assertWithinBudget("authz.check.max_rows_read", cost.rowsRead, { scenario: label });
      assertWithinBudget("authz.check.max_queries", cost.queries, { scenario: label });
    }
  });

  it("a two-relation check stays inside the same budget", async () => {
    const one = await checkCost(corpus.typicalUser, corpus.mailboxes[1]!);
    const two = await twoRelationCost(corpus.typicalUser, corpus.mailboxes[1]!);
    const denied = await twoRelationCost(corpus.typicalUser, "mbx_DOES_NOT_EXIST");
    report("check.two_relations", two);
    report("check.two_relations.deny", denied);
    console.log(
      `MEASURE relation_widening  rows_read_one=${one.rowsRead}  rows_read_two=${two.rowsRead}`,
    );

    for (const [label, cost] of [["two_relations", two], ["two_relations_deny", denied]] as const) {
      assertWithinBudget("authz.check.max_rows_read", cost.rowsRead, { scenario: label });
      assertWithinBudget("authz.check.max_queries", cost.queries, { scenario: label });
    }
    // Still a seek per relation, not a scan. Two relations must not cost more than a small multiple of one.
    expect(two.rowsRead).toBeLessThan(one.rowsRead * 2 + 10);
  });

  it("list case scans a bounded number of rows", async () => {
    const typical = await listCost(corpus.typicalUser);
    const heavy = await listCost(corpus.heavyUser);
    report("list.typical", typical);
    report("list.heavy", heavy);
    assertWithinBudget("authz.list.max_rows_read", typical.rowsRead, { scenario: "typical" });
    assertWithinBudget("authz.list.max_rows_read", heavy.rowsRead, { scenario: "heavy" });
  });

  it("cost does not grow with organisation size", async () => {
    // Same query against a corpus four times larger. If rows_read tracks corpus size,
    // the index is not being used and the p95 budget will not survive real data.
    const before = await checkCost(corpus.typicalUser, corpus.mailboxes[1]!);
    const grown = await seed({ users: 1600, teams: 160, mailboxes: 2400 });
    console.log(`CORPUS grown  tuples=${grown.tupleCount}  memberships=${grown.membershipCount}`);

    const after = await costOf(async () => {
      const teams = await env.CATALOG.prepare(
        "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
      )
        .bind(grown.orgId, grown.typicalUser)
        .all<{ team_id: string }>();
      const subjects = [grown.typicalUser, ...teams.results.map((row) => row.team_id)];
      const placeholders = subjects.map(() => "?").join(", ");
      const tuple = await env.CATALOG.prepare(
        `SELECT 1 FROM relationship_tuples
         WHERE org_id = ? AND subject_id IN (${placeholders})
           AND object_type = 'mailbox' AND object_id = ? AND relation = ?
         LIMIT 1`,
      )
        .bind(grown.orgId, ...subjects, grown.mailboxes[1]!, "mailbox.content.read")
        .all();
      return [teams, tuple];
    });

    report("check.typical.4x_corpus", after);
    console.log(
      `MEASURE scaling  corpus_growth=4x  rows_read_before=${before.rowsRead}  rows_read_after=${after.rowsRead}`,
    );

    // Indexed lookups are near-flat. Allow B-tree depth, not scans.
    expect(after.rowsRead).toBeLessThan(before.rowsRead * 3 + 20);
    assertWithinBudget("authz.check.max_rows_read", after.rowsRead, { scenario: "4x corpus" });
  });
});
