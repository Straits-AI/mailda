import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { assertWithinBudget, BUDGETS } from "@mailda/budgets";
import { createSystemCtx } from "@mailda/runtime";

import { messagePageQuery } from "../src/authz-read.ts";
import { buildSupervisedQuery, liveGrantsBySubject, SCOPES_FOR_CONTENT, SCOPES_FOR_METADATA } from "../src/supervised.ts";

/**
 * What one page of the inbox costs, and what `messages.page_size` is sized from (#91).
 *
 * The measurement behind `docs/receipts/message-page-size.md`. Two things are being priced and they pull in
 * opposite directions, which is the whole reason the number needs a receipt rather than a preference:
 *
 * 1. **Rows read per page**, against `authz.list.max_rows_read = 1000`. A bigger page reads more.
 * 2. **Rows read on a *deep* page**, which is the term keyset pagination exists to keep flat and which the
 *    old `LIMIT 50` had no answer for at all — it read the whole table and sorted it on every load.
 *
 * ## Why `messagePageQuery` is imported rather than restated
 *
 * `test/authz.measure.test.ts` hand-copies the statements it prices, and its own receipt now carries the
 * consequence: it says *"`listMessages` gained a `UNION` inside its mailbox sub-select and is not separately
 * priced here"* — a query the receipt describes and does not measure. So this file measures the builder the
 * Node actually calls. If the shipped statement changes, this figure changes with it or the assertion fails.
 *
 * ## rows_read, not milliseconds
 *
 * Same reason `authz.measure.test.ts` gives and worth not re-deriving: `performance.now()` inside workerd is
 * clamped by the Spectre mitigation and does not advance during execution, so a timing figure here would be
 * the clock's resolution. D1 reports `meta.rows_read`, D1 bills on rows *scanned*, and that number is
 * simultaneously the cost, the ceiling pressure and a direct test of whether the index is being used.
 */

const testEnv = env as unknown as Env;
const ORG = "org_page_measure";
const READER = "usr_page_reader";
/** Two mailboxes, because the mailbox filter has to be priced against a listing that spans more than one. */
const MAILBOX_A = "mbx_page_a";
const MAILBOX_B = "mbx_page_b";
/** Three messages, all of them the oldest in the Node — the shape that makes a filtered page walk the lot. */
const MAILBOX_QUIET = "mbx_page_quiet";
const ADDRESS_A = "a@page.example";
const ADDRESS_B = "b@page.example";
const ADDRESS_QUIET = "quiet@page.example";
const QUIET_DELIVERIES = 3;

/**
 * Deliveries seeded, and why this many.
 *
 * Deep enough that a page ten pages in is a real question rather than the whole table: at 50 rows a page,
 * 1,200 receipts is 24 pages. Small enough to seed inside the suite's measured timeout. A Node with three
 * years of mail has far more, which is the point — the figure that matters is whether the deep page's cost
 * depends on the depth, and 24 pages is enough to see that it does not.
 */
const DELIVERIES = 1200;

const AUGUST = Date.parse("2026-08-01T00:00:00.000Z");

interface Cost {
  rowsRead: number;
  rows: number;
}

async function pageCost(options: {
  after: { at: string; id: string } | null;
  mailboxId: string | null;
  limit: number;
}): Promise<Cost & { keys: Array<{ at: string; id: string }>; bytes: number }> {
  const query = messagePageQuery({
    sponsor: { sql: "", params: [] }, // a human reader has no sponsor ceiling
    orgId: ORG,
    subjects: [READER],
    supervised: {
      metadata: liveGrantsBySubject(ORG, READER, new Date(AUGUST).toISOString(), SCOPES_FOR_METADATA),
      content: liveGrantsBySubject(ORG, READER, new Date(AUGUST).toISOString(), SCOPES_FOR_CONTENT),
    },
    // `q: null` — this file prices the plain listing. Search has its own receipt and its own measurement,
    // because a searched page is a different plan and averaging the two would describe neither.
    page: { after: options.after, mailboxId: options.mailboxId, q: null },
    limit: options.limit,
  });
  const result = await testEnv.CATALOG.prepare(query.sql).bind(...query.params)
    .all<{ id: string; accepted_at: string; supervised_grant_id: string | null }>();

  const rows = result.results;
  return {
    rowsRead: result.meta.rows_read ?? 0,
    rows: rows.length,
    keys: rows.map((row) => ({ at: row.accepted_at, id: row.id })),
    // What the page weighs on the wire, with the column the response strips removed — so the figure is the
    // body a reader actually receives rather than the row the query returned.
    bytes: new TextEncoder().encode(JSON.stringify(
      rows.map(({ supervised_grant_id: _grant, ...row }) => row),
    )).length,
  };
}

/**
 * Pages forward until the corpus runs out or `pages` pages have been read, and returns the deepest page that
 * was still **full**.
 *
 * Walking rather than fabricating a cursor: a cursor invented from a timestamp would measure a seek to a
 * position no reader ever reached. The first version of this helper walked past the end and measured the
 * empty page after it — four rows read, which reads as a triumph and is a result nobody asked for. So it
 * stops on a page that did not fill, and resumes from the **page's last row rather than the query's**, which
 * is what `listMessages` does with the probe row it never returns.
 */
async function walk(size: number, pages: number): Promise<Cost & { page: number }> {
  let deepest = await pageCost({ after: null, mailboxId: null, limit: size + 1 });
  let page = 1;
  for (let next = 2; next <= pages; next++) {
    if (deepest.keys.length <= size) break;
    const measured = await pageCost({
      after: deepest.keys[size - 1]!, mailboxId: null, limit: size + 1,
    });
    if (measured.rows === 0) break;
    deepest = measured;
    page = next;
  }
  return { rowsRead: deepest.rowsRead, rows: deepest.rows, page };
}

beforeAll(async () => {
  const ctx = createSystemCtx();
  const at = new Date(AUGUST).toISOString();

  const mailboxes: Array<[string, string, string]> = [
    [MAILBOX_A, "A", ADDRESS_A], [MAILBOX_B, "B", ADDRESS_B], [MAILBOX_QUIET, "Quiet", ADDRESS_QUIET],
  ];
  await testEnv.CATALOG.batch(mailboxes.flatMap(([mailboxId, name, address]) => [
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(mailboxId, ORG, name, at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, address, mailboxId, at),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, READER, "mailbox.content.read", "mailbox", mailboxId, at),
  ]));

  /*
   * Realistic field widths, for `message-metadata-bytes.md`'s reason: placeholder data produces a fictional
   * byte figure, and half of what this file measures is how heavy a page is on the wire.
   *
   * Every fourth delivery **shares its predecessor's `accepted_at`**, which is the tie the cursor's second
   * column exists for. One inbound message to two addresses of one mailbox lands as two receipts with one
   * timestamp, so a corpus with distinct timestamps everywhere would test a total order the real one is not.
   */
  const statements = [];
  for (let n = 0; n < DELIVERIES; n++) {
    /*
     * **A deterministic id, not `ctx.id("rcpt")`.** The keyset order is `(accepted_at, id)` and every fourth
     * delivery shares a timestamp on purpose, so the id decides those ties — and a random ULID therefore
     * decides how far the walk gets before its page fills. Measured with random ids, the figures in
     * `message-page-size.md` moved by a row or two between runs (506 then 508 at size 100), which makes a
     * receipt somebody cannot reproduce. AGENTS.md's receipt format promises a command that prints the same
     * number.
     *
     * Zero-padded, so lexical order matches insertion order and the tie-break is the *stable* one rather
     * than an arbitrary one that happens to be reproducible.
     */
    const receiptId = `rcpt_${String(n).padStart(26, "0")}`;
    /*
     * The quiet mailbox's three deliveries are the **oldest** in the Node, an hour before everything else, so
     * a page filtered to it is the worst case rather than a lucky one: the walk cannot stop early.
     */
    const quiet = n < QUIET_DELIVERIES;
    const acceptedAt = quiet
      ? new Date(AUGUST - (QUIET_DELIVERIES - n) * 60_000).toISOString()
      : new Date(AUGUST + Math.floor(n / 4) * 4 * 60_000).toISOString();
    const address = quiet ? ADDRESS_QUIET : (n % 3 === 0 ? ADDRESS_B : ADDRESS_A);
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
         blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(receiptId, ORG, `evt_page_${n}`, `sender-${n}@supplier.example.net`, address, 24_576,
      `${ORG}/raw/${receiptId}`, "0".repeat(64), acceptedAt));
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
         thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
         conversation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(ctx.id("msg"), ORG, "2026-08", `${ORG}/raw/${receiptId}`, "0".repeat(64), 24_576,
      `<CAJ${n}.xxxxxxxxxxxxxxxxxxxx@mail.example-supplier.com>`, ctx.id("thr"),
      `Re: Purchase order 4501${n} — revised delivery schedule attached`,
      `accounts-payable-${n}@example-supplier.com`, acceptedAt, acceptedAt, receiptId, acceptedAt,
      ctx.id("cnv")));
  }
  // Chunked because a batch is one transaction and 2,400 statements in one is slower than the suite's
  // timeout allows, not because of the parameter limit — that one is per statement.
  for (let start = 0; start < statements.length; start += 100) {
    await testEnv.CATALOG.batch(statements.slice(start, start + 100));
  }
});

describe("what one page of the inbox costs", () => {
  it("finds the corpus, so nothing below can pass by measuring an empty table", async () => {
    const row = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM ingress_receipts WHERE org_id = ?",
    ).bind(ORG).first<{ n: number }>();
    expect(row?.n).toBe(DELIVERIES);
  });

  it("stays inside the list budget at the size that ships, on page one and deep", async () => {
    /*
     * The assertion, on the shipped configuration only. The sweep below prints the other sizes, because a
     * budget asserted against a page size nobody serves would fail for a number this Node does not use.
     */
    const size = BUDGETS["messages.page_size"];
    const first = await pageCost({ after: null, mailboxId: null, limit: size + 1 });
    const deep = await walk(size, 20);
    const filtered = await pageCost({ after: null, mailboxId: MAILBOX_A, limit: size + 1 });

    console.log(
      `MEASURE message_page  size=${size}  first_rows_read=${first.rowsRead}  `
      + `deep_rows_read=${deep.rowsRead}  deep_page=${deep.page}  filtered_rows_read=${filtered.rowsRead}  `
      + `first_bytes=${first.bytes}  bytes_per_row=${Math.round(first.bytes / first.rows)}`,
    );

    // The list budget is what bounds this listing (`authz-check-rows-read.md`), and it is asserted on the
    // deep page as well as the first — the deep page is the one the old statement had no answer for.
    assertWithinBudget("authz.list.max_rows_read", first.rowsRead, { scenario: "page 1" });
    assertWithinBudget("authz.list.max_rows_read", deep.rowsRead, { scenario: `page ${deep.page}` });
    assertWithinBudget("authz.list.max_rows_read", filtered.rowsRead, { scenario: "one mailbox" });
  });

  it("costs a deep page no more than the first, which is the property keyset pagination is for", async () => {
    const size = BUDGETS["messages.page_size"];
    const first = await pageCost({ after: null, mailboxId: null, limit: size + 1 });
    const deepest = await walk(size, 20);
    console.log(
      `MEASURE message_page_depth  page_1=${first.rowsRead}  page_${deepest.page}=${deepest.rowsRead}`,
    );
    /*
     * The assertion the index and the two-predicate cursor exist for, and it is a *ratio* rather than a
     * figure: what OFFSET and an unusable range constraint both do is make page twenty cost twenty times page
     * one, and no absolute bound catches that until the corpus is large enough to breach it — by which time
     * it is a customer's bill. Measured at 207 and 208 rows on the corpus above.
     *
     * `1.5x` rather than `1x` because the deep page descends the index one level further to find its start.
     */
    expect(deepest.rowsRead).toBeLessThanOrEqual(Math.ceil(first.rowsRead * 1.5));
    /*
     * And the ratio alone is not enough, which the mutation run proved: with the index removed, page one read
     * 6,004 and page twenty read 2,204 — *flatter* than the fixed version, because a query that already reads
     * everything cannot get worse with depth. A ratio is only meaningful once each page costs the page.
     */
    expect(first.rowsRead, "a page costs the corpus rather than the page").toBeLessThan(DELIVERIES);
  });

  it("depends on the index for that, which is why the migration is part of the fix", async () => {
    /*
     * `ingress_receipts` carried no index on `accepted_at` from Layer 1 until #91, so every inbox load
     * scanned the table and sorted it. That was invisible while the fixture had three messages in it, and it
     * is the term that grows with the archive — so it is measured here rather than argued, by taking the
     * index away and putting it back.
     *
     * Dropping an index inside a test is safe under `vitest-pool-workers`: isolated storage undoes the whole
     * test's writes, and the `CREATE` at the end means a failure between them cannot leave the rest of this
     * file measuring a different schema.
     */
    const size = BUDGETS["messages.page_size"];
    const withIndex = await pageCost({ after: null, mailboxId: null, limit: size + 1 });
    await testEnv.CATALOG.prepare("DROP INDEX ir_org_accepted").run();
    const without = await pageCost({ after: null, mailboxId: null, limit: size + 1 });
    const deepWithout = await walk(size, 5);
    await testEnv.CATALOG.prepare(
      "CREATE INDEX ir_org_accepted ON ingress_receipts (org_id, accepted_at, id)",
    ).run();

    console.log(
      `MEASURE message_page_index  deliveries=${DELIVERIES}  with_index=${withIndex.rowsRead}  `
      + `without_index=${without.rowsRead}  without_index_page_${deepWithout.page}=${deepWithout.rowsRead}`,
    );
    // Non-vacuity in the direction that matters: if this ratio were 1 the index would be decoration, and the
    // migration would be a row in `d1_migrations` nothing needed.
    expect(without.rowsRead).toBeGreaterThan(withIndex.rowsRead * 2);
  });

  it("prints what a page costs at the sizes that were considered", async () => {
    /*
     * The receipt's table. Printed rather than asserted for two reasons: these are sizes this Node does not
     * serve, and the figure that matters about them — where the list budget stops being satisfiable — is a
     * *ceiling*, and an assertion that a number is above a budget goes red the day the query gets cheaper.
     *
     * What is asserted is the property that makes the page size the thing worth sizing: the cost is
     * proportional to it. If it were not, this receipt would be measuring the wrong number.
     */
    const costs = new Map<number, number>();
    for (const size of [25, 50, 100, 200]) {
      const first = await pageCost({ after: null, mailboxId: null, limit: size + 1 });
      const filtered = await pageCost({ after: null, mailboxId: MAILBOX_A, limit: size + 1 });
      costs.set(size, first.rowsRead);
      console.log(
        `MEASURE message_page_sweep  size=${size}  first_rows_read=${first.rowsRead}  `
        + `filtered_rows_read=${filtered.rowsRead}  first_bytes=${first.bytes}`,
      );
    }
    expect(costs.get(200)!).toBeGreaterThan(costs.get(50)! * 2);
  });

  it("prints what a filter on a quiet mailbox costs, because that one is bounded by the archive", async () => {
    /*
     * **The listing's one cost that does not scale with the page, named rather than left to be discovered.**
     *
     * The rows are ordered by `accepted_at` and the mailbox is reached through `addresses`, so a page bounded
     * to one mailbox scans receipts in time order until it has found enough belonging to that mailbox. For a
     * mailbox that is quiet in a busy Node, that walk is the archive rather than the page.
     *
     * This is **not** something the mailbox filter introduced. The authorization predicate has exactly the
     * same shape — a reader who may see one mailbox out of ten has always paid this on an unfiltered listing —
     * so #91 exposed a characteristic of authorizing a listing over the evidence table in SQL, and did not
     * create one. What would fix it is a per-mailbox ordering to drive the listing from; `mailbox_items`
     * already is one, and moving the listing onto it is a redesign of what the inbox reads rather than a
     * pagination change. `docs/receipts/message-page-size.md` records the number and the shape of the fix.
     *
     * Printed, not asserted against the list budget, and that is deliberate: asserting it would either lock
     * in a figure that is a property of this corpus's size, or go green by choosing a corpus small enough to
     * pass. The number is here so the next person sizing this has it.
     */
    const size = BUDGETS["messages.page_size"];
    const quiet = await pageCost({ after: null, mailboxId: MAILBOX_QUIET, limit: size + 1 });
    const dense = await pageCost({ after: null, mailboxId: MAILBOX_A, limit: size + 1 });
    console.log(
      `MEASURE message_page_sparse  deliveries=${DELIVERIES}  quiet_mailbox_rows=${QUIET_DELIVERIES}  `
      + `quiet_rows_read=${quiet.rowsRead}  quiet_returned=${quiet.rows}  dense_rows_read=${dense.rowsRead}`,
    );
    // The page is still correct, which is the part that is asserted: every row the quiet mailbox has, and no
    // row of anybody else's.
    expect(quiet.rows).toBe(QUIET_DELIVERIES);
  });

  it("prints how many ids of one page fit in one supervised.query entry", async () => {
    /*
     * The other bound on the page size, and the one that turns out to be tighter (§7, #63).
     *
     * A supervised listing records the ids it returned, split across continuation entries rather than
     * truncated. So a page larger than one entry holds is *correct* and costs more audit rows. This prints
     * the fill against the shipped page size so the receipt can say which side of it we are on, and
     * `test/supervised-recording.test.ts` owns the assertion that a real page does not split.
     */
    const id = (n: number) => `rcpt_${String(n).padStart(26, "0")}`;
    let fill = 0;
    for (let count = 1; count <= 400; count++) {
      if (buildSupervisedQuery("sgr_measure", READER, MAILBOX_A,
        Array.from({ length: count }, (_, index) => id(index))).length === 1) fill = count;
    }
    const size = BUDGETS["messages.page_size"];
    console.log(`MEASURE message_page_audit  ids_per_entry=${fill}  page_size=${size}  `
      + `entries_per_page=${Math.ceil(size / fill)}`);
    expect(fill).toBeGreaterThan(0);
  });
});
