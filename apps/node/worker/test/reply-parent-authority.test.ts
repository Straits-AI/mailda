import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { utf8 } from "@mailda/evidence";
import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { putEvidence } from "../src/evidence-store.ts";
import { sealManifest } from "../src/outbound/manifest.ts";
import { CallerError } from "../src/errors.ts";

/**
 * May you thread a reply onto a message you cannot read?
 *
 * ## The claim that was not enforced
 *
 * `sealManifest`'s own comment says *"a reply threads onto a message the author can see"*. The check behind
 * it was `SELECT … FROM messages WHERE org_id = ? AND id = ?` — **organization membership, not read
 * authority.** `messages` carries no mailbox column and `mailbox_items` was never consulted, so a principal
 * holding `send.propose` on one mailbox and nothing at all on another could name a message delivered only
 * into the second and receive its `References` chain and its Message-ID, persisted in
 * `send_manifests.references_header` and emitted on the wire.
 *
 * Two things keep this smaller than it sounds, and both are worth stating so the fix is not oversold.
 * **Only Message-ID strings escape** — no subject, no sender, no body — which is materially less than the
 * `queueFor` defect that returned subject lines and sender addresses for a whole mailbox. And it is **not
 * enumerable**: `listMessages` is the only path in `src/` that hands a `msg_` id to a caller and it is
 * bounded inside its SQL by `mailbox.content.read`, so an id has to be acquired out of band.
 *
 * Two consequences that are worse than the disclosure itself. The emitted `In-Reply-To` and `References`
 * **inject the reply into the foreign thread** in any external participant's mail client. And the difference
 * between `E_NO_SUCH_PARENT` and success is an **org-wide existence oracle** for a `send.propose`-only
 * holder, which is exactly the §5C property the error was written to protect.
 *
 * So the parent is now resolved through the same authority `listMessages` uses — `mailbox.content.read` on
 * the mailbox the parent was delivered into, reached by `ingress_receipts.envelope_to → addresses` — and the
 * refusal stays `E_NO_SUCH_PARENT`, because §5C requires an invisible thing and an absent one to answer
 * alike.
 */

const testEnv = env as unknown as Env;
const ORG = "org_parent_authz";
const SUPPORT = "mbx_support";
const HR = "mbx_hr";
const SUPPORT_ADDRESS = "support@acme.example";
const HR_ADDRESS = "hr@acme.example";
const RESPONDER = "usr_responder";
const READER = "usr_reader";
const HR_RFC_ID = "<redundancies@candidate.example>";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

function grant(ctx: Ctx, userId: string, relation: string, mailboxId: string) {
  return testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,'mailbox',?,?)`,
  ).bind(ctx.id("rt"), ORG, userId, relation, mailboxId, new Date(ctx.now()).toISOString());
}

/** A message delivered into `mailboxId`, with real evidence so `rebuildReferences` has bytes to read. */
async function aDelivery(ctx: Ctx, mailboxId: string, address: string, rfcId: string): Promise<string> {
  const at = new Date(ctx.now()).toISOString();
  const raw = utf8(
    `Message-ID: ${rfcId}\r\nReferences: <root-secret@candidate.example>\r\n` +
    `From: candidate@example.net\r\nSubject: Confidential\r\n\r\nBody.\r\n`,
  );
  const stored = await putEvidence(testEnv, `${ORG}/parent-${mailboxId}.eml`, raw);
  const receiptId = ctx.id("ir");
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, envelope_from, envelope_to, raw_bytes, accepted_at,
                                   blob_key, blob_sha256, provider_event_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(receiptId, ORG, "candidate@example.net", address, raw.byteLength, at,
    stored.blobKey, stored.plaintextSha256, ctx.id("pe")).run();

  const messageId = ctx.id("msg");
  await testEnv.CATALOG.prepare(
    `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
                           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
                           created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(messageId, ORG, "2026-08", stored.blobKey, stored.plaintextSha256, raw.byteLength, rfcId, ctx.id("thr"),
    "Confidential", "candidate@example.net", at, at, receiptId, at).run();
  return messageId;
}

beforeEach(async () => {
  for (const table of ["messages", "ingress_receipts", "relationship_tuples", "mailboxes", "addresses",
                       "send_manifests", "send_recipients", "send_counters", "audit_entries", "outbox",
                       "conversations", "cases"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(SUPPORT, ORG, "Support", at),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(HR, ORG, "HR", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, SUPPORT_ADDRESS, SUPPORT, at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, HR_ADDRESS, HR, at),
    // The responder can send as Support and read Support. Nothing on HR at all.
    grant(ctx, RESPONDER, "send.propose", SUPPORT),
    grant(ctx, RESPONDER, "mailbox.content.read", SUPPORT),
    // The reader can do both on HR, so the positive case has somebody legitimate to be.
    grant(ctx, READER, "send.propose", HR),
    grant(ctx, READER, "mailbox.content.read", HR),
  ]);
});

const reply = (inReplyToMessageId: string, mailboxId: string, author: string) => ({
  mailboxId,
  authorUserId: author,
  to: ["customer@example.net"],
  subject: "Re: Confidential",
  bodyTyped: "Threading onto something.",
  fidelity: "authored" as const,
  inReplyToMessageId,
});

describe("threading a reply requires read authority on the parent, not merely the same organization", () => {
  it("refuses a parent delivered into a mailbox the author cannot read", async () => {
    const ctx = atTime(2_300_000_000_000);
    const hrMessage = await aDelivery(ctx, HR, HR_ADDRESS, HR_RFC_ID);

    // The responder holds send.propose on Support and nothing on HR.
    await expect(
      sealManifest(testEnv, atTime(2_300_000_001_000), ORG, reply(hrMessage, SUPPORT, RESPONDER)),
    ).rejects.toThrow(CallerError);
  });

  it("answers not-found rather than forbidden, so it is not an existence oracle", async () => {
    // §5C: an invisible thing and an absent one answer alike. Otherwise the difference between the two
    // tells a send.propose-only holder which message ids exist anywhere in the organization.
    const ctx = atTime(2_300_000_000_000);
    const hrMessage = await aDelivery(ctx, HR, HR_ADDRESS, HR_RFC_ID);

    const invisible = await sealManifest(
      testEnv, atTime(2_300_000_001_000), ORG, reply(hrMessage, SUPPORT, RESPONDER),
    ).catch((error: unknown) => error as CallerError);
    const absent = await sealManifest(
      testEnv, atTime(2_300_000_002_000), ORG, reply("msg_DOES_NOT_EXIST", SUPPORT, RESPONDER),
    ).catch((error: unknown) => error as CallerError);

    expect((invisible as CallerError).code).toBe((absent as CallerError).code);
    expect((invisible as CallerError).status).toBe((absent as CallerError).status);
  });

  it("does not leak the parent's Message-ID or References chain in the refusal", async () => {
    const ctx = atTime(2_300_000_000_000);
    const hrMessage = await aDelivery(ctx, HR, HR_ADDRESS, HR_RFC_ID);

    const error = await sealManifest(
      testEnv, atTime(2_300_000_001_000), ORG, reply(hrMessage, SUPPORT, RESPONDER),
    ).catch((e: unknown) => e);

    const text = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(text).not.toContain(HR_RFC_ID);
    expect(text).not.toContain("root-secret@candidate.example");
  });

  it("still allows a reply onto a parent the author can read", async () => {
    // The complement, so the fix cannot pass by refusing everything.
    const ctx = atTime(2_300_000_000_000);
    const hrMessage = await aDelivery(ctx, HR, HR_ADDRESS, HR_RFC_ID);

    const sealed = await sealManifest(
      testEnv, atTime(2_300_000_001_000), ORG, reply(hrMessage, HR, READER),
    );
    expect(sealed.referencesHeader).toContain(HR_RFC_ID);
  });
});
