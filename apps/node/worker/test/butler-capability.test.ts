import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { utf8 } from "@mailda/evidence";
import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { grant, revoke } from "../src/access.ts";
import { caseMailboxHeldBy, effectiveOnMailbox, readEntity } from "../src/butler/authority.ts";
import { ceilingOf } from "../src/butler/ceiling.ts";
import { interpret, type RunSteps } from "../src/butler/interpret.ts";
import type { ButlerPrincipal } from "../src/butler/principal.ts";
import { deliveryFacts } from "../src/butler/trigger.ts";
import { createButlerDraft, publishButler } from "../src/butlers.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { putEvidence } from "../src/evidence-store.ts";

/**
 * The pinned capability ceiling and the sponsor term, at runtime (#51, §7, blueprint:702).
 *
 *     effective(step) = pinned ceiling ∩ live tuples of the Butler ∩ live tuples of the sponsor
 *
 * `packages/butler-ast/test/capability.test.ts` proves what publication checks. This proves the other three
 * things, which are the ones a checker cannot: that the ceiling **binds** at runtime even where a tuple
 * would allow the act, that the sponsor's authority caps the Butler's, and that neither half can be widened
 * after publication by any route the database offers.
 *
 * ## Every test here writes its ceiling by hand
 *
 * `test/butler-capabilities.ts` derives a ceiling from a graph, which is right for the forty tests whose
 * subject is not the ceiling and wrong for every test in this file: a ceiling computed from the program
 * under test can never disagree with it, and disagreement is the whole subject.
 */

const testEnv = env as unknown as Env;
const ORG = "org_bcap";
const MAILBOX = "mbx_bcap";
const ADDRESS = "support@bcap.example";
const OTHER = "mbx_bcap_other";
const OTHER_ADDRESS = "invoices@bcap.example";
const ADMIN = "usr_bcap_admin";
/** A second administrator, who publishes the Butlers whose sponsor is not `ADMIN`. */
const OTHER_ADMIN = "usr_bcap_admin2";
const TEAM = "tm_bcap_support";

const T0 = 2_500_000_000_000;

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (prefix) => system.id(prefix), random: (n) => system.random(n) };
}

function inlineSteps(): RunSteps {
  return {
    do: async <T>(_name: string, body: () => Promise<T>): Promise<T> => await body(),
    sleep: async (): Promise<void> => undefined,
    waitForEvent: async (): Promise<unknown> => ({ released: true }),
  };
}

interface Delivery { messageId: string; conversationId: string; caseId: string }

/** A real delivery into `MAILBOX`, whose subject is settable so a `draft` can be aimed by content. */
async function aDelivery(ctx: Ctx, subject = "Invoice 4021 query"): Promise<Delivery> {
  const at = new Date(ctx.now()).toISOString();
  const raw = utf8(`Message-ID: <${ctx.id("x")}@x.example>\r\nSubject: ${subject}\r\n\r\nhello\r\n`);
  const stored = await putEvidence(testEnv, `${ORG}/raw/${ctx.id("k")}.eml`, raw);
  const receiptId = ctx.id("ir");
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, envelope_from, envelope_to, raw_bytes, accepted_at,
                                   blob_key, blob_sha256, provider_event_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(receiptId, ORG, "customer@example.net", ADDRESS, raw.byteLength, at,
    stored.blobKey, stored.plaintextSha256, ctx.id("pe")).run();

  const conversationId = await conversationForDelivery(testEnv, ctx, ORG, `<r-${ctx.id("r")}@x.example>`);
  const messageId = ctx.id("msg");
  await testEnv.CATALOG.prepare(
    `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
                           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
                           created_at, conversation_id, parse_error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).bind(messageId, ORG, "2026-08", stored.blobKey, stored.plaintextSha256, raw.byteLength,
    `<in-${messageId}@x.example>`, ctx.id("thr"), subject, "customer@example.net", at, at, receiptId, at,
    conversationId).run();

  const caseId = ctx.id("cas");
  await testEnv.CATALOG.prepare(
    `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at,
                        created_at)
     VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
  ).bind(caseId, ORG, conversationId, MAILBOX, at, at).run();

  return { messageId, conversationId, caseId };
}

/** A `draft` aimed by the delivery's subject line, which is how a ceiling is made to disagree with a tuple. */
const AIMED_DRAFT = [{
  id: "reply", type: "draft", mailboxId: "${event.subject}",
  subject: "Re:", body: "Thanks.", as: "ack", next: null,
}];

/** The same graph aimed at the mailbox the trigger names. */
const PLAIN_DRAFT = [{
  id: "reply", type: "draft", mailboxId: "${event.mailbox_id}",
  subject: "Re:", body: "Thanks.", as: "ack", next: null,
}];

async function published(
  ctx: Ctx,
  name: string,
  nodes: unknown[],
  capabilities: unknown[],
  publisher = ADMIN,
): Promise<{ butlerId: string; versionId: string }> {
  const source = JSON.stringify({
    apiVersion: "mailda/v1", kind: "Butler",
    metadata: { name, owner: "team:support" },
    capabilities,
    trigger: { event: "mail.received", mailbox: ADDRESS },
    entry: (nodes[0] as { id: string }).id,
    nodes,
  });
  const draft = await createButlerDraft(testEnv, ctx, ORG, publisher, { name, source });
  const version = await publishButler(testEnv, ctx, ORG, publisher, draft.butlerId);
  return { butlerId: draft.butlerId, versionId: version.versionId };
}

const sends = (address = ADDRESS): unknown[] => [
  { action: "send.propose", resource: `mailbox:${address}` },
];

async function run(
  ids: { butlerId: string; versionId: string },
  delivery: Delivery,
  now = T0 + 1000,
): ReturnType<typeof interpret> {
  const facts = await deliveryFacts(testEnv, ORG, delivery.messageId);
  if (facts === null) throw new Error("no delivery facts");
  return await interpret(
    testEnv, atTime(now),
    {
      orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
      trigger: { event: "mail.received", key: delivery.messageId, facts },
    },
    inlineSteps(),
    `${ids.versionId}-${delivery.messageId}`,
  );
}

/** What one run's effects came to, as `[outcome, reason]` pairs. */
function outcomes(result: Awaited<ReturnType<typeof interpret>>): Array<[string, string | null]> {
  return result.effects.map((effect) => [effect.outcome, effect.reason]);
}

async function grantOn(
  ctx: Ctx, subject: string, relation: Parameters<typeof grant>[4]["relation"], mailbox = MAILBOX,
): Promise<void> {
  await grant(testEnv, ctx, ORG, ADMIN, { subjectId: subject, relation, objectId: mailbox });
}

async function revokeOn(
  ctx: Ctx, subject: string, relation: Parameters<typeof revoke>[4]["relation"], mailbox = MAILBOX,
): Promise<void> {
  await revoke(testEnv, ctx, ORG, ADMIN, { subjectId: subject, relation, objectId: mailbox });
}

/** A principal with a hand-written ceiling, for calling one authority function directly. */
function principal(
  ids: { butlerId: string; versionId: string },
  addresses: readonly string[],
  relations: readonly string[] = ["send.propose"],
  sponsor = ADMIN,
): ButlerPrincipal {
  return {
    orgId: ORG, butlerId: ids.butlerId, versionId: ids.versionId, name: "probe",
    ceiling: ceilingOf(
      {
        capabilities: relations.flatMap((action) =>
          addresses.map((address) => ({ action, resource: `mailbox:${address}` }))),
      } as never,
      sponsor,
    ),
  };
}

beforeEach(async () => {
  for (const table of [
    "butler_run_effects", "butler_runs", "butler_versions", "butlers", "cases", "conversations", "messages",
    "ingress_receipts", "relationship_tuples", "team_members", "mailboxes", "addresses", "drafts",
    "send_manifests", "send_recipients", "send_counters", "audit_entries", "log_entries", "outbox", "users",
  ]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = atTime(T0);
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    ...[[MAILBOX, "Support"], [OTHER, "Invoices"]].map(([id, name]) =>
      testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
        .bind(id, ORG, name, at)),
    ...[[ADDRESS, MAILBOX], [OTHER_ADDRESS, OTHER]].map(([address, mailbox]) =>
      testEnv.CATALOG.prepare(
        "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("addr"), ORG, address, mailbox, at)),
    ...[ADMIN, OTHER_ADMIN].map((user) =>
      testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
        .bind(user, ORG, `${user}@local.invalid`, at)),
    ...[ADMIN, OTHER_ADMIN].map((user) => testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'org.admin','organization',?,?)`,
    ).bind(ctx.id("rt"), ORG, user, ORG, at)),
  ]);
});

/* ------------------------------------------------------- the ceiling binds at runtime -------------- */

describe("a Butler cannot exceed its pinned ceiling", () => {
  it("refuses a mailbox the ceiling never named, even when a tuple grants it", async () => {
    /*
     * The whole point of the term, in one run. The Butler holds `send.propose` on **both** mailboxes — an
     * administrator granted it, which is a thing an administrator may do at any time — and the version it
     * published declares only one. The undeclared one is refused, and it is refused for a reason whose
     * remedy is a republish rather than a grant, because no grant can reach it.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "aimed", AIMED_DRAFT, sends());
    await grantOn(ctx, ids.butlerId, "send.propose", MAILBOX);
    await grantOn(ctx, ids.butlerId, "send.propose", OTHER);
    await grantOn(ctx, ADMIN, "send.propose", MAILBOX);
    await grantOn(ctx, ADMIN, "send.propose", OTHER);

    const refused = await run(ids, await aDelivery(ctx, OTHER));
    expect(outcomes(refused)).toEqual([["refused", "capability_not_declared"]]);
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())
      .toEqual({ n: 0 });

    /*
     * Non-vacuity, and it is the whole of it: **the same Butler, the same tuples, the same delivery shape,
     * one ceiling entry different.** Nothing else moves. A build with the ceiling term deleted passes the
     * assertion above and this one; a build where the ceiling refused everything passes the first and fails
     * this.
     */
    const wider = await published(ctx, "aimed-wider", AIMED_DRAFT, [
      ...sends(), ...sends(OTHER_ADDRESS),
    ]);
    await grantOn(ctx, wider.butlerId, "send.propose", OTHER);
    const allowed = await run(wider, await aDelivery(ctx, OTHER));
    expect(outcomes(allowed)).toEqual([["ok", null]]);
  });

  it("bounds a lookup by the ceiling as well, in the statement that reads the row", async () => {
    // The folded shape, where the mailbox is the query's output rather than its input. §5C keeps "absent"
    // and "you may not" identical here, so what a wrong ceiling produces is `not_readable` — the same answer
    // as a message that does not exist, which is deliberate and is why the three reasons live on the nodes
    // that name their own mailbox.
    const ctx = atTime(T0);
    const ids = await published(ctx, "reader", PLAIN_DRAFT, sends());
    const delivery = await aDelivery(ctx);
    await grantOn(ctx, ids.butlerId, "mailbox.content.read");
    await grantOn(ctx, ADMIN, "mailbox.content.read");

    const outside = principal(ids, [OTHER_ADDRESS], ["mailbox.content.read"]);
    expect(await readEntity(testEnv, outside, "message", delivery.messageId)).toBeNull();

    // Non-vacuity: the same tuples, the same message, the ceiling moved to the mailbox it is actually in.
    const inside = principal(ids, [ADDRESS], ["mailbox.content.read"]);
    expect((await readEntity(testEnv, inside, "message", delivery.messageId))?.["id"])
      .toBe(delivery.messageId);
  });
});

/* ------------------------------------------------------- the sponsor term ------------------------- */

describe("a Butler cannot exceed its sponsor's authority", () => {
  it("refuses when the sponsor holds nothing on the mailbox, however well granted the Butler is", async () => {
    const ctx = atTime(T0);
    // Published by OTHER_ADMIN, so the sponsor is somebody who has been granted nothing on any mailbox.
    const ids = await published(ctx, "sponsored", PLAIN_DRAFT, sends(), OTHER_ADMIN);
    await grantOn(ctx, ids.butlerId, "send.propose");

    const refused = await run(ids, await aDelivery(ctx));
    expect(outcomes(refused)).toEqual([["refused", "sponsor_lacks_it"]]);

    // Non-vacuity: one tuple, for the sponsor, and the same Butler on the same delivery goes through. The
    // Butler's own grants did not move.
    await grantOn(ctx, OTHER_ADMIN, "send.propose");
    expect(outcomes(await run(ids, await aDelivery(ctx)))).toEqual([["ok", null]]);
  });

  it("stops the Butler when the sponsor's relation is revoked, on the next node", async () => {
    /*
     * §7 and §28: authority is re-read per operation and nothing about the sponsor term is cached. So this
     * is not "a new run refuses" — it is *the same published version, the same grants to the Butler*, and
     * one revocation between two runs.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "revocable", PLAIN_DRAFT, sends(), OTHER_ADMIN);
    await grantOn(ctx, ids.butlerId, "send.propose");
    await grantOn(ctx, OTHER_ADMIN, "send.propose");
    expect(outcomes(await run(ids, await aDelivery(ctx)))).toEqual([["ok", null]]);

    await revokeOn(ctx, OTHER_ADMIN, "send.propose");
    const stopped = await run(ids, await aDelivery(ctx));
    expect(outcomes(stopped)).toEqual([["refused", "sponsor_lacks_it"]]);
    // And the stop is **visible**: the run record carries the reason a person can filter on, which is what
    // makes an emptied ceiling different from a Butler that happens to be doing nothing.
    const recorded = await testEnv.CATALOG.prepare(
      "SELECT reason FROM butler_run_effects WHERE org_id = ? AND run_id = ? LIMIT 1",
    ).bind(ORG, stopped.runId).first<{ reason: string }>();
    expect(recorded?.reason).toBe("sponsor_lacks_it");
  });

  it("caps the read path too, which is the term that guards message content", async () => {
    /*
     * The sponsor term on the **folded** shape, asserted on the read that discloses content rather than only
     * on `caseMailboxHeldBy`.
     *
     * Both folded callers go through one `effectiveOn`, so the agreement test below already fails if that
     * function's sponsor `EXISTS` is deleted — but it fails on a *case*, and a case is queue metadata. The
     * path a reader worries about is `readEntity("message", …)`, which puts a subject line and a sender into
     * a run's state, and until this test nothing asserted that the sponsor's authority bounded it. A
     * regression there would have been caught by one assertion about the wrong entity.
     *
     * The Butler holds `mailbox.content.read` throughout and its ceiling names the right mailbox throughout:
     * the **only** thing that moves between the three calls below is the sponsor's tuple.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "reader-sponsored", PLAIN_DRAFT, sends());
    const delivery = await aDelivery(ctx);
    await grantOn(ctx, ids.butlerId, "mailbox.content.read");
    const reader = principal(ids, [ADDRESS], ["mailbox.content.read"]);

    expect(await readEntity(testEnv, reader, "message", delivery.messageId)).toBeNull();

    await grantOn(ctx, ADMIN, "mailbox.content.read");
    expect((await readEntity(testEnv, reader, "message", delivery.messageId))?.["id"])
      .toBe(delivery.messageId);

    // And it is live rather than resolved once: revoking the sponsor closes the read again.
    await revokeOn(ctx, ADMIN, "mailbox.content.read");
    expect(await readEntity(testEnv, reader, "message", delivery.messageId)).toBeNull();
  });

  it("counts the sponsor's teams, which is the one query #51 says the sponsor needs", async () => {
    /*
     * The sponsor's term is *"themselves, plus every team they belong to"*, resolved by `readableSubjects` —
     * the same function every human check uses. Shared mailboxes are granted to teams rather than to people
     * (`authz-check-rows-read.md`'s corpus says so), so a sponsor term with no team expansion would make
     * sponsorship unusable for exactly the mailboxes a Butler is for.
     *
     * The **Butler** gets no such expansion, and that is #51's decision 1 rather than an oversight: a Butler
     * inheriting a team's grants is how a declared ceiling stops meaning anything, because the ceiling would
     * float with the team's grants. Asserted below in the same test, so the asymmetry is a checked property
     * rather than a sentence.
     */
    const ctx = atTime(T0);
    const at = new Date(ctx.now()).toISOString();
    const ids = await published(ctx, "team-sponsored", PLAIN_DRAFT, sends(), OTHER_ADMIN);
    await grantOn(ctx, ids.butlerId, "send.propose");
    await grantOn(ctx, TEAM, "send.propose");

    // The sponsor holds nothing directly and the team holds it, but the sponsor is not in the team yet.
    expect(outcomes(await run(ids, await aDelivery(ctx)))).toEqual([["refused", "sponsor_lacks_it"]]);

    await testEnv.CATALOG.prepare(
      "INSERT INTO team_members (id, org_id, team_id, user_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("tmm"), ORG, TEAM, OTHER_ADMIN, at).run();
    expect(outcomes(await run(ids, await aDelivery(ctx)))).toEqual([["ok", null]]);

    /*
     * And the other direction. A Butler put into the same team holds nothing more: `team_members.user_id`
     * holds users, so the row exists and no check reads it for a `btl_`. With the Butler's own grant revoked
     * it stops, team membership notwithstanding.
     */
    await testEnv.CATALOG.prepare(
      "INSERT INTO team_members (id, org_id, team_id, user_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("tmm"), ORG, TEAM, ids.butlerId, at).run();
    await revokeOn(ctx, ids.butlerId, "send.propose");
    const stopped = await run(ids, await aDelivery(ctx));
    expect(outcomes(stopped)).toEqual([["refused", "butler_not_granted"]]);
  });
});

/* --------------------------------------------- the two shapes are one rule ------------------------ */

describe("the folded and the standalone shape answer alike", () => {
  it("agrees across every combination of the three terms", async () => {
    /*
     * `caseMailboxHeldBy` folds the intersection into the statement that finds the case, because its mailbox
     * is the query's output; `effectiveOnMailbox` asks it directly with `SELECT DISTINCT subject_id`,
     * because its mailbox is named. Two shapes of one rule is exactly the thing `authz-read.ts` warns about
     * — *"a second hand-written variant would be a second thing for that receipt to stop describing"* — so
     * the agreement is checked rather than argued, the same way `caseMailboxHeldBy` is already checked
     * against `maySend`.
     *
     * **The eight combinations matter one at a time.** A single `subject_id IN (butler, sponsor, …teams)`
     * with a `LIMIT 1` — the OR that #51 warns about — passes six of these and fails the two where exactly
     * one of the two subjects holds the relation. Those two are the whole defect: a Butler holding whatever
     * its sponsor holds.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "agreeing", PLAIN_DRAFT, sends());
    const delivery = await aDelivery(ctx);

    for (const declared of [true, false]) {
      for (const butlerHolds of [true, false]) {
        for (const sponsorHolds of [true, false]) {
          await revokeOn(ctx, ids.butlerId, "send.propose").catch(() => undefined);
          await revokeOn(ctx, ADMIN, "send.propose").catch(() => undefined);
          if (butlerHolds) await grantOn(ctx, ids.butlerId, "send.propose");
          if (sponsorHolds) await grantOn(ctx, ADMIN, "send.propose");

          const who = principal(ids, declared ? [ADDRESS] : [OTHER_ADDRESS]);
          const folded = await caseMailboxHeldBy(testEnv, who, delivery.caseId, "send.propose");
          const standalone = await effectiveOnMailbox(testEnv, who, MAILBOX, ["send.propose"]);
          const label = `declared=${declared} butler=${butlerHolds} sponsor=${sponsorHolds}`;

          expect(folded !== null, label).toBe(standalone.allowed);
          expect(standalone.allowed, label).toBe(declared && butlerHolds && sponsorHolds);
        }
      }
    }
  });

  it("names which term failed, in the order the remedies differ", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "reasons", PLAIN_DRAFT, sends());

    const undeclared = principal(ids, [OTHER_ADDRESS]);
    expect(await effectiveOnMailbox(testEnv, undeclared, MAILBOX, ["send.propose"]))
      .toEqual({ allowed: false, reason: "capability_not_declared" });

    const declared = principal(ids, [ADDRESS]);
    expect(await effectiveOnMailbox(testEnv, declared, MAILBOX, ["send.propose"]))
      .toEqual({ allowed: false, reason: "butler_not_granted" });

    await grantOn(ctx, ids.butlerId, "send.propose");
    expect(await effectiveOnMailbox(testEnv, declared, MAILBOX, ["send.propose"]))
      .toEqual({ allowed: false, reason: "sponsor_lacks_it" });

    await grantOn(ctx, ADMIN, "send.propose");
    expect(await effectiveOnMailbox(testEnv, declared, MAILBOX, ["send.propose"]))
      .toEqual({ allowed: true });
  });
});

/* --------------------------------------------- frozen with the version ---------------------------- */

describe("the ceiling cannot be widened after publication", () => {
  /** The routes #49's own frozen-version tests use, applied to the two halves of the ceiling. */
  async function refuses(sql: string, ...params: unknown[]): Promise<void> {
    await expect(testEnv.CATALOG.prepare(sql).bind(...params).run())
      .rejects.toThrow(/E_BUTLER_VERSION_FROZEN/);
  }

  it("refuses a rewritten AST, which is where the ceiling lives", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "frozen", PLAIN_DRAFT, sends());
    const widened = JSON.stringify({
      apiVersion: "mailda/v1", kind: "Butler",
      metadata: { name: "frozen", owner: "team:support" },
      capabilities: [...sends(), ...sends(OTHER_ADDRESS)],
      trigger: { event: "mail.received", mailbox: ADDRESS },
      entry: "reply", nodes: PLAIN_DRAFT,
    });
    await refuses(
      "UPDATE butler_versions SET ast_json = ? WHERE org_id = ? AND id = ?",
      widened, ORG, ids.versionId,
    );
    // And the source text, which is what a republish would be derived from.
    await refuses(
      "UPDATE butler_versions SET source_text = ? WHERE org_id = ? AND id = ?",
      widened, ORG, ids.versionId,
    );
  });

  it("refuses a swapped sponsor, which is the half 0027 did not know was content", async () => {
    /*
     * The hole 0031 closed, demonstrated the way #49 demonstrated its own: an attempt, made directly, rather
     * than an assertion that the write path does not do it. Swapping `published_by` re-points the ceiling's
     * sponsor term at a different person's authority — so a ceiling capped against somebody who holds
     * nothing becomes a ceiling capped against somebody who holds everything, with the AST untouched and
     * every digest still matching.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "sponsor-frozen", PLAIN_DRAFT, sends(), OTHER_ADMIN);
    await refuses(
      "UPDATE butler_versions SET published_by = ? WHERE org_id = ? AND id = ?",
      ADMIN, ORG, ids.versionId,
    );
    // NULL as well, which `<>` would have let through — the reason 0027 used `IS NOT` and 0031 kept it.
    await refuses(
      "UPDATE butler_versions SET published_by = NULL WHERE org_id = ? AND id = ?",
      ORG, ids.versionId,
    );
    await refuses(
      "UPDATE butler_versions SET published_at = ? WHERE org_id = ? AND id = ?",
      "2020-01-01T00:00:00.000Z", ORG, ids.versionId,
    );
    const row = await testEnv.CATALOG.prepare(
      "SELECT published_by FROM butler_versions WHERE id = ?",
    ).bind(ids.versionId).first<{ published_by: string }>();
    expect(row?.published_by).toBe(OTHER_ADMIN);
  });

  it("refuses the two-statement route: demote, then widen", async () => {
    // `btv_frozen` guards content *while the state is published*, so the way round it was always to leave
    // that state first. `btv_forward_only` refuses the first step, and this asserts it for the ceiling's
    // two halves rather than only for the AST — the same statement pair, aimed at the new column.
    const ctx = atTime(T0);
    const ids = await published(ctx, "two-step", PLAIN_DRAFT, sends(), OTHER_ADMIN);
    await refuses("UPDATE butler_versions SET state = 'draft' WHERE org_id = ? AND id = ?", ORG, ids.versionId);
    await refuses(
      "UPDATE butler_versions SET state = 'draft', published_by = ? WHERE org_id = ? AND id = ?",
      ADMIN, ORG, ids.versionId,
    );
    const row = await testEnv.CATALOG.prepare(
      "SELECT state, published_by FROM butler_versions WHERE id = ?",
    ).bind(ids.versionId).first<{ state: string; published_by: string }>();
    expect(row).toEqual({ state: "published", published_by: OTHER_ADMIN });
  });

  it("refuses a superseded version's sponsor too, because a run can still be bound to it", async () => {
    /*
     * A run binds a *version*, so an in-flight run of v1 goes on reading v1's frozen AST while v2 is live —
     * and therefore v1's ceiling and v1's sponsor are still live inputs to an authorization decision. A
     * frozen set that stopped at `published` would leave every superseded version editable while runs of it
     * were still walking.
     */
    const ctx = atTime(T0);
    const first = await published(ctx, "history", PLAIN_DRAFT, sends(), OTHER_ADMIN);
    const second = JSON.stringify({
      apiVersion: "mailda/v1", kind: "Butler",
      metadata: { name: "history", owner: "team:ops" },
      capabilities: sends(),
      trigger: { event: "mail.received", mailbox: ADDRESS },
      entry: "reply", nodes: PLAIN_DRAFT,
    });
    const { editButlerDraft } = await import("../src/butlers.ts");
    await editButlerDraft(testEnv, ctx, ORG, ADMIN, first.butlerId, { source: second });
    await publishButler(testEnv, ctx, ORG, ADMIN, first.butlerId);

    const superseded = await testEnv.CATALOG.prepare(
      "SELECT state FROM butler_versions WHERE id = ?",
    ).bind(first.versionId).first<{ state: string }>();
    expect(superseded?.state).toBe("superseded");

    await refuses(
      "UPDATE butler_versions SET published_by = ? WHERE org_id = ? AND id = ?",
      ADMIN, ORG, first.versionId,
    );
  });

  it("still allows the one write publication has to make, which is the anti-vacuity for all four", async () => {
    /*
     * A trigger whose WHEN clause was one clause too broad would pass every refusal above and break
     * publishing outright. Publishing a second version writes `published_by` and `published_at` on a **draft**
     * row and moves the first from published to superseded — both of which have to keep working.
     */
    const ctx = atTime(T0);
    const first = await published(ctx, "movable", PLAIN_DRAFT, sends());
    const { editButlerDraft } = await import("../src/butlers.ts");
    await editButlerDraft(testEnv, ctx, ORG, ADMIN, first.butlerId, {
      source: JSON.stringify({
        apiVersion: "mailda/v1", kind: "Butler",
        metadata: { name: "movable", owner: "team:ops" },
        capabilities: sends(),
        trigger: { event: "mail.received", mailbox: ADDRESS },
        entry: "reply", nodes: PLAIN_DRAFT,
      }),
    });
    const second = await publishButler(testEnv, ctx, ORG, OTHER_ADMIN, first.butlerId);
    expect(second.version).toBe(2);

    const rows = await testEnv.CATALOG.prepare(
      "SELECT id, state, published_by FROM butler_versions WHERE org_id = ? ORDER BY version",
    ).bind(ORG).all<{ id: string; state: string; published_by: string }>();
    expect(rows.results.map((row) => [row.state, row.published_by])).toEqual([
      ["superseded", ADMIN], ["published", OTHER_ADMIN],
    ]);
  });
});

/* --------------------------------------------- a published version with no sponsor ---------------- */

describe("a version that cannot name its sponsor is refused rather than defaulted", () => {
  it("stops the run and says so, because every available default is wrong", async () => {
    /*
     * Unreachable through `publishButler` and unwritable since 0031 — so this is reached by writing the row
     * before the trigger exists to refuse it, which is what a hand-edited database looks like. The point is
     * the direction of the failure: an empty sponsor would make the sponsor term match nothing and read as a
     * revocation, and treating the absence as "no sponsor term" would silently delete a term of §7's
     * intersection for exactly the row that could not account for itself.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "orphan", PLAIN_DRAFT, sends());
    await grantOn(ctx, ids.butlerId, "send.propose");
    await grantOn(ctx, ADMIN, "send.propose");

    // Straight into the table, bypassing the write path entirely: the trigger only guards UPDATE.
    await testEnv.CATALOG.prepare("DELETE FROM butler_versions WHERE id = ?").bind(ids.versionId).run();
    await testEnv.CATALOG.prepare(
      `INSERT INTO butler_versions
         (id, org_id, butler_id, version, state, ast_json, source_text, ast_sha256, source_sha256,
          created_by, created_at, published_by, published_at, superseded_at)
       VALUES (?,?,?,1,'published','{}','{}','x','y',?,?,NULL,NULL,NULL)`,
    ).bind(ids.versionId, ORG, ids.butlerId, ADMIN, new Date(ctx.now()).toISOString()).run();

    const refused = await run(ids, await aDelivery(ctx));
    expect(refused.state).toBe("refused");
    expect(refused.reason).toBe("sponsor_unknown");
    expect(refused.effects).toEqual([]);
    const logged = await testEnv.CATALOG.prepare(
      "SELECT message FROM log_entries WHERE event = 'butler.sponsor_unknown' LIMIT 1",
    ).first<{ message: string }>();
    expect(logged?.message).toContain("no publisher");
  });
});
