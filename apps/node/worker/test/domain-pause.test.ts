import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { decideApproval, pendingApprovals, stageOf } from "../src/approvals.ts";
import { evaluateBreakers, pausesInForce } from "../src/breakers.ts";
import { liftDomainPause, requestDomainPause } from "../src/domain-pause.ts";
import { runDoctor } from "../src/doctor.ts";
import { dispatchOne, type SendState } from "../src/outbound/dispatch.ts";
import { sealManifest } from "../src/outbound/manifest.ts";
import type { SubmitOutcome, TransportAdapter } from "../src/outbound/transport.ts";

/**
 * The domain-wide send pause (#66): **ceremony to place, one administrator to lift**.
 *
 * ## The asymmetry is the subject of this file
 *
 * #64 made placing a legal hold easy and lifting it hard, because placing only preserves. Placing a domain
 * pause **stops a customer's mail**, so the safe direction reverses: two administrators and a mandatory
 * reason to place, one administrator alone to lift. Same principle, opposite conclusion.
 *
 * That is easy to state and easy to get wrong in either direction, so both halves are asserted here as
 * *refusals* rather than as successes: one administrator cannot place a pause, and a second administrator is
 * not needed to lift one. A test that only showed the happy path would pass against a design that required
 * two for both, or one for both.
 *
 * ## And the fifth approval subject is the same machinery, not a second copy
 *
 * A pause is decided at `POST /api/approvals/:id/decide`, by `decideApproval`, with the same fold, the same
 * eligible set, the same completion predicate and the same conditional UPDATE every other subject uses. What
 * is new is only where the eligible set comes from — `org.admin` on the organization rather than
 * `approval.decide` on a mailbox — which is the second source migration 0021 said this kind would need.
 */

const testEnv = env as unknown as Env;
const ORG = "org_pause";
const MAILBOX = "mbx_pause";
const ADDRESS = "support@acme.example";
const AUTHOR = "usr_author_dp";
const ADMIN_A = "usr_admin_a";
const ADMIN_B = "usr_admin_b";
const ADMIN_C = "usr_admin_c";

const AUGUST_20 = Date.parse("2026-08-20T12:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

const acceptingTransport: TransportAdapter = {
  name: "test-accepting",
  capability: async () => ({
    canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "test",
  }),
  submit: async (): Promise<SubmitOutcome> =>
    ({ kind: "handed_over", transportMessageId: "<x@acme.example>" }),
};

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId,
    new Date(ctx.now()).toISOString()).run();
}

async function user(id: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    "INSERT OR IGNORE INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(id, ORG, `${id}@local.invalid`, new Date(ctx.now()).toISOString()).run();
}

/** Requested by A, approved by B and C: the two-administrator ceremony, end to end. */
async function placed(reason = "outbound spam from a compromised key"): Promise<string> {
  const requested = await requestDomainPause(
    testEnv, atTime(AUGUST_20), ORG, ADMIN_A, "acme.example", reason,
  );
  await decideApproval(testEnv, atTime(AUGUST_20 + 1_000), ORG, ADMIN_B, requested.approvalId, "approve");
  await decideApproval(testEnv, atTime(AUGUST_20 + 2_000), ORG, ADMIN_C, requested.approvalId, "approve");
  return requested.pauseId;
}

async function seal(at: number) {
  return sealManifest(testEnv, atTime(at), ORG, {
    mailboxId: MAILBOX,
    authorUserId: AUTHOR,
    to: ["customer@example.net"],
    subject: "Hello",
    bodyTyped: "Body.",
    fidelity: "authored",
  });
}

async function manifestRow(id: string) {
  return testEnv.CATALOG.prepare(
    "SELECT state, state_reason, last_error, release_at FROM send_manifests WHERE org_id = ? AND id = ?",
  ).bind(ORG, id).first<{
    state: SendState; state_reason: string | null; last_error: string | null; release_at: string;
  }>();
}

beforeEach(async () => {
  for (const table of ["send_manifests", "send_recipients", "send_recipient_events", "domain_pauses",
                       "approvals", "approval_stages", "approval_decisions", "notifications",
                       "relationship_tuples", "mailboxes", "addresses", "users", "audit_entries",
                       "node_claim", "policies", "policy_versions", "conversations", "cases", "outbox",
                       "messages", "ingress_receipts", "send_counters"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
    .bind(MAILBOX, ORG, "Support", at).run();
  await testEnv.CATALOG.prepare(
    "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
  ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at).run();
  for (const id of [AUTHOR, ADMIN_A, ADMIN_B, ADMIN_C]) await user(id);
  for (const id of [ADMIN_A, ADMIN_B, ADMIN_C]) await tuple(id, "org.admin", "organization", ORG);
  await tuple(AUTHOR, "send.propose", "mailbox", MAILBOX);
  await tuple(AUTHOR, "mailbox.content.read", "mailbox", MAILBOX);
});

/* ---------------------------------------------------- placing takes two ----------------------------- */

describe("placing a pause takes two administrators and a reason", () => {
  it("does not stop any mail on the strength of the request alone", async () => {
    const requested = await requestDomainPause(
      testEnv, atTime(AUGUST_20), ORG, ADMIN_A, "acme.example", "suspected compromise",
    );
    expect(requested.stages).toEqual([stageOf(2)]);
    // Two, not three: the requester is removed from their own request by `planApproval`, which is §18's
    // separation of duty applied once rather than by every caller.
    expect(requested.eligible).toBe(2);

    // The row exists and confers nothing. This is the assertion that separates a *request* from a pause,
    // and it is where a design that placed on request would be caught.
    expect(await pausesInForce(testEnv, ORG)).toEqual([]);
    const decision = await evaluateBreakers(testEnv, atTime(AUGUST_20 + 1_000), ORG, "acme.example");
    expect(decision.pause).toBeNull();
    expect((await seal(AUGUST_20 + 1_000)).state).toBe("held");
  });

  it("is still not in force after ONE approval", async () => {
    const requested = await requestDomainPause(
      testEnv, atTime(AUGUST_20), ORG, ADMIN_A, "acme.example", "suspected compromise",
    );
    const first = await decideApproval(
      testEnv, atTime(AUGUST_20 + 1_000), ORG, ADMIN_B, requested.approvalId, "approve",
    );
    expect(first.completed).toBe(false);
    expect(first.domainPaused).toBe(false);
    expect(await pausesInForce(testEnv, ORG)).toEqual([]);
    expect((await seal(AUGUST_20 + 2_000)).state).toBe("held");
  });

  it("comes into force on the second, and the two are distinct people", async () => {
    const requested = await requestDomainPause(
      testEnv, atTime(AUGUST_20), ORG, ADMIN_A, "acme.example", "suspected compromise",
    );
    await decideApproval(testEnv, atTime(AUGUST_20 + 1_000), ORG, ADMIN_B, requested.approvalId, "approve");
    const second = await decideApproval(
      testEnv, atTime(AUGUST_20 + 2_000), ORG, ADMIN_C, requested.approvalId, "approve",
    );
    expect(second.completed).toBe(true);
    expect(second.domainPaused).toBe(true);

    const live = await pausesInForce(testEnv, ORG);
    expect(live.map((pause) => pause.domain)).toEqual(["acme.example"]);
    expect(live[0]!.reason).toBe("suspected compromise");
  });

  it("refuses the requester as one of the two, which is what stops one person pausing a domain", async () => {
    const requested = await requestDomainPause(
      testEnv, atTime(AUGUST_20), ORG, ADMIN_A, "acme.example", "suspected compromise",
    );
    await expect(
      decideApproval(testEnv, atTime(AUGUST_20 + 1_000), ORG, ADMIN_A, requested.approvalId, "approve"),
    ).rejects.toThrow(/E_APPROVER_IS_ACTOR|you asked to pause this domain/);
  });

  it("refuses a blank reason, because the approvers read it before they agree", async () => {
    await expect(
      requestDomainPause(testEnv, atTime(AUGUST_20), ORG, ADMIN_A, "acme.example", "   "),
    ).rejects.toThrow(/E_DOMAIN_PAUSE_REASON_REQUIRED/);
    // Nothing was written, so a refused request leaves no row for the next one to collide with.
    const rows = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM domain_pauses WHERE org_id = ?",
    ).bind(ORG).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("refuses when there are not two other administrators to ask", async () => {
    // One administrator besides the requester. The pause has no completion anybody could reach, so it is
    // refused before anything is written — an open request nobody can decide reads as waiting for somebody.
    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ? AND relation = 'org.admin'",
    ).bind(ORG, ADMIN_C).run();

    await expect(
      requestDomainPause(testEnv, atTime(AUGUST_20), ORG, ADMIN_A, "acme.example", "suspected compromise"),
    ).rejects.toThrow(/E_DOMAIN_PAUSE_UNSATISFIABLE/);
    // **The safe direction here is refusing to pause**, which is the opposite of a hold's: the domain keeps
    // sending. Asserted rather than assumed, because it is the surprising half of #66's inversion.
    expect((await seal(AUGUST_20 + 1_000)).state).toBe("held");
  });

  it("refuses a second open question about one domain", async () => {
    await requestDomainPause(testEnv, atTime(AUGUST_20), ORG, ADMIN_A, "acme.example", "first");
    await expect(
      requestDomainPause(testEnv, atTime(AUGUST_20 + 1_000), ORG, ADMIN_B, "acme.example", "second"),
    ).rejects.toThrow(/E_DOMAIN_PAUSE_PENDING/);
  });

  it("shows the domain and the reason to the administrators being asked", async () => {
    await requestDomainPause(testEnv, atTime(AUGUST_20), ORG, ADMIN_A, "acme.example", "outbound spam");
    const queue = await pendingApprovals(testEnv, ORG, ADMIN_B);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.subjectKind).toBe("domain_pause");
    // The whole point of carrying it on the request rather than only in the trail: a person asked to stop a
    // customer's mail with no stated reason is being asked to agree to nothing in particular.
    expect(queue[0]!.domainPause?.domain).toBe("acme.example");
    expect(queue[0]!.domainPause?.reason).toBe("outbound spam");
    // And not to the person who asked: their own act never appears in their own queue.
    expect(await pendingApprovals(testEnv, ORG, ADMIN_A)).toEqual([]);
  });
});

/* ---------------------------------------------------- what a pause does ----------------------------- */

describe("a pause refuses rather than gates, at the seal and at the dispatch", () => {
  it("withholds a new send with domain_paused and the way to restart it", async () => {
    await placed();
    const sealed = await seal(AUGUST_20 + 10_000);
    expect(sealed.state).toBe("withheld");
    expect(sealed.stateReason).toBe("domain_paused");
    // Not `awaiting`: this is not a delay somebody waits out. #66's split — rate breakers gate, abuse
    // breakers refuse — is what stops a paused domain building a backlog somebody releases in bulk.
    expect(sealed.breakerError).toContain("acme.example");
    expect(sealed.breakerError).toContain("compromised key");
    expect(sealed.breakerError).toContain("/lift");
  });

  it("withholds a send that was sealed before the pause and reaches dispatch after it", async () => {
    const sealed = await seal(AUGUST_20 - 60_000);
    expect(sealed.state).toBe("held");
    await placed();

    const after = Date.parse(sealed.releaseAt) + 1_000;
    const result = await dispatchOne(testEnv, atTime(after), ORG, sealed.id, acceptingTransport);
    expect(result.state).toBe("withheld");
    expect((await manifestRow(sealed.id))?.state_reason).toBe("domain_paused");
    // Refused before the claim, so no attempt was spent and the send never entered `outcome_unknown`.
    const attempts = await testEnv.CATALOG.prepare(
      "SELECT attempts FROM send_manifests WHERE id = ?",
    ).bind(sealed.id).first<{ attempts: number }>();
    expect(attempts?.attempts).toBe(0);
  });

  it("leaves another domain alone", async () => {
    await placed();
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind("mbx_other_dp", ORG, "Other", new Date(ctx.now()).toISOString()).run();
    await testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, "hello@other.example", "mbx_other_dp",
      new Date(ctx.now()).toISOString()).run();
    await tuple(AUTHOR, "send.propose", "mailbox", "mbx_other_dp");
    await tuple(AUTHOR, "mailbox.content.read", "mailbox", "mbx_other_dp");

    const sealed = await sealManifest(testEnv, atTime(AUGUST_20 + 10_000), ORG, {
      mailboxId: "mbx_other_dp",
      authorUserId: AUTHOR,
      to: ["customer@example.net"],
      subject: "Hello",
      bodyTyped: "Body.",
      fidelity: "authored",
    });
    expect(sealed.state).toBe("held");
  });
});

/* ---------------------------------------------------- lifting takes one ----------------------------- */

describe("lifting takes one administrator, alone", () => {
  it("restarts the domain on a single call with no second decision anywhere", async () => {
    const pauseId = await placed();

    // ADMIN_A requested the pause and could not approve it. They can lift it, alone, immediately — because
    // the harm of a wrongly-paused domain grows every minute it stands. That is the inversion, asserted.
    const lifted = await liftDomainPause(
      testEnv, atTime(AUGUST_20 + 20_000), ORG, ADMIN_A, pauseId, "the key was rotated",
    );
    expect(lifted.domain).toBe("acme.example");
    expect(await pausesInForce(testEnv, ORG)).toEqual([]);

    // And **no approval was created for the lift**: this is the assertion that a lift is not an approval in
    // disguise. One `domain_pause` approval exists, from the placement.
    const approvals = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND subject_kind = 'domain_pause'",
    ).bind(ORG).first<{ n: number }>();
    expect(approvals?.n).toBe(1);

    expect((await seal(AUGUST_20 + 30_000)).state).toBe("held");
  });

  it("takes org.admin and nothing weaker", async () => {
    const pauseId = await placed();
    await expect(
      liftDomainPause(testEnv, atTime(AUGUST_20 + 20_000), ORG, AUTHOR, pauseId),
    ).rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);
    expect(await pausesInForce(testEnv, ORG)).toHaveLength(1);
  });

  it("needs no reason, and records its absence rather than a phrase nobody said", async () => {
    const pauseId = await placed();
    await liftDomainPause(testEnv, atTime(AUGUST_20 + 20_000), ORG, ADMIN_B, pauseId);

    const row = await testEnv.CATALOG.prepare(
      "SELECT lifted_by, lifted_reason FROM domain_pauses WHERE id = ?",
    ).bind(pauseId).first<{ lifted_by: string; lifted_reason: string | null }>();
    expect(row?.lifted_by).toBe(ADMIN_B);
    expect(row?.lifted_reason).toBeNull();
  });

  it("refuses a second lift, so two administrators cannot both claim to have restarted it", async () => {
    const pauseId = await placed();
    await liftDomainPause(testEnv, atTime(AUGUST_20 + 20_000), ORG, ADMIN_B, pauseId);
    await expect(
      liftDomainPause(testEnv, atTime(AUGUST_20 + 30_000), ORG, ADMIN_C, pauseId),
    ).rejects.toThrow(/E_DOMAIN_PAUSE_ALREADY_LIFTED/);

    const entries = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ? AND action = 'domain.pause_lifted'",
    ).bind(ORG).first<{ n: number }>();
    expect(entries?.n).toBe(1);
  });

  it("refuses to lift a request nobody decided", async () => {
    const requested = await requestDomainPause(
      testEnv, atTime(AUGUST_20), ORG, ADMIN_A, "acme.example", "suspected compromise",
    );
    await expect(
      liftDomainPause(testEnv, atTime(AUGUST_20 + 1_000), ORG, ADMIN_B, requested.pauseId),
    ).rejects.toThrow(/E_DOMAIN_PAUSE_NOT_PLACED/);
  });
});

/* ---------------------------------------------------- the trail and doctor -------------------------- */

describe("both acts are in the trail, and doctor shows a pause nobody would otherwise see", () => {
  it("records the placement with the domain, the reason, who asked and who agreed", async () => {
    const pauseId = await placed("outbound spam from a compromised key");
    const entry = await testEnv.CATALOG.prepare(
      `SELECT actor_user_id, detail FROM audit_entries
        WHERE org_id = ? AND subject = ? AND action = 'domain.pause_placed'`,
    ).bind(ORG, pauseId).first<{ actor_user_id: string | null; detail: string }>();
    expect(entry, "a domain whose mail stopped with nothing in the trail").not.toBeNull();
    const detail = JSON.parse(entry!.detail) as Record<string, unknown>;
    expect(detail.domain).toBe("acme.example");
    expect(detail.reason).toBe("outbound spam from a compromised key");
    expect(detail.requestedBy).toBe(ADMIN_A);
    expect(detail.approvedBy).toEqual([ADMIN_B, ADMIN_C]);
  });

  it("reports every pause in force with its reason and its age", async () => {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)",
    ).bind(ctx.id("clm"), "x", new Date(AUGUST_20).toISOString(), ORG).run();
    const pauseId = await placed();

    const report = await runDoctor(testEnv, atTime(AUGUST_20 + 60_000));
    const finding = report.findings.find((f) => f.check === "domain_paused")!;
    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("degraded");
    expect(finding.detail).toContain("acme.example");
    expect(finding.detail).toContain("compromised key");
    expect(finding.fix).toContain(pauseId);

    // And it disappears when the pause is lifted, so the finding tracks the world rather than the history.
    await liftDomainPause(testEnv, atTime(AUGUST_20 + 70_000), ORG, ADMIN_B, pauseId);
    const after = await runDoctor(testEnv, atTime(AUGUST_20 + 80_000));
    expect(after.findings.find((f) => f.check === "domain_paused")).toBeUndefined();
  });
});
