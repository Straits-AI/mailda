import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { type Bytes, utf8 } from "@mailda/evidence";

import { putEvidence } from "../src/evidence-store.ts";
import { materialiseReceipt } from "../src/materialise.ts";
import { releaseQuarantine, listQuarantined } from "../src/quarantine.ts";
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

const DISOWNED = "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=bank.test; "
  + "dmarc=fail header.from=bank.test policy.dmarc=reject; spf=fail smtp.mailfrom=x@bank.test";
const DISOWNED_P_NONE = DISOWNED.replace("policy.dmarc=reject", "policy.dmarc=none");
const PASSED = "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=bank.test; "
  + "dmarc=pass header.from=bank.test policy.dmarc=reject; spf=pass smtp.mailfrom=x@bank.test";

function raw(authHeader: string, to: string, n: number): Bytes {
  return utf8([
    authHeader, "From: Bank <x@bank.test>", `To: ${to}`, "Subject: Your account",
    `Message-ID: <q-${n}@bank.test>`, "Date: Mon, 3 Aug 2026 12:00:00 +0000", "", "body",
  ].join("\r\n"));
}

let n = 0;
async function accept(authHeader: string, to: string): Promise<string> {
  const ctx = createSystemCtx();
  n += 1;
  const id = `rcpt_quarantine_${String(n).padStart(16, "0")}`;
  const bytes = raw(authHeader, to, n);
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
    `SELECT m.id, m.quarantined_at, m.quarantine_reason,
            (SELECT COUNT(*) FROM cases c WHERE c.conversation_id = m.conversation_id) AS cases
       FROM messages m WHERE m.ingress_receipt_id = ?`,
  ).bind(receiptId).first<{ id: string; quarantined_at: string | null; quarantine_reason: string | null; cases: number }>())!;
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
    ...[ON, OFF].flatMap((box) => [
      testEnv.CATALOG.prepare(
        "INSERT OR IGNORE INTO mailboxes (id, org_id, name, created_at, quarantine_dmarc_fail) VALUES (?,?,?,?,?)",
      ).bind(box.id, ORG, box.id, at, box === ON ? 1 : 0),
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

describe("a mailbox that asked for it holds back a delivery its sender's domain disowned (0056)", () => {
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
});
