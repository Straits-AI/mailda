import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { decideApproval, stageOf, stagesOfApproval, type Stages } from "../src/approvals.ts";
import { verifyChain } from "../src/audit.ts";
import { decidersOf, rostersOf } from "../src/deciders.ts";
import { sealManifest } from "../src/outbound/manifest.ts";
import { createPolicyDraft, editPolicyDraft, publishPolicy, requiredStages } from "../src/policy.ts";
import {
  addTeamMember, createTeam, listTeams, membersOf, readTeam, removeTeamMember, renameTeam,
} from "../src/teams.ts";

/**
 * Teams as a first-class object, and the team-scoped approval stage they exist for (#73, #61, §18, §28).
 *
 * ## The two halves this file holds to each other
 *
 * #73's whole argument is that a subsystem with no consumer and a constraint with no subsystem are the two
 * halves of one mistake. So the membership admin is tested through what it is *for*: every assertion about
 * creating a team, adding a person or emptying one is followed by an assertion about what a policy naming that
 * team then does to a real send.
 *
 * ## Non-vacuity
 *
 * Every assertion here was verified by breaking the source it guards and watching it fail; the observed
 * failures are recorded in the ticket's report. Two are noted inline, because their failure mode is a **wrong
 * answer that looks like a working one** rather than an error — the dual-hat person satisfying a count of 2,
 * and the unknown team resolving to everybody instead of to nobody.
 */

const testEnv = env as unknown as Env;
const ORG = "org_teams";
const MAILBOX = "mbx_teams";
const ADDRESS = "support@acme.example";

const ADMIN = "usr_teams_admin";
const AUTHOR = "usr_teams_author";
const ANN = "usr_teams_ann";
const BOB = "usr_teams_bob";
/** One human being who will end up in two teams. The person dual control has to survive. */
const DUAL = "usr_teams_dual";
const PLAIN = "usr_teams_plain";
const BUTLER = "btl_teams_chaser";

const AUGUST_10 = Date.parse("2026-08-10T09:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

const ctxAt = (offset = 0): Ctx => atTime(AUGUST_10 + offset);

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string): Promise<void> {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId,
    new Date(ctx.now()).toISOString()).run();
}

/** A published policy requiring approval of every send from MAILBOX, with the stage set given. */
async function requireApproval(name: string, stages?: Stages): Promise<string> {
  const draft = await createPolicyDraft(testEnv, ctxAt(), ORG, ADMIN, {
    name, outcome: "require_approval", conditions: { mailboxId: MAILBOX }, stages,
  });
  await publishPolicy(testEnv, ctxAt(), ORG, ADMIN, draft.policyId);
  return draft.policyId;
}

async function seal(offset = 1000) {
  return sealManifest(testEnv, ctxAt(offset), ORG, {
    mailboxId: MAILBOX,
    authorUserId: AUTHOR,
    to: ["customer@example.net"],
    subject: "Needs approval",
    bodyTyped: "Body.",
    fidelity: "authored",
  });
}

async function approvalRow(manifestId: string) {
  return testEnv.CATALOG.prepare(
    `SELECT id, state FROM approvals
      WHERE org_id = ? AND subject_kind = 'send_manifest' AND subject_id = ?`,
  ).bind(ORG, manifestId).first<{ id: string; state: string }>();
}

async function manifestRow(id: string) {
  return testEnv.CATALOG.prepare(
    "SELECT state, state_reason, last_error FROM send_manifests WHERE org_id = ? AND id = ?",
  ).bind(ORG, id).first<{ state: string; state_reason: string | null; last_error: string | null }>();
}

async function entriesFor(action: string) {
  const { results } = await testEnv.CATALOG.prepare(
    "SELECT action, actor_user_id, subject, detail FROM audit_entries WHERE org_id = ? AND action = ? ORDER BY seq",
  ).bind(ORG, action).all<{
    action: string; actor_user_id: string | null; subject: string | null; detail: string;
  }>();
  return results.map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
}

beforeEach(async () => {
  for (const table of ["approval_decisions", "approval_stages", "approvals", "policy_stages",
                       "policy_versions", "policies", "send_manifests", "send_recipients", "send_counters",
                       "relationship_tuples", "team_members", "teams", "butlers", "addresses", "mailboxes",
                       "users", "node_claim", "audit_entries", "outbox", "notifications"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_teams", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    ...[ADMIN, AUTHOR, ANN, BOB, DUAL, PLAIN].map((userId) => testEnv.CATALOG.prepare(
      "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
    ).bind(userId, ORG, `${userId}@local.invalid`, at)),
    // A real Butler row, so the refusal below is tested against the thing it is about rather than against a
    // made-up id: #51's concern is a published program inheriting a team's grants.
    testEnv.CATALOG.prepare(
      "INSERT INTO butlers (id, org_id, name, created_by, created_at) VALUES (?,?,?,?,?)",
    ).bind(BUTLER, ORG, "chase invoices", ADMIN, at),
  ]);
  await tuple(ADMIN, "org.admin", "organization", ORG);
  for (const relation of ["send.propose", "mailbox.content.read"]) {
    await tuple(AUTHOR, relation, "mailbox", MAILBOX);
  }
});

/* ------------------------------------------------------------------ the object ------------------ */

describe("a team is an object with a name, which is what #73 says was missing", () => {
  it("creates, names, renames and lists — and the name is unique in the organization", async () => {
    const finance = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "  Finance  ");
    expect(finance.name).toBe("Finance");
    expect(finance.createdBy).toBe(ADMIN);
    expect(await readTeam(testEnv, ORG, finance.id)).toEqual(finance);

    // The decision argued in 0032: two teams called "Finance" is how approval.decide is granted to the wrong
    // one, because a team is picked by a human reading a name and stored as an id.
    await expect(createTeam(testEnv, ctxAt(), ORG, ADMIN, "Finance"))
      .rejects.toThrow(/E_TEAM_NAME_TAKEN/);
    // The refusal names the team that already has it, so the fix is one step rather than a search.
    await expect(createTeam(testEnv, ctxAt(), ORG, ADMIN, "Finance")).rejects.toThrow(finance.id);
    await expect(createTeam(testEnv, ctxAt(), ORG, ADMIN, "   ")).rejects.toThrow(/E_TEAM_NEEDS_A_NAME/);

    const renamed = await renameTeam(testEnv, ctxAt(), ORG, ADMIN, finance.id, "Finance and payroll");
    expect(renamed.name).toBe("Finance and payroll");
    // A rename that changes nothing is refused, for the reason a no-op publish is: an entry claiming an act
    // nobody took.
    await expect(renameTeam(testEnv, ctxAt(), ORG, ADMIN, finance.id, "Finance and payroll"))
      .rejects.toThrow(/E_TEAM_NAME_UNCHANGED/);

    await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");
    const listed = await listTeams(testEnv, ORG);
    // Ordered by name, and carrying the size — the number a team-scoped policy turns on.
    expect(listed.map((team) => `${team.name}:${team.memberCount}`))
      .toEqual(["Finance and payroll:0", "Legal:0"]);
  });

  it("takes org.admin for every act, including the one that confers nothing", async () => {
    // Creating confers nothing on its own, so this is the act whose authority was worth arguing. It is
    // org.admin because the *name* comes out of a shared space other people's grants are chosen from.
    await expect(createTeam(testEnv, ctxAt(), ORG, ANN, "Legal"))
      .rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);

    const legal = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");
    for (const act of [
      () => renameTeam(testEnv, ctxAt(), ORG, ANN, legal.id, "Counsel"),
      () => addTeamMember(testEnv, ctxAt(), ORG, ANN, legal.id, BOB),
      () => removeTeamMember(testEnv, ctxAt(), ORG, ANN, legal.id, BOB),
    ]) {
      await expect(act()).rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);
    }
    // And nothing was written by any of the refusals.
    expect(await membersOf(testEnv, ORG, legal.id)).toEqual([]);
    expect((await readTeam(testEnv, ORG, legal.id))?.name).toBe("Legal");
  });

  it("adds and removes members idempotently, and never writes a second entry for one act", async () => {
    const legal = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");

    const first = await addTeamMember(testEnv, ctxAt(1), ORG, ADMIN, legal.id, BOB);
    expect(first).toEqual({ teamId: legal.id, userId: BOB, changed: true, members: 1 });
    // `tm_unique` has existed since 0001 and is what makes this a no-op rather than an error — checked
    // rather than assumed, which is #73's question about whether the table needed anything new.
    const replay = await addTeamMember(testEnv, ctxAt(2), ORG, ADMIN, legal.id, BOB);
    expect(replay.changed).toBe(false);
    expect(replay.members).toBe(1);
    expect(await membersOf(testEnv, ORG, legal.id)).toEqual([BOB]);
    // One act, one entry. A second would claim somebody was added twice.
    expect((await entriesFor("team.member_added")).length).toBe(1);

    const gone = await removeTeamMember(testEnv, ctxAt(3), ORG, ADMIN, legal.id, BOB);
    expect(gone).toEqual({ teamId: legal.id, userId: BOB, changed: true, members: 0 });
    const goneAgain = await removeTeamMember(testEnv, ctxAt(4), ORG, ADMIN, legal.id, BOB);
    expect(goneAgain.changed).toBe(false);
    expect((await entriesFor("team.member_removed")).length).toBe(1);
  });

  it("records the four acts, keyed on the person for membership and on the team for the rest", async () => {
    const legal = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");
    await renameTeam(testEnv, ctxAt(1), ORG, ADMIN, legal.id, "Counsel");
    await addTeamMember(testEnv, ctxAt(2), ORG, ADMIN, legal.id, BOB);
    await addTeamMember(testEnv, ctxAt(3), ORG, ADMIN, legal.id, ANN);
    await removeTeamMember(testEnv, ctxAt(4), ORG, ADMIN, legal.id, BOB);

    expect((await entriesFor("team.created"))[0]).toMatchObject({
      actor_user_id: ADMIN, subject: legal.id, detail: { name: "Legal" },
    });
    // Both names, which is the half a `renamed_at` column could not carry and the half somebody asks about.
    expect((await entriesFor("team.renamed"))[0]).toMatchObject({
      subject: legal.id, detail: { from: "Legal", to: "Counsel" },
    });
    // Keyed on the **person**, like `access.granted`, so "what authority did this person get" is one filter
    // across both doors into it.
    expect((await entriesFor("team.member_added")).map((entry) => entry.subject)).toEqual([BOB, ANN]);
    // And `remaining` is what attributes an emptying to the act that caused it.
    expect((await entriesFor("team.member_removed"))[0]).toMatchObject({
      subject: BOB, detail: { teamId: legal.id, remaining: 1 },
    });
    expect((await verifyChain(testEnv, ORG)).intact).toBe(true);
  });

  it("refuses a Butler, and refuses it by a join rather than by the shape of an id (#51)", async () => {
    const legal = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");

    // #51: a Butler's effective authority is `pinned ceiling ∩ its own tuples ∩ its sponsor's`, and a ceiling
    // whose second term moved whenever somebody edited a team would not be a ceiling.
    await expect(addTeamMember(testEnv, ctxAt(1), ORG, ADMIN, legal.id, BUTLER))
      .rejects.toThrow(/E_NOT_A_PERSON/);
    expect(await membersOf(testEnv, ORG, legal.id)).toEqual([]);

    // Not a prefix test: a plain string that is nobody at all is refused by the same rule, which is what
    // makes the guard survive an id space changing.
    await expect(addTeamMember(testEnv, ctxAt(2), ORG, ADMIN, legal.id, "usr_never_existed"))
      .rejects.toThrow(/E_NOT_A_PERSON/);
    // And a real person is not refused, so the check is a check rather than a wall.
    expect((await addTeamMember(testEnv, ctxAt(3), ORG, ADMIN, legal.id, PLAIN)).changed).toBe(true);
  });

  it("refuses membership of a team that does not exist, rather than writing a row that confers nothing", async () => {
    await expect(addTeamMember(testEnv, ctxAt(), ORG, ADMIN, "tm_nothing", BOB))
      .rejects.toThrow(/E_NO_SUCH_TEAM/);
  });
});

/* ------------------------------------------------------------------ the constraint -------------- */

describe("a team-scoped stage narrows the eligible set and never widens it (#73)", () => {
  it("lets a member of the named team decide and refuses an equally-granted non-member", async () => {
    const legal = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");
    await addTeamMember(testEnv, ctxAt(1), ORG, ADMIN, legal.id, BOB);
    // Both hold the relation. Only one is in the team.
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    expect((await decidersOf(testEnv, ORG, MAILBOX)).size).toBe(2);

    await requireApproval("legal reviews", [stageOf(1, legal.id)]);
    const sealed = await seal();
    expect(sealed.state).toBe("awaiting");
    const approval = (await approvalRow(sealed.id))!;
    // The constraint is frozen with the request, team and all.
    expect(await stagesOfApproval(testEnv, approval.id)).toEqual([stageOf(1, legal.id)]);

    // Ann holds approval.decide on this mailbox and is outside the team: narrowed out. This is the assertion
    // the whole constraint exists for, and without the re-check in `decideApproval` it passes silently.
    await expect(decideApproval(testEnv, ctxAt(2000), ORG, ANN, approval.id, "approve"))
      .rejects.toThrow(/E_APPROVER_NOT_IN_TEAM/);
    // The refusal names the team, which is what makes it actionable.
    await expect(decideApproval(testEnv, ctxAt(2000), ORG, ANN, approval.id, "approve"))
      .rejects.toThrow(/Legal/);
    expect((await manifestRow(sealed.id))?.state).toBe("awaiting");

    const decided = await decideApproval(testEnv, ctxAt(3000), ORG, BOB, approval.id, "approve");
    expect(decided.completed).toBe(true);
    expect((await manifestRow(sealed.id))?.state).toBe("held");
  });

  it("never lets naming a team make somebody eligible who holds no relation", async () => {
    // The load-bearing direction. Ann is in the team and holds nothing on the mailbox; the intersection has
    // to remove her, not add her.
    const legal = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");
    await addTeamMember(testEnv, ctxAt(1), ORG, ADMIN, legal.id, ANN);
    await addTeamMember(testEnv, ctxAt(2), ORG, ADMIN, legal.id, BOB);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);

    // Two members of Legal, one holder: a stage of 2 from Legal is refused at publication.
    await expect(requireApproval("two lawyers", [stageOf(2, legal.id)]))
      .rejects.toThrow(/E_APPROVAL_UNSATISFIABLE/);
    await requireApproval("one lawyer", [stageOf(1, legal.id)]);
    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    await expect(decideApproval(testEnv, ctxAt(2000), ORG, ANN, approval.id, "approve"))
      .rejects.toThrow(/E_NO_APPROVAL/);
  });

  it("sequences two teams: one from finance, then one from legal (§18's separation of duty)", async () => {
    const finance = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Finance");
    const legal = await createTeam(testEnv, ctxAt(1), ORG, ADMIN, "Legal");
    await addTeamMember(testEnv, ctxAt(2), ORG, ADMIN, finance.id, ANN);
    await addTeamMember(testEnv, ctxAt(3), ORG, ADMIN, legal.id, BOB);
    for (const person of [ANN, BOB]) await tuple(person, "approval.decide", "mailbox", MAILBOX);

    await requireApproval("finance then legal", [stageOf(1, finance.id), stageOf(1, legal.id)]);
    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;

    // Bob is in Legal, which is stage 2 — he cannot take stage 1 out of order, and the order is on the
    // stages rather than on the people.
    await expect(decideApproval(testEnv, ctxAt(2000), ORG, BOB, approval.id, "approve"))
      .rejects.toThrow(/E_APPROVER_NOT_IN_TEAM/);
    expect((await decideApproval(testEnv, ctxAt(3000), ORG, ANN, approval.id, "approve")).openStage).toBe(2);
    // And now Bob's stage is open.
    expect((await decideApproval(testEnv, ctxAt(4000), ORG, BOB, approval.id, "approve")).completed).toBe(true);
    expect((await manifestRow(sealed.id))?.state).toBe("held");
  });
});

describe("one person in two real teams still cannot satisfy a count of 2 (#61, re-tested with #73's teams)", () => {
  /*
   * #61's sharpest finding, re-run against teams that exist as objects rather than as ids somebody seeded by
   * hand. Teams becoming real makes this case *easier* to construct — an administrator can now build it in
   * three API calls — so it is asserted again rather than assumed to still hold.
   *
   * **Non-vacuity note:** if distinctness were measured on the tuple, the first assertion below would pass
   * and the second would too — the count would simply reach 2 with one human being, and nothing would look
   * wrong. That is why this is asserted from three directions: the resolved decider set, the publication
   * refusal, and the live refusal of a second decision.
   */
  it("counts one human being in two approval.decide teams as ONE decider", async () => {
    const a = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Duty A");
    const b = await createTeam(testEnv, ctxAt(1), ORG, ADMIN, "Duty B");
    await addTeamMember(testEnv, ctxAt(2), ORG, ADMIN, a.id, DUAL);
    await addTeamMember(testEnv, ctxAt(3), ORG, ADMIN, b.id, DUAL);
    await tuple(a.id, "approval.decide", "mailbox", MAILBOX);
    await tuple(b.id, "approval.decide", "mailbox", MAILBOX);

    const tuples = await testEnv.CATALOG.prepare(
      `SELECT COUNT(*) AS n FROM relationship_tuples
        WHERE org_id = ? AND relation = 'approval.decide' AND object_id = ?`,
    ).bind(ORG, MAILBOX).first<{ n: number }>();
    expect(tuples?.n).toBe(2);
    expect([...await decidersOf(testEnv, ORG, MAILBOX)]).toEqual([DUAL]);

    await expect(requireApproval("dual control", [stageOf(2)]))
      .rejects.toThrow(/E_APPROVAL_UNSATISFIABLE/);
  });

  it("cannot fill two slots of one team-scoped stage either, which is the new way to build the case", async () => {
    // The version #73 makes easy: one team, one member, a stage asking that team for two decisions.
    const duty = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Duty managers");
    await addTeamMember(testEnv, ctxAt(1), ORG, ADMIN, duty.id, DUAL);
    await tuple(duty.id, "approval.decide", "mailbox", MAILBOX);
    // And a second, unrelated holder, so the *mailbox* has two deciders and only the team is short.
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    expect((await decidersOf(testEnv, ORG, MAILBOX)).size).toBe(2);

    await expect(requireApproval("two duty managers", [stageOf(2, duty.id)]))
      .rejects.toThrow(/stage 1 needs 2 distinct approver\(s\) holding approval\.decide on mailbox/);
    // The shortfall names the team, so an administrator is told to grow the team rather than to grant more.
    await expect(requireApproval("two duty managers again", [stageOf(2, duty.id)]))
      .rejects.toThrow(/in team Duty managers/);
  });

  it("lets the dual-hat person take exactly one slot when a second real person exists", async () => {
    const a = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Duty A");
    const b = await createTeam(testEnv, ctxAt(1), ORG, ADMIN, "Duty B");
    for (const team of [a, b]) {
      await addTeamMember(testEnv, ctxAt(2), ORG, ADMIN, team.id, DUAL);
      await tuple(team.id, "approval.decide", "mailbox", MAILBOX);
    }
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("dual control", [stageOf(2)]);

    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    expect((await decideApproval(testEnv, ctxAt(2000), ORG, DUAL, approval.id, "approve")).completed)
      .toBe(false);
    // The assertion that would pass silently if distinctness were on the tuple.
    await expect(decideApproval(testEnv, ctxAt(3000), ORG, DUAL, approval.id, "approve"))
      .rejects.toThrow(/E_ALREADY_DECIDED/);
    expect((await manifestRow(sealed.id))?.state).toBe("awaiting");
    expect((await decideApproval(testEnv, ctxAt(4000), ORG, ANN, approval.id, "approve")).completed)
      .toBe(true);
  });
});

/* ------------------------------------------------------------------ publication ----------------- */

describe("publication verifies the team, which is what a teams row makes possible (#73)", () => {
  it("refuses a stage naming a team that does not exist", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    // The check #73 says was impossible before: a misspelled team and a quiet team are indistinguishable if
    // all publication can ask is whether anybody is in it.
    await expect(requireApproval("ghost team", [stageOf(1, "tm_ghost")]))
      .rejects.toThrow(/E_NO_SUCH_TEAM/);
  });

  it("refuses a stage naming a team that is already empty, with the shortfall named", async () => {
    const legal = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    // The team exists — so this is not `E_NO_SUCH_TEAM` — and nobody is in it, which is a different answer
    // and gets a different refusal.
    await expect(requireApproval("empty legal", [stageOf(1, legal.id)]))
      .rejects.toThrow(/E_APPROVAL_UNSATISFIABLE/);
    await expect(requireApproval("empty legal again", [stageOf(1, legal.id)]))
      .rejects.toThrow(/stage 1 needs 1 distinct approver\(s\).*in team Legal/);
  });

  it("refuses two live rules asking one ordinal for two different teams", async () => {
    const finance = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Finance");
    const legal = await createTeam(testEnv, ctxAt(1), ORG, ADMIN, "Legal");
    for (const [team, person] of [[finance, ANN], [legal, BOB]] as const) {
      await addTeamMember(testEnv, ctxAt(2), ORG, ADMIN, team.id, person);
      await tuple(person, "approval.decide", "mailbox", MAILBOX);
    }

    await requireApproval("finance reviews", [stageOf(1, finance.id)]);
    // Both would gate the same sends, and "a member of Finance and a member of Legal" is not a stage.
    await expect(requireApproval("legal reviews", [stageOf(1, legal.id)]))
      .rejects.toThrow(/E_POLICY_STAGE_TEAM_CONFLICT/);

    // On a different mailbox they are provably disjoint, so the pair is allowed — which is the shape
    // separation of duty is actually written in, and a tripwire a good policy trips is a wrong tripwire.
    await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind("mbx_teams_other", ORG, "Billing", new Date(AUGUST_10).toISOString()).run();
    await tuple(BOB, "approval.decide", "mailbox", "mbx_teams_other");
    const other = await createPolicyDraft(testEnv, ctxAt(), ORG, ADMIN, {
      name: "legal reviews billing", outcome: "require_approval",
      conditions: { mailboxId: "mbx_teams_other" }, stages: [stageOf(1, legal.id)],
    });
    await expect(publishPolicy(testEnv, ctxAt(), ORG, ADMIN, other.policyId)).resolves.toBeTruthy();

    // And the fold at the seal is unambiguous, because publication made it so.
    const sealed = await seal();
    expect(sealed.state).toBe("awaiting");
    expect(await stagesOfApproval(testEnv, (await approvalRow(sealed.id))!.id))
      .toEqual([stageOf(1, finance.id)]);
  });

  it("treats a stage's team as content, so changing only the team is a real publication", async () => {
    /*
     * The canonical hash covers the stage set, and #73 puts the team inside it. Without that, two rules that
     * gate identically-but-for-the-team would hash the same and the second publish would be refused as a
     * no-op — a rule an administrator wrote, refused for changing nothing, when it changed who reviews.
     */
    const finance = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Finance");
    const legal = await createTeam(testEnv, ctxAt(1), ORG, ADMIN, "Legal");
    for (const [team, person] of [[finance, ANN], [legal, BOB]] as const) {
      await addTeamMember(testEnv, ctxAt(2), ORG, ADMIN, team.id, person);
      await tuple(person, "approval.decide", "mailbox", MAILBOX);
    }

    const draft = await createPolicyDraft(testEnv, ctxAt(), ORG, ADMIN, {
      name: "who reviews", outcome: "require_approval",
      conditions: { mailboxId: MAILBOX }, stages: [stageOf(1, finance.id)],
    });
    await publishPolicy(testEnv, ctxAt(), ORG, ADMIN, draft.policyId);
    await editPolicyDraft(testEnv, ctxAt(3), ORG, ADMIN, draft.policyId, {
      outcome: "require_approval", conditions: { mailboxId: MAILBOX }, stages: [stageOf(1, legal.id)],
    });
    // Same count, same conditions, same outcome — a different team, and therefore a different rule.
    await expect(publishPolicy(testEnv, ctxAt(4), ORG, ADMIN, draft.policyId)).resolves.toMatchObject({
      version: 2,
    });
    const sealed = await seal(5000);
    expect(await stagesOfApproval(testEnv, (await approvalRow(sealed.id))!.id))
      .toEqual([stageOf(1, legal.id)]);
  });

  it("folds a team-naming version with a team-less one by narrowing, never by dropping the team", async () => {
    const legal = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");
    await addTeamMember(testEnv, ctxAt(1), ORG, ADMIN, legal.id, BOB);
    for (const person of [ANN, BOB]) await tuple(person, "approval.decide", "mailbox", MAILBOX);

    const plain = await createPolicyDraft(testEnv, ctxAt(), ORG, ADMIN, {
      name: "any approver", outcome: "require_approval",
      conditions: { mailboxId: MAILBOX }, stages: [stageOf(1)],
    });
    const live = await publishPolicy(testEnv, ctxAt(), ORG, ADMIN, plain.policyId);
    const scoped = await createPolicyDraft(testEnv, ctxAt(), ORG, ADMIN, {
      name: "legal reviews", outcome: "require_approval",
      conditions: { mailboxId: MAILBOX }, stages: [stageOf(1, legal.id)],
    });
    const liveScoped = await publishPolicy(testEnv, ctxAt(), ORG, ADMIN, scoped.policyId);

    // The narrower of the two wins, which is the only direction Layer 5 permits.
    expect(await requiredStages(testEnv, [live.versionId, liveScoped.versionId]))
      .toEqual([stageOf(1, legal.id)]);
  });
});

/* ------------------------------------------------------------------ emptying -------------------- */

describe("a policy whose team is emptied becomes unsatisfiable at evaluation, not silently stuck", () => {
  it("withholds the send and names which stage, which team and how many short", async () => {
    const legal = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");
    await addTeamMember(testEnv, ctxAt(1), ORG, ADMIN, legal.id, BOB);
    for (const person of [ANN, BOB]) await tuple(person, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("legal reviews", [stageOf(1, legal.id)]);

    // Satisfiable while Bob is in the team.
    expect((await seal(1000)).state).toBe("awaiting");

    // The interesting act: the last member leaves. It is **permitted**, exactly as revoking the last
    // approval.decide holder is — #61 settled that a live policy may become unsatisfiable, loudly, rather
    // than a membership change being refused because a rule depends on it.
    const removal = await removeTeamMember(testEnv, ctxAt(2), ORG, ADMIN, legal.id, BOB);
    expect(removal.members).toBe(0);
    expect((await entriesFor("team.member_removed"))[0]?.detail.remaining).toBe(0);

    const stuck = await seal(3000);
    expect(stuck.state).toBe("withheld");
    expect(stuck.stateReason).toBe("approval_unsatisfiable");
    // Not parked in `awaiting`, and no approval row: there would be nothing to decide.
    expect(await approvalRow(stuck.id)).toBeNull();
    expect(stuck.approvalShortfall?.ordinal).toBe(1);
    expect(stuck.approvalShortfall?.team).toEqual({ id: legal.id, name: "Legal" });
    // And the prose a person reads names the team, beside the machine token.
    expect((await manifestRow(stuck.id))?.last_error).toContain("in team Legal");

    // Reversible: put somebody back and the next send is gated again rather than refused.
    await addTeamMember(testEnv, ctxAt(4), ORG, ADMIN, legal.id, ANN);
    expect((await seal(5000)).state).toBe("awaiting");
  });

  it("is re-checked at the decision too, so leaving a team stops a decision on the next request", async () => {
    const legal = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");
    for (const person of [ANN, BOB]) {
      await addTeamMember(testEnv, ctxAt(1), ORG, ADMIN, legal.id, person);
      await tuple(person, "approval.decide", "mailbox", MAILBOX);
    }
    await requireApproval("legal reviews", [stageOf(1, legal.id)]);
    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;

    // The request froze the team's **id**, deliberately not its members. Bob leaves after the request was
    // opened and before he decides.
    await removeTeamMember(testEnv, ctxAt(2000), ORG, ADMIN, legal.id, BOB);
    await expect(decideApproval(testEnv, ctxAt(3000), ORG, BOB, approval.id, "approve"))
      .rejects.toThrow(/E_APPROVER_NOT_IN_TEAM/);
    // Ann is still in it, so the request is not broken — only Bob's authority went.
    expect((await decideApproval(testEnv, ctxAt(4000), ORG, ANN, approval.id, "approve")).completed)
      .toBe(true);
  });
});

/* ------------------------------------------------------------------ the query cost -------------- */

describe("resolving a team costs an index range, not a table scan (#73, 0020's finding re-printed)", () => {
  it("reads the roster out of covering indexes", async () => {
    const legal = await createTeam(testEnv, ctxAt(), ORG, ADMIN, "Legal");
    await addTeamMember(testEnv, ctxAt(1), ORG, ADMIN, legal.id, BOB);

    const plan = await testEnv.CATALOG.prepare(
      `EXPLAIN QUERY PLAN
       SELECT t.id, t.name, m.user_id
         FROM teams t
         LEFT JOIN team_members m ON m.org_id = t.org_id AND m.team_id = t.id
        WHERE t.org_id = ? AND t.id IN (?)`,
    ).bind(ORG, legal.id).all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    for (const detail of details) console.log(`PLAN rostersOf  ${detail}`);

    // 0020 printed this for the *other* direction and it is re-printed here rather than inherited: the
    // membership side is a range inside `tm_unique`, bounded by one organization's headcount rather than by
    // mail volume, and the team side is a primary-key seek.
    expect(details.some((detail) => detail.includes("tm_unique"))).toBe(true);
    expect(details.some((detail) => /SCAN\s+(m|team_members)\b/.test(detail)),
      "reading team_members rows rather than an index").toBe(false);
  });

  it("asks nothing at all when no stage names a team, which is what keeps an ordinary send unchanged", async () => {
    // The laziness the receipt turns on: `rostersOf` short-circuits an empty request before it prepares
    // anything, so a send gated by a team-less policy pays exactly what it paid before #73.
    expect(await rostersOf(testEnv, ORG, [])).toEqual(new Map());
    // And an unknown team comes back absent rather than empty, which is the distinction publication needs.
    expect(await rostersOf(testEnv, ORG, ["tm_ghost"])).toEqual(new Map());
  });
});
