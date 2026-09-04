/**
 * Types for `preflight.mjs`, so a TypeScript test can import it.
 *
 * Hand-written, like `deploy-parse.d.mts` and `.github/scripts/sbom.d.mts`, and compared against the module's
 * real exports by `test/node/declaration-drift.test.ts` — which exists because one of those two kept
 * exporting a function after the function was deleted.
 */

export interface Account {
  name: string;
  id: string;
}

/** The accounts a `wrangler whoami` table names. Empty when it named none. */
export function accountsFrom(whoami: string): Account[];

/** Whether wrangler thinks anybody is signed in. It says so in prose; there is no exit code for it. */
export function signedIn(whoami: string): boolean;

/** Which account a deploy would use, or why it cannot tell. */
export function resolveAccount(args: { accounts: Account[]; chosen?: string | undefined }):
  | { ok: true; id: string; name: string }
  | { ok: false; what: string; why: string; fix: string };

/** wrangler's own version, out of its banner. */
export function wranglerVersionFrom(text: string): string | null;

/** Numeric version comparison. String comparison puts 4.118.0 below 4.97.0, which inverts the floor. */
export function atLeast(version: string | null, floor: string | number): boolean;

/** Whether a doctor report names the version that produced it, which the canary gate compares against. */
export function reportsItsVersion(report: unknown): boolean;

/**
 * Whether not knowing the Node's URL should stop this command.
 *
 * `null` when it should not: either the URL is known, or the command does not need one. `mailda deploy
 * --plan` is the second case — it promotes nothing, and a plan for a first install runs before there is a
 * Node to have a URL.
 */
export function urlRequirement(args: { origin: string | null; needsUrl: boolean }): {
  what: string;
  why: string;
  fix: string;
} | null;
