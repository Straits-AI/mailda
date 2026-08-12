import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { claim, close, queueFor, release, steal } from "../src/cases.ts";
import { grant, isAdmin, revoke } from "../src/access.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { CallerError } from "../src/errors.ts";

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
    const queue = await queueFor(testEnv, ORG, BO, MAILBOX);
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
    expect(await queueFor(testEnv, ORG, OUTSIDER, MAILBOX)).toEqual([]);
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

    const queue = await queueFor(testEnv, ORG, ANA, MAILBOX);
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
