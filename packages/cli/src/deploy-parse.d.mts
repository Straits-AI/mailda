/**
 * Types for `deploy-parse.mjs`, so a TypeScript test can import it.
 *
 * The CLI is plain JavaScript — it runs under `node` with no build step, which is what keeps `mailda` a file
 * an operator can read. That leaves this hand-written declaration as the one thing here that **can drift**
 * from its implementation, and nothing checks the pair.
 *
 * It is a small surface and the drift is bounded: a wrong signature here shows up immediately as a failing
 * test in `test/node/deploy-sequence.test.ts`, because that file calls these with real values and compares
 * real answers. A declaration nobody calls would be the dangerous kind.
 */

/** A version id out of wrangler's prose, or `null` — never a guess. */
export function versionIdFrom(text: string): string | null;

/** The canary's preview URL, trailing sentence punctuation removed. */
export function previewUrlFrom(text: string): string | null;

/** The pending migrations that contract, read from this repository's own files. */
export function contractingAmong(listOutput: string, migrationsDir: string): string[];

/** Whether a canary's `doctor` verdict is good enough to move traffic to. Only `"ok"` is. */
export function shouldPromote(verdict: string): boolean;
