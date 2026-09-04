import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";
import { createSystemCtx } from "@mailda/runtime";

import { messagePageQuery } from "../src/authz-read.ts";
import { liveGrantsBySubject, SCOPES_FOR_CONTENT, SCOPES_FOR_METADATA } from "../src/supervised.ts";

/**
 * What filtering the listing by sender costs, with and without an index (#152).
 *
 * ## Why this file exists at all
 *
 * #152 was filed saying a sender filter could not be made cheap: *"no single index can serve
 * sender-filtered time order"*, because `from_addr` is on `messages` and `accepted_at` is on
 * `ingress_receipts`. That is true of the **`From:` header** and it is the wrong column.
 *
 * `ingress_receipts.envelope_from` is the address the sending server handed over — the transmission fact this
 * Node recorded — and it sits on the **same table** as `accepted_at`. So one index can serve both, the seek
 * survives, and the keyset cursor keeps working. The ticket's three options were all answers to a problem
 * that only exists for the header.
 *
 * ## And why it is measured rather than reasoned
 *
 * An index the planner declines to use is dead weight that still costs every write. The figures below are
 * taken with the index absent and present, on the same corpus, so the decision to add it rests on a
 * difference rather than on an expectation. **DDL in a test does not roll back with isolated storage**, which
 * is why this is its own file — `fresh-install.test.ts` records that lesson.
 */

const testEnv = env as unknown as Env;
const ORG = "org_sender";
const MAILBOX = "mbx_sender";
const ADDRESS = "enquiries@sender.example";
const READER = "usr_sender_reader";
const AUGUST = Date.parse("2026-08-01T00:00:00.000Z");

/** Enough that a scan and a seek are different numbers rather than noise. */
const DELIVERIES = 1200;
/** One sender sends most of the mail; another sends once. Those are the two ends a plan behaves differently at. */
const BULK = "bulk@supplier.example.net";
const RARE = "once@rare.example.net";

interface Cost { rowsRead: number; rows: number }

async function cost(from: string | null): Promise<Cost> {
  const query = messagePageQuery({
    nowIso: new Date(AUGUST).toISOString(),
    sponsor: { sql: "", params: [] },
    orgId: ORG,
    subjects: [READER],
    supervised: {
      metadata: liveGrantsBySubject(ORG, READER, new Date(AUGUST).toISOString(), SCOPES_FOR_METADATA),
      content: liveGrantsBySubject(ORG, READER, new Date(AUGUST).toISOString(), SCOPES_FOR_CONTENT),
    },
    page: { after: null, mailboxId: null, q: null, since: null, until: null, from },
    limit: BUDGETS["messages.page_size"] + 1,
  });
  const result = await testEnv.CATALOG.prepare(query.sql).bind(...query.params).all<{ id: string }>();
  return { rowsRead: result.meta.rows_read ?? 0, rows: result.results.length };
}

async function planFor(from: string | null): Promise<string> {
  const query = messagePageQuery({
    nowIso: new Date(AUGUST).toISOString(),
    sponsor: { sql: "", params: [] },
    orgId: ORG,
    subjects: [READER],
    supervised: {
      metadata: liveGrantsBySubject(ORG, READER, new Date(AUGUST).toISOString(), SCOPES_FOR_METADATA),
      content: liveGrantsBySubject(ORG, READER, new Date(AUGUST).toISOString(), SCOPES_FOR_CONTENT),
    },
    page: { after: null, mailboxId: null, q: null, since: null, until: null, from },
    limit: BUDGETS["messages.page_size"] + 1,
  });
  const explained = await testEnv.CATALOG.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .bind(...query.params).all<{ detail: string }>();
  return explained.results.map((row) => row.detail).join("\n");
}

const INDEX = "ir_org_sender";

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
    ).bind(ctx.id("rt"), ORG, READER, "mailbox.metadata.read", "mailbox", MAILBOX, at),
  ]);

  const statements = [];
  for (let n = 0; n < DELIVERIES; n += 1) {
    const receiptId = `rcpt_send${String(n).padStart(21, "0")}`;
    const messageId = `msg_send${String(n).padStart(22, "0")}`;
    const acceptedAt = new Date(AUGUST + n * 60_000).toISOString();
    /*
     * The rare sender is the **oldest** message, deliberately. A time-ordered scan starts at the newest, so
     * a rare sender at the far end is the worst case for a plan that filters instead of seeking — and it is
     * the ordinary case for an investigation, which is looking for something old.
     *
     * Mixed case on purpose: the filter lowercases both sides, and a corpus that is uniformly lowercase
     * would let a case-sensitive comparison pass.
     */
    const sender = n === 0 ? RARE.toUpperCase() : BULK;
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
         blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(receiptId, ORG, `evt_send_${n}`, sender, ADDRESS, 24_576,
      `${ORG}/raw/${receiptId}`, "0".repeat(64), acceptedAt));
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
         thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
         thread_root_rfc_id, conversation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(messageId, ORG, "2026-Q3", `${ORG}/raw/${receiptId}`, "0".repeat(64), 24_576,
      `${receiptId}@example.net`, `thr_send${String(n).padStart(22, "0")}`, `Shipment ${n}`,
      sender, acceptedAt, acceptedAt, receiptId, acceptedAt,
      `${receiptId}@example.net`, `cnv_send${String(n).padStart(22, "0")}`));
  }
  for (let i = 0; i < statements.length; i += 100) {
    await testEnv.CATALOG.batch(statements.slice(i, i + 100));
  }
});

describe("what a sender filter costs", () => {
  it("seeds a corpus in which the sender is selective, so the figures mean something", async () => {
    const rare = await cost(RARE.toLowerCase());
    const bulk = await cost(BULK);
    expect(rare.rows).toBe(1);
    expect(bulk.rows).toBe(BUDGETS["messages.page_size"] + 1);
  });

  it("matches case-insensitively, which is what a person means by an address", async () => {
    /*
     * The corpus stores the rare sender uppercased. `envelope_to` is lowercased at ingress and
     * `envelope_from` is not — an asymmetry that predates this — so a filter comparing raw values would
     * answer an empty page to somebody who typed the address correctly.
     */
    expect((await cost(RARE.toLowerCase())).rows).toBe(1);
    expect((await cost(RARE)).rows).toBe(1);
  });

  it("measures the difference the index makes, rather than assuming one", async () => {
    /*
     * **Dropped first, and that is what keeps this honest.** The index ships in a migration now, so it
     * exists when this file runs — a version that measured, then created it with `IF NOT EXISTS`, would take
     * both figures *with* the index and report them as a before and after. The assertions below would still
     * pass, comparing a number to itself.
     *
     * DDL in a test does not roll back with isolated storage, so it is put back at the end of this test and
     * this file is the isolation boundary. `fresh-install.test.ts` records why that has to be a file.
     */
    await testEnv.CATALOG.prepare(`DROP INDEX IF EXISTS ${INDEX}`).run();
    const withoutIndex = { rare: await cost(RARE.toLowerCase()), bulk: await cost(BULK) };
    const planWithout = await planFor(RARE.toLowerCase());

    /*
     * The expression, because `envelope_from` is not normalised in storage. Spelled exactly as the predicate
     * spells it, or the planner cannot use it — which this measurement would report as "an index that does
     * not help" rather than as a predicate that does not match.
     */
    await testEnv.CATALOG.prepare(
      `CREATE INDEX IF NOT EXISTS ${INDEX}
         ON ingress_receipts (org_id, lower(envelope_from), accepted_at, id)`,
    ).run();

    const withIndex = { rare: await cost(RARE.toLowerCase()), bulk: await cost(BULK) };
    const planWith = await planFor(RARE.toLowerCase());

    console.log(
      `MEASURE sender_filter deliveries=${DELIVERIES}\n`
      + `  without index  rare=${withoutIndex.rare.rowsRead} bulk=${withoutIndex.bulk.rowsRead}\n`
      + `  with index     rare=${withIndex.rare.rowsRead} bulk=${withIndex.bulk.rowsRead}\n`
      + `  plan without   ${planWithout.split("\n").join(" | ")}\n`
      + `  plan with      ${planWith.split("\n").join(" | ")}`,
    );

    // The same answers either way — an index that changed a result would be a bug, not an optimisation.
    expect(withIndex.rare.rows).toBe(withoutIndex.rare.rows);
    expect(withIndex.bulk.rows).toBe(withoutIndex.bulk.rows);

    /*
     * The difference, asserted rather than printed. A selective sender is the case an investigation is made
     * of — somebody looking for one correspondent in an archive — and it is the case that was **over the
     * budget** without the index, because the sender's only message is the oldest and a time-ordered scan
     * reaches it last.
     */
    const budget = BUDGETS["authz.list.max_rows_read"];
    expect(withoutIndex.rare.rowsRead).toBeGreaterThan(budget);
    expect(withIndex.rare.rowsRead).toBeLessThan(budget / 10);
    expect(planWithout).toContain("ir_org_accepted");
    expect(planWith).toContain(INDEX);
    // Recorded, so the receipt cannot drift from what the plan actually does.
    expect(withIndex.rare.rowsRead).toBe(BUDGETS["sender.rows_read_indexed"]);
    expect(withoutIndex.rare.rowsRead).toBe(BUDGETS["sender.rows_read_unindexed"]);

    /*
     * And the bulk sender does not regress. An index that made the common case slower to help the rare one
     * would be the wrong trade, and "no difference" is the answer that makes it free.
     */
    expect(withIndex.bulk.rowsRead).toBeLessThanOrEqual(withoutIndex.bulk.rowsRead);
  });
});
