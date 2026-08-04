import { BUDGETS } from "@mailda/budgets";

/**
 * Password verifiers (§8).
 *
 * ## The platform ceiling
 *
 * **Cloudflare Workers rejects any single PBKDF2 call above 100,000 iterations** —
 * `Pbkdf2 failed: iteration counts above 100000 are not supported`. Measured on a deployed Node;
 * see `docs/receipts/password-hash-cost.md`. Local `workerd` does **not** enforce it, so a test
 * suite is no evidence here: this code passed every test at 600,000 while returning HTTP 500 in
 * production.
 *
 * OWASP's recommendation for PBKDF2-HMAC-SHA256 is 600,000 iterations, which cannot be requested in
 * one call. So the work is chained across six rounds that each stay inside the ceiling:
 *
 *     dk₀ = PBKDF2(password, salt ‖ 0, 100_000)
 *     dkᵢ = PBKDF2(dkᵢ₋₁,    salt ‖ i, 100_000)
 *
 * Each round consumes the previous round's output, so the chain is inherently sequential: an
 * attacker must still perform all 600,000 HMAC evaluations to test one guess. The work factor is
 * equivalent to single-call PBKDF2 at 600,000; only the call structure differs. The round index is
 * folded into the salt so no two rounds can share an input.
 *
 * This is a composition rather than textbook PBKDF2, which is a real cost — nobody can check it
 * against a specification. It is spelled out here and in the receipt so the reasoning is
 * inspectable instead of assumed.
 *
 * ## Verifiers describe themselves
 *
 *     pbkdf2-sha256$r=6$i=100000$<salt-b64>$<hash-b64>
 *
 * The parameters travel with the hash, and that is load-bearing rather than tidy. If Cloudflare
 * raises the ceiling and this code moves to a single round, a verifier that recorded only
 * "600000 iterations" would be re-derived as one call, produce a different key, and lock out every
 * existing user. Self-description makes that unrepresentable — and it is how Argon2id arrives
 * later without a migration: a new prefix, old rows still verifying.
 *
 * The receipt also records, plainly, that PBKDF2 is the weakest primitive in this design and why
 * Workers leaves no better native option. It is an accepted baseline, not a good one. §8 specifies
 * passkeys, which remove offline attack rather than repricing it.
 */

const PER_ROUND = BUDGETS["auth.pbkdf2_platform_max_iterations"];
const ROUNDS = BUDGETS["auth.pbkdf2_rounds"];
const EFFECTIVE = BUDGETS["auth.pbkdf2_effective_iterations"];
const SALT_BYTES = 16;
const DERIVED_BITS = 256;

const ALGORITHM = "pbkdf2-sha256";

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** One round. Kept separate so the ceiling appears in exactly one place. */
async function round(
  material: Uint8Array,
  salt: Uint8Array,
  index: number,
  iterations: number,
): Promise<Uint8Array> {
  if (iterations > PER_ROUND) {
    throw new Error(
      `E_PBKDF2_ABOVE_PLATFORM_CEILING  max=${PER_ROUND}, asked for ${iterations}\n` +
        `  why      Cloudflare Workers rejects a single PBKDF2 call above ${PER_ROUND} iterations, ` +
        `and local workerd does not enforce this — it fails only once deployed\n` +
        `  fix      raise auth.pbkdf2_rounds instead of the per-round count\n` +
        `  receipt  docs/receipts/password-hash-cost.md`,
    );
  }

  // The round index is folded into the salt so no round can repeat another's input.
  const roundSalt = new Uint8Array(salt.length + 1);
  roundSalt.set(salt, 0);
  roundSalt[salt.length] = index;

  const key = await crypto.subtle.importKey("raw", material as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: roundSalt as BufferSource, iterations },
    key,
    DERIVED_BITS,
  );
  return new Uint8Array(bits);
}

async function derive(
  password: string,
  salt: Uint8Array,
  rounds: number,
  iterations: number,
): Promise<Uint8Array> {
  let material = new TextEncoder().encode(password);
  for (let index = 0; index < rounds; index++) {
    material = await round(material, salt, index, iterations);
  }
  return material;
}

/**
 * Minimum length only, deliberately.
 *
 * Composition rules (one digit, one symbol) push people toward `Password1!` and are worse than
 * length; NIST 800-63B says the same. What would actually help is a breached-password check, which
 * needs a corpus this Node does not ship — recorded as absent rather than pretended at.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return (
      `E_PASSWORD_TOO_SHORT  minimum=${MIN_PASSWORD_LENGTH}, got ${password.length}\n` +
      `  why      length is the only property that reliably resists offline guessing\n` +
      `  fix      use a longer passphrase; there are no character-class requirements`
    );
  }
  return null;
}

/** Returns the self-describing verifier string, plus the effective work factor for the row. */
export interface PasswordVerifier {
  /** `pbkdf2-sha256$r=6$i=100000$<salt>$<hash>` */
  encoded: string;
  /** Total iterations of work, recorded alongside so the table is legible and queryable. */
  effectiveIterations: number;
}

export async function hashPassword(password: string): Promise<PasswordVerifier> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derive(password, salt, ROUNDS, PER_ROUND);
  return {
    encoded: `${ALGORITHM}$r=${ROUNDS}$i=${PER_ROUND}$${toBase64(salt)}$${toBase64(derived)}`,
    effectiveIterations: EFFECTIVE,
  };
}

interface ParsedVerifier {
  algorithm: string;
  rounds: number;
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

function parseVerifier(encoded: string): ParsedVerifier | null {
  const parts = encoded.split("$");
  if (parts.length !== 5) return null;
  const [algorithm, roundsPart, iterationsPart, salt, hash] = parts as [string, string, string, string, string];
  if (algorithm !== ALGORITHM) return null;
  if (!roundsPart.startsWith("r=") || !iterationsPart.startsWith("i=")) return null;

  const rounds = Number(roundsPart.slice(2));
  const iterations = Number(iterationsPart.slice(2));
  if (!Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(iterations) || iterations < 1) return null;

  try {
    return { algorithm, rounds, iterations, salt: fromBase64(salt), hash: fromBase64(hash) };
  } catch {
    return null;
  }
}

/**
 * Constant-time comparison. `===` on the encoded strings would leak, through timing, how many
 * leading bytes of a guess were correct — turning an offline problem into an online one.
 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseVerifier(encoded);
  // An unparseable verifier is not "wrong password" — it is a corrupt or future-format row, and
  // guessing at it would be worse than refusing.
  if (parsed === null) return false;

  const derived = await derive(password, parsed.salt, parsed.rounds, parsed.iterations);
  return equalBytes(derived, parsed.hash);
}

/** True when this verifier was made under less work, or a different algorithm, than we now use. */
export function needsRehash(encoded: string): boolean {
  const parsed = parseVerifier(encoded);
  if (parsed === null) return true;
  return parsed.algorithm !== ALGORITHM || parsed.rounds * parsed.iterations < EFFECTIVE;
}
