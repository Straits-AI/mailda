import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { queueFor } from "../src/cases.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { grant, isGrantable } from "../src/access.ts";

/**
 * What a queue discloses, and to whom.
 *
 * ## The defect this file exists for
 *
 * `queueFor` was gated on `send.propose` alone and selected `messages.subject` and `messages.from_addr`, so
 * **anybody who could reply read every subject line and sender address in the mailbox** — with no relation
 * permitting it and nothing recording it. Reproduced before the fix: a principal holding `send.propose` and
 * no read relation of any kind received `"Redundancy list, confidential"` from `hr@customer.example`.
 *
 * Blueprint §7 forbids exactly this. A case relation "never implies `message.read`", and participants and
 * snippets "are individually authorized from their source delivery". The blueprint's own permission catalogue
 * (`:697`) already names the relation the queue needs — `mailbox.metadata.read` — and it was implemented
 * nowhere: one mention in a test seed, granted by nothing, absent from `GRANTABLE`.
 *
 * ## Why this was never caught
 *
 * Every existing queue test grants `send.propose` because that is what claiming needs, and none of them
 * asserts anything about a caller who holds *only* that. The corpus in `seed.ts` grants all three relations
 * together, so the measured shape never separated them either. A test suite can be thorough about the
 * mechanism it was written for and silent about the combination nobody thought to construct — which is why
 * the case below is stated as a grant matrix rather than as one scenario.
 */

const testEnv = env as unknown as Env;
const ORG = "org_disclosure";
const MAILBOX = "mbx_disclosure";

const SUBJECT = "Redundancy list, confidential";
const SENDER = "hr@customer.example";

/** Somebody holding exactly the relations named, and nothing else. */
async function principalHolding(id: string, relations: readonly string[]): Promise<string> {
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  for (const relation of relations) {
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,'mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, id, relation, MAILBOX, at).run();
  }
  return id;
}

beforeEach(async () => {
  for (const table of ["cases", "conversations", "messages", "relationship_tuples", "mailboxes",
                       "audit_entries", "users"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
    .bind(MAILBOX, ORG, "Support", at).run();

  const conversationId = await conversationForDelivery(testEnv, ctx, ORG, "<confidential@example.net>");
  await testEnv.CATALOG.prepare(
    `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
                           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
                           created_at, conversation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(ctx.id("msg"), ORG, "2026-08", "blob", "sha", 10, "<confidential@example.net>", ctx.id("thr"),
    SUBJECT, SENDER, at, at, ctx.id("ir"), at, conversationId).run();
  await testEnv.CATALOG.prepare(
    `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at,
                        created_at)
     VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
  ).bind(ctx.id("cas"), ORG, conversationId, MAILBOX, at, at).run();
});

describe("the queue's message columns are gated separately from the queue itself", () => {
  it("withholds subject and sender from somebody holding only send.propose", async () => {
    const who = await principalHolding("usr_responder_only", ["send.propose"]);

    const rows = await queueFor(testEnv, createSystemCtx(), ORG, who, MAILBOX);

    // The case is listed — they can work it, which is what send.propose is for.
    expect(rows).toHaveLength(1);
    // The content is not.
    expect(rows[0]!.subject).toBeNull();
    expect(rows[0]!.from_addr).toBeNull();
    // And withheld is distinguishable from absent, which is the whole reason the flag exists: a message may
    // legitimately have an empty subject, so a null on its own says nothing about why.
    expect(rows[0]!.content_restricted).toBe(true);
  });

  it("shows them to somebody who also holds mailbox.metadata.read", async () => {
    const who = await principalHolding("usr_triage", ["send.propose", "mailbox.metadata.read"]);

    const rows = await queueFor(testEnv, createSystemCtx(), ORG, who, MAILBOX);

    expect(rows[0]!.subject).toBe(SUBJECT);
    expect(rows[0]!.from_addr).toBe(SENDER);
    expect(rows[0]!.content_restricted).toBe(false);
  });

  it("shows them to somebody holding content.read, without also needing the weaker relation", async () => {
    // content.read is strictly the stronger authority — you cannot read a body without seeing its subject —
    // so requiring metadata.read *as well* would be a rule with no defence.
    const who = await principalHolding("usr_reader", ["send.propose", "mailbox.content.read"]);

    const rows = await queueFor(testEnv, createSystemCtx(), ORG, who, MAILBOX);

    expect(rows[0]!.subject).toBe(SUBJECT);
    expect(rows[0]!.content_restricted).toBe(false);
  });

  it("shows no queue at all to a reader who cannot send, whatever they may read", async () => {
    // Not a defect and not a placeholder: a queue is a work surface, so `send.propose` decides whether one
    // exists here. A reader reaches the same mail through the message list, which is gated on what they hold.
    const who = await principalHolding("usr_watcher", ["mailbox.metadata.read", "mailbox.content.read"]);

    expect(await queueFor(testEnv, createSystemCtx(), ORG, who, MAILBOX)).toHaveLength(0);
  });

  it("never returns the withheld columns in the result set at all", async () => {
    // Read-and-discard would satisfy every assertion above while leaving the content one line of code away
    // from being returned again. The SQL selects literal NULLs instead, so this asserts the property that
    // makes the others durable: the string is not in the row.
    const who = await principalHolding("usr_responder_only", ["send.propose"]);

    const rows = await queueFor(testEnv, createSystemCtx(), ORG, who, MAILBOX);

    expect(JSON.stringify(rows)).not.toContain(SUBJECT);
    expect(JSON.stringify(rows)).not.toContain(SENDER);
  });

  it("counts the messages on the case even when their content is withheld", async () => {
    // §7 gates counters that would leak *that restricted content exists*. This one does not: the caller
    // already knows the case exists, because they hold send.propose and can claim it.
    const who = await principalHolding("usr_responder_only", ["send.propose"]);

    expect((await queueFor(testEnv, createSystemCtx(), ORG, who, MAILBOX))[0]!.message_count).toBe(1);
  });
});

describe("mailbox.metadata.read is a real, grantable relation", () => {
  it("is grantable, so an administrator can fix a restricted queue from inside the product", async () => {
    // It existed in the blueprint's catalogue and in one test seed, and in `GRANTABLE` it did not — which
    // made it a relation nobody could hold, checked by nothing.
    expect(isGrantable("mailbox.metadata.read")).toBe(true);
  });

  it("takes effect on the next read, because authority is never cached", async () => {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const who = await principalHolding("usr_responder_only", ["send.propose"]);
    const admin = "usr_admin";
    for (const [id, email] of [[who, "responder@local.invalid"], [admin, "admin@local.invalid"]] as const) {
      await testEnv.CATALOG.prepare(
        "INSERT OR IGNORE INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
      ).bind(id, ORG, email, at).run();
    }
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'org.admin','organization',?,?)`,
    ).bind(ctx.id("rt"), ORG, admin, ORG, at).run();

    expect((await queueFor(testEnv, createSystemCtx(), ORG, who, MAILBOX))[0]!.content_restricted).toBe(true);

    await grant(testEnv, ctx, ORG, admin, {
      subjectId: who, relation: "mailbox.metadata.read", objectId: MAILBOX,
    });

    expect((await queueFor(testEnv, createSystemCtx(), ORG, who, MAILBOX))[0]!.content_restricted).toBe(false);
  });
});
