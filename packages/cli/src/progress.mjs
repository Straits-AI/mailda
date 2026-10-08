/**
 * Where a long command is, and how much is left (8 October 2026, the owner's: "better progress indication on which
 * step we are now and how many steps left"). `mailda install`, `mailda upgrade` and `mailda setup` each name their
 * steps once, up front, and print a banner as each begins: "Step 3 of 7 · Back up the Node". The commands they call
 * (the deploy, the backup) keep their own `==` lines, which read as the parts of the step they sit under.
 *
 * The steps are a list the command declares, so a banner can never claim a step that is not in it: asking for one
 * that is not throws, which is a defect in the command, not something the operator did.
 */

import { plural } from "@mailda/runtime";

/** The line a banner is drawn to, the width the commands wrap their prose at. */
const WIDTH = 96;

/** A step's banner, pure. `at` counts from 1. */
export function banner(at, of, name) {
  const text = `━━ Step ${at} of ${of} · ${name} `;
  return `\n${text}${"━".repeat(Math.max(3, WIDTH - [...text].length))}\n`;
}

/** The list a command opens with, pure: every step, numbered, so how many are left is known from the start. */
export function overview(steps) {
  return `   ${steps.length} ${plural(steps.length, "step", "steps")}:\n${steps.map((one, i) => `     ${String(i + 1).padStart(2)}  ${one}\n`).join("")}`;
}

/**
 * A command's steps. `step(name)` prints that step's banner; steps may be skipped (a code already current, a claim
 * left for the browser), and the number is always the step's own place in the list, never a count of banners shown.
 */
export function progress(steps, out = (text) => process.stdout.write(text)) {
  out(overview(steps));
  return {
    step(name) {
      const at = steps.indexOf(name);
      if (at < 0) throw new Error(`"${name}" is not one of this command's steps: ${steps.join(", ")}`);
      out(banner(at + 1, steps.length, name));
    },
  };
}
