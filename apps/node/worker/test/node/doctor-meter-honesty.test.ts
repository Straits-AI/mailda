import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The doctor cost meter reports a correct number for a reason that is not the meter being correct.
 *
 * `metered()` in `src/doctor.ts` increments on **`prepare`**, never on execution. So:
 *
 * | Written as | Meters as | Actually costs |
 * |:--|--:|--:|
 * | one statement, executed 25 times | 1 | 25 |
 * | `batch` of 8 statements | 8 | 1 |
 * | 200 inserts inside one `batch` | 200 | 1 |
 * | any Durable Object RPC | 0 | 1 |
 *
 * Today's figure is right anyway, because every `prepare` reachable from `runDoctor` is chained into exactly
 * one execution and nothing on that path uses `batch`. That coincidence is what this file pins. It is a
 * **landmine** in the AGENTS.md sense — correct now, with nothing to notice when it stops being correct — and
 * a landmine is what a tripwire is for.
 *
 * ## Why source inspection rather than a runtime assertion
 *
 * A runtime test would have to reproduce a reused statement to prove the meter undercounts, which asserts
 * something about the meter rather than about the doctor path. The property that keeps the *number* honest is
 * structural: on the doctor path, prepare-count equals execution-count. That is a fact about how the source
 * is written, so it is checked where it lives.
 *
 * ## What this does not claim
 *
 * It does not claim the meter is a good instrument. It is not, and `doctor.ts` now says so: Butler step
 * costing was going to reuse it and would have priced `mail.send.propose` at 6 subrequests against a real 10,
 * missing four vault RPCs entirely. This test exists so the *existing* figure cannot drift, not to bless the
 * mechanism for reuse.
 */

const workerDir = join(import.meta.dirname, "..", "..");
const srcDir = join(workerDir, "src");

/**
 * The doctor path: `doctor.ts` plus **exactly what it imports from `src/`**, derived rather than asserted.
 *
 * The first version of this list was taken from a report and included `auth/keys.ts`, which `doctor.ts` does
 * not import at all — so the guard failed on a `batch()` inside `rotateSigningKey`, a function `runDoctor`
 * never calls. A guard that cries wolf gets deleted, so the list is now the import list and a test below
 * checks it still matches, which means adding an import to `doctor.ts` fails here until somebody widens this
 * deliberately.
 *
 * The honest limit: this is one level deep. A helper that `reconcile.ts` imports is not inspected, so the
 * guard covers the files whose I/O `doctor` obviously performs and not a full call graph. Stated because a
 * reader should know what it does not cover.
 */
const DOCTOR_PATH = [
  "doctor.ts",
  "reconcile.ts",
  "reseal.ts",
  // Added deliberately with #64's `legal_holds_active` check: `holdsForReport` is one query on the doctor
  // path, so it is one prepare that must be one execution. `placeHold` in the same file goes through
  // `auditedBatch`, which `runDoctor` never reaches — and would not trip the `.batch(` guard below in any
  // case, since the call has no dot before `batch`. Worth knowing, because that is the shape a real batch on
  // this path would hide behind.
  "holds.ts",
  join("auth", "kek.ts"),
  join("auth", "jwt.ts"),
  "keyvault.ts",
];

function read(relative: string): string | null {
  try {
    return readFileSync(join(srcDir, relative), "utf8");
  } catch {
    return null;
  }
}

describe("the doctor cost meter's figure rests on a property, so the property is pinned", () => {
  it("names files that exist, so the guard cannot pass by checking nothing", () => {
    const missing = DOCTOR_PATH.filter((relative) => read(relative) === null);
    // A renamed file must fail here rather than silently drop out of the check. `reseal.ts` and `keys.ts`
    // have moved once already in this repository's history.
    expect(missing, `unreadable: ${missing.join(", ")} — update DOCTOR_PATH deliberately`).toEqual([]);
  });

  it("matches what doctor.ts actually imports, so the list cannot quietly go stale", () => {
    // The list above is the thing most likely to rot: an import added to doctor.ts brings I/O the guard
    // below would not see. Deriving it here means widening the list is a deliberate act.
    const source = read("doctor.ts")!;
    const imported = [...source.matchAll(/^import .*? from "\.\/([^"]+)"/gm)]
      .map((match) => match[1]!)
      .filter((relative) => relative.endsWith(".ts"));
    const listed = new Set(DOCTOR_PATH.map((relative) => relative.replace(/\\/g, "/")));
    const unlisted = imported.filter((relative) => !listed.has(relative));
    expect(
      unlisted.length === 0 ? null
        : `doctor.ts imports ${unlisted.join(", ")}, which DOCTOR_PATH does not cover — the meter's figure `
          + "now depends on files this guard does not inspect",
    ).toBeNull();
  });

  it("uses no batch() on the doctor path, which the meter counts as zero executions", () => {
    const offenders: string[] = [];
    for (const relative of DOCTOR_PATH) {
      const source = read(relative);
      if (source === null) continue;
      // `.batch(` on any of these files means the meter is now undercounting executions, and
      // `doctor.max_subrequests_per_run` stops meaning what its receipt says it means.
      if (/\.batch\s*\(/.test(source)) offenders.push(relative);
    }
    expect(
      offenders.length === 0 ? null
        : `batch() on the doctor path (${offenders.join(", ")}): the meter counts prepares, not `
          + "executions, so a batch reports its statement count and costs one subrequest — re-measure "
          + "docs/receipts/doctor-check-cost.md before allowing this",
    ).toBeNull();
  });

  it("prepares no statement it does not immediately execute", () => {
    // The property that makes prepare-count equal execution-count: every `prepare(...)` is chained into
    // exactly one of `.first(`, `.all(`, `.run(` — possibly via `.bind(...)` — rather than being stored in a
    // variable and executed later, or executed more than once.
    const offenders: string[] = [];
    for (const relative of DOCTOR_PATH) {
      const source = read(relative);
      if (source === null) continue;
      // A `prepare` whose statement is assigned to a name is the shape that breaks the equality: it can be
      // executed zero times, or many. `const x = env.X.prepare(` / `= db.prepare(`.
      const assigned = /(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*[\w.]*\bprepare\s*\(/g;
      for (const match of source.matchAll(assigned)) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${relative}:${line}`);
      }
    }
    expect(
      offenders.length === 0 ? null
        : `a prepared statement is bound to a name on the doctor path (${offenders.join(", ")}). The meter `
          + "counts one subrequest when it is prepared, regardless of how many times it is executed — so "
          + "this makes docs/receipts/doctor-check-cost.md's figure a claim about the source rather than "
          + "about the cost",
    ).toBeNull();
  });

  it("keeps the meter's blind spot written down where somebody would reuse it", () => {
    // The comment is load-bearing: the next person to need a cost meter will find this one first, and the
    // reason not to reuse it has to be attached to it rather than living in an issue.
    const source = read("doctor.ts")!;
    for (const phrase of ["counts `prepare`, not execution", "Durable Object RPCs are invisible",
                          "must not be reused"]) {
      expect(source, `doctor.ts no longer explains the meter's limits: missing "${phrase}"`)
        .toContain(phrase);
    }
  });
});
