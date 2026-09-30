import { type Bytes, utf8 } from "@mailda/evidence";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";
import { createSystemCtx } from "@mailda/runtime";

import { messagePageQuery } from "../src/authz-read.ts";
import { checkSearchIndex } from "../src/doctor/evidence.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { materialiseReceipt } from "../src/materialise.ts";
import {
  bodyIndexState, ftsQuery, indexMessage, SEARCH_FORM, searchIndexBacklog, searchText,
} from "../src/search.ts";
import { backfillBodyIndex, backfillSearchIndex } from "../src/search-backfill.ts";
import { searchIndexReset } from "../../../../packages/cli/src/backup.mjs";
import { liveGrantsBySubject, SCOPES_FOR_CONTENT, SCOPES_FOR_METADATA } from "../src/supervised.ts";

/**
 * Finding Chinese, Japanese and Korean mail by part of what it says, in real FTS5 (`src/search.ts`,
 * `searchText`).
 *
 * `test/node/fts-query.test.ts` checks the rewrite against a model of `unicode61`. This file checks it against
 * `unicode61` itself, through the ingest path, because the model is only as good as the two facts it assumes
 * and both are FTS5's to decide: that a pair of Han characters is kept as **one** token, and that `"发票 票抬"*`
 * marks only the phrase's last term as a prefix.
 */

const testEnv = env as unknown as Env;
const ORG = "org_cjk";
const READER = "usr_cjk_reader";
const MAILBOX = "mbx_cjk";
const ADDRESS = "in@cjk.example";

/** A header value as RFC 2047 UTF-8, which is how mail carries a Chinese subject. */
function encoded(text: string): string {
  return `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(text)))}?=`;
}

function mail(subject: string, body: string, from = "sender@cjk-supplier.example"): Bytes {
  return utf8([
    `From: ${from}`, `To: ${ADDRESS}`, `Subject: ${encoded(subject)}`,
    `Message-ID: <${crypto.randomUUID()}@cjk-supplier.example>`, "Date: Mon, 3 Aug 2026 12:00:00 +0000",
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "",
    body,
  ].join("\r\n"));
}

/** Accepts and materialises one message the way the ingest path does. Returns its `msg_…` id. */
async function deliver(receiptId: string, raw: Bytes): Promise<string> {
  const ctx = createSystemCtx();
  const blobKey = `${ORG}/raw/2026-Q3/${receiptId}.eml`;
  await putEvidence(testEnv, blobKey, raw);
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
       blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(receiptId, ORG, `evt_${receiptId}`, "sender@cjk-supplier.example", ADDRESS, raw.length, blobKey,
    "0".repeat(64), new Date(ctx.now()).toISOString()).run();
  expect((await materialiseReceipt(testEnv, ctx, receiptId)).status).toBe("created");
  const row = await testEnv.CATALOG.prepare("SELECT id FROM messages WHERE ingress_receipt_id = ?")
    .bind(receiptId).first<{ id: string }>();
  return row!.id;
}

/** Messages whose **subject or sender** match, straight from the subject index. */
async function subjectFinds(typed: string): Promise<string[]> {
  const rows = await testEnv.CATALOG.prepare(
    "SELECT message_id AS id FROM message_search WHERE message_search MATCH ?",
  ).bind(ftsQuery(typed)).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

/** Messages whose **body** matches, straight from the body index. */
async function bodyFinds(typed: string): Promise<string[]> {
  const rows = await testEnv.CATALOG.prepare(
    `SELECT m.id AS id FROM message_body_search b JOIN messages m ON m.rowid = b.rowid
      WHERE b.message_body_search MATCH ?`,
  ).bind(ftsQuery(typed)).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

/**
 * Runs a backfill until it has nothing left, and fails rather than spinning when it never gets there: a pass
 * that re-selects the same messages forever (a stamp that does not land) is a defect these tests look for.
 */
async function drain(pass: () => Promise<boolean>): Promise<void> {
  for (let passes = 0; passes < 50; passes++) if (!await pass()) return;
  throw new Error("the backfill did not finish in 50 passes: something it writes is not stamped current");
}

let invoice = "";
let order = "";
let fullWidth = "";
let tokyo = "";

beforeAll(async () => {
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
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
  invoice = await deliver("rcpt_cjk_invoice000000000001", mail("关于发票的问题", "请尽快回复。谢谢！"));
  order = await deliver("rcpt_cjk_order00000000000001", mail("发货通知", "您的订单123已发货，请查收。"));
  fullWidth = await deliver("rcpt_cjk_fullwidth000000001", mail("ＡＢＣ　quarterly statement", "nothing here"));
  tokyo = await deliver("rcpt_cjk_tokyo00000000000001", mail("東京タワーへ行く予定", "らーめん屋さんで会いましょう"));
});

describe("Chinese, Japanese and Korean are found by part of a sentence", () => {
  it("finds a subject by any part of a Chinese sentence, including its first and last character", async () => {
    /*
     * The reported defect, in the words it was reported in: `关于发票的问题` indexed and `发票` searched found
     * nothing, because `unicode61` held the whole sentence as one token. `发` is a single character, which is
     * matched as a prefix of the bigrams it begins; `题` is the last character, which begins no bigram and is
     * found only because a run's last character is also indexed on its own.
     */
    for (const typed of ["发票", "票的", "发", "问题", "题", "关于发票的问题", "发票 问题"]) {
      expect(await subjectFinds(typed), `${typed} did not find 关于发票的问题`).toContain(invoice);
    }
  });

  it("does not find characters that are present but not next to each other", async () => {
    // The control: without it, an index that matched every row would pass the case above.
    expect(await subjectFinds("发问")).not.toContain(invoice);
    expect(await subjectFinds("票发")).not.toContain(invoice);
    expect(await subjectFinds("发票")).not.toContain(order);
  });

  it("finds the digits in 订单123 in a body, and the Chinese beside them", async () => {
    for (const typed of ["123", "订单", "订单123", "单123", "发货", "查收"]) {
      expect(await bodyFinds(typed), `${typed} did not find the order body`).toContain(order);
    }
  });

  it("finds a full-width ＡＢＣ by abc, and the other way round", async () => {
    expect(await subjectFinds("abc")).toContain(fullWidth);
    expect(await subjectFinds("ＡＢＣ")).toContain(fullWidth);
    expect(await subjectFinds("quarterly")).toContain(fullWidth);
  });

  it("finds Japanese across a change of script, and kana joined by the long-vowel mark", async () => {
    for (const typed of ["東京", "タワー", "京タ", "東京タワー", "行く", "予定"]) {
      expect(await subjectFinds(typed), `${typed} did not find 東京タワーへ行く予定`).toContain(tokyo);
    }
    expect(await bodyFinds("らーめん")).toContain(tokyo);
    expect(await bodyFinds("会い")).toContain(tokyo);
  });

  it("answers the same search through the page query a reader's request builds", async () => {
    /*
     * The two helpers above read the index directly, to say which index answered. This is the shipped path:
     * `messagePageQuery` wraps the expression, unions both arms and authorizes them.
     */
    const query = messagePageQuery({
      readerId: READER,
      nowIso: new Date().toISOString(),
      sponsor: { sql: "", params: [] },
      orgId: ORG,
      subjects: [READER],
      supervised: {
        metadata: liveGrantsBySubject(ORG, READER, new Date().toISOString(), SCOPES_FOR_METADATA),
        content: liveGrantsBySubject(ORG, READER, new Date().toISOString(), SCOPES_FOR_CONTENT),
      },
      page: {
        after: null, mailboxId: null, q: ftsQuery("发票"), since: null, until: null, from: null,
        conversationId: null, label: null, place: null, unread: false, mine: false,
      },
      limit: 51,
      lookback: null,
    });
    const rows = await testEnv.CATALOG.prepare(query.sql).bind(...query.params).all<{ message_id: string }>();
    expect(rows.results.map((row) => row.message_id)).toEqual([invoice]);
  });
});

describe("what the contentless body index discloses", () => {
  it("gives back a body's token sequence, in order, to anybody who can read the table", async () => {
    /*
     * `d1-fts5-search.md` and 0041 described the body index's disclosure as "which words occur in which
     * message" — a bag of words. It is more than that. The table is `detail=full`, FTS5's default, which keeps
     * every token's **offset**, and `fts5vocab`'s `instance` view reads them back: the body, in order, minus
     * punctuation and case. With bigrams, a Chinese body is its own characters chained, so it reads back as
     * the text. Asserted so the correction is a fact about this schema rather than a sentence about it; the
     * option itself is ADR 28's owner's decision, and is unchanged.
     */
    await testEnv.CATALOG.prepare(
      "CREATE VIRTUAL TABLE IF NOT EXISTS probe_body_instances USING fts5vocab(message_body_search, 'instance')",
    ).run();
    const rows = await testEnv.CATALOG.prepare(
      `SELECT term FROM probe_body_instances
        WHERE doc = (SELECT rowid FROM messages WHERE id = ?) AND col = 'body' ORDER BY offset`,
    ).bind(order).all<{ term: string }>();
    const expected = searchText("您的订单123已发货，请查收。").split(/[^\p{L}\p{N}]+/u).filter((t) => t !== "");
    expect(rows.results.map((row) => row.term)).toEqual(expected);
    // Chained, the bigrams are the sentence: every other one, plus each run's last character.
    expect(expected.join(" ")).toBe("您的 的订 订单 单 123 已发 发货 货 请查 查收 收");
  });
});

describe("the index cannot hold text its message does not", () => {
  it("writes nothing when handed a subject the row does not hold, and the backfill indexes the row's", async () => {
    /*
     * `indexMessage` binds the text, because SQL cannot compute `searchText` — so it could be handed text that
     * is not the message's. It compares what it was handed with the row it selects, and writes nothing on a
     * mismatch; the stamp is under the same predicate, so the message stays below the current form, which is
     * exactly what the backfill picks up and indexes from the row itself.
     */
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("DELETE FROM message_search WHERE message_id = ?").bind(invoice),
      testEnv.CATALOG.prepare("UPDATE messages SET search_index_form = 0 WHERE id = ?").bind(invoice),
    ]);
    const [row, stamp] = await testEnv.CATALOG.batch(indexMessage(testEnv, invoice, {
      subject: "关于付款的问题", from: "sender@cjk-supplier.example",
    }));
    expect(row!.meta.changes, "an index row was written for a subject the message does not have").toBe(0);
    expect(stamp!.meta.changes, "the message was stamped current with no row written").toBe(0);
    expect(await subjectFinds("付款")).not.toContain(invoice);

    await drain(async () => await backfillSearchIndex(testEnv) > 0);
    expect(await subjectFinds("发票")).toContain(invoice);
  });
});

/*
 * The previous version's writers, exactly as they stood before `searchText` (HEAD `src/search.ts` and
 * `src/materialise.ts` at dd0b9f5). What makes them the hazard is what they do **not** name: none of them
 * writes `search_index_form`, `body_index_form` or `body_index_cut_from_bytes`, because that code predates the
 * columns. `mailda deploy` applies migrations before the canary, so this code keeps writing after 0071 until
 * promotion, and again after a rollback.
 */
const OLD = {
  subject: `INSERT INTO message_search (subject, from_addr, day, message_id, org_id)
    SELECT m.subject, m.from_addr, 'd' || replace(substr(r.accepted_at, 1, 10), '-', ''), m.id, m.org_id
      FROM messages m JOIN ingress_receipts r ON r.id = m.ingress_receipt_id WHERE m.id = ?`,
  body: `INSERT OR REPLACE INTO message_body_search (rowid, body, day)
    SELECT m.rowid, ?, 'd' || replace(substr(r.accepted_at, 1, 10), '-', '')
      FROM messages m JOIN ingress_receipts r ON r.id = m.ingress_receipt_id
     WHERE m.id = ? AND m.body_index_attempt_version = ?`,
  settle: `UPDATE messages
      SET body_index_state = ?, body_index_error = ?, body_index_next_attempt_at = NULL,
          body_indexed_at = ?, body_index_lease_until = NULL
    WHERE id = ? AND body_index_attempt_version = ?`,
  claim: `UPDATE messages SET body_index_lease_until = ?, body_index_attempt_version = body_index_attempt_version + 1
    WHERE id = ? RETURNING body_index_attempt_version AS version`,
};

async function forms(id: string): Promise<{ subject: number; body: number; state: string }> {
  return (await testEnv.CATALOG.prepare(
    "SELECT search_index_form AS subject, body_index_form AS body, body_index_state AS state FROM messages WHERE id = ?",
  ).bind(id).first<{ subject: number; body: number; state: string }>())!;
}

describe("a row the previous version writes after migration 0071 is still re-formed", () => {
  it("re-forms mail the previous version accepted after the migration, found meanwhile by its Latin words only", async () => {
    /*
     * The interleaving 0071's first version lost: the migration has run (every migration is applied before
     * this file), and the previous version, still serving, accepts a message — its row in `messages` and both
     * index rows in the old form, and `indexed`. Nothing here resets a form column: the zeros asserted below
     * are the defaults the old INSERT leaves, which is the whole mechanism.
     */
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const receiptId = "rcpt_cjk_oldcode000000000001";
    const legacy = "msg_cjk_oldcode00000000000001";
    const raw = mail("发票抬头 invoice header", "请确认发票抬头 please confirm");
    const blobKey = `${ORG}/raw/2026-Q3/${receiptId}.eml`;
    await putEvidence(testEnv, blobKey, raw);
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(
        `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
           blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(receiptId, ORG, `evt_${receiptId}`, "sender@cjk-supplier.example", ADDRESS, raw.length, blobKey,
        "0".repeat(64), at),
      testEnv.CATALOG.prepare(
        `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
           thread_root_rfc_id, conversation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(legacy, ORG, "2026-Q3", blobKey, "0".repeat(64), raw.length, `${receiptId}@cjk.example`,
        ctx.id("thr"), "发票抬头 invoice header", "sender@cjk-supplier.example", at, at, receiptId, at,
        `${receiptId}@cjk.example`, ctx.id("cnv")),
      testEnv.CATALOG.prepare(OLD.subject).bind(legacy),
      testEnv.CATALOG.prepare(OLD.body).bind("请确认发票抬头 please confirm", legacy, 0),
      testEnv.CATALOG.prepare(OLD.settle).bind("indexed", null, at, legacy, 0),
    ]);
    expect(await forms(legacy)).toEqual({ subject: 0, body: 0, state: "indexed" });

    /*
     * The defect, reproduced on the old rows — the control that makes the last assertions mean something.
     * From the middle of the run: `发票` would be found, as a prefix of the old one-token `发票抬头`.
     */
    expect(await subjectFinds("票抬")).not.toContain(legacy);
    expect(await bodyFinds("确认发票")).not.toContain(legacy);
    expect(await subjectFinds("invoice")).toContain(legacy);
    /*
     * And what `doctor` and the docs may say of it, pinned: an old-form row is **not** found by the whole CJK word
     * it holds, because the query bigrams what the old row kept as one token. Only a search that is a run's first
     * one or two characters still matches, as a prefix of that token.
     */
    expect(await subjectFinds("发票抬头"), "a whole CJK run on an old-form row").not.toContain(legacy);
    expect(await bodyFinds("请确认发票抬头"), "a whole CJK run on an old-form body").not.toContain(legacy);
    expect(await subjectFinds("发票")).toContain(legacy);

    // Waiting, and counted as waiting rather than as done or as absent.
    expect(await searchIndexBacklog(testEnv)).toBeGreaterThan(0);
    expect((await bodyIndexState(testEnv)).olderForm).toBeGreaterThan(0);

    await drain(async () => await backfillSearchIndex(testEnv) > 0);
    const rows = await testEnv.CATALOG.prepare("SELECT count(*) AS n FROM message_search WHERE message_id = ?")
      .bind(legacy).first<{ n: number }>();
    expect(rows?.n, "the old subject row was left beside the new one").toBe(1);

    // One body pass requeues it and re-reads it; until then its old row answered a Latin word.
    expect(await bodyFinds("confirm"), "the old body row was dropped rather than kept until replaced")
      .toContain(legacy);
    await drain(async () => {
      const left = await bodyIndexState(testEnv);
      if (left.pending + left.olderForm === 0) return false;
      expect(await backfillBodyIndex(testEnv, createSystemCtx())).toBeGreaterThan(0);
      return true;
    });

    expect(await searchIndexBacklog(testEnv)).toBe(0);
    expect(await forms(legacy)).toEqual({ subject: SEARCH_FORM, body: SEARCH_FORM, state: "indexed" });
    // Caught up means a pass re-reads nothing: a requeue that took current bodies too would spend R2 forever.
    expect(await backfillBodyIndex(testEnv, createSystemCtx()), "a caught-up body pass re-read mail").toBe(0);
    expect(await subjectFinds("发票")).toContain(legacy);
    expect(await subjectFinds("票抬")).toContain(legacy);
    expect(await subjectFinds("发票抬头")).toContain(legacy);
    expect(await bodyFinds("确认发票")).toContain(legacy);
    expect(await bodyFinds("confirm")).toContain(legacy);
    // Every message delivered above is current too, not only the one this case wrote in the old form.
    expect(await subjectFinds("发票")).toContain(invoice);
  });

  it("re-forms a body the previous version re-indexed after this version had stamped it current", async () => {
    /*
     * The other old-code writer: its body backfill, which claims a queued message and writes the old form.
     * The message was indexed and stamped by this version at ingest; the previous version then claims it (a
     * repair on that version is how it gets queued) and settles `indexed` without touching the stamp. Only the
     * trigger on the claim's version bump can say that the row is now old.
     */
    const reclaimed = await deliver("rcpt_cjk_reclaimed0000000001", mail("关于合同的问题", "合同已签署 contract signed"));
    expect(await forms(reclaimed)).toMatchObject({ body: SEARCH_FORM, state: "indexed" });

    const at = new Date(createSystemCtx().now()).toISOString();
    await testEnv.CATALOG.prepare("UPDATE messages SET body_index_state = 'pending' WHERE id = ?").bind(reclaimed).run();
    const claimed = await testEnv.CATALOG.prepare(OLD.claim).bind(at, reclaimed).first<{ version: number }>();
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(OLD.body).bind("合同已签署 contract signed", reclaimed, claimed!.version),
      testEnv.CATALOG.prepare(OLD.settle).bind("indexed", null, at, reclaimed, claimed!.version),
    ]);
    expect(await bodyFinds("同已"), "the previous version's row is not the old form").not.toContain(reclaimed);
    expect(await forms(reclaimed), "an old-form body kept this version's stamp").toMatchObject({ body: 0 });

    await drain(async () => {
      const left = await bodyIndexState(testEnv);
      if (left.pending + left.olderForm === 0) return false;
      expect(await backfillBodyIndex(testEnv, createSystemCtx())).toBeGreaterThan(0);
      return true;
    });
    expect(await bodyFinds("同已")).toContain(reclaimed);
    expect(await forms(reclaimed)).toMatchObject({ body: SEARCH_FORM, state: "indexed" });
  });
});

describe("a body longer than the index can hold is indexed in part, and says so", () => {
  it("records the cut on the message and doctor names the limit, the size and what cannot be found", async () => {
    /*
     * 300,000 Chinese characters: 900 KB of mail, inside `render.max_body_bytes`, and about 2.1 MB once
     * `searchText` has made bigrams of it — past `d1.max_row_bytes`, D1's limit on one string. A word at the
     * start is indexed; one at the end is past the cut. Before this the cut was made and nothing recorded it.
     */
    const body = `openingword ${"关于发票的问题请尽快回复".repeat(25_000)} closingword`;
    const long = await deliver("rcpt_cjk_long000000000000001", mail("长邮件", body));
    const whole = new TextEncoder().encode(searchText(body)).byteLength;
    expect(whole).toBeGreaterThan(BUDGETS["d1.max_row_bytes"]);

    const row = await testEnv.CATALOG.prepare(
      "SELECT body_index_state AS state, body_index_cut_from_bytes AS cut FROM messages WHERE id = ?",
    ).bind(long).first<{ state: string; cut: number | null }>();
    expect(row).toEqual({ state: "indexed", cut: whole });
    expect(await bodyFinds("openingword")).toContain(long);
    expect(await bodyFinds("closingword"), "the control: the end of the body is past the cut").not.toContain(long);

    // Only this message is cut, so the largest is its size, and a short body elsewhere records nothing.
    const counts = await bodyIndexState(testEnv);
    expect({ cut: counts.cut, largest: counts.cutLargestBytes }).toEqual({ cut: 1, largest: whole });
    const partial = (await checkSearchIndex(testEnv, ORG)).find((finding) => finding.check === "body_index_partial");
    expect(partial?.detail).toContain(`d1.max_row_bytes=${BUDGETS["d1.max_row_bytes"]}`);
    expect(partial?.detail).toContain(`${whole} bytes`);
    expect(partial?.detail).toContain("are not found by search");
    expect(partial?.receipt).toBe("docs/receipts/d1-platform-limits.md");
  });
});

describe("a Node restored from a backup rebuilds both indexes", () => {
  it("finds its mail again once the dump's last statement has cleared the form stamps, and doctor counts down", async () => {
    /*
     * The shape `mailda backup` leaves: `messages` with every column, the form stamps included, and neither
     * search table (an fts5 table cannot be exported). Built here by emptying both indexes under messages
     * stamped current, which is what a restore produces.
     */
    await drain(async () => await backfillSearchIndex(testEnv) > 0);
    await drain(async () => await backfillBodyIndex(testEnv, createSystemCtx()) > 0);
    expect(await subjectFinds("发票")).toContain(invoice);
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("DELETE FROM message_search"),
      testEnv.CATALOG.prepare("DELETE FROM message_body_search"),
    ]);
    // The defect, as the control: stamped current and empty, so nothing is selected and doctor says complete.
    expect(await subjectFinds("发票")).not.toContain(invoice);
    expect(await searchIndexBacklog(testEnv)).toBe(0);
    expect(await backfillSearchIndex(testEnv)).toBe(0);

    const master = await testEnv.CATALOG.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string; sql: string }>();
    const reset = searchIndexReset(master.results);
    expect(reset).not.toBeNull();
    await testEnv.CATALOG.prepare(reset!).run();

    expect(await searchIndexBacklog(testEnv)).toBeGreaterThan(0);
    expect((await bodyIndexState(testEnv)).olderForm).toBeGreaterThan(0);
    await drain(async () => await backfillSearchIndex(testEnv) > 0);
    await drain(async () => {
      const left = await bodyIndexState(testEnv);
      if (left.pending + left.olderForm === 0) return false;
      expect(await backfillBodyIndex(testEnv, createSystemCtx())).toBeGreaterThan(0);
      return true;
    });
    expect(await subjectFinds("发票")).toContain(invoice);
    expect(await bodyFinds("订单")).toContain(order);
    expect(await searchIndexBacklog(testEnv)).toBe(0);
    expect((await bodyIndexState(testEnv)).olderForm).toBe(0);
  });
});
