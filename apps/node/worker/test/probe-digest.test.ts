import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { vault } from "../src/keyvault.ts";
import { digestProbe, normaliseProbe } from "../src/probe-digest.ts";

/**
 * The digest that records a probe without recording the word (#158).
 *
 * ## Both tests here exist because a mutation survived
 *
 * `supervised-recording.test.ts` checks that a supervised search matching nothing is recorded, that the entry
 * carries a digest, that the digest is stable for a repeated term, and that the plain term is nowhere in it.
 * All of that passed against **two mutations that destroy the design**:
 *
 * 1. Replacing the keyed HMAC with a bare `SHA-256`. The digest is still 43 base64url characters, still
 *    stable, still not the plain term — and now **reversible with a wordlist**, because the search space is
 *    English rather than 2^256. That delivers the term to exactly the reader it was chosen to withhold it
 *    from, while looking cryptographic.
 * 2. Reaching for `sealingKey` instead of `ensureKey`. Everything about the record is identical, and the Node
 *    quietly marks its content key generation **used** on a read — which is #138's defect, in a worse place
 *    than #138 found it.
 *
 * Neither is visible in the entry. Both are visible here.
 */

const testEnv = env as unknown as Env;

/** What an attacker with the trail and no key would compute. */
async function unkeyedDigestOf(term: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normaliseProbe(term))),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("the digest is keyed, not merely hashed", () => {
  it("is not the digest anybody could compute from the term alone", async () => {
    /*
     * **The assertion the whole choice of a digest rests on.** #158 weighed three options and picked the
     * hash over the plain term precisely so the trail's reader could not learn the words. An unkeyed hash
     * gives them the words back for the price of a dictionary, so it is not the option that was chosen — it
     * only looks like it.
     *
     * Stated as an inequality against the *specific* value an attacker would compute, rather than as a
     * property of the algorithm, because that is the thing that has to be false.
     */
    const term = "redundancy package";
    const { digest } = await digestProbe(testEnv, term);
    expect(digest).not.toBe(await unkeyedDigestOf(term));
  });

  it("changes when this Node's content key changes, which is what keyed means", async () => {
    /*
     * The other direction, and it proves the key is *the vault's* rather than a constant compiled in. A
     * salt-in-the-source digest would pass the test above and be reversible by anybody holding this
     * repository — which is everybody, since it is open source.
     */
    const term = "demurrage";
    const before = await digestProbe(testEnv, term);

    /*
     * A different secret at a higher generation. `restore` moves the pointer forward, so subsequent calls
     * derive from the new secret — and isolated storage undoes it after this test.
     */
    const replacement = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await vault(testEnv).restore("content", before.keyGeneration + 1, replacement);

    const after = await digestProbe(testEnv, term);
    expect(after.keyGeneration).toBe(before.keyGeneration + 1);
    expect(after.digest).not.toBe(before.digest);
  });

  it("is stable for the same term, and collapses case and outer whitespace", async () => {
    // Without stability there is nothing to count, and the choice collapses into the count-only option.
    const first = await digestProbe(testEnv, "shipment delay");
    expect((await digestProbe(testEnv, "shipment delay")).digest).toBe(first.digest);
    expect((await digestProbe(testEnv, "  Shipment   Delay ")).digest).toBe(first.digest);
    expect((await digestProbe(testEnv, "shipment delays")).digest).not.toBe(first.digest);
  });

  it("normalises no further than case and whitespace", () => {
    /*
     * Deliberately not stemming. Merging `delay` and `delays` would make two genuinely different queries
     * share a digest, and a count that merges distinct probes **overstates** repetition — the direction that
     * makes an innocent reader look like they were hammering one word.
     */
    expect(normaliseProbe("  Demurrage   Claim ")).toBe("demurrage claim");
    expect(normaliseProbe("delays")).not.toBe(normaliseProbe("delay"));
  });
});

describe("recording a probe does not consume a key generation", () => {
  it("leaves the generation it read adoptable, which sealingKey would not", async () => {
    /*
     * **#138's defect, in the one place it would be worse.** `sealingKey` marks a generation used, and
     * `restore` then refuses to install the escrowed key over it — measured in #92's drill as a redemption
     * that answered 200 and installed nothing.
     *
     * `doctor` triggered that once per install. This path would trigger it on an **ordinary supervised
     * search**: a reader typing a query would consume the generation, on a read, having sealed nothing. So
     * the observable is the one that matters — after a probe, the escrow can still be installed.
     *
     * ## Why this asks about the generation the probe *read*
     *
     * The first version of this test restored `keyGeneration + 1` and expected `adopted`. It was wrong twice
     * over: `restore` answers `restored` for a generation the vault has never held, and — more to the point —
     * `sealingKey` would not have marked that generation either, so the assertion would have passed against
     * the very mutation it was written to catch.
     *
     * `restore`'s four answers are what make the real question askable. A generation that is **present with a
     * different secret** is `adopted` when it has never sealed and `conflict` when it has. `ensureKey` mints
     * generation 1 on a fresh vault without marking it, so replacing that minted key loses nothing and the
     * escrow installs. Under `sealingKey` the same call is `conflict` and the escrow can never be installed.
     */
    const { keyGeneration } = await digestProbe(testEnv, "a probed word");
    const different = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    expect(await vault(testEnv).restore("content", keyGeneration, different)).toBe("adopted");
  });
});
