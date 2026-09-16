import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const CLI = resolve(new URL("../../../../../../packages/cli/src", import.meta.url).pathname);

/** `packages/cli/src/mailda.mjs`: the dispatcher, and what it dispatches to. */
export const CLI_ENTRY = join(CLI, "mailda.mjs");

/**
 * The CLI as one text: the dispatcher, `support.mjs`, and every verb module under `verbs/`. Split on
 * 16 September 2026 from one 2,515-line file, so a test that reads the CLI for a command's words or the
 * shape of a guard reads all of it rather than the file that happens to hold `switch (verb)`.
 */
export function cliSource(): string {
  const files = [
    CLI_ENTRY,
    join(CLI, "support.mjs"),
    ...readdirSync(join(CLI, "verbs")).filter((one) => one.endsWith(".mjs")).map((one) => join(CLI, "verbs", one)),
  ];
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}
