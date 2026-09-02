import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { utf8 } from "@mailda/evidence";

import { putEvidence, sha256Hex } from "../src/evidence-store.ts";
import { VERIFIED_TABLES, verifyEvidence } from "../src/evidence-audit.ts";
import { INVENTORY_REFERENTS } from "../src/evidence-inventory.ts";

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
  // Every table the verifier sweeps, not only the one the original tests seeded — a leftover draft would
  // otherwise be counted by a receipts test and read as the verifier checking more than it was given.
  for (const table of ["ingress_receipts", "drafts", "exports", "send_manifests"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table} WHERE org_id = ?`).bind(ORG).run();
  }
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
    expect(verdict.faults.map((one) => one.rowId).sort()).toEqual([first.id, second.id].sort());
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
    expect(verdict.faults.map((one) => one.rowId).sort()).toEqual([first.id, second.id].sort());
    expect(verdict.faults.every((one) => one.kind === "altered")).toBe(true);
    expect(verdict.checked).toBe(3);
    // The detail carries both hashes, so an investigation starts from the report rather than from a re-run.
    const reported = verdict.faults.find((one) => one.rowId === first.id);
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
    expect(verdict.faults[0]?.rowId).toBe(broken.id);
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
    const batch = BUDGETS["evidence.verify_objects"];
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
    /*
     * A short page ends **this table** and hands on to the next, which is the #131 correction: returning null
     * because receipts ran out would report drafts, exports and sends as verified without opening one.
     */
    expect(all.resumeAfter).toBe("1:");

    /*
     * The cursor is `<table index>:<row id>` since #131 — a bare id would be ambiguous across four tables,
     * and resuming in the wrong one is how a sweep silently skips evidence. `ingress_receipts` is index 0.
     */
    const resumed = await verifyEvidence(testEnv, ORG, `0:${ids[0]}`);
    expect(resumed.after).toBe(`0:${ids[0]}`);
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
    expect(page.resumeAfter).toBe(`0:${ids[1]}`);

    const rest = await verifyEvidence(testEnv, ORG, page.resumeAfter, 2);
    expect(rest.checked).toBe(1);
    // Receipts are exhausted, so it hands on rather than ending — the tables after this one are unswept.
    expect(rest.resumeAfter).toBe("1:");
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

/**
 * The prefixes that were never swept (#131).
 *
 * ## What this file could not see before
 *
 * Every test above seeds `ingress_receipts`, so every one of them passed while the verifier covered inbound
 * mail alone — and the inventory next door covered all four prefixes. A Node whose evidence is drafts or
 * staged sends verified nothing and reported a clean sweep, which is every Node before its domain is bound.
 *
 * Measured on the first real backup: three sealed drafts, `3 object(s) listed`, `0 checked, 0 fault(s)`.
 *
 * So these tests seed **only** the other tables. A verifier that still reads receipts alone fails them by
 * checking zero, which is the state that used to look like health.
 */
describe("every prefix the Worker writes, not only inbound mail", () => {
  /** Everything the sweep can reach, paged to the end the way a real caller does. */
  async function sweep(batch?: number) {
    const faults = [];
    const tables: string[] = [];
    let checked = 0;
    let after: string | null = null;
    for (let page = 0; page < 40; page += 1) {
      const verdict = await verifyEvidence(testEnv, ORG, after, batch);
      checked += verdict.checked;
      faults.push(...verdict.faults);
      if (verdict.table !== null && verdict.checked > 0) tables.push(verdict.table);
      if (verdict.resumeAfter === null) return { checked, faults, tables };
      after = verdict.resumeAfter;
    }
    throw new Error("the sweep never finished");
  }

  it("checks a draft's body, which is the case that was measured failing", async () => {
    const id = ctx.id("drf");
    const key = `${ORG}/drafts/${id}`;
    const body = utf8("a draft nobody has sent");
    const stored = await putEvidence(testEnv, key, body);
    await testEnv.CATALOG.prepare(
      `INSERT INTO drafts (id, org_id, mailbox_id, author_user_id, to_addresses, subject, body_bytes,
         body_key, body_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, ORG, "mbx_x", "usr_x", '["c@d.test"]', "a draft", body.byteLength, key,
      stored.plaintextSha256, new Date(ctx.now()).toISOString(), new Date(ctx.now()).toISOString()).run();

    const result = await sweep();

    expect(result.checked).toBe(1);
    expect(result.faults).toEqual([]);
    expect(result.tables).toEqual(["drafts"]);
  });

  it("names the table on a fault, so an operator knows where to look for the row", async () => {
    const id = ctx.id("drf");
    const key = `${ORG}/drafts/${id}`;
    const body = utf8("this one gets tampered with");
    const stored = await putEvidence(testEnv, key, body);
    await testEnv.CATALOG.prepare(
      `INSERT INTO drafts (id, org_id, mailbox_id, author_user_id, to_addresses, subject, body_bytes,
         body_key, body_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, ORG, "mbx_x", "usr_x", '["c@d.test"]', "a draft", body.byteLength, key,
      stored.plaintextSha256, new Date(ctx.now()).toISOString(), new Date(ctx.now()).toISOString()).run();
    await putEvidence(testEnv, key, utf8("something else entirely"));

    const result = await sweep();

    expect(result.faults).toHaveLength(1);
    expect(result.faults[0]?.kind).toBe("altered");
    expect(result.faults[0]?.rowId).toBe(id);
    // A bare id was unambiguous when one table was swept. It is not now.
    expect(result.faults[0]?.table).toBe("drafts");
    expect(result.faults[0]?.column).toBe("body_key");
    // The byte counts come from `body_bytes`, which is why `bytes` is on the shared referent list.
    expect(result.faults[0]?.detail).toContain("bytes when sealed");
  });

  it("checks all three of a send's staged objects from one row", async () => {
    /*
     * The reason the batch bound counts **objects** and not rows. One `send_manifests` row is three R2 gets,
     * so a row bound would mean three different per-invocation costs depending on which table was reached.
     */
    const id = ctx.id("snd");
    const typed = utf8("as typed");
    const normalized = utf8("as normalized");
    const submitted = utf8("as submitted");
    const a = await putEvidence(testEnv, `${ORG}/sent/${id}/typed`, typed);
    const b = await putEvidence(testEnv, `${ORG}/sent/${id}/normalized`, normalized);
    const c = await putEvidence(testEnv, `${ORG}/sent/${id}/submitted.eml`, submitted);
    await testEnv.CATALOG.prepare(
      `INSERT INTO send_manifests (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to,
         subject, rfc_message_id, fidelity, body_typed_key, body_typed_sha256,
         body_normalized_key, body_normalized_sha256, submitted_key, submitted_sha256,
         sealed_at, release_at, state, state_at, attempts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, ORG, "mbx_x", "usr_x", "a@b.test", '["c@d.test"]', "s", `<${id}@b.test>`, "authored",
      `${ORG}/sent/${id}/typed`, a.plaintextSha256,
      `${ORG}/sent/${id}/normalized`, b.plaintextSha256,
      `${ORG}/sent/${id}/submitted.eml`, c.plaintextSha256,
      new Date(ctx.now()).toISOString(), new Date(ctx.now()).toISOString(), "sealed",
      new Date(ctx.now()).toISOString(), 0).run();

    const result = await sweep();

    expect(result.checked).toBe(3);
    expect(result.faults).toEqual([]);
  });

  it("does not report a send that staged no submitted bytes as missing evidence", async () => {
    /*
     * `submitted_key` is null unless the send had authored fidelity, so a structured send stages two objects
     * and not three. Treating null as an absent object would put a `missing` fault on every structured send
     * the Node ever made — a verifier crying wolf over correct data, which is how a real fault stops being
     * read. The count is the assertion: two, not three, and no fault.
     */
    const id = ctx.id("snd");
    const typed = utf8("structured, as typed");
    const normalized = utf8("structured, as normalized");
    const a = await putEvidence(testEnv, `${ORG}/sent/${id}/typed`, typed);
    const b = await putEvidence(testEnv, `${ORG}/sent/${id}/normalized`, normalized);
    await testEnv.CATALOG.prepare(
      `INSERT INTO send_manifests (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to,
         subject, rfc_message_id, fidelity, body_typed_key, body_typed_sha256,
         body_normalized_key, body_normalized_sha256, submitted_key, submitted_sha256,
         sealed_at, release_at, state, state_at, attempts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, ORG, "mbx_x", "usr_x", "a@b.test", '["c@d.test"]', "s", `<${id}@b.test>`, "structured",
      `${ORG}/sent/${id}/typed`, a.plaintextSha256,
      `${ORG}/sent/${id}/normalized`, b.plaintextSha256,
      null, null,
      new Date(ctx.now()).toISOString(), new Date(ctx.now()).toISOString(), "sealed",
      new Date(ctx.now()).toISOString(), 0).run();

    const result = await sweep();

    expect(result.checked).toBe(2);
    expect(result.faults).toEqual([]);
  });

  it("does not stop at an empty table, which would report the rest as verified", async () => {
    /*
     * The sharpest failure available, and the same one `inventoryPage` guards against for an empty prefix.
     * `ingress_receipts` is swept first; a Node with no inbound mail and a draft would, with a walk that ends
     * on an empty page, return `resumeAfter: null` after checking nothing — indistinguishable from a finished
     * sweep of a healthy Node. That is #131 rebuilt inside the fix for it.
     */
    const id = ctx.id("drf");
    const key = `${ORG}/drafts/${id}`;
    const body = utf8("the only evidence on this Node");
    const stored = await putEvidence(testEnv, key, body);
    await testEnv.CATALOG.prepare(
      `INSERT INTO drafts (id, org_id, mailbox_id, author_user_id, to_addresses, subject, body_bytes,
         body_key, body_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, ORG, "mbx_x", "usr_x", '["c@d.test"]', "a draft", body.byteLength, key,
      stored.plaintextSha256, new Date(ctx.now()).toISOString(), new Date(ctx.now()).toISOString()).run();

    // The first page, unpaged by the caller: it must not report the sweep finished having checked nothing.
    const first = await verifyEvidence(testEnv, ORG);
    expect(first.checked).toBe(1);
    expect(first.table).toBe("drafts");
  });

  it("sweeps the same tables the inventory can name, rather than a second list", async () => {
    /*
     * The closed-world check, and the reason #131 was possible at all: two lists of prefixes that were each
     * correct on their own. `VERIFIED_TABLES` is grouped from `INVENTORY_REFERENTS`, so this cannot drift —
     * what it stops is somebody replacing that derivation with a literal.
     */
    expect(VERIFIED_TABLES).toEqual([...new Set(INVENTORY_REFERENTS.map((one) => one.table))]);
    expect(VERIFIED_TABLES).toHaveLength(BUDGETS["evidence.verify_tables"]);
  });
});
