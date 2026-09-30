import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { assertWithinBudget, BUDGETS } from "@mailda/budgets";
import { createSystemCtx } from "@mailda/runtime";

import { messagePageQuery } from "../src/authz-read.ts";
import { bodyIndexText, ftsQuery, indexBody, indexMessage, searchText } from "../src/search.ts";
import { liveGrantsBySubject, SCOPES_FOR_CONTENT, SCOPES_FOR_METADATA } from "../src/supervised.ts";
import { NA_HAN } from "./fixtures/na-han.ts";

/**
 * What the CJK bigram rewrite costs, on local D1: index growth and rows read per searched page
 * (`docs/receipts/cjk-search-bigrams.md`).
 *
 * The corpus is `test/fixtures/na-han.ts`, a **literary** text and not mail. Subjects are its sentences and
 * bodies are 200-character windows of it, 1,200 deliveries, seeded exactly as `message-search.measure.test.ts`
 * seeds its English corpus (the reader's own rows included), so the two sets of figures are comparable in
 * shape. They are not comparable in vocabulary, and no figure here stands for a Chinese mailbox.
 *
 * Printed on every run, asserted against the list budget. The receipt records the figures and what makes
 * them stale.
 */

const testEnv = env as unknown as Env;
const ORG = "org_cjk_measure";
const READER = "usr_cjk_measure";
const MAILBOX = "mbx_cjk_measure";
const ADDRESS = "in@cjk-measure.example";
const AUGUST = Date.parse("2026-08-01T00:00:00.000Z");
const DELIVERIES = 1200;
const BODY_CHARS = 200;

const TEXT = [...NA_HAN];
const SENTENCES = NA_HAN.split(/[。！？]/u).map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 4);

function bodyOf(n: number): string {
  const start = (n * 29) % (TEXT.length - BODY_CHARS);
  return TEXT.slice(start, start + BODY_CHARS).join("");
}

interface Cost { rowsRead: number; rows: number }

async function cost(term: string): Promise<Cost> {
  return costOf(ftsQuery(term));
}

/** The searched page statement for an FTS5 expression as given, which is how a refused one is timed. */
async function costOf(q: string | null): Promise<Cost> {
  const at = new Date(AUGUST).toISOString();
  const query = messagePageQuery({
    readerId: READER,
    nowIso: at,
    sponsor: { sql: "", params: [] },
    orgId: ORG,
    subjects: [READER],
    supervised: {
      metadata: liveGrantsBySubject(ORG, READER, at, SCOPES_FOR_METADATA),
      content: liveGrantsBySubject(ORG, READER, at, SCOPES_FOR_CONTENT),
    },
    page: {
      after: null, mailboxId: null, q, since: null, until: null, from: null,
      conversationId: null, label: null, place: null, unread: false, mine: false,
    },
    limit: BUDGETS["messages.page_size"] + 1,
    lookback: null,
  });
  const result = await testEnv.CATALOG.prepare(query.sql).bind(...query.params).all<{ id: string }>();
  return { rowsRead: result.meta.rows_read ?? 0, rows: result.results.length };
}

beforeAll(async () => {
  const ctx = createSystemCtx();
  const at = new Date(AUGUST).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Enquiries", at),
    testEnv.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)")
      .bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, READER, "mailbox.content.read", "mailbox", MAILBOX, at),
  ]);

  const statements = [];
  for (let n = 0; n < DELIVERIES; n++) {
    const receiptId = `rcpt_cjkm${String(n).padStart(21, "0")}`;
    const messageId = `msg_cjkm${String(n).padStart(22, "0")}`;
    const conversation = `cnv_cjkm${String(n).padStart(22, "0")}`;
    const acceptedAt = new Date(AUGUST + Math.floor(n / 4) * 4 * 60_000).toISOString();
    const subject = SENTENCES[n % SENTENCES.length]!.slice(0, 60);
    const from = `sender-${n}@supplier.example.cn`;
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
         blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(receiptId, ORG, `evt_cjkm_${n}`, from, ADDRESS, 24_576, `${ORG}/raw/${receiptId}`, "0".repeat(64),
      acceptedAt));
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
         thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
         thread_root_rfc_id, conversation_id, from_name, preview_sealed, preview_generation, preview_state)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(messageId, ORG, "2026-Q3", `${ORG}/raw/${receiptId}`, "0".repeat(64), 24_576,
      `${receiptId}@example.net`, `thr_cjkm${String(n).padStart(22, "0")}`, subject, from, acceptedAt,
      acceptedAt, receiptId, acceptedAt, `${receiptId}@example.net`, conversation,
      n % 10 < 7 ? `供應商 ${n}` : null, "A".repeat(200), 1, "projected"));
    // The reader's own rows, in the proportions `message-search.measure.test.ts` seeds, for its reason.
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(`cas_cjkm${String(n).padStart(22, "0")}`, ORG, conversation, MAILBOX,
      n % 20 === 3 ? "claimed" : "open", acceptedAt, n % 20 === 3 ? READER : null,
      n % 20 === 3 ? acceptedAt : null, acceptedAt));
    if (n % 5 !== 1) {
      statements.push(testEnv.CATALOG.prepare(
        "INSERT INTO message_reads (org_id, user_id, message_id, read_at) VALUES (?,?,?,?)",
      ).bind(ORG, READER, messageId, acceptedAt));
    }
    if (n % 2 === 0) {
      statements.push(testEnv.CATALOG.prepare(
        `INSERT INTO message_places (org_id, user_id, message_id, receipt_id, accepted_at, place, placed_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind(ORG, READER, messageId, receiptId, acceptedAt, n % 20 === 0 ? "trash" : "archive", acceptedAt));
    }
    statements.push(...indexMessage(testEnv, messageId, { subject, from }));
    statements.push(indexBody(testEnv, messageId, bodyIndexText(bodyOf(n)), 0));
  }
  for (let at2 = 0; at2 < statements.length; at2 += 300) {
    await testEnv.CATALOG.batch(statements.slice(at2, at2 + 300));
  }
});

describe("what a Chinese search costs", () => {
  /*
   * Five shapes. `櫃台` is rare in the text, `我們` is ordinary, `的` is the commonest character in written
   * Chinese and — as a single character — a prefix over every bigram it begins, which is the worst term a
   * person can type. The fourteen-character sentence is one typed word and thirteen bigrams in one phrase;
   * the twelve single characters are the most words one search may carry, each a prefix.
   */
  const TERMS = {
    rare: "櫃台",
    ordinary: "我們",
    commonest: "的",
    sentence: "我在年青時候也曾經做過許多夢",
    twelve: "的 了 是 我 他 在 不 一 有 人 這 也",
  } as const;

  it("prints rows read per page for each shape, inside the list budget", async () => {
    const measured: Record<string, Cost> = {};
    for (const [name, term] of Object.entries(TERMS)) measured[name] = await cost(term);
    process.stdout.write(`\nMEASURE cjk_search  deliveries=${DELIVERIES}  ${Object.entries(measured)
      .map(([name, c]) => `${name}=${c.rowsRead} (${c.rows} rows)`).join("  ")}\n`);

    // Anti-vacuity: the rare term finds something and the commonest fills the page.
    expect(measured.rare!.rows).toBeGreaterThan(0);
    expect(measured.commonest!.rows).toBe(BUDGETS["messages.page_size"] + 1);
    for (const [name, c] of Object.entries(measured)) {
      const what = `one searched page of Chinese (${name}: ${TERMS[name as keyof typeof TERMS]})`;
      assertWithinBudget("authz.list.max_rows_read", c.rowsRead, {
        what, receipt: "docs/receipts/cjk-search-bigrams.md",
      });
      // And against the measured figure rather than only the ceiling, for `message-search.measure.test.ts`'s
      // reason: a ceiling says nothing while there is headroom.
      assertWithinBudget("search.cjk_rows_read_per_page", c.rowsRead, {
        what, receipt: "docs/receipts/cjk-search-bigrams.md",
      });
    }
  });
});

describe("what a long phrase costs, which rows read cannot show", () => {
  /*
   * `search.max_query_terms`. A phrase's time grows with its terms, one doclist per term, and D1's rows_read
   * counts only the rows FTS5 returns, so a long phrase that matches nothing reads 2 rows whatever it costs. So
   * this is timed: the page statement, the median of nine runs after one to warm, on this local SQLite. The
   * phrase is the worst this corpus offers: `的人` repeated, two of its commonest bigrams alternating, so every
   * term's doclist is long and none is missing (a phrase with a rare or absent term stops early). The limit is
   * where that phrase costs no more than `的`, the commonest one-character search; timings are local and not
   * asserted, since a timing check in CI is flaky and a muted one is worse than none (AGENTS.md §2).
   */
  async function median(term: string): Promise<number> {
    await cost(term);
    const runs: number[] = [];
    for (let i = 0; i < 9; i++) {
      const started = performance.now();
      await cost(term);
      runs.push(performance.now() - started);
    }
    return runs.sort((a, b) => a - b)[4]!;
  }

  it("prints the time of the commonest one-character search, and of the worst phrase at and past the limit", async () => {
    const limit = BUDGETS["search.max_query_terms"];
    const phrase = (terms: number) => "的人".repeat(terms).slice(0, terms + 1); // the last word: one term a character after the first
    const figures: Record<string, number> = { commonest: await median("的") };
    for (const terms of [limit / 2, limit]) figures[`phrase_${terms}_terms`] = await median(phrase(terms));
    // Past the limit `ftsQuery` refuses; the statement is timed from the terms it would have built.
    for (const terms of [limit * 2, limit * 4]) {
      const expression = `"${searchText(phrase(terms)).trim().split(" ").slice(0, terms).join(" ")}"*`;
      const started = performance.now();
      for (let i = 0; i < 9; i++) await costOf(expression);
      figures[`phrase_${terms}_terms_refused`] = (performance.now() - started) / 9;
    }
    process.stdout.write(`\nMEASURE cjk_phrase_ms  ${Object.entries(figures)
      .map(([name, ms]) => `${name}=${ms.toFixed(1)}`).join("  ")}\n`);
    expect(() => ftsQuery(phrase(limit))).not.toThrow();
  });
});

describe("what the bigram rewrite costs the index", () => {
  it("prints the index's size for the same text, as unicode61 held it and as searchText holds it", async () => {
    /*
     * Two contentless tables, the body index's shape, filled with the same 1,200 bodies — raw, as before
     * `searchText` (search form 0), and through it. `_data` is where FTS5 keeps the postings, so its bytes are the growth;
     * `fts5vocab` counts distinct terms and token instances. English bodies through both, as the control that
     * the rewrite is the identity on text it is not for.
     */
    const english = (n: number) => `container ${n} cleared and the shipment was released on time`;
    const sizes: Record<string, { bytes: number; terms: number; instances: number }> = {};
    for (const [name, text] of [
      ["cjk_raw", (n: number) => bodyOf(n)], ["cjk_bigram", (n: number) => searchText(bodyOf(n))],
      ["en_raw", english], ["en_bigram", (n: number) => searchText(english(n))],
    ] as const) {
      await testEnv.CATALOG.prepare(
        `CREATE VIRTUAL TABLE probe_${name} USING fts5(body, content='', contentless_delete=1, tokenize='unicode61')`,
      ).run();
      await testEnv.CATALOG.prepare(`CREATE VIRTUAL TABLE probe_${name}_vocab USING fts5vocab(probe_${name}, 'row')`)
        .run();
      const inserts = Array.from({ length: DELIVERIES }, (_, n) =>
        testEnv.CATALOG.prepare(`INSERT INTO probe_${name} (rowid, body) VALUES (?, ?)`).bind(n + 1, text(n)));
      for (let at = 0; at < inserts.length; at += 300) await testEnv.CATALOG.batch(inserts.slice(at, at + 300));
      const data = await testEnv.CATALOG.prepare(`SELECT sum(length(block)) AS bytes FROM probe_${name}_data`)
        .first<{ bytes: number }>();
      const vocab = await testEnv.CATALOG.prepare(
        `SELECT count(*) AS terms, sum(cnt) AS instances FROM probe_${name}_vocab`,
      ).first<{ terms: number; instances: number }>();
      sizes[name] = { bytes: data!.bytes, terms: vocab!.terms, instances: vocab!.instances };
    }
    process.stdout.write(`\nMEASURE cjk_index  ${Object.entries(sizes)
      .map(([name, s]) => `${name}: bytes=${s.bytes} terms=${s.terms} instances=${s.instances}`).join("  |  ")}\n`);

    expect(sizes.en_bigram).toEqual(sizes.en_raw);
    expect(sizes.cjk_bigram!.bytes).toBeGreaterThan(sizes.cjk_raw!.bytes);
  });

  it("prints the size of a Chinese body at render.max_body_bytes, before and after the rewrite", async () => {
    /*
     * `extractBody` cuts a body at `render.max_body_bytes` **UTF-16 units**, before the rewrite. A Chinese
     * body at that bound is 3 bytes a character in UTF-8, and the bigrams roughly double it — past
     * `d1.max_row_bytes`, D1's limit on one string, which is why `indexBody` binds `bodyIndexText` and not the
     * rewrite itself (`test/node/fts-query.test.ts` checks the cut). Local D1 does not enforce the production
     * limit, so this prints sizes and does not show what production does with them.
     */
    const body = TEXT.join("").repeat(Math.ceil(BUDGETS["render.max_body_bytes"] / TEXT.length))
      .slice(0, BUDGETS["render.max_body_bytes"]);
    const rawBytes = new TextEncoder().encode(body).length;
    const rewrittenBytes = new TextEncoder().encode(searchText(body)).length;
    process.stdout.write(`\nMEASURE cjk_max_body  utf16_units=${body.length}  raw_utf8=${rawBytes}  `
      + `rewritten_utf8=${rewrittenBytes}  d1.max_row_bytes=${BUDGETS["d1.max_row_bytes"]}\n`);
    expect(rewrittenBytes).toBeGreaterThan(rawBytes);
  });
});
