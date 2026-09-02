import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { utf8 } from "@mailda/evidence";

import { getEvidence, openForReseal, putEvidence, streamEvidence } from "../src/evidence-store.ts";
import { vault } from "../src/keyvault.ts";

/**
 * Evidence whose metadata says nothing about which key sealed it (#142).
 *
 * ## The state this is about, and how ordinary it is
 *
 * `putEvidence` records the sealing generation in R2 custom metadata. **Ordinary tooling drops it**:
 * `wrangler r2 object get | put` has no flag for custom metadata, so a bucket copied that way arrives
 * byte-perfect and unreadable. Measured in #92's restore drill, across two real Cloudflare accounts:
 *
 *     source       keyGeneration=1  (x3)
 *     destination  keyGeneration=0  (x3)
 *
 * Every byte present, the correct key sitting in the destination's vault, and `E_EVIDENCE_AUTH_FAILED` on
 * every frame — because a label fell off in transit.
 *
 * ## Why trying keys is sound rather than a guess
 *
 * AES-GCM authenticates. A wrong key does not decrypt to wrong plaintext, it fails, so a sweep of the
 * generations this vault actually holds either finds the one that works or proves none does. The recorded
 * generation was always a hint; this stops it being the authority.
 *
 * The fixture writes objects the way a metadata-stripping copy leaves them — the sealed bytes, no custom
 * metadata — which is exactly what was measured rather than an approximation of it.
 */

const ORG = "org_no_label";

/** Seals through the real path, then re-puts the bytes with the metadata stripped, as a copy would. */
async function sealedWithoutItsLabel(key: string, text: string) {
  const stored = await putEvidence(testEnv, key, utf8(text));
  const sealed = await testEnv.EVIDENCE.get(key);
  const bytes = new Uint8Array(await sealed!.arrayBuffer());
  // No `customMetadata` at all, which is what `wrangler r2 object put` produces.
  await testEnv.EVIDENCE.put(key, bytes);
  return stored;
}

describe("an object that does not say which key sealed it", () => {
  it("opens anyway, by trying the generations the vault holds", async () => {
    const key = `${ORG}/raw/label-lost.eml`;
    const text = "the bytes survived the copy; the label did not";
    const stored = await sealedWithoutItsLabel(key, text);
    /*
     * Non-vacuity, and it is the assertion the rest rests on: if this Node sealed under generation 0 there
     * is no label to lose and the test proves nothing, because generation 0 is what absence already means.
     */
    expect(stored.keyGeneration, "sealed under generation 0, so there was no label to lose")
      .toBeGreaterThan(0);
    expect(await testEnv.EVIDENCE.get(key).then((o) => o!.customMetadata?.keyGeneration))
      .toBeUndefined();

    expect(new TextDecoder().decode(await getEvidence(testEnv, key))).toBe(text);
  });

  it("streams it too, without materialising the plaintext to find the key", async () => {
    /*
     * The response path is separate code and must not be left behind: a Node where drafts open and messages
     * do not is worse than one where neither does, because the failure looks like corruption of some mail
     * rather than a state to fix.
     */
    const key = `${ORG}/raw/streamed-without-a-label.eml`;
    const text = "read as a stream, one authenticated frame at a time";
    await sealedWithoutItsLabel(key, text);

    const chunks: Uint8Array[] = [];
    const reader = (await streamEvidence(testEnv, key)).getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }

    expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((c) => [...c])))).toBe(text);
  });

  it("tells the re-sealer the generation that opened it, not the one the object claimed", async () => {
    /*
     * `reseal.ts` skips an object already at or above the target generation. An unlabelled object reported
     * as generation 0 looks older than everything and would be re-sealed under a key it was never sealed
     * with — the repair path corrupting what it was pointed at.
     */
    const key = `${ORG}/raw/for-reseal.eml`;
    const stored = await sealedWithoutItsLabel(key, "re-sealed under the generation that opened it");

    const opened = await openForReseal(testEnv, key);

    expect(opened.generation).toBe(stored.keyGeneration);
    expect(opened.generation).not.toBe(0);
  });

  it("still fails when no key in the vault opens it, rather than reporting success", async () => {
    /*
     * The direction that must never be wrong. A recovery that answers "opened" on a sweep that found nothing
     * is the false clean bill of health this whole area keeps having to catch — so an object sealed under a
     * key this vault does not hold has to stay unreadable and say so.
     */
    const key = `${ORG}/raw/sealed-elsewhere.eml`;
    // A well-formed object from another Node: sealed, then its 32-byte header left intact and its body
    // replaced, so every candidate key fails authentication rather than failing to parse.
    await sealedWithoutItsLabel(key, "sealed by somebody else");
    const object = await testEnv.EVIDENCE.get(key);
    const bytes = new Uint8Array(await object!.arrayBuffer());
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    await testEnv.EVIDENCE.put(key, bytes);

    await expect(getEvidence(testEnv, key)).rejects.toThrow(/AUTH_FAILED|E_EVIDENCE/);
  });

  it("costs nothing when the object carries its label", async () => {
    /*
     * The ordinary path is untouched, and this is what says so: an object with metadata never reaches the
     * candidate sweep, so a vault holding many generations does not make every read slower.
     */
    const key = `${ORG}/raw/labelled.eml`;
    const text = "this one kept its metadata";
    await putEvidence(testEnv, key, utf8(text));

    const held = await vault(testEnv).generations("content");
    expect(held.length, "the vault holds no generations, so this asserts nothing").toBeGreaterThan(0);
    expect(new TextDecoder().decode(await getEvidence(testEnv, key))).toBe(text);
  });
});
