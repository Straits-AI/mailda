import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { type Bytes, utf8 } from "@mailda/evidence";

import { putEvidence } from "../src/evidence-store.ts";
import { materialiseReceipt } from "../src/materialise.ts";
import { holdDelivery, releaseQuarantine, listQuarantined } from "../src/quarantine.ts";
import { ACCESS_COOKIE, issueSession } from "../src/auth/session.ts";

/**
 * The decision in `materialise` (0056): a delivery is held back when — and only when — the sender's domain
 * disowned it *and* asked receivers to act *and* the mailbox asked for that. Each conjunct is a case below
 * that must not quarantine, so removing any one of the three tests from the code fails here.
 */
const testEnv = env as unknown as Env;
const ORG = "org_quarantine";
const ADMIN = "usr_quarantine_admin";
const ON = { id: "mbx_quarantine_on", address: "on@quarantine.example" };
const OFF = { id: "mbx_quarantine_off", address: "off@quarantine.example" };
/** Switch two (0057): dangerous attachments, and not DMARC. */
const FILES = { id: "mbx_quarantine_files", address: "files@quarantine.example" };

const DISOWNED = "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=bank.test; "
  + "dmarc=fail header.from=bank.test policy.dmarc=reject; spf=fail smtp.mailfrom=x@bank.test";
const DISOWNED_P_NONE = DISOWNED.replace("policy.dmarc=reject", "policy.dmarc=none");
const PASSED = "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=bank.test; "
  + "dmarc=pass header.from=bank.test policy.dmarc=reject; spf=pass smtp.mailfrom=x@bank.test";
const MZ = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");

/** A multipart message with one attached part, base64 so the bytes are exactly what the test says. */
function withAttachment(filename: string, mimeType: string, bytes: Uint8Array): string[] {
  const b64 = btoa(String.fromCharCode(...bytes));
  return [
    "MIME-Version: 1.0", "Content-Type: multipart/mixed; boundary=\"b\"", "", "--b",
    "Content-Type: text/plain", "", "See attached.", "", "--b",
    `Content-Type: ${mimeType}; name="${filename}"`, "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`, "", b64, "--b--",
  ];
}

function raw(authHeader: string, to: string, n: number, attachment?: string[]): Bytes {
  return utf8([
    authHeader, "From: Bank <x@bank.test>", `To: ${to}`, "Subject: Your account",
    `Message-ID: <q-${n}@bank.test>`, "Date: Mon, 3 Aug 2026 12:00:00 +0000",
    ...(attachment ?? ["", "body"]),
  ].join("\r\n"));
}

let n = 0;
async function accept(authHeader: string, to: string, attachment?: string[]): Promise<string> {
  const ctx = createSystemCtx();
  n += 1;
  const id = `rcpt_quarantine_${String(n).padStart(16, "0")}`;
  const bytes = raw(authHeader, to, n, attachment);
  await putEvidence(testEnv, `${ORG}/raw/2026-Q3/${id}.eml`, bytes);
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
       blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(id, ORG, `evt_${id}`, "x@bank.test", to, bytes.length,
    `${ORG}/raw/2026-Q3/${id}.eml`, "0".repeat(64), new Date(ctx.now()).toISOString()).run();
  return id;
}

async function row(receiptId: string) {
  return (await testEnv.CATALOG.prepare(
    `SELECT m.id, m.quarantined_at, m.quarantine_reason, m.quarantine_note, m.attachments, m.attachments_dangerous,
            (SELECT COUNT(*) FROM cases c WHERE c.conversation_id = m.conversation_id) AS cases
       FROM messages m WHERE m.ingress_receipt_id = ?`,
  ).bind(receiptId).first<{
    id: string; quarantined_at: string | null; quarantine_reason: string | null; quarantine_note: string | null; cases: number;
    attachments: number | null; attachments_dangerous: number | null;
  }>())!;
}

async function listedReceipts(): Promise<string[]> {
  const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId: ADMIN });
  const response = await SELF.fetch("https://node/api/messages", {
    headers: { cookie: `${ACCESS_COOKIE}=${session.accessToken}` },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { messages: Array<{ id: string }> };
  return body.messages.map((one) => one.id);
}

beforeAll(async () => {
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT OR IGNORE INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(ADMIN, ORG, "admin@quarantine.example", at),
    testEnv.CATALOG.prepare(
      "INSERT OR IGNORE INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('clm_quarantine','x',?,?)",
    ).bind(at, ORG),
    testEnv.CATALOG.prepare(
      `INSERT OR IGNORE INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'org.admin','organization',?,?)`,
    ).bind(ctx.id("rt"), ORG, ADMIN, ORG, at),
    ...[ON, OFF, FILES].flatMap((box) => [
      testEnv.CATALOG.prepare(
        `INSERT OR IGNORE INTO mailboxes (id, org_id, name, created_at, quarantine_dmarc_fail,
           quarantine_dangerous_attachments) VALUES (?,?,?,?,?,?)`,
      ).bind(box.id, ORG, box.id, at, box === ON ? 1 : 0, box === FILES ? 1 : 0),
      testEnv.CATALOG.prepare(
        "INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("addr"), ORG, box.address, box.id, at),
      testEnv.CATALOG.prepare(
        `INSERT OR IGNORE INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,'mailbox.content.read','mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, ADMIN, box.id, at),
    ]),
  ]);
});

describe("a mailbox that asked for it holds back a delivery its sender's domain disowned (0056), or a dangerous file (0057)", () => {
  it("quarantines: no case, hidden from the listing, audited, and release undoes all three", async () => {
    const ctx = createSystemCtx();
    const id = await accept(DISOWNED, ON.address);
    const outcome = await materialiseReceipt(testEnv, ctx, id);
    expect(outcome).toMatchObject({ status: "created", quarantined: true });

    const held = await row(id);
    expect(held.quarantined_at).not.toBeNull();
    expect(held.quarantine_reason).toBe("dmarc_fail_reject");
    expect(held.cases).toBe(0);
    expect(await listedReceipts()).not.toContain(id);
    const audited = await testEnv.CATALOG.prepare(
      "SELECT action FROM audit_entries WHERE org_id = ? AND subject = ? ORDER BY seq",
    ).bind(ORG, held.id).all<{ action: string }>();
    expect(audited.results.map((one) => one.action)).toEqual(["message.quarantined"]);

    // Hidden by id as well as from the listing: the body route answers as it does for an absent message.
    const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId: ADMIN });
    const direct = await SELF.fetch(`https://node/api/messages/${id}/body`, {
      headers: { cookie: `${ACCESS_COOKIE}=${session.accessToken}` },
    });
    expect(direct.status).toBe(404);
    const listed = await listQuarantined(testEnv, ORG, ADMIN);
    expect(listed.map((one) => one.messageId)).toContain(held.id);
    expect(listed.find((one) => one.messageId === held.id)).toMatchObject({
      mailboxId: ON.id, fromDomain: "bank.test", dmarcPolicy: "reject", receiptId: id,
    });

    await releaseQuarantine(testEnv, ctx, ORG, ADMIN, held.id);
    const released = await row(id);
    expect(released.quarantined_at).toBeNull();
    // The reason stays: a released message was once held, and the row says so.
    expect(released.quarantine_reason).toBe("dmarc_fail_reject");
    expect(released.cases).toBe(1);
    expect(await listedReceipts()).toContain(id);
    expect((await SELF.fetch(`https://node/api/messages/${id}/body`, {
      headers: { cookie: `${ACCESS_COOKIE}=${session.accessToken}` },
    })).status).toBe(200);
    expect((await listQuarantined(testEnv, ORG, ADMIN)).map((one) => one.messageId)).not.toContain(held.id);
    // A second release is a 404, not a second case.
    await expect(releaseQuarantine(testEnv, ctx, ORG, ADMIN, held.id)).rejects.toThrow(/E_NOT_QUARANTINED/);
    expect((await row(id)).cases).toBe(1);
  });

  it("does not quarantine when the switch is off, however bad the verdict", async () => {
    const id = await accept(DISOWNED, OFF.address);
    expect(await materialiseReceipt(testEnv, createSystemCtx(), id)).not.toHaveProperty("quarantined");
    expect(await row(id)).toMatchObject({ quarantined_at: null, quarantine_reason: null, cases: 1 });
  });

  it("does not quarantine a failure from a domain that published p=none", async () => {
    const id = await accept(DISOWNED_P_NONE, ON.address);
    await materialiseReceipt(testEnv, createSystemCtx(), id);
    expect(await row(id)).toMatchObject({ quarantined_at: null, cases: 1 });
  });

  it("does not quarantine a pass from a domain that publishes p=reject", async () => {
    const id = await accept(PASSED, ON.address);
    await materialiseReceipt(testEnv, createSystemCtx(), id);
    expect(await row(id)).toMatchObject({ quarantined_at: null, cases: 1 });
  });

  it("counts what was attached on every delivery, judged, and nobody's switch changes the count", async () => {
    const id = await accept(PASSED, OFF.address, withAttachment("setup.exe", "application/octet-stream", MZ));
    await materialiseReceipt(testEnv, createSystemCtx(), id);
    expect(await row(id)).toMatchObject({ attachments: 1, attachments_dangerous: 1, quarantined_at: null, cases: 1 });
    const none = await accept(PASSED, OFF.address);
    await materialiseReceipt(testEnv, createSystemCtx(), none);
    expect(await row(none)).toMatchObject({ attachments: 0, attachments_dangerous: 0 });
  });

  it("holds back a program under a document's name when the attachment switch is on, and not a real document", async () => {
    const disguised = await accept(PASSED, FILES.address, withAttachment("invoice.pdf", "application/pdf", MZ));
    expect(await materialiseReceipt(testEnv, createSystemCtx(), disguised)).toMatchObject({ quarantined: true });
    expect(await row(disguised)).toMatchObject({
      attachments: 1, attachments_dangerous: 1, quarantine_reason: "attachment_dangerous", cases: 0,
    });
    const listed = await listQuarantined(testEnv, ORG, ADMIN);
    expect(listed.find((one) => one.receiptId === disguised)).toMatchObject({ reason: "attachment_dangerous", mailboxId: FILES.id });

    const document = await accept(PASSED, FILES.address, withAttachment("invoice.pdf", "application/pdf", PDF));
    await materialiseReceipt(testEnv, createSystemCtx(), document);
    expect(await row(document)).toMatchObject({ attachments: 1, attachments_dangerous: 0, quarantined_at: null, cases: 1 });

    // The sender's domain speaks first: a disowned message with a dangerous file is held for the DMARC reason.
    const both = await accept(DISOWNED, ON.address, withAttachment("setup.exe", "application/octet-stream", MZ));
    await materialiseReceipt(testEnv, createSystemCtx(), both);
    expect(await row(both)).toMatchObject({ quarantine_reason: "dmarc_fail_reject", attachments_dangerous: 1 });
  });

  it("serves one part's bytes by ordinal, as octet-stream when the part was judged dangerous, and records the export", async () => {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      `INSERT OR IGNORE INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'message.export','mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, ADMIN, OFF.id, new Date(ctx.now()).toISOString()).run();
    const id = await accept(PASSED, OFF.address, withAttachment("invoice.pdf", "application/pdf", MZ));
    await materialiseReceipt(testEnv, ctx, id);
    const session = await issueSession(testEnv, ctx, { orgId: ORG, userId: ADMIN });
    const headers = { cookie: `${ACCESS_COOKIE}=${session.accessToken}` };
    const part = await SELF.fetch(`https://node/api/messages/${id}/attachments/0`, { headers });
    expect(part.status).toBe(200);
    expect(part.headers.get("content-type")).toBe("application/octet-stream");
    expect(part.headers.get("content-disposition")).toBe('attachment; filename="invoice.pdf"');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(MZ);
    expect((await SELF.fetch(`https://node/api/messages/${id}/attachments/1`, { headers })).status).toBe(404);
    const exported = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE action = 'message.exported' AND subject = ?")
      .bind(id).first<{ n: number }>();
    expect(exported?.n).toBe(1);
  });

  it("lists the parts on the body route, judged, and carries none of their bytes", async () => {
    const id = await accept(PASSED, OFF.address, withAttachment("invoice.pdf", "application/pdf", MZ));
    await materialiseReceipt(testEnv, createSystemCtx(), id);
    const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId: ADMIN });
    const response = await SELF.fetch(`https://node/api/messages/${id}/body`, {
      headers: { cookie: `${ACCESS_COOKIE}=${session.accessToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { attachments: unknown[]; text: string | null };
    expect(body.attachments).toEqual([
      { filename: "invoice.pdf", declaredType: "application/pdf", bytes: MZ.length, verdict: "disguised" },
    ]);
    expect(body.text).toContain("See attached.");
  });
});

describe("held on request (0064, #263): the act a customer's own classifier reaches", () => {
  it("holds a filed delivery with a reason, hides it, audits the score, and release undoes it", async () => {
    const ctx = createSystemCtx();
    const id = await accept(PASSED, OFF.address);
    expect(await materialiseReceipt(testEnv, ctx, id)).toMatchObject({ status: "created" });
    const filed = await row(id);
    expect(filed.quarantined_at).toBeNull();
    expect(await listedReceipts()).toContain(id);

    const held = await holdDelivery(testEnv, ctx, ORG, ADMIN, filed.id, {
      reason: "nearest neighbours are three released phishing messages", score: 0.91,
    });
    expect(held).toEqual({ held: true, messageId: filed.id, mailboxId: OFF.id });
    expect(await row(id)).toMatchObject({ quarantine_reason: "held" });
    expect(await listedReceipts()).not.toContain(id);
    const listed = (await listQuarantined(testEnv, ORG, ADMIN)).find((one) => one.messageId === filed.id);
    expect(listed).toMatchObject({
      reason: "held", note: "nearest neighbours are three released phishing messages", mailboxId: OFF.id,
    });
    const audited = await testEnv.CATALOG.prepare(
      "SELECT action, detail FROM audit_entries WHERE org_id = ? AND subject = ? ORDER BY seq",
    ).bind(ORG, filed.id).all<{ action: string; detail: string }>();
    expect(audited.results.map((one) => one.action)).toEqual(["message.held"]);
    expect(JSON.parse(audited.results[0]!.detail)).toMatchObject({ score: 0.91, mailboxId: OFF.id });

    // A held message is hidden by id, so a second hold cannot see it and cannot overwrite the first reason.
    await expect(holdDelivery(testEnv, ctx, ORG, ADMIN, filed.id, { reason: "again", score: null }))
      .rejects.toThrow(/E_NO_SUCH_MESSAGE/);
    expect((await row(id)).quarantine_note).toBe("nearest neighbours are three released phishing messages");

    await releaseQuarantine(testEnv, ctx, ORG, ADMIN, filed.id);
    expect((await row(id)).quarantined_at).toBeNull();
    expect(await listedReceipts()).toContain(id);
  });

  it("answers 404 for a message the holder may not read, the same as for one that does not exist", async () => {
    const ctx = createSystemCtx();
    const id = await accept(PASSED, OFF.address);
    await materialiseReceipt(testEnv, ctx, id);
    const stranger = "usr_quarantine_stranger";
    await testEnv.CATALOG.prepare("INSERT OR IGNORE INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(stranger, ORG, "stranger@quarantine.example", new Date(ctx.now()).toISOString()).run();
    await expect(holdDelivery(testEnv, ctx, ORG, stranger, (await row(id)).id, { reason: "x", score: null }))
      .rejects.toThrow(/E_NO_SUCH_MESSAGE/);
    await expect(holdDelivery(testEnv, ctx, ORG, ADMIN, "msg_nope", { reason: "x", score: null }))
      .rejects.toThrow(/E_NO_SUCH_MESSAGE/);
    expect((await row(id)).quarantined_at).toBeNull();
  });
});
