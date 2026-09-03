import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

/**
 * **A probe, not a feature.** Whether a date in the FTS index makes a windowed search affordable (#153).
 *
 * ## What is being decided, and why it has to be measured before it can be decided
 *
 * `q` with `since`/`until` currently refuses with `E_MESSAGE_PAGE_WINDOW_SEARCH`, because the window is a
 * residual filter *inside* each ranked arm: the arm scans further through its MATCH result to fill `LIMIT`,
 * and a common term went from **771** rows read to **4,335** against a 1,000-row budget. Filtering outside
 * the arms is not the answer — it keeps the cost exactly and changes the meaning, because the arms cap by
 * rank first, so *"mail about demurrage since October"* would answer nothing whenever October's demurrage
 * mail ranks below the cap.
 *
 * #153 measured two of the three candidate directions and rejected both. What is left is direction 2: put the
 * date in the index **as a token**, so the match set arrives already narrowed instead of being narrowed
 * afterwards.
 *
 * It carries a product consequence — FTS5 matches tokens rather than ranges, so windows become calendar
 * buckets and a windowed *search* would offer coarser granularity than a windowed *listing*. That is a
 * decision for the maintainer. **But it is only worth deciding if the direction works**, and nothing had
 * measured it, so this does — against a prototype, with no schema change and no backfill, because a schema
 * change made before the figure exists is a schema change made on a hypothesis.
 *
 * ## Why this corpus and not `message-search.measure.test.ts`'s
 *
 * That corpus seeds 1,200 deliveries four minutes apart, which spans **under a day** — so every message would
 * carry the same day token and the token would narrow nothing. The figure would have looked wonderful and
 * measured an index with one value in it.
 *
 * This one spreads the same 1,200 deliveries across 120 days, which is what a windowed search is *for*.
 *
 * ## What this file deliberately does not do
 *
 * It does not touch `message_search` or `message_body_search`, add a migration, or change any shipped query.
 * The tables here are created and dropped inside the probe. If the figures justify it, the schema change is a
 * separate piece of work with its own backfill and its own receipt; if they do not, nothing has to be undone.
 *
 * **And it deliberately has no receipt.** Every receipt in this repository carries a `values:` block that
 * becomes a constant in `packages/budgets`, and these figures bound nothing that ships — minting keys for a
 * design nobody has decided to build would put dead constants in generated code and give
 * `budget-plan-scope.test.ts` entries to classify that describe no live budget. So the measurement lives
 * here, printed on every run, where it cannot go stale quietly: the numbers are produced by the same code
 * that would have to keep producing them. A receipt belongs to the shipped query, if there is one.
 */

const testEnv = env as unknown as Env;
const ORG = "org_window_probe";
const DELIVERIES = 1200;
const DAYS = 120;
const START = Date.parse("2026-05-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** `2026-05-01` -> `d20260501`. One alphanumeric token under the default `unicode61` tokenizer. */
function dayToken(millis: number): string {
  return `d${new Date(millis).toISOString().slice(0, 10).replaceAll("-", "")}`;
}

/** Every day token from `from` to `to` inclusive — what a window becomes once it is a token set. */
function tokensAcross(from: number, to: number): string[] {
  const tokens: string[] = [];
  for (let at = from; at <= to; at += DAY_MS) tokens.push(dayToken(at));
  return tokens;
}

interface Cost { rowsRead: number; rows: number }

const LIMIT = BUDGETS["messages.page_size"] + 1;

/**
 * The tokenised plan: one MATCH carrying both the term and the window.
 *
 * `subject:` and `day:` are FTS5 column filters, so the day tokens cannot be matched by the subject text and
 * a message whose subject happened to contain `d20260501` could not forge its way into a window.
 */
async function tokenised(term: string, window: { from: number; to: number } | null): Promise<Cost> {
  const days = window === null ? null : tokensAcross(window.from, window.to);
  const match = days === null
    ? `subject:${term}`
    : `subject:${term} AND day:(${days.join(" OR ")})`;
  const result = await testEnv.CATALOG.prepare(
    `SELECT message_id FROM probe_search WHERE probe_search MATCH ? AND org_id = ?
     ORDER BY bm25(probe_search) LIMIT ?`,
  ).bind(match, ORG, LIMIT).all<{ message_id: string }>();
  return { rowsRead: result.meta.rows_read ?? 0, rows: result.results.length };
}

/**
 * The shipped shape, on this corpus: the window as a **residual filter** on the ranked arm.
 *
 * The control. Without it the tokenised figure is a number with nothing to be better than, and #153's
 * existing 4,335 was measured on a different corpus — comparing against it would be comparing against a
 * receipt rather than against a run.
 */
async function residual(term: string, window: { from: number; to: number } | null): Promise<Cost> {
  const sql = window === null
    ? `SELECT s.message_id FROM probe_search s
       WHERE s.probe_search MATCH ? AND s.org_id = ?
       ORDER BY bm25(s.probe_search) LIMIT ?`
    : `SELECT s.message_id FROM probe_search s
       JOIN probe_receipts r ON r.message_id = s.message_id
       WHERE s.probe_search MATCH ? AND s.org_id = ? AND r.accepted_at >= ? AND r.accepted_at <= ?
       ORDER BY bm25(s.probe_search) LIMIT ?`;
  const params = window === null
    ? [`subject:${term}`, ORG, LIMIT]
    : [
      `subject:${term}`, ORG,
      new Date(window.from).toISOString(), new Date(window.to + DAY_MS - 1).toISOString(), LIMIT,
    ];
  const result = await testEnv.CATALOG.prepare(sql).bind(...params).all<{ message_id: string }>();
  return { rowsRead: result.meta.rows_read ?? 0, rows: result.results.length };
}

beforeAll(async () => {
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("DROP TABLE IF EXISTS probe_search"),
    testEnv.CATALOG.prepare("DROP TABLE IF EXISTS probe_receipts"),
  ]);
  await testEnv.CATALOG.batch([
    /*
     * `day` as its own column, not appended to the subject text. Appending would put a synthetic token in the
     * stored subject — `message_search` stores its `subject` column, so an excerpt or a debug read would show
     * `d20260501` to somebody — and it would let a subject containing that string match a window it is not in.
     */
    testEnv.CATALOG.prepare(
      `CREATE VIRTUAL TABLE probe_search USING fts5(
         subject, day, message_id UNINDEXED, org_id UNINDEXED, tokenize = 'unicode61'
       )`,
    ),
    // The time order the residual control filters on, standing in for `ingress_receipts`.
    testEnv.CATALOG.prepare(
      "CREATE TABLE probe_receipts (message_id TEXT PRIMARY KEY, accepted_at TEXT NOT NULL)",
    ),
    testEnv.CATALOG.prepare(
      "CREATE INDEX probe_receipts_at ON probe_receipts (accepted_at, message_id)",
    ),
  ]);

  const statements = [];
  for (let n = 0; n < DELIVERIES; n++) {
    const messageId = `msg_win${String(n).padStart(22, "0")}`;
    // Ten deliveries per day across 120 days, which is what a window has to be able to narrow.
    const acceptedAt = START + Math.floor(n / (DELIVERIES / DAYS)) * DAY_MS;
    /*
     * The same two-term shape the shipped measurement uses, and for its reason: a **common** term is the case
     * that fails, because the index excludes nothing and the page is the plain page plus the cost of having
     * asked. A figure for a selective term proves nothing — #153 says so explicitly.
     */
    const subject = n % 100 === 0
      ? `Demurrage claim ${n} on the Hapag booking`
      : `Shipment update ${n} for the quarter`;
    statements.push(testEnv.CATALOG.prepare(
      "INSERT INTO probe_search (subject, day, message_id, org_id) VALUES (?,?,?,?)",
    ).bind(subject, dayToken(acceptedAt), messageId, ORG));
    statements.push(testEnv.CATALOG.prepare(
      "INSERT INTO probe_receipts (message_id, accepted_at) VALUES (?,?)",
    ).bind(messageId, new Date(acceptedAt).toISOString()));
  }
  for (let at = 0; at < statements.length; at += 300) {
    await testEnv.CATALOG.batch(statements.slice(at, at + 300));
  }
});

describe("does a date token make a windowed search affordable (#153)", () => {
  it("seeds a corpus the window can actually narrow, so the figures below mean something", async () => {
    /*
     * Anti-vacuity, and it is the check `message-search.measure.test.ts`'s corpus would fail for this
     * question: a corpus spanning under a day gives every message the same token, and a token that every row
     * carries narrows nothing while looking like it does.
     */
    const distinct = await testEnv.CATALOG.prepare(
      "SELECT COUNT(DISTINCT accepted_at) AS days FROM probe_receipts",
    ).first<{ days: number }>();
    expect(distinct?.days).toBe(DAYS);

    const common = await tokenised("shipment", null);
    // The common term matches nearly everything, which is the case that fails today.
    expect(common.rows).toBe(LIMIT);
  });

  it("prints what a window costs tokenised and residually, on one corpus", async () => {
    const budget = BUDGETS["authz.list.max_rows_read"];
    const midpoint = START + (DAYS / 2) * DAY_MS;
    const lastDay = START + (DAYS - 1) * DAY_MS;

    const unwindowed = await tokenised("shipment", null);
    const halfTokenised = await tokenised("shipment", { from: midpoint, to: lastDay });
    const halfResidual = await residual("shipment", { from: midpoint, to: lastDay });
    const oneDayTokenised = await tokenised("shipment", { from: lastDay, to: lastDay });
    const oneDayResidual = await residual("shipment", { from: lastDay, to: lastDay });
    const weekTokenised = await tokenised("shipment", { from: lastDay - 6 * DAY_MS, to: lastDay });

    console.log(
      `\nMEASURE search_window_probe  deliveries=${DELIVERIES}  days=${DAYS}  budget=${budget}\n`
      + `  unwindowed            rows_read=${unwindowed.rowsRead} (${unwindowed.rows} rows)\n`
      + `  half tokenised (60d)  rows_read=${halfTokenised.rowsRead} (${halfTokenised.rows} rows)\n`
      + `  half residual  (60d)  rows_read=${halfResidual.rowsRead} (${halfResidual.rows} rows)\n`
      + `  week tokenised  (7d)  rows_read=${weekTokenised.rowsRead} (${weekTokenised.rows} rows)\n`
      + `  one day tokenised     rows_read=${oneDayTokenised.rowsRead} (${oneDayTokenised.rows} rows)\n`
      + `  one day residual      rows_read=${oneDayResidual.rowsRead} (${oneDayResidual.rows} rows)\n`,
    );

    /*
     * No assertion on the figures themselves. This is a probe: its output is the numbers, and asserting a
     * bound would either encode a hope or turn a measurement into a gate on work nobody has decided to do.
     * What *is* asserted is that the two plans answer the same question — see below — because a cheaper plan
     * that returns different mail is not a cheaper plan.
     */
    expect(unwindowed.rows).toBeGreaterThan(0);
  });

  it("costs what the window is wide, not what the archive holds — which is the decisive property", async () => {
    /*
     * **The question that decides the direction.** Cheaper is not enough: #153's whole complaint is that the
     * window is a residual filter, so cost tracks the *match set* and the match set is the corpus for a term
     * the index cannot narrow. A tokenised window is only worth a schema change if its cost tracks the
     * **window** instead — otherwise it is the same failure with a better constant.
     *
     * Measured against a second corpus, three times the size, over the same 120 days. The same seven-day
     * window should cost about the same on both, and the residual plan should not.
     */
    const big = "probe_search_big";
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(`DROP TABLE IF EXISTS ${big}`),
      testEnv.CATALOG.prepare(
        `CREATE VIRTUAL TABLE ${big} USING fts5(
           subject, day, message_id UNINDEXED, org_id UNINDEXED, tokenize = 'unicode61'
         )`,
      ),
    ]);
    const bigger = DELIVERIES * 3;
    const rows = [];
    for (let n = 0; n < bigger; n++) {
      const acceptedAt = START + Math.floor(n / (bigger / DAYS)) * DAY_MS;
      rows.push(testEnv.CATALOG.prepare(
        `INSERT INTO ${big} (subject, day, message_id, org_id) VALUES (?,?,?,?)`,
      ).bind(
        n % 100 === 0 ? `Demurrage claim ${n}` : `Shipment update ${n} for the quarter`,
        dayToken(acceptedAt), `msg_big${String(n).padStart(22, "0")}`, ORG,
      ));
    }
    for (let at = 0; at < rows.length; at += 300) {
      await testEnv.CATALOG.batch(rows.slice(at, at + 300));
    }

    const lastDay = START + (DAYS - 1) * DAY_MS;
    const week = tokensAcross(lastDay - 6 * DAY_MS, lastDay).join(" OR ");

    const small = await tokenised("shipment", { from: lastDay - 6 * DAY_MS, to: lastDay });
    const large = await testEnv.CATALOG.prepare(
      `SELECT message_id FROM ${big} WHERE ${big} MATCH ? AND org_id = ?
       ORDER BY bm25(${big}) LIMIT ?`,
    ).bind(`subject:shipment AND day:(${week})`, ORG, LIMIT).all<{ message_id: string }>();

    const smallUnwindowed = await tokenised("shipment", null);
    const largeUnwindowed = await testEnv.CATALOG.prepare(
      `SELECT message_id FROM ${big} WHERE ${big} MATCH ? AND org_id = ?
       ORDER BY bm25(${big}) LIMIT ?`,
    ).bind("subject:shipment", ORG, LIMIT).all<{ message_id: string }>();

    const largeRows = large.meta.rows_read ?? 0;
    const largeUnwindowedRows = largeUnwindowed.meta.rows_read ?? 0;
    console.log(
      `\nMEASURE search_window_scaling  days=${DAYS}  window=7d\n`
      + `  corpus ${DELIVERIES}   windowed=${small.rowsRead}  unwindowed=${smallUnwindowed.rowsRead}\n`
      + `  corpus ${bigger}   windowed=${largeRows}  unwindowed=${largeUnwindowedRows}\n`,
    );

    /*
     * The unwindowed cost must grow with the corpus — if it did not, the corpus is not three times harder and
     * the comparison below means nothing. This is the anti-vacuity half.
     */
    expect(largeUnwindowedRows).toBeGreaterThan(smallUnwindowed.rowsRead * 2);

    /*
     * And the windowed cost must **not** grow like it. Stated as a ratio against the corpus multiple rather
     * than as a fixed figure: three times the mail in the same window is three times the mail *in that
     * window*, so some growth is the right answer — what must not happen is growth with the archive.
     */
    expect(largeRows).toBeLessThan(smallUnwindowed.rowsRead);
    await testEnv.CATALOG.prepare(`DROP TABLE ${big}`).run();
  });

  it("prints where the cost actually comes from, which decides what a bound could be made of", async () => {
    /*
     * #153's sharpest objection to the current shape is that **selectivity is not knowable before the query
     * runs**, so there is no per-request rule admitting the cheap case and refusing the expensive one.
     *
     * A tokenised window changes what the rule would have to be made of, and this measures which. If cost
     * tracks the *narrower* of the two sides, a selective term in a wide window is cheap and only the
     * common-term case needs bounding — and the volume in a window **is** knowable before running, cheaply,
     * because `ir_org_accepted` is a seek. That would be a rule the Node could apply in advance, which is
     * exactly what #153 says does not exist today.
     */
    const midpoint = START + (DAYS / 2) * DAY_MS;
    const lastDay = START + (DAYS - 1) * DAY_MS;
    const wide = { from: midpoint, to: lastDay };
    const narrow = { from: lastDay - 6 * DAY_MS, to: lastDay };

    const commonWide = await tokenised("shipment", wide);
    const rareWide = await tokenised("demurrage", wide);
    const commonNarrow = await tokenised("shipment", narrow);
    const rareNarrow = await tokenised("demurrage", narrow);

    console.log(
      `\nMEASURE search_window_selectivity  budget=${BUDGETS["authz.list.max_rows_read"]}\n`
      + `  common term, 60-day window  rows_read=${commonWide.rowsRead} (${commonWide.rows} rows)\n`
      + `  rare term,   60-day window  rows_read=${rareWide.rowsRead} (${rareWide.rows} rows)\n`
      + `  common term,  7-day window  rows_read=${commonNarrow.rowsRead} (${commonNarrow.rows} rows)\n`
      + `  rare term,    7-day window  rows_read=${rareNarrow.rowsRead} (${rareNarrow.rows} rows)\n`,
    );

    /*
     * The property that would make a pre-run bound possible: a selective term stays cheap however wide the
     * window, so the expensive corner is a **common term in a wide window** — and the window's volume, which
     * is what bounds it, can be counted before the search runs.
     */
    expect(rareWide.rowsRead).toBeLessThan(commonWide.rowsRead);
  });

  it("answers the same mail both ways, or the cheaper plan is not the same feature", async () => {
    /*
     * **The assertion that matters more than the cost.** #153 rejected filtering outside the arms because it
     * *"changes the meaning"* — the arms cap by rank first, so the window then filters an already-capped set
     * and the answer silently omits mail that exists.
     *
     * A token inside the MATCH should not have that problem: the narrowing happens before the cap. This
     * checks it rather than assuming it, on a window narrow enough that the whole answer fits inside one page
     * — which is the only case where "the same mail" is a question with a definite answer.
     */
    const lastDay = START + (DAYS - 1) * DAY_MS;
    const window = { from: lastDay - 2 * DAY_MS, to: lastDay };

    const byToken = await testEnv.CATALOG.prepare(
      `SELECT message_id FROM probe_search
       WHERE probe_search MATCH ? AND org_id = ? ORDER BY message_id`,
    ).bind(
      `subject:shipment AND day:(${tokensAcross(window.from, window.to).join(" OR ")})`, ORG,
    ).all<{ message_id: string }>();

    const byDate = await testEnv.CATALOG.prepare(
      `SELECT s.message_id FROM probe_search s
       JOIN probe_receipts r ON r.message_id = s.message_id
       WHERE s.probe_search MATCH ? AND s.org_id = ?
         AND r.accepted_at >= ? AND r.accepted_at <= ?
       ORDER BY s.message_id`,
    ).bind(
      "subject:shipment", ORG,
      new Date(window.from).toISOString(), new Date(window.to + DAY_MS - 1).toISOString(),
    ).all<{ message_id: string }>();

    expect(byToken.results.map((one) => one.message_id))
      .toEqual(byDate.results.map((one) => one.message_id));
    // And it is not vacuously equal because both are empty.
    expect(byToken.results.length).toBeGreaterThan(0);
  });

  it("cannot express an instant, which is the product consequence rather than a bug", async () => {
    /*
     * FTS5 matches tokens, not ranges. `since=2026-08-01T10:30:00.000Z` has no token, so a windowed *search*
     * offers day granularity where a windowed *listing* offers an instant.
     *
     * Asserted rather than described, because it is the half of this direction a maintainer is actually
     * choosing: a search window that silently rounded an instant to a day would answer with mail from before
     * the time the caller asked for, which is the same class of quiet wrongness #153 refused when it rejected
     * filtering outside the arms.
     */
    const lastDay = START + (DAYS - 1) * DAY_MS;
    const wholeDay = await tokenised("shipment", { from: lastDay, to: lastDay });

    const middayOnwards = await testEnv.CATALOG.prepare(
      `SELECT s.message_id FROM probe_search s
       JOIN probe_receipts r ON r.message_id = s.message_id
       WHERE s.probe_search MATCH ? AND s.org_id = ? AND r.accepted_at >= ?`,
    ).bind("subject:shipment", ORG, new Date(lastDay + 12 * 60 * 60 * 1000).toISOString())
      .all<{ message_id: string }>();

    /*
     * The day token cannot distinguish them: every delivery on the last day carries `d2026…`, so a caller
     * asking for "since midday" gets the whole day. Here that is the difference between some rows and none.
     */
    expect(wholeDay.rows).toBeGreaterThan(middayOnwards.results.length);
  });
});
