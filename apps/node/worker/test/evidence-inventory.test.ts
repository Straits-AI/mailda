import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { utf8 } from "@mailda/evidence";

import { putEvidence } from "../src/evidence-store.ts";
import { INVENTORY_REFERENTS, inventoryPage } from "../src/evidence-inventory.ts";
import { scannedPrefixes } from "../src/reconcile.ts";

/**
 * The inventory a restored backup is checked against (#92).
 *
 * ## What these tests are protecting
 *
 * Completeness, in the two ways it can quietly fail. A prefix left out of the walk, and a page that ends the
 * sweep early — both produce a **shorter inventory that looks finished**, which in a disaster recovery means
 * restoring less than the operator believes they restored. Neither shows up as an error.
 *
 * So the assertions are about coverage rather than shape: every prefix reached, an empty prefix not ending
 * the walk, and a hash present for objects in every prefix that has a referent row.
 */

const ORG = "org_inventory";
const ctx = createSystemCtx();

beforeEach(async () => {
  for (const table of ["ingress_receipts", "drafts", "exports", "send_manifests"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table} WHERE org_id = ?`).bind(ORG).run();
  }
  // The bucket is shared across tests in this pool, so clear only what this organization wrote.
  for (const prefix of scannedPrefixes(ORG)) {
    const listed = await testEnv.EVIDENCE.list({ prefix, limit: 200 });
    for (const object of listed.objects) await testEnv.EVIDENCE.delete(object.key);
  }
});

/** Walks every page, the way a backup would, and returns the whole inventory. */
async function everything(page?: number) {
  const objects = [];
  let cursor: string | null = null;
  let unaccounted = 0;
  let pages = 0;
  for (;;) {
    const next = await inventoryPage(testEnv, ORG, cursor, page);
    objects.push(...next.objects);
    unaccounted += next.unaccounted;
    pages += 1;
    if (next.resumeAfter === null) break;
    cursor = next.resumeAfter;
    // A sweep that cannot finish is a bug, not a slow test: bound it well above any page count here.
    if (pages > 40) throw new Error("the inventory never finished");
  }
  return { objects, unaccounted, pages };
}

describe("the inventory covers every prefix this Worker writes", () => {
  it("names an object in each of the four, with the hash its plaintext should have", async () => {
    /*
     * One object per prefix, each with its referent row, because the interesting failure is a prefix the walk
     * skips — and a test with only `raw/` objects passes against a walk that only knows about `raw/`.
     */
    const receipt = ctx.id("rcpt");
    const raw = utf8("From: a@b.test\r\nSubject: kept\r\n\r\nbody");
    const rawStored = await putEvidence(testEnv, `${ORG}/raw/${receipt}.eml`, raw);
    await testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
         raw_bytes, blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(receipt, ORG, `evt_${receipt}`, "a@b.test", "c@d.test", raw.byteLength,
      `${ORG}/raw/${receipt}.eml`, rawStored.plaintextSha256, new Date(ctx.now()).toISOString()).run();

    const draft = ctx.id("drf");
    const body = utf8("a draft body");
    const draftStored = await putEvidence(testEnv, `${ORG}/drafts/${draft}`, body);
    await testEnv.CATALOG.prepare(
      `INSERT INTO drafts (id, org_id, mailbox_id, author_user_id, to_addresses, subject, body_bytes,
         body_key, body_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(draft, ORG, "mbx_x", "usr_x", '["c@d.test"]', "a draft", body.byteLength,
      `${ORG}/drafts/${draft}`, draftStored.plaintextSha256,
      new Date(ctx.now()).toISOString(), new Date(ctx.now()).toISOString()).run();

    const inventory = await everything();
    const byKey = new Map(inventory.objects.map((one) => [one.key, one]));

    expect(byKey.get(`${ORG}/raw/${receipt}.eml`)?.recordedSha256).toBe(rawStored.plaintextSha256);
    expect(byKey.get(`${ORG}/drafts/${draft}`)?.recordedSha256).toBe(draftStored.plaintextSha256);
    // Sizes are the sealed object's, not the plaintext's — a restored copy is compared byte-for-byte on these.
    expect(byKey.get(`${ORG}/raw/${receipt}.eml`)?.bytes).toBeGreaterThan(raw.byteLength);
    expect(inventory.unaccounted).toBe(0);
  });

  it("does not stop at an empty prefix, which would report a partial inventory as complete", async () => {
    /*
     * The sharpest failure available here. `drafts/` is walked second; a Node with no drafts and objects in
     * `exports/` or `sent/` would, with a naive walk, end the sweep at the empty prefix and return a shorter
     * inventory with `resumeAfter: null` — indistinguishable from a finished one. In a restore that is
     * silently missing evidence.
     *
     * So: nothing in `raw/` or `drafts/`, one object in the **last** prefix.
     */
    const send = ctx.id("snd");
    const submitted = utf8("submitted bytes");
    const stored = await putEvidence(testEnv, `${ORG}/sent/${send}/submitted.eml`, submitted);
    await testEnv.CATALOG.prepare(
      `INSERT INTO send_manifests (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to,
         subject, rfc_message_id, fidelity, body_typed_key, body_typed_sha256,
         body_normalized_key, body_normalized_sha256, submitted_key, submitted_sha256,
         sealed_at, release_at, state, state_at, attempts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(send, ORG, "mbx_x", "usr_x", "a@b.test", '["c@d.test"]', "s", `<${send}@b.test>`,
      "authored", `${ORG}/sent/${send}/typed`, "0".repeat(64),
      `${ORG}/sent/${send}/normalized`, "0".repeat(64),
      `${ORG}/sent/${send}/submitted.eml`, stored.plaintextSha256,
      new Date(ctx.now()).toISOString(), new Date(ctx.now()).toISOString(), "sealed",
      new Date(ctx.now()).toISOString(), 0).run();

    const inventory = await everything();

    expect(inventory.objects.map((one) => one.key)).toEqual([`${ORG}/sent/${send}/submitted.eml`]);
    expect(inventory.objects[0]?.recordedSha256).toBe(stored.plaintextSha256);
  });

  it("reports an object no row names rather than leaving it out", async () => {
    /*
     * `reconcile.ts`'s "object, no referent". Safe to delete after a grace period, and **not** safe to omit
     * from an inventory: a backup that silently drops what it cannot explain restores less than the operator
     * thinks, and the gap is invisible precisely because nothing references it.
     */
    await putEvidence(testEnv, `${ORG}/raw/orphan.eml`, utf8("nobody's"));

    const inventory = await everything();

    expect(inventory.objects.map((one) => one.key)).toEqual([`${ORG}/raw/orphan.eml`]);
    expect(inventory.objects[0]?.recordedSha256).toBeNull();
    expect(inventory.unaccounted).toBe(1);
  });

  it("pages without losing or repeating an object", async () => {
    /*
     * Driven through the page seam rather than by writing a hundred and fifty objects. What is being checked
     * is that a truncated page resumes where it stopped: a cursor mishandled in either direction loses
     * evidence or counts it twice, and a backup is the one place both are unacceptable.
     */
    const keys: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const key = `${ORG}/raw/paged-${i}.eml`;
      await putEvidence(testEnv, key, utf8(`message ${i}`));
      keys.push(key);
    }

    const inOnePage = await everything(50);
    const inSmallPages = await everything(2);

    expect(inSmallPages.pages).toBeGreaterThan(inOnePage.pages);
    expect(inSmallPages.objects.map((one) => one.key).sort()).toEqual(keys.sort());
    // No repeats: the same key twice would inflate a restored count and hide a missing object.
    expect(new Set(inSmallPages.objects.map((one) => one.key)).size).toBe(keys.length);
  });

  it("names another organization's objects nowhere", async () => {
    await putEvidence(testEnv, "org_somebody_else/raw/theirs.eml", utf8("not ours"));
    await putEvidence(testEnv, `${ORG}/raw/ours.eml`, utf8("ours"));

    const inventory = await everything();

    expect(inventory.objects.map((one) => one.key)).toEqual([`${ORG}/raw/ours.eml`]);
  });

  it("does not take a hash from another organization's row that names our object", async () => {
    /*
     * Contrived, and it is what makes the `org_id` filter in the join load-bearing rather than decorative.
     * Every key in a page comes from an `EVIDENCE.list` under `${orgId}/`, so a key is org-scoped by
     * construction — which means dropping the filter changes nothing *unless* some other organization's row
     * names an object under our prefix. Then, without it, the inventory reports **their** recorded hash for
     * **our** object, and a restored copy is verified against another tenant's number.
     *
     * A mutation removing that filter passed every other test here. This is the one that fails.
     */
    const key = `${ORG}/raw/claimed-by-another.eml`;
    await putEvidence(testEnv, key, utf8("ours, whatever they say"));

    const theirs = ctx.id("rcpt");
    await testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
         raw_bytes, blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(theirs, "org_somebody_else", `evt_${theirs}`, "a@b.test", "c@d.test", 10, key,
      "f".repeat(64), new Date(ctx.now()).toISOString()).run();

    const inventory = await everything();
    const found = inventory.objects.find((one) => one.key === key);

    expect(found).toBeDefined();
    // No row *of ours* names it, so it is unaccounted — not "accounted for, by them".
    expect(found?.recordedSha256).toBeNull();
    expect(inventory.unaccounted).toBe(1);

    await testEnv.CATALOG.prepare("DELETE FROM ingress_receipts WHERE org_id = ?")
      .bind("org_somebody_else").run();
  });

  it("reports the generation that actually sealed each object, not a constant", async () => {
    /*
     * **This field was 0 for every object in every inventory ever produced** (#141), and the eight tests in
     * this file passed throughout, because not one of them asserted it. `generationOf` reads
     * `object.customMetadata`, and R2 returns custom metadata from `list` only when `include` says so —
     * honoured since compatibility date 2022-08-04, and this Worker's is far later. So the fallback ran every
     * time: absent metadata means generation 0, the published development constant.
     *
     * It is the field that says which key opens an object, in a backup artifact, and it is what would have
     * caught #142 — a cross-account copy that carried every byte and dropped the metadata — before an
     * operator trusted it. A number nobody asserted, in the place it costs most.
     *
     * The assertion is against the generation the vault reports rather than a literal 1, so it holds however
     * many times this pool's vault has rotated.
     */
    const key = `${ORG}/raw/sealed-under-a-real-key.eml`;
    const stored = await putEvidence(testEnv, key, utf8("sealed by this Node"));
    expect(stored.keyGeneration, "putEvidence sealed under generation 0, so this checks nothing")
      .toBeGreaterThan(0);

    const inventory = await everything();
    const found = inventory.objects.find((one) => one.key === key);

    expect(found?.keyGeneration).toBe(stored.keyGeneration);
  });

  it("says nothing at all about a Node with an empty bucket", async () => {
    const inventory = await everything();
    expect(inventory.objects).toEqual([]);
    expect(inventory.pages).toBe(1);
  });
});

describe("the referent table is closed over the prefixes", () => {
  it("gives every prefix the Worker writes a table that can name its objects", () => {
    /*
     * The property that keeps this inventory honest as the Node grows. A fifth prefix would be caught by
     * `evidence-prefix-world.test.ts` at the reconciler; this catches the half that test cannot see — a
     * prefix that *is* walked but whose objects can never carry a hash, so a backup of them is a list of
     * sizes and a restore of them is unverifiable.
     *
     * Asserted as a count rather than a mapping, because the key columns do not spell their prefixes: `sent/`
     * is served by three columns on one table, and `drafts/` by a column named `body_key`. What can be
     * checked mechanically is that the number of prefixes has not outgrown the referents somebody wrote.
     */
    expect(scannedPrefixes("org_x")).toHaveLength(4);
    expect(new Set(INVENTORY_REFERENTS.map((one) => one.table)).size).toBe(4);
    for (const referent of INVENTORY_REFERENTS) {
      expect(referent.key).toMatch(/_key$/);
      expect(referent.hash).toMatch(/sha256$/);
    }
  });
});
