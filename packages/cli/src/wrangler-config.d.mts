/**
 * Types for `wrangler-config.mjs`, so a TypeScript test can import it. Hand-written like
 * `preflight.d.mts`, and compared against the module's real exports by `test/node/declaration-drift.test.ts`.
 */

import type { Account } from "./preflight.mjs";

/** The last `count` lines wrangler wrote to stderr: colour removed, blank lines and npm's `notice` / `warn` lines dropped. */
export function wranglerSaid(stderr: string, count: number): string[];

/** The token from `wrangler auth token --json`, or why there is none. `error` never quotes stdout; it may quote stderr. */
export function tokenFrom(stdout: string, status: number, stderr?: string):
  | { token: string; error: null }
  | { token: null; error: string };

/** Who `wrangler whoami --json` says is signed in: signed in with its accounts, signed out, or unreadable. */
export function whoamiFrom(stdout: string, status: number, stderr?: string):
  | { state: "signed_in"; authType: string; accounts: Account[] }
  | { state: "signed_out" }
  | { state: "unreadable"; detail: string };
