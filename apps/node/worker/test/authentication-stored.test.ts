import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { type Bytes, utf8 } from "@mailda/evidence";

import { putEvidence } from "../src/evidence-store.ts";
import { materialiseReceipt } from "../src/materialise.ts";
import { backfillAuthentication } from "../src/authentication-backfill.ts";

const testEnv = env as unknown as Env;
const ORG = "org_authres";
const ADDRESS = "in@authres.example";

/** A message as Cloudflare's MX hands it over: its own Authentication-Results first, the sender's after. */
function raw(authHeader: string | null): Bytes {
  return utf8([
    ...(authHeader === null ? [] : [authHeader]),
    "Authentication-Results: mx.somebody-else.test; dmarc=pass header.from=bank.test",
    "From: Alice <alice@gmail.com>",
    `To: ${ADDRESS}`,
    "Subject: Authenticated?",
    "Message-ID: <a-1@gmail.com>",
    "Date: Mon, 3 Aug 2026 12:00:00 +0000",
    "",
    "body",
  ].join("\r\n"));
}

async function accept(id: string, bytes: Bytes): Promise<string> {
  const ctx = createSystemCtx();
  await putEvidence(testEnv, `${ORG}/raw/2026-Q3/${id}.eml`, bytes);
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
       blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(id, ORG, `evt_${id}`, "alice@gmail.com", ADDRESS, bytes.length,
    `${ORG}/raw/2026-Q3/${id}.eml`, "0".repeat(64), new Date(ctx.now()).toISOString()).run();
  return id;
}

async function stored(receiptId: string) {
  return await testEnv.CATALOG.prepare(
    `SELECT auth_spf, auth_dkim, auth_dmarc, auth_dmarc_policy, auth_from_domain
       FROM messages WHERE ingress_receipt_id = ?`,
  ).bind(receiptId).first<Record<string, string | null>>();
}

beforeAll(async () => {
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT OR IGNORE INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind("mbx_authres", ORG, "Auth", at),
    testEnv.CATALOG.prepare(
      "INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, "mbx_authres", at),
  ]);
});

describe("the receiving server's verdict is stored with the message (0055)", () => {
  it("stores what mx.cloudflare.net said, and not what another header claims", async () => {
    const ctx = createSystemCtx();
    const id = await accept("rcpt_authres_pass000000000001", raw(
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com; "
      + "dmarc=fail header.from=gmail.com policy.dmarc=reject; spf=softfail smtp.mailfrom=alice@gmail.com",
    ));
    expect((await materialiseReceipt(testEnv, ctx, id)).status).toBe("created");
    expect(await stored(id)).toEqual({
      auth_spf: "softfail", auth_dkim: "pass", auth_dmarc: "fail",
      auth_dmarc_policy: "reject", auth_from_domain: "gmail.com",
    });
  });

  it("stores absent, not null, when no header from the receiving server is there", async () => {
    // Null is "nobody looked" — a message from before 0055. Absent is "looked, and it is not there".
    const ctx = createSystemCtx();
    const id = await accept("rcpt_authres_absent0000000001", raw(null));
    expect((await materialiseReceipt(testEnv, ctx, id)).status).toBe("created");
    expect(await stored(id)).toEqual({
      auth_spf: "absent", auth_dkim: "absent", auth_dmarc: "absent",
      auth_dmarc_policy: null, auth_from_domain: null,
    });
  });

  it("evaluates a message from before 0055 from the cron, and leaves an evaluated one alone", async () => {
    const ctx = createSystemCtx();
    const old = await accept("rcpt_authres_backfill00000001", raw(
      "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=gmail.com policy.dmarc=none; "
      + "spf=pass smtp.mailfrom=alice@gmail.com; dkim=pass header.d=gmail.com",
    ));
    expect((await materialiseReceipt(testEnv, ctx, old)).status).toBe("created");
    // What a pre-0055 row looks like: materialised, and nobody looked.
    await testEnv.CATALOG.prepare(
      "UPDATE messages SET auth_spf = NULL, auth_dkim = NULL, auth_dmarc = NULL, auth_dmarc_policy = NULL, "
      + "auth_from_domain = NULL WHERE ingress_receipt_id = ?",
    ).bind(old).run();
    expect((await stored(old))?.auth_dmarc).toBeNull();

    const evaluated = await backfillAuthentication(testEnv, ctx);
    expect(evaluated).toBeGreaterThanOrEqual(1);
    expect(await stored(old)).toEqual({
      auth_spf: "pass", auth_dkim: "pass", auth_dmarc: "pass", auth_dmarc_policy: "none", auth_from_domain: "gmail.com",
    });
    // Nothing left to evaluate in this organization's slice: a second pass writes nothing.
    expect(await backfillAuthentication(testEnv, ctx)).toBe(0);
  });
});

