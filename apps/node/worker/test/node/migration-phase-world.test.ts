import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = join(import.meta.dirname, "../../migrations");

/**
 * A closed world over which migrations break the code that is already running (#98).
 *
 * ## The hazard, and why ordering alone does not fix it
 *
 * `mailda deploy` used to deploy the Worker and *then* apply migrations, so new code served requests against
 * a schema that did not have what it needed — and if the migration failed, the incompatible Worker stayed
 * deployed. The stated reason for that order was that *"the Worker bundles them"*, which is false: wrangler
 * reads migration files from this directory and needs no deployed Worker at all.
 *
 * But simply swapping the two is also unsafe, and that is the whole point of this file. A migration that
 * **drops, renames or narrows** something breaks the code that is *currently* serving, so applying it first
 * is the same window pointing the other way. There is no order that makes both safe. What makes both safe is
 * splitting migrations into two kinds:
 *
 * | phase | may | when |
 * |:--|:--|:--|
 * | **expand** | add tables, columns, indexes, triggers, backfills | before the new code, always |
 * | **contract** | drop, rename, narrow | a **later** release, once rollback is no longer wanted |
 *
 * ## Why this is a test and not a convention
 *
 * Because it was a convention and that did not work. Five of thirty-nine migrations carried a hand-written
 * line saying *"No DROP TABLE, no DROP COLUMN, no column rewrite, no bookmark gate"* — a habit from one
 * period of the project, not a rule, and the thirty-four without it were indistinguishable from unexamined.
 * A convention observed by one file in eight is a convention nobody can rely on, which is this repository's
 * most repeated defect wearing a `.sql` extension.
 *
 * So the phase is **derived** from what the statements actually do, and a migration whose statements say
 * `contract` while its marker says nothing fails here by name. Nothing has to be remembered.
 */

/**
 * Statements that break code already running against the old schema.
 *
 * `DROP INDEX` is deliberately absent, and three migrations contain one: an index is invisible to a query's
 * correctness, so dropping or widening one cannot break a running Worker. It changes what a plan costs,
 * which is a receipt's problem rather than a deployment's.
 *
 * `DROP TRIGGER` is absent for a narrower reason worth stating: the two that exist (`0031`, `0035`) drop and
 * immediately recreate a `btv_frozen` guard inside the same migration, so no window exists where the guard
 * is missing. A migration that dropped a trigger and left it dropped would be a real contraction, and it
 * would not be caught here — named as a gap rather than left to be discovered.
 */
const CONTRACTING = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bRENAME\s+COLUMN\b/i,
  /\bRENAME\s+TO\b/i,
];

/** The marker a contracting migration must carry, on a line of its own. */
const CONTRACT_MARKER = /^--\s*phase:\s*contract\b/im;

/** SQL with comments removed, so an annotation *describing* a DROP is not mistaken for one. */
function statementsOf(source: string): string {
  return source.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
}

const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

describe("every migration declares whether it can run ahead of the code", () => {
  it("has migrations to inspect, so nothing below passes by scanning nothing", () => {
    // Anti-vacuity. Every assertion here is a loop, and a loop over nothing agrees with everything.
    expect(files.length).toBeGreaterThan(30);
  });

  it("marks every contracting migration, and marks nothing else", () => {
    /*
     * Both directions, and the second matters as much as the first. A marker on a migration that contracts
     * nothing would train a reader to ignore markers, which is how the previous hand-written annotation
     * stopped meaning anything.
     */
    const wrong: string[] = [];
    for (const name of files) {
      const source = readFileSync(join(migrationsDir, name), "utf8");
      const contracts = CONTRACTING.some((pattern) => pattern.test(statementsOf(source)));
      const marked = CONTRACT_MARKER.test(source);
      if (contracts && !marked) {
        wrong.push(
          `${name} drops, renames or narrows something and carries no \`-- phase: contract\` marker. It `
          + "cannot be applied ahead of the code that is already serving, so `mailda deploy` must refuse it "
          + "without --contract. Add the marker, or split the contraction into a later release.",
        );
      }
      if (!contracts && marked) {
        wrong.push(
          `${name} is marked \`-- phase: contract\` and contracts nothing. A marker on a safe migration is `
          + "how the marker stops being read.",
        );
      }
    }
    expect(wrong.length === 0 ? null : wrong.join("\n")).toBeNull();
  });

  it("knows which ones contract, so the derivation is not matching everything or nothing", () => {
    /*
     * The derivation itself, pinned. Three migrations in this repository contract — two `RENAME COLUMN` on
     * `approvals`, and #153's `DROP TABLE` on the two search indexes — and if that set silently became empty
     * (a broken regex) or everything (a regex matching prose) the assertion above would pass while checking
     * nothing.
     *
     * `0054` is the first contraction that is not a rename, and it is worth naming why it is one: FTS5 has no
     * `ALTER TABLE ADD COLUMN`, so #153's day token means a new table, and the new code queries a column the
     * old table does not have. It is also the first whose expensive half is the point of running it
     * deliberately — it requeues every message for the body backfill.
     *
     * Written as the expected set rather than a count, so a third contraction has to be added here
     * deliberately and a reader can see what the two are.
     */
    const contracting = files.filter((name) => CONTRACTING.some(
      (pattern) => pattern.test(statementsOf(readFileSync(join(migrationsDir, name), "utf8"))),
    ));
    expect(contracting).toEqual([
      "0021_hold_lift.sql", "0026_send_breakers.sql", "0054_search_day_token.sql",
    ]);
  });

  it("does not mistake an annotation for a statement", () => {
    /*
     * Five migrations carry prose saying "No DROP TABLE, no DROP COLUMN" — the old hand-written convention.
     * A scanner reading comments would classify every one of them as contracting, which is how a check comes
     * to fail on the files that were most carefully written.
     */
    const annotated = files.filter((name) => /No DROP TABLE/.test(
      readFileSync(join(migrationsDir, name), "utf8"),
    ));
    expect(annotated.length, "the fixture for this assertion has gone").toBeGreaterThan(0);
    for (const name of annotated) {
      const source = readFileSync(join(migrationsDir, name), "utf8");
      expect(/\bDROP\s+TABLE\b/i.test(statementsOf(source)), `${name} read as dropping a table`).toBe(false);
    }
  });
});
