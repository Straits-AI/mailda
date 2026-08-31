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

/**
 * The version currently serving, out of `wrangler deployments list` — the last one holding traffic.
 *
 * Replaced `previewUrlFrom`, which parsed a hostname that can never exist: Cloudflare does not generate
 * preview URLs for Workers implementing a Durable Object.
 */
export function activeVersionFrom(text: string): string | null;

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
