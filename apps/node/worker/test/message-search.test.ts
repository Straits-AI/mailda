import { type Bytes, utf8 } from "@mailda/evidence";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { messagePageQuery } from "../src/authz-read.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { materialiseReceipt } from "../src/materialise.ts";
import { ftsQuery, indexMessage } from "../src/search.ts";
import { liveGrantsBySubject, SCOPES_FOR_METADATA } from "../src/supervised.ts";

/**
 * Finding mail by sender and subject, through the query that ships (#107).
 *
 * ## What this asks
 *
 * `messagePageQuery` is imported rather than restated, for the reason `message-page.measure.test.ts` gives:
 * `authz.measure.test.ts` hand-copied the statements it priced and its receipt now describes a query nothing
 * measured. A search test that built its own SQL would assert that FTS5 works, which
 * `docs/receipts/d1-fts5-search.md` already established, and would say nothing about whether *this Node*
 * searches correctly.
 *
 * ## Every positive case has a negative beside it
 *
 * A search predicate is unusually easy to test vacuously: a query that returns the seeded message proves
 * nothing if the predicate is a no-op, because the unfiltered listing returns it too. So the term that must
 * match is always paired with a term that must not, and the authorization cases search for a term that **is**
 * present — a refusal that happens because the word was missing would be the same green tick as a refusal
 * that happens because the reader has no relation.
 */

const testEnv = env as unknown as Env;
const ORG = "org_search";
/** A second organization, because `MATCH` runs before the join that scopes the result. */
const OTHER_ORG = "org_search_other";
const READER = "usr_search_reader";
/** Holds nothing, so authorization can be shown to still apply to a searched page. */
const STRANGER = "usr_search_stranger";
const MAILBOX = "mbx_search";
const OTHER_MAILBOX = "mbx_search_other";
const ADDRESS = "in@search.example";
const OTHER_ADDRESS = "in@other.example";
const AT = "2026-08-20T09:00:00.000Z";

/** The message every positive case looks for. */
const DEMURRAGE = "rcpt_search000000000000000001";
/** A second message, so a search that matched everything would be visible as a failure. */
const INVOICE = "rcpt_search000000000000000002";
/** Headers that cannot be parsed into a message row, so it has no index row either. */
const UNPARSED = "rcpt_search000000000000000003";
/** Belongs to the other organization and contains the same distinctive word as DEMURRAGE. */
const FOREIGN = "rcpt_search000000000000000004";

async function search(term: string | null, who = READER, org = ORG): Promise<string[]> {
  const query = messagePageQuery({
    orgId: org,
    subjects: [who],
    supervised: liveGrantsBySubject(org, who, AT, SCOPES_FOR_METADATA),
    page: { after: null, mailboxId: null, q: term === null ? null : ftsQuery(term) },
    limit: 51,
  });
  const result = await testEnv.CATALOG.prepare(query.sql).bind(...query.params).all<{ id: string }>();
  return result.results.map((row) => row.id);
}

beforeAll(async () => {
  const ctx = createSystemCtx();
  const statements = [];
  const mailbox = (org: string, id: string, address: string) => [
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(id, org, "Enquiries", AT),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), org, address, id, AT),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), org, READER, "mailbox.content.read", "mailbox", id, AT),
  ];
  statements.push(...mailbox(ORG, MAILBOX, ADDRESS), ...mailbox(OTHER_ORG, OTHER_MAILBOX, OTHER_ADDRESS));

  const deliver = (
    org: string, receiptId: string, address: string, subject: string | null, from: string,
  ) => {
    const out = [testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
         blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(receiptId, org, `evt_${receiptId}`, from, address, 18_000,
      `${org}/raw/${receiptId}`, "0".repeat(64), AT)];
    // `subject === null` seeds a receipt with **no message row** — the unparsed case, which therefore has no
    // index row and must be unreachable by search while staying reachable by paging.
    if (subject !== null) {
      const messageId = `msg_${receiptId.slice(5)}`;
      out.push(testEnv.CATALOG.prepare(
        `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
           thread_root_rfc_id, conversation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(messageId, org, "2026-Q3", `${org}/raw/${receiptId}`, "0".repeat(64), 18_000,
        `${receiptId}@example.net`, ctx.id("thr"), subject, from, AT, AT, receiptId, AT,
        `${receiptId}@example.net`, ctx.id("cnv")));
      out.push(indexMessage(testEnv, messageId));
    }
    return out;
  };

  statements.push(
    ...deliver(ORG, DEMURRAGE, ADDRESS, "Demurrage clause on the Hapag booking", "ops@carrier.example"),
    ...deliver(ORG, INVOICE, ADDRESS, "Invoice 4471 attached", "billing@supplier.example"),
    ...deliver(ORG, UNPARSED, ADDRESS, null, "garbled@nowhere.example"),
    ...deliver(OTHER_ORG, FOREIGN, OTHER_ADDRESS, "Demurrage in another org", "ops@elsewhere.example"),
  );
  await testEnv.CATALOG.batch(statements);
});

describe("searching the message listing", () => {
  it("returns every seeded message when nothing is searched, so a filter can be seen to filter", async () => {
    /*
     * Anti-vacuity, and the baseline every case below is measured against. All three of this org's receipts —
     * including the unparsed one, which has no message row — must be reachable without a term. If this fails,
     * every "search found nothing" below would be true of a broken fixture.
     */
    expect((await search(null)).sort()).toEqual([DEMURRAGE, INVOICE, UNPARSED].sort());
  });

  it("finds a message by a word in its subject, and does not find the other one", async () => {
    expect(await search("demurrage")).toEqual([DEMURRAGE]);
    // The pair that makes the assertion above mean something: the predicate excludes as well as includes.
    expect(await search("invoice")).toEqual([INVOICE]);
  });

  it("finds nothing for a word in no subject, rather than falling back to the whole listing", async () => {
    /*
     * The failure this guards is a dropped predicate. A `q` that got lost on the way to the SQL would answer
     * the full listing, which looks like a working search right up until somebody notices it always works.
     */
    expect(await search("kumquat")).toEqual([]);
  });

  it("requires every word, so a second term narrows", async () => {
    expect(await search("demurrage hapag")).toEqual([DEMURRAGE]);
    // `hapag` is present and `invoice` is not, so an OR would return one row here and AND returns none.
    expect(await search("demurrage invoice")).toEqual([]);
  });

  it("matches a part-typed last word as a prefix", async () => {
    expect(await search("demur")).toEqual([DEMURRAGE]);
    // Not a substring match: FTS5 prefixes are anchored at the token start, and claiming otherwise in the UI
    // would promise a search this index cannot do.
    expect(await search("murrage")).toEqual([]);
  });

  it("finds a message by its sender address, split the way the index tokenizes it", async () => {
    expect(await search("carrier")).toEqual([DEMURRAGE]);
    expect(await search("ops@carrier.example")).toEqual([DEMURRAGE]);
  });

  it("still refuses a reader with no relation, on a term that does match", async () => {
    /*
     * The term is deliberately one that **is** present. A stranger searching for `kumquat` would get an empty
     * page whether or not authorization worked, so that version of this test would pass against a listing
     * with no authorization at all.
     */
    expect(await search("demurrage", STRANGER)).toEqual([]);
  });

  it("does not match across organizations, on a word both organizations' mail contains", async () => {
    /*
     * Both orgs have a message containing "demurrage"; each reader sees only theirs.
     *
     * **This does not prove the index's `org_id` predicate does anything, and it is worth saying so.** The
     * isolation here is achieved by `WHERE r.org_id = ?` on the outer query: the listing only ever considers
     * one org's receipts, so a subquery returning both orgs' message ids would still answer correctly.
     * Checked by deleting `AND org_id = ?` from the shipped statement and re-running this file — all eleven
     * tests still passed.
     *
     * So this case documents the guarantee, and the case below is the one that holds the column. Recorded
     * rather than quietly relied upon, because a comment claiming this test covers that predicate is exactly
     * the defect #103 is about, and writing one here while building the fix for another was the reminder that
     * reading is not how these are found.
     */
    expect(await search("demurrage", READER, ORG)).toEqual([DEMURRAGE]);
    expect(await search("demurrage", READER, OTHER_ORG)).toEqual([FOREIGN]);
  });

  it("holds the whole index in one organization's scope, which is what makes the fixture able to fail", async () => {
    /*
     * Not a test of the shipped predicate — behaviour cannot hold that one, see the case above and
     * `test/node/search-scope-world.test.ts`, which guards it lexically because it is the only thing that can.
     *
     * What this establishes is that the **fixture** is capable of catching a cross-organization leak at all:
     * the word under test really is present in two organizations' index rows. Every isolation assertion in
     * this file is worthless if it is not, and a fixture that quietly stopped seeding the second org would
     * make all of them pass for the wrong reason.
     */
    const both = await testEnv.CATALOG.prepare(
      "SELECT count(DISTINCT org_id) AS orgs FROM message_search WHERE message_search MATCH ?",
    ).bind(ftsQuery("demurrage")).first<{ orgs: number }>();
    expect(both?.orgs, "the fixture no longer holds the search word in two organizations").toBe(2);
  });

  it("cannot reach an unparsed message by search, while paging still can", async () => {
    /*
     * A stated consequence rather than a defect, asserted so it stays true deliberately: no message row means
     * no index row, so a term cannot find it. The listing is what keeps such mail reachable, which is why
     * `parse_error` is a column and not a reason to drop a message (§24).
     */
    expect(await search(null)).toContain(UNPARSED);
    expect(await search("garbled")).toEqual([]);
  });
});

describe("keeping the index and the messages table in agreement", () => {
  const RAW: Bytes = utf8([
    "From: Alice Example <alice@ingest.example>",
    "To: in@search.example",
    "Subject: Bunkering surcharge query",
    "Message-ID: <ingest-1@ingest.example>",
    "Date: Mon, 3 Aug 2026 12:00:00 +0000",
    "",
    "body",
  ].join("\r\n"));

  async function accept(id: string): Promise<string> {
    const ctx = createSystemCtx();
    await putEvidence(testEnv, `${ORG}/raw/2026-Q3/${id}.eml`, RAW);
    await testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
         blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(id, ORG, `evt_${id}`, "alice@ingest.example", ADDRESS, RAW.length,
      `${ORG}/raw/2026-Q3/${id}.eml`, "0".repeat(64), new Date(ctx.now()).toISOString()).run();
    return id;
  }

  it("indexes a message the ingest path materialises, so real mail is searchable", async () => {
    /*
     * End to end through `materialiseReceipt`, not through `indexMessage` directly. The seam being tested is
     * that the ingest batch *contains* the index write — a search subsystem that works when called by a test
     * and is never called by the pipeline is the whole of what "not built" looks like.
     */
    const ctx = createSystemCtx();
    const receiptId = await accept("rcpt_search_ingest0000000001");
    expect((await materialiseReceipt(testEnv, ctx, receiptId)).status).toBe("created");

    expect(await search("bunkering")).toEqual([receiptId]);
  });

  it("writes one index row per message when the same receipt is materialised twice", async () => {
    /*
     * The orphan case, and the reason `indexMessage` is an `INSERT … SELECT` rather than bound values.
     * Delivery is at-least-once, `INSERT OR IGNORE` absorbs the repeat against `msg_by_receipt`, and a fresh
     * `msg_…` id is minted every time — so an index write with its own copy of the values would add a row
     * pointing at an id that belongs to no message, which no message deletion can ever remove.
     */
    const ctx = createSystemCtx();
    const receiptId = await accept("rcpt_search_ingest0000000002");
    await materialiseReceipt(testEnv, ctx, receiptId);
    await materialiseReceipt(testEnv, ctx, receiptId);

    const rows = await testEnv.CATALOG.prepare(
      `SELECT count(*) AS n FROM message_search
        WHERE message_id = (SELECT id FROM messages WHERE ingress_receipt_id = ?)`,
    ).bind(receiptId).first<{ n: number }>();
    expect(rows?.n).toBe(1);

    // And nothing in the index points at a message that does not exist.
    const orphans = await testEnv.CATALOG.prepare(
      `SELECT count(*) AS n FROM message_search s
        WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = s.message_id)`,
    ).first<{ n: number }>();
    expect(orphans?.n, "the index holds rows for messages that do not exist").toBe(0);
  });
});
