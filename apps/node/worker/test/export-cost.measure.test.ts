import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { utf8 } from "@mailda/evidence";

import { decideApproval } from "../src/approvals.ts";
import { hashPassword } from "../src/auth/password.ts";
import { metering } from "../src/cost-meter.ts";
import { putEvidence, runKeyCache, type RunKeyCache } from "../src/evidence-store.ts";
import { requestExport, runExport } from "../src/exports.ts";
import { openMatter } from "../src/matters.ts";

/**
 * What one exported message costs, **measured** — with and without the run-scoped key cache (#65).
 *
 * ## Why this file exists rather than a count
 *
 * #65's resolution costed a read-decrypt-re-emit at **6 subrequests per message**, taken from the re-seal
 * shape in `evidence-lifecycle.md`, and said the cache removes 2 of them. Both halves are hypotheses about a
 * feature that did not exist yet, and AGENTS.md is explicit that a number read off source is a hypothesis.
 * `src/cost-meter.ts` exists to settle exactly this class of question: it counts **executions** rather than
 * `prepare`, prices a `batch()` as the one round trip it is, and — the part that matters most here — sees
 * Durable Object RPCs, which is what a vault call is and what the cache removes.
 *
 * ## What is measured, and against what
 *
 * Real `workerd` under `vitest-pool-workers`, against a real D1 and a real R2. **Not a deployed Node** —
 * miniflare's D1 is a local SQLite, so what is counted is the number of operations Mailda performs, which is
 * what the subrequest budget is spent in, and not their latency. Same boundary
 * `policy-cost.measure.test.ts` and `doctor-check-cost.md` both draw.
 *
 * ## The per-message figure is isolated by differencing, which is the only honest way to get it
 *
 * A run costs a fixed amount per page — the recheck, the page query, the checkpoint — plus a per-message
 * amount, plus a one-off completion cost. Measuring "a run" and dividing would fold all three together and
 * produce a figure that moves when the fixture size changes. So two runs of **different sizes** are metered
 * and the per-message cost is the difference divided by the difference in messages, which cancels every
 * fixed term whether or not this file knows what they are.
 */

const testEnv = env as unknown as Env;
const ORG = "org_expcost";
const MAILBOX = "mbx_expcost";
const ADDRESS = "people@acme.example";
const INVESTIGATOR = "usr_expcost_investigator";
const ANA = "usr_expcost_ana";
const BEN = "usr_expcost_ben";

const PASSWORD = "fixture-password-not-a-real-secret";
const AUGUST = Date.parse("2026-08-20T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** Two fixture sizes. The difference is what isolates the per-message cost. */
const SMALL = 2;
const LARGE = 8;

/**
 * A cache that forgets — which is what *"without the run-scoped cache"* has to mean here.
 *
 * `runExport` always creates one when the caller passes none, so there is no code path that skips it and
 * `cache: undefined` measures the cached figure. Rather than adding a production switch that exists only for
 * a measurement — a landmine in the AGENTS.md sense, since somebody would eventually pass it — the "without"
 * arm is a cache double that reports every lookup as a miss. The run under measurement is then the **real**
 * one, byte for byte, with the only difference being whether the vault is asked again.
 *
 * A `Map` subclass rather than a stub object, because `contentKeyFor` calls `.get` and `.set` on it and a
 * partial double would have to be kept in step with those.
 */
class ForgetfulMap extends Map<number, CryptoKey> {
  override get(): CryptoKey | undefined {
    return undefined;
  }
}

function forgetfulCache(): RunKeyCache {
  return {
    opening: new ForgetfulMap(),
    // Written by `putEvidence` and discarded, so the sealing key is fetched once per message.
    get sealing() {
      return null;
    },
    set sealing(_value: RunKeyCache["sealing"]) {
      /* discarded on purpose: see the class above */
    },
  };
}

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

const who = (userId: string) => ({ orgId: ORG, userId });

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId,
    new Date(ctx.now()).toISOString()).run();
}

beforeEach(async () => {
  for (const table of ["exports", "matters", "approval_decisions", "approval_stages", "approvals",
                       "notifications", "relationship_tuples", "team_members", "ingress_receipts", "messages",
                       "addresses", "mailboxes", "users", "node_claim", "audit_entries", "log_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await testEnv.EVIDENCE.list({ prefix: `${ORG}/` });
  for (const object of listed.objects) await testEnv.EVIDENCE.delete(object.key);

  const ctx = createSystemCtx();
  const at = new Date(AUGUST).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_expcost", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "People", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    ...[INVESTIGATOR, ANA, BEN].map((userId) => testEnv.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations,
         password_updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, ORG, `${userId}@acme.example`, at, verifier.encoded, verifier.effectiveIterations, at)),
  ]);

  for (let index = 0; index < LARGE; index++) {
    const receiptId = `rcpt_expcost_${String(index).padStart(2, "0")}`;
    const acceptedAt = new Date(AUGUST + index * DAY).toISOString();
    const stored = await putEvidence(testEnv, `${ORG}/raw/${receiptId}.eml`,
      utf8(`From: s${index}@example.net\r\nSubject: message ${index}\r\n\r\nbody ${index}\r\n`));
    await testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
         blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(receiptId, ORG, `evt_${receiptId}`, `s${index}@example.net`, ADDRESS, stored.plaintextBytes,
      stored.blobKey, stored.plaintextSha256, acceptedAt).run();
  }

  await tuple(ANA, "approval.decide", "mailbox", MAILBOX);
  await tuple(BEN, "approval.decide", "mailbox", MAILBOX);
  await tuple(INVESTIGATOR, "ediscovery.export", "mailbox", MAILBOX);
});

/**
 * One approved export over the first `messages` days, run to completion under the meter.
 *
 * The window is what varies the size, so both runs use the same predicate shape and the same code path —
 * only the number of matching messages differs, which is the term being isolated.
 */
async function measure(messages: number, cache: RunKeyCache) {
  const ctx = atTime(AUGUST);
  const matter = await openMatter(testEnv, ctx, ORG, INVESTIGATOR, {
    type: "regulatory_request",
    description: `Cost measurement over ${messages} message(s)`,
  });
  const requested = await requestExport(testEnv, ctx, ORG, INVESTIGATOR, {
    mailboxId: MAILBOX,
    matterId: matter.id,
    maxMessages: 1000,
    // Inclusive of day `messages - 1` and exclusive of the next, so exactly `messages` receipts match.
    toDate: new Date(AUGUST + (messages - 1) * DAY).toISOString(),
  });
  await decideApproval(testEnv, ctx, ORG, ANA, requested.approvalId, "approve");
  await decideApproval(testEnv, ctx, ORG, BEN, requested.approvalId, "approve");

  // The meter wraps the env, so everything `runExport` touches through it is counted — including the vault
  // RPCs, which are the terms the cache removes and the ones `doctor`'s meter cannot see at all.
  const { env: metered, cost } = metering(testEnv);
  const outcome = await runExport(metered, ctx, ORG, who(INVESTIGATOR), requested.exportId, { cache });
  if (!outcome.done || outcome.messagesEmitted !== messages) {
    throw new Error(`expected ${messages} emitted in one page, got ${outcome.messagesEmitted}`);
  }
  return cost;
}

function report(label: string, cost: {
  subrequests: number; d1Executions: number; r2Operations: number; doRpcs: number;
}): void {
  console.log(
    `MEASURE export ${label}  subrequests=${cost.subrequests}  d1=${cost.d1Executions}`
    + `  r2=${cost.r2Operations}  do_rpc=${cost.doRpcs}`,
  );
}

describe("what one exported message costs", () => {
  it("measures the per-message cost with and without the run-scoped key cache", async () => {
    const uncachedSmall = await measure(SMALL, forgetfulCache());
    const uncachedLarge = await measure(LARGE, forgetfulCache());
    // One cache per run, exactly as `runExport` creates one per invocation when the caller passes none.
    const cachedSmall = await measure(SMALL, runKeyCache());
    const cachedLarge = await measure(LARGE, runKeyCache());

    report(`uncached.${SMALL}`, uncachedSmall);
    report(`uncached.${LARGE}`, uncachedLarge);
    report(`cached.${SMALL}`, cachedSmall);
    report(`cached.${LARGE}`, cachedLarge);

    // Differencing cancels every fixed term — the recheck, the page query, the checkpoint, the manifest
    // listing, the manifest put and the audit append — whether or not this test knows what they are.
    const perMessage = (uncachedLarge.subrequests - uncachedSmall.subrequests) / (LARGE - SMALL);
    const perMessageCached = (cachedLarge.subrequests - cachedSmall.subrequests) / (LARGE - SMALL);
    console.log(
      `MEASURE export per_message  uncached=${perMessage}  cached=${perMessageCached}`
      + `  saving=${perMessage - perMessageCached}`,
    );

    expect(perMessage).toBe(BUDGETS["export.subrequests_per_message"]);
    expect(perMessageCached).toBe(BUDGETS["export.subrequests_per_message_cached"]);

    /*
     * **The resolution's claim, checked rather than repeated.** #65 said caching removes 2 of the per-message
     * subrequests — the opening key and the sealing key, both Durable Object RPCs. If it ever stops saving
     * exactly 2, this fails and the receipt is wrong rather than quietly generous.
     */
    expect(perMessage - perMessageCached).toBe(2);
    const rpcPerMessage = (uncachedLarge.doRpcs - uncachedSmall.doRpcs) / (LARGE - SMALL);
    const rpcPerMessageCached = (cachedLarge.doRpcs - cachedSmall.doRpcs) / (LARGE - SMALL);
    expect(rpcPerMessage).toBe(2);
    // Zero, not "fewer": the cache is asked once per run and the vault is not touched per message at all.
    expect(rpcPerMessageCached).toBe(0);
  });

  it("keeps a full page inside the ceiling it was sized against", () => {
    /*
     * `export.page_size` is derived rather than measured, so this is arithmetic over receipts. Checked
     * against the **Free** ceiling for `reseal.batch_size`'s reason: it is the smaller of the two and the
     * Node cannot tell which plan it is on (#68).
     *
     * The fixed 5 per page is the recheck (1 for the export row and its live approval, 2 for the
     * `ediscovery.export` lookup), the page query and the checkpoint. Written out rather than folded into a
     * budget of its own, because it does not scale with anything and a figure that never moves is a figure
     * nobody should have to maintain a receipt for.
     */
    const fixedPerPage = 5;
    const worstPage = BUDGETS["export.page_size"] * BUDGETS["export.subrequests_per_message_cached"]
      + fixedPerPage;
    expect(worstPage).toBeLessThan(BUDGETS["doctor.free.max_subrequests"]);
    // And the recheck is a rounding error at this page size rather than a third of the budget, which is the
    // argument for not sizing the page smaller — §7 makes the recheck non-negotiable.
    expect(fixedPerPage / worstPage).toBeLessThan(0.05);
  });
});
