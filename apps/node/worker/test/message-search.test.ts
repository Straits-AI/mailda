import { type Bytes, utf8 } from "@mailda/evidence";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { messagePageQuery } from "../src/authz-read.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { materialiseReceipt } from "../src/materialise.ts";
import { ftsQuery, indexBody, indexMessage } from "../src/search.ts";
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
    const words = await indexableText(plain);
    expect(words, "a text/plain body produced nothing to index").not.toBeNull();
    expect(words!.toLowerCase()).toContain("demurrage");
    expect(words!.toLowerCase()).toContain("tuesday");
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
    const words = await indexableText(both);
    expect(words!.toLowerCase()).toContain("plaintextonlyword");
    expect(words!.toLowerCase()).toContain("htmlonlyword");
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
    const words = await indexableText(html);
    expect(words).not.toBeNull();
    expect(words!.toLowerCase()).toContain("demurrage");
    expect(words!.toLowerCase()).toContain("invoked");
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
    expect(await indexableText(headersOnly)).toBeNull();
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
});
