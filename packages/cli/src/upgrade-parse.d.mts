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

/** Where releases come from, for a clone with no remote. */
export const RELEASE_URL: string;

/** True when `git diff --name-only --diff-filter=U` names package.json and nothing else. */
export function onlyPackageJson(conflicted: string): boolean;

/** Upstream's package.json text with the clone's own name kept. */
export function resolvePackageJson(ours: string, theirs: string): string;

/** Whether an upgrade asks for a hostname of the operator's own: only while the Node is known by its workers.dev address. Pure. */
export function asksHostname(input: { given: string | null; yes: boolean; remembered: string | null }): boolean;

/** Whether an upgrade backs the Node up first: a migration pending, or asked for. Pure. */
export function backupWanted(phases: { expand: readonly string[]; contract: readonly string[] }, forced: boolean): boolean;
