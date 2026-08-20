import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { utf8 } from "@mailda/evidence";
import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { grant } from "../src/access.ts";
import { type Principal } from "../src/authz-read.ts";
import { interpret, type RunSteps } from "../src/butler/interpret.ts";
import { inspectRun, replayRun } from "../src/butler/replay.ts";
import { recentRuns, runEffects, runRow, triggerFactsOf } from "../src/butler/record.ts";
import { deliveryFacts, FACT_DISCLOSURE, redactFacts } from "../src/butler/trigger.ts";
import { placeButlerPause } from "../src/butler/pause-acts.ts";
import { createButlerDraft, publishButler } from "../src/butlers.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { contentIdentity } from "../src/outbound/manifest.ts";
import { createPolicyDraft, publishPolicy } from "../src/policy.ts";
import {
  incumbentStands, PROVEN_STATES, provenNonAcceptanceSql, resendMayDuplicate, retryEffect, retryOffer,
  type RetryFacts,
} from "../src/outbound/retry.ts";
import { type SendState } from "../src/outbound/dispatch.ts";
import { type SubmitOutcome, type TransportAdapter } from "../src/outbound/transport.ts";
import { capabilitiesFor } from "./butler-capabilities.ts";

/**
 * The run ledger and the four replay modes (#53), end to end.
 *
 * ## The headline, and why it is the headline
 *
 * §16 says *"a replay never reuses an old approval or idempotency key for a materially new effect."* This
 * ticket's own body proposed reading *materially new* as *a different manifest id* — and a replay producing
 * byte-identical content **always** gets a new id, because the id is a time-and-random ULID. So the rule this
 * file exists to pin is the one an id-based reading gets exactly backwards: an identical replay must reuse the
 * old key and send nothing, and `a replay of an unchanged run seals a second manifest` is the failure that
 * hands a customer two copies of the same message.
 *
 * ## What is real here
 *
 * Real: D1, R2, the key vault, `sealManifest`, `saveDraft`, `readDraft`, the policy plane, `checkButler`, the
 * audit chain, published `butler_versions`, real `send_manifests` rows and a real Butler pause.
 *
 * Substituted: the `RunSteps` runner, so a replay executes inline instead of through the Workflow engine — the
 * same substitution `butler-run.test.ts` makes and for the same reason. `replayRun`'s own tests do go through
 * the binding, and assert only what is written **before** `create` resolves, so an asynchronous run cannot
 * make them flaky.
 *
 * The transport is a stub wherever a send has to reach a terminal state, because the four provable states are
 * exactly what a transport answers and there is no other way to produce them.
 */

const testEnv = env as unknown as Env;
const ORG = "org_replay";
const MAILBOX = "mbx_replay";
const ADDRESS = "support@acme.example";
const ADMIN = "usr_admin";
const OTHER = "usr_other";
/**
 * An administrator who holds `mailbox.content.read` (the `beforeEach` grants it), so `inspect` answers this
 * principal in full. The redaction tests use `AS_OTHER`, who is an administrator holding **nothing** on the
 * mailbox — which is the population #63 exists to keep out of other people's mail.
 */
const AS_ADMIN: Principal = { orgId: ORG, userId: ADMIN };
const AS_OTHER: Principal = { orgId: ORG, userId: OTHER };

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (prefix) => system.id(prefix), random: (n) => system.random(n) };
}

const T0 = 2_700_000_000_000;

function inlineSteps(): RunSteps & { waited: string[] } {
  const waited: string[] = [];
  return {
    waited,
    do: async <T>(_name: string, body: () => Promise<T>): Promise<T> => await body(),
    sleep: async (): Promise<void> => undefined,
    waitForEvent: async (name: string): Promise<unknown> => {
      waited.push(name);
      return { released: true };
    },
  };
}

function fakeTransport(outcome: SubmitOutcome): TransportAdapter & { calls: number } {
  return {
    name: "fake",
    calls: 0,
    async capability() {
      return { canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "fake" };
    },
    async submit(this: { calls: number }) {
      this.calls += 1;
      return outcome;
    },
  };
}

interface Delivery { messageId: string; conversationId: string; caseId: string }

async function aDelivery(ctx: Ctx, subject = "Invoice 4021 query"): Promise<Delivery> {
  const at = new Date(ctx.now()).toISOString();
  const raw = utf8(
    `Message-ID: <${ctx.id("x")}@example.net>\r\nSubject: ${subject}\r\n`
    + "From: customer@example.net\r\n\r\nWhere is my invoice?\r\n",
  );
  const stored = await putEvidence(testEnv, `${ORG}/raw/${ctx.id("k")}.eml`, raw);
  const receiptId = ctx.id("ir");
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, envelope_from, envelope_to, raw_bytes, accepted_at,
                                   blob_key, blob_sha256, provider_event_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(receiptId, ORG, "customer@example.net", ADDRESS, raw.byteLength, at,
    stored.blobKey, stored.plaintextSha256, ctx.id("pe")).run();

  const conversationId = await conversationForDelivery(testEnv, ctx, ORG, `<root-${ctx.id("r")}@example.net>`);
  const messageId = ctx.id("msg");
  await testEnv.CATALOG.prepare(
    `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
                           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
                           created_at, conversation_id, parse_error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).bind(messageId, ORG, "2026-08", stored.blobKey, stored.plaintextSha256, raw.byteLength,
    `<in-${messageId}@example.net>`, ctx.id("thr"), subject, "customer@example.net", at, at, receiptId, at,
    conversationId).run();

  const caseId = ctx.id("cas");
  await testEnv.CATALOG.prepare(
    `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at,
                        created_at)
     VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
  ).bind(caseId, ORG, conversationId, MAILBOX, at, at).run();

  return { messageId, conversationId, caseId };
}

async function published(ctx: Ctx, name: string, nodes: unknown[], entry: string): Promise<{
  butlerId: string; versionId: string;
}> {
  const source = JSON.stringify({
    apiVersion: "mailda/v1",
    kind: "Butler",
    metadata: { name, owner: "team:support" },
    capabilities: capabilitiesFor(nodes, ADDRESS),
    trigger: { event: "mail.received", mailbox: ADDRESS },
    entry,
    nodes,
  });
  const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, { name, source });
  const version = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
  return { butlerId: draft.butlerId, versionId: version.versionId };
}

/** A constant acknowledgement: every run of it over one delivery produces byte-identical content. */
const ACKNOWLEDGE = [
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

/**
 * An acknowledgement whose body quotes the **case's live state**, so a replay after the case moves produces
 * genuinely different content.
 *
 * This is the shape that makes "materially new" testable at all without cheating: the AST is frozen, the
 * trigger facts are inherited, and the only thing a deterministic replay can legitimately differ on is what it
 * *reads from storage now*. A `lookup` is exactly that, which is also why it is the node that earns a run
 * record row despite performing no effect.
 */
const QUOTES_THE_CASE = [
  { id: "look", type: "lookup", entity: "case", entityId: "${event.case_id}", as: "k", next: "reply" },
  {
    id: "reply",
    type: "draft",
    mailboxId: "${event.mailbox_id}",
    subject: "Re: ${event.subject}",
    body: "Your case is ${steps.k.state}.",
    inReplyTo: "${event.message_id}",
    as: "acknowledgement",
    next: "propose",
  },
  { id: "propose", type: "mail.send.propose", draft: "${steps.acknowledgement}", next: null },
];

async function grantTo(ctx: Ctx, subject: string, relation: Parameters<typeof grant>[4]["relation"]) {
  await grant(testEnv, ctx, ORG, ADMIN, { subjectId: subject, relation, objectId: MAILBOX });
}

async function factsOf(delivery: Delivery): Promise<Record<string, unknown>> {
  const facts = await deliveryFacts(testEnv, ORG, delivery.messageId);
  if (facts === null) throw new Error("the fixture produced a delivery with no attributable mailbox");
  return facts as unknown as Record<string, unknown>;
}

/** One ordinary run, driven inline. */
async function run(
  ids: { butlerId: string; versionId: string },
  delivery: Delivery,
  now = T0 + 1000,
): Promise<{ runId: string; steps: ReturnType<typeof inlineSteps> }> {
  const runId = `${ids.versionId}-${delivery.messageId}`;
  const steps = inlineSteps();
  await interpret(
    testEnv, atTime(now),
    {
      orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
      trigger: { event: "mail.received", key: delivery.messageId, facts: await factsOf(delivery) },
    },
    steps, runId,
  );
  return { runId, steps };
}

/**
 * A replay, driven inline through the engine.
 *
 * The facts come off the **source run's row**, exactly as `replayRun` copies them, so this exercises the same
 * inheritance rather than re-deriving them from the delivery — which is the distinction the whole design rests
 * on and would be silently undone by a test that passed fresh facts.
 */
async function replay(
  ids: { butlerId: string; versionId: string },
  sourceRunId: string,
  now = T0 + 60_000,
): Promise<{
  runId: string; steps: ReturnType<typeof inlineSteps>; result: Awaited<ReturnType<typeof interpret>>;
}> {
  const ctx = atTime(now);
  const source = await runRow(testEnv, ORG, sourceRunId);
  const sourceFacts = await triggerFactsOf(testEnv, ORG, sourceRunId);
  if (source === null || sourceFacts === null) throw new Error("no source run");
  const runId = `${ids.versionId}-${ctx.id("brp")}`;
  const steps = inlineSteps();
  const result = await interpret(
    testEnv, ctx,
    {
      orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
      trigger: {
        event: source.trigger_event,
        key: source.trigger_key,
        facts: JSON.parse(sourceFacts) as Record<string, unknown>,
      },
      replay: { ofRunId: sourceRunId, byUserId: ADMIN },
    },
    steps, runId,
  );
  return { runId, steps, result };
}

async function manifestIds(): Promise<string[]> {
  const { results } = await testEnv.CATALOG.prepare(
    "SELECT id FROM send_manifests WHERE org_id = ? ORDER BY sealed_at, id",
  ).bind(ORG).all<{ id: string }>();
  return results.map((row) => row.id);
}

async function countOf(sql: string, ...params: unknown[]): Promise<number> {
  const row = await testEnv.CATALOG.prepare(sql).bind(...params).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  for (const table of [
    "butler_run_effects", "butler_runs", "butler_pauses", "butler_versions", "butlers", "cases",
    "conversations", "messages", "ingress_receipts", "relationship_tuples", "mailboxes", "addresses",
    "drafts", "send_manifests", "send_recipients", "send_counters", "audit_entries", "log_entries",
    "outbox", "users", "policies", "policy_versions", "policy_stages", "approvals", "approval_stages",
    "approval_decisions", "domain_pauses", "notifications", "supervised_grants", "matters",
  ]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = atTime(T0);
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare(
      "INSERT INTO mailboxes (id, org_id, name, hold_window_seconds, created_at) VALUES (?,?,?,?,?)",
    ).bind(MAILBOX, ORG, "Support", 0, at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    ...[ADMIN, OTHER].map((user) =>
      testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
        .bind(user, ORG, `${user}@local.invalid`, at)),
    // **Both** users are organization administrators, and that is the point of the second one: `OTHER` passes
    // every `isAdmin` gate on the two replay routes and holds nothing whatsoever on the mailbox. It is the
    // principal the disclosure tests below use.
    ...[ADMIN, OTHER].map((user) =>
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,'org.admin','organization',?,?)`,
      ).bind(ctx.id("rt"), ORG, user, ORG, at)),
  ]);
  await grantTo(ctx, ADMIN, "send.propose");
  await grantTo(ctx, ADMIN, "mailbox.content.read");
});

/* ============================================================ materially new, by content ========== */

describe("materially new is decided by content, never by identifier (#53)", () => {
  it("reuses the old effect key and seals nothing when a replay reproduces the send byte for byte", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);

    const first = await run(ids, delivery);
    const [original] = await manifestIds();
    expect(original).toBeDefined();

    const replayed = await replay(ids, first.runId);

    /*
     * The whole ticket, in three assertions.
     *
     * **One manifest**, so no second idempotency key exists and there is nothing for a dispatcher to hand
     * over twice. An id-based reading of "materially new" fails right here: the replay's seal would have
     * minted `snd_…` afresh, this list would hold two, and both would be dispatchable.
     */
    expect(await manifestIds()).toEqual([original]);
    // **One seal in the trail.** The record and the outbox agree that one message was composed.
    expect(await countOf(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ? AND action = 'send.sealed'", ORG,
    )).toBe(1);

    // **The replay's own effect row points at the original send**, so `bre_by_subject` joins both runs to one
    // message and the reason says why nothing was sealed.
    const effects = await runEffects(testEnv, ORG, replayed.runId);
    const propose = effects.find((effect) => effect.node_type === "mail.send.propose");
    expect(propose?.subject).toBe(original);
    expect(propose?.reason).toBe("replay_identical_content");
    expect(propose?.outcome).toBe("ok");
  });

  it("does not park on the reused send's gate, so the replay never waits for a release it cannot receive",
    async () => {
      const ctx = atTime(T0);
      const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
      await grantTo(ctx, ids.butlerId, "send.propose");
      await grantTo(ctx, ids.butlerId, "mailbox.content.read");
      const delivery = await aDelivery(ctx);

      const first = await run(ids, delivery);
      // The original run really did park, which is what makes this test mean something: the incumbent the
      // replay reuses carries `butler_release_required`, the one reason that parks a run.
      expect(first.steps.waited).toHaveLength(1);
      expect((await testEnv.CATALOG.prepare(
        "SELECT state, state_reason FROM send_manifests WHERE org_id = ?",
      ).bind(ORG).first<{ state: string; state_reason: string }>()))
        .toEqual({ state: "awaiting", state_reason: "butler_release_required" });

      const replayed = await replay(ids, first.runId);
      // Parking here would wait for a release that resumes the *original* run — `runOfSubject` returns the
      // first run for a subject — so this replay would have sat until its own timeout.
      expect(replayed.steps.waited).toEqual([]);
      expect(replayed.result.state).toBe("finished");
    });

  it("mints a new key when the content differs, and leaves the old send untouched", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "quotes-the-case", QUOTES_THE_CASE, "look");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);

    const first = await run(ids, delivery);
    const [original] = await manifestIds();

    // The world moves. A `lookup` is the one node whose answer legitimately changes between a run and its
    // replay, which is what makes a replay's content able to differ at all.
    await testEnv.CATALOG.prepare("UPDATE cases SET state = 'closed' WHERE org_id = ? AND id = ?")
      .bind(ORG, delivery.caseId).run();

    const replayed = await replay(ids, first.runId);
    const after = await manifestIds();
    expect(after).toHaveLength(2);

    const minted = after.find((id) => id !== original)!;
    const propose = (await runEffects(testEnv, ORG, replayed.runId))
      .find((effect) => effect.node_type === "mail.send.propose");
    expect(propose?.subject).toBe(minted);
    expect(propose?.reason).not.toBe("replay_identical_content");

    // Two bodies, two hashes: the content genuinely differs rather than the rule having simply failed to
    // match. Asserted on the stored hashes, because that is what the rule compares.
    const { results } = await testEnv.CATALOG.prepare(
      "SELECT id, body_normalized_sha256 FROM send_manifests WHERE org_id = ?",
    ).bind(ORG).all<{ id: string; body_normalized_sha256: string }>();
    expect(new Set(results.map((row) => row.body_normalized_sha256)).size).toBe(2);
  });

  it("hashes content and not identity, so two manifests can share an identity and one send cannot lose its own",
    async () => {
      // A unit check on the rule itself, because the two end-to-end tests above can only observe its effect.
      const base = {
        mailboxId: MAILBOX,
        to: ["customer@example.net"],
        cc: [] as string[],
        bcc: [] as string[],
        subject: "Re: Invoice 4021 query",
        inReplyToMessageId: "msg_01",
        bodyNormalizedSha256: "abc",
      };
      expect(await contentIdentity(base)).toBe(await contentIdentity({ ...base }));
      // Case and order are not content: SMTP delivers to a set, and #53 errs on the side of *identical*
      // because identity means "send nothing" and difference means "possibly send twice".
      expect(await contentIdentity({ ...base, to: ["Customer@Example.net"] })).toBe(await contentIdentity(base));
      expect(await contentIdentity({ ...base, to: ["b@x.test", "a@x.test"] }))
        .toBe(await contentIdentity({ ...base, to: ["a@x.test", "b@x.test"] }));
      // Everything a recipient would read is compared exactly.
      for (const different of [
        { ...base, subject: "Re: Invoice 4022 query" },
        { ...base, bodyNormalizedSha256: "abd" },
        { ...base, inReplyToMessageId: null },
        { ...base, mailboxId: "mbx_other" },
        { ...base, cc: ["colleague@acme.example"] },
        { ...base, bcc: ["archive@acme.example"] },
      ]) {
        expect(await contentIdentity(different)).not.toBe(await contentIdentity(base));
      }
    });

  it("refuses the whole replay when a send it would repeat has no manifest left to compare against",
    async () => {
      const ctx = atTime(T0);
      const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
      await grantTo(ctx, ids.butlerId, "send.propose");
      await grantTo(ctx, ids.butlerId, "mailbox.content.read");
      const delivery = await aDelivery(ctx);
      const first = await run(ids, delivery);

      // The manifest is gone, so its content is unknowable. Treating that as *materially new* is the
      // permissive failure — a fresh key for a message that may be identical — so the run refuses instead.
      await testEnv.CATALOG.prepare("DELETE FROM send_manifests WHERE org_id = ?").bind(ORG).run();

      const replayed = await replay(ids, first.runId);
      expect(replayed.result.state).toBe("refused");
      expect(replayed.result.reason).toBe("replay_send_unprovable");
      // And nothing was sealed on the way to refusing.
      expect(await manifestIds()).toEqual([]);
    });
});

/* ============================================================ what a replay re-asks =============== */

describe("a replay inherits the input and re-asks the judgement (#53)", () => {
  it("is refused by a policy published after the original ran", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "quotes-the-case", QUOTES_THE_CASE, "look");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);

    const first = await run(ids, delivery);
    const [original] = await manifestIds();
    // The original was allowed: no policy existed when it ran.
    expect(await testEnv.CATALOG.prepare(
      "SELECT policy_outcome FROM send_manifests WHERE id = ?",
    ).bind(original).first<{ policy_outcome: string }>()).toEqual({ policy_outcome: "allow" });

    // The world tightens, in both senses: the case moves, so the replay's content is materially new and it
    // really does try to seal; and a policy now denies every send from this mailbox.
    await testEnv.CATALOG.prepare("UPDATE cases SET state = 'closed' WHERE org_id = ? AND id = ?")
      .bind(ORG, delivery.caseId).run();
    const policy = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
      name: "no-sending", outcome: "deny", conditions: { mailboxId: MAILBOX },
    });
    await publishPolicy(testEnv, atTime(T0 + 500), ORG, ADMIN, policy.policyId);

    const replayed = await replay(ids, first.runId);

    const propose = (await runEffects(testEnv, ORG, replayed.runId))
      .find((effect) => effect.node_type === "mail.send.propose");
    // Refused, with the manifest's own token — the engine invents no vocabulary of its own for this.
    expect(propose?.outcome).toBe("refused");
    expect(propose?.reason).toBe("policy_denied");

    // The replay's send is `withheld`, and the original is untouched by the new rule: a policy applies to
    // decisions taken after it is published, and the seal is the decision.
    const states = await testEnv.CATALOG.prepare(
      "SELECT id, state FROM send_manifests WHERE org_id = ? ORDER BY sealed_at",
    ).bind(ORG).all<{ id: string; state: string }>();
    expect(states.results[0]).toEqual({ id: original, state: "awaiting" });
    expect(states.results[1]?.state).toBe("withheld");
  });

  it("does not re-ask policy for an identical replay, because an identical replay performs nothing",
    async () => {
      /*
       * The other half of the sentence above, and it is the counter-intuitive half worth pinning.
       *
       * A replay whose content is identical seals nothing, so there is no decision for a policy to take. That
       * is not a bypass: the send that exists is still re-evaluated against the **current** policy at
       * dispatch by `recheck.ts` (§18's "stricter policy fails closed"), so a tightened policy still stops it
       * — on the original manifest, where the mail actually is. Asking permission to do nothing would be the
       * odd behaviour, and would make a policy denial appear against a run that composed no message.
       */
      const ctx = atTime(T0);
      const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
      await grantTo(ctx, ids.butlerId, "send.propose");
      await grantTo(ctx, ids.butlerId, "mailbox.content.read");
      const delivery = await aDelivery(ctx);
      const first = await run(ids, delivery);
      const [original] = await manifestIds();

      const policy = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
        name: "no-sending", outcome: "deny", conditions: { mailboxId: MAILBOX },
      });
      await publishPolicy(testEnv, atTime(T0 + 500), ORG, ADMIN, policy.policyId);

      const replayed = await replay(ids, first.runId);
      const propose = (await runEffects(testEnv, ORG, replayed.runId))
        .find((effect) => effect.node_type === "mail.send.propose");
      expect(propose?.reason).toBe("replay_identical_content");
      expect(await manifestIds()).toEqual([original]);
    });

  it("leaves the original's approval bound to the original, and never to newly minted bytes", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "quotes-the-case", QUOTES_THE_CASE, "look");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);
    const first = await run(ids, delivery);
    const [original] = await manifestIds();

    await testEnv.CATALOG.prepare("UPDATE cases SET state = 'closed' WHERE org_id = ? AND id = ?")
      .bind(ORG, delivery.caseId).run();
    const replayed = await replay(ids, first.runId);
    const minted = (await runEffects(testEnv, ORG, replayed.runId))
      .find((effect) => effect.node_type === "mail.send.propose")!.subject!;

    // An approval binds a manifest id, so a materially-new effect cannot inherit one: there is no row in
    // `approvals` whose subject is the new manifest unless the current policy asked for one, and the
    // original's own subject is unchanged. ADR 11's property falls out of the identifiers.
    expect(minted).not.toBe(original);
    const bound = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND subject_id = ?",
    ).bind(ORG, minted).first<{ n: number }>();
    expect(bound?.n).toBe(0);
  });

  it("gives the replay's send its own hold window rather than inheriting the original's", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "quotes-the-case", QUOTES_THE_CASE, "look");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);
    const first = await run(ids, delivery);

    await testEnv.CATALOG.prepare("UPDATE cases SET state = 'closed' WHERE org_id = ? AND id = ?")
      .bind(ORG, delivery.caseId).run();
    await replay(ids, first.runId, T0 + 3_600_000);

    const { results } = await testEnv.CATALOG.prepare(
      "SELECT release_at FROM send_manifests WHERE org_id = ? ORDER BY sealed_at",
    ).bind(ORG).all<{ release_at: string }>();
    // The window to cancel is a fresh one, measured from the replay's own instant. An inherited `release_at`
    // would make a replayed send immediately past its window and therefore unstoppable.
    expect(Date.parse(results[1]!.release_at)).toBeGreaterThan(Date.parse(results[0]!.release_at));
  });

  it("refuses to start when the Butler has been paused since the original ran", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);
    const first = await run(ids, delivery);

    await placeButlerPause(testEnv, atTime(T0 + 100), ORG, {
      butlerId: ids.butlerId, butlerName: "acknowledge", reason: "loop_detected",
      detail: "the fixture stopped it", trippedBy: delivery.messageId,
    });

    // A pause refuses rather than gates, so the answer is that **no run happens** — not a run that starts
    // and refuses itself. Nothing is created and nothing is recorded beyond the pause's own entry.
    await expect(replayRun(testEnv, atTime(T0 + 200), ORG, ADMIN, first.runId))
      .rejects.toThrow(/E_BUTLER_PAUSED/);
    expect(await countOf(
      "SELECT COUNT(*) AS n FROM butler_runs WHERE org_id = ? AND replay_of IS NOT NULL", ORG,
    )).toBe(0);
  });

  it("refuses when the version the run executed is no longer published", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);
    const first = await run(ids, delivery);

    await testEnv.CATALOG.prepare(
      "UPDATE butler_versions SET state = 'superseded' WHERE org_id = ? AND id = ?",
    ).bind(ORG, ids.versionId).run();

    await expect(replayRun(testEnv, atTime(T0 + 200), ORG, ADMIN, first.runId))
      .rejects.toThrow(/E_REPLAY_VERSION_NOT_PUBLISHED/);
  });

  it("refuses a run recorded before this Node stored what a run was given", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);
    const first = await run(ids, delivery);

    // A pre-0030 row, reproduced exactly: the run exists and its input does not.
    await testEnv.CATALOG.prepare("UPDATE butler_runs SET trigger_facts = NULL WHERE id = ?")
      .bind(first.runId).run();

    await expect(replayRun(testEnv, atTime(T0 + 200), ORG, ADMIN, first.runId))
      .rejects.toThrow(/E_REPLAY_INPUT_NOT_RECORDED/);
  });
});

/* ============================================================ the ledger and inspect ============== */

describe("the run ledger records what a run was given, and inspect executes nothing (#53)", () => {
  it("freezes the trigger facts on the row, and re-derivation would have answered differently", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);
    const first = await run(ids, delivery);

    const recorded = JSON.parse((await triggerFactsOf(testEnv, ORG, first.runId))!) as
      Record<string, unknown>;
    expect(recorded.case_id).toBe(delivery.caseId);

    // The world moves under it. `deliveryFacts` now answers about **now**, and the recorded facts still
    // answer about then — which is the whole reason the column exists rather than being computed.
    await testEnv.CATALOG.prepare("DELETE FROM cases WHERE org_id = ? AND id = ?")
      .bind(ORG, delivery.caseId).run();
    expect((await deliveryFacts(testEnv, ORG, delivery.messageId))?.case_id).toBeNull();
    expect(JSON.parse((await triggerFactsOf(testEnv, ORG, first.runId))!).case_id)
      .toBe(delivery.caseId);
  });

  it("returns the frozen program, the input, the effects and each send's offer — and writes nothing",
    async () => {
      const ctx = atTime(T0);
      const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
      await grantTo(ctx, ids.butlerId, "send.propose");
      await grantTo(ctx, ids.butlerId, "mailbox.content.read");
      const delivery = await aDelivery(ctx);
      const first = await run(ids, delivery);

      const before = await countOf("SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ?", ORG);
      const inspected = await inspectRun(testEnv, atTime(T0 + 300), AS_ADMIN, first.runId);
      const after = await countOf("SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ?", ORG);

      // "`inspect` executes nothing" includes writing nothing, audit entry included.
      expect(after).toBe(before);

      expect(inspected?.program?.state).toBe("published");
      expect(inspected?.program?.checks).toBe(true);
      expect(inspected?.program?.nodes.map((node) => node.id)).toEqual(["reply", "propose"]);
      expect((inspected?.triggerFacts as { message_id: string }).message_id).toBe(delivery.messageId);
      expect(inspected?.reRun).toEqual({ available: true, why: null });

      const propose = inspected!.effects.find((effect) => effect.node_type === "mail.send.propose");
      // The send's current state travels with the effect, and so does what it offers — a Butler-gated send
      // has been attempted by nobody, so neither mode is on offer.
      expect(propose?.send?.state).toBe("awaiting");
      expect(propose?.send?.retry).toEqual({ mode: null, why: "not_yet_attempted" });

      // And the thing a reader would otherwise infer wrongly is stated in the answer rather than in a doc.
      expect(inspected?.notRecorded).toMatch(/not recorded/);
    });

  it("says which precondition stops a re-run rather than reporting it as merely unavailable", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);
    const first = await run(ids, delivery);

    await testEnv.CATALOG.prepare("UPDATE butler_runs SET trigger_facts = NULL WHERE id = ?")
      .bind(first.runId).run();
    expect((await inspectRun(testEnv, atTime(T0 + 300), AS_ADMIN, first.runId))?.reRun)
      .toEqual({ available: false, why: "input_not_recorded" });
  });

  it("records the replay on the run row and in the trail, keyed on the replay rather than the delivery",
    async () => {
      const ctx = atTime(T0);
      const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
      await grantTo(ctx, ids.butlerId, "send.propose");
      await grantTo(ctx, ids.butlerId, "mailbox.content.read");
      const delivery = await aDelivery(ctx);
      const first = await run(ids, delivery);

      const started = await replayRun(testEnv, atTime(T0 + 200), ORG, ADMIN, first.runId);

      // `<butlerVersionId>-<replayId>`, not `<butlerVersionId>-<triggerKey>`: keying a replay on the delivery
      // would collide with the primary key of the record it is replaying.
      expect(started.runId.startsWith(`${ids.versionId}-brp_`)).toBe(true);
      expect(started.runId).not.toBe(first.runId);

      const row = await runRow(testEnv, ORG, started.runId);
      expect(row?.replay_of).toBe(first.runId);
      expect(row?.replayed_by).toBe(ADMIN);
      // The delivery is still on the row and still indexed, so "every run caused by this message" keeps
      // answering.
      expect(row?.trigger_key).toBe(delivery.messageId);

      const entry = await testEnv.CATALOG.prepare(
        "SELECT actor_user_id, subject, detail FROM audit_entries WHERE org_id = ? AND action = 'butler.replayed'",
      ).bind(ORG).first<{ actor_user_id: string; subject: string; detail: string }>();
      expect(entry?.actor_user_id).toBe(ADMIN);
      expect(entry?.subject).toBe(started.runId);
      expect(JSON.parse(entry!.detail).replayOf).toBe(first.runId);

      // And `inspect` of the original now names it, so two people looking at one screen can see that it has
      // already been re-run.
      expect((await inspectRun(testEnv, atTime(T0 + 300), AS_ADMIN, first.runId))?.replays.map((replayed) => replayed.id))
        .toContain(started.runId);
    });

  it("gives the replay its own cost counter and leaves the original's alone", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx);
    const first = await run(ids, delivery);
    const originalSpend = (await runRow(testEnv, ORG, first.runId))!.subrequests_spent;
    expect(originalSpend).toBeGreaterThan(0);

    const replayed = await replay(ids, first.runId);

    // The pot is per instance and a replay is a new instance, so the counter starts again. That is what
    // makes a run killed with `budget_exhausted` replayable at all: an inherited figure would have refused
    // a replay that is in fact affordable.
    expect((await runRow(testEnv, ORG, first.runId))?.subrequests_spent).toBe(originalSpend);
    const replaySpend = (await runRow(testEnv, ORG, replayed.runId))!.subrequests_spent;
    expect(replaySpend).toBeLessThan(originalSpend);
  });
});

/* ============================================================ the four provable states ============ */

const EVERY_STATE: readonly SendState[] = [
  "held", "awaiting", "cancelled", "withheld", "throttled", "refused", "suppressed",
  "handed_over", "outcome_unknown",
];

describe("retry-effect is offered iff non-acceptance is proven, and absent otherwise (#53, §16)", () => {
  it("offers it on each of the four provable states, and on nothing else", () => {
    const authoredUnsubmitted = { fidelity: "authored", hasSubmitted: false };
    expect(retryOffer({ state: "refused", ...authoredUnsubmitted }))
      .toEqual({ mode: "retry-effect", proof: "refused" });
    expect(retryOffer({ state: "throttled", ...authoredUnsubmitted }))
      .toEqual({ mode: "retry-effect", proof: "throttled" });
    expect(retryOffer({ state: "suppressed", ...authoredUnsubmitted }))
      .toEqual({ mode: "retry-effect", proof: "suppressed" });
    // The fourth, and the only one that needs a second column: the bytes and `submitted_key` are written
    // before the first submit, so an absent key on an authored manifest is a durable proof of non-submission.
    expect(retryOffer({ state: "outcome_unknown", ...authoredUnsubmitted }))
      .toEqual({ mode: "retry-effect", proof: "never_submitted" });

    const offered = EVERY_STATE.filter((state) =>
      retryOffer({ state, ...authoredUnsubmitted }).mode === "retry-effect");
    expect(offered.sort()).toEqual(["outcome_unknown", "refused", "suppressed", "throttled"]);
  });

  it("is absent — not failing — on an outcome_unknown whose bytes were rendered", () => {
    // The unprovable case: the bytes exist, so the transport may have taken them and the acknowledgement been
    // lost. `retry-effect` is *absent*, and the differently-named sibling is what is on offer.
    expect(retryOffer({ state: "outcome_unknown", fidelity: "authored", hasSubmitted: true }))
      .toEqual({ mode: "resend-may-duplicate", duplicatePossible: true });
    // And on a reconstructed send, where `submitted_key` is never written at all — so its NULL proves
    // nothing, and reading it as a proof would be the permissive failure on the one path that has no bytes.
    expect(retryOffer({ state: "outcome_unknown", fidelity: "reconstructed", hasSubmitted: false }))
      .toEqual({ mode: "resend-may-duplicate", duplicatePossible: true });
  });

  it("offers nothing at all where there is nothing to retry, and says which of the three reasons it is", () => {
    const facts = { fidelity: "authored", hasSubmitted: false };
    expect(retryOffer({ state: "held", ...facts })).toEqual({ mode: null, why: "not_yet_attempted" });
    expect(retryOffer({ state: "awaiting", ...facts })).toEqual({ mode: null, why: "not_yet_attempted" });
    expect(retryOffer({ state: "cancelled", ...facts })).toEqual({ mode: null, why: "decided" });
    expect(retryOffer({ state: "withheld", ...facts })).toEqual({ mode: null, why: "decided" });
    // Provider observation can only ever *disprove* non-acceptance, and it has.
    expect(retryOffer({ state: "handed_over", ...facts, hasSubmitted: true }))
      .toEqual({ mode: null, why: "acceptance_observed" });
  });

  it("fails closed on a state it does not classify", () => {
    // `outcome_unknown` is `applyOutcome`'s default for anything unrecognised, so the unprovable population is
    // the one that grows and a denylist would guard only the spellings its author thought of. A state string
    // this code has never seen offers nothing rather than falling through to either act.
    expect(retryOffer({ state: "quantum_superposition", fidelity: "authored", hasSubmitted: false }))
      .toEqual({ mode: null, why: "state_not_classified" });
  });

  it("agrees with the SQL that gates the act, over every state crossed with both columns", async () => {
    /*
     * Two expressions of one rule is a correspondence risk, and this is the answer to it rather than care.
     *
     * The TS decides what is *offered* and the SQL decides what is *done*, conditionally, so a disagreement
     * would either offer an act the database refuses — visible, annoying — or perform one the offer says is
     * unsafe, which is a duplicate delivery. Every combination is written to a real row and run through the
     * real predicate.
     */
    const at = new Date(T0).toISOString();
    const combinations: Array<{ id: string; facts: RetryFacts }> = [];
    for (const state of EVERY_STATE) {
      for (const fidelity of ["authored", "reconstructed"]) {
        for (const hasSubmitted of [true, false]) {
          const id = `snd_${state}_${fidelity}_${hasSubmitted ? "key" : "nokey"}`;
          combinations.push({ id, facts: { state, fidelity, hasSubmitted } });
          await testEnv.CATALOG.prepare(
            `INSERT INTO send_manifests
               (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to, subject, rfc_message_id,
                fidelity, body_typed_key, body_typed_sha256, body_normalized_key, body_normalized_sha256,
                submitted_key, sealed_at, release_at, state, state_at, attempts, policy_outcome)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'allow')`,
          ).bind(id, ORG, MAILBOX, ADMIN, ADDRESS, JSON.stringify(["c@example.net"]), "s", `${id}@x`,
            fidelity, "k", "h", "k", "h", hasSubmitted ? "sub" : null, at, at, state, at).run();
        }
      }
    }

    const { results } = await testEnv.CATALOG.prepare(
      `SELECT id FROM send_manifests WHERE org_id = ? AND ${provenNonAcceptanceSql()}`,
    ).bind(ORG, ...PROVEN_STATES).all<{ id: string }>();
    const bySql = new Set(results.map((row) => row.id));
    const byTs = new Set(
      combinations.filter(({ facts }) => retryOffer(facts).mode === "retry-effect").map(({ id }) => id),
    );

    expect([...bySql].sort()).toEqual([...byTs].sort());
    // Non-vacuous by construction: both sides must be non-empty and neither may be everything.
    expect(bySql.size).toBeGreaterThan(0);
    expect(bySql.size).toBeLessThan(combinations.length);
  });
});

/* ============================================================ the two acts ======================== */

/** A manifest sealed through the real path and then driven to a terminal state by a stub transport. */
async function sentInto(outcome: SubmitOutcome, ctx: Ctx): Promise<string> {
  const { sealManifest } = await import("../src/outbound/manifest.ts");
  const { dispatchOne } = await import("../src/outbound/dispatch.ts");
  const sealed = await sealManifest(testEnv, ctx, ORG, {
    mailboxId: MAILBOX, authorUserId: ADMIN, to: ["customer@example.net"],
    subject: "Your invoice", bodyTyped: "Attached.", fidelity: "authored",
  });
  await dispatchOne(testEnv, atTime(ctx.now() + 1000), ORG, sealed.id, fakeTransport(outcome));
  return sealed.id;
}

describe("the two acts, and the two names (#53)", () => {
  it("retry-effect dispatches the same manifest under the same key, and records the proof", async () => {
    const ctx = atTime(T0);
    const id = await sentInto({ kind: "refused", reason: "boundary said no", retryable: true }, ctx);
    expect((await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
      .bind(id).first<{ state: string }>())?.state).toBe("refused");

    const transport = fakeTransport({ kind: "handed_over", transportMessageId: "tm_1" });
    const result = await retryEffect(testEnv, atTime(T0 + 5000), ORG, ADMIN, id, transport);

    expect(result.mode).toBe("retry-effect");
    // **The same id.** No second effect key exists, so the outbox holds one message rather than two.
    expect(result.manifestId).toBe(id);
    expect(await manifestIds()).toEqual([id]);
    expect(result.dispatch?.state).toBe("handed_over");

    const entry = await testEnv.CATALOG.prepare(
      "SELECT actor_user_id, subject, detail FROM audit_entries WHERE org_id = ? AND action = 'send.retried'",
    ).bind(ORG).first<{ actor_user_id: string; subject: string; detail: string }>();
    expect(entry?.actor_user_id).toBe(ADMIN);
    expect(entry?.subject).toBe(id);
    expect(JSON.parse(entry!.detail)).toMatchObject({ proof: "refused", duplicatePossible: false });
  });

  it("refuses retry-effect where non-acceptance is not proven, and names the other mode and its cost",
    async () => {
      const ctx = atTime(T0);
      const id = await sentInto({ kind: "outcome_unknown", reason: "the isolate died" }, ctx);
      // The bytes were rendered and stored before the submit, so `submitted_key` is set and the proof fails.
      expect((await testEnv.CATALOG.prepare(
        "SELECT submitted_key IS NOT NULL AS k FROM send_manifests WHERE id = ?",
      ).bind(id).first<{ k: number }>())?.k).toBe(1);

      await expect(retryEffect(testEnv, atTime(T0 + 5000), ORG, ADMIN, id))
        .rejects.toThrow(/E_RETRY_NOT_PROVEN/);
      // Absent, not failing, is about the *offer*; the act itself refuses and says what is available instead.
      await expect(retryEffect(testEnv, atTime(T0 + 5000), ORG, ADMIN, id))
        .rejects.toThrow(/resend-may-duplicate/);
      expect(await manifestIds()).toEqual([id]);
    });

  it("does not claim a reconstructed send has a submitted_key it does not have", async () => {
    /*
     * `E_RETRY_NOT_PROVEN` had two arms — `offer.mode === null` and everything else — so a `reconstructed`
     * send inherited the *authored* sentence and was told **"this send has one"** about a column reading NULL.
     * An agent reading that error is sent to check the wrong thing, which is worse than a vague reason: a
     * false explanation ends the question a blank one would have started.
     */
    const at = new Date(T0).toISOString();
    const id = "snd_reconstructed_unknown";
    await testEnv.CATALOG.prepare(
      `INSERT INTO send_manifests
         (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to, subject, rfc_message_id,
          fidelity, body_typed_key, body_typed_sha256, body_normalized_key, body_normalized_sha256,
          submitted_key, sealed_at, release_at, state, state_at, attempts, policy_outcome)
       VALUES (?,?,?,?,?,?,?,?,'reconstructed',?,?,?,?,NULL,?,?,'outcome_unknown',?,1,'allow')`,
    ).bind(id, ORG, MAILBOX, ADMIN, ADDRESS, JSON.stringify(["c@example.net"]), "s", `${id}@x`,
      "k", "h", "k", "h", at, at, at).run();
    // The row really is the shape the arm describes: reconstructed, unknown, and no key.
    expect(await testEnv.CATALOG.prepare(
      "SELECT fidelity, submitted_key FROM send_manifests WHERE id = ?",
    ).bind(id).first<{ fidelity: string; submitted_key: string | null }>())
      .toEqual({ fidelity: "reconstructed", submitted_key: null });

    const failure = await retryEffect(testEnv, atTime(T0 + 5000), ORG, ADMIN, id)
      .then(() => null, (error: Error) => error.message);

    expect(failure).toMatch(/E_RETRY_NOT_PROVEN/);
    expect(failure).toMatch(/reconstructed path never writes submitted_key/);
    // The sentence that was false here. Asserted as an absence, because that is the defect.
    expect(failure).not.toMatch(/this send has one/);
    // The authored case still says the true thing, so the fix narrowed the arm rather than replacing it.
    const authored = await sentInto({ kind: "outcome_unknown", reason: "the isolate died" }, atTime(T0));
    const authoredFailure = await retryEffect(testEnv, atTime(T0 + 5000), ORG, ADMIN, authored)
      .then(() => null, (error: Error) => error.message);
    expect(authoredFailure).toMatch(/this send has one/);
  });

  it("resend-may-duplicate seals a new key, links it to the old send, and names the person who risked it",
    async () => {
      const ctx = atTime(T0);
      const id = await sentInto({ kind: "outcome_unknown", reason: "the isolate died" }, ctx);

      const result = await resendMayDuplicate(testEnv, atTime(T0 + 5000), ORG, {
        userId: OTHER, acceptDuplicateRisk: true, reason: "the customer says nothing arrived",
      }, id);

      expect(result.mode).toBe("resend-may-duplicate");
      // A **new** key, deliberately: the old one may already have been handed over, so reusing it would say
      // these are the same effect — the one thing nobody can say about this case.
      expect(result.sealedAs).not.toBe(id);
      expect(await manifestIds()).toHaveLength(2);

      const fresh = await testEnv.CATALOG.prepare(
        "SELECT resend_of, state, envelope_from, subject FROM send_manifests WHERE id = ?",
      ).bind(result.sealedAs!).first<{ resend_of: string; state: string; envelope_from: string; subject: string }>();
      expect(fresh?.resend_of).toBe(id);
      expect(fresh?.envelope_from).toBe(ADDRESS);
      expect(fresh?.subject).toBe("Your invoice");
      // It enters the hold window rather than dispatching, because this is the one act that may produce a
      // second copy of a message somebody has already read.
      expect(fresh?.state).toBe("held");

      const entry = await testEnv.CATALOG.prepare(
        "SELECT actor_user_id, subject, detail FROM audit_entries WHERE org_id = ? AND action = 'send.resent'",
      ).bind(ORG).first<{ actor_user_id: string; subject: string; detail: string }>();
      // The **person**, not the author: `send.sealed` beside it already names the author, and on a Butler's
      // message that is the `btl_`.
      expect(entry?.actor_user_id).toBe(OTHER);
      expect(JSON.parse(entry!.detail)).toMatchObject({
        resendOf: id, duplicatePossible: true, reason: "the customer says nothing arrived",
      });
    });

  it("refuses a resend that did not accept the duplicate risk, or gave no reason", async () => {
    const ctx = atTime(T0);
    const id = await sentInto({ kind: "outcome_unknown", reason: "the isolate died" }, ctx);

    await expect(resendMayDuplicate(testEnv, atTime(T0 + 5000), ORG, {
      userId: ADMIN, acceptDuplicateRisk: false, reason: "because",
    }, id)).rejects.toThrow(/E_DUPLICATE_RISK_NOT_ACCEPTED/);
    await expect(resendMayDuplicate(testEnv, atTime(T0 + 5000), ORG, {
      userId: ADMIN, acceptDuplicateRisk: true, reason: "   ",
    }, id)).rejects.toThrow(/E_RESEND_REASON_REQUIRED/);
    // Neither refusal sealed anything: the acknowledgement is a precondition, not a warning.
    expect(await manifestIds()).toEqual([id]);
  });

  it("refuses resend-may-duplicate where the safe act is available, rather than letting a caller pick the "
    + "riskier one", async () => {
    const ctx = atTime(T0);
    const id = await sentInto({ kind: "refused", reason: "boundary said no", retryable: true }, ctx);
    await expect(resendMayDuplicate(testEnv, atTime(T0 + 5000), ORG, {
      userId: ADMIN, acceptDuplicateRisk: true, reason: "I would rather have a new key",
    }, id)).rejects.toThrow(/E_RESEND_NOT_OFFERED/);
    expect(await manifestIds()).toEqual([id]);
  });
});

/* ============================================================ inspect and mail content ============ */

/**
 * `inspect` discloses the run's recorded input, and that input **is mail content** (#53, #63, §7).
 *
 * The route is `org.admin`, which is a relation on the *organization*: it appears nowhere in
 * `authz-read.ts`'s table of who may read a mailbox, and §7 is explicit that no relation implies
 * `message.read`. The trigger facts carry `subject`, `from`, `return_path` and `parse_error`, so before this
 * gate existed an administrator holding nothing on any mailbox could read the subject line and the sender of
 * every message any Butler ever processed — leaving no record, which is the pair #63 exists to prevent.
 *
 * `OTHER` is that administrator throughout: `org.admin` on the organization, nothing on `mbx_replay`.
 */
describe("inspect gates the run's recorded input on mailbox authority (#53, #63)", () => {
  /** The fields `FACT_DISCLOSURE` classifies as the sender's words. */
  const CONTENT_FACTS = ["subject", "from", "return_path", "parse_error"];

  async function aRunToInspect(): Promise<{ runId: string; delivery: Delivery }> {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
    await grantTo(ctx, ids.butlerId, "send.propose");
    await grantTo(ctx, ids.butlerId, "mailbox.content.read");
    const delivery = await aDelivery(ctx, "Confidential: redundancy list");
    const first = await run(ids, delivery);
    return { runId: first.runId, delivery };
  }

  async function liveGrant(userId: string, scope: "metadata" | "content"): Promise<string> {
    const ctx = atTime(T0 + 100);
    const at = new Date(ctx.now()).toISOString();
    const id = ctx.id("sgr");
    await testEnv.CATALOG.prepare(
      `INSERT INTO supervised_grants
         (id, org_id, subject_id, mailbox_id, scope, matter_id, requested_at, expires_at, granted_at)
       VALUES (?,?,?,?,?,NULL,?,?,?)`,
    ).bind(id, ORG, userId, MAILBOX, scope, at, new Date(ctx.now() + 3_600_000).toISOString(), at).run();
    return id;
  }

  it("withholds the subject line and the sender from an administrator with no authority on the mailbox, and "
    + "says so", async () => {
    const { runId, delivery } = await aRunToInspect();

    const seen = await inspectRun(testEnv, atTime(T0 + 300), AS_OTHER, runId);
    const facts = seen!.triggerFacts as Record<string, unknown>;

    // The disclosure this test exists for. Asserted against the literal strings the fixture put on the wire,
    // so a redaction that merely renamed a field would not pass.
    expect(facts.subject).toBeNull();
    expect(facts.from).toBeNull();
    expect(facts.return_path).toBeNull();
    expect(JSON.stringify(seen)).not.toContain("Confidential: redundancy list");
    expect(JSON.stringify(seen)).not.toContain("customer@example.net");

    // A hole a reader cannot see is a hole a reader reads past, so the answer names it and says what to ask
    // for. `org.admin` is called out because it is the authority the caller *does* hold.
    expect(seen?.triggerFactsRedacted?.keys.slice().sort()).toEqual(CONTENT_FACTS.slice().sort());
    expect(seen?.triggerFactsRedacted?.why).toMatch(/mailbox\.metadata\.read/);
    expect(seen?.triggerFactsRedacted?.why).toMatch(/org\.admin/);

    // And `inspect` still does its job: every id, state and token is intact, so an auditor with no mailbox
    // authority can still see which program ran, over which delivery, and what it did.
    expect(facts.message_id).toBe(delivery.messageId);
    expect(facts.case_id).toBe(delivery.caseId);
    expect(facts.mailbox_id).toBe(MAILBOX);
    expect(facts.mailbox_address).toBe(ADDRESS);
    expect(seen?.program?.nodes.map((node) => node.id)).toEqual(["reply", "propose"]);
    expect(seen?.effects.length).toBeGreaterThan(0);
    expect(seen?.reRun).toEqual({ available: true, why: null });
  });

  it("discloses them to a standing reader — either relation — and records nothing for it", async () => {
    const { runId } = await aRunToInspect();
    // Granted before the count is taken, because `grant` records itself and this test is about what
    // **inspecting** writes.
    await grantTo(atTime(T0 + 200), OTHER, "mailbox.metadata.read");
    const before = await countOf("SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ?", ORG);

    // `mailbox.content.read`, which the `beforeEach` granted ADMIN. The stronger of the two authorities.
    const asContent = await inspectRun(testEnv, atTime(T0 + 300), AS_ADMIN, runId);
    expect((asContent!.triggerFacts as { subject: string }).subject).toBe("Confidential: redundancy list");
    expect((asContent!.triggerFacts as { from: string }).from).toBe("customer@example.net");
    expect(asContent?.triggerFactsRedacted).toBeNull();

    // `mailbox.metadata.read` alone, which is the relation that exists for **nothing but** subject lines and
    // sender addresses. Refusing it here would have made that relation grant nothing.
    const asMetadata = await inspectRun(testEnv, atTime(T0 + 300), AS_OTHER, runId);
    expect((asMetadata!.triggerFacts as { subject: string }).subject).toBe("Confidential: redundancy list");
    expect(asMetadata?.triggerFactsRedacted).toBeNull();

    // Neither read is recorded, and that is the settled rule for metadata rather than an exception carved
    // here: `queueFor` gates on this same function and records only its *supervised* arm — the standing arm
    // returns having appended nothing — and an entry per glance at a screen is the per-row frequency
    // `audit-and-log-retention.md` sizes against. The grant arm of this route is the test below.
    expect(await countOf("SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ?", ORG)).toBe(before);
  });

  it("lets a live supervised grant open it, and records supervised.opened before answering", async () => {
    const { runId, delivery } = await aRunToInspect();
    const grantId = await liveGrant(OTHER, "metadata");

    const seen = await inspectRun(testEnv, atTime(T0 + 300), AS_OTHER, runId);
    expect((seen!.triggerFacts as { subject: string }).subject).toBe("Confidential: redundancy list");
    expect(seen?.triggerFactsRedacted).toBeNull();

    // The entry #63 makes structural: the grant is the subject, so the trail filters by access, and `opened`
    // names the one message that was disclosed. Unlike a listing, this read knows that before it answers.
    const entry = await testEnv.CATALOG.prepare(
      `SELECT subject, detail FROM audit_entries
        WHERE org_id = ? AND action = 'supervised.opened'`,
    ).bind(ORG).first<{ subject: string; detail: string }>();
    expect(entry?.subject).toBe(grantId);
    expect(JSON.parse(entry!.detail)).toMatchObject({
      grantId, mailboxId: MAILBOX, opened: delivery.messageId,
    });
  });

  it("withholds them once the grant has expired, because authority is re-read per call", async () => {
    const { runId } = await aRunToInspect();
    await liveGrant(OTHER, "content");

    // One hour and a second past the grant's deadline. Nothing is cached, so the deadline is a hard stop with
    // no revocation mechanism behind it — the same property `supervised-read.test.ts` proves on the body read.
    const seen = await inspectRun(testEnv, atTime(T0 + 100 + 3_600_001), AS_OTHER, runId);
    expect((seen!.triggerFacts as { subject: unknown }).subject).toBeNull();
    expect(seen?.triggerFactsRedacted?.keys.slice().sort()).toEqual(CONTENT_FACTS.slice().sort());
  });

  it("withholds an unclassified fact and every content fact when the recorded input names no mailbox", async () => {
    const { runId } = await aRunToInspect();
    // A fact set of another shape, which is what a future trigger event will store: no `mailbox_id` to
    // authorize against, and a field this Node's classification has never heard of.
    await testEnv.CATALOG.prepare("UPDATE butler_runs SET trigger_facts = ? WHERE org_id = ? AND id = ?")
      .bind(JSON.stringify({
        message_id: "msg_future", subject: "Confidential: redundancy list", ticket_body: "secret",
      }), ORG, runId).run();

    // ADMIN holds `mailbox.content.read` on the mailbox and it does not help: there is no mailbox on the
    // facts, so there is nothing to hold it on. Fails closed rather than guessing at a mailbox.
    const seen = await inspectRun(testEnv, atTime(T0 + 300), AS_ADMIN, runId);
    const facts = seen!.triggerFacts as Record<string, unknown>;
    expect(facts.message_id).toBe("msg_future");
    expect(facts.subject).toBeNull();
    // The unknown key, redacted because the map constrains what can be *written* and not what a stored blob
    // holds. An allowlist that let unknown keys through would have shipped the next fact set in the clear.
    expect(facts.ticket_body).toBeNull();
    expect(seen?.triggerFactsRedacted?.keys.slice().sort()).toEqual(["subject", "ticket_body"]);
    expect(seen?.triggerFactsRedacted?.why).toMatch(/names no mailbox/);
  });

  it("keeps the raw blob off the run row itself, so no route can serialize what it does not carry", async () => {
    const { runId } = await aRunToInspect();

    /*
     * The **total** half of the fix, and the one the per-mailbox gate above rests on.
     *
     * `RunRow` is serialized whole into three `org.admin` responses — `GET /api/butler-runs`,
     * `GET /api/butler-runs/:id` and `inspect` — so a careful gate on the *parsed* facts is worth nothing
     * while the raw column sits beside it in the same object. Asserted on the row rather than on the three
     * responses because that is the property: a fourth route cannot leak a column its row does not carry, and
     * a response-shaped test would have to be written a fourth time to keep saying so.
     */
    for (const row of [(await runRow(testEnv, ORG, runId))!, ...await recentRuns(testEnv, ORG, 25)]) {
      expect(Object.hasOwn(row, "trigger_facts")).toBe(false);
      expect(JSON.stringify(row)).not.toContain("Confidential: redundancy list");
    }
    // And the one reader still returns it, so this is an absence from the row rather than a lost column.
    expect(await triggerFactsOf(testEnv, ORG, runId)).toContain("Confidential: redundancy list");
  });

  it("classifies every delivery fact, so a new one cannot arrive unclassified", () => {
    /*
     * The totality is a compile-time property — `{ [K in keyof DeliveryFacts]: … }` — and this is the runtime
     * half of it: that the map's keys are exactly the fact set's, so a field cannot be classified in the map
     * and absent from the facts either. `deliveryFacts` is the producer, so its own output is the corpus.
     */
    expect(Object.keys(FACT_DISCLOSURE).slice().sort()).toEqual([
      "case_id", "conversation_id", "from", "mailbox_address", "mailbox_id", "message_id", "parse_error",
      "received_at", "return_path", "subject",
    ]);
    expect(Object.keys(FACT_DISCLOSURE).filter((key) => FACT_DISCLOSURE[key as "subject"] === "content")
      .sort()).toEqual(CONTENT_FACTS.slice().sort());

    // And the redactor keeps the operational half whole while nulling the rest, listing what it nulled.
    const { facts, redacted } = redactFacts({
      message_id: "msg_1", mailbox_id: MAILBOX, subject: "s", from: "f@x.test", surprise: "who knows",
    });
    expect(facts).toEqual({
      message_id: "msg_1", mailbox_id: MAILBOX, subject: null, from: null, surprise: null,
    });
    expect(redacted.slice().sort()).toEqual(["from", "subject", "surprise"]);
  });
});

/* ============================================================ a decided incumbent ================= */

describe("a replay whose send was decided against says so, rather than reporting ok (#53)", () => {
  it("refuses with replay_send_decided when the incumbent is withheld, even after the policy is withdrawn",
    async () => {
      const ctx = atTime(T0);
      const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
      await grantTo(ctx, ids.butlerId, "send.propose");
      await grantTo(ctx, ids.butlerId, "mailbox.content.read");
      const delivery = await aDelivery(ctx);

      // A policy denies every send from this mailbox, so the original run's send is sealed `withheld`.
      const policy = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
        name: "no-sending", outcome: "deny", conditions: { mailboxId: MAILBOX },
      });
      await publishPolicy(testEnv, atTime(T0 + 100), ORG, ADMIN, policy.policyId);

      const first = await run(ids, delivery, T0 + 1000);
      const [original] = await manifestIds();
      expect((await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
        .bind(original).first<{ state: string }>())?.state).toBe("withheld");

      // The operator does the obvious thing: decides the policy was wrong, withdraws it, and re-runs.
      for (const table of ["policy_stages", "policy_versions", "policies"]) {
        await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
      }

      const replayed = await replay(ids, first.runId);
      const propose = (await runEffects(testEnv, ORG, replayed.runId))
        .find((effect) => effect.node_type === "mail.send.propose");

      // Before this fix the row read `ok` / `replay_identical_content`: a no-op reporting success, on the
      // single most obvious use of `re-run`.
      expect(propose?.outcome).toBe("refused");
      expect(propose?.reason).toBe("replay_send_decided");
      // Still the incumbent's key, and still nothing minted — the fix does not open a duplicate path. Two
      // replays of one source run would each find only the original, so re-sealing here would be two copies.
      expect(propose?.subject).toBe(original);
      expect(await manifestIds()).toEqual([original]);
      expect((await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
        .bind(original).first<{ state: string }>())?.state).toBe("withheld");
    });

  it("refuses the same way when a person cancelled the incumbent, which is the other half of the pair",
    async () => {
      const ctx = atTime(T0);
      const ids = await published(ctx, "acknowledge", ACKNOWLEDGE, "reply");
      await grantTo(ctx, ids.butlerId, "send.propose");
      await grantTo(ctx, ids.butlerId, "mailbox.content.read");
      const delivery = await aDelivery(ctx);

      const first = await run(ids, delivery);
      const [original] = await manifestIds();
      // The state `cancelSend` leaves behind. Driven here rather than through it because what is under test is
      // the replay's reading of the state, and `cancelSend`'s own gate is `outbox` territory.
      await testEnv.CATALOG.prepare(
        "UPDATE send_manifests SET state = 'cancelled', state_at = ? WHERE org_id = ? AND id = ?",
      ).bind(new Date(T0 + 2000).toISOString(), ORG, original).run();

      const replayed = await replay(ids, first.runId);
      const propose = (await runEffects(testEnv, ORG, replayed.runId))
        .find((effect) => effect.node_type === "mail.send.propose");

      /*
       * `withheld` is a policy's decision and `cancelled` is a person's, and `INCUMBENT_STANDS` is the only
       * thing that makes them answer alike. The unit test below pins the map; this drives the second state
       * through the engine, so the pair is covered by an integration rather than by the map twice.
       */
      expect(propose?.outcome).toBe("refused");
      expect(propose?.reason).toBe("replay_send_decided");
      expect(propose?.subject).toBe(original);
      expect(await manifestIds()).toEqual([original]);
      expect((await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
        .bind(original).first<{ state: string }>())?.state).toBe("cancelled");
    });

  it("classifies every send state, and an unrecognised one stands", () => {
    /*
     * The total map, checked the way `retryOffer`'s is: the two states that do not stand are exactly the pair
     * `OFFER_FOR` answers `decided` on, and an unclassified string **stands** — which reuses the key and
     * performs nothing, rather than inventing a governance decision nobody made.
     */
    expect(EVERY_STATE.filter((state) => !incumbentStands(state)).slice().sort())
      .toEqual(["cancelled", "withheld"]);
    expect(EVERY_STATE.filter((state) => {
      const offer = retryOffer({ state, fidelity: "authored", hasSubmitted: false });
      return offer.mode === null && offer.why === "decided";
    }).slice().sort()).toEqual(["cancelled", "withheld"]);
    expect(incumbentStands("quantum_superposition")).toBe(true);
  });
});
