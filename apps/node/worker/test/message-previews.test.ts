import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { type Bytes, utf8 } from "@mailda/evidence";

import worker from "../src/index.ts";
import { ACCESS_COOKIE, issueSession } from "../src/auth/session.ts";
import { mintAgent } from "../src/agents.ts";
import { runDoctor } from "../src/doctor.ts";
import { contentOpeningKey, putEvidence } from "../src/evidence-store.ts";
import { vault } from "../src/keyvault.ts";
import { materialiseReceipt } from "../src/materialise.ts";
import { openPreview, PREVIEW_BACKFILL_LIMIT } from "../src/preview.ts";
import { backfillPreviews, PREVIEW_MAX_ATTEMPTS } from "../src/preview-backfill.ts";
import { seedDelivery } from "./fixtures/delivery.ts";
import { ROUTES } from "@mailda/contract/routes";

/**
 * Row projections (0068): the sender's display name and one sealed line of the body, written at ingest, caught
 * up by the backfill, opened by the listing only where the reader holds standing content read — and never a
 * reason for ingest, the backfill or the listing to fail.
 *
 * `test/node/preview.test.ts` holds the pure functions; this holds where they meet the Node.
 */

const testEnv = env as unknown as Env;
const ORG = "org_previews";
const MAILBOX = "mbx_previews";
const ADDRESS = "support@previews.example";
const ORIGIN = "https://node";
const ids = createSystemCtx();
const ANA = ids.id("usr");
const META = ids.id("usr");
const SUPERVISOR = ids.id("usr");
const ADMIN = ids.id("usr");

const WORDS = "Hello, the invoice INV-2041 is attached for your review.";

function raw(n: number, from = '"Aisha Rahman" <aisha@example.net>'): Bytes {
  return utf8([
    `From: ${from}`,
    `To: ${ADDRESS}`,
    `Subject: Invoice ${n}`,
    `Message-ID: <preview-${n}@example.net>`,
    "Date: Mon, 21 Sep 2026 09:00:00 +0000",
    "",
    WORDS,
    "> the message this one answers, which is not the preview",
  ].join("\r\n"));
}

let accepted = 0;
/** An accepted receipt, then ingest's own `materialiseReceipt`, as the queue consumer runs it. */
async function ingest(bytes: Bytes, onEnv: Env = testEnv): Promise<{ receiptId: string; messageId: string }> {
  accepted += 1;
  const receiptId = `rcpt_${String(accepted).padStart(26, "0")}`;
  const blobKey = `${ORG}/raw/${receiptId}.eml`;
  await putEvidence(testEnv, blobKey, bytes);
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
       blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(receiptId, ORG, `evt_${receiptId}`, "aisha@example.net", ADDRESS, bytes.length, blobKey, "0".repeat(64),
    new Date(Date.parse("2026-09-21T09:00:00.000Z") + accepted * 1000).toISOString()).run();
  const outcome = await materialiseReceipt(onEnv, createSystemCtx(), receiptId);
  return { receiptId, messageId: outcome.messageId! };
}

type Projection = {
  from_name: string | null; preview_sealed: string | null; preview_generation: number | null;
  preview_state: string; preview_attempts: number;
};
async function projection(messageId: string): Promise<Projection> {
  return (await testEnv.CATALOG.prepare(
    `SELECT from_name, preview_sealed, preview_generation, preview_state, preview_attempts
       FROM messages WHERE id = ?`,
  ).bind(messageId).first<Projection>())!;
}

async function opened(messageId: string): Promise<string | null> {
  const row = await projection(messageId);
  if (row.preview_sealed === null) return null;
  return openPreview(await contentOpeningKey(testEnv, row.preview_generation!), messageId, row.preview_sealed);
}

/** The Node's own vault, except that `sealingKey` fails: a cold or overloaded vault, for the seal only. */
function vaultThatWillNotSeal(): Env {
  const real = vault(testEnv);
  const stub = {
    openingKey: (purpose: "content", generation: number) => real.openingKey(purpose, generation),
    generations: (purpose: "content") => real.generations(purpose),
    sealingKey: () => Promise.reject(new Error("E_VAULT_UNAVAILABLE  the vault did not answer")),
  };
  return { ...testEnv, KEY_VAULT: { getByName: () => stub } } as unknown as Env;
}

/** The Node's own vault, except that nothing opens: what the listing meets when the vault is down. */
function vaultThatWillNotOpen(): Env {
  const stub = { openingKey: () => Promise.reject(new Error("E_VAULT_UNAVAILABLE  the vault did not answer")) };
  return { ...testEnv, KEY_VAULT: { getByName: () => stub } } as unknown as Env;
}

/** Evidence reads that throw for the named keys `times` times each, then read through. */
function evidenceThatFails(failing: Map<string, number>): Env {
  const real = testEnv.EVIDENCE;
  const bucket = {
    get: async (key: string) => {
      const left = failing.get(key) ?? 0;
      if (left > 0) {
        failing.set(key, left - 1);
        throw new Error("E_R2_UNAVAILABLE  the bucket did not answer");
      }
      return real.get(key);
    },
    head: (key: string) => real.head(key),
    put: (...args: Parameters<R2Bucket["put"]>) => real.put(...args),
  };
  return { ...testEnv, EVIDENCE: bucket } as unknown as Env;
}

async function cookieFor(userId: string): Promise<string> {
  return `${ACCESS_COOKIE}=${(await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId })).accessToken}`;
}

async function listed(credential: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const response = await SELF.fetch(`${ORIGIN}/api/messages`, { headers: credential });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as { messages: Array<Record<string, unknown>> }).messages;
}

async function tuple(subjectId: string, relation: string, objectType = "mailbox", objectId = MAILBOX) {
  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(createSystemCtx().id("rt"), ORG, subjectId, relation, objectType, objectId, new Date().toISOString()).run();
}

async function logs(event: string): Promise<Array<{ detail: string | null }>> {
  return (await testEnv.CATALOG.prepare("SELECT detail FROM log_entries WHERE event = ?").bind(event)
    .all<{ detail: string | null }>()).results;
}

beforeEach(async () => {
  for (const table of [
    "message_places", "message_reads", "message_search", "supervised_grants", "agents", "agent_actions",
    "relationship_tuples", "cases", "conversations", "mailbox_items", "messages", "ingress_receipts",
    "addresses", "mailboxes", "users", "node_claim", "audit_entries", "log_entries",
  ]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const at = new Date().toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('claim','x',?,?)")
      .bind(at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)")
      .bind("adr_previews", ORG, ADDRESS, MAILBOX, at),
    ...[ANA, META, SUPERVISOR, ADMIN].map((userId) => testEnv.CATALOG.prepare(
      "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
    ).bind(userId, ORG, `${userId.toLowerCase()}@previews.example`, at)),
  ]);
  await tuple(ANA, "mailbox.content.read");
  await tuple(META, "mailbox.metadata.read");
  await tuple(ADMIN, "org.admin", "organization", ORG);
  await testEnv.CATALOG.prepare(
    `INSERT INTO supervised_grants
       (id, org_id, subject_id, mailbox_id, scope, matter_id, requested_at, expires_at, granted_at)
     VALUES (?,?,?,?,'content',NULL,?,?,?)`,
  ).bind(createSystemCtx().id("sgr"), ORG, SUPERVISOR, MAILBOX, at, "2099-01-01T00:00:00.000Z", at).run();
});

describe("ingest projects the row", () => {
  it("writes the display name and a sealed preview, under the content key, with the words not in the row", async () => {
    const { messageId } = await ingest(raw(1));
    const row = await projection(messageId);
    expect(row.from_name).toBe("Aisha Rahman");
    expect(row.preview_state).toBe("projected");
    expect(row.preview_generation).toBeGreaterThanOrEqual(1);
    expect(row.preview_sealed).not.toBeNull();
    expect(row.preview_sealed!).not.toContain("invoice");
    expect(atob(row.preview_sealed!)).not.toContain("invoice");
    expect(await opened(messageId)).toBe(WORDS);
  });

  it("drops a display name shaped like an address, which is how a spoof would wear one", async () => {
    const { messageId } = await ingest(raw(2, '"ceo@whymelabs.test" <x@evil.example>'));
    expect((await projection(messageId)).from_name).toBeNull();
  });

  it("still files the message when the seal fails, owing the projection to the backfill", async () => {
    const { receiptId, messageId } = await ingest(raw(3), vaultThatWillNotSeal());
    const filed = await testEnv.CATALOG.prepare("SELECT id FROM messages WHERE ingress_receipt_id = ?")
      .bind(receiptId).first<{ id: string }>();
    expect(filed?.id).toBe(messageId);
    const row = await projection(messageId);
    expect([row.preview_state, row.preview_sealed, row.from_name]).toEqual(["pending", null, "Aisha Rahman"]);
    expect(await logs("preview.seal_failed")).toHaveLength(1);
    // And the backfill, with the vault back, projects it.
    expect((await backfillPreviews(testEnv, createSystemCtx())).projected).toBe(1);
    expect(await opened(messageId)).toBe(WORDS);
  });
});

describe("the listing opens a preview only for standing content read", () => {
  it("shows the preview and name to a content reader, the name alone to metadata and supervised readers", async () => {
    await ingest(raw(4));
    const [ana] = await listed({ cookie: await cookieFor(ANA) });
    expect([ana!.from_name, ana!.preview, ana!.standing_content]).toEqual(["Aisha Rahman", WORDS, 1]);
    // The sealed value and its generation never leave the Node.
    expect(Object.keys(ana!)).not.toContain("preview_sealed");
    expect(Object.keys(ana!)).not.toContain("preview_generation");

    for (const reader of [META, SUPERVISOR]) {
      const [row] = await listed({ cookie: await cookieFor(reader) });
      expect([row!.from_name, row!.preview, row!.standing_content], reader).toEqual(["Aisha Rahman", null, 0]);
    }
  });

  it("shows no preview to an agent whose sponsor no longer holds content read", async () => {
    await ingest(raw(5));
    await tuple(ANA, "message.export");
    await tuple(ANA, "mailbox.metadata.read");
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "reader", sponsorUserId: ANA, capabilities: ["mail.read"],
      grants: [
        { mailboxId: MAILBOX, relation: "mailbox.content.read" }, { mailboxId: MAILBOX, relation: "message.export" },
        { mailboxId: MAILBOX, relation: "mailbox.metadata.read" },
      ],
    });
    const agent = { authorization: `Bearer ${minted.token}` };
    expect((await listed(agent))[0]!.preview).toBe(WORDS);
    // The sponsor is a ceiling, live: without its content read, the agent's is not standing.
    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE subject_id = ? AND relation = 'mailbox.content.read'",
    ).bind(ANA).run();
    const [row] = await listed(agent);
    expect([row!.preview, row!.standing_content]).toEqual([null, 0]);
  });

  it("lists a tampered preview as none, and says so once", async () => {
    const { messageId } = await ingest(raw(6));
    const sealed = (await projection(messageId)).preview_sealed!;
    const bytes = Uint8Array.from(atob(sealed), (char) => char.charCodeAt(0));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await testEnv.CATALOG.prepare("UPDATE messages SET preview_sealed = ? WHERE id = ?")
      .bind(btoa(String.fromCharCode(...bytes)), messageId).run();
    const [row] = await listed({ cookie: await cookieFor(ANA) });
    expect(row!.preview).toBeNull();
    const warned = await logs("preview.unopenable");
    expect(warned).toHaveLength(1);
    expect(JSON.parse(warned[0]!.detail!).count).toBe(1);
  });

  it("answers the page when the vault will not open anything (R29)", async () => {
    await ingest(raw(7));
    await ingest(raw(8));
    const request = new Request(`${ORIGIN}/api/messages`, { headers: { cookie: await cookieFor(ANA) } });
    const execution = createExecutionContext();
    const response = await worker.fetch(request, vaultThatWillNotOpen(), execution);
    await waitOnExecutionContext(execution);
    expect(response.status).toBe(200);
    const page = await response.json() as { messages: Array<{ preview: string | null; subject: string }> };
    expect(page.messages.map((row) => [row.subject, row.preview])).toEqual([["Invoice 8", null], ["Invoice 7", null]]);
    const warned = await logs("preview.unopenable");
    expect(warned).toHaveLength(1);
    expect(JSON.parse(warned[0]!.detail!).count).toBe(2);
  });
});

describe("the backfill catches up, and never wedges", () => {
  it("picks up a row written without a projection, as an older code version writes it", async () => {
    const delivery = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId: MAILBOX, address: ADDRESS });
    expect((await projection(delivery.messageId)).preview_state).toBe("pending");
    const outcome = await backfillPreviews(testEnv, createSystemCtx());
    expect(outcome).toEqual({ projected: 1, retried: 0, failed: 0, reason: null });
    const row = await projection(delivery.messageId);
    expect(row.preview_state).toBe("projected");
    expect(await opened(delivery.messageId)).toBe("Where is my invoice?");
  });

  it("rides out a read that fails twice, gives up on one that always fails, and projects the rest meanwhile", async () => {
    const blip = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId: MAILBOX, address: ADDRESS });
    const broken = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId: MAILBOX, address: ADDRESS });
    const key = async (messageId: string) => (await testEnv.CATALOG.prepare("SELECT blob_key FROM messages WHERE id = ?")
      .bind(messageId).first<{ blob_key: string }>())!.blob_key;
    const failing = new Map([[await key(blip.messageId), 2], [await key(broken.messageId), 99]]);
    const flaky = evidenceThatFails(failing);

    const passes = [];
    for (let pass = 0; pass < PREVIEW_MAX_ATTEMPTS; pass++) {
      // An older message arrives between passes and is projected in the same pass as the failures.
      const older = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId: MAILBOX, address: ADDRESS });
      passes.push(await backfillPreviews(flaky, createSystemCtx()));
      expect((await projection(older.messageId)).preview_state, `pass ${pass}`).toBe("projected");
    }
    expect(passes.map((one) => [one.projected, one.retried, one.failed])).toEqual([[1, 2, 0], [1, 2, 0], [2, 0, 1]]);
    expect(passes[0]!.reason).toContain("E_R2_UNAVAILABLE");
    expect((await projection(blip.messageId)).preview_state).toBe("projected");
    expect((await projection(broken.messageId))).toMatchObject({ preview_state: "failed", preview_attempts: 3 });
    // Terminal: the next pass does not touch it.
    expect(await backfillPreviews(flaky, createSystemCtx())).toEqual({ projected: 0, retried: 0, failed: 0, reason: null });
  });

  it("marks a message whose evidence is gone as failed at once, rather than retrying lost mail", async () => {
    const lost = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId: MAILBOX, address: ADDRESS });
    const { blob_key: blobKey } = (await testEnv.CATALOG.prepare("SELECT blob_key FROM messages WHERE id = ?")
      .bind(lost.messageId).first<{ blob_key: string }>())!;
    await testEnv.EVIDENCE.delete(blobKey);
    const outcome = await backfillPreviews(testEnv, createSystemCtx());
    expect([outcome.projected, outcome.retried, outcome.failed]).toEqual([0, 0, 1]);
    expect(outcome.reason).toContain("E_EVIDENCE_MISSING");
    expect((await projection(lost.messageId))).toMatchObject({ preview_state: "failed", preview_attempts: 0 });
  });

  it("puts the previews it gave up on back in its queue, once the fault is over, through the route doctor names", async () => {
    const key = async (messageId: string) => (await testEnv.CATALOG.prepare("SELECT blob_key FROM messages WHERE id = ?")
      .bind(messageId).first<{ blob_key: string }>())!.blob_key;
    // An outage that outlasts every attempt, and a message whose evidence is really gone.
    const outage = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId: MAILBOX, address: ADDRESS });
    const lost = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId: MAILBOX, address: ADDRESS });
    await testEnv.EVIDENCE.delete(await key(lost.messageId));
    const down = evidenceThatFails(new Map([[await key(outage.messageId), 99]]));
    for (let pass = 0; pass < PREVIEW_MAX_ATTEMPTS; pass++) await backfillPreviews(down, createSystemCtx());
    // Another organization's failure, which this organization's administrator does not put back.
    const elsewhere = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId: MAILBOX, address: ADDRESS });
    await testEnv.CATALOG.prepare("UPDATE messages SET org_id = 'org_elsewhere', preview_state = 'failed' WHERE id = ?")
      .bind(elsewhere.messageId).run();
    expect([(await projection(outage.messageId)).preview_state, (await projection(lost.messageId)).preview_state])
      .toEqual(["failed", "failed"]);

    // The remedy doctor names is a registered route, and it is the one called below.
    const finding = (await runDoctor(testEnv, createSystemCtx())).findings.find((one) => one.check === "preview_backlog")!;
    const REQUEUE = "POST /api/maintenance/requeue-previews";
    expect(finding.fix).toContain(REQUEUE);
    expect(ROUTES.some((spec) => `${spec.method} ${spec.path}` === REQUEUE)).toBe(true);

    const requeue = (userId: string) => cookieFor(userId).then((cookie) => SELF.fetch(
      `${ORIGIN}/api/maintenance/requeue-previews`, { method: "POST", headers: { cookie } },
    ));
    expect((await requeue(ANA)).status, "a member put the organization's previews back").toBe(403);
    const answered = await requeue(ADMIN);
    expect(answered.status, await answered.clone().text()).toBe(200);
    const answer = await answered.json() as { requeued: number; message: string };
    expect(answer.requeued).toBe(2);
    // The pace is the constant's, so a changed limit changes the sentence rather than leaving it to drift.
    expect(answer.message).toContain(`projects up to ${PREVIEW_BACKFILL_LIMIT} on each scheduled pass`);
    expect((await projection(elsewhere.messageId)).preview_state, "another organization's row was put back")
      .toBe("failed");

    // The outage is over: the next pass projects the one it gave up on; lost mail is back to failed at once.
    const outcome = await backfillPreviews(testEnv, createSystemCtx());
    expect([outcome.projected, outcome.retried, outcome.failed]).toEqual([1, 0, 1]);
    expect(await opened(outage.messageId)).toBe("Where is my invoice?");
    expect(await projection(lost.messageId)).toMatchObject({ preview_state: "failed", preview_attempts: 0 });
  });

  it("rebuilds every projection from the evidence alone", async () => {
    const first = await ingest(raw(9));
    const second = await ingest(raw(10, "Ben Okafor <ben@example.net>"));
    const before = [
      [(await projection(first.messageId)).from_name, await opened(first.messageId)],
      [(await projection(second.messageId)).from_name, await opened(second.messageId)],
    ];
    await testEnv.CATALOG.prepare(
      "UPDATE messages SET preview_state = 'pending', preview_attempts = 0, preview_sealed = NULL, from_name = NULL",
    ).run();
    expect((await backfillPreviews(testEnv, createSystemCtx())).projected).toBe(2);
    expect([
      [(await projection(first.messageId)).from_name, await opened(first.messageId)],
      [(await projection(second.messageId)).from_name, await opened(second.messageId)],
    ]).toEqual(before);
    expect(before).toEqual([["Aisha Rahman", WORDS], ["Ben Okafor", WORDS]]);
  });
});

describe("the cron runs the pass only once the other R2-reading passes are idle", () => {
  async function cron(): Promise<void> {
    const execution = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "*/1 * * * *", noRetry: () => undefined } as ScheduledController,
      testEnv,
      execution,
    );
    await waitOnExecutionContext(execution);
  }

  it("waits a minute while the body and authentication backfills have work, then projects", async () => {
    // Written as an older code version would: the body index and the sender verdict are both owed too.
    const delivery = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId: MAILBOX, address: ADDRESS });
    await cron();
    expect((await projection(delivery.messageId)).preview_state, "the preview pass ran beside busy passes")
      .toBe("pending");
    await cron();
    expect((await projection(delivery.messageId)).preview_state).toBe("projected");
    expect(await logs("preview.backfilled")).toHaveLength(1);
  });
});

describe("doctor reports the backlog", () => {
  it("counts pending and failed, and is not ok only when something failed", async () => {
    const find = async (ctx: Ctx) => (await runDoctor(testEnv, ctx)).findings.find((one) => one.check === "preview_backlog")!;
    const pending = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId: MAILBOX, address: ADDRESS });
    const waiting = await find(createSystemCtx());
    expect(waiting.ok).toBe(true);
    expect(waiting.detail).toContain("1 message has no row preview");
    expect(waiting.detail).toContain(`projects up to ${PREVIEW_BACKFILL_LIMIT} on each scheduled pass`);

    await testEnv.CATALOG.prepare("UPDATE messages SET preview_state = 'failed' WHERE id = ?").bind(pending.messageId).run();
    const failed = await find(createSystemCtx());
    expect(failed.ok).toBe(false);
    expect(failed.severity).toBe("report");
    expect(failed.detail).toContain("1 could not be projected");
    // Not "their evidence could not be read" alone: a vault or storage fault spends the attempts too.
    expect(failed.detail).toContain("reading it failed on every attempt");

    await testEnv.CATALOG.prepare("UPDATE messages SET preview_state = 'projected'").run();
    const clear = await find(createSystemCtx());
    expect([clear.ok, clear.detail]).toEqual([true, "Every message on this Node has its row preview and sender name."]);
  });
});
