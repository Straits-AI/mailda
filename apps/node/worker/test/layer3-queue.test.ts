import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { claim, close, mailboxQueues, queueFor, release, steal } from "../src/cases.ts";
import { grant, isAdmin, revoke } from "../src/access.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { CallerError } from "../src/errors.ts";
import { statementsOf } from "../src/sql-statements.ts";
// Imported as text, the way migrate.ts does — workerd has no filesystem, and this also means the test
// exercises the same bytes the migration runner will.
import BACKFILL from "../migrations/0016_backfill_conversations_and_cases.sql";

/**
 * Layer 3's proof line: **two people work one queue without colliding.**
 *
 * The mechanism is a conditional UPDATE — `WHERE assignee IS NULL` — and nothing else. No Durable Object, no
 * lock, no timeout. These tests are the proof that the mechanism holds and that each refusal is a distinct,
 * useful answer rather than a shared failure.
 */

const testEnv = env as unknown as Env;
const ORG = "org_layer3";
const MAILBOX = "mbx_support";
const OTHER_MAILBOX = "mbx_billing";
const ANA = "usr_ana";
const BO = "usr_bo";
const OUTSIDER = "usr_outsider";
const ADMIN = "usr_admin";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

async function grantTuple(userId: string, relation: string, objectType: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, userId, relation, objectType, objectId,
    new Date(ctx.now()).toISOString()).run();
}

/** A case in a mailbox, reached the way ingress reaches one: conversation first, then the case. */
async function aCase(mailboxId: string, root: string): Promise<string> {
  const ctx = createSystemCtx();
  const conversationId = await conversationForDelivery(testEnv, ctx, ORG, root);
  const at = new Date(ctx.now()).toISOString();
  const id = ctx.id("cas");
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO cases
       (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at, created_at)
     VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
  ).bind(id, ORG, conversationId, mailboxId, at, at).run();
  return id;
}

beforeEach(async () => {
  for (const table of ["cases", "conversations", "messages", "relationship_tuples", "mailboxes",
                       "audit_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  for (const [id, name] of [[MAILBOX, "Support"], [OTHER_MAILBOX, "Billing"]] as const) {
    await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(id, ORG, name, at).run();
  }
  // Ana and Bo both work Support. The outsider works nothing. The admin administers.
  for (const user of [ANA, BO]) await grantTuple(user, "send.propose", "mailbox", MAILBOX);
  await grantTuple(ADMIN, "org.admin", "organization", ORG);
});

describe("two people work one queue without colliding", () => {
  it("gives the case to exactly one of two simultaneous claimants", async () => {
    const caseId = await aCase(MAILBOX, "<one@example.net>");

    // Both press reply at once. The compare-and-swap decides; nothing coordinates them.
    const [ana, bo] = await Promise.all([
      claim(testEnv, atTime(5_000_000_000_000), ORG, ANA, caseId),
      claim(testEnv, atTime(5_000_000_000_000), ORG, BO, caseId),
    ]);

    const winners = [ana, bo].filter((o) => o.kind === "claimed");
    const losers = [ana, bo].filter((o) => o.kind === "held");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The loser is told who won and since when. `changes = 0` on its own would leave them guessing whether
    // to wait, steal, or move on.
    const loser = losers[0] as { kind: "held"; by: string; since: string };
    expect([ANA, BO]).toContain(loser.by);
    expect(loser.since).not.toBe("");
  });

  it("holds the claim until its holder gives it up, with no timeout anywhere", async () => {
    const caseId = await aCase(MAILBOX, "<two@example.net>");
    await claim(testEnv, atTime(5_100_000_000_000), ORG, ANA, caseId);

    // Eleven hours later. Nothing expires: an expiry is a policy guess, an age is a fact.
    const bo = await claim(testEnv, atTime(5_100_000_000_000 + 11 * 3_600_000), ORG, BO, caseId);
    expect(bo.kind).toBe("held");
    expect((bo as { by: string }).by).toBe(ANA);
  });

  it("shows the age so a person can judge staleness the Node refuses to", async () => {
    const caseId = await aCase(MAILBOX, "<three@example.net>");
    await claim(testEnv, atTime(5_200_000_000_000), ORG, ANA, caseId);
    const queue = await queueFor(testEnv, createSystemCtx(), ORG, BO, MAILBOX);
    const entry = queue.find((c) => c.id === caseId);
    expect(entry?.assignee).toBe(ANA);
    expect(entry?.claimed_at).toBe(new Date(5_200_000_000_000).toISOString());
  });
});

describe("stealing is the escape hatch, and it is audited", () => {
  it("lets a colleague take a held case and records who took it from whom", async () => {
    const caseId = await aCase(MAILBOX, "<four@example.net>");
    await claim(testEnv, atTime(5_300_000_000_000), ORG, ANA, caseId);

    const taken = await steal(testEnv, atTime(5_300_000_060_000), ORG, BO, caseId);
    expect(taken.kind).toBe("claimed");
    expect((taken as { case: { assignee: string } }).case.assignee).toBe(BO);

    const entry = await testEnv.CATALOG.prepare(
      "SELECT action, actor_user_id, subject, detail FROM audit_entries WHERE action = 'case.claim_taken'",
    ).first<{ action: string; actor_user_id: string; subject: string; detail: string }>();
    // Both named. Claim-before-composing prevents accidents, not takeover — so the trail is what makes a
    // takeover accountable rather than silent.
    expect(entry?.actor_user_id).toBe(BO);
    expect(entry?.subject).toBe(caseId);
    expect(JSON.parse(entry!.detail).from).toBe(ANA);
  });

  it("does not audit an ordinary claim or release, because people do those all day", async () => {
    const caseId = await aCase(MAILBOX, "<five@example.net>");
    await claim(testEnv, atTime(5_400_000_000_000), ORG, ANA, caseId);
    await release(testEnv, atTime(5_400_000_060_000), ORG, ANA, caseId);

    // Audit entries are never trimmed and the table is sized at a handful per message. One entry per claim
    // grows it without bound; claim history lives on the case instead.
    const count = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM audit_entries")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("lets only the holder release, so stealing is the mechanism for everything else", async () => {
    const caseId = await aCase(MAILBOX, "<six@example.net>");
    await claim(testEnv, atTime(5_500_000_000_000), ORG, ANA, caseId);
    expect((await release(testEnv, atTime(5_500_000_060_000), ORG, BO, caseId)).released).toBe(false);
    expect((await release(testEnv, atTime(5_500_000_120_000), ORG, ANA, caseId)).released).toBe(true);
  });

  it("closes and releases in one act, so finished work has no holder", async () => {
    const caseId = await aCase(MAILBOX, "<seven@example.net>");
    await claim(testEnv, atTime(5_600_000_000_000), ORG, ANA, caseId);
    expect((await close(testEnv, atTime(5_600_000_060_000), ORG, ANA, caseId)).closed).toBe(true);

    const row = await testEnv.CATALOG.prepare("SELECT state, assignee FROM cases WHERE id = ?")
      .bind(caseId).first<{ state: string; assignee: string | null }>();
    expect(row?.state).toBe("closed");
    // A closed case with an assignee would sit in somebody's "what am I working on" forever.
    expect(row?.assignee).toBeNull();
  });
});

describe("a queue is bounded by the mailbox, and says nothing about others (#44)", () => {
  it("shows nothing to somebody who holds no relation, rather than refusing", async () => {
    await aCase(MAILBOX, "<eight@example.net>");
    // §5C keeps an absent thing and an invisible one alike: empty, not forbidden.
    expect(await queueFor(testEnv, createSystemCtx(), ORG, OUTSIDER, MAILBOX)).toEqual([]);
  });

  it("does not reveal a sibling case on the same conversation in another mailbox", async () => {
    const root = "<shared@example.net>";
    const mine = await aCase(MAILBOX, root);
    const theirs = await aCase(OTHER_MAILBOX, root);

    // One conversation, two cases — the (conversation, mailbox) model. Ana holds Support only.
    const conversations = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM conversations WHERE org_id = ?",
    ).bind(ORG).first<{ n: number }>();
    expect(conversations?.n).toBe(1);

    const queue = await queueFor(testEnv, createSystemCtx(), ORG, ANA, MAILBOX);
    expect(queue.map((c) => c.id)).toEqual([mine]);
    // Not the id, not a count, not an existence bit. §5C names existence and counts as gated.
    expect(JSON.stringify(queue)).not.toContain(theirs);
    expect(JSON.stringify(queue)).not.toContain(OTHER_MAILBOX);
  });

  it("cannot claim a case in a mailbox it cannot send as, and cannot tell that from absent", async () => {
    const theirs = await aCase(OTHER_MAILBOX, "<nine@example.net>");
    const refused = await claim(testEnv, atTime(5_700_000_000_000), ORG, ANA, theirs);
    const absent = await claim(testEnv, atTime(5_700_000_000_000), ORG, ANA, "cas_does_not_exist");
    expect(refused).toEqual({ kind: "not_found" });
    expect(refused).toEqual(absent);
  });
});

describe("one conversation per root, whatever the concurrency", () => {
  it("files two deliveries of one thread against one conversation", async () => {
    const ctx = createSystemCtx();
    const root = "<race@example.net>";
    const [a, b] = await Promise.all([
      conversationForDelivery(testEnv, ctx, ORG, root),
      conversationForDelivery(testEnv, ctx, ORG, root),
    ]);
    // The UNIQUE index is the concurrency control, and the loser reads back the winner's id rather than
    // proceeding with the one it minted — which would have orphaned its message and its case.
    expect(a).toBe(b);
  });

  it("gives a message with no readable root its own conversation, joinable by nothing", async () => {
    const ctx = createSystemCtx();
    const first = await conversationForDelivery(testEnv, ctx, ORG, null);
    const second = await conversationForDelivery(testEnv, ctx, ORG, null);
    // Two distinct conversations: a NULL root joins nothing, now or ever, which is the honest consequence of
    // having nothing to join on. Fragmentation, visible and mergeable by a person.
    expect(first).not.toBe(second);
  });
});

describe("access administration (#39)", () => {
  it("lets an administrator grant, and the grant is audited with the tuple", async () => {
    const outcome = await grant(testEnv, atTime(5_800_000_000_000), ORG, ADMIN, {
      subjectId: OUTSIDER, relation: "send.propose", objectId: MAILBOX,
    });
    expect(outcome).toEqual({ granted: true, alreadyHeld: false });

    // The grant now works, immediately: nothing caches a relation.
    const caseId = await aCase(MAILBOX, "<ten@example.net>");
    expect((await claim(testEnv, atTime(5_800_000_060_000), ORG, OUTSIDER, caseId)).kind).toBe("claimed");

    const entry = await testEnv.CATALOG.prepare(
      "SELECT actor_user_id, subject, detail FROM audit_entries WHERE action = 'access.granted'",
    ).first<{ actor_user_id: string; subject: string; detail: string }>();
    expect(entry?.actor_user_id).toBe(ADMIN);
    expect(entry?.subject).toBe(OUTSIDER);
    expect(JSON.parse(entry!.detail).relation).toBe("send.propose");
  });

  it("makes a replayed grant a no-op rather than a second act", async () => {
    const first = await grant(testEnv, atTime(5_900_000_000_000), ORG, ADMIN, {
      subjectId: OUTSIDER, relation: "send.propose", objectId: MAILBOX,
    });
    const again = await grant(testEnv, atTime(5_900_000_060_000), ORG, ADMIN, {
      subjectId: OUTSIDER, relation: "send.propose", objectId: MAILBOX,
    });
    expect(first.alreadyHeld).toBe(false);
    expect(again.alreadyHeld).toBe(true);

    // rt_unique makes the replay retry-safe (#9), and the entry is gated on the insert so the trail does not
    // claim two grants happened.
    const count = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE action = 'access.granted'",
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("refuses a non-administrator, naming the missing relation", async () => {
    await expect(
      grant(testEnv, atTime(6_000_000_000_000), ORG, ANA, {
        subjectId: OUTSIDER, relation: "send.propose", objectId: MAILBOX,
      }),
    ).rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);
  });

  it("refuses a grant on a mailbox that does not exist, rather than storing a tuple nothing matches", async () => {
    await expect(
      grant(testEnv, atTime(6_100_000_000_000), ORG, ADMIN, {
        subjectId: OUTSIDER, relation: "send.propose", objectId: "mbx_nope",
      }),
    ).rejects.toThrow(/E_NO_MAILBOX/);
  });

  it("lets an administrator make an administrator, so a departure cannot lock a Node", async () => {
    await grant(testEnv, atTime(6_200_000_000_000), ORG, ADMIN, {
      subjectId: ANA, relation: "org.admin", objectId: ORG,
    });
    expect(await isAdmin(testEnv, ORG, ANA)).toBe(true);
  });

  it("revokes immediately, and leaves a held claim visibly stuck rather than silently released", async () => {
    const caseId = await aCase(MAILBOX, "<eleven@example.net>");
    await claim(testEnv, atTime(6_300_000_000_000), ORG, ANA, caseId);

    expect((await revoke(testEnv, atTime(6_300_000_060_000), ORG, ADMIN, {
      subjectId: ANA, relation: "send.propose", objectId: MAILBOX,
    })).revoked).toBe(true);

    // Ana can no longer claim anything here — §7's immediacy, with nothing cached.
    const another = await aCase(MAILBOX, "<twelve@example.net>");
    expect((await claim(testEnv, atTime(6_300_000_120_000), ORG, ANA, another)).kind).toBe("not_found");

    // But her existing claim stands. Releasing it would look tidier and would silently discard whatever she
    // had in progress at a moment she is not watching. It is visibly stuck, and Bo may steal it.
    const row = await testEnv.CATALOG.prepare("SELECT assignee FROM cases WHERE id = ?")
      .bind(caseId).first<{ assignee: string | null }>();
    expect(row?.assignee).toBe(ANA);
    expect((await steal(testEnv, atTime(6_300_000_180_000), ORG, BO, caseId)).kind).toBe("claimed");
  });

  it("does not let one person read another's relations unless they administer", async () => {
    await expect(
      grant(testEnv, atTime(6_400_000_000_000), ORG, OUTSIDER, {
        subjectId: OUTSIDER, relation: "org.admin", objectId: ORG,
      }),
    ).rejects.toThrow(CallerError);
  });
});

/**
 * The backfill (migration 0016), tested by exercising the SQL rather than trusting it.
 *
 * 0014 wired conversations and cases into *ingress*, so mail that had already arrived was in no queue —
 * an inbox with messages and a queue with none, which reads as a broken feature rather than a new one.
 *
 * The interesting property is grouping: a per-message backfill would give two messages of one thread two
 * conversations each, which is the thing conversations exist to prevent. So the id derives from the
 * earliest message sharing the root, not from any one message.
 */
describe("backfilling mail that arrived before Layer 3", () => {
  /** Runs the migration the way `migrate.ts` does — statement by statement. */
  async function runBackfill() {
    for (const sql of statementsOf(BACKFILL)) await testEnv.CATALOG.prepare(sql).run();
  }

  async function anOldMessage(id: string, root: string | null, mailboxes: string[], receivedAt: string) {
    await testEnv.CATALOG.prepare(
      `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
         thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
         in_reply_to, thread_root_rfc_id, parse_error, conversation_id)
       VALUES (?,?, '2026-Q3', ?, 'deadbeef', 4211, ?, ?, ?, 'customer@example.net', ?, ?, ?, ?,
               NULL, ?, NULL, NULL)`,
    ).bind(id, ORG, `${ORG}/raw/${id}.eml`, `<${id}@example.net>`, `thr_${id}`,
      "Container MSKU4471203 held at customs", receivedAt, receivedAt, `rcp_${id}`, receivedAt, root).run();
    for (const mailboxId of mailboxes) {
      await testEnv.CATALOG.prepare(
        `INSERT INTO mailbox_items (id, org_id, mailbox_id, time_bucket, message_id, change_number, flags,
           sent_at, created_at) VALUES (?,?,?, '2026-Q3', ?, 0, 0, ?, ?)`,
      ).bind(`mbi_${id}_${mailboxId}`, ORG, mailboxId, id, receivedAt, receivedAt).run();
    }
  }

  it("groups two messages of one thread into one conversation, not one each", async () => {
    const root = "<original@example.net>";
    await anOldMessage("msg_old_a", root, [MAILBOX], "2026-08-01T09:00:00.000Z");
    await anOldMessage("msg_old_b", root, [MAILBOX], "2026-08-01T11:00:00.000Z");
    await runBackfill();

    const rows = await testEnv.CATALOG.prepare(
      "SELECT DISTINCT conversation_id FROM messages WHERE id IN ('msg_old_a','msg_old_b')",
    ).all<{ conversation_id: string }>();
    // One conversation. A per-message backfill would produce two, which is exactly what grouping exists
    // to prevent and what the deterministic-id-from-MIN(id) trick avoids.
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.conversation_id).not.toBeNull();
  });

  it("opens one case per mailbox the message was delivered to, unclaimed", async () => {
    await anOldMessage("msg_old_c", "<two@example.net>", [MAILBOX, OTHER_MAILBOX], "2026-08-02T09:00:00.000Z");
    await runBackfill();

    const cases = await testEnv.CATALOG.prepare(
      `SELECT c.mailbox_id, c.state, c.assignee, c.created_at FROM cases c
        JOIN messages m ON m.conversation_id = c.conversation_id
       WHERE m.id = 'msg_old_c' ORDER BY c.mailbox_id`,
    ).all<{ mailbox_id: string; state: string; assignee: string | null; created_at: string }>();

    expect(cases.results.map((c) => c.mailbox_id)).toEqual([OTHER_MAILBOX, MAILBOX]);
    for (const row of cases.results) {
      // `open` and unclaimed is the only honest state: `claimed` invents a holder and `closed` declares
      // work finished on the strength of it being old.
      expect(row.state).toBe("open");
      expect(row.assignee).toBeNull();
      // Dated from the mail, not from the migration — the queue orders by this, and stamping everything
      // with the migration's timestamp would present all history as arriving at once.
      expect(row.created_at).toBe("2026-08-02T09:00:00.000Z");
    }
  });

  it("gives a message with no readable root its own conversation", async () => {
    await anOldMessage("msg_old_d", null, [MAILBOX], "2026-08-03T09:00:00.000Z");
    await anOldMessage("msg_old_e", null, [MAILBOX], "2026-08-03T10:00:00.000Z");
    await runBackfill();

    const rows = await testEnv.CATALOG.prepare(
      "SELECT conversation_id FROM messages WHERE id IN ('msg_old_d','msg_old_e')",
    ).all<{ conversation_id: string }>();
    // Two, not one: a NULL root joins nothing, and the backfill inherits the live rule rather than being
    // allowed a looser one. Grouping them because they happen to share a subject is the guess this refuses.
    expect(new Set(rows.results.map((r) => r.conversation_id)).size).toBe(2);
  });

  it("is a no-op when run twice", async () => {
    await anOldMessage("msg_old_f", "<three@example.net>", [MAILBOX], "2026-08-04T09:00:00.000Z");
    await runBackfill();
    const first = await testEnv.CATALOG.prepare(
      "SELECT (SELECT COUNT(*) FROM conversations) AS c, (SELECT COUNT(*) FROM cases) AS k",
    ).first<{ c: number; k: number }>();
    await runBackfill();
    const second = await testEnv.CATALOG.prepare(
      "SELECT (SELECT COUNT(*) FROM conversations) AS c, (SELECT COUNT(*) FROM cases) AS k",
    ).first<{ c: number; k: number }>();
    // A migration must be idempotent under retry, and this one may also run after some cases exist.
    expect(second).toEqual(first);
  });

  it("leaves mail that already has a conversation alone", async () => {
    const ctx = createSystemCtx();
    const existing = await conversationForDelivery(testEnv, ctx, ORG, "<already@example.net>");
    await anOldMessage("msg_old_g", "<already@example.net>", [MAILBOX], "2026-08-05T09:00:00.000Z");
    await testEnv.CATALOG.prepare("UPDATE messages SET conversation_id = ? WHERE id = 'msg_old_g'")
      .bind(existing).run();
    await runBackfill();

    const row = await testEnv.CATALOG.prepare("SELECT conversation_id FROM messages WHERE id = 'msg_old_g'")
      .first<{ conversation_id: string }>();
    // Guarded by `conversation_id IS NULL`, so the backfill cannot repoint mail the live path already filed.
    expect(row?.conversation_id).toBe(existing);
  });
});

describe("the rail's per-mailbox depths (#42)", () => {
  it("lists only mailboxes this person may work, with unclaimed, in-progress and mine split", async () => {
    const a = await aCase(MAILBOX, "<rail-a@example.net>");
    await aCase(MAILBOX, "<rail-b@example.net>");
    await aCase(OTHER_MAILBOX, "<rail-c@example.net>");
    await claim(testEnv, atTime(7_000_000_000_000), ORG, ANA, a);

    const queues = await mailboxQueues(testEnv, ORG, ANA);
    // Billing is absent, not shown at zero: Ana holds no send.propose on it, and a count is a disclosure
    // Blueprint:358 gates before returning.
    expect(queues.map((q) => q.id)).toEqual([MAILBOX]);
    // Unclaimed is the queue's depth — the work nobody has taken. Counting claimed cases alongside it would
    // make a busy queue look like a backlog.
    expect(queues[0]).toMatchObject({ unclaimed: 1, claimed: 1, mine: 1 });
  });

  it("counts `mine` per person, so two people see different numbers for one queue", async () => {
    const a = await aCase(MAILBOX, "<rail-d@example.net>");
    await claim(testEnv, atTime(7_100_000_000_000), ORG, ANA, a);

    const forAna = await mailboxQueues(testEnv, ORG, ANA);
    const forBo = await mailboxQueues(testEnv, ORG, BO);
    expect(forAna[0]!.mine).toBe(1);
    // Same case, same queue: in progress for both, held by only one of them.
    expect(forBo[0]!.mine).toBe(0);
    expect(forBo[0]!.claimed).toBe(1);
  });

  it("shows nothing at all to somebody who may work no mailbox", async () => {
    await aCase(MAILBOX, "<rail-e@example.net>");
    expect(await mailboxQueues(testEnv, ORG, OUTSIDER)).toEqual([]);
  });

  it("names the holder as a person, not an identifier", async () => {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      `INSERT OR IGNORE INTO users (id, org_id, email, created_at, password_hash, password_iterations,
         password_updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(ANA, ORG, "ana@acme.example", new Date(ctx.now()).toISOString(), "x", 1,
      new Date(ctx.now()).toISOString()).run();

    const caseId = await aCase(MAILBOX, "<rail-f@example.net>");
    await claim(testEnv, atTime(7_200_000_000_000), ORG, ANA, caseId);

    const queue = await queueFor(testEnv, createSystemCtx(), ORG, BO, MAILBOX);
    const row = queue.find((c) => c.id === caseId);
    // The first version returned the assignee alone and the queue rendered `usr_01KZ…` in the "held by"
    // column. Somebody deciding whether to take a case cannot weigh that — caught by looking at it.
    expect(row?.assignee_email).toBe("ana@acme.example");
  });
});
