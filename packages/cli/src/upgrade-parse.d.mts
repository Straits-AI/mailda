/**
 * Types for `upgrade-parse.mjs`, so a TypeScript test can import it. Hand-written like `preflight.d.mts`,
 * and compared against the module's real exports by `test/node/declaration-drift.test.ts`.
 */

/** The remote whose fetch URL is Straits-AI/mailda, or null. */
export function releaseRemote(remoteV: string): string | null;

/** Ahead and behind counts from `git rev-list --left-right --count`, or null when unparseable. */
export function distance(revListCount: string): { ahead: number; behind: number } | null;

/** Pending migrations split by phase. */
export function pendingByPhase(
  listOutput: string,
  migrationNames: readonly string[],
  contracting: readonly string[],
): { expand: string[]; contract: string[] };
