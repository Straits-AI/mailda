import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { generationOf, getEvidence, putEvidence } from "../src/evidence-store.ts";
import { LEGACY_KEY_GENERATION, aesKeyFrom, vault } from "../src/keyvault.ts";
import { reconcileEvidence } from "../src/reconcile.ts";
import { resealBatch } from "../src/reseal.ts";
import { credentialGenerationOf, unwrapCredential, wrapCredential } from "../src/auth/kek.ts";
import { DEFAULT_FRAME_BYTES, seal } from "@mailda/evidence";

const testEnv = env as unknown as Env;
const ORG = "org_lifecycle";
const RAW = new TextEncoder().encode("From: a@b.com\r\nSubject: hello\r\n\r\nbody\r\n");

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Writes an object sealed under generation 0 — as a Node deployed before the vault would have. */
async function writeLegacyObject(blobKey: string, plaintext: Uint8Array): Promise<void> {
  const legacy = await vault(testEnv).openingKey("content", LEGACY_KEY_GENERATION);
  const sealed = await seal(await aesKeyFrom(legacy.secret), plaintext, DEFAULT_FRAME_BYTES);
  const object = new Uint8Array(sealed.header.length + sealed.body.length);
  object.set(sealed.header, 0);
  object.set(sealed.body, sealed.header.length);
  // No keyGeneration in customMetadata: absent is what generation 0 actually looks like on disk.
  await testEnv.EVIDENCE.put(blobKey, object, { customMetadata: { frames: "aes-256-gcm/256KiB/v1" } });
}

async function insertReceipt(
  id: string, blobKey: string, plaintext: Uint8Array, generation: number | null, at: string,
): Promise<void> {
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
       raw_bytes, blob_key, blob_sha256, accepted_at, key_generation) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, ORG, id, "a@b.com", "c@d.com", plaintext.length, blobKey,
    await sha256Hex(plaintext), at, generation).run();
}

beforeEach(async () => {
  await testEnv.CATALOG.prepare("DELETE FROM ingress_receipts").run();
  const listed = await testEnv.EVIDENCE.list({ prefix: `${ORG}/` });
  for (const object of listed.objects) await testEnv.EVIDENCE.delete(object.key);
});

describe("key vault (ADR 28)", () => {
  it("generates its own keys, so an unprotected Node is not representable", async () => {
    const key = await vault(testEnv).sealingKey("content");
    expect(key.generation).toBeGreaterThan(LEGACY_KEY_GENERATION);
    expect(atob(key.secret).length).toBe(32);
  });

  it("returns the same key on repeat calls — generated once, not per call", async () => {
    const first = await vault(testEnv).sealingKey("content");
    const second = await vault(testEnv).sealingKey("content");
    expect(second.generation).toBe(first.generation);
    expect(second.secret).toBe(first.secret);
  });

  it("keeps content and credential keys genuinely different (#7's split)", async () => {
    const content = await vault(testEnv).sealingKey("content");
    const credential = await vault(testEnv).sealingKey("credential");
    // One key for both would mean a single leaked secret that reads every message *and* forges a
    // session for any user.
    expect(credential.secret).not.toBe(content.secret);
  });

  it("never hands out the legacy constant for sealing", async () => {
    // Generation 0 is published in this repository. It must be openable and never sealable.
    const sealing = await vault(testEnv).sealingKey("content");
    expect(sealing.generation).not.toBe(LEGACY_KEY_GENERATION);

    const legacy = await vault(testEnv).openingKey("content", LEGACY_KEY_GENERATION);
    expect(legacy.generation).toBe(LEGACY_KEY_GENERATION);
    expect(legacy.secret).not.toBe(sealing.secret);
  });

  it("rotates without losing the ability to open older generations", async () => {
    const before = await vault(testEnv).sealingKey("content");
    const rotation = await vault(testEnv).rotate("content");
    expect(rotation.to).toBeGreaterThan(rotation.from);

    // The point of the whole design: rotation does not make existing data unreadable.
    const old = await vault(testEnv).openingKey("content", before.generation);
    expect(old.secret).toBe(before.secret);
    const now = await vault(testEnv).sealingKey("content");
    expect(now.generation).toBe(rotation.to);
  });

  it("names an unknown generation instead of failing vaguely", async () => {
    await expect(vault(testEnv).openingKey("content", 9999)).rejects.toThrow(
      /E_VAULT_UNKNOWN_GENERATION/,
    );
    // The message has to say the data is intact and what would restore it.
    await expect(vault(testEnv).openingKey("content", 9999)).rejects.toThrow(/recovery codes/);
  });
});

describe("evidence records the key that sealed it", () => {
  it("stamps the generation on the object and round-trips through it", async () => {
    const stored = await putEvidence(testEnv, `${ORG}/raw/2026-Q3/a.eml`, RAW);
    const head = await testEnv.EVIDENCE.head(stored.blobKey);
    expect(generationOf(head!)).toBe(stored.keyGeneration);
    expect(await getEvidence(testEnv, stored.blobKey)).toEqual(RAW);
  });

  it("treats absent metadata as generation 0, which keeps pre-vault mail readable", async () => {
    const blobKey = `${ORG}/raw/2026-Q3/legacy.eml`;
    await writeLegacyObject(blobKey, RAW);

    const head = await testEnv.EVIDENCE.head(blobKey);
    expect(generationOf(head!)).toBe(LEGACY_KEY_GENERATION);
    // Deleting the legacy key would have made this mail unreadable. That is why it survives.
    expect(await getEvidence(testEnv, blobKey)).toEqual(RAW);
  });

  it("carries the generation on wrapped credentials too, where there is no metadata to use", async () => {
    const wrapped = await wrapCredential(testEnv, "a-signing-key");
    expect(wrapped).toMatch(/^v[1-9]\d*\./);
    expect(credentialGenerationOf(wrapped)).toBeGreaterThan(LEGACY_KEY_GENERATION);
    expect(await unwrapCredential(testEnv, wrapped)).toBe("a-signing-key");
  });
});

describe("re-seal (#25)", () => {
  it("moves generation-0 evidence to the current key, byte-for-byte", async () => {
    const ctx = createSystemCtx();
    const blobKey = `${ORG}/raw/2026-Q3/legacy.eml`;
    await writeLegacyObject(blobKey, RAW);
    await insertReceipt("rcpt_legacy", blobKey, RAW, null, new Date(ctx.now()).toISOString());

    const outcome = await resealBatch(testEnv, ctx, ORG);
    expect(outcome.resealed).toBe(1);
    expect(outcome.failed).toEqual([]);
    expect(outcome.remaining).toBe(0);

    // The whole claim: the mail is now under the Node's own key and is still exactly the same bytes.
    const head = await testEnv.EVIDENCE.head(blobKey);
    expect(generationOf(head!)).toBe(outcome.targetGeneration);
    expect(await getEvidence(testEnv, blobKey)).toEqual(RAW);
  });

  it("refuses to advance a message whose plaintext hash does not match its receipt", async () => {
    const ctx = createSystemCtx();
    const blobKey = `${ORG}/raw/2026-Q3/tampered.eml`;
    await writeLegacyObject(blobKey, RAW);
    // A receipt claiming a different message. Re-sealing must not launder this into the new key.
    await insertReceipt("rcpt_bad", blobKey, new TextEncoder().encode("different"), null,
      new Date(ctx.now()).toISOString());

    const outcome = await resealBatch(testEnv, ctx, ORG);
    expect(outcome.resealed).toBe(0);
    expect(outcome.failed[0]?.receiptId).toBe("rcpt_bad");
    expect(outcome.failed[0]?.reason).toContain("SHA-256");
    // Left alone and still readable under its old key, not deleted and not skipped silently.
    expect(generationOf((await testEnv.EVIDENCE.head(blobKey))!)).toBe(LEGACY_KEY_GENERATION);
    expect(outcome.remaining).toBe(1);
  });

  it("is resumable and idempotent, so an interrupted run costs a pass and not a message", async () => {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    for (let i = 0; i < 3; i++) {
      const blobKey = `${ORG}/raw/2026-Q3/m${i}.eml`;
      await writeLegacyObject(blobKey, RAW);
      await insertReceipt(`rcpt_m${i}`, blobKey, RAW, null, at);
    }

    const first = await resealBatch(testEnv, ctx, ORG);
    expect(first.resealed).toBe(3);

    // Running again finds nothing to do and says so, rather than re-sealing what is already current.
    const second = await resealBatch(testEnv, ctx, ORG);
    expect(second.resealed).toBe(0);
    expect(second.remaining).toBe(0);
  });

  it("recovers a stale index without re-sealing: R2 metadata is the truth", async () => {
    const ctx = createSystemCtx();
    const stored = await putEvidence(testEnv, `${ORG}/raw/2026-Q3/current.eml`, RAW);
    // The object is current but D1 says otherwise — exactly the state a crash between the R2 write
    // and the D1 update leaves behind.
    await insertReceipt("rcpt_stale", stored.blobKey, RAW, null, new Date(ctx.now()).toISOString());

    const outcome = await resealBatch(testEnv, ctx, ORG);
    expect(outcome.alreadyCurrent).toBe(1);
    expect(outcome.resealed).toBe(0);
    expect(outcome.remaining).toBe(0);
  });

  it("reports a missing object as a failure rather than advancing past it", async () => {
    const ctx = createSystemCtx();
    await insertReceipt("rcpt_gone", `${ORG}/raw/2026-Q3/gone.eml`, RAW, null,
      new Date(ctx.now()).toISOString());

    const outcome = await resealBatch(testEnv, ctx, ORG);
    expect(outcome.failed[0]?.reason).toContain("absent");
    // Advancing the index would hide lost mail from the next scan.
    expect(outcome.remaining).toBe(1);
  });

  it("stays inside its measured subrequest budget per batch", () => {
    const perMessage = BUDGETS["reseal.subrequests_per_message"];
    const batch = BUDGETS["reseal.batch_size"];
    // The reason the batch is 100 and not 200: 200 would exceed the cap on a full batch, and that is
    // a limit that only appears under load.
    expect(batch * perMessage + 2).toBeLessThan(BUDGETS["doctor.max_subrequests"]);
  });
});

describe("reconcile (#25, §24)", () => {
  it("finds an orphan blob but will not delete it unless asked", async () => {
    const ctx = createSystemCtx();
    const blobKey = `${ORG}/raw/2026-Q3/orphan.eml`;
    await writeLegacyObject(blobKey, RAW);

    // An hour past the grace period: no receipt is coming.
    const later = createSystemCtx();
    const future = {
      now: () => Date.now() + (BUDGETS["reconcile.orphan_grace_seconds"] + 60) * 1000,
      id: later.id, random: later.random,
    };

    const readOnly = await reconcileEvidence(testEnv, future, ORG);
    expect(readOnly.orphans.map((o) => o.blobKey)).toContain(blobKey);
    expect(readOnly.orphansDeleted).toBe(0);
    // A diagnostic must never be the thing that deletes data.
    expect(await testEnv.EVIDENCE.head(blobKey)).not.toBeNull();

    const collected = await reconcileEvidence(testEnv, future, ORG, { collect: true });
    expect(collected.orphansDeleted).toBe(1);
    expect(await testEnv.EVIDENCE.head(blobKey)).toBeNull();
  });

  it("will not judge a blob still inside the grace window", async () => {
    const ctx = createSystemCtx();
    const blobKey = `${ORG}/raw/2026-Q3/inflight.eml`;
    await writeLegacyObject(blobKey, RAW);

    // ingress writes R2 before D1, so a fresh blob may be a delivery mid-flight. Deleting it would
    // destroy mail that was about to be accepted.
    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.tooFreshToJudge).toBe(1);
    expect(report.orphansDeleted).toBe(0);
    expect(await testEnv.EVIDENCE.head(blobKey)).not.toBeNull();
  });

  it("reports a receipt with no evidence and never repairs it", async () => {
    const ctx = createSystemCtx();
    await insertReceipt("rcpt_lost", `${ORG}/raw/2026-Q3/lost.eml`, RAW, 1,
      new Date(ctx.now()).toISOString());

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.missing.map((m) => m.receiptId)).toContain("rcpt_lost");

    // Even with collect set, the receipt survives. Deleting it would turn a detectable data loss
    // into an undetectable one — and it is the tempting option, because it makes the report green.
    const still = await testEnv.CATALOG.prepare("SELECT id FROM ingress_receipts WHERE id = ?")
      .bind("rcpt_lost").first();
    expect(still).not.toBeNull();
  });

  it("does not mistake a healthy pair for either failure", async () => {
    const ctx = createSystemCtx();
    const stored = await putEvidence(testEnv, `${ORG}/raw/2026-Q3/fine.eml`, RAW);
    await insertReceipt("rcpt_fine", stored.blobKey, RAW, stored.keyGeneration,
      new Date(ctx.now()).toISOString());

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.missing).toEqual([]);
    expect(report.orphans).toEqual([]);
  });

  it("says what it examined, including when the listing was truncated", async () => {
    const ctx = createSystemCtx();
    const stored = await putEvidence(testEnv, `${ORG}/raw/2026-Q3/one.eml`, RAW);
    await insertReceipt("rcpt_one", stored.blobKey, RAW, stored.keyGeneration,
      new Date(ctx.now()).toISOString());

    const report = await reconcileEvidence(testEnv, ctx, ORG);
    expect(report.scanned.receiptsTotal).toBe(1);
    expect(report.scanned.objects).toBeGreaterThan(0);
    expect(typeof report.scanned.truncated).toBe("boolean");
  });
});
