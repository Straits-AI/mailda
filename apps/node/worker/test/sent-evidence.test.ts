import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { utf8 } from "@mailda/evidence";

import { putEvidence } from "../src/evidence-store.ts";
import { placeHold } from "../src/holds.ts";
import { cancelSend, dispatchOne } from "../src/outbound/dispatch.ts";
import { sealManifest, sentObjectKey, sentPrefix } from "../src/outbound/manifest.ts";
import { formatReconcile, reconcileEvidence, scanSentObjects } from "../src/reconcile.ts";
import type { SubmitOutcome, TransportAdapter } from "../src/outbound/transport.ts";

/**
 * `${orgId}/sent/`: the fourth prefix, its referent rule, and what it grows to (#74).
 *
 * ## What was invisible
 *
 * A send stages three objects — `typed.txt` and `normalized.txt` at seal, `submitted.eml` at hand-over. The
 * reconciler listed `raw/`, `drafts/` and `exports/` and this prefix was listed by nothing, which is #67's
 * defect in a second place: a prefix outside every scan, whose cost was invisible precisely because nothing
 * reported it. It was *reported* from #65 onward — `scanned.prefixes` named what was listed and
 * `formatReconcile` said the rest was neither counted nor collectable — and reported is not repaired.
 *
 * ## What this file pins
 *
 * The referent rule, which is the decision #74 was filed to take: an object here belongs to a
 * `send_manifests` row keyed by the id in the key's **second segment**, so three objects resolve to one row.
 * Concretely — an unreferenced object is collected past the grace window; a referenced one is never touched;
 * a **cancelled** send's objects are never touched, because `cancelSend` keeps the row and therefore the
 * reference; a legal hold suppresses collection org-wide (#64) while still enumerating; and the bounded
 * referent read spares *every* live manifest rather than the first one.
 *
 * It also measures the growth nobody had measured, which is the second half of the ticket: how many objects
 * and how many stored bytes one send adds under this prefix, and what a cancelled send leaves.
 */

const testEnv = env as unknown as Env;
const ORG = "org_sentev";
const MAILBOX = "mbx_sentev";
const ADDRESS = "support@sentev.example";
const AUTHOR = "usr_sentev";
const ADMIN = "usr_sentev_admin";

const SEALED_AT = 2_500_000_000_000;
const DUE_AT = SEALED_AT + (BUDGETS["send.hold_window_default_seconds"] + 1) * 1000;

const composition = {
  mailboxId: MAILBOX,
  authorUserId: AUTHOR,
  to: ["customer@example.net"],
  subject: "Re: Invoice 4500219877",
  bodyTyped: "We have revised the schedule.   \r\nBest,\nSupport",
  fidelity: "authored" as const,
};

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

/**
 * Past the grace window measured against the **real** clock, not against the fixture's frozen instant.
 *
 * `uploaded` on an R2 object is stamped by the runtime, so a cutoff derived from `SEALED_AT` — which is in
 * 2049 — would put every object inside the window and every assertion below would pass for the wrong reason.
 * `ediscovery-export.test.ts` records the same trap on the same pass.
 */
function afterTheGraceWindow(): Ctx {
  return atTime(Date.now() + (BUDGETS["reconcile.orphan_grace_seconds"] + 60) * 1000);
}

function fakeTransport(outcome: SubmitOutcome): TransportAdapter {
  return {
    name: "fake",
    async capability() {
      return { canSend: true, arbitraryRecipients: true, verifiedAt: "2026-08-20T00:00:00.000Z", detail: "fake" };
    },
    async submit() {
      return outcome;
    },
  };
}

/** Every object staged under this organization's send prefix, by key. */
async function sentObjects(): Promise<{ key: string; size: number }[]> {
  const listed = await testEnv.EVIDENCE.list({ prefix: sentPrefix(ORG) });
  return listed.objects
    .map((object) => ({ key: object.key, size: object.size }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** A send sealed and handed over: the full three-object shape. */
async function aHandedOverSend(): Promise<string> {
  const sealed = await sealManifest(testEnv, atTime(SEALED_AT), ORG, composition);
  await dispatchOne(
    testEnv, atTime(DUE_AT), ORG, sealed.id,
    fakeTransport({ kind: "handed_over", transportMessageId: `cf-${sealed.id}` }),
  );
  return sealed.id;
}

/**
 * What a lost transaction leaves: the objects `sealManifest` writes before its `INSERT`, and no row.
 *
 * Written through `putEvidence` with the key `sentObjectKey` produces, so the fixture is the real artifact
 * rather than a plausible-looking one — the same reason `stranded-draft-bodies.test.ts` builds its residue
 * through `bodyKeyFor`.
 */
async function anOrphanedSend(manifestId: string): Promise<string[]> {
  const keys: string[] = [];
  for (const name of ["typed.txt", "normalized.txt", "submitted.eml"]) {
    const stored = await putEvidence(testEnv, sentObjectKey(ORG, manifestId, name), utf8("staged bytes"));
    keys.push(stored.blobKey);
  }
  return keys;
}

/** The same Node whose `send_manifests` read refuses — the referent half of the scan, not the listing half. */
function withUnreadableManifests(): Env {
  const catalog = new Proxy(testEnv.CATALOG, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes("FROM send_manifests")) return statement;
          return new Proxy(statement, {
            get(stmtTarget, stmtProperty) {
              if (stmtProperty === "bind") {
                return () => ({ all: () => Promise.reject(new Error("no such table: send_manifests")) });
              }
              const value = Reflect.get(stmtTarget, stmtProperty) as unknown;
              return typeof value === "function"
                ? (value as (...a: unknown[]) => unknown).bind(stmtTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...testEnv, CATALOG: catalog } as Env;
}

beforeEach(async () => {
  for (const table of ["send_manifests", "send_counters", "send_recipients", "send_recipient_events",
                       "messages", "addresses", "mailboxes", "holds", "relationship_tuples",
                       "audit_entries", "ingress_receipts", "node_claim", "node_capabilities"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await testEnv.EVIDENCE.list({ prefix: `${ORG}/` });
  for (const object of listed.objects) await testEnv.EVIDENCE.delete(object.key);

  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, AUTHOR, "send.propose", "mailbox", MAILBOX, at),
    // `placeHold` is `org.admin` only, and the suppression case below places a real hold rather than
    // inserting a row: the closed world requires `INSERT INTO holds` to live in `src/holds.ts` alone.
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, ADMIN, "org.admin", "organization", ORG, at),
  ]);
});

describe("the referent rule for the fourth prefix (#74)", () => {
  it("collects a staged object whose send_manifests row is gone, past the grace window", async () => {
    const keys = await anOrphanedSend("snd_00000000000000000000000001");

    const report = await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG, { collect: true });
    expect(report.sentObjectsDeleted, "three objects, one absent manifest").toBe(3);
    for (const key of keys) expect(await testEnv.EVIDENCE.head(key)).toBeNull();
  });

  it("enumerates it without deleting when collection was not asked for, which is doctor's mode", async () => {
    const keys = await anOrphanedSend("snd_00000000000000000000000001");

    const report = await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG);
    expect(report.sentObjects.read).toBe("complete");
    if (report.sentObjects.read !== "complete") throw new Error("unreachable");
    expect(report.sentObjects.stranded.map((object) => object.blobKey).sort()).toEqual([...keys].sort());
    expect(report.sentObjectsDeleted).toBe(0);
    for (const key of keys) expect(await testEnv.EVIDENCE.head(key)).not.toBeNull();
  });

  it("never touches a handed-over send's evidence, asked to collect and long past the window", async () => {
    // §12 invariant 2 calls the typed body, the normalized body and the submitted bytes immutable evidence.
    // Getting this rule wrong does not cost storage: it destroys the record of what this Node sent.
    const manifestId = await aHandedOverSend();
    const before = await sentObjects();
    expect(before, "seal writes two objects and hand-over a third").toHaveLength(3);

    const ctx = afterTheGraceWindow();
    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.sentObjects.read).toBe("complete");
    if (report.sentObjects.read !== "complete") throw new Error("unreachable");
    // The trap this repository has been bitten by: a fixture spared by a filter other than the one under
    // test. Nothing here may be spared for being too fresh — the referent is what has to be doing the work.
    expect(report.sentObjects.tooFreshToJudge, "spared by the referent, not by the clock").toBe(0);
    expect(report.sentObjects.examined).toBe(3);
    expect(report.sentObjects.stranded).toEqual([]);
    expect(report.sentObjectsDeleted).toBe(0);
    expect(await sentObjects()).toEqual(before);
    expect(manifestId).toMatch(/^snd_/);
  });

  it("never touches a cancelled send's evidence, because cancelling keeps the row", async () => {
    /*
     * The issue asked for this to be verified rather than relied on, and it is the assumption the whole rule
     * rests on: `cancelSend` moves `state` to `cancelled` and touches neither R2 nor the row's existence. So
     * a send that never went still has its `typed.txt` and `normalized.txt` staged with a **live** manifest
     * pointing at them — referenced, therefore not residue, therefore never collectable by anything.
     */
    const sealed = await sealManifest(testEnv, atTime(SEALED_AT), ORG, composition);
    const cancelled = await cancelSend(testEnv, atTime(SEALED_AT + 1000), ORG, sealed.id);
    expect(cancelled.cancelled, "the fixture has to actually cancel, or this proves nothing").toBe(true);

    const state = await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
      .bind(sealed.id).first<{ state: string }>();
    expect(state?.state, "the row survives cancellation, which is why the objects are referenced")
      .toBe("cancelled");

    const before = await sentObjects();
    expect(before, "a cancelled send keeps both composition bodies and never writes submitted.eml")
      .toHaveLength(2);

    const report = await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG, { collect: true });
    expect(report.sentObjects.read).toBe("complete");
    if (report.sentObjects.read !== "complete") throw new Error("unreachable");
    expect(report.sentObjects.tooFreshToJudge, "spared by the referent, not by the clock").toBe(0);
    expect(report.sentObjects.stranded, "a cancelled send is referenced, not residue").toEqual([]);
    expect(report.sentObjectsDeleted).toBe(0);
    expect(await sentObjects()).toEqual(before);
  });

  it("never judges an object inside the grace window, because the seal writes R2 before its row", async () => {
    // `sealManifest` writes both bodies before the `INSERT`, deliberately, for `ingress.ts`'s reason. So an
    // object legitimately has no row for the width of that gap, and collecting inside it would delete the
    // evidence of a send that is being sealed right now.
    const keys = await anOrphanedSend("snd_00000000000000000000000001");

    const report = await reconcileEvidence(testEnv, createSystemCtx(), ORG, { collect: true });
    expect(report.sentObjects.read).toBe("complete");
    if (report.sentObjects.read !== "complete") throw new Error("unreachable");
    expect(report.sentObjects.tooFreshToJudge).toBe(3);
    expect(report.sentObjectsDeleted).toBe(0);
    for (const key of keys) expect(await testEnv.EVIDENCE.head(key)).not.toBeNull();
  });

  it("treats an object with no second segment as belonging to no manifest rather than skipping it", async () => {
    // A key directly under the prefix names no manifest at all, so it belongs to no row by definition.
    // Skipping it would leave an object this pass can see and never collect, which is the shape #67 filed.
    const stored = await putEvidence(testEnv, `${sentPrefix(ORG)}loose.txt`, utf8("no manifest here"));

    const report = await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG, { collect: true });
    expect(report.sentObjectsDeleted).toBe(1);
    expect(await testEnv.EVIDENCE.head(stored.blobKey)).toBeNull();
  });

  it("spares every live manifest, not just the first, because the referent read spans the page", async () => {
    /*
     * The mutation guard for the bounded referent read. `scanSentObjects` reads
     * `WHERE org_id = ? AND id >= ? AND id <= ?` over the smallest and largest manifest id in the page, and
     * the claim is that this can never return a *partial* set of the referents that matter. A read that
     * answered for one manifest — `LIMIT 1`, or a range collapsed to `ids[0]` at both ends — would report a
     * live send's evidence as stranded and, under `collect`, delete it.
     *
     * Three live sends and one residue, for `stranded-draft-bodies.test.ts`'s reason and with its boundary:
     * this fails for any read that answers for fewer than three manifests, and it cannot prove the absence of
     * a limit, because a larger one needs a larger fixture. Three is past the plurality every realistic
     * regression shows up at, and the residue's id is deliberately **lower** than all three so a range
     * anchored at the wrong end is caught rather than accommodated.
     */
    const live: string[] = [];
    for (let index = 0; index < 3; index++) live.push(await aHandedOverSend());
    const residue = await anOrphanedSend("snd_00000000000000000000000001");
    // The ids really are ordered the way this fixture assumes, or the "wrong end" argument above is empty.
    expect([...live].sort()[0]! > "snd_00000000000000000000000001").toBe(true);

    const report = await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG, { collect: true });
    expect(report.sentObjects.read).toBe("complete");
    if (report.sentObjects.read !== "complete") throw new Error("unreachable");
    // The accusation, before the deletion: a live manifest's evidence named as stranded is already the whole
    // bug, and the read-only pass `doctor` performs would report it where no delete follows.
    expect(report.sentObjects.stranded.map((object) => object.blobKey).sort()).toEqual([...residue].sort());
    expect(report.sentObjectsDeleted).toBe(3);
    expect(await sentObjects(), "nine objects for three live sends, and nothing else").toHaveLength(9);
  });

  it("counts the send rule apart from the export rule, which shares its key shape", async () => {
    // Same shape of key, different table, different meaning. A single total would tell an operator that
    // *something* is missing without saying whether it is an investigator's copy or the evidence of what this
    // Node sent — #67's argument, three prefixes along.
    await anOrphanedSend("snd_00000000000000000000000001");
    await putEvidence(testEnv, `${ORG}/exports/exp_gone/manifest.json`, utf8("{}"));

    const report = await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG, { collect: true });
    expect(report.sentObjectsDeleted).toBe(3);
    expect(report.exportObjectsDeleted).toBe(1);
    expect(report.orphansDeleted).toBe(0);
    expect(report.draftBodiesDeleted).toBe(0);
  });

  it("is the function the pass calls, judging the objects it reports", async () => {
    await aHandedOverSend();
    const residue = await anOrphanedSend("snd_00000000000000000000000001");
    const ctx = afterTheGraceWindow();

    const direct = await scanSentObjects(testEnv, ctx, ORG);
    expect(direct.read).toBe("complete");
    if (direct.read !== "complete") throw new Error("unreachable");
    expect(direct.stranded.map((object) => object.blobKey).sort()).toEqual([...residue].sort());
    expect((await reconcileEvidence(testEnv, ctx, ORG)).sentObjects).toEqual(direct);
  });
});

describe("a legal hold suppresses send-evidence collection org-wide (#64, #74)", () => {
  const AUGUST_10 = Date.parse("2026-08-10T09:00:00.000Z");

  it("enumerates the residue and leaves the bytes in place", async () => {
    /*
     * **#64's rule, deliberately re-argued rather than inherited, because this key looks more attributable.**
     *
     * A `sent/` orphan carries a manifest id, which a `raw/` orphan does not — so the tempting move is a
     * per-hold check. It is unavailable for the same reason as everywhere else on this pass: the mailbox lives
     * in `send_manifests.mailbox_id`, and the absence of that row is the definition of the state. The id in
     * the key names a record that is gone, so it resolves to no mailbox, and nothing can prove the object is
     * not responsive. Org-wide, unchanged, neither widened nor narrowed.
     */
    const keys = await anOrphanedSend("snd_00000000000000000000000001");
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: MAILBOX });

    const report = await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG, { collect: true });
    expect(report.collection).toEqual({ requested: true, suppressed: true });
    expect(report.sentObjectsDeleted, "a suppressed pass deletes nothing").toBe(0);
    expect(report.sentObjects.read).toBe("complete");
    if (report.sentObjects.read !== "complete") throw new Error("unreachable");
    expect(report.sentObjects.stranded, "still enumerated").toHaveLength(3);
    for (const key of keys) expect(await testEnv.EVIDENCE.head(key)).not.toBeNull();
  });

  it("counts the withheld send objects in the line an operator reads", async () => {
    // Suppression nobody can see is indistinguishable from a reconciler that has stopped working, and the
    // held count has to include these or the line understates what is being preserved.
    await anOrphanedSend("snd_00000000000000000000000001");
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: MAILBOX });

    const text = formatReconcile(await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG, { collect: true }));
    expect(text).toContain("HELD      3 collectable object(s) not collected");
  });

  it("collects when nothing is held, so the suppression is the hold and not the code path", async () => {
    const keys = await anOrphanedSend("snd_00000000000000000000000001");

    const report = await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG, { collect: true });
    expect(report.collection).toEqual({ requested: true, suppressed: false });
    expect(report.sentObjectsDeleted).toBe(3);
    for (const key of keys) expect(await testEnv.EVIDENCE.head(key)).toBeNull();
  });
});

describe("the report names the fourth prefix and stops hedging about it", () => {
  it("prints a line of its own, naming the referent table", async () => {
    await anOrphanedSend("snd_00000000000000000000000001");

    const text = formatReconcile(await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG));
    expect(text).toContain("sent      3 staged object(s) with no send_manifests row");
    expect(text).toContain(`examined under ${sentPrefix(ORG)}`);
  });

  it("claims the reported set is complete instead of hedging about what it skipped", async () => {
    // The sentence changed with the fourth prefix, and a sentence describing a state the code has left is the
    // defect this whole thread is about. `test/node/evidence-prefix-world.test.ts` is what makes the new,
    // stronger claim checkable rather than a nicer paragraph.
    const text = formatReconcile(await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG));
    expect(text).toContain(`${sentPrefix(ORG)} — every prefix this Worker writes for this organization`);
    expect(text, "the old hedge, which the fourth prefix made false")
      .not.toContain("objects under any other prefix were not listed");
  });

  it("reports a prefix it could not read instead of counting zero under it", async () => {
    // The whole of #67 and #74 in one assertion: a prefix nobody could read must not contribute a `0`.
    await anOrphanedSend("snd_00000000000000000000000001");

    const report = await reconcileEvidence(withUnreadableManifests(), afterTheGraceWindow(), ORG, { collect: true });
    expect(report.sentObjects.read).toBe("unreadable");
    if (report.sentObjects.read !== "unreadable") throw new Error("unreachable");
    expect(report.sentObjects.because, "the cause, not just the symptom").toContain("no such table");
    expect(report.sentObjectsDeleted).toBe(0);
    expect(formatReconcile(report)).toContain(`UNREAD    ${sentPrefix(ORG)} could not be read`);
  });

  it("still reports lost mail when the send prefix will not answer", async () => {
    // Why the failure is caught rather than thrown: direction 2 is produced by nothing else in this Node, and
    // losing it because a fourth prefix would not answer trades the serious finding for the cheap one.
    //
    // The residue is part of the fixture rather than decoration: an **empty** page asks the referent table
    // nothing at all — the minimum of no ids does not exist — so a Node with no staged objects reaches
    // `complete` however broken the catalog is, and this test would pass without exercising the branch.
    await anOrphanedSend("snd_00000000000000000000000001");
    await testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
         raw_bytes, blob_key, blob_sha256, accepted_at, key_generation) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind("igr_lost", ORG, "igr_lost", "a@b.com", "c@d.com", 7, `${ORG}/raw/gone.eml`,
      "0".repeat(64), new Date(Date.now()).toISOString(), 1).run();

    const report = await reconcileEvidence(withUnreadableManifests(), afterTheGraceWindow(), ORG);
    expect(report.sentObjects.read).toBe("unreadable");
    expect(report.missing.map((entry) => entry.receiptId)).toEqual(["igr_lost"]);
  });

  it("counts every object it lists, so the reported prefixes cannot outrun the scan", async () => {
    await aHandedOverSend();

    const report = await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG);
    let listedAcrossPrefixes = 0;
    for (const prefix of report.scanned.prefixes) {
      listedAcrossPrefixes += (await testEnv.EVIDENCE.list({ prefix })).objects.length;
    }
    expect(report.scanned.objects).toBe(listedAcrossPrefixes);
    expect(report.scanned.objects, "one send, three objects, no other prefix populated").toBe(3);
  });
});

/**
 * How much `sent/` grows relative to mail sent — **measured**, because it had no answer (#74).
 *
 * It matters for a reason no other prefix has: these objects are *referenced* for the life of the manifest
 * row, nothing deletes a manifest row, and two of the three are the composition evidence §12 invariant 2
 * calls immutable. So the reconciler cannot collect them and is not supposed to. A Node that composes heavily
 * and sends rarely accumulates staged bytes for ever, and the growth is **unreported** — no check, no meter,
 * no figure anywhere names it.
 *
 * Measured here rather than derived from the source, because a figure read off code is a hypothesis: the
 * stored size is the *sealed* size, which carries a frame header the plaintext length does not predict.
 *
 * The finding is recorded in `docs/receipts/evidence-lifecycle.md` and filed as **#76** rather than as a
 * footnote, which is what the growth being unbounded and unreported earns.
 */
describe("what one send costs under the fourth prefix, measured", () => {
  it("stages three objects per handed-over send, and the count does not depend on recipients", async () => {
    await aHandedOverSend();
    const one = await sentObjects();
    expect(one.map((object) => object.key.split("/").pop())).toEqual(
      ["normalized.txt", "submitted.eml", "typed.txt"],
    );

    await aHandedOverSend();
    const two = await sentObjects();
    expect(two, "linear in sends: three more objects, not four and not one").toHaveLength(6);

    const perSend = two.reduce((sum, object) => sum + object.size, 0)
      - one.reduce((sum, object) => sum + object.size, 0);
    const plaintext = composition.bodyTyped.length;
    // The per-object framing cost, isolated by differencing against a plaintext this test knows exactly.
    // It is the term that makes the growth body-independent, and therefore the term the receipt needs: three
    // objects per send cost this much before a single byte of anybody's message.
    const typed = one.find((object) => object.key.endsWith("typed.txt"))!;
    const frameOverhead = typed.size - plaintext;
    // Printed, not asserted to a literal: the number goes in the receipt and the receipt says the method.
    // Asserting a byte count here would pin a figure that legitimately moves with the frame format, and
    // `evidence-lifecycle.md` is where a moved figure gets re-measured rather than silently re-asserted.
    console.log(
      `MEASURE sent/ objects_per_send=3 stored_bytes_per_send=${perSend} `
      + `typed_plaintext_bytes=${plaintext} typed_stored_bytes=${typed.size} `
      + `frame_overhead_bytes_per_object=${frameOverhead} total_objects=${two.length} `
      + `total_stored_bytes=${two.reduce((sum, object) => sum + object.size, 0)}`,
    );

    // What is asserted is the shape the receipt's argument rests on: the growth is linear in sends and the
    // stored cost is dominated by per-object framing rather than by the body, which is why a Node that
    // composes short messages heavily still accumulates.
    expect(perSend).toBeGreaterThan(plaintext);
  });

  it("leaves two of the three staged for a cancelled send, referenced and therefore never collectable", async () => {
    const sealed = await sealManifest(testEnv, atTime(SEALED_AT), ORG, composition);
    await cancelSend(testEnv, atTime(SEALED_AT + 1000), ORG, sealed.id);

    const staged = await sentObjects();
    const bytes = staged.reduce((sum, object) => sum + object.size, 0);
    console.log(
      `MEASURE sent/ cancelled_send objects=${staged.length} stored_bytes=${bytes} `
      + `keys=${staged.map((object) => object.key.split("/").pop()).join(",")}`,
    );

    expect(staged).toHaveLength(2);
    // The reason the figure matters: this is what a send that never went costs, for ever, with nothing able
    // to collect it — the manifest row that references it is never deleted by anything in this product.
    const report = await reconcileEvidence(testEnv, afterTheGraceWindow(), ORG, { collect: true });
    expect(report.sentObjectsDeleted).toBe(0);
    expect(await sentObjects()).toHaveLength(2);
  });
});

/**
 * What the fourth prefix costs the pass, **metered** — `docs/receipts/evidence-lifecycle.md`'s figures.
 *
 * Same instrument and the same boundary as the 19 and 20 August tables in that receipt: `metering()` around
 * one `reconcileEvidence` call under `vitest-pool-workers`, against **miniflare** — a local SQLite and a local
 * R2, so what is counted is the number of operations Mailda performs, which is what the subrequest budget is
 * spent in, and not their latency.
 *
 * Kept as a test rather than run once and written down, because the claim it establishes is the one the
 * `list_limit` arithmetic rests on: this scan is **flat** in the number of objects. A regression to a
 * per-object referent lookup — the shape the raw direction has — would take the worst case from
 * `(n + 2) × list_limit` to `(n + 3) × list_limit` and straight over the Free ceiling, and it would be
 * invisible in any ordinary pass, which has a handful of objects rather than 600.
 */
describe("what the fourth prefix costs the pass, metered", () => {
  it("is flat in the number of staged objects, which is what the list_limit arithmetic assumes", async () => {
    const { metering } = await import("../src/cost-meter.ts");
    const ctx = afterTheGraceWindow();

    const empty = metering(testEnv);
    await scanSentObjects(empty.env, ctx, ORG);

    await anOrphanedSend("snd_00000000000000000000000001");
    await anOrphanedSend("snd_00000000000000000000000002");
    const populated = metering(testEnv);
    const scan = await scanSentObjects(populated.env, ctx, ORG);
    expect(scan.read).toBe("complete");
    if (scan.read !== "complete") throw new Error("unreachable");
    // The fixture is doing work, or "flat" would be a statement about two empty listings.
    expect(scan.examined).toBe(6);

    console.log(
      `MEASURE scanSentObjects objects=0 subrequests=${empty.cost.subrequests} `
      + `d1=${empty.cost.d1Executions} r2=${empty.cost.r2Operations}`,
    );
    console.log(
      `MEASURE scanSentObjects objects=6 manifests=2 subrequests=${populated.cost.subrequests} `
      + `d1=${populated.cost.d1Executions} r2=${populated.cost.r2Operations}`,
    );

    // One `list` and nothing else on an empty prefix: the minimum of no ids does not exist, so there is
    // nothing to ask the referent table.
    expect(empty.cost.subrequests).toBe(1);
    expect(empty.cost.r2Operations).toBe(1);
    expect(empty.cost.d1Executions).toBe(0);
    // One `list` and **one** referent query for six objects across two manifests — not one query per object
    // and not one per manifest. This is the assertion the arithmetic's `bulk referents: n − 1` term is.
    expect(populated.cost.subrequests).toBe(2);
    expect(populated.cost.r2Operations).toBe(1);
    expect(populated.cost.d1Executions).toBe(1);
  });

  it("prices a whole pass, read-only and collecting, so the receipt's table is re-runnable", async () => {
    const { metering } = await import("../src/cost-meter.ts");
    const ctx = afterTheGraceWindow();
    await anOrphanedSend("snd_00000000000000000000000001");

    const readOnly = metering(testEnv);
    await reconcileEvidence(readOnly.env, ctx, ORG);
    console.log(
      `MEASURE reconcileEvidence prefixes=4 sent_stranded=3 mode=read-only `
      + `subrequests=${readOnly.cost.subrequests} d1=${readOnly.cost.d1Executions} `
      + `r2=${readOnly.cost.r2Operations}`,
    );

    const collecting = metering(testEnv);
    const report = await reconcileEvidence(collecting.env, ctx, ORG, { collect: true });
    expect(report.sentObjectsDeleted, "the collecting arm must actually delete, or its figure is the other one")
      .toBe(3);
    console.log(
      `MEASURE reconcileEvidence prefixes=4 sent_stranded=3 mode=collect `
      + `subrequests=${collecting.cost.subrequests} d1=${collecting.cost.d1Executions} `
      + `r2=${collecting.cost.r2Operations}`,
    );

    // `collect` costs the hold check plus one R2 delete per collected object, and nothing else (#64).
    expect(collecting.cost.subrequests - readOnly.cost.subrequests).toBe(1 + 3);
    expect(collecting.cost.d1Executions - readOnly.cost.d1Executions, "anyActiveHold, once per pass").toBe(1);
  });
});
