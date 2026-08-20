import type { Butler } from "./ast.ts";

/**
 * Canonical serialization: the bytes that say whether two ASTs are the same program (#49, ADR 35, #60).
 *
 * ## Why this exists at all, stated as what it buys rather than what it sounds like it buys
 *
 * `JSON.stringify` emits keys in insertion order, so the same Butler read from two editors — or the same
 * object rebuilt by a refactor — produces different bytes. A digest over those bytes fingerprints the
 * *document*; a digest over these bytes fingerprints the **program**. ADR 35 already mints the send
 * manifest's id from canonical output and #60 already hashes a policy version's canonical conditions; this
 * is the same discipline applied to a tree, reused rather than re-derived.
 *
 * **It is not what makes the no-op-publish refusal work, and claiming so would be a claim nothing
 * enforces.** That refusal compares a draft's two digests against the published version's, and a Butler is
 * *derived* from its source text — so identical source bytes already give an identical AST and the source
 * digest decides. What canonicalization decides is the question the second column exists for: two versions
 * whose source texts differ can still be shown to be the same program, which is how a reformat mints a
 * version that says plainly it changed nothing but the text. `src/butlers.ts` carries the same note at the
 * point of comparison.
 *
 * ## Where it differs from `canonicalConditions`, and why the difference is right
 *
 * `src/policy.ts` writes its field order out by hand — six named fields, in a fixed sequence — and gives
 * the reason: a hash whose input depends on property order changes when somebody reorders an interface.
 * That works for six flat fields and it does **not** scale to a tree: a hand-written writer per node kind
 * has a failure mode a flat record does not, which is *omission*. A field added to `draft` and not added
 * to `draft`'s writer would change the Butler without changing its hash — a frozen version whose content
 * moved underneath its own fingerprint.
 *
 * So the order here is **derived from the key names**, sorted, rather than from insertion order. That
 * satisfies the property #60 actually wanted — the bytes do not depend on how the object was built — and it
 * removes the omission mode entirely, because every present key is written. `test/canonical.test.ts`
 * mutates every leaf of a fixture AST and asserts the bytes move for each one, which is what makes
 * "nothing is silently dropped" a check rather than a claim.
 *
 * ## The three rules
 *
 * 1. **Object keys are sorted** by UTF-16 code unit. Deterministic and independent of construction order.
 * 2. **Arrays keep their order.** An array in this AST is a sequence with meaning — `switch.cases` is
 *    evaluated in order, `draft.to` is a recipient list, `nodes` is a list. Sorting one would erase a
 *    semantic difference, which is the opposite failure from the one above and a worse one.
 * 3. **`null` and `undefined` are dropped**, so absent and null-valued keys serialize identically. They
 *    mean the same thing in this AST — `next: null` and no `next` are both "the run ends here" — and #60
 *    settled that a publish which changed `undefined` to `null` changed nothing.
 *
 * ## Numbers
 *
 * Every number in this AST is an integer by schema (`maxItems`, `wait.seconds`). A non-integer reaching
 * here is a programming error rather than an author error, so it **throws** instead of being formatted:
 * `0.1` and `1e-1` are the same value with two spellings, and a canonicaliser that quietly picked one
 * would be the unreliable half of ADR 35's discipline hiding inside the reliable half. `-0` throws for the
 * same reason.
 */

/** Serializes any JSON value canonically. Exported because the checker's fixtures test it directly. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    // Only reachable as a top-level call; inside an object these keys are dropped, and inside an array a
    // hole is not representable in this AST.
    return "null";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error(
        `E_CANONICAL_NON_INTEGER  ${String(value)} cannot be canonicalized\n`
          + "  why      every number in a Butler AST is an integer by schema, and a canonicaliser that "
          + "picked one spelling of a float would make the no-op-publish refusal unreliable (#49)\n"
          + "  fix      use an integer, or extend this function with a decided decimal form and a test",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== null && item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error(
    `E_CANONICAL_UNSUPPORTED  a ${typeof value} cannot appear in a Butler AST\n`
      + "  why      the AST is JSON; a function, symbol or bigint here means something built it wrongly\n"
      + "  fix      parse the AST with `parseButler` before canonicalizing it",
  );
}

/** The canonical bytes of a checked AST. This is what is stored in `butler_versions.ast_json`. */
export function canonicalButlerJson(ast: Butler): string {
  return canonicalJson(ast);
}

export function canonicalButlerBytes(ast: Butler): Uint8Array {
  return new TextEncoder().encode(canonicalButlerJson(ast));
}

/**
 * SHA-256 over the canonical bytes, hex.
 *
 * Here rather than in the Worker so the fingerprint stored beside an AST and the fingerprint a checker
 * computes from the same AST cannot be two functions. `crypto.subtle` is a global in workerd and in Node
 * 22 alike, so this needs no runtime-specific import.
 */
export async function astSha256(ast: Butler): Promise<string> {
  return await sha256Hex(canonicalButlerBytes(ast));
}

/** The same digest over arbitrary bytes, for the source text that travels beside the AST. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function textSha256(text: string): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(text));
}
