import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { ACCESS_COOKIE, issueSession } from "../src/auth/session.ts";
import { sealManifest } from "../src/outbound/manifest.ts";
import { seedDelivery } from "./fixtures/delivery.ts";

/**
 * A thread is two listings with one more predicate each (#30's other half): `?conversation=` on the inbox
 * and on the outbox. Authorization is the listings' own, which is the claim worth a test — a reader who may
 * see one mailbox must not see the other mailbox's half of a conversation that reached both.
 */
const testEnv = env as unknown as Env;
const ORG = "org_thread";
const READER = "usr_thread_reader";
const OTHER = "usr_thread_other";
const MINE = { id: "mbx_thread_mine", address: "mine@thread.example" };
const THEIRS = { id: "mbx_thread_theirs", address: "theirs@thread.example" };

async function cookieFor(userId: string): Promise<string> {
  const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId });
  return `${ACCESS_COOKIE}=${session.accessToken}`;
}

async function listed(path: string, cookie: string): Promise<Array<{ id: string }>> {
  const response = await SELF.fetch(`https://node${path}`, { headers: { cookie } });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json() as { messages?: Array<{ id: string }>; sends?: Array<{ id: string }> };
  return body.messages ?? body.sends ?? [];
}

beforeAll(async () => {
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    ...[READER, OTHER].map((userId) =>
      testEnv.CATALOG.prepare("INSERT OR IGNORE INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
        .bind(userId, ORG, `${userId}@thread.example`, at)),
    testEnv.CATALOG.prepare("INSERT OR IGNORE INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('clm_thread','x',?,?)").bind(at, ORG),
    ...[MINE, THEIRS].flatMap((box) => [
      testEnv.CATALOG.prepare("INSERT OR IGNORE INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)").bind(box.id, ORG, box.id, at),
      testEnv.CATALOG.prepare("INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)")
        .bind(ctx.id("addr"), ORG, box.address, box.id, at),
    ]),
    ...["mailbox.content.read", "send.propose"].map((relation) =>
      testEnv.CATALOG.prepare(
        `INSERT OR IGNORE INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,'mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, READER, relation, MINE.id, at)),
  ]);
});

describe("a conversation is read as a thread, authorized as the listings are", () => {
  it("lists the conversation's messages and the sends that replied into it, and nothing from elsewhere", async () => {
    const ctx = createSystemCtx();
    const first = await seedDelivery(testEnv, ctx, { orgId: ORG, mailboxId: MINE.id, address: MINE.address }, { subject: "Thread A" });
    // A second delivery into the same conversation: the fixture mints a root per call, so the row is moved.
    const second = await seedDelivery(testEnv, ctx, { orgId: ORG, mailboxId: MINE.id, address: MINE.address }, { subject: "Re: Thread A" });
    await testEnv.CATALOG.prepare("UPDATE messages SET conversation_id = ? WHERE id = ?").bind(first.conversationId, second.messageId).run();
    const elsewhere = await seedDelivery(testEnv, ctx, { orgId: ORG, mailboxId: MINE.id, address: MINE.address }, { subject: "Thread B" });
    const sealed = await sealManifest(testEnv, ctx, ORG, {
      mailboxId: MINE.id, authorUserId: READER, to: ["customer@example.net"], subject: "Re: Thread A",
      bodyTyped: "Replying.", fidelity: "authored", inReplyToMessageId: first.messageId,
    });

    const cookie = await cookieFor(READER);
    const messages = await listed(`/api/messages?conversation=${first.conversationId}`, cookie);
    expect(messages.map((one) => one.id).sort()).toEqual([first.receiptId, second.receiptId].sort());
    expect(messages.map((one) => one.id)).not.toContain(elsewhere.receiptId);
    const sends = await listed(`/api/sends?conversation=${first.conversationId}`, cookie);
    expect(sends.map((one) => one.id)).toEqual([sealed.id]);
    // The whole outbox still lists it; the predicate narrows and never widens.
    expect((await listed("/api/sends", cookie)).map((one) => one.id)).toContain(sealed.id);
  });

  it("shows a reader only the half of a conversation they may see", async () => {
    const ctx = createSystemCtx();
    const mine = await seedDelivery(testEnv, ctx, { orgId: ORG, mailboxId: MINE.id, address: MINE.address }, { subject: "Both" });
    const theirs = await seedDelivery(testEnv, ctx, { orgId: ORG, mailboxId: THEIRS.id, address: THEIRS.address }, { subject: "Both" });
    await testEnv.CATALOG.prepare("UPDATE messages SET conversation_id = ? WHERE id = ?").bind(mine.conversationId, theirs.messageId).run();

    const asReader = await listed(`/api/messages?conversation=${mine.conversationId}`, await cookieFor(READER));
    expect(asReader.map((one) => one.id)).toEqual([mine.receiptId]);
    // A stranger to both mailboxes is answered an empty page, not a refusal: the thread does not exist for them.
    expect(await listed(`/api/messages?conversation=${mine.conversationId}`, await cookieFor(OTHER))).toEqual([]);
    expect(await listed(`/api/sends?conversation=${mine.conversationId}`, await cookieFor(OTHER))).toEqual([]);
  });
});
