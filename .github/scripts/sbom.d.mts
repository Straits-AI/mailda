/**
 * Types for `sbom.mjs`, so a TypeScript test can import it.
 *
 * Hand-written for the same reason `packages/cli/src/deploy-parse.d.mts` is: these scripts run under `node`
 * with no build step, which is what keeps them files a person can read. That makes the declaration the one
 * thing here capable of drifting from its implementation — and it has drifted before, in the CLI's pair,
 * which kept exporting a function after the function was deleted.
 *
 * `test/node/declaration-drift.test.ts` compares both pairs as sets, in both directions.
 */

export interface SbomComponent {
  type: string;
  "bom-ref": string;
  name: string;
  version: string;
  purl: string;
  hashes?: Array<{ alg: string; content: string }>;
  externalReferences?: Array<{ type: string; url: string }>;
  properties?: Array<{ name: string; value: string }>;
}

export interface Sbom {
  bomFormat: string;
  specVersion: string;
  version: number;
  metadata: {
    timestamp: string;
    component: Record<string, unknown>;
    properties: Array<{ name: string; value: string }>;
  };
  components: SbomComponent[];
}

/**
 * The third-party components a lockfile resolves, with the count of entries it read.
 *
 * Throws rather than skipping an entry it cannot verify: an inventory missing a dependency answers
 * "is this dependency here?" with a confident no.
 */
export function componentsFromLock(lock: string): { components: SbomComponent[]; seen: number };

/** The workspace's own packages, read from the `pnpm-workspace.yaml` globs. */
export function workspaceComponents(): SbomComponent[];

/**
 * The whole document. `at` and `commit` are passed in rather than read from the clock or from git, so two
 * runs over one commit produce identical bytes.
 */
export function buildSbom(args: { lock: string; at: string; commit: string }): Sbom;
