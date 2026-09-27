import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";
import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { ACCESS_COOKIE, issueSession } from "../src/auth/session.ts";
import { mintAgent } from "../src/agents.ts";
import { placeHold } from "../src/holds.ts";
import { setPlace } from "../src/places.ts";
import { seedDelivery } from "./fixtures/delivery.ts";

/**
 * Places (0067, ADR 45): each person's Inbox, Archive and Trash, and the listing's `place`, `unread` and `mine`.
 *
 * The property that decided the design is the first one tested: a place is **per person**. One reader filing a
 * message changes nothing for anybody else, and nothing is destroyed — the message stays in its mailbox, in
 * every other reader's Inbox, in search and in its thread. `test/message-pagination.test.ts` holds the lookback
 * (how far one Inbox, Unread or Mine request looks) and `test/message-page.measure.test.ts` what each costs.
 */

const testEnv = env as unknown as Env;
const ORG = "org_places";
const MAILBOX = "mbx_places";
const ADDRESS = "support@places.example";
const ORIGIN = "https://node";
const BASE = Date.parse("2026-09-01T09:00:00.000Z");

// Minted ids: `mintAgent` checks its sponsor is a person here, which includes the identifier's shape.
const minted = createSystemCtx();
const ANA = minted.id("usr");
const BEN = minted.id("usr");
/** `mailbox.metadata.read` only: sees the listing, may not file. */
const META = minted.id("usr");
/** A live supervised grant of scope content, and no standing relation. */
const SUPERVISOR = minted.id("usr");
/** A live supervised grant of scope metadata only. */
const SUPERVISOR_META = minted.id("usr");
const ADMIN = minted.id("usr");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (prefix) => system.id(prefix), random: (n) => system.random(n) };
}

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string) {
  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(createSystemCtx().id("rt"), ORG, subjectId, relation, objectType, objectId, new Date(BASE).toISOString()).run();
}

async function grant(subjectId: string, scope: "metadata" | "content") {
  const at = new Date(BASE).toISOString();
  await testEnv.CATALOG.prepare(
    `INSERT INTO supervised_grants
       (id, org_id, subject_id, mailbox_id, scope, matter_id, requested_at, expires_at, granted_at)
     VALUES (?,?,?,?,?,NULL,?,?,?)`,
  ).bind(createSystemCtx().id("sgr"), ORG, subjectId, MAILBOX, scope, at, "2099-01-01T00:00:00.000Z", at).run();
}

async function cookieFor(userId: string): Promise<string> {
  const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId });
  return `${ACCESS_COOKIE}=${session.accessToken}`;
}

type Row = {
  id: string; message_id: string | null; place: string; read: number; standing_content: number;
  case_mine: number; case_state: string | null; accepted_at: string;
};
type Page = { messages: Row[]; next_cursor: string | null; lookback_exhausted: boolean };

async function list(credential: string, query = ""): Promise<Page> {
  const response = await SELF.fetch(`${ORIGIN}/api/messages${query}`, { headers: auth(credential) });
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as Page;
}

async function every(credential: string, query: string): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Page = await list(credential, `?${query}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    ids.push(...page.messages.map((row) => row.id));
    cursor = page.next_cursor;
    pages += 1;
  } while (cursor !== null && pages < 20);
  return { ids, pages };
}

/** A session cookie, or an agent's bearer token (`agt:` prefixed by the caller of `auth`). */
function auth(credential: string): Record<string, string> {
  return credential.startsWith("agent ")
    ? { authorization: `Bearer ${credential.slice("agent ".length)}` }
    : { cookie: credential };
}

async function put(credential: string, messageId: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/messages/${messageId}/place`, {
    method: "PUT", headers: { "content-type": "application/json", ...auth(credential) }, body: JSON.stringify(body),
  });
}

/**
 * `n` deliveries straight into the catalog, oldest first a minute apart, with deterministic ids so the keyset
 * order is the insertion order. No evidence: nothing here reads a body.
 */
async function seedMany(n: number): Promise<Array<{ receiptId: string; messageId: string; caseId: string }>> {
  const out: Array<{ receiptId: string; messageId: string; caseId: string }> = [];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < n; i++) {
    // The receipt id has the shape a cursor is checked against (`rcpt_` and 26 ULID characters).
    const pad = String(i).padStart(25, "0");
    const receiptId = `rcpt_P${pad}`;
    const messageId = `msg_P${pad}`;
    const caseId = `cas_P${pad}`;
    const conversationId = `cnv_P${pad}`;
    const at = new Date(BASE + i * 60_000).toISOString();
    out.push({ receiptId, messageId, caseId });
    statements.push(
      testEnv.CATALOG.prepare(
        `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
           blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(receiptId, ORG, `evt_${receiptId}`, `sender-${i}@example.net`, ADDRESS, 100,
        `${ORG}/raw/${receiptId}`, "0".repeat(64), at),
      testEnv.CATALOG.prepare(
        `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at, conversation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(messageId, ORG, "2026-09", `${ORG}/raw/${receiptId}`, "0".repeat(64), 100, `m-${i}@example.net`,
        `thr_P${pad}`, `Message ${i}`, `sender-${i}@example.net`, at, at, receiptId, at, conversationId),
      testEnv.CATALOG.prepare(
        `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at, created_at)
         VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
      ).bind(caseId, ORG, conversationId, MAILBOX, at, at),
    );
  }
  for (let start = 0; start < statements.length; start += 100) {
    await testEnv.CATALOG.batch(statements.slice(start, start + 100));
  }
  return out;
}

beforeEach(async () => {
  for (const table of [
    "message_places", "message_reads", "supervised_grants", "holds", "agents", "agent_actions",
    "relationship_tuples", "cases", "conversations", "mailbox_items", "messages", "ingress_receipts",
    "addresses", "mailboxes", "users", "node_claim", "audit_entries", "log_entries",
  ]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const at = new Date(BASE).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('claim','x',?,?)")
      .bind(at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)")
      .bind("adr_places", ORG, ADDRESS, MAILBOX, at),
    ...[ANA, BEN, META, SUPERVISOR, SUPERVISOR_META, ADMIN].map((userId) => testEnv.CATALOG.prepare(
      "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
    ).bind(userId, ORG, `${userId.toLowerCase()}@places.example`, at)),
  ]);
  for (const person of [ANA, BEN]) {
    await tuple(person, "mailbox.content.read", "mailbox", MAILBOX);
    await tuple(person, "send.propose", "mailbox", MAILBOX);
  }
  await tuple(META, "mailbox.metadata.read", "mailbox", MAILBOX);
  await tuple(ADMIN, "org.admin", "organization", ORG);
  await grant(SUPERVISOR, "content");
  await grant(SUPERVISOR_META, "metadata");
});

describe("a place is the caller's own, and nothing else changes", () => {
  it("files for one reader and leaves another reader's Inbox alone", async () => {
    const [first, second] = await seedMany(2);
    const ana = await cookieFor(ANA);
    const ben = await cookieFor(BEN);

    const filed = await put(ana, first!.messageId, { place: "archive" });
    expect(filed.status).toBe(200);
    expect(await filed.json()).toEqual({ messageId: first!.messageId, place: "archive" });

    expect((await list(ana, "?place=inbox")).messages.map((row) => row.id)).toEqual([second!.receiptId]);
    expect((await list(ana, "?place=archive")).messages.map((row) => row.id)).toEqual([first!.receiptId]);
    // Ben's Inbox still has it: a mailbox is shared, and Ana putting a message away says nothing about him.
    expect((await list(ben, "?place=inbox")).messages.map((row) => row.id))
      .toEqual([second!.receiptId, first!.receiptId]);
    // Without `place`, every place: the message is still listed for Ana, wearing her place.
    const all = await list(ana);
    expect(all.messages.map((row) => [row.id, row.place])).toEqual([
      [second!.receiptId, "inbox"], [first!.receiptId, "archive"],
    ]);
    expect(all.lookback_exhausted).toBe(false);

    // Trash, and back: Trash is a place, not a deletion.
    expect((await put(ana, first!.messageId, { place: "trash" })).status).toBe(200);
    expect((await list(ana, "?place=trash")).messages.map((row) => row.id)).toEqual([first!.receiptId]);
    expect((await put(ana, first!.messageId, { place: "inbox" })).status).toBe(200);
    expect((await list(ana, "?place=inbox")).messages.map((row) => row.id))
      .toEqual([second!.receiptId, first!.receiptId]);
    const rows = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM message_places").first<{ n: number }>();
    expect(rows?.n, "putting a message back in the Inbox leaves a filing row behind").toBe(0);
  });

  it("puts a message back in one reader's Inbox and leaves another reader's Archive alone", async () => {
    // The other direction of the rule above: the un-filing is per person too, while a colleague still has a row.
    const [message] = await seedMany(1);
    const ana = await cookieFor(ANA);
    const ben = await cookieFor(BEN);
    expect((await put(ben, message!.messageId, { place: "archive" })).status).toBe(200);
    expect((await put(ana, message!.messageId, { place: "trash" })).status).toBe(200);
    expect((await put(ana, message!.messageId, { place: "inbox" })).status).toBe(200);
    expect((await list(ben, "?place=archive")).messages.map((row) => row.id), "Ana's Inbox emptied Ben's Archive")
      .toEqual([message!.receiptId]);
    const filed = await testEnv.CATALOG.prepare("SELECT user_id, place FROM message_places").all();
    expect(filed.results).toEqual([{ user_id: BEN, place: "archive" }]);
  });

  it("files an agent's messages in the agent's own view, never its sponsor's", async () => {
    const [message] = await seedMany(1);
    // `mail.read` includes the original `.eml`, so the agent (and its sponsor) hold `message.export` too.
    await tuple(ANA, "message.export", "mailbox", MAILBOX);
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "filer", sponsorUserId: ANA, capabilities: ["mail.read", "mail.place"],
      grants: [
        { mailboxId: MAILBOX, relation: "mailbox.content.read" }, { mailboxId: MAILBOX, relation: "message.export" },
      ],
    });
    const agent = `agent ${minted.token}`;
    expect((await put(agent, message!.messageId, { place: "archive" })).status).toBe(200);
    expect((await list(agent, "?place=inbox")).messages).toEqual([]);
    expect((await list(await cookieFor(ANA), "?place=inbox")).messages.map((row) => row.id))
      .toEqual([message!.receiptId]);
    const filed = await testEnv.CATALOG.prepare("SELECT user_id FROM message_places").all<{ user_id: string }>();
    expect(filed.results).toEqual([{ user_id: minted.agent.id }]);
  });

  it("refuses a reader who cannot file, and still lists the message for them", async () => {
    const [message] = await seedMany(1);
    for (const reader of [META, SUPERVISOR]) {
      const credential = await cookieFor(reader);
      const refused = await put(credential, message!.messageId, { place: "archive" });
      expect(refused.status, `${reader} could file a message it may not act on`).toBe(404);
      expect((await refused.json() as { error: string }).error).toBe("E_NO_SUCH_MESSAGE");
      const listed = await list(credential);
      expect(listed.messages.map((row) => [row.id, row.standing_content, row.place]))
        .toEqual([[message!.receiptId, 0, "inbox"]]);
    }
    expect((await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM message_places").first<{ n: number }>())?.n)
      .toBe(0);
  });

  it("refuses a quarantined message, with the answer an absent one gets", async () => {
    const [message] = await seedMany(1);
    await testEnv.CATALOG.prepare("UPDATE messages SET quarantined_at = ? WHERE id = ?")
      .bind(new Date(BASE).toISOString(), message!.messageId).run();
    const refused = await put(await cookieFor(ANA), message!.messageId, { place: "archive" });
    expect(refused.status).toBe(404);
  });

  it("is not refused by a legal hold, because filing destroys nothing", async () => {
    const [message] = await seedMany(1);
    await placeHold(testEnv, atTime(BASE), ORG, ADMIN, { mailboxId: MAILBOX });
    const ana = await cookieFor(ANA);
    expect((await put(ana, message!.messageId, { place: "trash" })).status).toBe(200);
    expect((await put(ana, message!.messageId, { place: "inbox" })).status).toBe(200);
  });

  it("leaves the case exactly as it was: archiving never closes a case", async () => {
    const [open, claimed] = await seedMany(2);
    await testEnv.CATALOG.prepare("UPDATE cases SET state = 'claimed', assignee = ?, claimed_at = ? WHERE id = ?")
      .bind(ANA, new Date(BASE).toISOString(), claimed!.caseId).run();
    const before = await testEnv.CATALOG.prepare("SELECT id, state, assignee, state_at FROM cases ORDER BY id").all();
    const ana = await cookieFor(ANA);
    await put(ana, open!.messageId, { place: "archive" });
    await put(ana, claimed!.messageId, { place: "trash" });
    const after = await testEnv.CATALOG.prepare("SELECT id, state, assignee, state_at FROM cases ORDER BY id").all();
    expect(after.results).toEqual(before.results);
  });

  it("answers the same when asked twice, and keeps one row", async () => {
    const [message] = await seedMany(1);
    const ana = await cookieFor(ANA);
    const first = await (await put(ana, message!.messageId, { place: "archive" })).json();
    const again = await (await put(ana, message!.messageId, { place: "archive" })).json();
    expect(again).toEqual(first);
    expect((await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM message_places").first<{ n: number }>())?.n)
      .toBe(1);
  });

  it("refuses a place that is not one, by name, and an unknown field before that", async () => {
    const [message] = await seedMany(1);
    const ana = await cookieFor(ANA);
    for (const body of [{ place: ["archive"] }, {}, { place: "spam" }, { place: 3 }]) {
      const refused = await put(ana, message!.messageId, body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
      expect((await refused.json() as { error: string }).error).toBe("E_PLACE_UNKNOWN");
    }
    const typo = await put(ana, message!.messageId, { plcae: "trash" });
    expect(typo.status).toBe(422);
    expect((await typo.json() as { error: string }).error).toBe("E_PLACE_FIELD_UNKNOWN");
  });
});

describe("the listing's per-person filters", () => {
  it("lists an unmaterialised receipt in the Inbox, because nothing can file it", async () => {
    await testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
         blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind("ir_UNMATERIALISED000000000000", ORG, "evt_unmat", "x@example.net", ADDRESS, 10, "k", "0".repeat(64),
      new Date(BASE).toISOString()).run();
    const inbox = await list(await cookieFor(ANA), "?place=inbox");
    expect(inbox.messages.map((row) => [row.id, row.message_id, row.place, row.standing_content]))
      .toEqual([["ir_UNMATERIALISED000000000000", null, "inbox", 0]]);
  });

  it("pages unread=1 across two pages, filtered by the Node and never by the client", async () => {
    const size = BUDGETS["messages.page_size"];
    const seeded = await seedMany(2 * size + 10);
    // Every other message read by Ana; the rest unread. Newest first is the listing's order.
    await testEnv.CATALOG.batch(seeded.filter((_, i) => i % 2 === 1).map((one) => testEnv.CATALOG.prepare(
      "INSERT INTO message_reads (org_id, user_id, message_id, read_at) VALUES (?,?,?,?)",
    ).bind(ORG, ANA, one.messageId, new Date(BASE).toISOString())));
    const expected = seeded.filter((_, i) => i % 2 === 0).map((one) => one.receiptId).reverse();
    const ana = await cookieFor(ANA);
    // More than a page is unread, so the second page is part of what is tested.
    expect(expected.length).toBeGreaterThan(size);
    const paged = await every(ana, "place=inbox&unread=1");
    expect(paged.pages).toBeGreaterThan(1);
    expect(paged.ids).toEqual(expected);
    const all = await every(ana, "unread=1");
    expect(all.ids).toEqual(expected);
  });

  it("pages mine=1 across two pages, and case_mine says so on each row", async () => {
    const size = BUDGETS["messages.page_size"];
    const seeded = await seedMany(2 * size + 10);
    const mine = seeded.filter((_, i) => i % 2 === 0);
    await testEnv.CATALOG.batch(mine.map((one) => testEnv.CATALOG.prepare(
      "UPDATE cases SET state = 'claimed', assignee = ?, claimed_at = ? WHERE id = ?",
    ).bind(ANA, new Date(BASE).toISOString(), one.caseId)));
    const ana = await cookieFor(ANA);
    const paged = await every(ana, "mine=1");
    expect(paged.pages).toBeGreaterThan(1);
    expect(paged.ids).toEqual(mine.map((one) => one.receiptId).reverse());

    const first = await list(ana, "?mine=1");
    expect(new Set(first.messages.map((row) => `${row.case_mine}:${row.case_state}`))).toEqual(new Set(["1:claimed"]));
    // Ben sees the same claimed cases as claimed, and not as his.
    const ben = await list(await cookieFor(BEN));
    const claimedRow = ben.messages.find((row) => row.id === mine[mine.length - 1]!.receiptId);
    expect([claimedRow?.case_mine, claimedRow?.case_state]).toEqual([0, "claimed"]);
    expect((await list(await cookieFor(BEN), "?mine=1")).messages).toEqual([]);
  });

  it("pages Archive from the filing table, newest first, with the listing's cursor shape", async () => {
    const size = BUDGETS["messages.page_size"];
    const seeded = await seedMany(2 * size);
    const archived = seeded.filter((_, i) => i % 3 !== 0);
    for (const one of archived) await setPlace(testEnv, atTime(BASE), ORG, ANA, one.messageId, "archive");
    const ana = await cookieFor(ANA);
    const first = await list(ana, "?place=archive");
    expect(first.messages).toHaveLength(size);
    expect(first.lookback_exhausted).toBe(false);
    // The same `accepted_at id` position every listing returns, so paging code does not change.
    expect(first.next_cursor).toBe(`${first.messages[size - 1]!.accepted_at} ${first.messages[size - 1]!.id}`);
    const paged = await every(ana, "place=archive");
    expect(paged.ids).toEqual(archived.map((one) => one.receiptId).reverse());
    expect(new Set((await list(ana, "?place=archive")).messages.map((row) => row.place))).toEqual(new Set(["archive"]));
  });

  it("refuses a filter it cannot read, rather than answering a wider page", async () => {
    const ana = await cookieFor(ANA);
    for (const [query, code] of [
      ["?place=archived", "E_MESSAGE_PAGE_FILTER"], ["?unread=0", "E_MESSAGE_PAGE_FILTER"],
      ["?mine=true", "E_MESSAGE_PAGE_FILTER"], ["?q=invoice&place=inbox", "E_MESSAGE_PAGE_SEARCH_FILTER"],
      ["?q=invoice&unread=1", "E_MESSAGE_PAGE_SEARCH_FILTER"], ["?q=invoice&mine=1", "E_MESSAGE_PAGE_SEARCH_FILTER"],
    ] as const) {
      const response = await SELF.fetch(`${ORIGIN}/api/messages${query}`, { headers: { cookie: ana } });
      expect(response.status, query).toBe(422);
      expect((await response.json() as { error: string }).error, query).toBe(code);
    }
  });
});

describe("the header block is content", () => {
  it("is recorded as an open under a supervised content grant, and refused under a metadata one", async () => {
    const delivery = await seedDelivery(testEnv, atTime(BASE), { orgId: ORG, mailboxId: MAILBOX, address: ADDRESS });
    const opened = await SELF.fetch(`${ORIGIN}/api/messages/${delivery.receiptId}/headers`, {
      headers: { cookie: await cookieFor(SUPERVISOR) },
    });
    expect(opened.status).toBe(200);
    const block = await opened.json() as { headers: string; truncated: boolean; limit_bytes: number };
    expect(block.headers).toContain(`Message-ID: <${delivery.rfcMessageId}>`);
    expect(block.truncated).toBe(false);
    expect(block.limit_bytes).toBe(BUDGETS["mime.max_header_bytes"]);
    const recorded = await testEnv.CATALOG.prepare(
      "SELECT detail FROM audit_entries WHERE action = 'supervised.opened'",
    ).all<{ detail: string }>();
    expect(recorded.results.map((row) => row.detail).join(" ")).toContain(delivery.receiptId);

    const refused = await SELF.fetch(`${ORIGIN}/api/messages/${delivery.receiptId}/headers`, {
      headers: { cookie: await cookieFor(SUPERVISOR_META) },
    });
    expect(refused.status).toBe(404);
  });
});
