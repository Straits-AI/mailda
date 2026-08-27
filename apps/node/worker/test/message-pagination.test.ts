import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";
import { MESSAGE_PAGE_PARAMS } from "@mailda/contract/routes";
import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { listMessages } from "../src/authz-read.ts";
import { indexMessage } from "../src/search.ts";
import { hashPassword } from "../src/auth/password.ts";
import { login } from "../src/auth/session.ts";
import { decideApproval } from "../src/approvals.ts";
import { requestSupervisedRead } from "../src/supervised.ts";

/**
 * Reaching mail older than one page (#91).
 *
 * `listMessages` ordered by `accepted_at DESC` and took fifty, with no cursor, no offset and no mailbox
 * filter. The fifty-first message was not slow to reach: there was no parameter a caller could pass and no
 * control the interface could render that would return it. The bytes were all still in `ingress_receipts`, so
 * this was never loss — it was the whole archive present and unnavigable, which for a system of record is
 * close enough to matter the same way.
 *
 * ## The test this file exists for
 *
 * **Revoking access between page one and page two, and proving page two cannot return what the revocation
 * removed.** Everything else here is bookkeeping around it.
 *
 * That assertion is the reason the cursor carries *position only*. The obvious cursor — one that remembered
 * the mailbox set page one resolved — would be correct, fast, and would disclose rows the reader may no
 * longer see, because §7 and ADR 11 both require the live relationship to be re-evaluated on **every**
 * operation rather than once per traversal. A cursor is not an exception to that just because it feels like
 * one request in two parts.
 *
 * It is asserted twice, against the two structures that answer *"who may read this mailbox"* and expire
 * differently: a standing `relationship_tuples` row that somebody deletes, and a `supervised_grants` row that
 * runs out of time. A design that re-ran only the tuple half would pass one and fail the other, which is
 * exactly why one test would not have been enough.
 *
 * ## Non-vacuity
 *
 * Each revocation test carries a **control**: the same page two, on the same corpus, without the revocation,
 * asserting that the rows *do* appear. Without it the test would pass against a listing that returned nothing
 * on page two for any reason at all — including the defect being fixed.
 */

const testEnv = env as unknown as Env;
const ORG = "org_paging";
const READER = "usr_paging_reader";
const ANA = "usr_paging_ana";
const BEN = "usr_paging_ben";
/** Read all along. */
const MAILBOX_KEPT = "mbx_paging_kept";
/** Readable on page one and not on page two. The subject of the test. */
const MAILBOX_LOST = "mbx_paging_lost";
/** Never readable. The premise: a listing that returned everything would fail on this alone. */
const MAILBOX_NEVER = "mbx_paging_never";
const ADDRESS_KEPT = "kept@paging.example";
const ADDRESS_LOST = "lost@paging.example";
const ADDRESS_NEVER = "never@paging.example";

const PASSWORD = "fixture-password-not-a-real-secret";
const AUGUST_20 = Date.parse("2026-08-20T09:00:00.000Z");
const THREE_DAYS = 3 * 24 * 60 * 60;

const PAGE = BUDGETS["messages.page_size"];
/**
 * Deliveries per mailbox, chosen from the budget rather than written down.
 *
 * `PAGE + 10` per mailbox means page one is full from two mailboxes and page two is short — so the boundary
 * is inside the corpus rather than at its edge, and a page-two assertion is about paging rather than about
 * running out of mail. Deriving it means a re-measured `messages.page_size` moves the fixture with it,
 * instead of turning this file green by accident.
 */
const PER_MAILBOX = PAGE + 10;

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

interface Row { id: string; mailbox_id: string; accepted_at: string; subject: string | null }
interface Page { messages: Row[]; next_cursor: string | null }

function requestFor(token: string, query?: Record<string, string>): Request {
  const search = new URLSearchParams(query ?? {}).toString();
  return new Request(`https://node.example/api/messages${search === "" ? "" : `?${search}`}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function page(token: string, query?: Record<string, string>): Promise<Page> {
  const response = await listMessages(testEnv, atTime(AUGUST_20), requestFor(token, query));
  expect(response.status).toBe(200);
  return await response.json() as Page;
}

/**
 * Page two, reached the way a caller reaches it: with the cursor page one returned, **and every other
 * parameter page one was asked with**.
 *
 * The second half is not decoration. The first version of this helper sent the cursor alone, so a filtered
 * page one was followed by an unfiltered page two — which is exactly the widening
 * *"carries the filter across the page"* exists to catch, and it caught it here first.
 */
async function secondPage(token: string, first: Page, query?: Record<string, string>): Promise<Page> {
  expect(first.next_cursor, "page one said there was nothing older; the fixture is wrong").not.toBeNull();
  return await page(token, { ...(query ?? {}), [MESSAGE_PAGE_PARAMS.cursor]: first.next_cursor! });
}

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId,
    new Date(AUGUST_20).toISOString()).run();
}

async function sessionFor(userId: string): Promise<string> {
  // The fake clock, not the wall clock: `verifyAccessToken` compares against the instant it is given, so a
  // token minted now and verified at AUGUST_20 is a token from the future and is refused.
  const outcome = await login(testEnv, atTime(AUGUST_20), ORG, `${userId}@paging.example`, PASSWORD);
  if (outcome.status !== "signed_in") throw new Error(`could not sign in ${userId}: ${outcome.status}`);
  return outcome.session.accessToken;
}

beforeEach(async () => {
  for (const table of ["supervised_grants", "matters", "approval_decisions", "approval_stages", "approvals",
                       "relationship_tuples", "team_members", "ingress_receipts", "messages", "cases",
                       "conversations", "addresses", "mailboxes", "users", "node_claim", "login_attempts",
                       "sessions", "refresh_tokens", "audit_entries", "log_entries", "outbox"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }

  const ctx = createSystemCtx();
  const at = new Date(AUGUST_20).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_paging", "unused", at, ORG),
    ...([[MAILBOX_KEPT, ADDRESS_KEPT], [MAILBOX_LOST, ADDRESS_LOST], [MAILBOX_NEVER, ADDRESS_NEVER]] as const)
      .flatMap(([mailboxId, address]) => [
        testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
          .bind(mailboxId, ORG, mailboxId, at),
        testEnv.CATALOG.prepare(
          "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
        ).bind(ctx.id("addr"), ORG, address, mailboxId, at),
      ]),
    ...[READER, ANA, BEN].map((userId) => testEnv.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations,
         password_updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, ORG, `${userId}@paging.example`, at, verifier.encoded, verifier.effectiveIterations, at)),
  ]);

  /*
   * The corpus, interleaved so that **every page spans every mailbox**.
   *
   * Round-robin by arrival rather than one mailbox after another: if `MAILBOX_LOST`'s mail were all older than
   * the page boundary, page two would exclude it whether or not the authorization re-ran, and the test would
   * be measuring the fixture. Interleaved, page two contains rows from all three mailboxes unless something
   * stops them — which is the only way the revocation can be the thing that stopped them.
   *
   * **Two receipts share each timestamp**, because that is what a real Node produces: one message to two
   * addresses lands as two receipts with one `accepted_at`. It also puts a tie across the page boundary, which
   * is the case the cursor's second column exists for.
   */
  const addresses = [ADDRESS_KEPT, ADDRESS_LOST, ADDRESS_NEVER];
  const statements = [];
  for (let n = 0; n < PER_MAILBOX * addresses.length; n++) {
    const receiptId = ctx.id("rcpt");
    const messageId = ctx.id("msg");
    const acceptedAt = new Date(AUGUST_20 - Math.floor(n / 2) * 60_000).toISOString();
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
         blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(receiptId, ORG, `evt_paging_${n}`, `sender${n}@outside.example`, addresses[n % addresses.length]!,
      1024, `${ORG}/raw/${receiptId}`, "0".repeat(64), acceptedAt));
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
         thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
         conversation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(messageId, ORG, "2026-08", `${ORG}/raw/${receiptId}`, "0".repeat(64), 1024,
      `<paging-${n}@outside.example>`, ctx.id("thr"), `message ${n}`, `sender${n}@outside.example`,
      acceptedAt, acceptedAt, receiptId, acceptedAt, null));
    // Indexed, so the searched-page cases below have a corpus. Every subject carries the word "message", so
    // a search for it matches everything and fills a page — which is what makes the cursor assertion sharp.
    statements.push(indexMessage(testEnv, messageId));
  }
  for (let start = 0; start < statements.length; start += 100) {
    await testEnv.CATALOG.batch(statements.slice(start, start + 100));
  }

  await tuple(READER, "mailbox.content.read", "mailbox", MAILBOX_KEPT);
  await tuple(READER, "mailbox.content.read", "mailbox", MAILBOX_LOST);
  // Two people who are not the reader, so a supervised request below can be approved twice.
  await tuple(ANA, "approval.decide", "mailbox", MAILBOX_NEVER);
  await tuple(BEN, "approval.decide", "mailbox", MAILBOX_NEVER);
});


/* ------------------------------------------------- a searched page is not a position in a listing --- */

describe("a searched page offers no cursor, because rank is not a position", () => {
  /*
   * The property, and it lives here rather than in `message-search.test.ts` because it is about
   * `next_cursor` — the field this file owns.
   *
   * A searched page is ordered by bm25 rank, which depends on how often a term occurs across the whole
   * corpus. So it shifts every time mail arrives, and a cursor into it would name a position in an ordering
   * that no longer exists — skipping rows and repeating others, silently. The Node therefore returns null,
   * and the interface renders no pager.
   *
   * **The client cannot hold this property**, which is why it is asserted here. `test/client/` stubs the API,
   * so the pager test there is answered by a fixture that supplies `next_cursor` itself — it proves the
   * interface honours a null, not that the Node produces one. Found by mutating the suppression away and
   * watching the client suite fail somewhere unrelated.
   */
  it("returns a cursor on a full unsearched page, so the null below is the search's doing", async () => {
    /*
     * The control, and it runs first. Without it, "a searched page has no cursor" would pass against a corpus
     * too small to fill a page, a broken fixture, or a listing that never returns a cursor at all.
     */
    const token = await sessionFor(READER);
    const plain = await page(token);
    expect(plain.messages).toHaveLength(PAGE);
    expect(plain.next_cursor, "the unsearched listing returns no cursor — the fixture cannot fill a page")
      .not.toBeNull();
  });

  it("returns null on a searched page that is equally full", async () => {
    /*
     * `message` is in every seeded subject, so this matches the whole corpus and the page comes back full —
     * which is the case that matters. A search matching *fewer* rows than a page would return null anyway,
     * for the ordinary reason, and would prove nothing about the suppression.
     */
    const token = await sessionFor(READER);
    const searched = await page(token, { [MESSAGE_PAGE_PARAMS.q]: "message" });
    expect(searched.messages).toHaveLength(PAGE);
    expect(searched.next_cursor, "a searched page offered a cursor into a ranked ordering").toBeNull();
  });

  it("ignores a cursor sent alongside a term rather than half-honouring it", async () => {
    /*
     * The two parameters do not compose, and the documented behaviour is that the cursor is ignored. Asserted
     * because the alternative — applying a time cursor to a ranked listing — is the failure that produces an
     * arbitrary page, and because `docs/api-contract.md` now tells callers this and a promise in a document
     * with nothing enforcing it is what #103 is about.
     */
    const token = await sessionFor(READER);
    const first = await page(token);
    const withCursor = await page(token, {
      [MESSAGE_PAGE_PARAMS.q]: "message",
      [MESSAGE_PAGE_PARAMS.cursor]: first.next_cursor!,
    });
    const withoutCursor = await page(token, { [MESSAGE_PAGE_PARAMS.q]: "message" });
    expect(withCursor.messages.map((row) => row.id)).toEqual(withoutCursor.messages.map((row) => row.id));
  });
});

/* ------------------------------------------------------- the test the cursor design exists for --- */

describe("authorization is re-run on every page, so a revocation between two pages bites", () => {
  it("drops a mailbox from page two when its standing relation is revoked after page one", async () => {
    const token = await sessionFor(READER);
    const first = await page(token);
    expect(first.messages).toHaveLength(PAGE);
    // The premise: page one saw both mailboxes, so page two would see both too.
    expect(new Set(first.messages.map((row) => row.mailbox_id)))
      .toEqual(new Set([MAILBOX_KEPT, MAILBOX_LOST]));

    /*
     * The control, run first and on the same corpus: page two *does* contain the revoked mailbox's rows when
     * nothing is revoked. Without this the assertion below would pass against a page two that was empty for
     * any reason — including the one this whole change is about.
     */
    const control = await secondPage(token, first);
    const wouldHaveShown = control.messages.filter((row) => row.mailbox_id === MAILBOX_LOST);
    expect(wouldHaveShown.length).toBeGreaterThan(0);

    // The revocation. One statement, exactly as `DELETE /api/access` performs it — no cache to invalidate,
    // which is the property being tested rather than a convenience of the test.
    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ? AND object_id = ?",
    ).bind(ORG, READER, MAILBOX_LOST).run();

    const second = await secondPage(token, first);
    // The assertion: not one row of the revoked mailbox, named by id rather than counted — a count could be
    // satisfied by a page that returned different rows of the same mailbox.
    const ids = new Set(second.messages.map((row) => row.id));
    for (const row of wouldHaveShown) {
      expect(ids.has(row.id), `page two returned ${row.id} from a mailbox the reader lost`).toBe(false);
    }
    expect(second.messages.every((row) => row.mailbox_id === MAILBOX_KEPT)).toBe(true);
    // And it is not empty, which is what says the page still works rather than having failed closed on
    // everything. A page two that returned nothing would also have passed the loop above.
    expect(second.messages.length).toBeGreaterThan(0);
  });

  it("drops a mailbox from page two when a supervised grant expires between the pages", async () => {
    const token = await sessionFor(READER);
    /*
     * A **sixty-second** grant, not a three-day one, and the reason is the access token rather than the
     * grant: `verifyAccessToken` compares against the instant it is given, so a session minted at AUGUST_20
     * and read three days later is refused as expired and page two would come back 401 — which would pass
     * every assertion below for entirely the wrong reason. Sixty seconds is inside the token's life and past
     * the grant's, so the only thing that changed between the two pages is the grant.
     */
    const requested = await requestSupervisedRead(testEnv, atTime(AUGUST_20), ORG, READER, {
      mailboxId: MAILBOX_NEVER,
      scope: "metadata",
      durationSeconds: 60,
      matterId: null,
    });
    await decideApproval(testEnv, atTime(AUGUST_20), ORG, ANA, requested.approvalId, "approve");
    const closing = await decideApproval(testEnv, atTime(AUGUST_20), ORG, BEN, requested.approvalId, "approve");
    if (closing.supervisedGranted !== true) throw new Error("the second approval did not grant the read");

    const first = await page(token);
    expect(first.messages.some((row) => row.mailbox_id === MAILBOX_NEVER)).toBe(true);

    // The control again: the grant's mailbox is on page two while the grant is live.
    const control = await secondPage(token, first);
    const wouldHaveShown = control.messages.filter((row) => row.mailbox_id === MAILBOX_NEVER);
    expect(wouldHaveShown.length).toBeGreaterThan(0);

    /*
     * Page two read *after* the deadline, and that is the whole difference: nothing is revoked, nothing is
     * invalidated, the clock simply moves. `listMessages` takes the instant from its own `ctx`, so this is the
     * same request a caller would make a day later.
     */
    const later = await listMessages(
      testEnv,
      atTime(AUGUST_20 + 60_001),
      requestFor(token, { [MESSAGE_PAGE_PARAMS.cursor]: first.next_cursor! }),
    );
    // 200, not 401: the session is still good and only the grant has run out. Asserted rather than assumed,
    // because a 401 here would satisfy every "the mailbox is absent" check below without proving anything.
    expect(later.status).toBe(200);
    const second = await later.json() as Page;
    const ids = new Set(second.messages.map((row) => row.id));
    for (const row of wouldHaveShown) {
      expect(ids.has(row.id), `page two returned ${row.id} under an expired grant`).toBe(false);
    }
    expect(second.messages.some((row) => row.mailbox_id === MAILBOX_NEVER)).toBe(false);
    expect(second.messages.length).toBeGreaterThan(0);
  });

  it("does not let a forged cursor reach a mailbox the reader may not read", async () => {
    /*
     * The other half of *"the cursor carries position only"*: it is untrusted, and it needs no signature
     * **because** it carries no authority. A caller who invents one moves their own position in an ordering
     * they are re-authorized against — so the honest way to say that is to hand this reader a cursor pointing
     * at the very top of the archive and check that the mailbox they hold nothing on stays invisible.
     */
    const token = await sessionFor(READER);
    /*
     * **Well-formed** but invented, which is the case this test means. The first version used a lowercase
     * body, and once the cursor's shape became strict (`idPattern`) that was refused for its spelling — so
     * the test would have passed while proving nothing about authorization. A forgery has to get past the
     * shape check to say anything about what happens next.
     */
    const forged = `${new Date(AUGUST_20 + 60_000).toISOString()} rcpt_ZZZZZZZZZZZZZZZZZZZZZZZZZZ`;
    const listed = await page(token, { [MESSAGE_PAGE_PARAMS.cursor]: forged });
    expect(listed.messages.length).toBeGreaterThan(0);
    expect(listed.messages.some((row) => row.mailbox_id === MAILBOX_NEVER)).toBe(false);
  });
});

/* ------------------------------------------------------- the archive is reachable ---------------- */

describe("every message is reachable, exactly once", () => {
  /** Walks the whole listing the way a caller does, and returns the ids in the order they arrived. */
  async function walk(token: string, query?: Record<string, string>): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const listed: Page = await page(token, {
        ...(query ?? {}),
        ...(cursor === null ? {} : { [MESSAGE_PAGE_PARAMS.cursor]: cursor }),
      });
      ids.push(...listed.messages.map((row) => row.id));
      cursor = listed.next_cursor;
      pages += 1;
      // A walk that cannot terminate is the failure mode of a cursor that does not advance, and it would
      // otherwise present as the suite's timeout rather than as this test failing.
      expect(pages, "the walk did not terminate; the cursor is not advancing").toBeLessThan(10);
    } while (cursor !== null);
    return { ids, pages };
  }

  it("reaches the message after the page boundary, which is the one that was unreachable", async () => {
    const token = await sessionFor(READER);
    const first = await page(token);
    const second = await secondPage(token, first);
    /*
     * The defect, stated as an assertion. Before #91 this row existed in `ingress_receipts`, was returned by
     * `/api/messages/:id/raw` if you already knew its id, and could not be reached from the listing by any
     * parameter a caller could pass.
     */
    expect(second.messages.length).toBeGreaterThan(0);
    expect(first.messages.map((row) => row.id)).not.toContain(second.messages[0]!.id);
  });

  it("returns every readable message once, in order, across the pages", async () => {
    const token = await sessionFor(READER);
    const { ids, pages } = await walk(token);

    // Two mailboxes readable, one not — so the total is what the reader may see rather than what exists.
    expect(ids).toHaveLength(PER_MAILBOX * 2);
    expect(new Set(ids).size, "a message was returned on two pages").toBe(ids.length);
    expect(pages).toBeGreaterThan(1);

    /*
     * Against the ordering the query claims, computed by SQL rather than restated here — otherwise this
     * asserts that the test and the code agree about ULIDs, which is not the claim.
     *
     * The tie is what makes this worth doing: two receipts share every timestamp, so an ordering that left
     * their relative position to the planner could drop one at a page boundary and repeat the other, and the
     * totals above would still be right if it dropped one and repeated another.
     */
    const { results } = await testEnv.CATALOG.prepare(
      `SELECT r.id FROM ingress_receipts r
         JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
        WHERE r.org_id = ? AND a.mailbox_id IN (?, ?)
        ORDER BY r.accepted_at DESC, r.id DESC`,
    ).bind(ORG, MAILBOX_KEPT, MAILBOX_LOST).all<{ id: string }>();
    expect(ids).toEqual(results.map((row) => row.id));
  });

  it("says next_cursor is null on the last page and not merely because the page was short", async () => {
    const token = await sessionFor(READER);
    const { ids } = await walk(token);
    expect(ids.length).toBeGreaterThan(PAGE);

    /*
     * The probe row, from the other side. `listMessages` asks for one row past the page so `next_cursor` can
     * mean *"there is at least one more row you may read"* rather than *"the page was full, so perhaps"*.
     * The difference is only observable when the readable mail is an exact multiple of the page — so this
     * makes it one, by taking the second mailbox away.
     */
    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ? AND object_id = ?",
    ).bind(ORG, READER, MAILBOX_LOST).run();
    await testEnv.CATALOG.prepare(
      `DELETE FROM ingress_receipts WHERE org_id = ? AND id IN (
         SELECT r.id FROM ingress_receipts r
           JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
          WHERE r.org_id = ? AND a.mailbox_id = ?
          ORDER BY r.accepted_at DESC, r.id DESC LIMIT ?)`,
    ).bind(ORG, ORG, MAILBOX_KEPT, PER_MAILBOX - PAGE).run();

    const exact = await page(token);
    expect(exact.messages).toHaveLength(PAGE);
    // A full page with nothing behind it. Without the probe row this would carry a cursor, and the interface
    // would render an "older" control leading to an empty page.
    expect(exact.next_cursor).toBeNull();
  });
});

/* ------------------------------------------------------- the mailbox filter ---------------------- */

describe("a reader with several mailboxes can look at one", () => {
  it("returns only that mailbox, and pages within it", async () => {
    const token = await sessionFor(READER);
    const first = await page(token, { [MESSAGE_PAGE_PARAMS.mailbox]: MAILBOX_LOST });
    expect(first.messages).toHaveLength(PAGE);
    expect(first.messages.every((row) => row.mailbox_id === MAILBOX_LOST)).toBe(true);

    const second = await secondPage(token, first, { [MESSAGE_PAGE_PARAMS.mailbox]: MAILBOX_LOST });
    expect(second.messages).toHaveLength(PER_MAILBOX - PAGE);
    expect(second.messages.every((row) => row.mailbox_id === MAILBOX_LOST)).toBe(true);
    expect(second.next_cursor).toBeNull();
  });

  it("carries the filter across the page, rather than widening on page two", async () => {
    /*
     * The failure this catches is specific and easy to write: a client that passes `mailbox` on page one and
     * only `cursor` on page two would silently widen back to every mailbox, and the reader would see a page
     * of somebody else's queue where they asked for their own. Asserted on the server's behaviour with both
     * parameters present, because that is the contract the client is written against.
     */
    const token = await sessionFor(READER);
    const first = await page(token, { [MESSAGE_PAGE_PARAMS.mailbox]: MAILBOX_LOST });
    const second = await page(token, {
      [MESSAGE_PAGE_PARAMS.mailbox]: MAILBOX_LOST,
      [MESSAGE_PAGE_PARAMS.cursor]: first.next_cursor!,
    });
    expect(second.messages.some((row) => row.mailbox_id === MAILBOX_KEPT)).toBe(false);
  });

  it("answers empty for a mailbox this reader may not read, rather than saying which", async () => {
    /*
     * §5C keeps an absent thing and an invisible one alike, which is what `GET /api/cases` already does for a
     * queue: *"empty rather than forbidden for a mailbox this caller cannot see"*. A 403 here would answer
     * *"that mailbox exists and is not yours"*, which is a fact about somebody else's mail.
     */
    const token = await sessionFor(READER);
    const listed = await page(token, { [MESSAGE_PAGE_PARAMS.mailbox]: MAILBOX_NEVER });
    expect(listed.messages).toHaveLength(0);
    expect(listed.next_cursor).toBeNull();

    const nonexistent = await page(token, { [MESSAGE_PAGE_PARAMS.mailbox]: "mbx_paging_no_such_thing" });
    expect(nonexistent.messages).toHaveLength(0);
  });
});

/* ------------------------------------------------------- the refusal ----------------------------- */

describe("a cursor this Node cannot read is refused, not ignored", () => {
  /*
   * The last four cases are the ones the **first version accepted**, and they are why the instant is matched
   * against a pattern rather than handed to `Date.parse`.
   *
   * `Date.parse("2027")` is a finite number, and so is `Date.parse("2026-08")`. The old guard was
   * `Number.isFinite(Date.parse(instant))`, so a client that truncated its cursor — a date picker, a log
   * line copied by hand, a JSON round trip through a lossy field — sailed through. And `accepted_at` is
   * compared as a **string** in the keyset predicate, where `'2027'` sorts after every `'2026-…'` value, so
   * the caller silently received a page from a position nobody had given them. A wrong page is worse than a
   * refusal here for the reason the whole `describe` is about: it is indistinguishable from the truth.
   *
   * The id half was not checked at all, which is why `rcpt_1` is in this list.
   */
  const malformed = ["", "not-a-position", "2026-08-20T09:00:00.000Z", "2026-08-20T09:00:00.000Z ",
    "yesterday rcpt_1", "2026-08-20T09:00:00.000Z rcpt_1 extra",
    // Accepted by `Date.parse`, refused by the shape.
    "2027 rcpt_ZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    "2026-08 rcpt_ZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    "2026-08-20T09:00:00.000Z rcpt_1",
    // Right length, wrong alphabet: Crockford base32 excludes I, L, O and U.
    "2026-08-20T09:00:00.000Z rcpt_IIIIIIIIIIIIIIIIIIIIIIIIII"];

  for (const cursor of malformed) {
    it(`refuses ${JSON.stringify(cursor)} with a code and a way back`, async () => {
      const token = await sessionFor(READER);
      const attempt = listMessages(testEnv, atTime(AUGUST_20),
        requestFor(token, { [MESSAGE_PAGE_PARAMS.cursor]: cursor }));
      /*
       * Thrown, so `index.ts`'s central `CallerError` handler renders it as a 422 with the code and the
       * message — rather than answered here in a second spelling of that shape.
       *
       * **The refusal is the point, not the message.** Ignoring a cursor it could not parse would answer the
       * *newest* page, which reads as "you have reached the end" or "here is your inbox again" and is
       * indistinguishable from the truth. That is AGENTS.md's never-swallow rule arriving through a `??`
       * instead of a `catch`.
       */
      await expect(attempt).rejects.toThrow(/E_PAGE_CURSOR_MALFORMED/);
      await expect(attempt).rejects.toThrow(/next_cursor/);
    });
  }

  it("accepts the cursor it just produced, so the refusal cannot be over-eager", async () => {
    // The other side of the six refusals above: a rule strict enough to reject the Node's own cursor would
    // make paging impossible and every test in this file would have to be written around it.
    const token = await sessionFor(READER);
    const first = await page(token);
    await expect(secondPage(token, first)).resolves.toBeDefined();
  });
});

/* ------------------------------------------------------- one page, one act (§7) ------------------ */

describe("each page is one supervised act, and records the ids that page showed", () => {
  async function queryEntries() {
    const { results } = await testEnv.CATALOG.prepare(
      "SELECT subject, detail FROM audit_entries WHERE org_id = ? AND action = 'supervised.query' ORDER BY seq",
    ).bind(ORG).all<{ subject: string | null; detail: string | null }>();
    return results.map((row) => ({
      grantId: row.subject,
      detail: JSON.parse(row.detail ?? "{}") as { ids?: string[]; returned?: number },
    }));
  }

  it("writes one entry per page, naming that page's rows and not the next page's", async () => {
    const token = await sessionFor(READER);
    const requested = await requestSupervisedRead(testEnv, atTime(AUGUST_20), ORG, READER, {
      mailboxId: MAILBOX_NEVER, scope: "metadata", durationSeconds: THREE_DAYS, matterId: null,
    });
    await decideApproval(testEnv, atTime(AUGUST_20), ORG, ANA, requested.approvalId, "approve");
    await decideApproval(testEnv, atTime(AUGUST_20), ORG, BEN, requested.approvalId, "approve");

    const first = await page(token, { [MESSAGE_PAGE_PARAMS.mailbox]: MAILBOX_NEVER });
    const afterOne = await queryEntries();
    expect(afterOne).toHaveLength(1);
    /*
     * The ids of the page, **not of the query**. `listMessages` reads one row past the page to learn whether
     * there is a next one, and that row is never returned — so recording it would put an id in the trail that
     * nobody saw. Off-by-one in the direction that overstates exposure is still a wrong record.
     */
    expect(afterOne[0]!.detail.ids).toEqual(first.messages.map((row) => row.id));
    expect(afterOne[0]!.detail.returned).toBe(PAGE);

    const second = await page(token, {
      [MESSAGE_PAGE_PARAMS.mailbox]: MAILBOX_NEVER,
      [MESSAGE_PAGE_PARAMS.cursor]: first.next_cursor!,
    });
    const afterTwo = await queryEntries();
    // §7 records acts and each page is one: two pages, two entries, disjoint id lists. One entry covering the
    // whole traversal would have to accumulate across requests and name an instant at which some of those
    // ids may no longer have been disclosable.
    expect(afterTwo).toHaveLength(2);
    expect(afterTwo[1]!.detail.ids).toEqual(second.messages.map((row) => row.id));
    expect(afterTwo[0]!.grantId).toBe(requested.grantId);
    expect(afterTwo[1]!.grantId).toBe(requested.grantId);
    const overlap = afterTwo[0]!.detail.ids!.filter((id) => afterTwo[1]!.detail.ids!.includes(id));
    expect(overlap).toEqual([]);
  });

  it("keeps one page inside one entry, which is what messages.page_size is sized under", async () => {
    /*
     * `docs/receipts/message-page-size.md` sizes the page under the id list one `supervised.query` entry
     * holds — 57 measured, against a page of 50. Splitting is correct and never truncates, so a larger page
     * would still record everything; what it would stop being is one row per act. Asserted here on a real
     * page rather than on the builder, because the builder is where `supervised-recording.test.ts` checks it
     * and this is where the two numbers meet.
     */
    const token = await sessionFor(READER);
    const requested = await requestSupervisedRead(testEnv, atTime(AUGUST_20), ORG, READER, {
      mailboxId: MAILBOX_NEVER, scope: "metadata", durationSeconds: THREE_DAYS, matterId: null,
    });
    await decideApproval(testEnv, atTime(AUGUST_20), ORG, ANA, requested.approvalId, "approve");
    await decideApproval(testEnv, atTime(AUGUST_20), ORG, BEN, requested.approvalId, "approve");

    await page(token, { [MESSAGE_PAGE_PARAMS.mailbox]: MAILBOX_NEVER });
    const entries = await queryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail.ids).toHaveLength(PAGE);
  });
});
