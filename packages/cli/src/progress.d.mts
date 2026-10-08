/** Types for `progress.mjs`, so a TypeScript test can import it. Hand-written like `credentials.d.mts`. */

/** A step's banner, pure: "━━ Step 3 of 7 · Back up the Node ━━━…". */
export function banner(at: number, of: number, name: string): string;

/** The numbered list a command opens with, pure. */
export function overview(steps: readonly string[]): string;

/** A command's steps; `step(name)` prints that step's banner and throws for a name not in the list. */
export function progress(steps: readonly string[], out?: (text: string) => void): { step(name: string): void };
