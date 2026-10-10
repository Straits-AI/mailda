/**
 * Types for `api-call.mjs`, so a TypeScript test can import it. Hand-written like `preflight.d.mts`, and compared
 * against the module's real exports by `test/node/declaration-drift.test.ts`.
 */
import type { RouteSpec } from "@mailda/contract/routes";

/** Every route, by the name the SDK and MCP use for it. */
export function methods(): Array<{ name: string; spec: RouteSpec }>;

/** The request a `mailda api` command line asks for, or the usage refusal that stops it before anything is sent. */
export function requestFor(name: string, argv: readonly string[]):
  | { usage: string }
  | {
    usage: null;
    method: string;
    template: string;
    params: Record<string, string>;
    query: Record<string, string>;
    body: string | undefined;
    out: string | undefined;
    binary: boolean;
  };

/** The Blueprint's exit category (§19) for the Node's HTTP status. */
export function exitCodeFor(status: number): number;
