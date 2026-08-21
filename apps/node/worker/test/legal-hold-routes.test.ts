import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { hashPassword } from "../src/auth/password.ts";
import { login } from "../src/auth/session.ts";
import { placeHold } from "../src/holds.ts";
import { saveDraft } from "../src/drafts.ts";

/**
 * The legal hold **through the HTTP surface** (#64).
 *
 * `test/legal-hold.test.ts` calls the functions. This file goes through the routes, because three claims in
 * this change are claims about what a *caller* is told, and a function-level test cannot check any of them:
 *
 *   - `POST /api/holds` is the only way to place one, and `org.admin` is the only principal who may.
 *   - `DELETE /api/drafts/:id` answers **409 with the Node's four-part message**. `index.ts` records the
 *     decision not to catch it there — "somebody pressing discard is owed the reason" — and that is a
 *     statement about a response body, so it is asserted against one.
 *   - `POST /api/sends` **succeeds** from a held mailbox and reports `draftRetained: true`. That was
 *     documented in `application-shell.md` and `evidence-lifecycle.md` with nothing checking it, which is the
 *     claim-without-a-check shape AGENTS.md treats as a defect. A send that started failing under a hold, or
 *     a field that quietly stopped being sent, would have been invisible.
 */

const testEnv = env as unknown as Env;
const ORG = "org_hold_routes";
const HELD_MAILBOX = "mbx_routes_held";
const ADDRESS = "support@acme.example";
const ADMIN = "usr_routes_admin";
const ANA = "usr_routes_ana";
/** The second approver: a lift takes two people who are not the one who asked. */
const BEN = "usr_routes_ben";
const PASSWORD = "fixture-password-not-a-real-secret";

async function sessionFor(userId: string): Promise<string> {
  const ctx = createSystemCtx();
  const outcome = await login(testEnv, ctx, ORG, `${userId}@acme.example`, PASSWORD);
  if (outcome.status !== "signed_in") throw new Error(`could not sign in ${userId}: ${outcome.status}`);
  return outcome.session.accessToken;
}

function as(token: string, body?: unknown): RequestInit {
  return {
    method: "POST",
    headers: { cookie: `mailda_at=${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

beforeEach(async () => {
  for (const table of ["approval_decisions", "approval_stages", "approvals", "hold_lifts",
                       "holds", "drafts", "send_manifests", "send_recipients", "send_counters",
                       "relationship_tuples", "addresses", "mailboxes", "users", "node_claim",
                       "login_attempts", "sessions", "refresh_tokens", "audit_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_routes", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(HELD_MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, HELD_MAILBOX, at),
  ]);

  for (const userId of [ADMIN, ANA, BEN]) {
    await testEnv.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations,
         password_updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, ORG, `${userId}@acme.example`, at, verifier.encoded, verifier.effectiveIterations, at)
      .run();
    for (const relation of ["mailbox.content.read", "send.propose"]) {
      await testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind(ctx.id("rt"), ORG, userId, relation, "mailbox", HELD_MAILBOX, at).run();
    }
  }

  // Ana and Ben can decide an approval; the administrator cannot decide their own request.
  for (const userId of [ANA, BEN]) {
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, userId, "approval.decide", "mailbox", HELD_MAILBOX, at).run();
  }

  // Only the administrator holds org.admin. Ana is a real, authenticated member without it.
  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, ADMIN, "org.admin", "organization", ORG, at).run();
});

const composition = {
  mailboxId: HELD_MAILBOX,
  to: ["customer@example.net"],
  subject: "Demurrage on MSKU4471203",
  body: "Charges stop today.",
};

describe("POST /api/holds is the only way to place one", () => {
  it("places a hold for an administrator", async () => {
    const response = await SELF.fetch(
      "https://node/api/holds",
      as(await sessionFor(ADMIN), { mailboxId: HELD_MAILBOX, matterId: "mat_acme", fromDate: "2026-08-01" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { hold: { id: string; mailboxId: string; toDate: string | null } };
    expect(body.hold.mailboxId).toBe(HELD_MAILBOX);
    // An absent bound stays absent through the route rather than being invented as "today".
    expect(body.hold.toDate).toBeNull();
  });

  it("refuses a member who does not hold org.admin, and places nothing", async () => {
    const response = await SELF.fetch(
      "https://node/api/holds",
      as(await sessionFor(ANA), { mailboxId: HELD_MAILBOX }),
    );
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe("E_NOT_AN_ADMINISTRATOR");
    const row = await testEnv.CATALOG.prepare("SELECT id FROM holds WHERE org_id = ?").bind(ORG).first();
    expect(row).toBeNull();
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await SELF.fetch("https://node/api/holds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mailboxId: HELD_MAILBOX }),
    });
    expect(response.status).toBe(401);
  });
});

describe("POST /api/holds/:id/lift asks; the approvals endpoints decide", () => {
  it("refuses a member who does not hold org.admin", async () => {
    const hold = await placeHold(testEnv, createSystemCtx(), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const response = await SELF.fetch(
      `https://node/api/holds/${hold.id}/lift`,
      as(await sessionFor(ANA), { reason: "I would like this gone" }),
    );
    expect(response.status).toBe(403);
    const lifts = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM hold_lifts").first<{ n: number }>();
    expect(lifts?.n).toBe(0);
  });

  it("refuses a request with no reason at all, rather than inventing one", async () => {
    const hold = await placeHold(testEnv, createSystemCtx(), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    // No `reason` key. The route passes the empty string through so the refusal comes from one place, with
    // its four parts, rather than being defaulted here into "no reason given" — which would be this Node
    // writing a justification for re-permitting destruction.
    const response = await SELF.fetch(`https://node/api/holds/${hold.id}/lift`, as(await sessionFor(ADMIN), {}));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("E_HOLD_LIFT_REASON_REQUIRED");
    expect(body.message).toContain("fix");
  });

  it("opens a request the requester cannot decide, and two others can", async () => {
    const hold = await placeHold(testEnv, createSystemCtx(), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const asked = await SELF.fetch(
      `https://node/api/holds/${hold.id}/lift`,
      as(await sessionFor(ADMIN), { reason: "matter closed on 9 August" }),
    );
    expect(asked.status).toBe(200);
    const { lift } = await asked.json() as {
      lift: { liftId: string; approvalId: string; stages: number[]; eligible: number };
    };
    expect(lift.stages).toEqual([{ count: 2, teamId: null }]);
    expect(lift.eligible).toBe(2);

    // The administrator is given approval.decide as well, so nothing but the actor exclusion stands between
    // them and lifting their own request. Without this the refusal would be §5C's 404 — "not an approval you
    // may decide" — which is also correct and does not test the exclusion at all.
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(createSystemCtx().id("rt"), ORG, ADMIN, "approval.decide", "mailbox", HELD_MAILBOX,
      new Date(createSystemCtx().now()).toISOString()).run();

    // The requester's own decision, refused through the ordinary decide endpoint. 409, because the request is
    // well-formed and it is the *state* — whose act this is — that does not permit it.
    const own = await SELF.fetch(
      `https://node/api/approvals/${lift.approvalId}/decide`,
      as(await sessionFor(ADMIN), { decision: "approve" }),
    );
    expect(own.status).toBe(409);
    expect((await own.json() as { error: string }).error).toBe("E_APPROVER_IS_ACTOR");

    // Ana sees it in the queue **with the reason**, which is what she is being asked to agree to.
    const queue = await SELF.fetch("https://node/api/approvals", {
      headers: { cookie: `mailda_at=${await sessionFor(ANA)}` },
    });
    const { approvals } = await queue.json() as {
      approvals: Array<{ id: string; subjectKind: string; reason: string | null }>;
    };
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.subjectKind).toBe("hold_lift");
    expect(approvals[0]!.reason).toBe("matter closed on 9 August");

    // Two decisions, through the same endpoint a send's approval uses. No second plane for the lift.
    for (const [userId, expected] of [[ANA, false], [BEN, true]] as const) {
      const decided = await SELF.fetch(
        `https://node/api/approvals/${lift.approvalId}/decide`,
        as(await sessionFor(userId), { decision: "approve" }),
      );
      expect(decided.status).toBe(200);
      const body = await decided.json() as { decided: { holdLifted: boolean } };
      expect(body.decided.holdLifted).toBe(expected);
    }

    const row = await testEnv.CATALOG.prepare("SELECT lifted_at, lifted_reason FROM holds WHERE id = ?")
      .bind(hold.id).first<{ lifted_at: string | null; lifted_reason: string | null }>();
    expect(row?.lifted_at).not.toBeNull();
    expect(row?.lifted_reason).toBe("matter closed on 9 August");
  });

  it("requires authentication, like every other governed surface", async () => {
    const hold = await placeHold(testEnv, createSystemCtx(), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const response = await SELF.fetch(`https://node/api/holds/${hold.id}/lift`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "no session" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/drafts/:id answers the refusal rather than swallowing it", () => {
  it("returns 409 and the Node's four-part message, naming the hold", async () => {
    const ctx = createSystemCtx();
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);
    const hold = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const response = await SELF.fetch(`https://node/api/drafts/${saved.id}`, {
      method: "DELETE",
      headers: { cookie: `mailda_at=${await sessionFor(ANA)}` },
    });

    // 409, not 403 and not `{ deleted: false }`: the request is well-formed and it is the state that does
    // not permit it. `{ deleted: false }` would say the draft is still there without saying why.
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("E_LEGAL_HOLD");
    expect(body.message).toContain(hold.id);
    expect(body.message).toContain("fix");
    // The remedy exists now and the message names it: request a lift, and two other people decide. The
    // assertion was "#61" while there was no lift and the honest remedy was "there is none yet".
    expect(body.message).toContain("/lift");
    expect(body.message).toContain("#64");

    const row = await testEnv.CATALOG.prepare("SELECT id FROM drafts WHERE id = ?").bind(saved.id).first();
    expect(row, "the row a refused deletion must leave alone").not.toBeNull();
  });
});

describe("POST /api/sends from a held mailbox sends, and says the draft was kept", () => {
  it("reports draftRetained and leaves the draft in place", async () => {
    const ctx = createSystemCtx();
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);
    await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const response = await SELF.fetch(
      "https://node/api/sends",
      as(await sessionFor(ANA), { ...composition, draftId: saved.id }),
    );

    // The send must not fail: the manifest is sealed and the message is leaving. Answering 409 here would
    // tell somebody their send failed when it did not.
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; draftRetained: boolean };
    expect(body.id).toMatch(/^snd_/);
    expect(body.draftRetained, "the field the docs promise a caller").toBe(true);

    const row = await testEnv.CATALOG.prepare("SELECT id FROM drafts WHERE id = ?").bind(saved.id).first();
    expect(row, "preserved on purpose, which is why the caller is told").not.toBeNull();

    // The attempt is in the trail even though the send succeeded, which is what makes the reported field a
    // convenience rather than the only record of it.
    const blocked = await testEnv.CATALOG.prepare(
      "SELECT subject FROM audit_entries WHERE org_id = ? AND action = 'hold.blocked'",
    ).bind(ORG).all<{ subject: string }>();
    expect(blocked.results.map((entry) => entry.subject)).toEqual([saved.id]);
  });

  it("reports draftRetained false and retires the draft when no hold covers it", async () => {
    // The other half, so `draftRetained: true` is the hold and not a field that is always true.
    const ctx = createSystemCtx();
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);

    const response = await SELF.fetch(
      "https://node/api/sends",
      as(await sessionFor(ANA), { ...composition, draftId: saved.id }),
    );
    expect(response.status).toBe(200);
    expect((await response.json() as { draftRetained: boolean }).draftRetained).toBe(false);

    const row = await testEnv.CATALOG.prepare("SELECT id FROM drafts WHERE id = ?").bind(saved.id).first();
    expect(row).toBeNull();
  });
});
