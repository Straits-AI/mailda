import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { messagePageQuery } from "../src/authz-read.ts";
import { liveGrantsBySubject, SCOPES_FOR_CONTENT, SCOPES_FOR_METADATA } from "../src/supervised.ts";

/**
 * What `mailbox.metadata.read` actually gets you from the message listing.
 *
 * ## Why this file exists
 *
 * `mailbox.metadata.read` is a real, grantable relation. `access.ts` catalogs it as conferred by an admin
 * grant, `mayReadMetadata` accepts it, the queue honours it, and the access UI advertises it in these words:
 *
 * > See that mail exists — senders, subjects, when. Not the message itself.
 *
 * `listMessages`' own header says the same thing — *"the columns returned are subject line, sender address
 * and size, which is what `mailbox.metadata.read` covers"*.
 *
 * `messagePageQuery`'s standing-relation arm **read** `AND relation = 'mailbox.content.read'` — one
 * relation, spelled once, inside a SQL string where no type could reach it. So the question this file asks
 * is whether the relation the product sells as *"see that mail exists"* returns any mail, and it is asked
 * of the shipped builder rather than of a copy. It failed when written (#106) and now passes; it stays
 * because the predicate is one edit away from being narrowed again.
 *
 * It is the shape this repository keeps finding — a comment asserting a property the code below it does not
 * have (#103) — so it is asked rather than assumed, and it is asked **before** search is built on top of this
 * listing. [#105](https://github.com/Straits-AI/mailda/issues/105) decides that metadata search authorizes on
 * `metadata.read`; a metadata search built on a listing that ignores `metadata.read` would inherit the hole
 * and add a second surface to it.
 */

const testEnv = env as unknown as Env;
const ORG = "org_metaread";
/** Holds `mailbox.metadata.read` and nothing else — the relation under examination. */
const METADATA_ONLY = "usr_metaread_only";
/** Holds `mailbox.content.read`, as the control. Without this the test below cannot fail. */
const CONTENT_READER = "usr_metaread_control";
/** Holds no relation at all, so "empty" is shown to be a real answer this query can give. */
const STRANGER = "usr_metaread_stranger";
const MAILBOX = "mbx_metaread";
const ADDRESS = "in@metaread.example";
const AT = "2026-08-20T09:00:00.000Z";

async function pageFor(subject: string): Promise<string[]> {
  const query = messagePageQuery({
    // Unwindowed here, so the clock is never read — a fixed value keeps the query byte-stable across runs.
    nowIso: "2026-08-01T00:00:00.000Z",
    sponsor: { sql: "", params: [] }, // a human reader has no sponsor ceiling
    orgId: ORG,
    subjects: [subject],
    supervised: {
      metadata: liveGrantsBySubject(ORG, subject, AT, SCOPES_FOR_METADATA),
      content: liveGrantsBySubject(ORG, subject, AT, SCOPES_FOR_CONTENT),
    },
    page: { after: null, mailboxId: null, q: null , since: null, until: null, from: null },
    limit: 51,
  });
  const result = await testEnv.CATALOG.prepare(query.sql).bind(...query.params).all<{ id: string }>();
  return result.results.map((row) => row.id);
}

beforeAll(async () => {
  const ctx = createSystemCtx();
  const tuple = (subject: string, relation: string) => testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subject, relation, "mailbox", MAILBOX, AT);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Enquiries", AT),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, AT),
    tuple(METADATA_ONLY, "mailbox.metadata.read"),
    tuple(CONTENT_READER, "mailbox.content.read"),
    testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
         blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind("rcpt_metaread0000000000000000", ORG, "evt_metaread_1", "supplier@example.net", ADDRESS,
      18_000, `${ORG}/raw/rcpt_metaread0000000000000000`, "0".repeat(64), AT),
  ]);
});

describe("the relation sold as “see that mail exists” against the listing that shows it", () => {
  it("seeds a message the control reader can see, so an empty page below means something", async () => {
    /*
     * Anti-vacuity, and this is the assertion the whole file rests on. If the seed failed, if the address
     * join did not match, or if the org were wrong, then *every* reader would get an empty page and the test
     * would "prove" a defect that is really a broken fixture. The control must see the mail.
     */
    expect(await pageFor(CONTENT_READER), "the control holder of mailbox.content.read sees no mail — "
      + "the fixture is broken, not the product").toEqual(["rcpt_metaread0000000000000000"]);
  });

  it("shows an empty page to a stranger, so the query can distinguish readers at all", async () => {
    // The other half of the control: "empty" must be an answer this query gives for the right reason.
    expect(await pageFor(STRANGER)).toEqual([]);
  });

  it("returns mail to a holder of mailbox.metadata.read", async () => {
    /*
     * The claim under test, stated positively so a failure reads as the defect it is.
     *
     * The columns this listing returns are `subject`, `from_addr`, `raw_bytes` and the timestamps — precisely
     * *"senders, subjects, when"*, and precisely what the header says `mailbox.metadata.read` covers. If this
     * fails, the product grants a relation, describes it in the interface, accepts it in `mayReadMetadata`,
     * and then shows the person who holds it an inbox indistinguishable from an empty mailbox.
     */
    expect(await pageFor(METADATA_ONLY), "mailbox.metadata.read returns no mail from the message listing")
      .toEqual(["rcpt_metaread0000000000000000"]);
  });
});
