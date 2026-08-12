import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { conversationForDelivery } from "../src/conversations.ts";
import { claim } from "../src/cases.ts";
import { mergeConversations } from "../src/merge.ts";
import { CallerError } from "../src/errors.ts";

/**
 * Merging conversations (#43): a refusal policy with two auto-mergeable states.
 *
 * Of twelve pair-states, two are safe. The other ten mean a single-winner merge destroys data or asserts
 * something false — and the deciding class is **false compliance**, because two running clocks means either
 * resetting a breach that happened or importing one that did not. So most of this file tests refusals, which
 * is the actual deliverable: a refusal a person can act on beats a merge that quietly picked.
 */

const testEnv = env as unknown as Env;
const ORG = "org_merge";
const MAILBOX = "mbx_support_m";
const OTHER = "mbx_billing_m";
const ANA = "usr_ana_m";
const BO = "usr_bo_m";
const OUTSIDER = "usr_outsider_m";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

async function tuple(userId: string, relation: string, mailboxId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?, 'mailbox', ?, ?)`,
  ).bind(ctx.id("rt"), ORG, userId, relation, mailboxId, new Date(ctx.now()).toISOString()).run();
}

/** A conversation with one message and a case in each named mailbox. */
async function conversation(root: string, mailboxes: string[], at: string): Promise<string> {
  const ctx = createSystemCtx();
  const id = await conversationForDelivery(testEnv, ctx, ORG, root);
  const messageId = ctx.id("msg");
  await testEnv.CATALOG.prepare(
    `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
       thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
       in_reply_to, thread_root_rfc_id, parse_error, conversation_id)
     VALUES (?,?, '2026-Q3', ?, 'deadbeef', 4211, ?, ?, ?, 'customer@example.net', ?, ?, ?, ?, NULL, ?, NULL, ?)`,
  ).bind(messageId, ORG, `${ORG}/raw/${messageId}.eml`, root, ctx.id("thr"),
    "Container MSKU4471203", at, at, ctx.id("rcp"), at, root, id).run();
  for (const mailboxId of mailboxes) {
    await testEnv.CATALOG.prepare(
      `INSERT OR IGNORE INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee,
         claimed_at, created_at) VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
    ).bind(ctx.id("cas"), ORG, id, mailboxId, at, at).run();
  }
  return id;
}

async function caseIn(conversationId: string, mailboxId: string): Promise<string> {
  const row = await testEnv.CATALOG.prepare(
    "SELECT id FROM cases WHERE org_id = ? AND conversation_id = ? AND mailbox_id = ?",
  ).bind(ORG, conversationId, mailboxId).first<{ id: string }>();
  return row!.id;
}

beforeEach(async () => {
  for (const table of ["cases", "conversations", "messages", "relationship_tuples", "mailboxes",
                       "audit_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  for (const [id, name] of [[MAILBOX, "Support"], [OTHER, "Billing"]] as const) {
    await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(id, ORG, name, at).run();
  }
  for (const user of [ANA, BO]) {
    for (const mailbox of [MAILBOX, OTHER]) {
      await tuple(user, "mailbox.content.read", mailbox);
      await tuple(user, "send.propose", mailbox);
    }
  }
});

describe("the two states that merge automatically", () => {
  it("moves a case where only one side has one in that mailbox", async () => {
    const a = await conversation("<a@example.net>", [MAILBOX], "2026-08-01T09:00:00.000Z");
    const b = await conversation("<b@example.net>", [OTHER], "2026-08-01T10:00:00.000Z");

    const outcome = await mergeConversations(testEnv, atTime(8_000_000_000_000), ORG, ANA, a, b);
    expect(outcome).toMatchObject({ merged: true, into: b, messagesMoved: 1, casesMerged: 1 });

    // The case followed the conversation into the target, rather than being dropped.
    const cases = await testEnv.CATALOG.prepare(
      "SELECT mailbox_id FROM cases WHERE conversation_id = ? ORDER BY mailbox_id",
    ).bind(b).all<{ mailbox_id: string }>();
    expect(cases.results.map((c) => c.mailbox_id)).toEqual([OTHER, MAILBOX]);
  });

  it("merges when both cases are held by the same person, because no claim changes hands", async () => {
    const a = await conversation("<c@example.net>", [MAILBOX], "2026-08-02T09:00:00.000Z");
    const b = await conversation("<d@example.net>", [MAILBOX], "2026-08-02T10:00:00.000Z");
    await claim(testEnv, atTime(8_100_000_000_000), ORG, ANA, await caseIn(a, MAILBOX));
    await claim(testEnv, atTime(8_100_000_060_000), ORG, ANA, await caseIn(b, MAILBOX));

    const outcome = await mergeConversations(testEnv, atTime(8_100_000_120_000), ORG, ANA, a, b);
    expect(outcome).toMatchObject({ merged: true, casesMerged: 1 });
    // One case survives in that mailbox, still hers.
    const row = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n, MAX(assignee) AS who FROM cases WHERE conversation_id = ? AND mailbox_id = ?",
    ).bind(b, MAILBOX).first<{ n: number; who: string }>();
    expect(row).toEqual({ n: 1, who: ANA });
  });

  it("keeps the merged-away conversation, and marks the survivor as manually grouped", async () => {
    const a = await conversation("<e@example.net>", [MAILBOX], "2026-08-03T09:00:00.000Z");
    const b = await conversation("<f@example.net>", [OTHER], "2026-08-03T10:00:00.000Z");
    await mergeConversations(testEnv, atTime(8_200_000_000_000), ORG, ANA, a, b);

    const rows = await testEnv.CATALOG.prepare(
      "SELECT id, merged_into, grouped_by FROM conversations WHERE id IN (?, ?) ORDER BY id = ?",
    ).bind(a, b, a).all<{ id: string; merged_into: string | null; grouped_by: string }>();
    const source = rows.results.find((r) => r.id === a)!;
    const target = rows.results.find((r) => r.id === b)!;
    // Not deleted: merge is audited, and the trail must not disagree with the data about there having been two.
    expect(source.merged_into).toBe(b);
    // A person decided these were one thing, and a later reader can tell from the row rather than the trail.
    expect(target.grouped_by).toBe("manual");
  });

  it("audits it once, naming both conversations and every mailbox", async () => {
    const a = await conversation("<g@example.net>", [MAILBOX], "2026-08-04T09:00:00.000Z");
    const b = await conversation("<h@example.net>", [OTHER], "2026-08-04T10:00:00.000Z");
    await mergeConversations(testEnv, atTime(8_300_000_000_000), ORG, ANA, a, b);

    const entry = await testEnv.CATALOG.prepare(
      "SELECT actor_user_id, subject, detail FROM audit_entries WHERE action = 'conversation.merged'",
    ).first<{ actor_user_id: string; subject: string; detail: string }>();
    expect(entry?.actor_user_id).toBe(ANA);
    expect(entry?.subject).toBe(b);
    const detail = JSON.parse(entry!.detail);
    expect(detail.from).toBe(a);
    expect(detail.mailboxes.sort()).toEqual([OTHER, MAILBOX].sort());
  });
});

describe("everything else refuses, and names the obstruction", () => {
  it("refuses two unclaimed cases in one mailbox, because the earlier clock start would be lost", async () => {
    const a = await conversation("<i@example.net>", [MAILBOX], "2026-08-05T09:00:00.000Z");
    const b = await conversation("<j@example.net>", [MAILBOX], "2026-08-05T10:00:00.000Z");

    const outcome = await mergeConversations(testEnv, atTime(8_400_000_000_000), ORG, ANA, a, b);
    expect(outcome.merged).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("both cases are unclaimed");
    // "and nothing was changed" is the load-bearing half: all-or-nothing means a refusal writes nothing.
    expect((outcome as { reason: string }).reason).toContain("nothing was changed");
  });

  it("refuses when two people hold the two cases, and says who", async () => {
    const a = await conversation("<k@example.net>", [MAILBOX], "2026-08-06T09:00:00.000Z");
    const b = await conversation("<l@example.net>", [MAILBOX], "2026-08-06T10:00:00.000Z");
    await claim(testEnv, atTime(8_500_000_000_000), ORG, ANA, await caseIn(a, MAILBOX));
    await claim(testEnv, atTime(8_500_000_060_000), ORG, BO, await caseIn(b, MAILBOX));

    const outcome = await mergeConversations(testEnv, atTime(8_500_000_120_000), ORG, ANA, a, b);
    expect(outcome.merged).toBe(false);
    // There is no non-destructive single-winner outcome for this pair, so it is refused rather than resolved.
    expect((outcome as { reason: string }).reason).toContain(ANA);
    expect((outcome as { reason: string }).reason).toContain(BO);
  });

  it("refuses when one is claimed and the other is not", async () => {
    const a = await conversation("<m@example.net>", [MAILBOX], "2026-08-07T09:00:00.000Z");
    const b = await conversation("<n@example.net>", [MAILBOX], "2026-08-07T10:00:00.000Z");
    await claim(testEnv, atTime(8_600_000_000_000), ORG, ANA, await caseIn(a, MAILBOX));

    const outcome = await mergeConversations(testEnv, atTime(8_600_000_060_000), ORG, ANA, a, b);
    expect(outcome.merged).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("claimed and the other is not");
  });

  it("refuses when either case is closed", async () => {
    const a = await conversation("<o@example.net>", [MAILBOX], "2026-08-08T09:00:00.000Z");
    const b = await conversation("<p@example.net>", [MAILBOX], "2026-08-08T10:00:00.000Z");
    await testEnv.CATALOG.prepare("UPDATE cases SET state = 'closed' WHERE conversation_id = ?")
      .bind(a).run();

    const outcome = await mergeConversations(testEnv, atTime(8_700_000_000_000), ORG, ANA, a, b);
    expect(outcome.merged).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("closed");
  });

  it("changes nothing at all when it refuses", async () => {
    const a = await conversation("<q@example.net>", [MAILBOX], "2026-08-09T09:00:00.000Z");
    const b = await conversation("<r@example.net>", [MAILBOX], "2026-08-09T10:00:00.000Z");
    const before = await testEnv.CATALOG.prepare(
      "SELECT (SELECT COUNT(*) FROM cases) AS k, (SELECT COUNT(*) FROM audit_entries) AS a, (SELECT COUNT(*) FROM conversations WHERE merged_into IS NOT NULL) AS m",
    ).first();

    await mergeConversations(testEnv, atTime(8_800_000_000_000), ORG, ANA, a, b);

    const after = await testEnv.CATALOG.prepare(
      "SELECT (SELECT COUNT(*) FROM cases) AS k, (SELECT COUNT(*) FROM audit_entries) AS a, (SELECT COUNT(*) FROM conversations WHERE merged_into IS NOT NULL) AS m",
    ).first();
    // No cases moved, no audit entry claiming an act that did not happen, no conversation marked merged.
    expect(after).toEqual(before);
  });

  it("refuses a merge reaching a mailbox the caller cannot read, without naming it", async () => {
    const a = await conversation("<s@example.net>", [MAILBOX], "2026-08-10T09:00:00.000Z");
    const b = await conversation("<t@example.net>", [OTHER], "2026-08-10T10:00:00.000Z");
    await tuple(OUTSIDER, "mailbox.content.read", MAILBOX);

    const outcome = await mergeConversations(testEnv, atTime(8_900_000_000_000), ORG, OUTSIDER, a, b);
    expect(outcome.merged).toBe(false);
    // Naming the mailbox would disclose the existence of a queue this caller has no relation to — the §5C
    // rule #44 settled.
    expect((outcome as { reason: string }).reason).not.toContain(OTHER);
    expect((outcome as { reason: string }).reason).toContain("cannot read");
  });

  it("refuses to merge a conversation into itself rather than recording an act that did not happen", async () => {
    const a = await conversation("<u@example.net>", [MAILBOX], "2026-08-11T09:00:00.000Z");
    await expect(mergeConversations(testEnv, atTime(9_000_000_000_000), ORG, ANA, a, a))
      .rejects.toThrow(/E_MERGE_INTO_SELF/);
  });

  it("answers a conversation it cannot see exactly as one that does not exist", async () => {
    await expect(
      mergeConversations(testEnv, atTime(9_100_000_000_000), ORG, ANA, "cnv_nope", "cnv_also_nope"),
    ).rejects.toThrow(CallerError);
  });

  it("refuses a second merge of an already-merged conversation", async () => {
    const a = await conversation("<v@example.net>", [MAILBOX], "2026-08-12T09:00:00.000Z");
    const b = await conversation("<w@example.net>", [OTHER], "2026-08-12T10:00:00.000Z");
    await mergeConversations(testEnv, atTime(9_200_000_000_000), ORG, ANA, a, b);

    const again = await mergeConversations(testEnv, atTime(9_200_000_060_000), ORG, ANA, a, b);
    expect(again.merged).toBe(false);
    expect((again as { reason: string }).reason).toContain("already been merged");
    // And no second entry claiming a second act.
    const count = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE action = 'conversation.merged'",
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
