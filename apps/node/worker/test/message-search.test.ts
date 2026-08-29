import { type Bytes, utf8 } from "@mailda/evidence";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { messagePageQuery } from "../src/authz-read.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { materialiseReceipt } from "../src/materialise.ts";
import {
  BODY_INDEX_LEASE_MS, bodyIndexState, claimBodyIndexBatch, failedBodyIndex, ftsQuery, indexBody,
  indexMessage,
  repairBodyIndex, settleBodyIndex,
} from "../src/search.ts";
import { backfillBodyIndex } from "../src/search-backfill.ts";
import { indexableText, wordsFromHtml } from "../src/search-body.ts";
import { liveGrantsBySubject, SCOPES_FOR_CONTENT, SCOPES_FOR_METADATA } from "../src/supervised.ts";

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
/** Holds `mailbox.metadata.read` only — may search subjects, must not search bodies (#107 L2). */
const METADATA_ONLY = "usr_search_metadata_only";
/** Holds no standing relation and a supervised grant of scope `metadata` only. */
const SUPERVISED_METADATA = "usr_search_sup_metadata";
/** Holds no standing relation and a supervised grant of scope `content`. */
const SUPERVISED_CONTENT = "usr_search_sup_content";
/** Holds **both** grants on one mailbox, which is the case that can defeat the union's deduplication. */
const SUPERVISED_BOTH = "usr_search_sup_both";
/**
 * Standing `content.read` **and** a supervised grant of scope `metadata`.
 *
 * The attribution cell nothing covered: the standing relation authorizes a body match, and the only live
 * grant is one that could not have.
 */
const STANDING_PLUS_META_GRANT = "usr_search_standing_meta";
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
    sponsor: { sql: "", params: [] }, // a human reader has no sponsor ceiling
    orgId: org,
    subjects: [who],
    supervised: {
      metadata: liveGrantsBySubject(org, who, AT, SCOPES_FOR_METADATA),
      content: liveGrantsBySubject(org, who, AT, SCOPES_FOR_CONTENT),
    },
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
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), org, METADATA_ONLY, "mailbox.metadata.read", "mailbox", id, AT),
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
      /*
       * **`cabotage` appears in no subject anywhere**, so a match on it can only have come from the body
       * index. The first fixture used `bunkering`, which is also a word in the ingest test's subject further
       * down this file — so a metadata-only reader legitimately matched it through the *subject* arm and the
       * authorization test appeared to fail. The corpus was ambiguous, not the predicate.
       *
       * `DEMURRAGE`'s body additionally repeats the word in its own subject, which is what makes the
       * deduplication case below reachable: one message, both arms, one row.
       */
      out.push(indexBody(
        testEnv, messageId,
        receiptId === DEMURRAGE
          ? "cabotage rules disputed, and the demurrage position restated"
          : `cabotage rules disputed for ${receiptId}`,
        0,
      ));
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

  /*
   * Two supervised grants on the same mailbox, differing only in scope. §7's grants are the *other* way to
   * reach mail, and the whole question below is whether the search arms tell them apart the way the standing
   * relations do.
   */
  const grant = (subject: string, scope: string) => testEnv.CATALOG.prepare(
    `INSERT INTO supervised_grants
       (id, org_id, subject_id, mailbox_id, scope, matter_id, requested_at, expires_at, granted_at)
     VALUES (?,?,?,?,?,NULL,?,?,?)`,
  ).bind(ctx.id("sgr"), ORG, subject, MAILBOX, scope, AT, "2027-01-01T00:00:00.000Z", AT);
  await testEnv.CATALOG.batch([
    grant(SUPERVISED_METADATA, "metadata"),
    grant(SUPERVISED_CONTENT, "content"),
    grant(SUPERVISED_BOTH, "metadata"),
    grant(SUPERVISED_BOTH, "content"),
    grant(STANDING_PLUS_META_GRANT, "metadata"),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, STANDING_PLUS_META_GRANT, "mailbox.content.read", "mailbox", MAILBOX, AT),
  ]);
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

    // `bunkering` is this message's *subject*. No body in the fixture carries it, so this is the
    // metadata arm answering — which is what "real mail is searchable" needs to mean at minimum.
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

describe("searching message bodies, which is a stronger authority than searching subjects", () => {
  it("finds a message by a word that appears only in its body", async () => {
    /*
     * The premise for everything below: the body arm works at all, and the word really is body-only. The
     * second assertion is what makes the first mean something — if `bunkering` were in a subject, every case
     * in this block would pass through the metadata arm and prove nothing about bodies.
     */
    expect((await search("cabotage")).sort()).toEqual([DEMURRAGE, INVOICE].sort());
    const inSubjects = await testEnv.CATALOG.prepare(
      "SELECT count(*) AS n FROM message_search WHERE message_search MATCH ?",
    ).bind(ftsQuery("cabotage")).first<{ n: number }>();
    expect(inSubjects?.n, "the word is in a subject, so the body arm is not what answered").toBe(0);
  });

  it("refuses a body search to a holder of mailbox.metadata.read, on a word that does match", async () => {
    /*
     * **The authorization boundary this layer exists to draw.** `metadata.read` is sold as "See that mail
     * exists — senders, subjects, when. Not the message itself", and answering *"the word bunkering occurs in
     * message X"* discloses the message itself a word at a time.
     *
     * The term is deliberately one that **does** match for a `content.read` holder — asserted directly above
     * this line — so a refusal here cannot be the empty result any nonsense word would produce.
     */
    expect(await search("cabotage", METADATA_ONLY)).toEqual([]);
  });

  it("still lets that reader search subjects, so the refusal is scoped and not a revocation", async () => {
    /*
     * The other half. A metadata reader who could search nothing would also pass the assertion above, and
     * that would be #106 all over again — a relation that grants less than it says.
     */
    expect(await search("demurrage", METADATA_ONLY)).toEqual([DEMURRAGE]);
  });

  it("returns a message matching in both indexes exactly once", async () => {
    /*
     * `UNION` rather than `UNION ALL`. `demurrage` is in DEMURRAGE's subject *and* in its body, so it matches
     * in both arms — and a duplicated row in a result list is the kind of defect that reads as a rendering
     * bug for a week. Checked by length as well as by value, because `toEqual` on a two-element array with
     * both elements equal would not obviously read as a duplicate.
     */
    const both = await search("demurrage");
    expect(both).toEqual([DEMURRAGE]);
    expect(both.length, "a message matching both indexes came back twice").toBe(1);
  });

  it("cannot match a query whose words are split across subject and body", async () => {
    /*
     * **A real limitation, asserted so it stays deliberate.** FTS5 requires every term of a query to appear in
     * the same indexed document, and the subject and the body are two documents in two tables. So `hapag` (in
     * DEMURRAGE's subject) and `cabotage` (in its body) match nothing together, even though both are true of
     * that one message.
     *
     * Fixing it means one index holding subject and body together — which is exactly what the authorization
     * split forbids, because then a `metadata.read` holder's subject search would match body words. The
     * limitation is the price of the boundary, and it is written into the docs rather than discovered by a
     * user whose search mysteriously finds nothing.
     */
    expect(await search("hapag cabotage")).toEqual([]);
    // Each half alone finds it, which is what makes the line above a limitation rather than a broken fixture.
    expect(await search("hapag")).toEqual([DEMURRAGE]);
    expect(await search("cabotage")).toContain(DEMURRAGE);
  });

  it("has no content shadow table, which is what content='' looks like in the schema", async () => {
    /*
     * The cheapest available proof that the contentless option is in force, and a falsifiable one: a
     * content-bearing FTS5 table gets a `_content` shadow table to store documents in, and a contentless one
     * does not. `message_search` (subjects, content-bearing) has six tables; this has five.
     *
     * Worth asserting separately from the `SELECT body IS NULL` check below, because the two fail in
     * different ways. A future edit that dropped `content=''` would make `body` readable *and* create this
     * table — and if somebody ever "fixed" the null by populating a column, this assertion is the one that
     * would still catch the storage.
     */
    const content = await testEnv.CATALOG.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE name = 'message_body_search_content'",
    ).first<{ n: number }>();
    expect(content?.n, "the body index has a content table — content='' is not in force and a D1 dump "
      + "now contains message bodies").toBe(0);

    // The control: the *metadata* index does have one, so the assertion above is discriminating rather than
    // just true of every name it is handed.
    const metadata = await testEnv.CATALOG.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE name = 'message_search_content'",
    ).first<{ n: number }>();
    expect(metadata?.n, "the metadata index lost its content table — this test can no longer tell the two "
      + "storage forms apart").toBe(1);
  });

  it("cannot read body text back out of the index, which is what the contentless form is for", async () => {
    /*
     * ADR 28's amended claim, asserted rather than described. The index discloses *which words occur in which
     * message*; it must not disclose the message. If this ever returns text, the migration lost `content=''`
     * and a D1 dump now contains everybody's mail.
     */
    const row = await testEnv.CATALOG.prepare("SELECT body FROM message_body_search LIMIT 1")
      .first<{ body: string | null }>();
    expect(row, "the body index is empty — the assertion below would hold vacuously").not.toBeNull();
    expect(row?.body, "the body index is storing message text").toBeNull();
  });
});

describe("what reaches the body index", () => {
  it("indexes plain-text mail, which is the ordinary case and was the one nothing covered", async () => {
    /*
     * **Added because mutation testing found it missing.** Every case in this block exercised HTML, so
     * inverting `if (extracted.text !== null)` — or deleting the guard — left the whole suite green while
     * making text-only mail silently unsearchable by its contents. The most common shape of business mail,
     * and the tests had nothing to say about it.
     *
     * Recorded rather than quietly fixed: this is the third vacuity in this ticket that reading did not find
     * and `scripts/mutants.mjs` did, which is the argument AGENTS.md principle 2b makes.
     */
    const plain = new TextEncoder().encode([
      "From: a@b.example", "To: in@search.example", "Subject: Plain",
      "Content-Type: text/plain; charset=utf-8", "",
      "The demurrage clause was invoked on tuesday.",
    ].join("\r\n"));
    const body = await indexableText(plain);
    expect(body.kind, "a text/plain body produced nothing to index").toBe("text");
    const words = body.kind === "text" ? body.text.toLowerCase() : "";
    expect(words).toContain("demurrage");
    expect(words).toContain("tuesday");
  });

  it("indexes both parts when a message carries text and HTML", async () => {
    /*
     * The pair that makes the two cases above distinguishable from each other. A multipart/alternative message
     * is supposed to say the same thing twice and usually does — but "supposed to" does a lot of work in a
     * mail system, and a sender whose HTML says more than their text would otherwise lose the extra words.
     */
    const both = new TextEncoder().encode([
      "From: a@b.example", "To: in@search.example", "Subject: Both",
      'Content-Type: multipart/alternative; boundary="x"', "",
      "--x", "Content-Type: text/plain; charset=utf-8", "", "plaintextonlyword", "",
      "--x", "Content-Type: text/html; charset=utf-8", "", "<p>htmlonlyword</p>", "",
      "--x--", "",
    ].join("\r\n"));
    const body = await indexableText(both);
    const words = body.kind === "text" ? body.text.toLowerCase() : "";
    expect(words).toContain("plaintextonlyword");
    expect(words).toContain("htmlonlyword");
  });

  it("indexes HTML-only mail, which is the case that would silently never match", async () => {
    /*
     * A great deal of real mail has no plain-text part. Indexing only `extracted.text` would make it
     * unsearchable while everything looked fine — the failure shape this repository keeps finding.
     */
    const html = new TextEncoder().encode([
      "From: a@b.example", "To: in@search.example", "Subject: HTML only",
      "Content-Type: text/html; charset=utf-8", "",
      "<html><head><style>.x{font-family:sans-serif}</style></head>",
      "<body><p>The&nbsp;demurrage clause was <b>invoked</b></p></body></html>",
    ].join("\r\n"));
    const body = await indexableText(html);
    expect(body.kind).toBe("text");
    const words = body.kind === "text" ? body.text.toLowerCase() : "";
    expect(words).toContain("demurrage");
    expect(words).toContain("invoked");
  });

  it("keeps stylesheet and script contents out, so they do not become words", () => {
    /*
     * Not tidiness. A mail template's CSS is thousands of tokens, and bm25 ranking is computed from term
     * frequency across the index — so indexing `sans-serif` once per HTML message degrades ranking for every
     * real word as well as wasting space.
     */
    const words = wordsFromHtml(
      "<style>.a{color:#fff}</style><script>var x=1</script><p>actual prose</p>",
    );
    expect(words).toBe("actual prose");
  });

  it("makes a tag a word boundary rather than deleting it", () => {
    // `a<br>b` is two words. Deleting the tag would make it one, and neither would then match.
    expect(wordsFromHtml("<p>alpha</p><p>beta</p>")).toBe("alpha beta");
    expect(wordsFromHtml("alpha<br>beta")).toBe("alpha beta");
  });

  it("returns null for a message with no body at all, so no empty row is written", async () => {
    /*
     * An empty index row can never match, takes space, and would still be counted as indexed — which would
     * make the backfill's remaining-work figure a lie.
     */
    const headersOnly = new TextEncoder().encode(
      "From: a@b.example\r\nTo: in@search.example\r\nSubject: nothing\r\n\r\n",
    );
    // `empty`, not `unparseable`: the parser read it fine and there is no body. The distinction is the
    // whole point of the state machine — one is ordinary and the other wants an operator's attention.
    expect((await indexableText(headersOnly)).kind).toBe("empty");
  });
});

describe("a supervised grant reaches exactly as far as its scope, in search too", () => {
  /*
   * ## The hole this block was written to prove
   *
   * The standing relations are split correctly: the subject arm accepts `metadata.read` or `content.read`,
   * the body arm accepts `content.read` alone. **The supervised arm was not split with them.**
   * `listMessages` builds one grant subquery on `SCOPES_FOR_METADATA` — which is `["metadata", "content"]` —
   * and both arms carry the same `sg.grant_id IS NOT NULL`.
   *
   * So a grant of scope `metadata` reached the body index. It never returns body text, but it answers
   * *"does this word occur in any message"* — a membership oracle over content, one query at a time:
   * bankruptcy, termination, an account number, a person's name. Repeated, it identifies the message and
   * hands over its subject and sender. That is precisely the line `BODY_SEARCH_RELATIONS` exists to draw,
   * crossed by the other of the two ways to authorize a read.
   *
   * Found by a third-party audit, not by this suite. Worth recording why: every test here used *standing
   * relations*, so the arms looked correctly separated. The supervised path is the second authorization
   * mechanism and nothing exercised it against the second index.
   */
  it("gives a content-scoped grant the body index, which is the control", async () => {
    // First, so that a refusal below cannot be the empty result any unreachable mailbox would produce.
    expect((await search("cabotage", SUPERVISED_CONTENT)).sort())
      .toEqual([DEMURRAGE, INVOICE].sort());
  });

  it("gives a metadata-scoped grant the subject index", async () => {
    // The other control: this grant works. A refusal below is therefore about the *arm*, not the grant.
    expect(await search("demurrage", SUPERVISED_METADATA)).toEqual([DEMURRAGE]);
  });

  it("refuses a metadata-scoped grant the body index", async () => {
    /*
     * The assertion. `cabotage` is body-only — asserted against `message_search` elsewhere in this file — so
     * a result here can only have come through the body arm, which a metadata grant must not reach.
     */
    expect(
      await search("cabotage", SUPERVISED_METADATA),
      "a supervised grant of scope metadata reached the body index: it can now ask whether any word occurs "
      + "in a message body, one query at a time",
    ).toEqual([]);
  });

  it("returns one row for a message matching both arms under two grants at once", async () => {
    /*
     * The case that can defeat `UNION`'s deduplication, and it is not hypothetical — two rows in
     * `supervised_grants` for one person and one mailbox is representable and legitimate.
     *
     * `liveGrantsBySubject` names `MIN(id)` per mailbox, so the metadata-scoped subquery (whose scope list
     * is `["metadata", "content"]`) and the content-scoped one can pick **different** grants. Both arms then
     * match `demurrage` — it is in DEMURRAGE's subject and in its body — and the rows differ only in the
     * attribution column, which `UNION` treats as two distinct rows and the response then strips. The reader
     * sees the same message twice for no visible reason.
     *
     * `COALESCE(sgc.grant_id, sgm.grant_id)` is what makes the two arms agree, and this is the assertion
     * that holds it. Checked by length as well as value, because `toEqual` on `[x, x]` does not obviously
     * read as a duplicate.
     */
    const rows = await search("demurrage", SUPERVISED_BOTH);
    expect(rows, "a message matching both arms came back twice under two live grants").toEqual([DEMURRAGE]);
    expect(rows.length).toBe(1);
  });

  it("attributes a body match to no grant when only a standing relation could authorize it", async () => {
    /*
     * ## The attribution cell the first fix left open
     *
     * This reader holds standing `content.read` **and** a supervised grant of scope `metadata`. A body-only
     * search is authorized — by the standing relation — and the metadata grant could not have authorized it.
     *
     * `COALESCE(sgc.grant_id, sgm.grant_id)` picks `sgm` here, because there is no content grant. So the row
     * comes back attributed to a metadata-scoped grant for a **body** disclosure, and `listMessages` appends
     * a `supervised.query` entry naming a grant that did not and could not permit what was disclosed.
     *
     * That is not a read-authority defect — nothing was disclosed that should not have been. It is an
     * **audit-integrity** defect, which is worse in the one way that matters for this product: §7's trail is
     * the artifact an investigation relies on, and an entry naming the wrong authority is a false statement
     * in it. `docs/supervised-access.md` already says the trail over-records deliberately; over-recording a
     * reader who could have read anyway is a spare line, and attributing a disclosure to a grant that could
     * not have made it is a different thing.
     *
     * Found by the same external audit, in the matrix cell the first round of fixtures did not combine.
     */
    const query = messagePageQuery({
    sponsor: { sql: "", params: [] }, // a human reader has no sponsor ceiling
      orgId: ORG,
      subjects: [STANDING_PLUS_META_GRANT],
      supervised: {
        metadata: liveGrantsBySubject(ORG, STANDING_PLUS_META_GRANT, AT, SCOPES_FOR_METADATA),
        content: liveGrantsBySubject(ORG, STANDING_PLUS_META_GRANT, AT, SCOPES_FOR_CONTENT),
      },
      page: { after: null, mailboxId: null, q: ftsQuery("cabotage") },
      limit: 51,
    });
    const rows = await testEnv.CATALOG.prepare(query.sql).bind(...query.params)
      .all<{ id: string; supervised_grant_id: string | null }>();

    // The read itself is fine: the standing relation authorizes it.
    expect(rows.results.length, "the standing content relation no longer reaches the body index")
      .toBeGreaterThan(0);
    for (const row of rows.results) {
      expect(
        row.supervised_grant_id,
        "a body match is attributed to a supervised grant of scope metadata, which could not have authorized "
        + "it — the audit trail would name the wrong authority for a content disclosure",
      ).toBeNull();
    }
  });
});

describe("a failed body read is retried; a failed parse is not", () => {
  /*
   * The behaviour the state machine exists for, driven through `backfillBodyIndex` rather than through the
   * transition functions — `test/body-index-state.test.ts` covers the boundary arithmetic, and this covers
   * whether the pass actually classifies what it meets.
   *
   * The distinction is made by **where** the failure comes from rather than by inspecting an error string.
   * Reaching the evidence is R2 and the vault: recoverable. Parsing what came back is deterministic — the
   * same bytes fail the same way next minute, so retrying spends the pass on a message that cannot succeed
   * while the mail behind it waits.
   */
  const stateOf = async (messageId: string) => testEnv.CATALOG.prepare(
    `SELECT body_index_state AS state, body_index_attempts AS attempts, body_index_error AS error,
            body_index_next_attempt_at AS next
       FROM messages WHERE id = ?`,
  ).bind(messageId).first<{ state: string; attempts: number; error: string | null; next: string | null }>();

  it("marks a message whose evidence cannot be read as retryable, with a time to try again", async () => {
    /*
     * The blob key points at nothing, so `getEvidence` throws — which is the transient class. Before 0044
     * this message was settled and never looked at again.
     */
    const ctx = createSystemCtx();
    const receiptId = "rcpt_missing_evidence00000001";
    const messageId = "msg_missing_evidence000000001";
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(
        `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
           blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(receiptId, ORG, `evt_${receiptId}`, "x@y.example", ADDRESS, 10,
        `${ORG}/raw/does-not-exist`, "0".repeat(64), AT),
      testEnv.CATALOG.prepare(
        `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
           thread_root_rfc_id, conversation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(messageId, ORG, "2026-Q3", `${ORG}/raw/does-not-exist`, "0".repeat(64), 10,
        `${receiptId}@example.net`, ctx.id("thr"), "Missing evidence", "x@y.example", AT, AT, receiptId, AT,
        `${receiptId}@example.net`, ctx.id("cnv")),
    ]);

    await backfillBodyIndex(testEnv, ctx);
    const after = await stateOf(messageId);
    expect(after?.state, "an unreadable body was not marked retryable").toBe("retryable");
    expect(after?.attempts).toBe(1);
    expect(after?.error, "no reason was recorded, so an operator cannot tell why").not.toBeNull();
    expect(after?.next, "no next attempt was scheduled, so nothing will retry it").not.toBeNull();
  });

  it("does not pick the same message up again before its next attempt is due", async () => {
    /*
     * The half that makes the backoff real. Without the `<=` on `body_index_next_attempt_at`, a failing
     * message is retried on the very next pass — which is the every-minute pass spending its budget on the
     * same object while the archive waits.
     */
    const ctx = createSystemCtx();
    const before = await stateOf("msg_missing_evidence000000001");
    await backfillBodyIndex(testEnv, ctx);
    const after = await stateOf("msg_missing_evidence000000001");
    expect(after?.attempts, "the message was retried before its scheduled time").toBe(before?.attempts);
  });

  it("counts the states apart, so doctor can report failures separately from work remaining", async () => {
    const counts = await bodyIndexState(testEnv);
    expect(counts.retryable, "the failing message is not counted as retryable").toBeGreaterThan(0);
    // And the ones that succeeded are not lumped in with it.
    expect(counts.indexed, "nothing is recorded as indexed, so the fixture never worked").toBeGreaterThan(0);
  });

  it("lists a failure with its reason, and repair puts it back in the queue", async () => {
    /*
     * The operator path, end to end. `doctor` names `mailda search repair`; before 0044 the only route was
     * clearing a column by hand, which the receipt admitted and which is not a repair path.
     */
    const failed = await failedBodyIndex(testEnv, ORG, 50);
    expect(failed.length, "nothing is listed as failed, so there is nothing to repair").toBeGreaterThan(0);
    expect(failed[0]!.error, "a failure is listed without a reason").not.toBeNull();

    await testEnv.CATALOG.batch(repairBodyIndex(testEnv, ORG, failed.map((row) => row.messageId)));
    const after = await stateOf(failed[0]!.messageId);
    expect(after?.state, "repair did not return the message to the queue").toBe("pending");
    // The counter is reset, so a message that exhausted its attempts gets a full set again rather than being
    // abandoned on the next failure.
    expect(after?.attempts).toBe(0);
    expect(after?.error).toBeNull();
  });

  it("cannot be repaired from another organization", async () => {
    // The `org_id` in the predicate is what makes a leaked id inert rather than merely unlikely.
    const ctx = createSystemCtx();
    await backfillBodyIndex(testEnv, ctx);
    const before = await stateOf("msg_missing_evidence000000001");
    await testEnv.CATALOG.batch(repairBodyIndex(testEnv, OTHER_ORG, ["msg_missing_evidence000000001"]));
    const after = await stateOf("msg_missing_evidence000000001");
    expect(after?.state, "another organization repaired this message").toBe(before?.state);
  });
});

describe("the body index and the state column cannot disagree (audit P1-3)", () => {
  /*
   * Two defects, both about the pass that fills the body index rather than about the index itself.
   */
  it("removes a repaired message from the index, so the state is not a claim the index contradicts", async () => {
    /*
     * `repairBodyIndex` set the state back to `pending` and left the index row in place. Its comment argued
     * that was safe because `indexBody`'s `INSERT OR REPLACE` overwrites on the next pass — which is true
     * **only when the next pass finds text**. A re-parse that settles `empty` or `unindexable` runs no
     * `indexBody` at all, so the old text survives for ever: `bodyIndexState` reports a message that was
     * never indexed, and searching its body returns it.
     *
     * Repair is also not restricted to failed messages — the statement filters on `org_id` and `id` and
     * nothing else — so this is reachable by repairing anything.
     */
    const messageId = "msg_repairstale00000000000001";
    await seedRepairable(messageId, "cabotage");

    // The control: the term is really in the index, so the absence below is the repair and not a bad fixture.
    expect(await bodySearchFinds("cabotage"), "the fixture never indexed anything").toContain(messageId);

    await testEnv.CATALOG.batch(repairBodyIndex(testEnv, ORG, [messageId]));
    const state = await testEnv.CATALOG.prepare("SELECT body_index_state AS s FROM messages WHERE id = ?")
      .bind(messageId).first<{ s: string }>();
    expect(state?.s, "repair did not reset the state").toBe("pending");
    expect(
      await bodySearchFinds("cabotage"),
      "the state column says this message was never indexed and the index still answers for it",
    ).not.toContain(messageId);
  });

  it("skips a message another pass is holding, and picks it up once the lease lapses", async () => {
    /*
     * The deterministic half. The concurrent case below reproduces the real interleaving and does so reliably
     * in this environment, but it rests on scheduling — so the lease's two properties are also asserted
     * against a claim held by hand: a live lease is skipped, and a lapsed one is not.
     *
     * The second half is what stops a lease being a deadlock. A pass that crashes or is evicted never clears
     * its claim, so without expiry those rows would be parked for ever and the backlog would never empty.
     */
    const messageId = "msg_leaseheld0000000000000001";
    await seedRepairable(messageId, null);
    const held = async (until: string) => {
      await testEnv.CATALOG.prepare(
        "UPDATE messages SET body_index_lease_until = ? WHERE id = ?",
      ).bind(until, messageId).run();
    };

    /*
     * Asserted on **this message's** claim counter rather than on the pass's return value: other cases in this
     * file leave messages due, so the count is not a statement about the one message under test. A test that
     * read the total would pass or fail depending on what ran before it.
     */
    const claims = async () => Number((await testEnv.CATALOG.prepare(
      "SELECT body_index_attempt_version AS v FROM messages WHERE id = ?",
    ).bind(messageId).first<{ v: number }>())?.v ?? -1);

    await held("2099-01-01T00:00:00.000Z");
    const before = await claims();
    await backfillBodyIndex(testEnv, createSystemCtx());
    expect(await claims(), "a pass took a message another pass is holding").toBe(before);

    await held("2000-01-01T00:00:00.000Z");
    await backfillBodyIndex(testEnv, createSystemCtx());
    expect(
      await claims(),
      "a lapsed lease parked the message for ever, so a crashed pass would stall the backlog",
    ).toBe(before + 1);
  });

  it("clears the lease on repair, so a repaired message does not wait out somebody else's claim", async () => {
    /*
     * Repair means "try this again now". A message repaired while a pass held a claim on it would otherwise
     * sit unselectable until that claim lapsed — up to `BODY_INDEX_LEASE_MS` of doing nothing, for an operator
     * who has just asked for the opposite. The reachable version is the ordinary one: the pass that failed
     * this message is often the one still holding it.
     */
    const messageId = "msg_repairleased00000000001";
    await seedRepairable(messageId, null);
    await testEnv.CATALOG.prepare(
      "UPDATE messages SET body_index_lease_until = ? WHERE id = ?",
    ).bind("2099-01-01T00:00:00.000Z", messageId).run();

    await testEnv.CATALOG.batch(repairBodyIndex(testEnv, ORG, [messageId]));

    const lease = await testEnv.CATALOG.prepare(
      "SELECT body_index_lease_until AS until FROM messages WHERE id = ?",
    ).bind(messageId).first<{ until: string | null }>();
    expect(lease?.until, "repair left a live claim on the message it just queued").toBeNull();

    // And the claim actually reaches it, which is what "cleared" has to mean.
    const claimed = await claimBodyIndexBatch(testEnv, AT, 50)
      .all<{ id: string }>();
    expect(claimed.results.map((row) => row.id)).toContain(messageId);
  });

  it("refuses a settlement from a pass whose claim was taken over", async () => {
    /*
     * The compare-and-swap, which is the half a lease cannot do. A lease bounds how long two passes overlap;
     * this is what makes the write correct when the bound is **exceeded** — a slow pass whose lease lapsed,
     * whose message was re-claimed and re-settled by a later pass, must not then overwrite the newer answer.
     *
     * Asserted against `settleBodyIndex` directly, holding the version the first claim returned while the row
     * has moved on. That is exactly the state a lapsed-lease overlap produces, and there is no way to reach it
     * by calling the pass twice, because the second call is what advances the version.
     */
    const messageId = "msg_casstale00000000000000001";
    await seedRepairable(messageId, null);
    const claimed = await claimBodyIndexBatch(testEnv, AT, 5)
      .all<{ id: string; version: number }>();
    const mine = claimed.results.find((row) => row.id === messageId);
    expect(mine, "the claim returned nothing, so there is no version to go stale").toBeDefined();

    /*
     * A later pass claims it again — at an instant past the first lease's expiry, because that is what a lapse
     * is. Claiming at `AT` would find a live lease and skip, which is the *other* property and the reason the
     * first draft of this test asserted nothing: the version never advanced, so the stale settlement was
     * simply the current one.
     */
    const afterLapse = new Date(Date.parse(AT) + BODY_INDEX_LEASE_MS + 1_000).toISOString();
    await claimBodyIndexBatch(testEnv, afterLapse, 5).all();
    await settleBodyIndex(testEnv, messageId, { state: "indexed" }, AT, mine!.version).run();

    const state = await testEnv.CATALOG.prepare("SELECT body_index_state AS s FROM messages WHERE id = ?")
      .bind(messageId).first<{ s: string }>();
    expect(
      state?.s,
      "a pass whose claim had been taken over wrote its stale answer over the newer one",
    ).toBe("pending");

    // The control: the same settlement with the current version does land, so the refusal above is the
    // comparison and not a broken statement.
    const current = await testEnv.CATALOG.prepare(
      "SELECT body_index_attempt_version AS v FROM messages WHERE id = ?",
    ).bind(messageId).first<{ v: number }>();
    await settleBodyIndex(testEnv, messageId, { state: "indexed" }, AT, current!.v).run();
    const after = await testEnv.CATALOG.prepare("SELECT body_index_state AS s FROM messages WHERE id = ?")
      .bind(messageId).first<{ s: string }>();
    expect(after?.s).toBe("indexed");
  });

  it("refuses a stale worker's tokens, not only its state", async () => {
    /*
     * The lease and the compare-and-swap protected `messages.body_index_state` and left the FTS write
     * unconditional, so a stale worker could not record its **answer** and could still write its **tokens**:
     *
     * ```
     *   worker A   claims version 1, becomes slow, lease lapses
     *   worker B   claims version 2, parses, settles `empty`
     *   worker A   returns: INSERT OR REPLACE lands, version-1 state update changes nothing
     *   result     state says `empty`, and body search still matches A's text
     * ```
     *
     * The index and the state column then disagree — the exact disagreement `repairBodyIndex` was changed to
     * prevent from the operator's end, arriving here without anybody asking.
     */
    const messageId = "msg_stalewriter000000000001";
    await seedRepairable(messageId, null);

    const first = await claimBodyIndexBatch(testEnv, AT, 50).all<{ id: string; version: number }>();
    const mine = first.results.find((row) => row.id === messageId);
    expect(mine, "the claim returned nothing, so there is no stale version to hold").toBeDefined();

    // A later pass takes it over and settles it as having no text to index.
    const afterLapse = new Date(Date.parse(AT) + BODY_INDEX_LEASE_MS + 1_000).toISOString();
    const second = await claimBodyIndexBatch(testEnv, afterLapse, 50).all<{ id: string; version: number }>();
    const theirs = second.results.find((row) => row.id === messageId)!;
    await settleBodyIndex(testEnv, messageId, { state: "empty" }, afterLapse, theirs.version).run();

    // The slow worker returns, holding the version it claimed.
    await testEnv.CATALOG.batch([
      indexBody(testEnv, messageId, "cabotage", mine!.version),
      settleBodyIndex(testEnv, messageId, { state: "indexed" }, AT, mine!.version),
    ]);

    const state = await testEnv.CATALOG.prepare("SELECT body_index_state AS s FROM messages WHERE id = ?")
      .bind(messageId).first<{ s: string }>();
    expect(state?.s, "the stale worker overwrote the newer answer").toBe("empty");
    expect(
      await bodySearchFinds("cabotage"),
      "the state column says this message has no body text and the index answers for it anyway",
    ).not.toContain(messageId);
  });

  it("leaves the index row and the state column agreeing on everything it settles", async () => {
    /*
     * The invariant, asserted as a property of the **pass** rather than as a function guarding it.
     *
     * The audit that prompted this asked for a version-gated delete on the `empty` and `unindexable` paths, on
     * the reasoning that a stale worker's tokens could outlive a newer settlement. With the FTS write inside
     * the same batch as the state update and both carrying the claim version, that cannot happen — the two
     * land together or neither does. A delete there would be code implying a lifecycle this product does not
     * have, which is the argument `search-backfill.ts` already makes for not writing `unindexMessage`.
     *
     * So the obligation is enforced by an assertion that **fails the day a path breaks it**. Scoped to what
     * one pass settled rather than to the whole table, because several cases in this file construct states the
     * product cannot reach — a message driven straight from `indexed` to `retryable`, a settlement written
     * with no tokens to prove a compare-and-swap — and a table-wide claim would be measuring those.
     */
    const readable = "msg_agree_ok00000000000001";
    const unreadable = "msg_agree_gone0000000000001";
    await seedRepairable(readable, null);
    await seedRepairable(unreadable, null);
    // One message whose evidence is really there, so the pass has a success to settle as well as a failure.
    // The other's `blob_key` points at nothing, which is the ordinary unreadable case.
    const raw = utf8([
      "From: alice@agree.example",
      "To: in@search.example",
      "Subject: agreement",
      "Message-ID: <agree-1@agree.example>",
      "Date: Mon, 3 Aug 2026 12:00:00 +0000",
      "",
      "cabotage schedules attached",
    ].join("\r\n"));
    await putEvidence(testEnv, `${ORG}/raw/rcpt_${readable.slice(4, 27)}`, raw);

    await backfillBodyIndex(testEnv, createSystemCtx());

    const rows = await testEnv.CATALOG.prepare(
      `SELECT m.id, m.body_index_state AS state,
              EXISTS (SELECT 1 FROM message_body_search b WHERE b.rowid = m.rowid) AS indexed
         FROM messages m WHERE m.id IN (?, ?)`,
    ).bind(readable, unreadable).all<{ id: string; state: string; indexed: number }>();

    expect(rows.results.length, "the pass reached neither message").toBe(2);
    expect(
      rows.results.every((row) => row.state === "pending"),
      "neither message was settled, so agreement is trivial",
    ).toBe(false);

    const disagreeing = rows.results
      .filter((row) => (row.state === "indexed") !== (Number(row.indexed) === 1))
      .map((row) => `${row.id}: state=${row.state} indexed=${Number(row.indexed) === 1}`);
    expect(
      disagreeing,
      "the pass left the body index and the state column disagreeing. Body search answers for a message whose "
      + "state says it holds no text, or the reverse:\n  " + disagreeing.join("\n  "),
    ).toEqual([]);
  });

  it("invalidates an in-flight claim on repair, so an old worker cannot undo the requeue", async () => {
    /*
     * Clearing the lease frees the message for a **new** pass and does nothing about the pass already
     * running. A worker holding the pre-repair version could land afterwards, write its tokens and settle its
     * state, undoing the requeue with an answer computed before the operator asked for it — which is the one
     * thing a repair has to mean.
     */
    const messageId = "msg_repairstale00000000002";
    await seedRepairable(messageId, null);
    const claimed = await claimBodyIndexBatch(testEnv, AT, 50).all<{ id: string; version: number }>();
    const mine = claimed.results.find((row) => row.id === messageId)!;

    await testEnv.CATALOG.batch(repairBodyIndex(testEnv, ORG, [messageId]));

    // The worker that was already running returns.
    await testEnv.CATALOG.batch([
      indexBody(testEnv, messageId, "cabotage", mine.version),
      settleBodyIndex(testEnv, messageId, { state: "indexed" }, AT, mine.version),
    ]);

    const state = await testEnv.CATALOG.prepare("SELECT body_index_state AS s FROM messages WHERE id = ?")
      .bind(messageId).first<{ s: string }>();
    expect(state?.s, "a worker running before the repair settled the message afterwards").toBe("pending");
    expect(
      await bodySearchFinds("cabotage"),
      "a repaired message was re-indexed by the pass that was already failing it",
    ).not.toContain(messageId);
  });

  it("does not hand the same message to two overlapping passes", async () => {
    /*
     * The pass runs from cron every minute and costs, per message, an R2 read plus a vault unwrap plus a MIME
     * parse. A pass that takes longer than a minute overlaps the next one, and the selector had nothing to
     * stop the second claiming the same rows — the state is still `pending` until the first pass's batch
     * commits at the very end.
     *
     * The wasted work is not the defect. `body_index_attempts` is computed as `attempts + 1` from a value read
     * at selection time, so two overlapping passes both write `attempts = 1`: the counter stops advancing, and
     * `BODY_INDEX_MAX_ATTEMPTS` — the bound that exists so a pass cannot spend its whole budget on the same
     * failure for ever — never trips. A permanently failing message would be retried without end while the
     * mail behind it waits.
     */
    const messageId = "msg_leased000000000000000001";
    await seedRepairable(messageId, null);

    const [first, second] = await Promise.all([
      backfillBodyIndex(testEnv, createSystemCtx()),
      backfillBodyIndex(testEnv, createSystemCtx()),
    ]);
    expect(first + second, "neither pass saw the message, so nothing is being asserted").toBeGreaterThan(0);
    expect(
      Math.min(first, second),
      "both passes claimed the same message; each will settle it and one settlement is lost",
    ).toBe(0);
  });
});

/**
 * A message with a body-index state, and optionally an index row, for the two P1-3 cases.
 *
 * `blob_key` points at nothing in R2 when `indexedText` is null — which is the failing-read case the second
 * test needs, and gets it without a fixture that has to be told to fail.
 */
async function seedRepairable(messageId: string, indexedText: string | null): Promise<void> {
  const ctx = createSystemCtx();
  const receiptId = `rcpt_${messageId.slice(4, 27)}`;
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare(
      `INSERT OR IGNORE INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
         raw_bytes, blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(receiptId, ORG, `evt_${receiptId}`, "x@y.example", ADDRESS, 100,
      `${ORG}/raw/${receiptId}`, "0".repeat(64), AT),
    testEnv.CATALOG.prepare(
      `INSERT OR IGNORE INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes,
         rfc_message_id, thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
         thread_root_rfc_id, conversation_id, body_index_state)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(messageId, ORG, "2026-Q3", `${ORG}/raw/${receiptId}`, "0".repeat(64), 100,
      `${receiptId}@example.net`, ctx.id("thr"), "Repairable", "x@y.example", AT, AT, receiptId, AT,
      `${receiptId}@example.net`, ctx.id("cnv"), indexedText === null ? "pending" : "indexed"),
  ]);
  if (indexedText !== null) await indexBody(testEnv, messageId, indexedText, 0).run();
}

/** Which messages the body index answers for a term — the index alone, not the authorized listing. */
async function bodySearchFinds(term: string): Promise<string[]> {
  const rows = await testEnv.CATALOG.prepare(
    `SELECT m.id FROM message_body_search b JOIN messages m ON m.rowid = b.rowid
      WHERE b.message_body_search MATCH ?`,
  ).bind(ftsQuery(term)).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}
