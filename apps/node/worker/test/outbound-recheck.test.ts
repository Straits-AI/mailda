import { utf8 } from "@mailda/evidence";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import {
  decideApproval, expiryFor, pendingApprovals, stageOf, withdrawApproval,
} from "../src/approvals.ts";
import { BREAKER_REASONS } from "../src/breakers.ts";
import { BUTLER_REASONS } from "../src/butler/gate.ts";
import { runDoctor } from "../src/doctor.ts";
import { placeHold, requestHoldLift } from "../src/holds.ts";
import { metering } from "../src/cost-meter.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { dispatchOne, type SendState } from "../src/outbound/dispatch.ts";
import { renderRfc822, sealManifest } from "../src/outbound/manifest.ts";
import {
  bindEnvelope, DISPATCH_REASONS, ENVELOPE_ABSENT, WITHHOLDING,
} from "../src/outbound/recheck.ts";
import { cloudflareTransport, type SubmitOutcome, type TransportAdapter } from "../src/outbound/transport.ts";
import { createPolicyDraft, publishPolicy } from "../src/policy.ts";
import deliveryScript from "../src/client/delivery.client.js";

/**
 * The dispatch-time recheck of an approved send (#62): the six reasons, the envelope, and the two paths.
 *
 * ## Every reason is produced through the real dispatch path
 *
 * Not one of the tests below calls a checker. Each one arranges a state and then calls `dispatchOne`, which is
 * where #62 placed the recheck and where a real sweeper enters it — so what is asserted is that *dispatching*
 * refuses, not that a predicate returns false. A helper-level test would have passed against a recheck nothing
 * called, which is the defect shape this repository keeps finding.
 *
 * How each state is arranged matters, and the arrangements are of two kinds:
 *
 * | Reason | Arranged by | Kind |
 * |:--|:--|:--|
 * | `authority_lost` | revoking `send.propose` | a real act |
 * | `approver_ineligible` | revoking `approval.decide` from the approver | a real act |
 * | `policy_stricter` | publishing a `deny` policy | a real act |
 * | `approval_expired` | dispatching after the deadline | a real clock |
 * | `evidence_changed` | writing **different bytes** to the stored object | a real object |
 * | `approval_revoked` | a direct write to `approvals` / `approval_decisions` | **not** reachable through the product |
 *
 * The last row is the honest one and it is asserted as such: the test that produces it also asserts that
 * `withdrawApproval` **refuses** on a settled approval, which is what makes that state reachable only from
 * outside this Node. A check for a state the product cannot reach is still worth having — it is the layer that
 * holds if that ever stops being true, the same argument `COUNT(DISTINCT …)` gets beside `apd_one_per_person` —
 * but calling it a live flow would be a claim nothing supports.
 *
 * **`evidence_changed` is produced by differing bytes, never by editing the hash column.** Editing
 * `body_typed_sha256` would test the comparison; replacing the object tests the mechanism, and afterwards a
 * reader cannot tell the two apart from the test's name. So the object is re-sealed through `putEvidence` with
 * different content — which is exactly what a corrupted or tampered archive looks like from here: readable,
 * decryptable under the current key, and not what the manifest recorded.
 */

const testEnv = env as unknown as Env;
const ORG = "org_recheck";
const MAILBOX = "mbx_recheck";
const ADDRESS = "support@acme.example";
const AUTHOR = "usr_recheck_author";
const ANN = "usr_recheck_ann";
const BOB = "usr_recheck_bob";
const ADMIN = "usr_recheck_admin";

/** Seal at this instant; the hold window closes 15 seconds later. */
const SEALED_AT = Date.parse("2026-08-20T09:00:00.000Z");
const DUE_AT = SEALED_AT + 60_000;
/** After `approval.send_expiry_seconds`, whatever that is, plus a minute. */
const LAPSED_AT = SEALED_AT + BUDGETS["approval.send_expiry_seconds"] * 1000 + 60_000;

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

/** A transport that records what it was handed. Its `capability` performs no I/O — see the measure block. */
function fakeTransport(outcome: SubmitOutcome): TransportAdapter & { submitted: unknown[] } {
  const submitted: unknown[] = [];
  return {
    name: "fake",
    submitted,
    async capability() {
      return { canSend: true, arbitraryRecipients: true, verifiedAt: "2026-08-20T00:00:00.000Z", detail: "fake" };
    },
    async submit(_env, request, fidelity) {
      submitted.push({ request, fidelity });
      return outcome;
    },
  };
}

const handedOver = (): TransportAdapter & { submitted: unknown[] } =>
  fakeTransport({ kind: "handed_over", transportMessageId: "<ok@acme.example>" });

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string): Promise<void> {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId,
    new Date(ctx.now()).toISOString()).run();
}

const composition = {
  mailboxId: MAILBOX,
  authorUserId: AUTHOR,
  to: ["customer@example.net"],
  subject: "Re: Invoice 4500219877",
  bodyTyped: "We have revised the schedule.\nBest,\nSupport",
  fidelity: "authored" as const,
};

async function published(name: string, outcome: string, stages?: number[]): Promise<void> {
  const ctx = atTime(SEALED_AT - 1000);
  const draft = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
    name, outcome, conditions: { mailboxId: MAILBOX },
    ...(stages === undefined ? {} : { stages: stages.map((count) => stageOf(count)) }),
  });
  await publishPolicy(testEnv, ctx, ORG, ADMIN, draft.policyId);
}

/**
 * A gated send, approved, and therefore back in `held` and due.
 *
 * `stages` defaults to one decision by Ann. `[2]` takes both approvers, which is the shape that separates
 * *"nobody's approval stands"* from *"somebody withdrew"* — two conditions one approver cannot tell apart.
 */
async function approvedSend(stages: number[] = [1]): Promise<{ manifestId: string; approvalId: string }> {
  await published(`needs approval ${stages.join("-")}`, "require_approval", stages);
  const sealed = await sealManifest(testEnv, atTime(SEALED_AT), ORG, composition);
  expect(sealed.state).toBe("awaiting");
  if (sealed.approvalId === null) throw new Error(`no approval was requested: ${sealed.stateReason}`);
  const approvers = [ANN, BOB].slice(0, stages.reduce((total, count) => total + count, 0));
  let last;
  for (const [index, approver] of approvers.entries()) {
    last = await decideApproval(
      testEnv, atTime(SEALED_AT + 1000 * (index + 1)), ORG, approver, sealed.approvalId, "approve",
    );
  }
  expect(last?.manifestState).toBe("held");
  return { manifestId: sealed.id, approvalId: sealed.approvalId };
}

/** A send no policy gated: the unapproved path, unchanged by #62. */
async function unapprovedSend(): Promise<string> {
  const sealed = await sealManifest(testEnv, atTime(SEALED_AT), ORG, composition);
  expect(sealed.state).toBe("held");
  expect(sealed.policyOutcome).toBe("allow");
  return sealed.id;
}

async function manifestRow(manifestId: string) {
  return testEnv.CATALOG.prepare(
    "SELECT state, state_reason, last_error, attempts, submitted_key FROM send_manifests WHERE id = ?",
  ).bind(manifestId).first<{
    state: SendState; state_reason: string | null; last_error: string | null; attempts: number;
    submitted_key: string | null;
  }>();
}

async function withheldEntry(manifestId: string) {
  const row = await testEnv.CATALOG.prepare(
    "SELECT detail FROM audit_entries WHERE subject = ? AND action = 'send.withheld' ORDER BY seq DESC LIMIT 1",
  ).bind(manifestId).first<{ detail: string | null }>();
  return { raw: row?.detail ?? null, parsed: JSON.parse(row?.detail ?? "null") as Record<string, unknown> };
}

beforeEach(async () => {
  for (const table of ["approval_decisions", "approval_stages", "approvals", "policy_stages",
                       "policy_versions", "policies", "send_manifests", "send_recipients", "send_counters",
                       "send_recipient_events", "relationship_tuples", "team_members", "addresses",
                       "mailboxes", "users", "audit_entries", "log_entries", "outbox", "node_claim",
                       "node_capabilities", "messages", "holds", "hold_lifts"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    ...[ADMIN, AUTHOR, ANN, BOB].map((userId) => testEnv.CATALOG.prepare(
      "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
    ).bind(userId, ORG, `${userId}@local.invalid`, at)),
  ]);
  await tuple(ADMIN, "org.admin", "organization", ORG);
  await tuple(AUTHOR, "send.propose", "mailbox", MAILBOX);
  for (const approver of [ANN, BOB]) await tuple(approver, "approval.decide", "mailbox", MAILBOX);
});

/* ------------------------------------------------------------------ the six reasons -------------- */

describe("the six reasons a dispatch withholds a send (#62)", () => {
  it("withholds an approved send whose author lost authority — the check both paths share", async () => {
    const { manifestId } = await approvedSend();
    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE subject_id = ? AND relation = 'send.propose'",
    ).bind(AUTHOR).run();

    const transport = handedOver();
    const result = await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport);

    expect(result.state).toBe("withheld");
    expect((await manifestRow(manifestId))?.state_reason).toBe("authority_lost");
    expect(transport.submitted).toHaveLength(0);
    // The authority check runs *first* and short-circuits, so no envelope was bound: an unauthorized send
    // must not pay for five more checks to be refused. Absence of the envelope in the entry is how that is
    // observable rather than asserted about the source.
    expect((await withheldEntry(manifestId)).parsed["envelope"]).toBeUndefined();
  });

  it("withholds when the approval no longer stands, which the product cannot produce", async () => {
    const { manifestId, approvalId } = await approvedSend();

    // First: the product refuses to produce this state. A withdrawal after completion is exactly what
    // `withdrawApproval` blocks, and that refusal is what is supposed to make an approved send safe to
    // dispatch — so the state below is reachable only by a write from outside this Node.
    await expect(withdrawApproval(testEnv, atTime(DUE_AT), ORG, ANN, approvalId))
      .rejects.toThrow(/E_APPROVAL_SETTLED/);

    // So it is written from outside, which is what the check exists for.
    await testEnv.CATALOG.prepare(
      "UPDATE approval_decisions SET withdrawn_at = ? WHERE approval_id = ?",
    ).bind(new Date(DUE_AT).toISOString(), approvalId).run();

    const transport = handedOver();
    const result = await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport);

    expect(result.state).toBe("withheld");
    const row = await manifestRow(manifestId);
    expect(row?.state_reason).toBe("approval_revoked");
    expect(row?.last_error).toContain("0 standing approval(s) and 1 withdrawn");
    expect(transport.submitted).toHaveLength(0);
  });

  it("withholds on a withdrawal even when another approval still stands", async () => {
    // This case exists because the one above cannot distinguish two clauses. With a single approver, a
    // withdrawal leaves *both* "nobody's approval stands" and "somebody withdrew" true, so deleting either
    // check leaves that test green — which it did, under mutation, before this one was written. Two stages of
    // one, both approved, one withdrawn: a standing approval remains, and only the withdrawal clause catches
    // it.
    const { manifestId, approvalId } = await approvedSend([1, 1]);
    await testEnv.CATALOG.prepare(
      "UPDATE approval_decisions SET withdrawn_at = ? WHERE approval_id = ? AND decider_user_id = ?",
    ).bind(new Date(DUE_AT).toISOString(), approvalId, ANN).run();

    const transport = handedOver();
    const result = await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport);

    expect(result.state).toBe("withheld");
    const row = await manifestRow(manifestId);
    expect(row?.state_reason).toBe("approval_revoked");
    expect(row?.last_error).toContain("1 standing approval(s) and 1 withdrawn");
    expect(transport.submitted).toHaveLength(0);
  });

  it("withholds when nobody's approval stands at all, which would pass the eligibility check vacuously",
    async () => {
      // The other half of the same guard, and it needs its own case: with the decision rows gone there is
      // nothing withdrawn *and* nobody standing, so the eligibility check below has an empty list to check
      // and finds nobody ineligible. Dropping this clause left the whole file green under mutation, which is
      // exactly the vacuous pass it exists to prevent.
      const { manifestId, approvalId } = await approvedSend();
      await testEnv.CATALOG.prepare("DELETE FROM approval_decisions WHERE approval_id = ?")
        .bind(approvalId).run();

      const transport = handedOver();
      const result = await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport);

      expect(result.state).toBe("withheld");
      const row = await manifestRow(manifestId);
      expect(row?.state_reason).toBe("approval_revoked");
      expect(row?.last_error).toContain("0 standing approval(s) and 0 withdrawn");
      expect(transport.submitted).toHaveLength(0);
    });

  it("withholds when the approval row has gone, rather than dispatching an unassured send", async () => {
    const { manifestId, approvalId } = await approvedSend();
    await testEnv.CATALOG.prepare("DELETE FROM approvals WHERE id = ?").bind(approvalId).run();

    const transport = handedOver();
    const result = await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport);

    expect(result.state).toBe("withheld");
    expect((await manifestRow(manifestId))?.state_reason).toBe("approval_revoked");
    expect(result.detail).toContain("no approval for it");
    expect(transport.submitted).toHaveLength(0);
  });

  it("withholds when an approver has since lost approval.decide", async () => {
    const { manifestId } = await approvedSend();
    // A real act: somebody revoked the relation after the decision was taken. §18's separation of duty is
    // evaluated live, so the approval stops being one this Node will act on.
    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE subject_id = ? AND relation = 'approval.decide'",
    ).bind(ANN).run();

    const transport = handedOver();
    const result = await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport);

    expect(result.state).toBe("withheld");
    const row = await manifestRow(manifestId);
    expect(row?.state_reason).toBe("approver_ineligible");
    expect(row?.last_error).toContain(ANN);
    expect(transport.submitted).toHaveLength(0);
  });

  it("withholds when policy is stricter now than what the send was approved under", async () => {
    const { manifestId } = await approvedSend();
    // A real act: an administrator publishes a denial covering this mailbox. `max(current) > max(bound)`,
    // and the outcomes are totally ordered, so "stricter" is a comparison rather than a judgement.
    await published("no more of this", "deny");

    const transport = handedOver();
    const result = await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport);

    expect(result.state).toBe("withheld");
    const row = await manifestRow(manifestId);
    expect(row?.state_reason).toBe("policy_stricter");
    expect(row?.last_error).toContain("Policy now says deny");
    expect(row?.last_error).toContain("no more of this@1");
    expect(transport.submitted).toHaveLength(0);
  });

  it("withholds an approval that passed its deadline, and that is terminal", async () => {
    const { manifestId, approvalId } = await approvedSend();

    const transport = handedOver();
    const result = await dispatchOne(testEnv, atTime(LAPSED_AT), ORG, manifestId, transport);

    expect(result.state).toBe("withheld");
    const row = await manifestRow(manifestId);
    expect(row?.state_reason).toBe("approval_expired");
    expect(transport.submitted).toHaveLength(0);

    // Terminal, in the two ways that matter. The send did **not** go back to `awaiting`: that was rejected
    // because it makes expiry mean nothing — the same manifest could be re-approved indefinitely — and
    // creates a queue that never drains.
    expect(row?.state).toBe("withheld");
    // And a second dispatch does not resurrect it: `withheld` is neither held-and-due nor throttled, so the
    // predicate that lets a send out never admits it.
    const again = await dispatchOne(testEnv, atTime(LAPSED_AT + 60_000), ORG, manifestId, transport);
    expect(again.state).toBe("withheld");
    expect(transport.submitted).toHaveLength(0);

    // The approval itself is untouched: nothing reopened it, and re-seal is the invalidation mechanism.
    const approval = await testEnv.CATALOG.prepare(
      "SELECT state, expires_at FROM approvals WHERE id = ?",
    ).bind(approvalId).first<{ state: string; expires_at: string | null }>();
    expect(approval?.state).toBe("approved");
    // The deadline is `requested_at` plus the constant, computed by the module that writes it rather than
    // restated here — a second copy of that arithmetic is a second thing to get wrong.
    expect(approval?.expires_at).toBe(expiryFor("send_manifest", SEALED_AT));
  });

  it("withholds when the stored typed body no longer hashes to what the manifest recorded", async () => {
    const { manifestId } = await approvedSend();
    const keys = await testEnv.CATALOG.prepare(
      "SELECT body_typed_key, body_typed_sha256 FROM send_manifests WHERE id = ?",
    ).bind(manifestId).first<{ body_typed_key: string; body_typed_sha256: string }>();

    // **Different bytes, not a different hash column.** The object is re-sealed under the current key, so it
    // is perfectly readable and decrypts cleanly — it simply is not what was sealed. That is what a tampered
    // or corrupted archive looks like from here, and editing the column would have tested the comparison
    // instead of the mechanism.
    await putEvidence(testEnv, keys!.body_typed_key, utf8("Something else entirely."));

    const transport = handedOver();
    const result = await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport);

    expect(result.state).toBe("withheld");
    const row = await manifestRow(manifestId);
    expect(row?.state_reason).toBe("evidence_changed");
    expect(row?.last_error).toContain("body_typed");
    expect(row?.last_error).toContain(keys!.body_typed_sha256);
    expect(transport.submitted).toHaveLength(0);

    // This one raises as well as refusing: it is the one member of the six that is not the system working.
    const logged = await testEnv.CATALOG.prepare(
      "SELECT level, event, detail FROM log_entries WHERE event = 'send.evidence_changed'",
    ).all<{ level: string; event: string; detail: string | null }>();
    expect(logged.results).toHaveLength(1);
    expect(logged.results[0]!.level).toBe("error");
    expect(logged.results[0]!.detail).toContain(keys!.body_typed_key);
  });

  it("checks the normalized body too, which is the second of the two bound hashes", async () => {
    const { manifestId } = await approvedSend();
    const keys = await testEnv.CATALOG.prepare(
      "SELECT body_normalized_key FROM send_manifests WHERE id = ?",
    ).bind(manifestId).first<{ body_normalized_key: string }>();
    await putEvidence(testEnv, keys!.body_normalized_key, utf8("Not the approved text.\r\n"));

    const result = await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, handedOver());
    expect(result.state).toBe("withheld");
    const row = await manifestRow(manifestId);
    expect(row?.state_reason).toBe("evidence_changed");
    // Named, because "a hash did not match" without saying which object is a finding nobody can act on.
    expect(row?.last_error).toContain("body_normalized");
  });

  it("treats an unreadable object as changed, because it is the same claim about the same object", async () => {
    const { manifestId } = await approvedSend();
    const keys = await testEnv.CATALOG.prepare(
      "SELECT body_typed_key FROM send_manifests WHERE id = ?",
    ).bind(manifestId).first<{ body_typed_key: string }>();
    // §24's worst failure: a record pointing at bytes that are not there. It must not throw out of
    // `dispatchOne` — a throw would leave the send `held` and the next sweep would try for ever with nothing
    // recorded, which is the one outcome worse than a refusal.
    await testEnv.EVIDENCE.delete(keys!.body_typed_key);

    const result = await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, handedOver());
    expect(result.state).toBe("withheld");
    const row = await manifestRow(manifestId);
    expect(row?.state_reason).toBe("evidence_changed");
    expect(row?.last_error).toContain("could not be read");
  });

  it("spends no attempt and never claims the manifest when the recheck refuses", async () => {
    const { manifestId } = await approvedSend();
    await published("no more of this", "deny");
    await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, handedOver());

    const row = await manifestRow(manifestId);
    // The recheck runs before the claim, for the reason ADR 39's authority check does: afterwards it would
    // have burned an attempt and parked a never-submitted send in `outcome_unknown` — "we do not know
    // whether it left" — when it demonstrably did not.
    expect(row?.attempts).toBe(0);
    expect(row?.submitted_key).toBeNull();
  });

  it("moves the recipients with the send, so nothing reads as stopped and pending at once", async () => {
    const { manifestId } = await approvedSend();
    await published("no more of this", "deny");
    await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, handedOver());

    const recipients = await testEnv.CATALOG.prepare(
      "SELECT submission_state FROM send_recipients WHERE manifest_id = ?",
    ).bind(manifestId).all<{ submission_state: string }>();
    expect(recipients.results.map((row) => row.submission_state)).toEqual(["withheld"]);
  });

  it("still sends an approved send when every check passes, so the recheck is not simply a wall", async () => {
    const { manifestId } = await approvedSend();
    const transport = handedOver();
    const result = await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport);

    expect(result.state).toBe("handed_over");
    expect(transport.submitted).toHaveLength(1);
    const row = await manifestRow(manifestId);
    expect(row?.state).toBe("handed_over");
    // No reason, because there is nothing to explain: the approval's release cleared it and a hand-over does
    // not write one. A stale reason on a released row is what `approveStatements` sets NULL for.
    expect(row?.state_reason).toBeNull();
    // And the submitted bytes exist, which is the column that proves the transport was actually reached —
    // the third hash the recheck cannot verify, written here, immediately before the ask.
    expect(row?.submitted_key).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ the deadline ----------------- */

describe("the deadline #62 added, and the two kinds it treats differently", () => {
  it("stores requested_at plus the receipt's own constant, so a hand-typed duration fails here", async () => {
    await published("needs approval deadline", "require_approval", [1]);
    const sealed = await sealManifest(testEnv, atTime(SEALED_AT), ORG, composition);
    const stored = await testEnv.CATALOG.prepare(
      "SELECT requested_at, expires_at FROM approvals WHERE id = ?",
    ).bind(sealed.approvalId).first<{ requested_at: string; expires_at: string | null }>();

    // Compared against `BUDGETS` rather than against `expiryFor`, deliberately: the assertions elsewhere in
    // this file use the helper, which means they hold for whatever the helper says. This one pins the stored
    // deadline to the number `docs/receipts/dispatch-recheck-cost.md` generates, so a literal typed in place
    // of the constant — the exact defect AGENTS.md's receipt rule exists to stop — fails here.
    expect(Date.parse(stored!.expires_at!) - Date.parse(stored!.requested_at))
      .toBe(BUDGETS["approval.send_expiry_seconds"] * 1000);
    // And it is exactly the request's own instant plus that, not a second `ctx.now()` a few milliseconds later.
    expect(stored!.requested_at).toBe(new Date(SEALED_AT).toISOString());
  });

  it("gives a hold lift no deadline, because nothing would ever compare one", async () => {
    // `EXPIRES_AFTER_SECONDS` is a total map over the subject kinds and this is the half of it nothing else
    // reaches: the only reader of `expires_at` is the recheck, which only ever dispatches a send. Without this
    // case, giving `hold_lift` the send's deadline left the whole suite green — a limit written into a column
    // with no reader, which is the mirror image of the bound field nothing populates.
    const hold = await placeHold(testEnv, atTime(SEALED_AT), ORG, ADMIN, { mailboxId: MAILBOX });
    const lift = await requestHoldLift(
      testEnv, atTime(SEALED_AT + 1000), ORG, ADMIN, hold.id, "the matter closed",
    );
    const row = await testEnv.CATALOG.prepare(
      "SELECT subject_kind, expires_at FROM approvals WHERE id = ?",
    ).bind(lift.approvalId).first<{ subject_kind: string; expires_at: string | null }>();
    expect(row?.subject_kind).toBe("hold_lift");
    expect(row?.expires_at).toBeNull();
    expect(expiryFor("hold_lift", SEALED_AT)).toBeNull();
  });

  it("puts the deadline in front of the person being asked, which is what makes nothing sweeping it fair",
    async () => {
      // Nothing moves a lapsed request out of `pending`, so the one thing that keeps that from meaning
      // "nobody can tell" is that the deadline travels on the queue those people read. `pendingApprovals` is
      // what `GET /api/approvals` returns, verbatim.
      await published("needs approval queue", "require_approval", [1]);
      const sealed = await sealManifest(testEnv, atTime(SEALED_AT), ORG, composition);
      const hold = await placeHold(testEnv, atTime(SEALED_AT), ORG, ADMIN, { mailboxId: MAILBOX });
      await requestHoldLift(testEnv, atTime(SEALED_AT + 1000), ORG, ADMIN, hold.id, "the matter closed");

      const queue = await pendingApprovals(testEnv, ORG, ANN);
      const send = queue.find((entry) => entry.subjectKind === "send_manifest");
      const lift = queue.find((entry) => entry.subjectKind === "hold_lift");
      expect(send?.subjectId).toBe(sealed.id);
      expect(send?.expiresAt).toBe(expiryFor("send_manifest", SEALED_AT));
      // And the lift's null travels too, rather than being filled in by whatever the send got.
      expect(lift?.expiresAt).toBeNull();
    });
});

/* ------------------------------------------------------------------ the envelope ----------------- */

describe("the effect envelope §18 requires every approval to bind", () => {
  it("binds every member from a column that carries it, and records it on the refusal", async () => {
    const { manifestId, approvalId } = await approvedSend();
    await published("no more of this", "deny");
    await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, handedOver());

    const entry = await withheldEntry(manifestId);
    const envelope = entry.parsed["envelope"] as Record<string, unknown>;
    expect(envelope).toBeDefined();

    // The manifest is the revision (Layer 5's answer 1) and ADR 9's effect key is the manifest id, which
    // 0007 says on the column itself. So all three of §18's identity fields are that id — bound rather than
    // left null, and not a second identifier that would have to be kept equal to this one.
    expect(envelope["targetResource"]).toBe(manifestId);
    expect(envelope["expectedVersion"]).toBe(manifestId);
    expect(envelope["idempotencyKey"]).toBe(manifestId);
    expect(envelope["command"]).toBe("mail.send");
    expect(envelope["actorUserId"]).toBe(AUTHOR);
    expect(envelope["mailboxId"]).toBe(MAILBOX);

    // Counts, not addresses, and no subject: `sealManifest` set that discipline and the reason is §12's.
    expect(envelope["recipients"]).toEqual({ to: 1, cc: 0, bcc: 0 });
    expect(entry.raw).not.toContain(composition.subject);
    expect(entry.raw).not.toContain(composition.to[0]);

    const hashes = envelope["artifactHashes"] as Record<string, string>;
    const stored = await testEnv.CATALOG.prepare(
      "SELECT body_typed_sha256, body_normalized_sha256, policy_outcome FROM send_manifests WHERE id = ?",
    ).bind(manifestId).first<Record<string, string>>();
    expect(hashes["bodyTyped"]).toBe(stored!["body_typed_sha256"]);
    expect(hashes["bodyNormalized"]).toBe(stored!["body_normalized_sha256"]);

    const policy = envelope["policy"] as { boundOutcome: string; boundVersionIds: string[] };
    expect(policy.boundOutcome).toBe("require_approval");
    expect(policy.boundVersionIds).toHaveLength(1);

    const approval = envelope["approval"] as Record<string, unknown>;
    expect(approval["approvalId"]).toBe(approvalId);
    expect(approval["state"]).toBe("approved");
    expect(approval["approvers"]).toEqual([ANN]);
    expect(approval["expiresAt"]).toBe(expiryFor("send_manifest", SEALED_AT));

    const transport = envelope["transport"] as Record<string, unknown>;
    expect(transport["adapter"]).toBe("fake");
    expect(transport["canSend"]).toBe(true);

    // What §18 asks for that this build cannot bind, on the record rather than only in a comment: an
    // investigator reading a withheld send learns what the recheck did not cover from the entry itself.
    expect(envelope["absent"]).toEqual(Object.keys(ENVELOPE_ABSENT));
  });

  it("names every member §18 asks for that this build cannot bind, with a reason each", async () => {
    // The enumeration itself, asserted rather than trusted, because the failure mode is *dropping* one: a
    // member that quietly stops being listed reads as bound, and a bound field nothing populates is this
    // repository's most-repeated defect. #62's resolution enumerated these eight and this is that list.
    expect(Object.keys(ENVELOPE_ABSENT).sort()).toEqual([
      "attachment_filenames", "attachment_hashes", "butler_version", "delegator", "dlp_results",
      "rendered_html", "submitted_sha256", "template_and_prompt_versions",
    ]);
    for (const [member, why] of Object.entries(ENVELOPE_ABSENT)) {
      // A reason, not a placeholder. "TODO" and "" would both satisfy a check that only asked for a key.
      expect(why.length, `${member} has no real reason`).toBeGreaterThan(40);
    }

    // And nothing is in both halves. An envelope claiming to bind a member it also names absent would be the
    // same defect wearing both hats, and the two lists are written in different places in the file.
    const manifestId = await unapprovedSend();
    const row = await testEnv.CATALOG.prepare(
      `SELECT author_user_id, mailbox_id, envelope_from, envelope_to, envelope_cc, envelope_bcc, subject,
              in_reply_to_message_id, references_header, body_typed_key, body_typed_sha256,
              body_normalized_key, body_normalized_sha256, policy_outcome, policy_versions
         FROM send_manifests WHERE id = ?`,
    ).bind(manifestId).first();
    const bound = await bindEnvelope(testEnv, ORG, manifestId, row as never, handedOver());
    const collisions = Object.keys(ENVELOPE_ABSENT).filter((member) => member in bound);
    expect(collisions).toEqual([]);
  });

  it("fits the audit detail's byte cap, so the record is not silently truncated", async () => {
    const { manifestId } = await approvedSend();
    await published("no more of this", "deny");
    await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, handedOver());

    const entry = await withheldEntry(manifestId);
    const bytes = new TextEncoder().encode(entry.raw ?? "").length;
    console.log(`MEASURE recheck withheld audit detail bytes=${bytes}`);
    // A detail that overruns the cap is replaced *wholesale* by a truncation record, so the envelope and
    // the reason would both vanish together. This is the tripwire for that, and it is why the envelope
    // carries names and hashes rather than addresses and bodies.
    expect(bytes).toBeLessThanOrEqual(BUDGETS["audit.max_detail_bytes"]);
    expect(entry.raw).not.toContain("truncated");
  });

  it("enumerates exactly the header set the wire form actually carries, on both shapes", async () => {
    // The claim "the emitted header set is fixed and enumerable" is worth nothing unless something reads the
    // bytes. So both shapes are rendered and the header names are read back out of them.
    const namesOf = async (manifestId: string): Promise<string[]> => {
      const { raw } = await renderRfc822(testEnv, manifestId);
      const text = new TextDecoder().decode(raw);
      return text.slice(0, text.indexOf("\r\n\r\n")).split("\r\n")
        .map((line) => line.slice(0, line.indexOf(":")));
    };
    const envelopeOf = async (manifestId: string): Promise<readonly string[]> => {
      const row = await testEnv.CATALOG.prepare(
        `SELECT author_user_id, mailbox_id, envelope_from, envelope_to, envelope_cc, envelope_bcc, subject,
                in_reply_to_message_id, references_header, body_typed_key, body_typed_sha256,
                body_normalized_key, body_normalized_sha256, policy_outcome, policy_versions
           FROM send_manifests WHERE id = ?`,
      ).bind(manifestId).first();
      const bound = await bindEnvelope(
        testEnv, ORG, manifestId, row as never, handedOver(),
      );
      return bound.emittedHeaders;
    };

    const plain = await unapprovedSend();
    expect(await envelopeOf(plain)).toEqual(await namesOf(plain));
    expect(await envelopeOf(plain))
      .toEqual(["From", "To", "Subject", "Message-ID", "Date", "MIME-Version", "Content-Type"]);

    // With a Cc, and as a reply — which is the shape that adds `In-Reply-To` and `References`. Bcc is
    // absent from both, and that is what Bcc means.
    const ctx = atTime(SEALED_AT);
    const parent = await putEvidence(testEnv, `${ORG}/raw/2026-Q3/parent.eml`, utf8(
      "Message-ID: <parent@example.net>\r\nReferences: <root@example.net>\r\n\r\nOriginal.",
    ));
    const receiptId = ctx.id("igr");
    const messageId = ctx.id("msg");
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(
        `INSERT INTO ingress_receipts (id, org_id, envelope_from, envelope_to, raw_bytes, accepted_at,
                                       blob_key, blob_sha256, provider_event_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(receiptId, ORG, "customer@example.net", ADDRESS, 42,
        new Date(SEALED_AT - 60_000).toISOString(), parent.blobKey, parent.plaintextSha256, ctx.id("pe")),
      testEnv.CATALOG.prepare(
        `INSERT INTO messages
           (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id, thread_id, subject,
            from_addr, sent_at, received_at, ingress_receipt_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(messageId, ORG, "2026-Q3", parent.blobKey, parent.plaintextSha256, 42,
        "parent@example.net", ctx.id("thr"), "Invoice", "customer@example.net",
        new Date(SEALED_AT - 60_000).toISOString(), new Date(SEALED_AT - 60_000).toISOString(),
        receiptId, new Date(SEALED_AT - 60_000).toISOString()),
    ]);
    await tuple(AUTHOR, "mailbox.content.read", "mailbox", MAILBOX);

    const reply = await sealManifest(testEnv, ctx, ORG, {
      ...composition, cc: ["colleague@example.net"], inReplyToMessageId: messageId,
    });
    expect(await envelopeOf(reply.id)).toEqual(await namesOf(reply.id));
    expect(await envelopeOf(reply.id)).toEqual([
      "From", "To", "Cc", "Subject", "Message-ID", "Date", "MIME-Version", "Content-Type",
      "In-Reply-To", "References",
    ]);
    expect(await namesOf(reply.id)).not.toContain("Bcc");
  });
});

/* ------------------------------------------------------------------ two dispatchers -------------- */

describe("two dispatchers on one manifest, which is what a sweep plus a request is", () => {
  /*
   * The recheck runs *before* the claim, so it is the one part of a dispatch two invocations can both perform
   * on the same manifest. Both cases below therefore matter, and neither is covered by the claim's own tests:
   * `OutboxSweeper`'s alarm and `POST /api/sends/dispatch` can reach the same due manifest at once.
   */
  it("hands over exactly once when both pass the recheck", async () => {
    const { manifestId } = await approvedSend();
    const transport = handedOver();
    const results = await Promise.all([
      dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport),
      dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport),
    ]);
    // One submit and one attempt: the claim's conditional UPDATE is what decides it, and the recheck running
    // twice costs two reads rather than two messages.
    expect(transport.submitted).toHaveLength(1);
    expect((await manifestRow(manifestId))?.attempts).toBe(1);
    expect(results.filter((result) => result.state === "handed_over")).toHaveLength(1);
  });

  it("withholds once, raises once, and neither dispatcher submits, when both refuse", async () => {
    // `evidence_changed` is the reason to race, because it is the one that writes *outside* the transaction as
    // well as inside it. So this pins both: one entry in the trail, and one alarm.
    const { manifestId } = await approvedSend();
    const keys = await testEnv.CATALOG.prepare(
      "SELECT body_typed_key FROM send_manifests WHERE id = ?",
    ).bind(manifestId).first<{ body_typed_key: string }>();
    await putEvidence(testEnv, keys!.body_typed_key, utf8("Neither dispatcher may send this."));

    const transport = handedOver();
    const results = await Promise.all([
      dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport),
      dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, transport),
    ]);
    expect(transport.submitted).toHaveLength(0);
    expect(results.map((result) => result.state)).toEqual(["withheld", "withheld"]);

    // One `send.withheld` entry, because the audit insert is gated on the manifest still being held-and-due.
    const entries = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE subject = ? AND action = 'send.withheld'",
    ).bind(manifestId).first<{ n: number }>();
    expect(entries?.n).toBe(1);
    // And one log line. This is the assertion that holds the *state* UPDATE's predicate rather than the audit
    // gate: the gate only conditions the entry, so an unconditional UPDATE would let the second dispatcher
    // re-write the row — a state change with no entry recording it — and raise a second corruption alarm for
    // one corrupt object.
    const logged = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM log_entries WHERE event = 'send.evidence_changed'",
    ).first<{ n: number }>();
    expect(logged?.n).toBe(1);
    // And no attempt was spent by either, which is the property that separates a refusal from a failure.
    expect((await manifestRow(manifestId))?.attempts).toBe(0);
  });
});

/* ------------------------------------------------------------------ the vocabulary --------------- */

describe("the reason vocabulary is closed in both directions", () => {
  it("declares exactly the six #62 settled on, plus #66's domain pause", () => {
    expect([...DISPATCH_REASONS].sort()).toEqual([
      "approval_expired", "approval_revoked", "approver_ineligible", "authority_lost", "domain_paused",
      "evidence_changed", "policy_stricter",
    ]);
    // One of them raises, and exactly one: every other reason is a decision or a deadline.
    expect(Object.entries(WITHHOLDING).filter(([, entry]) => entry.raises).map(([name]) => name))
      .toEqual(["evidence_changed"]);
  });

  it("gives every token words in the module a browser is served, and has no words for a token nothing writes", () => {
    /*
     * Extracted from the served bytes rather than matched against them, which is the difference between a
     * check and a vacuous one. A `toContain` per token proves each name appears *somewhere* in a 300-line
     * file; this reads the keys of `SEND_REASONS` itself, so it also catches the other direction — a
     * sentence left behind for a reason that was renamed, which would read as the explanation for something
     * nothing writes.
     */
    const block = /export const SEND_REASONS = \{([\s\S]*?)\n\};/.exec(deliveryScript);
    expect(block, "SEND_REASONS not found in the served delivery module").not.toBeNull();
    const worded = [...block![1]!.matchAll(/^ {2}([a-z_]+): \{$/gm)].map((match) => match[1]!);
    // Anti-vacuity: an extractor that stopped matching would make every comparison below trivially pass.
    expect(worded.length).toBeGreaterThanOrEqual(14);

    for (const reason of [...DISPATCH_REASONS, ...BREAKER_REASONS]) {
      expect(worded, `no words for ${reason}`).toContain(reason);
    }
    // And nothing here explains a token no module mints. The seal's and the approval's tokens are the rest
    // of the set, imported from where they are declared rather than listed again.
    const minted = new Set([
      ...DISPATCH_REASONS,
      "policy_hold", "policy_approval_required", "policy_denied",
      "approval_denied", "approval_unsatisfiable",
      // #66's three rate gates, imported from the map that mints them rather than listed here — a second
      // literal list of the same tokens is exactly the drift this closed world exists to catch.
      ...BREAKER_REASONS,
      // #50's human-release gate, imported from the module that mints it rather than spelled again here. It
      // is the one `awaiting` reason that neither a policy nor a breaker produces: a program wrote the
      // message and no person has seen it.
      ...BUTLER_REASONS,
    ]);
    expect(worded.filter((reason) => !minted.has(reason))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ doctor ----------------------- */

describe("doctor can see a hash mismatch, because it is not a decision", () => {
  it("reports the withheld sends and stays quiet on a Node that has none", async () => {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)",
    ).bind(ctx.id("clm"), "x", new Date(SEALED_AT).toISOString(), ORG).run();

    const clean = await runDoctor(testEnv, atTime(DUE_AT));
    const before = clean.findings.find((finding) => finding.check === "send_evidence_changed");
    expect(before?.ok).toBe(true);
    expect(before?.detail).toContain("No send has been withheld");
    // Reported because `doctor-check-cost.md`'s `stale_when` names "any new fixed-cost check", and this is
    // one: it costs a subrequest on every claimed run whether or not anything has gone wrong.
    console.log(`MEASURE doctor claimed-and-clean subrequests=${clean.cost.subrequests} `
      + `d1=${clean.cost.d1Queries} r2=${clean.cost.r2Reads} findings=${clean.findings.length}`);

    const { manifestId } = await approvedSend();
    const keys = await testEnv.CATALOG.prepare(
      "SELECT body_typed_key FROM send_manifests WHERE id = ?",
    ).bind(manifestId).first<{ body_typed_key: string }>();
    await putEvidence(testEnv, keys!.body_typed_key, utf8("Tampered."));
    await dispatchOne(testEnv, atTime(DUE_AT), ORG, manifestId, handedOver());

    const after = await runDoctor(testEnv, atTime(DUE_AT + 1000));
    const finding = after.findings.find((f) => f.check === "send_evidence_changed");
    expect(finding?.ok).toBe(false);
    expect(finding?.severity).toBe("degraded");
    expect(finding?.detail).toContain(manifestId);
    expect(finding?.fix).toContain("send.evidence_changed");
    // A finding a person cannot act on is a complaint, so the whole report degrades rather than staying ok.
    expect(after.verdict).not.toBe("ok");
    console.log(`MEASURE doctor with-one-mismatch subrequests=${after.cost.subrequests} `
      + `d1=${after.cost.d1Queries} r2=${after.cost.r2Reads} findings=${after.findings.length}`);
    expect(after.cost.subrequests).toBeLessThanOrEqual(BUDGETS["doctor.max_subrequests_per_run"]);
  });

  it("finds them through the partial index rather than by scanning every send ever made", async () => {
    const plan = await testEnv.CATALOG.prepare(
      `EXPLAIN QUERY PLAN SELECT id, state_at, last_error FROM send_manifests
        WHERE org_id = ? AND state_reason = 'evidence_changed' ORDER BY state_at DESC`,
    ).bind(ORG).all<{ detail: string }>();
    const plans = plan.results.map((row) => row.detail).join(" | ");
    console.log(`PLAN send_evidence_changed: ${plans}`);
    // The reason this check can run on every doctor invocation: on a healthy Node the index is empty, so
    // this is a seek into nothing. Read from the planner rather than asserted in a comment, because 0020
    // records an index that was written on reasoning and earned nothing when the plan was finally read.
    expect(plans).toContain("sm_evidence_changed");
  });
});

/* ------------------------------------------------------------------ the two paths ---------------- */

describe("what the two paths cost (#62's whole basis for their differing)", () => {
  function report(scenario: string, cost: {
    subrequests: number; d1Executions: number; d1Batches: number; r2Operations: number; doRpcs: number;
  }): void {
    console.log(
      `MEASURE dispatch scenario=${scenario}  subrequests=${cost.subrequests}` +
      `  d1=${cost.d1Executions} (batches=${cost.d1Batches})  r2=${cost.r2Operations}` +
      `  do_rpc=${cost.doRpcs}`,
    );
  }

  it("costs the unapproved path exactly what it did, and the approved path the recheck more", async () => {
    const plain = await unapprovedSend();
    const unapproved = metering(testEnv);
    const plainResult = await dispatchOne(unapproved.env, atTime(DUE_AT), ORG, plain, handedOver());
    expect(plainResult.state).toBe("handed_over");
    report("unapproved/handed-over", unapproved.cost);

    const { manifestId } = await approvedSend();
    const approved = metering(testEnv);
    const approvedResult = await dispatchOne(approved.env, atTime(DUE_AT), ORG, manifestId, handedOver());
    expect(approvedResult.state).toBe("handed_over");
    report("approved/handed-over", approved.cost);

    // The bound that matters, and it is on the *unapproved* path: a future reader tidying the two branches
    // into one would put the recheck's operations on every send, and this is what fails. Stated as a bound
    // rather than an equality for the reason `butler-step-cost.md` gives — an equality on an I/O count fails
    // on every harmless refactor and gets deleted.
    expect(unapproved.cost.subrequests)
      .toBeLessThanOrEqual(BUDGETS["send.dispatch_unapproved_max_subrequests"]);
    expect(approved.cost.subrequests)
      .toBeLessThanOrEqual(BUDGETS["send.dispatch_approved_max_subrequests"]);

    // And the asymmetry itself, measured: the recheck is not free, which is why it is not universal.
    //
    // A floor rather than an equality, and the floor is the anti-vacuity half of this test: delete the
    // recheck's call from `dispatchOne` and the delta becomes 0, which fails here rather than quietly
    // passing every other assertion in this file about a mechanism nothing runs. The ceiling is the approved
    // bound above, so the two together pin the figure from both sides without asserting an I/O count.
    const recheck = approved.cost.subrequests - unapproved.cost.subrequests;
    console.log(`MEASURE dispatch recheck_delta=${recheck}`);
    expect(recheck).toBeGreaterThanOrEqual(6);
  });

  it("costs a refusal less than a pass, because the two body hashes are checked last", async () => {
    const { manifestId, approvalId } = await approvedSend();
    await testEnv.CATALOG.prepare("DELETE FROM approvals WHERE id = ?").bind(approvalId).run();

    const refused = metering(testEnv);
    const result = await dispatchOne(refused.env, atTime(DUE_AT), ORG, manifestId, handedOver());
    expect(result.state).toBe("withheld");
    report("approved/refused-at-first-check", refused.cost);
    // No R2 read of a body and no vault RPC for one: a send that is already refused must not pay for the
    // expensive pair. `submitClaimed` never ran either, so nothing was rendered or stored.
    expect(refused.cost.r2Operations).toBe(0);
    expect(refused.cost.doRpcs).toBe(0);
  });

  it("measures the one operation the fake transport hides: the shipped adapter's capability read", async () => {
    // `bindEnvelope` asks the adapter for its capability, and the fake transport every dispatch test uses
    // answers without I/O — so the approved figure above is one short of a Node running the shipped adapter.
    // Measured here rather than reasoned about, because a figure counted by reading is a hypothesis and this
    // repository has had three of those be wrong this month.
    await testEnv.CATALOG.prepare(
      "INSERT INTO node_capabilities (name, value, recorded_at) VALUES ('send', ?, ?)",
    ).bind(JSON.stringify({ canSend: true, arbitraryRecipients: true }), new Date(SEALED_AT).toISOString())
      .run();

    const bound = metering(testEnv);
    const present = await cloudflareTransport.capability(bound.env);
    expect(present.canSend).toBe(true);
    report("capability/EMAIL-bound", bound.cost);
    // One D1 read, and nothing else. So a deployed Node with sending enabled costs exactly one more than the
    // approved figure above, which is what `dispatch-recheck-cost.md` bounds against.
    expect(bound.cost.subrequests).toBe(1);
    expect(bound.cost.d1Executions).toBe(1);

    // And zero on a Node with no binding, which is a capability answer rather than an error (§14). Both
    // halves are measured, because "it depends on the binding" is exactly the kind of claim that turns out
    // to be about something else.
    const without = metering({ ...testEnv, EMAIL: undefined } as Env);
    const absent = await cloudflareTransport.capability(without.env);
    expect(absent.canSend).toBe(false);
    expect(absent.detail).toContain("No EMAIL binding");
    report("capability/no-EMAIL-binding", without.cost);
    expect(without.cost.subrequests).toBe(0);
  });
});
