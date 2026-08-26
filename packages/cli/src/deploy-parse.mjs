import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The parts of `mailda deploy` that read text, split out so they can be tested (#98).
 *
 * ## Why a separate module
 *
 * `mailda.mjs` dispatches on `process.argv` at the top level, so importing it *runs* it. This repository has
 * already paid for that lesson once: the SDK's generator had a top-level `writeFileSync`, so the test meant
 * to catch a hand edit regenerated the file before it could read one. A module with a top-level side effect
 * cannot be imported by the thing that checks it, and the fix both times is the same seam — the pure part in
 * its own file, the side-effecting part importing it.
 *
 * ## Why these three are worth testing at all
 *
 * The deploy sequence's safety rests on never shifting traffic to an unchecked version, and a failed check
 * needs no rollback because `versions upload` moves no traffic. There is exactly one way to defeat that:
 * **promote the wrong version**, by misreading an id. That is a pure string function, so it gets real tests
 * rather than a lexical guard.
 */

/** A version id, out of wrangler's prose. `null` rather than a guess: the caller refuses on null. */
export function versionIdFrom(text) {
  const match = /Worker Version ID:\s*([0-9a-f-]{36})/i.exec(text)
    ?? /Version ID:\s*([0-9a-f-]{36})/i.exec(text)
    ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(text);
  return match?.[1] ?? null;
}

/**
 * The canary's preview URL.
 *
 * The trailing punctuation strip is not cosmetic: wrangler prints the URL inside a sentence, and a full stop
 * carried into a `fetch` is a 404 that reads as a broken canary rather than as a parse bug.
 */
export function previewUrlFrom(text) {
  const match = /(https:\/\/canary-[^\s]+\.workers\.dev)/i.exec(text)
    ?? /Version Preview URL:\s*(https:\/\/[^\s]+)/i.exec(text);
  return match?.[1]?.replace(/[.,)]+$/, "") ?? null;
}

/**
 * The pending migrations that contract, given wrangler's `migrations list` output.
 *
 * The phase is read from **this repository's own files** rather than parsed out of wrangler's table. That is
 * deliberate: a change to how wrangler formats that table would otherwise produce an empty list, which reads
 * as "nothing contracts" and lets a contraction through — a silent failure in the guard, which is the shape
 * this whole ticket is about. A name wrangler prints that this checkout does not have is ignored, because it
 * belongs to a version of the Node this checkout is not.
 */
export function contractingAmong(listOutput, migrationsDir) {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => listOutput.includes(name))
    .filter((name) => /^--\s*phase:\s*contract\b/im.test(readFileSync(resolve(migrationsDir, name), "utf8")));
}

/**
 * Whether a canary's verdict is good enough to move traffic to.
 *
 * A function rather than an inline comparison, and the reason is a test that failed to catch anything. The
 * gate was `if (verdict !== "ok") fail(...)`, asserted **lexically** — a test read the source between the
 * check and the traffic shift and required it to contain `fail(` and to mention `verdict !== "ok"`. Both
 * remained true when the condition was mutated to `if (false && verdict !== "ok")`, which disables the gate
 * entirely. The test passed against a deploy that promotes a broken canary.
 *
 * So the decision moves here, where it can be called with a value and checked against an answer. The lexical
 * test keeps only the claim it can actually support: that the call site consults this before promoting.
 *
 * `degraded` does **not** promote. That is the interesting half: a degraded Node is one with a real finding —
 * no key escrow, a blind delivery channel, a stalled outbox — and "it started up" is not the bar for moving
 * every request onto it. An operator who has read the finding and decided it is acceptable promotes by hand,
 * with the command the refusal prints.
 */
export function shouldPromote(verdict) {
  return verdict === "ok";
}
