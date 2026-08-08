import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Two columns that are named as though they mean something and do not.
 *
 * | Column | Declared | Actually |
 * |:--|:--|:--|
 * | `mailbox_items.change_number` | `INTEGER NOT NULL`, §12 invariant 5's monotonic counter | written as the literal `0` |
 * | `messages.thread_id` | `TEXT NOT NULL`, `thr_<ulid>`, indexed for grouping | minted **fresh per message** — a second message id |
 *
 * Both are honest in their own comments and dishonest in their names, which is exactly the shape AGENTS.md
 * calls a landmine: correct today, with nothing to notice when somebody relies on it. A monotonic counter
 * that is silently always zero is what a later sync protocol trips over, and a `thread_id` that never
 * groups is what a case would have been keyed on.
 *
 * Neither is a bug to fix here. Both are **decided**:
 *
 * - `change_number` stays a placeholder because choosing D1 compare-and-swap for Layer 3 decided that the
 *   monotonic change feed is not built — it is for sync, which is a Layer 6 concern and out of the map's
 *   scope.
 * - `thread_id` is superseded by `conversation_id`, per the resolution of *"What is a conversation, now
 *   that a case is created per one?"*. #10's expand/contract rule forbids a bare `DROP`, so disposal is a
 *   contracting migration behind a bookmark gate, later.
 *
 * So this file's job is to convert two landmines into one tripwire. It does not stop either column being
 * fixed — it stops either being *used*, and it fails loudly enough that whoever trips it goes and reads
 * the map instead of building on a zero.
 *
 * ## What it deliberately does not assert
 *
 * That every `change_number` row is `0`. On a fresh test database there are no `mailbox_items` rows at all,
 * so the assertion passes by having nothing to check — a vacuous green, which is the same failure mode as
 * the check it would be pretending to be. The source-level guard below is the whole value: the literal is
 * one line in one file, and this reads that line.
 */

const workerDir = join(import.meta.dirname, "..", "..");

/** The one file allowed to name them: it is what writes the placeholders. */
const WRITER = "src/materialise.ts";

const PLACEHOLDERS = ["change_number", "thread_id"] as const;

/**
 * Every `.ts`/`.tsx` under `src`, recursively.
 *
 * `src` only, and not `test`. A fixture inserting a row *must* name a `NOT NULL` column, so scanning tests
 * would force an allowlist that grows with every fixture and stops meaning anything. The risk being
 * guarded is production code starting to read a placeholder — a client type, an API projection, a query —
 * and all of that lives here.
 */
function sourceFiles(dir: string, prefix = "src"): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(join(workerDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...sourceFiles(rel, prefix));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push({ path: rel, text: readFileSync(join(workerDir, rel), "utf8") });
    }
  }
  return out;
}

describe("placeholder columns stay unused (change_number, thread_id)", () => {
  for (const column of PLACEHOLDERS) {
    it(`is named nowhere in src except ${WRITER} — ${column}`, () => {
      const offenders = sourceFiles("src")
        .filter((file) => file.path !== WRITER)
        .filter((file) => file.text.includes(column))
        .map((file) => file.path);

      // If this fails: `change_number` is always 0 and `thread_id` is unique per message. Neither means
      // what its name says. Read the Layer 3 entries on the wayfinder map before building on either —
      // the decision is that both stay placeholders until sync (change_number) or a contracting
      // migration (thread_id), and both have a stated path. Do not delete this test to proceed.
      expect(offenders).toEqual([]);
    });
  }

  it("still writes change_number as the literal 0", () => {
    const source = readFileSync(join(workerDir, WRITER), "utf8");
    // The literal, with its own comment beside it. If somebody serialises a real counter this fails, which
    // is correct: the map records that Layer 3 does not build the change feed, and making one means saying
    // so there first.
    expect(source).toMatch(/change_number is §12 invariant 5/);
    expect(source).toMatch(/^\s*0,\s*$/m);
  });

  it("still mints thread_id fresh per message", () => {
    const source = readFileSync(join(workerDir, WRITER), "utf8");
    // `ctx.id("thr")` inline in the INSERT — not a lookup, not a group key. When this becomes a real
    // grouping (or is replaced by conversation_id) this fails, and the map's Layer 3 decision entry is
    // the thing to update.
    expect(source).toContain('ctx.id("thr")');
  });

  it("has not been quietly dropped instead of contracted", () => {
    // #10's expand/contract rule: no `DROP` without a bookmark gate. A migration that removed either
    // column would make the guards above pass by having nothing to guard, so the columns are asserted to
    // still exist — the intended disposal is a contracting migration, which fails this and should.
    const migrations = readdirSync(join(workerDir, "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(join(workerDir, "migrations", name), "utf8"))
      .join("\n");

    expect(migrations).toContain("change_number INTEGER NOT NULL");
    expect(migrations).toContain("thread_id     TEXT NOT NULL");
    expect(migrations).not.toMatch(/DROP COLUMN\s+(change_number|thread_id)/i);
  });
});
