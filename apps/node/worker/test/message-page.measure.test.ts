import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { assertWithinBudget, BUDGETS } from "@mailda/budgets";
import { createSystemCtx } from "@mailda/runtime";

import { messagePageQuery, needsLookback, type MessagePage } from "../src/authz-read.ts";
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

/**
 * Readers whose own state differs, each holding content read on every mailbox (0062, 0067, cases).
 *
 * `READER` is the **healthy mixed corpus** `message-page-size.md` sizes the lookback on, seeded by delivery
 * index `i`: one in twenty in Trash, half the rest in Archive (so half stay in the Inbox), one in five unread,
 * one in twenty a case the reader holds. `ZERO` has filed everything, read everything and holds nothing: the
 * inbox-zero reader, whose Inbox, Unread and Mine are where the lookback is meant to be felt. The three
 * `FILED_*` readers have filed 1 %, 50 % and 95 % of the corpus, for the placed plan's cost.
 */
const ZERO = "usr_page_zero";
const FILED = { "1": "usr_page_filed_1", "50": "usr_page_filed_50", "95": "usr_page_filed_95" } as const;
/** A sealed preview's width for a Latin line (`message-metadata-bytes.md`), and the line a reader receives. */
const SEALED = "A".repeat(200);
const OPENED = "Please find the revised delivery schedule attached; the first consignment ships on the 14th, and the "
  + "second on the 21st.";
if (Array.from(OPENED).length !== 120) throw new Error("the fixture preview must be PREVIEW_CHARS (120) wide");

interface Cost {
  rowsRead: number;
  rows: number;
}

async function pageCost(options: {
  after: { at: string; id: string } | null;
  mailboxId: string | null;
  limit: number;
  reader?: string;
  filter?: Partial<Pick<MessagePage, "place" | "unread" | "mine">>;
  /** Overrides `messages.max_lookback`, only to measure the lookback's per-message slope. */
  lookback?: number;
}): Promise<Cost & { keys: Array<{ at: string; id: string }>; bytes: number; exhausted: boolean; edgeRowsRead: number }> {
  const reader = options.reader ?? READER;
  const page: MessagePage = {
    after: options.after, mailboxId: options.mailboxId, q: null, since: null, until: null, from: null,
    conversationId: null, label: null, place: null, unread: false, mine: false, ...options.filter,
  };
  const query = messagePageQuery({
    readerId: reader,
    nowIso: new Date(AUGUST).toISOString(),
    sponsor: { sql: "", params: [] }, // a human reader has no sponsor ceiling
    orgId: ORG,
    subjects: [reader],
    supervised: {
      metadata: liveGrantsBySubject(ORG, reader, new Date(AUGUST).toISOString(), SCOPES_FOR_METADATA),
      content: liveGrantsBySubject(ORG, reader, new Date(AUGUST).toISOString(), SCOPES_FOR_CONTENT),
    },
    // `q: null` — this file prices the plain listing. Search has its own receipt and its own measurement,
    // because a searched page is a different plan and averaging the two would describe neither.
    page,
    limit: options.limit,
    lookback: needsLookback(page) ? options.lookback ?? BUDGETS["messages.max_lookback"] : null,
  });
  const result = await testEnv.CATALOG.prepare(query.sql).bind(...query.params)
    .all<{ id: string; accepted_at: string; supervised_grant_id: string | null; standing_content: number }>();

  const rows = result.results;
  /*
   * Both statements, as `listMessages` runs them: the edge only after a lookback page that did not fill. The
   * receipt's lookback figures are the two together, because that is what one request costs.
   */
  let edgeRowsRead = 0;
  let exhausted = false;
  if (query.edge !== null && rows.length < options.limit) {
    const edge = await testEnv.CATALOG.prepare(query.edge.sql).bind(...query.edge.params).all();
    edgeRowsRead = edge.meta.rows_read ?? 0;
    exhausted = edge.results.length === 2;
  }
  return {
    rowsRead: (result.meta.rows_read ?? 0) + edgeRowsRead,
    edgeRowsRead,
    rows: rows.length,
    keys: rows.map((row) => ({ at: row.accepted_at, id: row.id })),
    exhausted,
    // What the page weighs on the wire: the columns the response strips removed and the preview a content
    // reader receives in their place, so the figure is the body a reader actually gets.
    bytes: new TextEncoder().encode(JSON.stringify(
      rows.map(({ supervised_grant_id: _grant, preview_sealed: _sealed, preview_generation: _generation, ...row }:
        Record<string, unknown>) => ({ ...row, preview: row.standing_content === 1 ? OPENED : null })),
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
    ...[READER, ZERO, ...Object.values(FILED)].map((reader) => testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, reader, "mailbox.content.read", "mailbox", mailboxId, at)),
  ]));

  /*
   * Realistic field widths, for `message-metadata-bytes.md`'s reason: placeholder data produces a fictional
   * byte figure, and half of what this file measures is how heavy a page is on the wire.
   *
   * Every fourth delivery **shares its predecessor's `accepted_at`**, which is the tie the cursor's second
   * column exists for. One inbound message to two addresses of one mailbox lands as two receipts with one
   * timestamp, so a corpus with distinct timestamps everywhere would test a total order the real one is not.
   */
  const statements: D1PreparedStatement[] = [];
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
    /*
     * The row projections (0068) as a settled Node holds them: 70 % with a display name about sixteen
     * characters wide, every one a sealed preview of a Latin line's width, projected.
     */
    const messageId = `msg_${String(n).padStart(26, "0")}`;
    const conversationId = `cnv_${String(n).padStart(26, "0")}`;
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
         thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
         conversation_id, from_name, preview_sealed, preview_generation, preview_state)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'projected')`,
    ).bind(messageId, ORG, "2026-08", `${ORG}/raw/${receiptId}`, "0".repeat(64), 24_576,
      `<CAJ${n}.xxxxxxxxxxxxxxxxxxxx@mail.example-supplier.com>`, ctx.id("thr"),
      `Re: Purchase order 4501${n} — revised delivery schedule attached`,
      `accounts-payable-${n}@example-supplier.com`, acceptedAt, acceptedAt, receiptId, acceptedAt,
      conversationId, n % 10 < 7 ? `Accounts ${String(n).padStart(4, "0")} desk` : null, SEALED));
    /*
     * **The readers' own rows, seeded** — a correlated probe into an empty table reads nothing, which is how
     * the `read` column (0062) went unmeasured. A case for every delivery, one in twenty held by `READER`.
     */
    const mailboxId = address === ADDRESS_QUIET ? MAILBOX_QUIET : address === ADDRESS_B ? MAILBOX_B : MAILBOX_A;
    const held = n % 20 === 3;
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(`cas_${String(n).padStart(26, "0")}`, ORG, conversationId, mailboxId, held ? "claimed" : "open",
      acceptedAt, held ? READER : null, held ? acceptedAt : null, acceptedAt));
    const read = (reader: string) => statements.push(testEnv.CATALOG.prepare(
      "INSERT INTO message_reads (org_id, user_id, message_id, read_at) VALUES (?,?,?,?)",
    ).bind(ORG, reader, messageId, acceptedAt));
    const file = (reader: string, place: "archive" | "trash") => statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO message_places (org_id, user_id, message_id, receipt_id, accepted_at, place, placed_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ORG, reader, messageId, receiptId, acceptedAt, place, acceptedAt));
    if (n % 5 !== 1) read(READER);
    if (n % 20 === 0) file(READER, "trash");
    else if (n % 2 === 0) file(READER, "archive");
    read(ZERO);
    file(ZERO, "archive");
    if (n % 100 === 0) file(FILED["1"], "archive");
    if (n % 2 === 0) file(FILED["50"], "archive");
    if (n % 20 !== 0) file(FILED["95"], "archive");
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

  it("prints what a lookback on a quiet mailbox costs: the walk twice, once for the page and once for its edge", async () => {
    /*
     * The quiet mailbox again, now with the Inbox filter. The reader sees fewer than `messages.max_lookback`
     * messages there, so the page never fills and the edge runs, and its `OFFSET N - 1` passes every receipt
     * the page statement already passed, the other mailboxes' included. The authorization term (here the
     * mailbox term, a predicate in the same inner statement) is paid twice. Printed rather than held to the
     * list budget for the reason the quiet figure above gives; the ceiling, twice the walk, is asserted.
     */
    const size = BUDGETS["messages.page_size"];
    const walk = await pageCost({ after: null, mailboxId: MAILBOX_QUIET, limit: size + 1 });
    const figures: string[] = [];
    for (const [who, reader, rows] of [["reader", READER, 1], ["inbox_zero", ZERO, 0]] as const) {
      const looked = await pageCost({
        after: null, mailboxId: MAILBOX_QUIET, limit: size + 1, reader, filter: { place: "inbox" },
      });
      figures.push(`${who}=${looked.rowsRead}(page ${looked.rowsRead - looked.edgeRowsRead} + edge ${looked.edgeRowsRead})`);
      // Anti-vacuity: the page did not fill, so the edge ran, and it found fewer than N (not exhausted).
      expect([looked.rows, looked.exhausted], who).toEqual([rows, false]);
      expect(looked.edgeRowsRead, `${who}: the edge did not run`).toBeGreaterThan(0);
      expect(looked.rowsRead, `${who}: the lookback read more than the walk twice`).toBeLessThanOrEqual(2 * walk.rowsRead);
    }
    console.log(`MEASURE message_page_sparse_lookback  walk=${walk.rowsRead}  ${figures.join("  ")}`);
  });

  it("pages Archive and Trash from the filing table, a page's cost however much is filed", async () => {
    /*
     * The placed plan (0067), asserted against the list budget at three fractions of the corpus filed. Its
     * cost is a page because `mpl_by_place` drives it; driven from the walk instead, a reader who has filed 1 %
     * would pay for the other 99 % on every Archive load — the mutation that turns this red.
     */
    const size = BUDGETS["messages.page_size"];
    const figures: string[] = [];
    for (const [fraction, reader] of Object.entries(FILED)) {
      const archive = await pageCost({
        after: null, mailboxId: null, limit: size + 1, reader, filter: { place: "archive" },
      });
      figures.push(`filed_${fraction}pct=${archive.rowsRead}(${archive.rows} rows)`);
      assertWithinBudget("authz.list.max_rows_read", archive.rowsRead, { scenario: `Archive, ${fraction} % filed` });
      expect(archive.rows, `${fraction} % filed`).toBe(Math.min(size + 1, Math.ceil(DELIVERIES * Number(fraction) / 100)));
    }
    const trash = await pageCost({ after: null, mailboxId: null, limit: size + 1, filter: { place: "trash" } });
    figures.push(`trash_5pct=${trash.rowsRead}(${trash.rows} rows)`);
    assertWithinBudget("authz.list.max_rows_read", trash.rowsRead, { scenario: "Trash" });
    console.log(`MEASURE message_page_placed  ${figures.join("  ")}`);
  });

  /*
   * ## Sizing the lookback (§7 Q-A), and the three assertions that hold it (a)–(c)
   *
   * `docs/receipts/message-page-size.md` carries the arithmetic with these figures. F is how many messages the
   * healthy reader's default Inbox looks through to fill its page, counted from the seeded data rather than
   * estimated; `messages.max_lookback` is sized at four times it. c is the per-message cost of both statements,
   * measured as a slope between two lookbacks on the inbox-zero reader, so the fixed cost falls out.
   */
  function inboxFill(): number {
    // Newest first is `n` descending here (acceptance time grows with `n`, ties broken by the zero-padded id).
    // The healthy reader's Inbox is every odd `n` (even ones are filed); the page is full at `size + 1` rows.
    const size = BUDGETS["messages.page_size"];
    let seen = 0;
    let looked = 0;
    for (let n = DELIVERIES - 1; n >= 0 && seen < size + 1; n--) {
      looked += 1;
      if (!(n % 20 === 0 || n % 2 === 0)) seen += 1;
    }
    return looked;
  }

  it("(a) fills the healthy Inbox inside the list budget, never exhausted, with 4 x F <= messages.max_lookback", async () => {
    const size = BUDGETS["messages.page_size"];
    const F = inboxFill();
    const healthy = await pageCost({ after: null, mailboxId: null, limit: size + 1, filter: { place: "inbox" } });
    console.log(`MEASURE message_page_lookback_healthy  F=${F}  rows_read=${healthy.rowsRead}  rows=${healthy.rows}  `
      + `max_lookback=${BUDGETS["messages.max_lookback"]}  bytes_per_row=${Math.round(healthy.bytes / healthy.rows)}`);
    assertWithinBudget("authz.list.max_rows_read", healthy.rowsRead, { scenario: "the healthy default Inbox" });
    expect(healthy.rows, "the healthy Inbox did not fill its page").toBe(size + 1);
    expect(healthy.exhausted).toBe(false);
    // A corpus or query change that grows F goes red here and asks for a remeasure of the lookback.
    expect(4 * F).toBeLessThanOrEqual(BUDGETS["messages.max_lookback"]);
  });

  it("(b) bounds an inbox-zero Inbox, Unread and Mine at c x N + the first page, however much mail there is", async () => {
    const size = BUDGETS["messages.page_size"];
    const N = BUDGETS["messages.max_lookback"];
    // Anti-vacuity: an unbounded walk over twice the lookback would breach the bound below.
    expect(DELIVERIES).toBeGreaterThanOrEqual(2 * N);
    const zero = (filter: Partial<Pick<MessagePage, "place" | "unread" | "mine">>, lookback?: number) =>
      pageCost({ after: null, mailboxId: null, limit: size + 1, reader: ZERO, filter, ...(lookback === undefined ? {} : { lookback }) });
    const atN = await zero({ place: "inbox" });
    const atHalf = await zero({ place: "inbox" }, N / 2);
    const c = Math.ceil((atN.rowsRead - atHalf.rowsRead) / (N / 2));
    const firstPage = (await pageCost({ after: null, mailboxId: null, limit: size + 1, filter: { place: "inbox" } })).rowsRead;
    const unread = await zero({ place: "inbox", unread: true });
    const mine = await zero({ place: "inbox", mine: true });
    console.log(`MEASURE message_page_lookback_exhausted  N=${N}  inbox_zero=${atN.rowsRead}  at_half=${atHalf.rowsRead}  `
      + `c=${c}  no_unread=${unread.rowsRead}  no_mine=${mine.rowsRead}  first_page=${firstPage}  `
      + `bound=${c * N + firstPage}  lookback_rows_read_per_message=${BUDGETS["messages.lookback_rows_read_per_message"]}`);
    expect(c, "the per-message cost moved: remeasure messages.lookback_rows_read_per_message")
      .toBeLessThanOrEqual(BUDGETS["messages.lookback_rows_read_per_message"]);
    for (const [what, cost] of [["inbox zero", atN], ["nothing unread", unread], ["no case held", mine]] as const) {
      expect(cost.rows, what).toBe(0);
      expect(cost.exhausted, what).toBe(true);
      expect(cost.rowsRead, `${what} read past the lookback`)
        .toBeLessThanOrEqual(BUDGETS["messages.lookback_rows_read_per_message"] * N + firstPage);
    }
  });

  it("(c) stops a healthy page early: less than half of what an exhausted lookback reads", async () => {
    const size = BUDGETS["messages.page_size"];
    const healthy = await pageCost({ after: null, mailboxId: null, limit: size + 1, filter: { place: "inbox" } });
    const exhausted = await pageCost({
      after: null, mailboxId: null, limit: size + 1, reader: ZERO, filter: { place: "inbox" },
    });
    expect(healthy.rowsRead * 2).toBeLessThan(exhausted.rowsRead);
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
