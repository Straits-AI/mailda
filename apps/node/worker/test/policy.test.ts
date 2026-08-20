import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { utf8 } from "@mailda/evidence";

import {
  createPolicyDraft, editPolicyDraft, evaluate, isStricter, OUTCOMES, POLICY_REASONS, publishPolicy,
  stricter, canonicalConditions, domainOf, STATE_FOR, type Outcome, type PolicyConditions,
} from "../src/policy.ts";
import deliveryScript from "../src/client/delivery.client.js";
import { cancelSend, dispatchDue, type SendState } from "../src/outbound/dispatch.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { sealManifest } from "../src/outbound/manifest.ts";

/**
 * The policy object (#60): the total order, the draft/publish lifecycle, and the state a decision produces.
 *
 * ## The sixteen ordered pairs, and why they are exhaustive rather than illustrative
 *
 * Four outcomes make sixteen ordered pairs, and #60's resolution calls conflict resolution *"exhaustively
 * testable — sixteen ordered pairs"*. That is the whole argument for a total order over a precedence table: a
 * table has sixteen cells and a wrong one nobody notices, while an order has four ranks and can be checked
 * against every pair by construction. So the pairs are walked from `OUTCOMES` rather than written out — a
 * hand-written list of sixteen is the same maintenance hazard as the table it replaced, and a fifth outcome
 * would make it silently incomplete instead of failing.
 *
 * Each pair is asserted **three** ways, because `stricter` alone could be right for the wrong reason:
 *
 * 1. against an independently written expectation (the index in `OUTCOMES`, which is the order itself);
 * 2. symmetrically, so `stricter(a, b) === stricter(b, a)` — a maximum does not care which argument came
 *    first, and an implementation that did would be an ordering bug that only bites on one arrival order;
 * 3. through `evaluate()` against two really-published policies, so the order is proved where it is used and
 *    not only where it is defined. That is the half a unit test of `stricter` would have missed entirely.
 */

const testEnv = env as unknown as Env;
const ORG = "org_policy";
const MAILBOX = "mbx_policy";
const OTHER_MAILBOX = "mbx_policy_other";
const ADDRESS = "support@acme.example";
const OTHER_ADDRESS = "billing@acme-billing.example";
const ADMIN = "usr_admin_p";
const AUTHOR = "usr_author_p";
const OTHER_AUTHOR = "usr_other_p";
/**
 * Somebody who can decide an approval, on both mailboxes.
 *
 * Added by #61 rather than by choice: publishing a `require_approval` policy is now refused when nobody holds
 * `approval.decide` on a mailbox it applies to, so every `require_approval` fixture in this file would
 * otherwise fail at publication. That refusal is the subject of `test/approvals.test.ts`; here it is a
 * precondition, and one approver is enough because none of these stages asks for more than the default 1.
 */
const APPROVER = "usr_approver_p";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

const AUGUST_10 = Date.parse("2026-08-10T09:00:00.000Z");

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId,
    new Date(ctx.now()).toISOString()).run();
}

/** A published policy in one call, since every test below needs at least one. */
async function published(
  name: string,
  outcome: Outcome,
  conditions?: PolicyConditions,
): Promise<{ policyId: string; versionId: string; version: number }> {
  const ctx = atTime(AUGUST_10);
  const draft = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, { name, outcome, conditions });
  const live = await publishPolicy(testEnv, ctx, ORG, ADMIN, draft.policyId);
  return { policyId: live.policyId, versionId: live.versionId, version: live.version };
}

function facts(overrides?: Partial<{
  mailboxId: string; actorUserId: string; recipients: string[]; isReply: boolean;
}>) {
  return {
    mailboxId: MAILBOX,
    actorUserId: AUTHOR,
    recipients: ["customer@example.net"],
    isReply: false,
    ...overrides,
  };
}

async function seal(overrides?: Partial<Parameters<typeof sealManifest>[3]>) {
  return sealManifest(testEnv, atTime(AUGUST_10 + 1000), ORG, {
    mailboxId: MAILBOX,
    authorUserId: AUTHOR,
    to: ["customer@example.net"],
    subject: "Hello",
    bodyTyped: "Body.",
    fidelity: "authored",
    ...overrides,
  });
}

async function manifestRow(id: string) {
  return testEnv.CATALOG.prepare(
    `SELECT state, state_reason, policy_outcome, policy_versions, release_at
       FROM send_manifests WHERE org_id = ? AND id = ?`,
  ).bind(ORG, id).first<{
    state: SendState; state_reason: string | null; policy_outcome: string | null;
    policy_versions: string | null; release_at: string;
  }>();
}

beforeEach(async () => {
  for (const table of ["policy_versions", "policies", "send_manifests", "send_recipients", "send_counters",
                       "relationship_tuples", "mailboxes", "addresses", "users", "audit_entries",
                       "messages", "ingress_receipts", "conversations", "cases", "outbox"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(OTHER_MAILBOX, ORG, "Billing", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(ADMIN, ORG, "admin@local.invalid", at),
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(AUTHOR, ORG, "author@local.invalid", at),
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(APPROVER, ORG, "approver@local.invalid", at),
  ]);
  await tuple(ADMIN, "org.admin", "organization", ORG);
  // A row in `users` as well as the tuple: `decidersByMailbox` counts only subjects that are people, because a
  // tuple's subject may be a team.
  for (const mailbox of [MAILBOX, OTHER_MAILBOX]) await tuple(APPROVER, "approval.decide", "mailbox", mailbox);
  for (const mailbox of [MAILBOX, OTHER_MAILBOX]) {
    for (const relation of ["send.propose", "mailbox.content.read"]) {
      await tuple(AUTHOR, relation, "mailbox", mailbox);
      await tuple(OTHER_AUTHOR, relation, "mailbox", mailbox);
    }
  }
});

describe("the total order over four outcomes (#60)", () => {
  it("ranks every one of the sixteen ordered pairs, in both directions, from OUTCOMES itself", () => {
    const pairs: string[] = [];
    for (const a of OUTCOMES) {
      for (const b of OUTCOMES) {
        pairs.push(`${a}+${b}`);
        // The expectation is derived from the declared order, not from the function under test: whichever
        // outcome appears later in `OUTCOMES` is the stricter one, which is what "totally ordered in that
        // direction" means. If `RANK` and `OUTCOMES` ever disagree, this fails.
        const expected = OUTCOMES.indexOf(a) >= OUTCOMES.indexOf(b) ? a : b;
        expect(stricter(a, b), `${a} vs ${b}`).toBe(expected);
        // A maximum is symmetric. An implementation that preferred its first argument on a tie would pass a
        // one-directional test and produce a different decision depending on which policy was read first.
        expect(stricter(b, a), `${b} vs ${a} must agree`).toBe(expected);
      }
    }
    expect(pairs).toHaveLength(16);
  });

  it("puts hold below require_approval, which is the counter-intuitive half", () => {
    // Not incidental to the ranks above: the order between the two gates follows from **who may clear it**.
    // Any `send.propose` holder releases a hold; only an `approval.decide` holder approves. So a hold is the
    // *less* restrictive gate, and an intuition-led implementation would have had these the other way round.
    expect(stricter("hold", "require_approval")).toBe("require_approval");
    expect(isStricter("require_approval", "hold")).toBe(true);
    expect(isStricter("hold", "require_approval")).toBe(false);
  });

  it("gives #62 a stricter-than predicate that is strict, not reflexive", () => {
    // `policy_stricter` fails a send closed. Reflexive equality must therefore be false: re-evaluating an
    // unchanged policy must not withhold every in-flight send in the organization.
    for (const outcome of OUTCOMES) expect(isStricter(outcome, outcome), outcome).toBe(false);
    expect(isStricter("deny", "allow")).toBe(true);
    expect(isStricter("allow", "deny")).toBe(false);
  });

  it("resolves the same sixteen pairs through evaluate(), against really-published policies", async () => {
    // The half that matters. `stricter` being right proves nothing about `evaluate` using it, and #60's own
    // rejection of a priority field is about what happens when two policies match one send.
    for (const a of OUTCOMES) {
      for (const b of OUTCOMES) {
        await testEnv.CATALOG.prepare("DELETE FROM policy_versions").run();
        await testEnv.CATALOG.prepare("DELETE FROM policies").run();
        // Both match every send: no conditions at all. So the only thing deciding the answer is the order.
        await published(`first ${a}`, a);
        await published(`second ${b}`, b);

        const decision = await evaluate(testEnv, atTime(AUGUST_10), ORG, facts());
        const expected = OUTCOMES.indexOf(a) >= OUTCOMES.indexOf(b) ? a : b;
        expect(decision.outcome, `${a} + ${b}`).toBe(expected);
        // Both matched, and both are reported. A decision that named only the winner could not answer
        // "which rules applied to this send", which is what §18 requires the audit trail to say.
        expect(decision.matched.map((match) => match.outcome).sort()).toEqual([a, b].sort());
      }
    }
  });

  it("is a fold over every match, not a comparison of the last two, at three policies in all six orders", async () => {
    // Sixteen *pairs* prove the comparison. They do not prove the **fold**: a combination that compared only
    // the most recent two matches passes every pair and still loses a `deny` read first, because
    // `allow, deny, hold` ends on `hold`. So the third policy is what makes `max` a claim about the whole set
    // rather than about adjacent elements, and all six permutations are walked because a fold that depends on
    // arrival order is exactly the bug a policy system fails open through.
    const orders: Outcome[][] = [
      ["allow", "deny", "hold"], ["allow", "hold", "deny"], ["deny", "allow", "hold"],
      ["deny", "hold", "allow"], ["hold", "allow", "deny"], ["hold", "deny", "allow"],
    ];
    for (const order of orders) {
      await testEnv.CATALOG.prepare("DELETE FROM policy_versions").run();
      await testEnv.CATALOG.prepare("DELETE FROM policies").run();
      // Unconditional, so nothing but the order can decide, and published in the listed sequence so
      // `ORDER BY published_at, id` reads them back in it.
      for (const [n, outcome] of order.entries()) await published(`p${n} ${outcome}`, outcome);

      const decision = await evaluate(testEnv, atTime(AUGUST_10), ORG, facts());
      expect(decision.outcome, order.join(",")).toBe("deny");
      // All three are named, because "which rules applied" is every match and not only the winner.
      expect(decision.matched, order.join(",")).toHaveLength(3);
    }
  });

  it("allows a send no policy matched, which is why an empty policy set is not a gate", async () => {
    const decision = await evaluate(testEnv, atTime(AUGUST_10), ORG, facts());
    expect(decision.outcome).toBe("allow");
    expect(decision.matched).toEqual([]);
  });
});

describe("the indexes the migration claims evaluation needs", () => {
  it("reads the published set through pv_live rather than scanning the history", async () => {
    // 0019's header says the partial index *is* what makes reading the live set cheap. That is a claim about a
    // query plan, so it is read from the planner rather than asserted in prose — #11's whole lesson being
    // that a plan looked fine right up until somebody printed it.
    const plan = await testEnv.CATALOG.prepare(
      `EXPLAIN QUERY PLAN
       SELECT v.id, v.outcome FROM policy_versions v
         JOIN policies p ON p.id = v.policy_id AND p.org_id = v.org_id
        WHERE v.org_id = ? AND v.state = 'published'
        ORDER BY v.published_at, v.id`,
    ).bind(ORG).all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    for (const detail of details) console.log(`PLAN policy_versions  ${detail}`);

    expect(details.some((detail) => detail.includes("USING INDEX pv_live"))).toBe(true);
    expect(details.some((detail) => /SCAN\s+(v|policy_versions)\b/.test(detail)),
      "a table scan of the whole version history would grow with every publication").toBe(false);
    // The `USE TEMP B-TREE FOR ORDER BY` this plan also reports is deliberate and is not a defect: the sort
    // is over the live set only — one row per policy — and the order is what makes `policy_versions` on a
    // manifest reproducible rather than dependent on physical row order.
  });

  it("reads the internal domain set through a covering index", async () => {
    const plan = await testEnv.CATALOG.prepare(
      "EXPLAIN QUERY PLAN SELECT DISTINCT address FROM addresses WHERE org_id = ?",
    ).bind(ORG).all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    for (const detail of details) console.log(`PLAN addresses  ${detail}`);
    // No new index was added for this: `addr_unique` on (org_id, address) already covers it, which is why
    // `recipient_external` needs no storage of its own. If that stops being true, this fails rather than
    // quietly costing a scan of every address in the organization on every gated seal.
    expect(details.some((detail) => detail.includes("COVERING INDEX addr_unique"))).toBe(true);
  });
});

describe("the five conditions", () => {
  it("matches on mailbox, and does not match another mailbox", async () => {
    await published("support only", "deny", { mailboxId: MAILBOX });
    expect((await evaluate(testEnv, atTime(AUGUST_10), ORG, facts())).outcome).toBe("deny");
    expect((await evaluate(testEnv, atTime(AUGUST_10), ORG,
      facts({ mailboxId: OTHER_MAILBOX }))).outcome).toBe("allow");
  });

  it("matches on actor", async () => {
    await published("that person", "require_approval", { actorUserId: AUTHOR });
    expect((await evaluate(testEnv, atTime(AUGUST_10), ORG, facts())).outcome).toBe("require_approval");
    expect((await evaluate(testEnv, atTime(AUGUST_10), ORG,
      facts({ actorUserId: OTHER_AUTHOR }))).outcome).toBe("allow");
  });

  it("matches on is_reply in both directions, so a false condition is a condition", async () => {
    await published("replies hold", "hold", { isReply: true });
    await published("new threads approve", "require_approval", { isReply: false });
    expect((await evaluate(testEnv, atTime(AUGUST_10), ORG, facts({ isReply: true }))).outcome).toBe("hold");
    expect((await evaluate(testEnv, atTime(AUGUST_10), ORG, facts({ isReply: false }))).outcome)
      .toBe("require_approval");
  });

  it("matches on org_daily_volume at or above the floor, and not below it", async () => {
    await published("busy day", "hold", { orgDailyVolumeMin: 10 });
    const ctx = atTime(AUGUST_10);
    const day = new Date(ctx.now()).toISOString().slice(0, 10);

    expect((await evaluate(testEnv, ctx, ORG, facts())).outcome, "no counter row at all").toBe("allow");

    await testEnv.CATALOG.prepare(
      "INSERT INTO send_counters (org_id, day, handed_over) VALUES (?,?,?)",
    ).bind(ORG, day, 9).run();
    expect((await evaluate(testEnv, ctx, ORG, facts())).outcome, "9 is below 10").toBe("allow");

    await testEnv.CATALOG.prepare(
      "UPDATE send_counters SET handed_over = 10 WHERE org_id = ? AND day = ?",
    ).bind(ORG, day).run();
    expect((await evaluate(testEnv, ctx, ORG, facts())).outcome, "10 is at the floor").toBe("hold");

    // The counter is per **day**, which is the only grain that exists. A policy that fired on yesterday's
    // volume would be a policy nobody could reason about.
    const tomorrow = atTime(AUGUST_10 + 86_400_000);
    expect((await evaluate(testEnv, tomorrow, ORG, facts())).outcome, "a new day, no rows").toBe("allow");
  });

  it("refuses a daily-volume floor of zero rather than storing an unconditional policy as a conditional one", async () => {
    await expect(createPolicyDraft(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      name: "always", outcome: "deny", conditions: { orgDailyVolumeMin: 0 },
    })).rejects.toThrow(/E_BAD_POLICY_VOLUME/);
  });
});

describe("recipient_external is derived from the customer's own domains", () => {
  it("treats a recipient on a domain in `addresses` as internal and anything else as external", async () => {
    await published("external needs approval", "require_approval", { recipientExternal: true });
    const ctx = atTime(AUGUST_10);

    // `acme.example` is internal because a row in `addresses` says so — support@acme.example, inserted by the
    // fixture. Nothing about that domain is hardcoded anywhere in `src/`.
    expect((await evaluate(testEnv, ctx, ORG, facts({ recipients: ["colleague@acme.example"] }))).outcome)
      .toBe("allow");
    expect((await evaluate(testEnv, ctx, ORG, facts({ recipients: ["customer@example.net"] }))).outcome)
      .toBe("require_approval");
  });

  it("follows the addresses table when a second domain is added, which is what proves it is derived", async () => {
    // The case that distinguishes "derived from the customer's own domains" from "a list somebody wrote".
    // `acme-billing.example` is external until the customer routes an address on it, and internal the moment
    // they do — with no code change, no migration and no cache to invalidate. Email Routing only accepts
    // addresses on domains in the customer's own account, which is what makes this sound.
    await published("external needs approval", "require_approval", { recipientExternal: true });
    const ctx = atTime(AUGUST_10);

    expect((await evaluate(testEnv, ctx, ORG, facts({ recipients: ["ap@acme-billing.example"] }))).outcome,
      "before the address exists").toBe("require_approval");

    await testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, OTHER_ADDRESS, OTHER_MAILBOX, new Date(ctx.now()).toISOString()).run();

    expect((await evaluate(testEnv, ctx, ORG, facts({ recipients: ["ap@acme-billing.example"] }))).outcome,
      "after the address exists").toBe("allow");
  });

  it("is any-recipient rather than all-recipient, because one stranger makes the send leave", async () => {
    await published("external needs approval", "require_approval", { recipientExternal: true });
    const decision = await evaluate(testEnv, atTime(AUGUST_10), ORG, facts({
      recipients: ["colleague@acme.example", "customer@example.net"],
    }));
    expect(decision.outcome).toBe("require_approval");
  });

  it("compares domains case-insensitively and takes the part after the last @", () => {
    expect(domainOf("Support@ACME.Example")).toBe("acme.example");
    // A quoted local part may itself contain an `@`. Splitting on the first one would call the domain
    // `b"@example.net`, and every such recipient would read as external.
    expect(domainOf('"a@b"@example.net')).toBe("example.net");
    expect(domainOf("not-an-address")).toBe("");
  });

  it("does not read the domain set at all when no published policy asks for it", async () => {
    // The cost decision made observable. `evaluate` reports which derived inputs it fetched, and a policy
    // set that constrains neither derived condition fetches neither — which is what keeps a seal at one
    // query rather than three (receipt: policy-evaluation-cost.md).
    await published("mailbox only", "hold", { mailboxId: MAILBOX });
    const decision = await evaluate(testEnv, atTime(AUGUST_10), ORG, facts());
    expect(decision.fetched).toEqual({ domains: false, dailyVolume: false });

    await published("external too", "deny", { recipientExternal: true });
    await published("volume too", "deny", { orgDailyVolumeMin: 5 });
    const both = await evaluate(testEnv, atTime(AUGUST_10), ORG, facts());
    expect(both.fetched).toEqual({ domains: true, dailyVolume: true });
  });
});

describe("publication is the versioning event (#49, inherited)", () => {
  it("refuses a publish that changes nothing", async () => {
    const ctx = atTime(AUGUST_10);
    const first = await published("no external", "deny", { recipientExternal: true });

    // An edit that writes the same outcome and the same conditions is a draft that says nothing new.
    await editPolicyDraft(testEnv, ctx, ORG, ADMIN, first.policyId, {
      outcome: "deny", conditions: { recipientExternal: true },
    });
    await expect(publishPolicy(testEnv, ctx, ORG, ADMIN, first.policyId))
      .rejects.toThrow(/E_POLICY_UNCHANGED/);

    // And the refusal did not consume the version number or damage what is live.
    const live = await testEnv.CATALOG.prepare(
      "SELECT id, version FROM policy_versions WHERE org_id = ? AND state = 'published'",
    ).bind(ORG).all<{ id: string; version: number }>();
    expect(live.results).toHaveLength(1);
    expect(live.results[0]!.version).toBe(1);
    expect(live.results[0]!.id).toBe(first.versionId);
  });

  it("treats an absent condition and an explicit null as the same rule, so neither is a change", async () => {
    // `canonicalConditions` is what the refusal compares, so the equivalence has to hold there. A publish
    // that turned `undefined` into `null` and minted a version would be a version representing no decision.
    expect(canonicalConditions("deny", { mailboxId: null, isReply: undefined }))
      .toBe(canonicalConditions("deny", {}));
    // And a real difference really differs, so the hash is not constant.
    expect(canonicalConditions("deny", { isReply: true }))
      .not.toBe(canonicalConditions("deny", { isReply: false }));
    expect(canonicalConditions("deny", {})).not.toBe(canonicalConditions("hold", {}));
  });

  it("publishes a real change, supersedes the previous version, and takes the next number", async () => {
    const ctx = atTime(AUGUST_10);
    const first = await published("no external", "hold", { recipientExternal: true });
    await editPolicyDraft(testEnv, ctx, ORG, ADMIN, first.policyId, {
      outcome: "deny", conditions: { recipientExternal: true },
    });
    const second = await publishPolicy(testEnv, ctx, ORG, ADMIN, first.policyId);

    expect(second.version).toBe(2);
    expect(second.supersededVersionId).toBe(first.versionId);
    const rows = await testEnv.CATALOG.prepare(
      "SELECT id, state, version FROM policy_versions WHERE org_id = ? ORDER BY version",
    ).bind(ORG).all<{ id: string; state: string; version: number }>();
    expect(rows.results.map((row) => [row.version, row.state]))
      .toEqual([[1, "superseded"], [2, "published"]]);

    // And only the current one decides. #60 binds a version for the record; it never evaluates history.
    expect((await evaluate(testEnv, ctx, ORG, facts({ recipients: ["c@example.net"] }))).outcome)
      .toBe("deny");
  });

  it("freezes a superseded version's content, which is the claim 0019's header makes", async () => {
    // "A published version freezes" has to be exact rather than a slogan, because supersession *is* an
    // UPDATE of a published row. What freezes is the content; the lifecycle state is the only column that
    // moves. Asserted by reading the content bytes before and after.
    const ctx = atTime(AUGUST_10);
    const first = await published("no external", "hold", { recipientExternal: true });
    const content = () => testEnv.CATALOG.prepare(
      `SELECT outcome, when_mailbox_id, when_actor_user_id, when_recipient_external, when_is_reply,
              when_org_daily_volume_min, canonical_sha256, version, created_at
         FROM policy_versions WHERE id = ?`,
    ).bind(first.versionId).first<Record<string, unknown>>();

    const before = await content();
    await editPolicyDraft(testEnv, ctx, ORG, ADMIN, first.policyId, { outcome: "deny" });
    await publishPolicy(testEnv, ctx, ORG, ADMIN, first.policyId);
    expect(await content()).toEqual(before);
  });

  it("leaves the live version live when a publish loses the race, rather than superseding it", async () => {
    // Found by reading this code rather than by a failure, and it is the one way this ticket could have made
    // the policy plane fail **open**. The publish is two statements — supersede the current version, promote
    // the draft — inside one batch. Only the promotion was conditional at first, so a publish whose draft had
    // already been promoted by somebody else would have superseded the live version and promoted nothing,
    // leaving the policy with **no** published version and every send it gated suddenly allowed.
    //
    // Interleaved at the exact point that matters rather than simulated before it. Promoting the draft
    // *before* calling `publishPolicy` would fail on the draft read instead, which proves nothing — the window
    // is between reading the draft and committing the batch. So the batch itself is the hook: the env below
    // promotes the draft on the first `batch()` call and then delegates, which is precisely what the loser
    // observes. No production seam is added for this; it wraps the binding the way `cost-meter.ts` does.
    const ctx = atTime(AUGUST_10);
    const first = await published("gate", "deny", { mailboxId: MAILBOX });
    await editPolicyDraft(testEnv, ctx, ORG, ADMIN, first.policyId, { outcome: "hold" });
    const draftId = (await testEnv.CATALOG.prepare(
      "SELECT id FROM policy_versions WHERE org_id = ? AND state = 'draft'",
    ).bind(ORG).first<{ id: string }>())!.id;

    await expect(publishPolicy(racingEnv(draftId), ctx, ORG, ADMIN, first.policyId))
      .rejects.toThrow(/E_POLICY_PUBLISH_RACED/);

    // The version that was live before the losing publish is still live. Nothing was superseded.
    const still = await testEnv.CATALOG.prepare(
      "SELECT state, superseded_at FROM policy_versions WHERE id = ?",
    ).bind(first.versionId).first<{ state: string; superseded_at: string | null }>();
    expect(still?.state).toBe("published");
    expect(still?.superseded_at).toBeNull();
    // And the policy still denies, which is the property that matters: a lost race must not open a gate.
    expect((await evaluate(testEnv, ctx, ORG, facts())).outcome).toBe("deny");
  });

  it("refuses a publish with no draft, because publication needs something unpublished", async () => {
    const first = await published("no external", "hold", { recipientExternal: true });
    await expect(publishPolicy(testEnv, atTime(AUGUST_10), ORG, ADMIN, first.policyId))
      .rejects.toThrow(/E_NO_POLICY_DRAFT/);
  });

  it("keeps at most one draft per policy, so an author cannot accumulate competing edits", async () => {
    const ctx = atTime(AUGUST_10);
    const first = await published("no external", "hold", { recipientExternal: true });
    await editPolicyDraft(testEnv, ctx, ORG, ADMIN, first.policyId, { outcome: "deny" });
    await editPolicyDraft(testEnv, ctx, ORG, ADMIN, first.policyId, { outcome: "require_approval" });

    const drafts = await testEnv.CATALOG.prepare(
      "SELECT outcome FROM policy_versions WHERE org_id = ? AND state = 'draft'",
    ).bind(ORG).all<{ outcome: string }>();
    expect(drafts.results.map((row) => row.outcome)).toEqual(["require_approval"]);
  });

  it("takes org.admin to write or publish a policy", async () => {
    await expect(createPolicyDraft(testEnv, atTime(AUGUST_10), ORG, AUTHOR, {
      name: "sneaky", outcome: "allow",
    })).rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);

    const first = await published("no external", "hold", { recipientExternal: true });
    await expect(editPolicyDraft(testEnv, atTime(AUGUST_10), ORG, AUTHOR, first.policyId, {
      outcome: "allow",
    })).rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);
    await expect(publishPolicy(testEnv, atTime(AUGUST_10), ORG, AUTHOR, first.policyId))
      .rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);
  });

  it("records both the draft and the publication in the audit trail", async () => {
    // Separation of duty (§18) means the drafter and the publisher may differ deliberately, so a trail
    // carrying only the publication cannot answer who wrote what became live.
    await published("no external", "deny", { recipientExternal: true });
    const entries = await testEnv.CATALOG.prepare(
      "SELECT action, actor_user_id FROM audit_entries WHERE org_id = ? ORDER BY seq",
    ).bind(ORG).all<{ action: string; actor_user_id: string }>();
    expect(entries.results.map((row) => row.action)).toEqual(["policy.drafted", "policy.published"]);
    expect(entries.results.every((row) => row.actor_user_id === ADMIN)).toBe(true);
  });
});

describe("a draft is never consulted by evaluation", () => {
  it("has no effect on a send its conditions match exactly", async () => {
    const ctx = atTime(AUGUST_10);
    // A draft that would deny everything, never published.
    await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
      name: "would deny everything", outcome: "deny", conditions: { mailboxId: MAILBOX },
    });

    const decision = await evaluate(testEnv, ctx, ORG, facts());
    expect(decision.outcome).toBe("allow");
    expect(decision.matched).toEqual([]);

    const sealed = await seal();
    expect(sealed.state).toBe("held");
    expect(sealed.policyOutcome).toBe("allow");
  });

  it("has no effect after the policy it belongs to has a published version too", async () => {
    // The sharper case: a policy with a live `hold` and a draft `deny`. If drafts leaked, the send would be
    // withheld, and the draft is exactly what an administrator has not finished deciding.
    const ctx = atTime(AUGUST_10);
    const first = await published("gate", "hold", { mailboxId: MAILBOX });
    await editPolicyDraft(testEnv, ctx, ORG, ADMIN, first.policyId, {
      outcome: "deny", conditions: { mailboxId: MAILBOX },
    });

    const decision = await evaluate(testEnv, ctx, ORG, facts());
    expect(decision.outcome).toBe("hold");
    expect(decision.matched.map((match) => match.versionId)).toEqual([first.versionId]);
  });
});

describe("the state a decision produces (#60's mapping)", () => {
  it("maps all four outcomes, and the map has no gaps", () => {
    // Declared as a total `Record<Outcome, …>`, so a fifth outcome is a compile error rather than a send
    // that falls through the mapping into whatever the last branch was.
    expect(Object.keys(STATE_FOR).sort()).toEqual([...OUTCOMES].sort());
    expect(STATE_FOR.allow).toEqual({ state: "held", reason: null });
    expect(STATE_FOR.hold).toEqual({ state: "awaiting", reason: "policy_hold" });
    expect(STATE_FOR.require_approval).toEqual({ state: "awaiting", reason: "policy_approval_required" });
    expect(STATE_FOR.deny).toEqual({ state: "withheld", reason: "policy_denied" });
  });

  it("gives every reason token it can write words in the module a browser is served", () => {
    // `src/policy.ts` mints the tokens and `src/client/delivery.client.js` owns the sentences, which is a
    // split two files assert in prose and nothing was checking. The failure it admits is not hypothetical:
    // `describeReason` falls back to the raw token, so a reason with no entry shows somebody
    // `policy_approval_required` where a sentence naming who can clear it belongs — the same defect
    // `delivery-summary.test.ts` catches for states, which had no counterpart for reasons.
    //
    // Asserted against the **exact bytes** `ui.ts` serves rather than against an imported map, because
    // `delivery.client.js` is a Text module (wrangler `rules`) and cannot be imported as a namespace inside
    // workerd. That is the stronger check anyway: what is asserted is what a browser gets.
    //
    // `POLICY_REASONS` is derived from `STATE_FOR`, so a fifth outcome or a renamed token arrives here
    // automatically instead of needing this list edited. `authority_lost` is added by hand and named,
    // because its writer is `dispatchOne` rather than this mapping — #62's remaining five reasons are that
    // ticket's to add here as it adds them there.
    expect([...POLICY_REASONS].sort())
      .toEqual(["policy_approval_required", "policy_denied", "policy_hold"]);
    for (const reason of [...POLICY_REASONS, "authority_lost"]) {
      expect(deliveryScript, `no words for ${reason}`).toContain(`\n  ${reason}: {`);
    }
  });

  it("seals a send in held when policy allows, and records that it was evaluated", async () => {
    const sealed = await seal();
    expect(sealed.state).toBe("held");
    expect(sealed.stateReason).toBeNull();
    const row = await manifestRow(sealed.id);
    expect(row?.state).toBe("held");
    expect(row?.policy_outcome).toBe("allow");
    // An empty array, not NULL. "Evaluated and nothing matched" and "never evaluated" are different facts,
    // and NULL is reserved for rows sealed before this migration existed.
    expect(row?.policy_versions).toBe("[]");
    expect(row?.state_reason).toBeNull();
  });

  it("seals a held send in awaiting with the hold reason", async () => {
    const gate = await published("gate", "hold", { mailboxId: MAILBOX });
    const sealed = await seal();
    expect(sealed.state).toBe("awaiting");
    expect(sealed.stateReason).toBe("policy_hold");
    const row = await manifestRow(sealed.id);
    expect(row?.state).toBe("awaiting");
    expect(row?.policy_outcome).toBe("hold");
    expect(JSON.parse(row!.policy_versions!)).toEqual([gate.versionId]);
  });

  it("seals an approval-required send in awaiting with the approval reason, which is the stricter gate", async () => {
    await published("gate", "hold", { mailboxId: MAILBOX });
    await published("approve", "require_approval", { mailboxId: MAILBOX });
    const sealed = await seal();
    // Both matched. The reason is the *stricter* one, because that is what has to be cleared.
    expect(sealed.state).toBe("awaiting");
    expect(sealed.stateReason).toBe("policy_approval_required");
    expect(sealed.policyVersionIds).toHaveLength(2);
  });

  it("seals a denied send in withheld rather than in awaiting", async () => {
    // The call this ticket makes. A denial in `awaiting` would be a send nobody can ever clear, accumulating
    // forever in a state that reads as pending.
    await published("no", "deny", { mailboxId: MAILBOX });
    const sealed = await seal();
    expect(sealed.state).toBe("withheld");
    expect(sealed.stateReason).toBe("policy_denied");
    expect((await manifestRow(sealed.id))?.state).toBe("withheld");
  });

  it("mirrors the state onto every recipient row, so nothing is stopped and pending at once", async () => {
    await published("gate", "hold", { mailboxId: MAILBOX });
    const sealed = await seal({ to: ["a@example.net"], cc: ["b@example.net"] });
    const rows = await testEnv.CATALOG.prepare(
      "SELECT submission_state FROM send_recipients WHERE org_id = ? AND manifest_id = ?",
    ).bind(ORG, sealed.id).all<{ submission_state: string }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((row) => row.submission_state === "awaiting")).toBe(true);
  });

  it("carries the policy decision into the seal's audit entry", async () => {
    const gate = await published("gate", "require_approval", { mailboxId: MAILBOX });
    const sealed = await seal();
    const entry = await testEnv.CATALOG.prepare(
      "SELECT detail FROM audit_entries WHERE org_id = ? AND action = 'send.sealed' AND subject = ?",
    ).bind(ORG, sealed.id).first<{ detail: string }>();
    const detail = JSON.parse(entry!.detail) as Record<string, unknown>;
    expect(detail.policyOutcome).toBe("require_approval");
    expect(detail.state).toBe("awaiting");
    expect(detail.stateReason).toBe("policy_approval_required");
    // Named by policy name and version as well as by id, because "which rule applied" is a question a person
    // asks and `plv_01J…` alone does not answer it.
    expect((detail.policyVersions as string[])[0]).toBe(`gate@${gate.version}:${gate.versionId}`);
  });

  it("evaluates a reply as a reply, using the parent the authority check already verified", async () => {
    const ctx = atTime(AUGUST_10);
    await published("replies hold", "hold", { isReply: true });
    const messageId = await aParentMessage(ctx);

    expect((await seal()).state, "a new thread is unaffected").toBe("held");
    const reply = await seal({ inReplyToMessageId: messageId });
    expect(reply.state).toBe("awaiting");
    expect(reply.stateReason).toBe("policy_hold");
  });
});

describe("a gated send cannot leave, and can still be stopped", () => {
  it("is not picked up by the dispatcher even once its release window has passed", async () => {
    await published("gate", "hold", { mailboxId: MAILBOX });
    const sealed = await seal();

    // Well past any hold window. `awaiting` is neither `held` nor `throttled`, so the predicate that lets a
    // send out never admitted it — there is no guard to forget.
    const dispatched = await dispatchDue(
      testEnv, atTime(AUGUST_10 + 86_400_000), ORG, failingTransport(), 20,
    );
    expect(dispatched).toEqual([]);
    expect((await manifestRow(sealed.id))?.state).toBe("awaiting");
  });

  it("can be cancelled by its author, because nothing else in this build clears it", async () => {
    await published("gate", "require_approval", { mailboxId: MAILBOX });
    const sealed = await seal();
    const outcome = await cancelSend(testEnv, atTime(AUGUST_10 + 2000), ORG, sealed.id);
    expect(outcome.cancelled).toBe(true);
    expect((await manifestRow(sealed.id))?.state).toBe("cancelled");
    const recipients = await testEnv.CATALOG.prepare(
      "SELECT submission_state FROM send_recipients WHERE org_id = ? AND manifest_id = ?",
    ).bind(ORG, sealed.id).all<{ submission_state: string }>();
    expect(recipients.results.every((row) => row.submission_state === "cancelled")).toBe(true);
  });

  it("cannot be cancelled once withheld, which is what makes withheld terminal", async () => {
    await published("no", "deny", { mailboxId: MAILBOX });
    const sealed = await seal();
    const outcome = await cancelSend(testEnv, atTime(AUGUST_10 + 2000), ORG, sealed.id);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.reason).toContain("withheld");
    expect((await manifestRow(sealed.id))?.state).toBe("withheld");
  });
});

/**
 * An env whose first `batch()` is preceded by somebody else promoting the draft.
 *
 * The only way to land in the window between `publishPolicy` reading the draft and committing its batch. A
 * proxy over `CATALOG` rather than a flag in `src/policy.ts`, because a production branch that exists only to
 * be taken by a test is a branch nothing else exercises.
 */
function racingEnv(draftId: string): Env {
  let raced = false;
  const catalog = new Proxy(testEnv.CATALOG, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await target.prepare(
              "UPDATE policy_versions SET state = 'published', version = 99 WHERE id = ?",
            ).bind(draftId).run();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { ...testEnv, CATALOG: catalog } as Env;
}

/** A transport that would fail loudly if anything reached it. Nothing in this file should. */
function failingTransport() {
  return {
    capability: async () => ({ canSend: true as const, detail: "test" }),
    submit: async () => {
      throw new Error("the transport must not be reached: a gated send never leaves");
    },
  } as unknown as Parameters<typeof dispatchDue>[3];
}

/** A real inbound message the author may read, so a reply can be sealed against it. */
async function aParentMessage(ctx: Ctx): Promise<string> {
  const at = new Date(ctx.now()).toISOString();
  const conversationId = await conversationForDelivery(testEnv, ctx, ORG, "<in@example.net>");
  const raw = utf8("Message-ID: <p@example.net>\r\nSubject: q\r\n\r\nbody\r\n");
  const stored = await putEvidence(testEnv, `${ORG}/parent-${ctx.id("k")}.eml`, raw);
  const receiptId = ctx.id("ir");
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, envelope_from, envelope_to, raw_bytes, accepted_at,
                                   blob_key, blob_sha256, provider_event_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(receiptId, ORG, "customer@example.net", ADDRESS, raw.byteLength, at,
    stored.blobKey, stored.plaintextSha256, ctx.id("pe")).run();
  const messageId = ctx.id("msg");
  await testEnv.CATALOG.prepare(
    `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
                           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
                           created_at, conversation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(messageId, ORG, "2026-08", stored.blobKey, stored.plaintextSha256, raw.byteLength,
    "<p@example.net>", ctx.id("thr"), "q", "customer@example.net", at, at, receiptId, at,
    conversationId).run();
  return messageId;
}
