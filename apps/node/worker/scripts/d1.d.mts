/**
 * Types for `d1.mjs`, so the operator tools are inside `pnpm typecheck` rather than beside it.
 *
 * A `.d.mts` rather than converting the script to TypeScript: it is imported by `.mjs` scripts that run
 * under `node --experimental-strip-types`, and strip-only mode refuses several TypeScript constructs — the
 * exact reason `claim-secret.ts` had to become a leaf module in the first place.
 */
export function sqlLiteral(value: string | number | null): string;
export function fill(sql: string, params?: ReadonlyArray<string | number | null>): string;
export function d1(
  workerDir: string,
  sql: string,
  params?: ReadonlyArray<string | number | null>,
  options?: { local?: boolean },
): Array<Record<string, unknown>>;
