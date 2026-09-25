/**
 * Types for `wrangler-config.mjs`, so a TypeScript test can import it. Hand-written like
 * `preflight.d.mts`, and compared against the module's real exports by `test/node/declaration-drift.test.ts`.
 */

/** The token wrangler's `default.toml` holds, or null. */
export function tokenFromWranglerConfig(toml: string): { token: string; expiresAt: string | null } | null;

/** Candidate paths for wrangler's `default.toml`, most specific first. */
export function wranglerConfigPaths(
  env: Record<string, string | undefined>, platform: string, home: string,
): string[];
