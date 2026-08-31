import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { utf8 } from "@mailda/evidence";

import { putEvidence, sha256Hex } from "../src/evidence-store.ts";
import { verifyEvidence } from "../src/evidence-audit.ts";

/**
 * Does the verifier notice? (#92)
 *
 * ## Why the negative cases are the whole file
 *
 * A verifier that returns `intact: true` is easy to write and impossible to trust — the failure mode of one
 * is not a crash, it is a clean bill of health over evidence that is gone. So every test below **breaks
 * something specific** and requires the report to name it: the receipt id, and which of the three ways it
 * failed.
 *
 * #92's own words about the step this implements: *"Step 5 is the one that makes the rest true. An export
 * nobody has restored is a claim, and this ticket exists because of a claim."* A verifier nobody has shown
 * failing is the same claim one layer along.
 */

const ORG = "org_evidence_audit";
const ctx = createSystemCtx();

/** A receipt whose recorded hash is the **real** one, which is what makes an `altered` finding meaningful. */
async function seedReceipt(body: string): Promise<{ id: string; blobKey: string; sha: string }> {
  const id = ctx.id("rcpt");
  const blobKey = `${ORG}/raw/${id}.eml`;
  const raw = utf8(["From: someone@example.test", `Subject: ${body}`, "", body].join("\r\n"));
  const stored = await putEvidence(testEnv, blobKey, raw);
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
       raw_bytes, blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, ORG, `evt_${id}`, "someone@example.test", "inbox@example.test", raw.byteLength,
      blobKey, stored.plaintextSha256, new Date(ctx.now()).toISOString())
    .run();
  return { id, blobKey, sha: stored.plaintextSha256 };
}

beforeEach(async () => {
  await testEnv.CATALOG.prepare("DELETE FROM ingress_receipts WHERE org_id = ?").bind(ORG).run();
});

describe("verifying stored evidence against what ingress recorded", () => {
  it("passes over evidence that is intact, and says how much it read", async () => {
    await seedReceipt("one");
    await seedReceipt("two");

    const verdict = await verifyEvidence(testEnv, ORG);

    expect(verdict.intact).toBe(true);
    expect(verdict.faults).toEqual([]);
    /*
     * Non-vacuity, and it is the assertion that matters most here: `intact: true` over zero receipts is what
     * a broken query returns, and it reads identically to a healthy Node.
     */
    expect(verdict.checked).toBe(2);
    expect(verdict.bytesRead).toBeGreaterThan(0);
  });

  it("reports an object that is gone as missing, and keeps going", async () => {
    /*
     * **Two** deletions, with an intact message between them, and that is the point of the fixture rather
     * than thoroughness. The first version of this test broke one object out of two and asserted one fault —
     * which a verifier that stopped at the first fault also satisfies. Mutating the loop to `break` on a
     * fault left it green: `checked` came from the page size, and one fault is one fault either way.
     *
     * With two, an early stop reports one and the count drops. That is the difference between asserting the
     * verifier found a fault and asserting it kept looking.
     */
    const first = await seedReceipt("deleted from the bucket");
    await seedReceipt("still here");
    const second = await seedReceipt("also deleted");
    await testEnv.EVIDENCE.delete(first.blobKey);
    await testEnv.EVIDENCE.delete(second.blobKey);

    const verdict = await verifyEvidence(testEnv, ORG);

    expect(verdict.intact).toBe(false);
    expect(verdict.faults.map((one) => one.receiptId).sort()).toEqual([first.id, second.id].sort());
    expect(verdict.faults.every((one) => one.kind === "missing")).toBe(true);
    /*
     * All three examined. `verifyChain` stops at the first break because a hash chain after one is
     * meaningless; evidence objects are independent, so stopping here would report one lost message and hide
     * however many follow — and the count is the first thing an operator needs.
     */
    expect(verdict.checked).toBe(3);
  });

  it("reports every object whose bytes changed as altered, naming both hashes", async () => {
    /*
     * **Two** tampered objects with an intact one between them, for the reason the missing test gives: a
     * single fault is found by a verifier that stops at the first, so one fixture cannot distinguish "found
     * it" from "kept looking". Mutating the altered branch to `break` survived the one-fixture version, and
     * survived the missing test too — the kinds take different paths through the loop, so each needs its own
     * pair.
     */
    const first = await seedReceipt("the original");
    await seedReceipt("untouched");
    const second = await seedReceipt("also original");

    /*
     * Re-sealed under the Node's own key with different content — which is the hard case, and the reason
     * `blob_sha256` is the hash of the **plaintext** rather than of the stored bytes. Anybody who can write
     * to the bucket can produce a well-formed object that decrypts perfectly; only the recorded plaintext
     * hash catches it. A ciphertext hash would have called this intact.
     */
    await putEvidence(testEnv, first.blobKey, utf8("not the original"));
    await putEvidence(testEnv, second.blobKey, utf8("nor is this"));

    const verdict = await verifyEvidence(testEnv, ORG);

    expect(verdict.intact).toBe(false);
    expect(verdict.faults.map((one) => one.receiptId).sort()).toEqual([first.id, second.id].sort());
    expect(verdict.faults.every((one) => one.kind === "altered")).toBe(true);
    expect(verdict.checked).toBe(3);
    // The detail carries both hashes, so an investigation starts from the report rather than from a re-run.
    const reported = verdict.faults.find((one) => one.receiptId === first.id);
    expect(reported?.detail).toContain(first.sha.slice(0, 16));
  });

  it("reports an object it cannot open as unreadable rather than treating the error as a pass", async () => {
    const broken = await seedReceipt("will not open");

    /*
     * Written straight to R2 with no frame header and no key generation. This is what a truncated object and
     * an object sealed under a lost generation both look like to a reader — the ADR 28 loss the escrow
     * exists for — and the direction that matters is that a decrypt failure must not be swallowed. A verifier
     * that treats a thrown error as "checked, fine" is worse than none.
     */
    await testEnv.EVIDENCE.put(broken.blobKey, new Uint8Array(16));

    const verdict = await verifyEvidence(testEnv, ORG);

    expect(verdict.intact).toBe(false);
    expect(verdict.faults[0]?.kind).toBe("unreadable");
    expect(verdict.faults[0]?.receiptId).toBe(broken.id);
  });

  it("does not confuse one organization's evidence with another's", async () => {
    await seedReceipt("ours");
    const other = ctx.id("rcpt");
    await testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
         raw_bytes, blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    )
      .bind(other, "org_somebody_else", `evt_${other}`, "a@b.test", "c@d.test", 10,
        "org_somebody_else/raw/nothing.eml", "0".repeat(64), new Date(ctx.now()).toISOString())
      .run();

    const verdict = await verifyEvidence(testEnv, ORG);

    // The other organization's receipt points at an object that does not exist, so a leak shows up as a
    // fault rather than as a silently wider sweep — which is why this assertion is worth making here.
    expect(verdict.checked).toBe(1);
    expect(verdict.intact).toBe(true);
  });

  it("stops at the batch bound and says where to resume", async () => {
    /*
     * The bound is what keeps a sweep inside one invocation's subrequest budget
     * (`docs/receipts/evidence-integrity-cost.md`). Read from the receipt rather than restated, so the test
     * cannot disagree with the number the route enforces.
     */
    const batch = BUDGETS["evidence.verify_batch"];
    expect(batch).toBeGreaterThan(1);

    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await seedReceipt(`m${i}`)).id);
    ids.sort();

    /*
     * Rather than seeding two hundred messages to reach the real bound — which would make this the slowest
     * test in the suite for no extra property — resumption is driven directly: page one is asked for from the
     * beginning, and page two from after the first id. What is being checked is that `after` is honoured and
     * that the cursor advances, which is the part a caller depends on.
     */
    const all = await verifyEvidence(testEnv, ORG);
    expect(all.checked).toBe(3);
    // A short page is the end. Reporting a cursor here would loop a sweeping caller for ever.
    expect(all.resumeAfter).toBeNull();

    const resumed = await verifyEvidence(testEnv, ORG, ids[0]);
    expect(resumed.after).toBe(ids[0]);
    expect(resumed.checked).toBe(2);
    expect(resumed.intact).toBe(true);

    /*
     * A **full** page, through the batch seam, and this is the branch no other test reaches. Forcing
     * `resumeAfter` to null passed everything above, because three messages never fill a page of two hundred
     * and a short page correctly ends a sweep — so the decision to *continue* was untested. Two of three,
     * then the remainder, is the whole property a sweeping caller depends on.
     */
    const page = await verifyEvidence(testEnv, ORG, null, 2);
    expect(page.checked).toBe(2);
    expect(page.resumeAfter).toBe(ids[1]);

    const rest = await verifyEvidence(testEnv, ORG, page.resumeAfter, 2);
    expect(rest.checked).toBe(1);
    expect(rest.resumeAfter).toBeNull();
    // Every message reached exactly once across the two pages, which is what makes a paged sweep complete.
    expect(page.checked + rest.checked).toBe(3);
  });

  it("has nothing to say about a Node with no evidence, and says that rather than passing", async () => {
    const verdict = await verifyEvidence(testEnv, ORG);
    expect(verdict.checked).toBe(0);
    expect(verdict.resumeAfter).toBeNull();
    /*
     * `intact: true` with `checked: 0` is honest — there is nothing that fails — and it is exactly why every
     * other test here asserts `checked` as well. A caller reading only `intact` cannot tell a healthy Node
     * from a query that matched nothing, so the field is in the response for that caller's benefit.
     */
    expect(verdict.intact).toBe(true);
  });

  it("hashes the plaintext, so a re-seal under a new key does not read as tampering", async () => {
    /*
     * The property that makes the whole check survive ADR 28's key rotation. `reseal.ts` rewrites every
     * object under a new generation; if the recorded hash were of the stored bytes, a completed re-seal would
     * mark every message in the Node as altered — a verifier that fails after correct maintenance is a
     * verifier that gets switched off.
     */
    const receipt = await seedReceipt("unchanged content");
    const raw = utf8(
      ["From: someone@example.test", "Subject: unchanged content", "", "unchanged content"].join("\r\n"),
    );
    expect(await sha256Hex(raw)).toBe(receipt.sha);

    // Sealed again — new nonces, different ciphertext, same plaintext.
    await putEvidence(testEnv, receipt.blobKey, raw);

    const verdict = await verifyEvidence(testEnv, ORG);
    expect(verdict.intact).toBe(true);
    expect(verdict.checked).toBe(1);
  });
});
