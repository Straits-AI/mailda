import { vault } from "./keyvault.ts";

/**
 * A search term recorded so a probe can be counted and never read (#158).
 *
 * ## The decision this implements, and the trap in it
 *
 * A supervised reader — somebody with a dual-approved, time-bounded grant into a colleague's mailbox — can
 * search that mailbox for a word and learn that it does not occur. On a **contentless** body index that null
 * answer is half of ADR 28's confirm-a-guess capability, and until #158 it left no record at all. So the act
 * is now recorded even when it matches nothing.
 *
 * That made the entry's shape the real question, because the trail has to name *what* was probed for or it
 * answers nothing — and a search term in the audit trail is somebody's words, retained, readable by whoever
 * reads the trail. The decision was a **digest**: an auditor learns that this mailbox was probed and how
 * often, and never for what.
 *
 * **A digest of a search term is not a hash problem, it is a key problem.** `sha256("redundancy package")`
 * is reversible with a wordlist in seconds — the search space is English, not 2^256 — so an unkeyed digest
 * would deliver the plain term to exactly the reader it was chosen to withhold it from, while looking
 * cryptographic. This is therefore a **keyed** digest, and the key never enters D1.
 *
 * ## Why the content key, and not the credential key
 *
 * #7 splits keys by purpose and the split only pays off if it is maintained, so adding a third purpose was
 * the obvious move. It is the wrong one: a new `KeyPurpose` needs a legacy secret, escrow coverage,
 * generation accounting and a re-seal story, all to protect a value whose loss costs nothing but the ability
 * to correlate old probes with new ones.
 *
 * Deriving is better, and *which* key to derive from is the actual security argument:
 *
 * - Derived from **content**: an attacker holding the content key can already read every message. Being able
 *   to reverse a probe digest tells them a word somebody searched for — strictly less than they already have.
 *   The derivation widens nothing.
 * - Derived from **credential**: that key forges sessions and unwraps transport tokens but reads no mail.
 *   Adding "and reverses every recorded search term" to its compromise would be a genuine widening, which is
 *   the opposite of what #7's split is for.
 *
 * So: HKDF from the content secret with a distinct `info`, which is one-way — the probe key cannot yield the
 * content key back.
 *
 * ## `ensureKey`, not `sealingKey`, and #138 is why
 *
 * `sealingKey` marks a generation **used**. #138 measured what that costs when a non-sealing caller reaches
 * for it: `doctor` wrapped a constant it threw away, the generation was marked load-bearing anyway, and on a
 * fresh Node the escrow's generation 1 became unusable before the Node could be claimed — a redemption that
 * answered 200 and installed nothing.
 *
 * This path is worse than `doctor`'s, because it runs on an **ordinary supervised search**. A reader typing a
 * query would mark the content generation used, on a read, having sealed nothing. So it takes the accessor
 * that does not mark.
 *
 * ## Hashes are comparable within a key generation, and the entry says which
 *
 * The derived key follows the content key, so rotating that key changes every digest. Old and new hashes are
 * then incomparable, and repeat-counting restarts. That is recorded rather than hidden: `keyGeneration` rides
 * in the entry beside the digest, so an auditor counting repeats across a rotation can see why the count
 * resets instead of concluding the probing stopped.
 */

/** Distinct from every other use of this secret, so the derived key cannot collide with one. */
const INFO = "mailda:probe-digest:v1";

/**
 * The term as it is digested.
 *
 * Lowercased and internally whitespace-collapsed, so `"Demurrage"` and `"demurrage "` count as the same
 * probe. Deliberately nothing more: stemming or stop-word removal would make two genuinely different queries
 * share a digest, and a count that merges distinct probes overstates repetition — which is the direction that
 * would make an innocent reader look like they were hammering one word.
 */
export function normaliseProbe(term: string): string {
  return term.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

/**
 * The digest of a probed term, and the key generation it is comparable within.
 *
 * One Durable Object round trip for the key, on a supervised searched page that matched nothing — which is
 * the only path that calls this. An ordinary listing, an unsearched supervised page and a search by somebody
 * with no grant all reach it not at all.
 */
export async function digestProbe(
  env: Env, term: string,
): Promise<{ digest: string; keyGeneration: number }> {
  const key = await vault(env).ensureKey("content");
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key.secret), "HKDF", false, ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      /*
       * No salt. HKDF's salt is optional and its value here would have to be stored somewhere to stay
       * stable across calls — and the only place available is D1, which is the one place this design
       * requires the key material not to be. An empty salt with a distinct `info` is HKDF's documented
       * shape for exactly this case: one high-entropy input, several independent outputs.
       */
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(INFO),
    },
    material,
    256,
  );

  const hmacKey = await crypto.subtle.importKey(
    "raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC", hmacKey, new TextEncoder().encode(normaliseProbe(term)),
  );

  /*
   * The full 32 bytes, not truncated. A shorter digest would look more private and be less useful: a
   * collision merges two distinct terms, and the count an auditor reads would then overstate repetition of a
   * word nobody searched twice. There is nothing to gain by shortening — the term is already unrecoverable
   * without the key.
   */
  return { digest: base64Url(new Uint8Array(signature)), keyGeneration: key.generation };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
