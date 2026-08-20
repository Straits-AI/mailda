import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { utf8 } from "@mailda/evidence";
import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { LOOKUP_ENTITIES, priceButler, checkButler } from "@mailda/butler-ast";

import { grant, revoke } from "../src/access.ts";
import { maySend } from "../src/authz-read.ts";
import { caseMailboxHeldBy, readEntity } from "../src/butler/authority.ts";
import { EFFECT_REASONS } from "../src/butler/effects.ts";
import { BUTLER_RELEASE_REASON } from "../src/butler/gate.ts";
import { interpret, RELEASE_EVENT, type RunSteps } from "../src/butler/interpret.ts";
import { actingAs, BUTLER_ACTOR_KIND, type ButlerPrincipal } from "../src/butler/principal.ts";
import { releaseButlerSend } from "../src/butler/release.ts";
import { runEffects, runRow } from "../src/butler/record.ts";
import { deliveryFacts, triggerButlers } from "../src/butler/trigger.ts";
import { createButlerDraft, publishButler } from "../src/butlers.ts";
import { claim } from "../src/cases.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { createPolicyDraft, publishPolicy } from "../src/policy.ts";
import { requestDomainPause } from "../src/domain-pause.ts";
import { decideApproval } from "../src/approvals.ts";

/**
 * The Butler engine, end to end (#50).
 *
 * ## What is exercised for real, and what is substituted
 *
 * Real: D1, R2, the key vault, `sealManifest`, `claim`, `close`, `saveDraft`, `readDraft`, the policy plane,
 * the approval planner, the circuit breakers, the audit chain, `checkButler`, and the published
 * `butler_versions` row the interpreter reads its program out of. Nothing about a refusal here is a stub —
 * a policy denial is a real published policy, a paused domain is a real approved pause, and an unsatisfiable
 * approval is a real stage set with nobody eligible to fill it.
 *
 * Substituted in most tests: the `RunSteps` runner. `interpret` takes one, so a test can execute step bodies
 * inline and *observe* `sleep` and `waitForEvent` instead of waiting a year for the first and forever for
 * the second. That is the whole reason the interpreter is a function and `ButlerRun` is an adapter.
 *
 * **One test does not substitute it**, and it is the load-bearing one: `through the real Workflow binding`
 * calls `triggerButlers`, which calls `env.BUTLER_RUNS.create`, which runs the real `ButlerRun` entrypoint
 * against the real workflow engine, and then polls D1 for the record. Without it every other test in this
 * file would be a test of a function nothing calls.
 *
 * ## What the local runtime cannot prove, measured rather than assumed
 *
 * `create({ id })` on a duplicate **throws `instance.already_exists`** against the real platform
 * (`workflow-provisioning.md`). Miniflare's emulation does not: measured here — its `create` resolves,
 * swallowing the initialisation failure inside `waitUntil`. So the *refusal* is invisible locally while the
 * *outcome* holds, and the two halves are tested separately: the outcome against real storage (one run
 * record and one set of effects for two triggers of the same delivery), and the handling of the throw
 * against a binding that throws.
 */

const testEnv = env as unknown as Env;
const ORG = "org_butler";
const MAILBOX = "mbx_butler";
const ADDRESS = "support@acme.example";
const ADMIN = "usr_admin";
const RESPONDER = "usr_responder";
const APPROVER_A = "usr_approver_a";
const APPROVER_B = "usr_approver_b";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (prefix) => system.id(prefix), random: (n) => system.random(n) };
}

const T0 = 2_500_000_000_000;

/**
 * A runner that executes every step body inline.
 *
 * `sleep` and `waitForEvent` are **recorded, not performed**, which is what makes `wait` and the release
 * gate testable at all. `releases` decides what a wait does: resolve with a payload, or reject the way the
 * platform's timeout does.
 */
function inlineSteps(options: { release?: "arrives" | "times_out" } = {}): RunSteps & {
  slept: Array<{ name: string; seconds: number }>;
  waited: Array<{ name: string; type: string; timeoutSeconds: number }>;
  performed: string[];
} {
  const slept: Array<{ name: string; seconds: number }> = [];
  const waited: Array<{ name: string; type: string; timeoutSeconds: number }> = [];
  const performed: string[] = [];
  return {
    slept,
    waited,
    performed,
    do: async <T>(name: string, body: () => Promise<T>): Promise<T> => {
      performed.push(name);
      return await body();
    },
    sleep: async (name: string, seconds: number): Promise<void> => {
      slept.push({ name, seconds });
    },
    waitForEvent: async (name: string, type: string, timeoutSeconds: number): Promise<unknown> => {
      waited.push({ name, type, timeoutSeconds });
      if (options.release === "times_out") throw new Error("WorkflowTimeoutError: no event arrived");
      return { released: true };
    },
  };
}

interface Delivery {
  messageId: string;
  conversationId: string;
  caseId: string;
  receiptId: string;
}

/**
 * A real delivery: evidence in R2, a receipt, a message, a conversation and a case.
 *
 * `envelopeFrom` and `headerFrom` default to the same address and are **separable on purpose** (#52). A
 * Butler's recipients are derived from the envelope sender; the `From:` header is content the sender chose.
 * A fixture that could not tell the two apart could not tell whether the derivation reads the right one, and
 * every test in this file used to be exactly that fixture.
 */
async function aDelivery(
  ctx: Ctx,
  subject = "Invoice 4021 query",
  who: { envelopeFrom?: string; headerFrom?: string } = {},
): Promise<Delivery> {
  const envelopeFrom = who.envelopeFrom ?? "customer@example.net";
  const headerFrom = who.headerFrom ?? "customer@example.net";
  const at = new Date(ctx.now()).toISOString();
  const raw = utf8(
    `Message-ID: <${ctx.id("x")}@example.net>\r\nSubject: ${subject}\r\n`
    + `From: ${headerFrom}\r\n\r\nWhere is my invoice?\r\n`,
  );
  const stored = await putEvidence(testEnv, `${ORG}/raw/${ctx.id("k")}.eml`, raw);
  const receiptId = ctx.id("ir");
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, envelope_from, envelope_to, raw_bytes, accepted_at,
                                   blob_key, blob_sha256, provider_event_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(receiptId, ORG, envelopeFrom, ADDRESS, raw.byteLength, at,
    stored.blobKey, stored.plaintextSha256, ctx.id("pe")).run();

  const conversationId = await conversationForDelivery(testEnv, ctx, ORG, `<root-${ctx.id("r")}@example.net>`);
  const messageId = ctx.id("msg");
  await testEnv.CATALOG.prepare(
    `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
                           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
                           created_at, conversation_id, parse_error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).bind(messageId, ORG, "2026-08", stored.blobKey, stored.plaintextSha256, raw.byteLength,
    `<in-${messageId}@example.net>`, ctx.id("thr"), subject, headerFrom, at, at, receiptId, at,
    conversationId).run();

  const caseId = ctx.id("cas");
  await testEnv.CATALOG.prepare(
    `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at,
                        created_at)
     VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
  ).bind(caseId, ORG, conversationId, MAILBOX, at, at).run();

  return { messageId, conversationId, caseId, receiptId };
}

/** Publishes a Butler through the real authoring path, so the AST is checked and frozen. */
async function published(ctx: Ctx, name: string, nodes: unknown[], entry: string): Promise<{
  butlerId: string; versionId: string;
}> {
  const source = JSON.stringify({
    apiVersion: "mailda/v1",
    kind: "Butler",
    metadata: { name, owner: "team:support" },
    trigger: { event: "mail.received", mailbox: ADDRESS },
    entry,
    nodes,
  });
  const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, { name, source });
  const version = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
  return { butlerId: draft.butlerId, versionId: version.versionId };
}

function principal(ids: { butlerId: string; versionId: string }, name = "acknowledge"): ButlerPrincipal {
  return { orgId: ORG, butlerId: ids.butlerId, versionId: ids.versionId, name };
}

/** The acknowledgement Butler used by most of these tests: a guard, a draft and a proposed send. */
const ACKNOWLEDGE = [
  {
    id: "security_guard",
    type: "guard",
    // §16's own example shape: a bare comparison, no `${}`. A parsed message has `parse_error: null`.
    when: 'event.parse_error != null',
    then: "halt",
    otherwise: "reply",
  },
  { id: "halt", type: "stop", reason: "the message could not be parsed, so nothing is answered" },
  {
    id: "reply",
    type: "draft",
    mailboxId: "${event.mailbox_id}",
    subject: "Re: ${event.subject}",
    body: "Thanks for your message. Someone will reply shortly.",
    inReplyTo: "${event.message_id}",
    as: "acknowledgement",
    next: "propose",
  },
  { id: "propose", type: "mail.send.propose", draft: "${steps.acknowledgement}", next: null },
];

async function grantTo(ctx: Ctx, subject: string, relation: Parameters<typeof grant>[4]["relation"]): Promise<void> {
  await grant(testEnv, ctx, ORG, ADMIN, { subjectId: subject, relation, objectId: MAILBOX });
}

beforeEach(async () => {
  for (const table of [
    "butler_run_effects", "butler_runs", "butler_versions", "butlers", "cases", "conversations", "messages",
    "ingress_receipts", "relationship_tuples", "mailboxes", "addresses", "drafts", "send_manifests",
    "send_recipients", "send_counters", "audit_entries", "log_entries", "outbox", "users",
    "policies", "policy_versions", "policy_stages", "approvals", "approval_stages", "approval_decisions",
    "domain_pauses", "notifications",
  ]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = atTime(T0);
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    ...[ADMIN, RESPONDER, APPROVER_A, APPROVER_B].map((user) =>
      testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
        .bind(user, ORG, `${user}@local.invalid`, at)),
    // The administrator, which is what authoring a Butler takes (#49) — a tuple like any other.
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'org.admin','organization',?,?)`,
    ).bind(ctx.id("rt"), ORG, ADMIN, ORG, at),
  ]);
});

/* ------------------------------------------------------------------ the principal ----------------- */

describe("a Butler's principal is the Butler", () => {
  it("holds only what an administrator granted to its btl_ id, and loses it on revocation", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    const butler = principal(ids);

    // Nothing granted: a published Butler can do nothing at all. Fail-closed by default, which is the whole
    // return on making the Butler its own subject rather than borrowing its publisher's authority.
    expect(await maySend(testEnv, actingAs(butler), MAILBOX)).toBe(false);

    await grantTo(ctx, ids.butlerId, "send.propose");
    expect(await maySend(testEnv, actingAs(butler), MAILBOX)).toBe(true);

    await revoke(testEnv, ctx, ORG, ADMIN, {
      subjectId: ids.butlerId, relation: "send.propose", objectId: MAILBOX,
    });
    expect(await maySend(testEnv, actingAs(butler), MAILBOX)).toBe(false);
  });

  it("is checked by the same tuples `hasAnyRelation` reads, which is why the one-query form is safe", async () => {
    // `caseMailboxHeldBy` folds the tuple check into its statement rather than calling `maySend`, to save a
    // subrequest a Butler can never match (`team_members.user_id` holds users). That is a claim about
    // agreement between two code paths, so it is checked rather than argued: both answer alike before and
    // after a grant, and after a revocation.
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    const butler = principal(ids);
    const delivery = await aDelivery(ctx);

    expect(await caseMailboxHeldBy(testEnv, butler, delivery.caseId, "send.propose")).toBeNull();
    expect(await maySend(testEnv, actingAs(butler), MAILBOX)).toBe(false);

    await grantTo(ctx, ids.butlerId, "send.propose");
    const held = await caseMailboxHeldBy(testEnv, butler, delivery.caseId, "send.propose");
    expect(held?.mailboxId).toBe(MAILBOX);
    expect(await maySend(testEnv, actingAs(butler), MAILBOX)).toBe(true);

    await revoke(testEnv, ctx, ORG, ADMIN, {
      subjectId: ids.butlerId, relation: "send.propose", objectId: MAILBOX,
    });
    expect(await caseMailboxHeldBy(testEnv, butler, delivery.caseId, "send.propose")).toBeNull();
    expect(await maySend(testEnv, actingAs(butler), MAILBOX)).toBe(false);
  });

  it("names itself in the audit trail with a kind of its own, never a person", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);

    await run(ids, delivery, inlineSteps());

    const sealed = await testEnv.CATALOG.prepare(
      "SELECT actor_user_id, actor_kind FROM audit_entries WHERE action = 'send.sealed' LIMIT 1",
    ).first<{ actor_user_id: string; actor_kind: string }>();
    expect(sealed?.actor_user_id).toBe(ids.butlerId);
    expect(sealed?.actor_kind).toBe(BUTLER_ACTOR_KIND);
    // And not the publisher. Using the administrator who published it would grant the program everything
    // that person can do, put their name on mail they never saw, and silently exclude them from approving
    // any of it (§18's actor exclusion).
    expect(sealed?.actor_user_id).not.toBe(ADMIN);
  });

  it("answers *which version* from the run record, which is the only place that answers it", async () => {
    /*
     * `principal.ts` says authority attaches to the `btl_` and attribution names the `btv_`, and the loose
     * version of that sentence claimed the audit entry's `detail` carried the version. It does not, and it
     * should not: every entry a Butler causes is written by a Layer 5 function that takes an `actorUserId`
     * and knows nothing about Butlers — which is exactly the property that makes `actor_kind` derivable and
     * is the reason not to thread a per-call-site field through `sealManifest`.
     *
     * So this walks the path a reader actually has, on indexes that exist for it: the entry's subject is the
     * manifest id, `butler_run_effects.subject` is the same id (`bre_by_subject`), and its `run_id` names a
     * `butler_runs` row carrying both ids. Asserted in both directions — the version is reachable, and it is
     * *not* in the entry — because a later change that put it in the detail should make somebody re-read the
     * argument for not doing so rather than silently satisfy half of this.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);

    await run(ids, delivery, inlineSteps());

    const sealed = await testEnv.CATALOG.prepare(
      "SELECT subject, detail FROM audit_entries WHERE action = 'send.sealed' LIMIT 1",
    ).first<{ subject: string; detail: string }>();
    expect(sealed).not.toBeNull();
    expect(
      sealed!.detail.includes(ids.versionId),
      "send.sealed's detail now names the butler version — see src/butler/principal.ts on why it did not",
    ).toBe(false);

    // Manifest id -> the effect that produced it -> the run -> the version and the Butler.
    const reached = await testEnv.CATALOG.prepare(
      `SELECT r.butler_id, r.version_id FROM butler_run_effects e
         JOIN butler_runs r ON r.org_id = e.org_id AND r.id = e.run_id
        WHERE e.org_id = ? AND e.subject = ? LIMIT 1`,
    ).bind(ORG, sealed!.subject).first<{ butler_id: string; version_id: string }>();
    expect(reached).toEqual({ butler_id: ids.butlerId, version_id: ids.versionId });
  });
});

/** Runs one Butler over one delivery with the given step runner. */
async function run(
  ids: { butlerId: string; versionId: string },
  delivery: Delivery,
  steps: RunSteps,
  now = T0 + 1000,
): ReturnType<typeof interpret> {
  const facts = await factsOf(delivery);
  return await interpret(
    testEnv,
    atTime(now),
    {
      orgId: ORG,
      butlerId: ids.butlerId,
      butlerVersionId: ids.versionId,
      trigger: { event: "mail.received", key: delivery.messageId, facts },
    },
    steps,
    `${ids.versionId}-${delivery.messageId}`,
  );
}

/**
 * The facts `trigger.ts` assembles — **the production function**, not a copy of its statement.
 *
 * It used to be a copy, under a comment claiming a test could not drift from production. It could and it did:
 * #52 added `return_path` to the fact set and the copy went on producing deliveries with no envelope sender,
 * which is now the fact a Butler's recipients are derived from. A hand-written fixture here would be a test
 * of a delivery this Node never produces.
 */
async function factsOf(delivery: Delivery): Promise<Record<string, unknown>> {
  const facts = await deliveryFacts(testEnv, ORG, delivery.messageId);
  if (facts === null) throw new Error(`no delivery facts for ${delivery.messageId}`);
  return facts;
}

/* ------------------------------------------------------------------ a real walk ------------------- */

describe("a run walks a real AST and produces a real draft", () => {
  it("guards, drafts, seals and parks, with a record of each effect", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx, "Invoice 4021 query");

    const steps = inlineSteps();
    const outcome = await run(ids, delivery, steps);

    // The guard took the `otherwise` edge — the message parsed — so `halt` never ran and the two effect
    // nodes did. Only the effects are steps; the guard is arithmetic and costs nothing.
    expect(steps.performed).toEqual(["load", "reply#1", "propose#1"]);
    // The send parked, and this runner's release arrives at once — so the run went on to finish. The park is
    // asserted by its evidence rather than by catching a transient state: one `waitForEvent`, and a manifest
    // the sweeper cannot move.
    expect(steps.waited.map((wait) => wait.type)).toEqual([RELEASE_EVENT]);
    expect(outcome.state).toBe("finished");
    expect(outcome.effects.map((effect) => [effect.nodeType, effect.outcome]))
      .toEqual([["draft", "ok"], ["mail.send.propose", "ok"]]);

    // A real draft, with the expressions actually interpolated.
    const draft = await testEnv.CATALOG.prepare(
      "SELECT subject, to_addresses, in_reply_to_message_id, author_user_id FROM drafts LIMIT 1",
    ).first<{ subject: string; to_addresses: string; in_reply_to_message_id: string; author_user_id: string }>();
    expect(draft?.subject).toBe("Re: Invoice 4021 query");
    expect(JSON.parse(draft!.to_addresses)).toEqual(["customer@example.net"]);
    expect(draft?.in_reply_to_message_id).toBe(delivery.messageId);
    expect(draft?.author_user_id).toBe(ids.butlerId);

    // A real manifest, gated on a person.
    const manifest = await testEnv.CATALOG.prepare(
      "SELECT id, state, state_reason, author_user_id, envelope_from FROM send_manifests LIMIT 1",
    ).first<{ id: string; state: string; state_reason: string; author_user_id: string; envelope_from: string }>();
    expect(manifest?.state).toBe("awaiting");
    expect(manifest?.state_reason).toBe(BUTLER_RELEASE_REASON);
    expect(manifest?.author_user_id).toBe(ids.butlerId);
    expect(manifest?.envelope_from).toBe(ADDRESS);

    // The record a person reads.
    const record = await runRow(testEnv, ORG, outcome.runId);
    expect(record?.state).toBe("finished");
    expect(record?.butler_id).toBe(ids.butlerId);
    expect(record?.trigger_key).toBe(delivery.messageId);
    const effects = await runEffects(testEnv, ORG, outcome.runId);
    expect(effects.map((effect) => effect.node_id)).toEqual(["reply", "propose"]);
    expect(effects[1]?.subject).toBe(manifest?.id);
  });

  it("takes the other edge when the guard holds, and stops with the author's reason", async () => {
    // Non-vacuity for the guard: the *same* Butler over a delivery whose headers did not parse must take the
    // other branch and perform no effect at all. A guard that always fell through would pass the test above
    // and fail this one.
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    const delivery = await aDelivery(ctx);
    await testEnv.CATALOG.prepare("UPDATE messages SET parse_error = ? WHERE id = ?")
      .bind("E_NO_MESSAGE_ID  the sender omitted a Message-ID", delivery.messageId).run();

    const steps = inlineSteps();
    const outcome = await run(ids, delivery, steps);

    expect(outcome.state).toBe("stopped");
    expect(outcome.reason).toBe("the message could not be parsed, so nothing is answered");
    expect(steps.performed).toEqual(["load"]);
    expect(outcome.effects).toEqual([]);
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())
      .toEqual({ n: 0 });
  });
});

/* ------------------------------------------------------------------ recipients (#52) ------------- */

/**
 * Who a Butler's reply goes to, and who decides (#52, §16).
 *
 * §16 forbids untrusted content selecting or constructing To/CC/BCC. `draft` used to take a `to` list of
 * expressions and an expression reads `event.*`, so a published Butler could send to an address the inbound
 * message had chosen. The parameter is gone and the Node derives the recipient from the parent delivery's
 * envelope sender. These tests are what makes that a property rather than a paragraph.
 */
describe("a Butler does not choose who its reply goes to", () => {
  it("addresses the reply to the parent delivery's envelope sender", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx, "Invoice 4021 query");

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.state).toBe("finished");

    const draft = await testEnv.CATALOG.prepare(
      "SELECT to_addresses, cc_addresses, bcc_addresses FROM drafts LIMIT 1",
    ).first<{ to_addresses: string; cc_addresses: string | null; bcc_addresses: string | null }>();
    expect(JSON.parse(draft!.to_addresses)).toEqual(["customer@example.net"]);
    // Empty, and this is the cost of the decision stated as an assertion: a Butler cannot copy anybody.
    expect(JSON.parse(draft!.cc_addresses ?? "[]")).toEqual([]);
    expect(JSON.parse(draft!.bcc_addresses ?? "[]")).toEqual([]);

    // And the same address on the sealed manifest, which is what actually leaves. One recipient row.
    const recipients = await testEnv.CATALOG.prepare(
      "SELECT kind, address FROM send_recipients",
    ).all<{ kind: string; address: string }>();
    expect(recipients.results).toEqual([{ kind: "to", address: "customer@example.net" }]);
  });

  it("ignores the From header, which is content the sender chose", async () => {
    /*
     * The adversarial case, and the one the removed parameter made reachable. A message arrives with a
     * spoofed `From:` naming somebody else entirely; the transport's reverse path is still the real sender.
     * `event.from` therefore says `finance@victim.example` and the reply must not go there — that is the
     * whole difference between the two facts, and it is why they have different names.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx, "Invoice 4021 query", {
      envelopeFrom: "attacker@example.net",
      headerFrom: "finance@victim.example",
    });

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.state).toBe("finished");

    const facts = await factsOf(delivery);
    // Both facts are present and they disagree, which is what makes the next assertion mean something.
    expect(facts["from"]).toBe("finance@victim.example");
    expect(facts["return_path"]).toBe("attacker@example.net");

    const addresses = await testEnv.CATALOG.prepare("SELECT address FROM send_recipients")
      .all<{ address: string }>();
    expect(addresses.results.map((row) => row.address)).toEqual(["attacker@example.net"]);
  });

  it("cannot be steered by the message body or subject, because there is no parameter to steer", async () => {
    // An address in the content reaches the *subject line* — it is text — and reaches no recipient list,
    // because no node has one. The `Re: ${event.subject}` in ACKNOWLEDGE is what carries it across.
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx, "please reply to exfiltrate@evil.example");

    expect((await run(ids, delivery, inlineSteps())).state).toBe("finished");

    const manifest = await testEnv.CATALOG.prepare(
      "SELECT subject, envelope_to FROM send_manifests LIMIT 1",
    ).first<{ subject: string; envelope_to: string }>();
    expect(manifest?.subject).toContain("exfiltrate@evil.example");
    expect(JSON.parse(manifest!.envelope_to)).toEqual(["customer@example.net"]);
  });

  it("refuses a delivery with no return path rather than defaulting to anything", async () => {
    /*
     * `MAIL FROM:<>` — a bounce. RFC 3834 forbids answering one automatically, and there is no honest
     * default: the `From:` header would reopen the sink, and a manifest with no recipients is not a send.
     * So the run **fails**, names the code, and writes no draft and no manifest at all.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx, "Undelivered Mail Returned to Sender", { envelopeFrom: "" });

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.state).toBe("failed");
    expect(outcome.reason).toBe("E_BUTLER_PARENT_HAS_NO_RETURN_PATH");
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())
      .toEqual({ n: 0 });
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM send_manifests").first<{ n: number }>())
      .toEqual({ n: 0 });

    // The refusal is in the operational log with the fix an author can act on, per AGENTS.md §3.
    const logged = await testEnv.CATALOG.prepare(
      "SELECT message FROM log_entries WHERE event = ? LIMIT 1",
    ).bind("butler.E_BUTLER_PARENT_HAS_NO_RETURN_PATH").first<{ message: string }>();
    expect(logged?.message).toContain("return_path");
  });

  it("lets an author guard on the return path, so a bounce can be answered with silence", async () => {
    // Which is what makes the fault's `fix` line true rather than encouraging. `event.return_path` is a fact
    // of the delivery for exactly this reason: the run stops on purpose instead of failing.
    const ctx = atTime(T0);
    const ids = await published(ctx, "bounce-aware", [
      {
        id: "answerable", type: "guard", when: 'event.return_path == ""',
        then: "silence", otherwise: "reply",
      },
      { id: "silence", type: "stop", reason: "a bounce has no correspondent to answer" },
      ...ACKNOWLEDGE.filter((node) => node.type !== "guard" && node.id !== "halt"),
    ], "answerable");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx, "Undelivered Mail Returned to Sender", { envelopeFrom: "" });

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.state).toBe("stopped");
    expect(outcome.reason).toBe("a bounce has no correspondent to answer");
  });

  it("refuses to reply to the address the delivery arrived at, because that is a loop", async () => {
    /*
     * Found by driving the derivation adversarially rather than by reading it. Deriving the recipient from
     * the envelope sender closed the sink and left one address it must not derive: **its own**. A message
     * whose reverse path is `support@acme.example`, delivered to `support@acme.example`, sealed a manifest
     * with that address in From *and* To — which is delivered back into the same mailbox, fires the same
     * Butler, and does it again. Forging `MAIL FROM` is all it takes, so it starts from outside.
     *
     * `parent.ts` already called replying to the mailbox itself "a loop", as a reason not to default to it.
     * That was a reason nothing enforced. RFC 3834 §2 states the rule this now enforces: an automatic
     * responder must not answer its own address.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx, "loop", { envelopeFrom: ADDRESS, headerFrom: ADDRESS });

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.state).toBe("failed");
    expect(outcome.reason).toBe("E_BUTLER_REPLY_WOULD_LOOP");
    // Nothing written, so there is no draft for a person to release into the loop by hand either.
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())
      .toEqual({ n: 0 });
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM send_manifests").first<{ n: number }>())
      .toEqual({ n: 0 });

    // Case-insensitively, because an envelope sender is not required to match the stored address byte for
    // byte and a guard that a capital letter walks past is not a guard.
    const shouted = await aDelivery(ctx, "loop", { envelopeFrom: ADDRESS.toUpperCase() });
    expect((await run(ids, shouted, inlineSteps(), T0 + 2000)).reason).toBe("E_BUTLER_REPLY_WOULD_LOOP");

    // And the refusal carries the guard an author can write, per AGENTS.md §3.
    const logged = await testEnv.CATALOG.prepare(
      "SELECT message FROM log_entries WHERE event = ? LIMIT 1",
    ).bind("butler.E_BUTLER_REPLY_WOULD_LOOP").first<{ message: string }>();
    expect(logged?.message).toContain("event.return_path == event.mailbox_address");
  });

  it("refuses when it cannot tell whether a reply would loop, rather than skipping the check", async () => {
    // The pre-upgrade payload again, from the other side: a trigger with no `mailbox_address` cannot answer
    // "would this come straight back?". A check that turns itself off when its input is missing is a check
    // that is absent on exactly the runs nobody tested.
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);

    const facts = { ...(await factsOf(delivery)) };
    delete facts["mailbox_address"];
    const outcome = await interpret(
      testEnv, atTime(T0 + 1000),
      {
        orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
        trigger: { event: "mail.received", key: delivery.messageId, facts },
      },
      inlineSteps(), `${ids.versionId}-no-delivered-to`,
    );
    expect(outcome.state).toBe("failed");
    expect(outcome.reason).toBe("E_BUTLER_REPLY_WOULD_LOOP");
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())
      .toEqual({ n: 0 });
  });

  it("lets an author guard the loop away, which is what makes the fix line true", async () => {
    // Both sides of the comparison are bare paths, which the expression language resolves — so the guard the
    // refusal tells an author to write is a guard this engine can actually run.
    const ctx = atTime(T0);
    const ids = await published(ctx, "loop-aware", [
      {
        id: "answerable", type: "guard", when: "event.return_path == event.mailbox_address",
        then: "silence", otherwise: "reply",
      },
      { id: "silence", type: "stop", reason: "a message from this mailbox is not answered by it" },
      ...ACKNOWLEDGE.filter((node) => node.type !== "guard" && node.id !== "halt"),
    ], "answerable");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx, "loop", { envelopeFrom: ADDRESS });

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.state).toBe("stopped");
    expect(outcome.reason).toBe("a message from this mailbox is not answered by it");
  });

  it("bounds the one sink that is still an expression — the mailbox — by the grant rather than by the AST", async () => {
    /*
     * Found by re-verifying §16's other ten sinks rather than trusting the list (#52).
     *
     * **`draft.mailboxId` is an `Expr`,** so untrusted content *can* reach it — and the mailbox decides two
     * of the eleven: `From` is the mailbox's address (ADR 36), and `mailbox_id` is a policy condition. #52's
     * note that "sender identity is closed structurally" is half the story: `From` is derived from the
     * mailbox, and the mailbox is an expression.
     *
     * It is closed by **validation against trusted organization state**, which is §16's own escape clause
     * and is the honest difference from the recipient: a recipient had nothing to be validated against — no
     * contacts table, no allowlist — while a mailbox has `relationship_tuples`, which an administrator
     * writes. So this is asserted rather than described: content naming a mailbox this Butler was not
     * granted is refused, and content naming one it *was* granted works, which is the residual stated as a
     * fact rather than implied by silence.
     */
    const ctx = atTime(T0);
    const at = new Date(ctx.now()).toISOString();
    const other = "mbx_elsewhere";
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
        .bind(other, ORG, "Elsewhere", at),
      testEnv.CATALOG.prepare(
        "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("addr"), ORG, "elsewhere@acme.example", other, at),
    ]);

    const ids = await published(ctx, "content-picks-the-mailbox", [
      {
        id: "reply", type: "draft", mailboxId: "${event.subject}",
        subject: "Re:", body: "Thanks.", as: "ack", next: null,
      },
    ], "reply");
    await grantTo(ctx, ids.butlerId, "send.propose");

    // The subject *is* the other mailbox's id, which is the strongest form of the attack available: the
    // content names a real mailbox in the same organization.
    const elsewhere = await aDelivery(ctx, other);
    const refused = await run(ids, elsewhere, inlineSteps());
    expect(refused.effects.map((effect) => [effect.outcome, effect.reason]))
      .toEqual([["refused", "E_MAY_NOT_SEND_AS_MAILBOX"]]);
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())
      .toEqual({ n: 0 });

    // And the boundary is the grant, not the guess: the same expression works for the mailbox an
    // administrator did grant. That is the residual, and it is bounded by trusted state on purpose.
    const granted = await aDelivery(ctx, MAILBOX);
    const allowed = await run(ids, granted, inlineSteps());
    expect(allowed.effects.map((effect) => [effect.nodeType, effect.outcome]))
      .toEqual([["draft", "ok"]]);
  });

  it("cannot pick which of a mailbox's addresses it sends as, so a second address refuses the send", async () => {
    /*
     * The sender-identity sink from the other side, verified rather than asserted in a doc. `senderAddress`
     * is not a node parameter, so a Butler cannot name one — and `sealManifest` refuses to pick when a
     * mailbox has more than one, because that choice is what every recipient sees and a timestamp must not
     * make it.
     *
     * **So a Butler on a multi-address mailbox cannot send.** That predates this ticket and is the honest
     * consequence of the parameter being absent: the fix is a node parameter validated against the mailbox's
     * own addresses, which is trusted state, and it belongs with whoever wants the feature.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    await testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, "billing@acme.example", MAILBOX, new Date(ctx.now()).toISOString()).run();

    const outcome = await run(ids, await aDelivery(ctx), inlineSteps());
    expect(outcome.effects.map((effect) => [effect.nodeType, effect.outcome, effect.reason])).toEqual([
      ["draft", "ok", null],
      ["mail.send.propose", "refused", "E_SENDER_AMBIGUOUS"],
    ]);
  });

  it("refuses to draft in a run with no parent delivery at all", async () => {
    /*
     * Two shapes at once, because they are one cause. A trigger that is not a delivery — #49 says the trigger
     * enum will grow — and a run created by a *previous version of this Node*, whose payload carries facts
     * that predate `return_path`. Workflow instances outlive a deploy, so the second is not hypothetical.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    const delivery = await aDelivery(ctx);

    const notADelivery = await interpret(
      testEnv, atTime(T0 + 1000),
      {
        orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
        trigger: { event: "schedule.fired", key: "sch_1", facts: await factsOf(delivery) },
      },
      inlineSteps(), `${ids.versionId}-not-a-delivery`,
    );
    expect(notADelivery.state).toBe("failed");
    expect(notADelivery.reason).toBe("E_BUTLER_NO_PARENT_DELIVERY");

    const preUpgrade = { ...(await factsOf(delivery)) };
    delete preUpgrade["return_path"];
    const older = await interpret(
      testEnv, atTime(T0 + 2000),
      {
        orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
        trigger: { event: "mail.received", key: delivery.messageId, facts: preUpgrade },
      },
      inlineSteps(), `${ids.versionId}-pre-upgrade`,
    );
    expect(older.state).toBe("failed");
    expect(older.reason).toBe("E_BUTLER_PARENT_HAS_NO_RETURN_PATH");
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())
      .toEqual({ n: 0 });
  });
});

/* ------------------------------------------------------------------ the real workflow ------------- */

describe("through the real Workflow binding", () => {
  /** Polls for a terminal-ish state, because an instance runs asynchronously. */
  async function settle(runId: string, want: readonly string[]): Promise<Record<string, unknown> | null> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const row = await testEnv.CATALOG.prepare(
        "SELECT id, state, outcome_reason, effects, refusals, subrequests_spent FROM butler_runs WHERE id = ?",
      ).bind(runId).first<Record<string, unknown>>();
      if (row !== null && want.includes(String(row.state))) return row;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return await testEnv.CATALOG.prepare("SELECT * FROM butler_runs WHERE id = ?")
      .bind(runId).first<Record<string, unknown>>();
  }

  it("fires from a delivery, runs ButlerRun, and records what it did", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);

    const first = await triggerButlers(testEnv, ctx, ORG, delivery.messageId);
    expect(first.started).toEqual([`${ids.versionId}-${delivery.messageId}`]);
    expect(first.notListening).toBe(0);
    expect(first.notStarted).toEqual([]);

    const record = await settle(first.started[0]!, ["awaiting_release"]);
    expect(record?.state, JSON.stringify(record)).toBe("awaiting_release");
    expect(record?.effects).toBe(0);
    console.log(`MEASURE workflow_end_to_end run=${String(record?.id)} `
      + `spent=${String(record?.subrequests_spent)}`);

    // A second trigger of the same delivery. Locally `create` does not throw — measured below — so this
    // lands in `started`; what must hold either way is that **no second run happened**: one record, one set
    // of effects, one manifest.
    const second = await triggerButlers(testEnv, ctx, ORG, delivery.messageId);
    expect([...second.started, ...second.duplicates]).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM butler_runs").first<{ n: number }>())
      .toEqual({ n: 1 });
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM send_manifests").first<{ n: number }>())
      .toEqual({ n: 1 });
    const effects = await runEffects(testEnv, ORG, first.started[0]!);
    expect(effects.map((effect) => effect.seq)).toEqual([1, 2]);
  });

  it("does not fire a Butler listening on another mailbox", async () => {
    // Non-vacuity for the match: the same delivery, a Butler whose trigger names a different address.
    const ctx = atTime(T0);
    const source = JSON.stringify({
      apiVersion: "mailda/v1", kind: "Butler",
      metadata: { name: "elsewhere", owner: "team:sales" },
      trigger: { event: "mail.received", mailbox: "sales@acme.example" },
      entry: "halt",
      nodes: [{ id: "halt", type: "stop", reason: "not for me" }],
    });
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, { name: "elsewhere", source });
    await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    const delivery = await aDelivery(ctx);

    const outcome = await triggerButlers(testEnv, ctx, ORG, delivery.messageId);
    expect(outcome.started).toEqual([]);
    expect(outcome.notListening).toBe(1);
  });

  it("measures what miniflare's create does with a duplicate id, rather than assuming", async () => {
    // The finding this file exists to record: against the real platform a duplicate `create` **throws**
    // `instance.already_exists` and that throw is #50's whole `forbid` mechanism. Locally it does not.
    const id = `btv_measure-${Date.now()}`;
    const params = {
      orgId: ORG, butlerId: "btl_x", butlerVersionId: "btv_measure",
      trigger: { event: "mail.received", key: "msg_x", facts: {} },
    };
    await testEnv.BUTLER_RUNS.create({ id, params });
    let threw: string | null = null;
    try {
      await testEnv.BUTLER_RUNS.create({ id, params });
    } catch (error) {
      threw = (error as Error).message;
    }
    console.log(`MEASURE miniflare duplicate_create_throws=${threw === null ? 0 : 1} `
      + `message=${JSON.stringify(threw)}`);
    // Asserted as the measurement, not as an approval of it: if a miniflare release starts throwing, this
    // fails and the paragraph in `src/butler/trigger.ts` has to be rewritten rather than left claiming a
    // divergence that has closed.
    expect(threw).toBeNull();
  });

  it("treats a thrown already_exists as a duplicate, and anything else as a fault", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    const delivery = await aDelivery(ctx);

    const throwing = (message: string): Env => ({
      ...testEnv,
      BUTLER_RUNS: { create: async () => { throw new Error(message); } },
    } as unknown as Env);

    const refused = await triggerButlers(throwing("instance.already_exists"), ctx, ORG, delivery.messageId);
    expect(refused.duplicates).toEqual([`${ids.versionId}-${delivery.messageId}`]);
    expect(refused.started).toEqual([]);

    // Non-vacuity, and the safe direction: a *different* failure must not be absorbed as "already running".
    await expect(triggerButlers(throwing("subrequest limit exceeded"), ctx, ORG, delivery.messageId))
      .rejects.toThrow(/subrequest limit/);
  });
});

/* ------------------------------------------------------------------ refusals ---------------------- */

describe("a send refused is the system working", () => {
  async function readyToSend(ctx: Ctx): Promise<{ ids: { butlerId: string; versionId: string }; delivery: Delivery }> {
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    return { ids, delivery: await aDelivery(ctx) };
  }

  it("records a policy denial as a refusal, and the run carries on", async () => {
    const ctx = atTime(T0);
    const { ids, delivery } = await readyToSend(ctx);
    const policy = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
      name: "no outbound", outcome: "deny", conditions: { mailboxId: MAILBOX },
    });
    await publishPolicy(testEnv, ctx, ORG, ADMIN, policy.policyId);

    const outcome = await run(ids, delivery, inlineSteps());

    // The draft still happened — a policy decides whether mail *leaves*, not whether it may be written.
    expect(outcome.effects.map((effect) => [effect.nodeType, effect.outcome, effect.reason])).toEqual([
      ["draft", "ok", null],
      ["mail.send.propose", "refused", "policy_denied"],
    ]);
    // Not parked: there is nothing for a person to release.
    expect(outcome.state).toBe("finished");
    const manifest = await testEnv.CATALOG.prepare(
      "SELECT state, state_reason FROM send_manifests LIMIT 1",
    ).first<{ state: string; state_reason: string }>();
    expect(manifest).toEqual({ state: "withheld", state_reason: "policy_denied" });
    const record = await runRow(testEnv, ORG, outcome.runId);
    expect({ effects: record?.effects, refusals: record?.refusals }).toEqual({ effects: 1, refusals: 1 });
  });

  it("records a paused domain as a refusal", async () => {
    const ctx = atTime(T0);
    const { ids, delivery } = await readyToSend(ctx);
    // A real latched breaker: two administrators, an approval, a placed pause.
    await grant(testEnv, ctx, ORG, ADMIN, {
      subjectId: APPROVER_A, relation: "approval.decide", objectId: MAILBOX,
    });
    await grant(testEnv, ctx, ORG, ADMIN, {
      subjectId: APPROVER_B, relation: "approval.decide", objectId: MAILBOX,
    });
    for (const admin of [APPROVER_A, APPROVER_B]) {
      await testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,'org.admin','organization',?,?)`,
      ).bind(ctx.id("rt"), ORG, admin, ORG, new Date(ctx.now()).toISOString()).run();
    }
    const pause = await requestDomainPause(
      testEnv, ctx, ORG, ADMIN, "acme.example", "a customer's bounce storm",
    );
    await decideApproval(testEnv, ctx, ORG, APPROVER_A, pause.approvalId, "approve");
    await decideApproval(testEnv, ctx, ORG, APPROVER_B, pause.approvalId, "approve");

    const outcome = await run(ids, delivery, inlineSteps());
    const send = outcome.effects.find((effect) => effect.nodeType === "mail.send.propose");
    expect([send?.outcome, send?.reason]).toEqual(["refused", "domain_paused"]);
    expect(outcome.state).toBe("finished");
  });

  it("records an approval that nobody can give as a refusal, and one that somebody can as a gate", async () => {
    const ctx = atTime(T0);
    const { ids, delivery } = await readyToSend(ctx);
    // Published while it *can* be satisfied, because #60 refuses to publish a policy nobody could clear —
    // `assertApprovable` runs at publication. So the unsatisfiable state is reached the way it is reached in
    // life: the approvers were granted, the rule was published, and then the grants went away.
    for (const approver of [APPROVER_A, APPROVER_B]) {
      await grant(testEnv, ctx, ORG, ADMIN, {
        subjectId: approver, relation: "approval.decide", objectId: MAILBOX,
      });
    }
    const policy = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
      name: "review outbound", outcome: "require_approval", conditions: { mailboxId: MAILBOX }, stages: [2],
    });
    await publishPolicy(testEnv, ctx, ORG, ADMIN, policy.policyId);
    for (const approver of [APPROVER_A, APPROVER_B]) {
      await revoke(testEnv, ctx, ORG, ADMIN, {
        subjectId: approver, relation: "approval.decide", objectId: MAILBOX,
      });
    }

    // Nobody holds `approval.decide` any more, so a stage asking for two decisions cannot be filled.
    // Withheld rather than parked: the gate exists and nobody can clear it.
    const unsatisfiable = await run(ids, delivery, inlineSteps());
    const refusedSend = unsatisfiable.effects.find((effect) => effect.nodeType === "mail.send.propose");
    expect([refusedSend?.outcome, refusedSend?.reason]).toEqual(["refused", "approval_unsatisfiable"]);

    // Grant them back and run over a *second* delivery. The send is now gated by the approval, so this
    // Node's own release gate does **not** also apply — that would be a second ask for one send.
    for (const approver of [APPROVER_A, APPROVER_B]) {
      await grant(testEnv, ctx, ORG, ADMIN, {
        subjectId: approver, relation: "approval.decide", objectId: MAILBOX,
      });
    }
    const second = await aDelivery(ctx, "Second query");
    const steps = inlineSteps();
    const gated = await run(ids, second, steps, T0 + 2000);
    const gatedSend = gated.effects.find((effect) => effect.nodeType === "mail.send.propose");
    expect([gatedSend?.outcome, gatedSend?.reason]).toEqual(["ok", "policy_approval_required"]);
    expect(gated.state).toBe("finished");
    expect(steps.waited, "an approval-gated send must not also park on the Butler release gate").toEqual([]);
  });
});

/* ------------------------------------------------------------------ wait and release -------------- */

describe("wait sleeps, and a release resumes", () => {
  const CHASE = [
    { id: "pause", type: "wait", seconds: 3600, next: "reply" },
    ...ACKNOWLEDGE.slice(2),
  ];

  it("maps `wait` onto step.sleep with the node's own duration", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "chase", CHASE, "pause");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);

    const steps = inlineSteps();
    const outcome = await run(ids, delivery, steps);

    expect(steps.slept).toEqual([{ name: "pause#1", seconds: 3600 }]);
    // And the run went on afterwards, which is what distinguishes a sleep from a stop.
    expect(outcome.effects.map((effect) => effect.nodeType)).toEqual(["draft", "mail.send.propose"]);
    // A sleep costs no subrequest at all — it is `step.sleep`, and a waiting instance costs no concurrency.
    expect(steps.performed).not.toContain("pause#1");
  });

  it("parks a proposed send on waitForEvent and resumes when a person releases it", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    await grantTo(ctx, RESPONDER, "send.propose");
    const delivery = await aDelivery(ctx);

    // First: the run parks. The manifest is `awaiting` with the Butler reason and the sweeper cannot move it.
    const parking = inlineSteps({ release: "times_out" });
    const parked = await run(ids, delivery, parking);
    // The timeout is `approval.send_expiry_seconds`, reused rather than invented: a release is a person
    // agreeing to a Butler's send in substance, so this Node must not hold two opinions about how long
    // somebody has to decide about one send. Read from the budget so the two cannot drift.
    expect(parking.waited).toEqual([
      {
        name: "propose#1:release", type: RELEASE_EVENT,
        timeoutSeconds: BUDGETS["approval.send_expiry_seconds"],
      },
    ]);
    expect(parked.state).toBe("stopped");
    expect(parked.reason).toBe("release_timed_out");
    const manifestId = parked.effects.find((effect) => effect.nodeType === "mail.send.propose")!.subject!;
    // A timeout ends the **run**, never the send: the mail is still stopped and still releasable.
    expect(await manifestState(manifestId)).toEqual({
      state: "awaiting", state_reason: BUTLER_RELEASE_REASON,
    });

    // Then: a person releases it. The manifest goes back to `held`, from where the ordinary hold window
    // takes it, and the trail names the person rather than the Butler.
    const released = await releaseButlerSend(testEnv, atTime(T0 + 5000), ORG, RESPONDER, manifestId);
    expect(released.released).toBe(true);
    expect(await manifestState(manifestId)).toEqual({ state: "held", state_reason: null });
    const entry = await testEnv.CATALOG.prepare(
      "SELECT actor_user_id, actor_kind FROM audit_entries WHERE action = 'send.released' LIMIT 1",
    ).first<{ actor_user_id: string; actor_kind: string }>();
    expect(entry).toEqual({ actor_user_id: RESPONDER, actor_kind: "user" });

    // Non-vacuity on the predicate: releasing again finds nothing to release.
    const again = await releaseButlerSend(testEnv, atTime(T0 + 6000), ORG, RESPONDER, manifestId);
    expect(again).toEqual({ released: false, reason: "not_found" });
  });

  it("cannot be used to clear a policy gate, which is a different gate with a different clearer", async () => {
    /*
     * The predicate that makes this safe is `state_reason = 'butler_release_required'`, in the read **and**
     * in the conditional update. A policy hold and an approval are `awaiting` too, and if this act matched
     * them it would be a governance bypass with a benign-looking name — one `send.propose` holder clearing a
     * gate that #60 gave to an approver, or to nobody at all.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    await grantTo(ctx, RESPONDER, "send.propose");
    const policy = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
      name: "hold outbound", outcome: "hold", conditions: { mailboxId: MAILBOX },
    });
    await publishPolicy(testEnv, ctx, ORG, ADMIN, policy.policyId);
    const delivery = await aDelivery(ctx);

    const outcome = await run(ids, delivery, inlineSteps());
    const manifestId = outcome.effects.find((effect) => effect.nodeType === "mail.send.propose")!.subject!;
    expect(await manifestState(manifestId)).toEqual({ state: "awaiting", state_reason: "policy_hold" });

    // Refused, and refused as not-found: whether a send exists and which gate holds it must not be
    // learnable from this route (§5C).
    expect(await releaseButlerSend(testEnv, atTime(T0 + 5000), ORG, RESPONDER, manifestId))
      .toEqual({ released: false, reason: "not_found" });
    expect(await manifestState(manifestId)).toEqual({ state: "awaiting", state_reason: "policy_hold" });
    // And nothing was written to the trail about an act that did not happen.
    expect(await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE action = 'send.released'",
    ).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("refuses a release from somebody who may not send as the mailbox, as not-found", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);
    const parked = await run(ids, delivery, inlineSteps({ release: "times_out" }));
    const manifestId = parked.effects.find((effect) => effect.nodeType === "mail.send.propose")!.subject!;

    // `RESPONDER` holds nothing here. §5C: this answers exactly as a manifest that does not exist would.
    expect(await releaseButlerSend(testEnv, atTime(T0 + 5000), ORG, RESPONDER, manifestId))
      .toEqual({ released: false, reason: "not_found" });
    expect(await manifestState(manifestId)).toEqual({
      state: "awaiting", state_reason: BUTLER_RELEASE_REASON,
    });
  });

  it("resumes the run when the event arrives, and the run finishes", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);

    const steps = inlineSteps({ release: "arrives" });
    const outcome = await run(ids, delivery, steps);

    expect(steps.waited).toHaveLength(1);
    expect(outcome.state).toBe("finished");
    const record = await runRow(testEnv, ORG, outcome.runId);
    // Un-parked, and the reason cleared: it is no longer waiting, and a stale reason is a wrong answer.
    expect(record?.state).toBe("finished");
    expect(record?.outcome_reason).toBeNull();
  });
});

async function manifestState(manifestId: string): Promise<unknown> {
  return await testEnv.CATALOG.prepare(
    "SELECT state, state_reason FROM send_manifests WHERE id = ?",
  ).bind(manifestId).first();
}

/* ------------------------------------------------------------------ cases, loops, data ----------- */

describe("the rest of the shipped node set", () => {
  it("assigns a case to a person, and refuses one somebody else holds", async () => {
    const ctx = atTime(T0);
    const nodes = [
      { id: "assign", type: "case.assign", caseId: "${event.case_id}", assignee: "${transform_target}", next: null },
    ];
    // `assignee` has to resolve, and the only roots are `event`, `steps` and `butler` — so a literal user id
    // goes through a `transform`, which is also the shape a real Butler would use for a rota.
    const withTransform = [
      { id: "pick", type: "transform", as: "target", value: RESPONDER, next: "assign" },
      { id: "assign", type: "case.assign", caseId: "${event.case_id}", assignee: "${steps.target}", next: null },
    ];
    void nodes;
    const ids = await published(ctx, "triage", withTransform, "pick");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, RESPONDER, "send.propose");
    const delivery = await aDelivery(ctx);

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.effects.map((effect) => [effect.nodeType, effect.outcome])).toEqual([["case.assign", "ok"]]);
    const assigned = await testEnv.CATALOG.prepare("SELECT assignee, state FROM cases WHERE id = ?")
      .bind(delivery.caseId).first<{ assignee: string; state: string }>();
    expect(assigned).toEqual({ assignee: RESPONDER, state: "claimed" });

    // A second delivery, whose case is already held: refused, named, and the run carries on.
    const second = await aDelivery(ctx, "Another");
    await claim(testEnv, ctx, ORG, RESPONDER, second.caseId);
    const held = await run(ids, second, inlineSteps(), T0 + 2000);
    expect(held.effects.map((effect) => [effect.nodeType, effect.outcome, effect.reason]))
      .toEqual([["case.assign", "refused", "case_held"]]);
  });

  it("refuses a case in a mailbox the Butler holds nothing on, without saying which it was", async () => {
    // The check `claim` does not do: it verifies the **assignee**, so without this a Butler holding nothing
    // anywhere could assign any case in the organization to anybody who may work it.
    const ctx = atTime(T0);
    const withTransform = [
      { id: "pick", type: "transform", as: "target", value: RESPONDER, next: "assign" },
      { id: "assign", type: "case.assign", caseId: "${event.case_id}", assignee: "${steps.target}", next: null },
    ];
    const ids = await published(ctx, "triage", withTransform, "pick");
    await grantTo(ctx, RESPONDER, "send.propose");
    const delivery = await aDelivery(ctx);

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.effects.map((effect) => [effect.outcome, effect.reason]))
      .toEqual([["refused", "case_not_actionable"]]);
    expect(await testEnv.CATALOG.prepare("SELECT assignee FROM cases WHERE id = ?")
      .bind(delivery.caseId).first<{ assignee: string | null }>()).toEqual({ assignee: null });
  });

  it("names the assignee's own lack of authority, which is a different answer from the Butler's", async () => {
    /*
     * `claim` answers `not_found` for a case that does not exist **and** for one whose mailbox the assignee
     * may not send as. The engine has already proved the case exists and is visible to the Butler, so the
     * remaining reading is the second — and a person reading the run needs to be told which, because the
     * remedy is a grant to a *different* subject.
     */
    const ctx = atTime(T0);
    const nodes = [
      { id: "pick", type: "transform", as: "target", value: APPROVER_A, next: "assign" },
      { id: "assign", type: "case.assign", caseId: "${event.case_id}", assignee: "${steps.target}", next: null },
    ];
    const ids = await published(ctx, "triage", nodes, "pick");
    await grantTo(ctx, ids.butlerId, "send.propose");
    // APPROVER_A holds nothing on this mailbox, so the Butler may act and the assignee may not work it.
    const delivery = await aDelivery(ctx);

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.effects.map((effect) => [effect.outcome, effect.reason]))
      .toEqual([["refused", "assignee_may_not_work_it"]]);
  });

  it("refuses to assign or close a case that is already closed", async () => {
    const ctx = atTime(T0);
    const nodes = [
      { id: "pick", type: "transform", as: "target", value: RESPONDER, next: "assign" },
      { id: "assign", type: "case.assign", caseId: "${event.case_id}", assignee: "${steps.target}", next: "shut" },
      { id: "shut", type: "case.close", caseId: "${event.case_id}", next: null },
    ];
    const ids = await published(ctx, "triage", nodes, "pick");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, RESPONDER, "send.propose");
    const delivery = await aDelivery(ctx);
    await testEnv.CATALOG.prepare("UPDATE cases SET state = 'closed', state_at = ? WHERE id = ?")
      .bind(new Date(ctx.now()).toISOString(), delivery.caseId).run();

    const outcome = await run(ids, delivery, inlineSteps());
    // Both nodes refuse, both name the same reason, and the run carries on to the end of the graph — because
    // a closed case is the system working rather than a fault.
    expect(outcome.effects.map((effect) => [effect.nodeType, effect.outcome, effect.reason])).toEqual([
      ["case.assign", "refused", "case_closed"],
      ["case.close", "refused", "case_closed"],
    ]);
    expect(outcome.state).toBe("finished");
  });

  it("closes only a case it holds, which is what `close` requires of a person too", async () => {
    const ctx = atTime(T0);
    const nodes = [
      { id: "mine", type: "case.assign", caseId: "${event.case_id}", assignee: "${butler.id}", next: "done" },
      { id: "done", type: "case.close", caseId: "${event.case_id}", next: null },
    ];
    const ids = await published(ctx, "self-serve", nodes, "mine");
    await grantTo(ctx, ids.butlerId, "send.propose");
    const delivery = await aDelivery(ctx);

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.effects.map((effect) => [effect.nodeType, effect.outcome]))
      .toEqual([["case.assign", "ok"], ["case.close", "ok"]]);
    expect(await testEnv.CATALOG.prepare("SELECT state, assignee FROM cases WHERE id = ?")
      .bind(delivery.caseId).first()).toEqual({ state: "closed", assignee: null });

    // Non-vacuity: a case held by somebody else cannot be closed by the Butler, and the reason says so.
    const second = await aDelivery(ctx, "Another");
    await grantTo(ctx, RESPONDER, "send.propose");
    await claim(testEnv, ctx, ORG, RESPONDER, second.caseId);
    const refused = await run(ids, second, inlineSteps(), T0 + 2000);
    expect(refused.effects.map((effect) => [effect.nodeType, effect.outcome, effect.reason])).toEqual([
      ["case.assign", "refused", "case_held"],
      ["case.close", "refused", "case_not_held_by_butler"],
    ]);
  });

  it("looks up a row it may read, refuses one it may not, and projects rather than returning the row", async () => {
    const ctx = atTime(T0);
    const nodes = [
      {
        id: "read", type: "lookup", entity: "message", entityId: "${event.message_id}", as: "original",
        next: "check",
      },
      { id: "check", type: "guard", when: 'steps.original.from_addr == "customer@example.net"', then: "yes", otherwise: "no" },
      { id: "yes", type: "stop", reason: "the sender is who the trigger said" },
      { id: "no", type: "stop", reason: "the lookup disagreed with the trigger" },
    ];
    const ids = await published(ctx, "verify", nodes, "read");
    const delivery = await aDelivery(ctx);

    /*
     * No read relation: the lookup is refused, and §5C keeps "absent" and "forbidden" alike.
     *
     * The run then **faults**, and that is the honest consequence rather than a gap: a refused lookup binds
     * nothing, so the guard that reads `steps.original.from_addr` is a program reading a field that is not
     * there. The refusal is recorded *first*, so the run reads refusal-then-fault and a person meets the
     * reason before the symptom. The shipped AST has no failure edge for a node to branch on (`effects.ts`
     * says so), which is what makes this the only available answer short of substituting a value.
     */
    const blind = await run(ids, delivery, inlineSteps());
    expect(blind.effects.map((effect) => [effect.outcome, effect.reason]))
      .toEqual([["refused", "not_readable"]]);
    expect(blind.state).toBe("failed");
    expect(blind.reason).toBe("E_BUTLER_EXPR_UNRESOLVED");

    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const seeing = await run(ids, delivery, inlineSteps(), T0 + 2000);
    expect(seeing.reason).toBe("the sender is who the trigger said");

    // And the projection: a lookup must not put an internal storage key where an expression can interpolate
    // it into a subject line.
    const row = await readEntity(testEnv, principal(ids), "message", delivery.messageId);
    expect(row).not.toBeNull();
    expect(Object.keys(row!)).not.toContain("blob_key");
    expect(Object.keys(row!)).not.toContain("blob_sha256");
    // Every declared entity is readable by the same one query, which is what `butler.step_cost_max_lookup`
    // was measured against.
    expect([...LOOKUP_ENTITIES]).toEqual(["message", "conversation", "case", "mailbox", "draft"]);
  });

  it("fails a loop whose collection is larger than its bound, and processes nothing", async () => {
    const ctx = atTime(T0);
    const nodes = [
      { id: "listed", type: "transform", as: "rows", value: "${event.recipients}", next: "each" },
      {
        id: "each", type: "foreach", over: "${steps.rows}", as: "row", maxItems: 2, body: "note",
        next: "done",
      },
      { id: "note", type: "transform", as: "seen", value: "${steps.row}", next: null },
      { id: "done", type: "stop", reason: "every row was seen" },
    ];
    const ids = await published(ctx, "fan", nodes, "listed");
    const delivery = await aDelivery(ctx);
    const facts = { ...(await factsOf(delivery)), recipients: ["a", "b", "c"] };

    const outcome = await interpret(
      testEnv, atTime(T0 + 1000),
      {
        orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
        trigger: { event: "mail.received", key: delivery.messageId, facts },
      },
      inlineSteps(), `${ids.versionId}-${delivery.messageId}`,
    );

    expect(outcome.state).toBe("failed");
    expect(outcome.reason).toBe("loop_bound_exceeded");
    // Nothing processed, and the operational log carries the four-part refusal a person acts on.
    const logged = await testEnv.CATALOG.prepare(
      "SELECT event, message FROM log_entries WHERE event = 'butler.loop_bound_exceeded' LIMIT 1",
    ).first<{ event: string; message: string }>();
    expect(logged?.message).toContain("maxItems=2");
    expect(logged?.message).toContain("asked for 3");

    // Non-vacuity: three items under a bound of three run, and the loop completes.
    const within = await published(ctx, "fan-wide", nodes.map((node) =>
      node.id === "each" ? { ...node, maxItems: 3 } : node), "listed");
    const second = await aDelivery(ctx, "Another");
    const ok = await interpret(
      testEnv, atTime(T0 + 2000),
      {
        orgId: ORG, butlerId: within.butlerId, butlerVersionId: within.versionId,
        trigger: {
          event: "mail.received", key: second.messageId,
          facts: { ...(await factsOf(second)), recipients: ["a", "b", "c"] },
        },
      },
      inlineSteps(), `${within.versionId}-${second.messageId}`,
    );
    expect(ok.state).toBe("stopped");
    expect(ok.reason).toBe("every row was seen");
  });

  it("switches on a value, and collects a map's results under one name", async () => {
    const ctx = atTime(T0);
    const nodes = [
      { id: "listed", type: "transform", as: "rows", value: "${event.recipients}", next: "each" },
      {
        id: "each", type: "map", over: "${steps.rows}", as: "row", maxItems: 4, body: "note",
        collectAs: "seen", next: "route",
      },
      // The body binds under the loop's own `collectAs`, which is the one name a map uses: inside the body
      // it is this iteration's result, and after the loop it is the array of them.
      { id: "note", type: "transform", as: "seen", value: "seen:${steps.row}", next: null },
      { id: "route", type: "switch", on: "${steps.rows}", cases: [{ equals: "x", next: "wrong" }], default: "right" },
      { id: "wrong", type: "stop", reason: "the switch matched a case it should not have" },
      { id: "right", type: "stop", reason: "the switch fell through to its default" },
    ];
    const ids = await published(ctx, "collect", nodes, "listed");
    const delivery = await aDelivery(ctx);
    const facts = { ...(await factsOf(delivery)), recipients: ["a", "b"] };

    const outcome = await interpret(
      testEnv, atTime(T0 + 1000),
      {
        orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
        trigger: { event: "mail.received", key: delivery.messageId, facts },
      },
      inlineSteps(), `${ids.versionId}-${delivery.messageId}`,
    );

    expect(outcome.state).toBe("stopped");
    expect(outcome.reason).toBe("the switch fell through to its default");
    // The body ran once per item — two items, two visits of `note`, and the loop's own node visited once.
    expect(outcome.nodesExecuted).toBe(1 + 1 + 2 + 1 + 1);
  });

  it("refuses a map whose body collected nothing under the name the loop names", async () => {
    // Non-vacuity for `collectAs`, and the decision behind it: a map that collected nulls would report a
    // list of results for iterations that produced none. A `foreach` is the node that collects nothing.
    const ctx = atTime(T0);
    /*
     * The fixture binds `seen` **before** the loop and never inside it. That is what makes the refusal load
     * bearing rather than incidental: without clearing the binding at the top of each iteration, iteration
     * one would find the pre-loop value still there and collect it, and the loop would report a list of
     * results for iterations that produced none.
     */
    const nodes = [
      { id: "listed", type: "transform", as: "rows", value: "${event.recipients}", next: "stale" },
      { id: "stale", type: "transform", as: "seen", value: "left over from before the loop", next: "each" },
      {
        id: "each", type: "map", over: "${steps.rows}", as: "row", maxItems: 4, body: "note",
        collectAs: "seen", next: "done",
      },
      { id: "note", type: "transform", as: "elsewhere", value: "${steps.row}", next: null },
      { id: "done", type: "stop", reason: "collected" },
    ];
    const ids = await published(ctx, "mislaid", nodes, "listed");
    const delivery = await aDelivery(ctx);
    const outcome = await interpret(
      testEnv, atTime(T0 + 1000),
      {
        orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
        trigger: {
          event: "mail.received", key: delivery.messageId,
          facts: { ...(await factsOf(delivery)), recipients: ["a"] },
        },
      },
      inlineSteps(), `${ids.versionId}-${delivery.messageId}`,
    );
    expect(outcome.state).toBe("failed");
    expect(outcome.reason).toBe("E_BUTLER_MAP_COLLECTS_NOTHING");
  });

  it("refuses a validate whose value does not match, and passes one that does", async () => {
    const ctx = atTime(T0);
    const nodes = [
      {
        id: "shape", type: "validate", value: "${event.subject}",
        schema: { type: "string", minLength: 5 }, next: "done",
      },
      { id: "done", type: "stop", reason: "the subject was long enough" },
    ];
    const ids = await published(ctx, "shape-check", nodes, "shape");
    const long = await aDelivery(ctx, "A long enough subject");
    expect((await run(ids, long, inlineSteps())).reason).toBe("the subject was long enough");

    const short = await aDelivery(ctx, "Hi");
    const refused = await run(ids, short, inlineSteps(), T0 + 2000);
    expect(refused.state).toBe("refused");
    expect(refused.reason).toBe("validate_failed");
  });
});

/* ------------------------------------------------------------------ the re-check ------------------ */

describe("a stored AST is data, so the engine re-checks it", () => {
  it("refuses a reserved node written straight into the row, before performing any effect", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);

    /*
     * The one thing `checkButler` at publication cannot prevent: a direct write. `butler_versions` has two
     * triggers that abort an UPDATE of a published row's content, so this has to go through a state
     * demotion — which is itself refused (`btv_forward_only`) — so the row is replaced outright. That is
     * exactly the access level the header of `src/butler/interpret.ts` says this guards against.
     */
    const hostile = JSON.stringify({
      apiVersion: "mailda/v1", kind: "Butler",
      metadata: { name: "acknowledge", owner: "team:support" },
      trigger: { event: "mail.received", mailbox: ADDRESS },
      entry: "classify",
      nodes: [
        { id: "classify", type: "llm.classify", profile: "sales-intake@3", next: "reply" },
        ...ACKNOWLEDGE.slice(2),
      ],
    });
    await testEnv.CATALOG.prepare("DELETE FROM butler_versions WHERE id = ?").bind(ids.versionId).run();
    await testEnv.CATALOG.prepare(
      `INSERT INTO butler_versions
         (id, org_id, butler_id, version, state, ast_json, source_text, ast_sha256, source_sha256,
          created_by, created_at, published_by, published_at, superseded_at)
       VALUES (?,?,?,1,'published',?,?,'x','y',?,?,?,?,NULL)`,
    ).bind(ids.versionId, ORG, ids.butlerId, hostile, hostile, ADMIN,
      new Date(ctx.now()).toISOString(), ADMIN, new Date(ctx.now()).toISOString()).run();

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.state).toBe("refused");
    expect(outcome.reason).toBe("ast_does_not_check");
    expect(outcome.effects).toEqual([]);
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())
      .toEqual({ n: 0 });

    // The checker's own words, in the log, so a person meets the reason rather than a stack trace.
    const logged = await testEnv.CATALOG.prepare(
      "SELECT message FROM log_entries WHERE event = 'butler.ast_does_not_check' LIMIT 1",
    ).first<{ message: string }>();
    expect(logged?.message).toContain("E_BUTLER_NODE_RESERVED");
    expect(logged?.message).toContain("There is no LLM control plane");
  });

  it("refuses a version already published with a recipient parameter, rather than running it", async () => {
    /*
     * The question #52 leaves behind and nothing else answers: **what happens to the Butlers that were
     * already published while `draft` took a `to`?** Their `ast_json` is frozen — a published version cannot
     * be edited — so the row on a live Node still names recipients an inbound message chose.
     *
     * The engine re-checks the stored AST on every run, so the answer falls out of the same guard: a version
     * carrying `to` no longer checks, the run is refused before any effect, and nothing is sent. Asserted
     * because "fail-closed" is a claim about a path, and the direction matters — a version that ran with the
     * field *ignored* would silently send to a recipient its author picked and no longer controls.
     *
     * The row is written directly for the reason the test above is: this Butler cannot be published any more,
     * which is the whole point, so the only way to have one is to be a Node that already did.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);

    const legacy = JSON.stringify({
      apiVersion: "mailda/v1", kind: "Butler",
      metadata: { name: "acknowledge", owner: "team:support" },
      trigger: { event: "mail.received", mailbox: ADDRESS },
      entry: "reply",
      nodes: ACKNOWLEDGE
        .filter((node) => node.type === "draft" || node.type === "mail.send.propose")
        // Exactly what `main` shipped: a recipient list of expressions, reading the inbound message.
        .map((node) => (node.type === "draft" ? { ...node, to: ["${event.from}"] } : node)),
    });
    await testEnv.CATALOG.prepare("DELETE FROM butler_versions WHERE id = ?").bind(ids.versionId).run();
    await testEnv.CATALOG.prepare(
      `INSERT INTO butler_versions
         (id, org_id, butler_id, version, state, ast_json, source_text, ast_sha256, source_sha256,
          created_by, created_at, published_by, published_at, superseded_at)
       VALUES (?,?,?,1,'published',?,?,'x','y',?,?,?,?,NULL)`,
    ).bind(ids.versionId, ORG, ids.butlerId, legacy, legacy, ADMIN,
      new Date(ctx.now()).toISOString(), ADMIN, new Date(ctx.now()).toISOString()).run();

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.state).toBe("refused");
    expect(outcome.reason).toBe("ast_does_not_check");
    expect(outcome.effects).toEqual([]);
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())
      .toEqual({ n: 0 });
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM send_manifests").first<{ n: number }>())
      .toEqual({ n: 0 });

    const logged = await testEnv.CATALOG.prepare(
      "SELECT message FROM log_entries WHERE event = 'butler.ast_does_not_check' LIMIT 1",
    ).first<{ message: string }>();
    expect(logged?.message).toContain("E_BUTLER_NODE_UNKNOWN_PARAMETER");
    expect(logged?.message).toContain("To/CC/BCC");
  });

  it("refuses a run whose version is no longer published", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    const delivery = await aDelivery(ctx);
    await testEnv.CATALOG.prepare(
      "UPDATE butler_versions SET state = 'superseded', superseded_at = ? WHERE id = ?",
    ).bind(new Date(ctx.now()).toISOString(), ids.versionId).run();

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.state).toBe("refused");
    expect(outcome.reason).toBe("version_not_published");
    // The record still exists, with the ids the payload carried — so a refusal is visible even though
    // nothing about the program could be read.
    expect((await runRow(testEnv, ORG, outcome.runId))?.version_id).toBe(ids.versionId);
  });

  it("refuses an effect it cannot afford, rather than being killed mid-run", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "security_guard");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);
    const runId = `${ids.versionId}-${delivery.messageId}`;

    // A run that has already spent almost the whole pot. Written directly because the alternative is a
    // Butler with ten thousand subrequests in it, and the column is exactly what a resumed instance reads.
    await testEnv.CATALOG.prepare(
      `INSERT INTO butler_runs (id, org_id, butler_id, version_id, trigger_event, trigger_key, state,
                                state_at, outcome_reason, started_at, finished_at, nodes_executed, effects,
                                refusals, subrequests_spent)
       VALUES (?,?,?,?,'mail.received',?, 'running', ?, NULL, ?, NULL, 0, 0, 0, 9995)`,
    ).bind(runId, ORG, ids.butlerId, ids.versionId, delivery.messageId,
      new Date(ctx.now()).toISOString(), new Date(ctx.now()).toISOString()).run();

    const outcome = await run(ids, delivery, inlineSteps());
    expect(outcome.state).toBe("refused");
    expect(outcome.reason).toBe("budget_exhausted");
    expect(outcome.effects).toEqual([]);
    const logged = await testEnv.CATALOG.prepare(
      "SELECT message FROM log_entries WHERE event = 'butler.budget_exhausted' LIMIT 1",
    ).first<{ message: string }>();
    expect(logged?.message).toContain("E_BUDGET_EXCEEDED");
    expect(logged?.message).toContain("workflow.paid.subrequest_budget_per_instance=10000");
    expect(logged?.message).toContain("reply");
  });
});

/* ------------------------------------------------------------------ the vocabulary --------------- */

describe("the engine's own refusal vocabulary is closed", () => {
  it("declares exactly the six #50 settled on, plus #53's two replay tokens", () => {
    // `replay_identical_content` is the seventh member and the only one that is not a refusal: a replay found
    // it was about to seal a send identical to one the replayed run already made, so it reused that send's
    // effect key and sealed nothing. It lives in this list because the run record's `reason` column carries
    // it and a reason nobody can list is a reason nobody can filter on — see `effects.ts` on why the outcome
    // beside it stays `ok`.
    //
    // `replay_send_decided` is the eighth and is that token's pair: the same key reuse, on an incumbent that
    // is `cancelled` or `withheld` — a decision **against** this message, so nothing is on its way and `ok`
    // would report a success that did not happen.
    expect([...EFFECT_REASONS].sort()).toEqual([
      "assignee_may_not_work_it", "case_closed", "case_held", "case_not_actionable",
      "case_not_held_by_butler", "not_readable", "replay_identical_content", "replay_send_decided",
    ]);
  });

  it("prices the same AST the checker prices, so the two cannot disagree about the graph", () => {
    // Not a cost assertion — `test/butler-run-cost.measure.test.ts` owns those. This asserts that the
    // engine's forecast is built from the checker's own answer for the same nodes, which is the property
    // that stops a second cost model appearing in the engine.
    const checked = checkButler({
      apiVersion: "mailda/v1", kind: "Butler",
      metadata: { name: "acknowledge", owner: "team:support" },
      trigger: { event: "mail.received", mailbox: ADDRESS },
      entry: "security_guard", nodes: ACKNOWLEDGE,
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.cost.total).toBe(priceButler(checked.ast.nodes).total);
    console.log(`MEASURE checker_prediction acknowledge=${checked.cost.total}`);
  });
});
