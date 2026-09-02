import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { assertWithinBudget, BUDGETS } from "@mailda/budgets";
import { createSystemCtx } from "@mailda/runtime";

import { messagePageQuery } from "../src/authz-read.ts";
import { ftsQuery, indexBody, indexMessage } from "../src/search.ts";
import { liveGrantsBySubject, SCOPES_FOR_CONTENT, SCOPES_FOR_METADATA } from "../src/supervised.ts";

/**
 * What a searched page costs, against the same budget the plain listing lives inside (#107).
 *
 * The measurement behind `docs/receipts/message-search-cost.md`. The question is not whether FTS5 is fast —
 * `d1-fts5-search.md` settled that the index works — it is whether **adding a term to this listing** keeps
 * the page inside `authz.list.max_rows_read`, and whether it stays there as the archive grows.
 *
 * `messagePageQuery` is imported rather than restated, for the reason `message-page.measure.test.ts` gives:
 * `authz.measure.test.ts` hand-copied the statements it priced, and its receipt now describes a query nothing
 * measured.
 *
 * ## The shape being checked, and the wrong answer this file caught
 *
 * A searched page is **driven by the index, ordered by rank and capped** — a different plan from the plain
 * listing, which is driven by `ir_org_accepted` in `accepted_at` order with a keyset cursor.
 *
 * It was first built as one plan: the match as an extra predicate on the listing, keeping the time ordering
 * and the cursor, on the argument that a semi-join leaves `ingress_receipts` driving so a searched page pages
 * like an unsearched one. Measured on this corpus:
 *
 * | shape (subjects only, as first measured) | rare term (12 hits) | common term (1,188 hits) |
 * |:--|--:|--:|
 * | time-driven, match as a filter | **3,640** | 2,584 |
 * | index-driven, `ORDER BY rank` | **64** | **258** |
 * | index-driven, `ORDER BY accepted_at` | 63 | **5,943** |
 *
 * Those figures are one arm. The shipped query is a **union of two** — subjects and bodies, authorized
 * differently — so the real cost is roughly double: **150** and **616** against a 1,000-row budget.
 *
 * Ordering by time while filtering by match costs **O(corpus), not O(matches)** — filling a page of the twelve
 * newest matching messages walks all 1,200 receipts, because the time index knows nothing about which match.
 * `AS MATERIALIZED` on the subquery removed the repeated match and left the walk, which was the expensive
 * half. Only the ranked, capped plan is inside the budget for both terms.
 *
 * So the plan is printed on every run rather than assumed, because the losing design read correctly in review
 * and had a confident comment explaining why it was safe.
 */

const testEnv = env as unknown as Env;
const ORG = "org_search_measure";
const READER = "usr_search_measure";
const MAILBOX = "mbx_search_measure";
const ADDRESS = "in@search-measure.example";
const AUGUST = Date.parse("2026-08-01T00:00:00.000Z");

/**
 * Deliveries seeded, matching `message-page-size.md`'s corpus so the two figures are comparable.
 *
 * A search figure measured on a smaller corpus than the plain page's would be the more flattering number for
 * no reason, and the comparison is the whole point of this file.
 */
const DELIVERIES = 1200;

/** How many of them contain the rare term. One in a hundred — a real search, not a filter. */
const RARE_EVERY = 100;

interface Cost { rowsRead: number; rows: number }

async function cost(
  term: string | null,
  mailboxId: string | null = null,
  window: { since?: string | null; until?: string | null } = {},
): Promise<Cost> {
  const query = messagePageQuery({
    sponsor: { sql: "", params: [] }, // a human reader has no sponsor ceiling
    orgId: ORG,
    subjects: [READER],
    supervised: {
      metadata: liveGrantsBySubject(ORG, READER, new Date(AUGUST).toISOString(), SCOPES_FOR_METADATA),
      content: liveGrantsBySubject(ORG, READER, new Date(AUGUST).toISOString(), SCOPES_FOR_CONTENT),
    },
    page: {
      after: null, mailboxId, q: term === null ? null : ftsQuery(term),
      since: window.since ?? null, until: window.until ?? null, from: null,
    },
    limit: BUDGETS["messages.page_size"] + 1,
  });
  const result = await testEnv.CATALOG.prepare(query.sql).bind(...query.params).all<{ id: string }>();
  return { rowsRead: result.meta.rows_read ?? 0, rows: result.results.length };
}

async function planFor(term: string | null): Promise<string> {
  const query = messagePageQuery({
    sponsor: { sql: "", params: [] }, // a human reader has no sponsor ceiling
    orgId: ORG,
    subjects: [READER],
    supervised: {
      metadata: liveGrantsBySubject(ORG, READER, new Date(AUGUST).toISOString(), SCOPES_FOR_METADATA),
      content: liveGrantsBySubject(ORG, READER, new Date(AUGUST).toISOString(), SCOPES_FOR_CONTENT),
    },
    page: { after: null, mailboxId: null, q: term === null ? null : ftsQuery(term), since: null, until: null, from: null },
    limit: BUDGETS["messages.page_size"] + 1,
  });
  const explained = await testEnv.CATALOG.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .bind(...query.params).all<{ detail: string }>();
  return explained.results.map((row) => row.detail).join("\n");
}

beforeAll(async () => {
  const ctx = createSystemCtx();
  const at = new Date(AUGUST).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Enquiries", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, READER, "mailbox.content.read", "mailbox", MAILBOX, at),
  ]);

  const statements = [];
  for (let n = 0; n < DELIVERIES; n++) {
    // Deterministic, zero-padded ids, for `message-page-size.md`'s reason: the keyset order is
    // `(accepted_at, id)` and a random ULID would decide ties differently on every run.
    const receiptId = `rcpt_srch${String(n).padStart(21, "0")}`;
    const messageId = `msg_srch${String(n).padStart(22, "0")}`;
    const acceptedAt = new Date(AUGUST + Math.floor(n / 4) * 4 * 60_000).toISOString();
    /*
     * The rare term appears in one message per hundred, and **the common term in every one**. Two terms
     * because they price different things: a rare term measures the search everybody actually runs, and a
     * common one measures the worst case, where the index excludes nothing and the page is the plain page
     * plus the cost of having asked.
     */
    const subject = n % RARE_EVERY === 0
      ? `Demurrage claim ${n} on the Hapag booking`
      : `Shipment update ${n} for the quarter`;
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
         blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(receiptId, ORG, `evt_srch_${n}`, `sender-${n}@supplier.example.net`, ADDRESS, 24_576,
      `${ORG}/raw/${receiptId}`, "0".repeat(64), acceptedAt));
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
         thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
         thread_root_rfc_id, conversation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(messageId, ORG, "2026-Q3", `${ORG}/raw/${receiptId}`, "0".repeat(64), 24_576,
      `${receiptId}@example.net`, `thr_srch${String(n).padStart(22, "0")}`, subject,
      `sender-${n}@supplier.example.net`, acceptedAt, acceptedAt, receiptId, acceptedAt,
      `${receiptId}@example.net`, `cnv_srch${String(n).padStart(22, "0")}`));
    statements.push(indexMessage(testEnv, messageId));
    /*
     * **A body for every message, and the figures depend on it.** The first version of this fixture indexed
     * only subjects, so the body arm of the union probed an empty index and the measurement reported a cost
     * the shipped query would never have — a receipt describing a corpus that does not exist.
     *
     * The body text mirrors the subject's selectivity: the rare term is rare in bodies too and the common one
     * is common. The first attempt put `demurrage` in every body — including the ones saying a claim was
     * *not* raised — which made the "rare" term match all 1,200 bodies and reported 372 rows for what was
     * supposed to be the cheap case. A fixture whose two terms have the same selectivity measures one thing
     * twice.
     */
    statements.push(indexBody(testEnv, messageId, n % RARE_EVERY === 0
      ? `demurrage was claimed on booking ${n} and the container held`
      : `container ${n} cleared and the shipment was released on time`, 0));
  }
  // Batched in chunks: one 3,600-statement batch exceeds what D1 will accept in a single call.
  for (let at2 = 0; at2 < statements.length; at2 += 300) {
    await testEnv.CATALOG.batch(statements.slice(at2, at2 + 300));
  }
});

describe("what a searched page costs", () => {
  it("seeds a corpus in which the term is selective, so the figures below mean something", async () => {
    /*
     * Anti-vacuity. If the index were empty every search would read almost nothing and this file would report
     * a triumph — the cheapest possible search is one that finds nothing. So the rare term must actually
     * return rows, and the common one must return a full page.
     */
    const rare = await cost("demurrage");
    const common = await cost("shipment");
    expect(rare.rows, "the rare term matches nothing — the index did not populate").toBeGreaterThan(1);
    expect(common.rows, "the common term does not fill a page").toBe(BUDGETS["messages.page_size"] + 1);
  });

  it("stays inside the list budget on a rare term and on a common one", async () => {
    const plain = await cost(null);
    const rare = await cost("demurrage");
    const common = await cost("shipment");
    const twoWords = await cost("demurrage hapag");

    process.stdout.write(
      `\nMEASURE message_search  deliveries=${DELIVERIES}  plain=${plain.rowsRead}  `
      + `rare=${rare.rowsRead} (${rare.rows} rows)  common=${common.rowsRead}  `
      + `two_words=${twoWords.rowsRead}\n`,
    );

    for (const [what, measured] of [["rare", rare], ["common", common], ["two words", twoWords]] as const) {
      assertWithinBudget("authz.list.max_rows_read", measured.rowsRead, {
        what: `one searched inbox page (${what})`,
        receipt: "docs/receipts/message-search-cost.md",
      });
      /*
       * **And against the measured figure, not only the ceiling.** This is the assertion
       * `doctor-check-cost.md` wishes it had: a 1,000-row ceiling says nothing while there is headroom, and
       * the losing design sat at 2,584 on this very term — over the budget, but a version of it that had come
       * in at 900 would have passed a ceiling check and shipped an O(corpus) search.
       *
       * `search.max_rows_read_per_page` is the worst of the three terms as measured. It must be updated
       * deliberately when the query legitimately changes, which is the cost of an assertion this tight and is
       * the point: a figure that moves silently is a figure nobody is checking.
       */
      assertWithinBudget("search.max_rows_read_per_page", measured.rowsRead, {
        what: `one searched inbox page (${what}), against the measured figure rather than the ceiling`,
        receipt: "docs/receipts/message-search-cost.md",
      });
    }
  });


  it("drives a searched page from the index and a plain one from the time order", async () => {
    /*
     * The plans, printed rather than trusted, and the assertion that would catch the design this file already
     * rejected once.
     *
     * A searched page must be driven by the **virtual table** — the FTS scan is the outer loop and `messages`,
     * `ingress_receipts` and `addresses` are seeks off it. If a future edit makes `ingress_receipts` the driver
     * again with the match as a predicate, the rare-term figure goes back to 3,640 and this fails.
     */
    const searched = await planFor("demurrage");
    const plain = await planFor(null);
    process.stdout.write(`\nPLAN searched page\n${searched}\n\nPLAN plain page\n${plain}\n`);

    // The virtual table drives the searched plan: `SCAN s VIRTUAL TABLE` before any receipt access.
    expect(searched, "the searched page is no longer driven by the search index")
      .toMatch(/SCAN s VIRTUAL TABLE/);
    expect(
      searched.indexOf("VIRTUAL TABLE") < searched.indexOf("ingress_receipts"),
      "receipts are reached before the index, which is the O(corpus) plan this replaced",
    ).toBe(true);

    /*
     * And the plain page is untouched by all of this. The two plans share a column list and an authorization
     * predicate, so a change to either could quietly re-plan the listing — which is the whole reason the
     * listing's own figure is asserted here as well as in `message-page-size.md`.
     */
    expect(plain, "the plain listing no longer seeks on ir_org_accepted").toContain("ir_org_accepted");
    expect(plain, "the plain listing now sorts instead of reading its order from the index")
      .not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("costs a rare search less than the plain page, which is the point of an index", async () => {
    /*
     * Direction, not just a ceiling — and this is the assertion that failed against the first design.
     *
     * A search that reads *more* than the unfiltered listing means the index is being consulted and then
     * ignored: the rows were fetched and then filtered, rather than found. Asserted because "inside the
     * budget" was true of that failure too at 2,584, and only the rare term's 3,640 gave it away.
     */
    const plain = await cost(null);
    const rare = await cost("demurrage");
    expect(rare.rowsRead).toBeLessThan(plain.rowsRead);
  });

  it("does not grow with the archive on a term that matches almost everything", async () => {
    /*
     * The worst case, kept honest. A common term matches 1,188 of 1,200 messages, so the index excludes
     * nothing and the page is the cost of having asked. What must not happen is the cost tracking the *match
     * set* rather than the page: ordering an index-driven plan by time costs 5,943 here, because every match
     * is fetched and sorted before fifty are returned.
     *
     * `ORDER BY rank LIMIT n` is what keeps it near the page size, and the ratio is the assertion — a figure
     * that drifted to the match set's size would pass a fixed ceiling of 1,000 and fail this.
     */
    const common = await cost("shipment");
    expect(common.rows).toBe(BUDGETS["messages.page_size"] + 1);
    /*
     * **Twenty, not ten, and the doubling is the union.** Each arm seeks the receipt, its address, its message
     * and its case per row it returns, so one arm is about four reads per row and two arms about eight, plus
     * the two index scans and the outer sort. Measured at 616 for 51 rows — a little over twelve each.
     *
     * The bound is what would catch the failure this file exists for: a plan that sorted the *match set*
     * rather than taking the top of it read 5,943 here, which is 116 per row and nowhere near twenty.
     */
    expect(
      common.rowsRead,
      "a page of a common term now costs more than twenty reads per row returned — a plan sorting the whole "
      + "match set rather than taking the top of it, which is the shape this design replaced",
    ).toBeLessThan(common.rows * 20);
  });
});

/**
 * What a date window costs, on each of the two plans (#107).
 *
 * The ticket claimed `since` and `until` are *"ordinary range predicates and want no index beyond what
 * exists"*. That is true, and it undersells them on one plan and oversells them on the other — which is why
 * this is measured rather than asserted.
 *
 * On the **unsearched** plan they are bounds on `accepted_at`, the column `ir_org_accepted` is built on. So
 * they are the same shape as the cursor, and `since` lets the backward scan **stop** instead of running to
 * the beginning of the archive: a bounded page costs less than an unbounded one, which is the opposite of
 * what a filter usually does.
 *
 * On the **searched** plan there is no such seek. Each arm is driven by its virtual table and capped by
 * `ORDER BY rank LIMIT ?`, so a window is a residual filter and the arm scans **further** through its MATCH
 * result to fill the cap. That direction has to be measured against `authz.list.max_rows_read`, because it
 * is the one that can grow.
 */
describe("what a date window costs", () => {
  /** Half way through the seeded twenty hours, so a window genuinely excludes most of the corpus. */
  const MIDPOINT = new Date(AUGUST + 10 * 60 * 60_000).toISOString();

  it("never costs an unsearched page more, and costs it less when the window is short", async () => {
    /*
     * The ticket claimed these are *"ordinary range predicates"*, and the honest figures are more specific
     * than that in both directions.
     *
     * A window over half the corpus reads **exactly** what an unbounded page reads: the scan stops at
     * `LIMIT` either way, so nothing is saved. My own claim that a bounded page is cheaper was wrong for the
     * common case, and the measurement is what said so.
     *
     * A window holding **less** than a page is where the bound pays: the backward scan reaches the lower
     * bound and stops, instead of continuing to look for rows that are not there. That is the property that
     * distinguishes `since` from the sender filter in #152 — one reaches the index, the other does not.
     */
    const unbounded = await cost(null);
    const half = await cost(null, null, { since: MIDPOINT });
    const narrow = await cost(null, null, {
      since: MIDPOINT, until: new Date(AUGUST + 10 * 60 * 60_000 + 20 * 60_000).toISOString(),
    });

    console.log(
      `MEASURE page_rows_read unbounded=${unbounded.rowsRead} half=${half.rowsRead}(${half.rows} rows) `
      + `narrow=${narrow.rowsRead}(${narrow.rows} rows)`,
    );

    expect(half.rows).toBe(unbounded.rows);
    expect(half.rowsRead).toBeLessThanOrEqual(unbounded.rowsRead);
    // Short window: fewer rows returned **and** fewer read, which is the bound reaching the index.
    expect(narrow.rows).toBeLessThan(unbounded.rows);
    expect(narrow.rowsRead).toBeLessThan(unbounded.rowsRead);
  });

  it("is why a window and a search term are refused together", async () => {
    /*
     * The figure the refusal in `messagePageRequest` rests on, measured here so the two cannot drift. Both
     * queries return a full page; the windowed one reads five and a half times as much, because the window
     * is a residual filter inside each ranked arm and the arm scans further to fill `LIMIT`.
     *
     * A selective term is affordable, and that is the trap rather than the reassurance: selectivity is not
     * knowable before the query runs, so there is no per-request rule that admits the cheap case and refuses
     * the expensive one.
     */
    const budget = BUDGETS["authz.list.max_rows_read"];
    const common = await cost("shipment");
    const windowed = await cost("shipment", null, { since: MIDPOINT });
    const selective = await cost("demurrage", null, { since: MIDPOINT });

    console.log(
      `MEASURE search_windowed_rows_read unwindowed=${common.rowsRead} windowed=${windowed.rowsRead} `
      + `selective=${selective.rowsRead} budget=${budget}`,
    );

    expect(common.rowsRead).toBeLessThanOrEqual(budget);
    expect(windowed.rowsRead).toBeGreaterThan(budget);
    // Same page, five and a half times the reading — so the cost is the filter, not the result set.
    expect(windowed.rows).toBe(common.rows);
    expect(selective.rowsRead).toBeLessThanOrEqual(budget);
  });
});
