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

/** One entry of wrangler's output file (`WRANGLER_OUTPUT_FILE_PATH`): `type` and whatever that type carries. */
export interface OutputEntry {
  type?: string;
  [field: string]: unknown;
}

/** The entries of wrangler's output file, one JSON object per line. Throws on a line that is not JSON. */
export function outputEntries(text: string): OutputEntry[];

/** The uploaded version's id, from the last `version-upload` entry, or `null` — never a guess. */
export function versionIdFrom(entries: OutputEntry[]): string | null;

/** The Node's workers.dev address, from the last `deploy` entry's `targets`, or null. */
export function workersDevUrlFrom(entries: OutputEntry[]): string | null;

/** The deployment id from the last `version-deploy` entry, or null. Its `version_traffic` is `{}` in 4.118.0. */
export function deploymentIdFrom(entries: OutputEntry[]): string | null;

/**
 * The version serving now, from `wrangler deployments status --json`: the one version holding traffic, or
 * `null` when there is not exactly one (or the answer is not JSON).
 *
 * Replaced a read of `deployments list` that took the last `(N%) <uuid>` line on a row-order assumption, which
 * itself replaced `previewUrlFrom`: Cloudflare does not generate preview URLs for Workers implementing a
 * Durable Object.
 */
export function activeVersionFrom(statusJson: string): string | null;

/**
 * The version id a doctor report says answered, or `null` if it did not say so in a form worth trusting.
 *
 * `unknown` rather than a report interface, because the caller has just parsed arbitrary JSON off the
 * network. Narrowing that to a shape here would be a claim about a response this function exists to doubt.
 */
export function servedVersionOf(report: unknown): string | null;

/** The pending migrations that contract, read from this repository's own files. */
export function contractingAmong(listOutput: string, migrationsDir: string): string[];

/**
 * Whether the canary is safe to promote, judged against what is already serving.
 *
 * Replaced `shouldPromote`, which compared the canary's verdict against `"ok"` — and so refused a canary
 * whose only finding was one the incumbent already had. A canary answers whether the new code is *worse*.
 */
export function promotionVerdict(args: { canary: unknown; incumbent: unknown }): {
  promote: boolean;
  blocking: string[];
  carried: string[];
  why: string | null;
};

/** `mailda doctor`'s exit code: its verdict is its answer. refuse=2, degraded=1, ok=0. */
export function doctorExitCode(verdict: string | undefined): number;

/**
 * `mailda deploy`'s exit code. A deploy that happened is a success unless the Node now refuses.
 *
 * A pre-existing degradation is not a deploy failure — and the gate already refused anything the canary made
 * worse, so a carried finding is the incumbent's condition rather than this command's doing.
 */
export function deployExitCode(verdict: string | undefined): number;

/**
 * `wrangler.jsonc` as a second Node would have it (`mailda deploy --name`): the Worker's `name`, the
 * Workflow's `name` (`<worker>-butler-runs`) and `vars.WORKER_NAME` rewritten, comments kept.
 */
export function deriveConfig(source: string, name: string, hostname?: string | null): string;

/** The custom domain a config carries (`pattern` beside `custom_domain: true`), or null. */
export function hostnameIn(config: string): string | null;

/** The Worker's name as the config states it, or null when the config names none. */
export function workerNameIn(config: string): string | null;

/** The Workflows one page of `wrangler workflows list` shows. `[]` for an empty page or one past the last. */
export function workflowRowsFrom(text: string): Array<{ name: string; script: string; className: string }>;
