import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { assertWithinBudget } from "@mailda/budgets";
import { createSystemCtx } from "@mailda/runtime";

import { mayRead } from "../src/authz-read.ts";
import { metering } from "../src/cost-meter.ts";
import { liveGrantOnMailbox, SCOPES_FOR_CONTENT } from "../src/supervised.ts";

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


/**
 * What supervised reading (#63) costs the authorization path, measured because
 * `docs/receipts/authz-check-rows-read.md` bounds that path and its `stale_when` names *"ABAC/policy
 * conditions beginning to read additional rows on the request path"*. A grant lookup is exactly that, so the
 * question was never whether the receipt still holds but by how much — checked rather than assumed.
 *
 * ## Two instruments, because the receipt and the house rule ask different questions
 *
 * `rows_read` is what the receipt is written in, and it comes from D1's own `meta` — the reason this file
 * measures rows rather than milliseconds is at the top. `metering()` from `src/cost-meter.ts` is what AGENTS.md
 * requires for a subrequest figure, and it earns its place here for a second reason that matters more: it
 * prices **`mayRead` itself**, not a copy of its query. Every other measurement in this file re-writes the
 * statement under test, which is right for a receipt about an index and useless for the question *"did the real
 * function gain a round trip?"*. `authz.check.max_queries = 2` is what answers that, and a hand-copied query
 * cannot trip it.
 *
 * ## The prediction, stated before the numbers
 *
 * The supervised arm is a `UNION ALL` inside the statement the check was already issuing, and `sgr_live` is
 * partial on `granted_at IS NOT NULL`. So: **two queries either way**, and a rows_read delta of one index
 * seek — zero on a Node with no supervised access at all, because a partial index with no qualifying rows is
 * empty. The one place a real cost appears is a check that **misses** the tuple arm and then hits the grant
 * arm, because `LIMIT 1` can no longer stop at the first miss. Every comparison below is same-user, since a
 * heavy user's team resolution dominates the total and comparing across users would measure that instead.
 */
describe("supervised reading's effect on the authorization path (#63)", () => {
  /** A mailbox nobody in the corpus holds any relation on, so the tuple arm always misses. */
  const UNRELATED = "mbx_supervised_measure";

  async function liveGrantFor(userId: string, mailboxId: string): Promise<void> {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    await env.CATALOG.prepare(
      `INSERT INTO supervised_grants
         (id, org_id, subject_id, mailbox_id, scope, matter_id, requested_at, expires_at, granted_at)
       VALUES (?,?,?,?,?,NULL,?,?,?)`,
    ).bind(ctx.id("sgr"), corpus.orgId, userId, mailboxId, "content", at,
      new Date(ctx.now() + 3600_000).toISOString(), at).run();
  }

  /** Round trips spent by `mayRead` as the product calls it. Rows are measured separately: this meter counts
   * executions and cannot see D1's `meta`. */
  async function readQueries(userId: string, mailboxId: string): Promise<{ allowed: boolean; queries: number }> {
    const meter = metering(env as unknown as Env);
    const allowed = await mayRead(
      meter.env, createSystemCtx(), { orgId: corpus.orgId, userId }, mailboxId,
    );
    return { allowed, queries: meter.cost.d1Executions };
  }

  /** The two-arm statement, with the supervised arm built by the **source** rather than copied. */
  async function unionCost(userId: string, mailboxId: string): Promise<Cost> {
    return costOf(async () => {
      const teams = await env.CATALOG.prepare(
        "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
      ).bind(corpus.orgId, userId).all<{ team_id: string }>();

      const subjects = [userId, ...teams.results.map((row) => row.team_id)];
      const placeholders = subjects.map(() => "?").join(", ");
      const grant = liveGrantOnMailbox(
        corpus.orgId, userId, mailboxId, new Date().toISOString(), SCOPES_FOR_CONTENT,
      );
      const tuple = await env.CATALOG.prepare(
        `SELECT 1 FROM relationship_tuples
          WHERE org_id = ? AND subject_id IN (${placeholders})
            AND object_type = 'mailbox' AND relation IN (?) AND object_id = ?
         UNION ALL ${grant.sql} LIMIT 1`,
      ).bind(corpus.orgId, ...subjects, "mailbox.content.read", mailboxId, ...grant.params).all();

      return [teams, tuple];
    });
  }

  it("spends the same two round trips whether or not a grant is in play", async () => {
    // (1) Nothing supervised exists anywhere: the state of almost every Node, and the state the receipt's
    // existing figures were measured in.
    const cleanHit = await readQueries(corpus.typicalUser, corpus.mailboxes[1]!);
    const cleanMiss = await readQueries(corpus.typicalUser, UNRELATED);
    expect(cleanHit.allowed).toBe(true);
    expect(cleanMiss.allowed).toBe(false);

    // (2) A live grant on a mailbox the reader holds no relation on at all — the case the feature exists for.
    await liveGrantFor(corpus.typicalUser, UNRELATED);
    const supervisedHit = await readQueries(corpus.typicalUser, UNRELATED);
    // And a bystander with no grant, measured while the table is non-empty: what a Node pays for *somebody
    // else's* supervised access, which is what "no effect on the ordinary check" has to mean.
    const bystander = await readQueries(corpus.heavyUser, UNRELATED);
    expect(supervisedHit.allowed).toBe(true);
    expect(bystander.allowed).toBe(false);

    for (const [label, measured] of [
      ["absent.hit", cleanHit], ["absent.miss", cleanMiss],
      ["present.hit", supervisedHit], ["present.bystander", bystander],
    ] as const) {
      console.log(`MEASURE mayRead.${label}  queries=${measured.queries}  allowed=${measured.allowed}`);
      assertWithinBudget("authz.check.max_queries", measured.queries, { scenario: label });
      // The whole point: the supervised arm rides in a statement that was already being issued, so a
      // supervised read is not a third round trip. This is the assertion a second query would fail.
      expect(measured.queries).toBe(2);
    }
  });

  it("adds an index seek rather than a scan, in rows_read", async () => {
    /*
     * Same user on both sides of each comparison. The interesting pair is the **deny** one: without the arm,
     * `LIMIT 1` lets the planner stop at the first missing subject; with it, the compound has to exhaust the
     * tuple arm before it can try the grant. That is the real cost of this feature and it is printed rather
     * than argued.
     */
    const hitBefore = await checkCost(corpus.typicalUser, corpus.mailboxes[1]!);
    const hitAfter = await unionCost(corpus.typicalUser, corpus.mailboxes[1]!);
    const missBefore = await checkCost(corpus.typicalUser, UNRELATED);
    const missAfter = await unionCost(corpus.typicalUser, UNRELATED);

    await liveGrantFor(corpus.heavyUser, UNRELATED);
    const heavyBefore = await checkCost(corpus.heavyUser, UNRELATED);
    const heavyAfter = await unionCost(corpus.heavyUser, UNRELATED);

    for (const [label, cost] of [
      ["hit.standing_only", hitBefore], ["hit.with_arm", hitAfter],
      ["miss.standing_only", missBefore], ["miss.with_arm", missAfter],
      ["heavy_granted.standing_only", heavyBefore], ["heavy_granted.with_arm", heavyAfter],
    ] as const) {
      report(`supervised.${label}`, cost);
      assertWithinBudget("authz.check.max_rows_read", cost.rowsRead, { scenario: label });
      assertWithinBudget("authz.check.max_queries", cost.queries, { scenario: label });
    }
    console.log(
      `MEASURE supervised_arm  hit=${hitBefore.rowsRead}->${hitAfter.rowsRead}  `
        + `miss=${missBefore.rowsRead}->${missAfter.rowsRead}  `
        + `heavy_granted=${heavyBefore.rowsRead}->${heavyAfter.rowsRead}`,
    );

    // A hit on the tuple arm short-circuits exactly as it did: the arm costs nothing when the first one wins.
    expect(hitAfter.rowsRead).toBeLessThanOrEqual(hitBefore.rowsRead + 2);
    /*
     * A miss pays for the grant seek the early exit used to skip, and the measurement says that is **one row**
     * — not a multiple of anything. `+ 5` rather than `+ 1` so a B-tree that gains a level does not fail this,
     * and deliberately not a multiple of the baseline: a bound written as `× 5` would let a scan through, and a
     * scan is the only failure this assertion is for.
     */
    expect(missAfter.rowsRead).toBeLessThanOrEqual(missBefore.rowsRead + 5);
    expect(heavyAfter.rowsRead).toBeLessThanOrEqual(heavyBefore.rowsRead + 5);
  });
});
