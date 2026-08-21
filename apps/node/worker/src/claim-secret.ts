/**
 * The claim secret's hash, in a module a Node script can import.
 *
 * ## Why this is its own file
 *
 * `seedClaimSecret` lives in `src/claim.ts` and the operator tool that writes the secret has to hash it the
 * **same** way — a second implementation of a hash is a second implementation to get subtly wrong, and the
 * failure would be silent in the worst direction: a Node whose recorded hash nothing can ever match is a
 * Node nobody can claim, discovered at install by the person least able to diagnose it.
 *
 * Importing `claim.ts` directly does not work. It reaches `errors.ts` through the session module, and that
 * file uses a TypeScript **parameter property**, which `node --experimental-strip-types` refuses:
 *
 *     SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in
 *     strip-only mode
 *
 * So the shared thing is a leaf with no imports of its own — the same trick `app-routes.ts` uses to be
 * readable by both the Worker and `axe.mjs`. `set-password.mjs` gets away with importing `auth/password.ts`
 * only because that file happens to be a leaf too; this makes it deliberate rather than lucky.
 *
 * `Web Crypto` rather than `node:crypto`, because this is imported *into the Worker* as well and `crypto` is
 * global in both runtimes.
 */
export async function claimSecretHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
