import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { statementsOf } from "../../src/sql-statements.ts";

/**
 * Guards the assumption `src/migrate.ts` makes about its own SQL.
 *
 * The Node applies its own schema by splitting each migration into statements, which is **wrong for SQL in
 * general** — a semicolon inside a string literal, a comment or a `BEGIN … END` trigger body is not a
 * statement boundary. `statementsOf` is a small tokenizer that knows about all four, and this file is what
 * keeps its knowledge matched to the files it is asked to split.
 *
 * ## What changed on 20 August 2026, and why the old assertion is gone rather than relaxed
 *
 * This file used to assert that **no migration contained a trigger**, with the standing instruction that
 * the moment one was genuinely needed, `statementsOf` should become a real parser rather than gain a rule
 * about how to write SQL. #49 needed one: migration 0027 makes a published Butler version's content
 * unwritable *in the database* rather than merely unwritten, which is a `BEFORE UPDATE … BEGIN SELECT
 * RAISE(ABORT, …); END` trigger, and a trigger body's inner semicolon is mandatory in SQLite's grammar.
 *
 * So the splitter grew a depth counter over `BEGIN`/`CASE`/`END`, and the assertion that used to forbid the
 * construct is replaced by assertions that the construct **survives the split** — including the two ways a
 * naive depth counter gets it wrong: a `CASE … END` inside a body, and a keyword inside a string.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../migrations");

function files(): string[] {
  return readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
}

describe("migration SQL stays splittable", () => {
  it("keeps every real trigger body whole, semicolons and all", () => {
    const withTriggers = files().filter((file) =>
      /\bCREATE\s+TRIGGER\b/i.test(readFileSync(join(migrationsDir, file), "utf8")));

    // Anti-vacuity, and the reason it is asserted rather than assumed: the loop below is about triggers, so
    // if the repository ever had none this test would pass by not running — which is exactly the state it
    // was written to replace.
    expect(withTriggers.length, "no migration declares a trigger; this test has nothing to check")
      .toBeGreaterThan(0);

    for (const file of withTriggers) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      const declared = [...sql.matchAll(/CREATE\s+TRIGGER\s+([a-z_]+)/gi)].map((match) => match[1]!);
      const split = statementsOf(sql);
      for (const name of declared) {
        const statement = split.find((one) => new RegExp(`CREATE\\s+TRIGGER\\s+${name}\\b`, "i").test(one));
        expect(statement, `${file}: ${name} did not survive as one statement`).toBeDefined();
        // A body cut in half is the failure mode, and it is invisible in a count: the fragment still looks
        // like SQL. So the whole `BEGIN … END` has to be inside the same statement as its `CREATE TRIGGER`.
        expect(statement, `${file}: ${name} lost its body`).toMatch(/\bBEGIN\b[\s\S]*\bEND\b/i);
      }
    }
  });

  it("does not split inside a BEGIN … END body", () => {
    expect(statementsOf(
      "CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, 'no'); END; SELECT 9",
    )).toEqual([
      "CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, 'no'); END",
      "SELECT 9",
    ]);
  });

  it("counts CASE … END, so a CASE inside a body does not close it early", () => {
    // The way a BEGIN-only depth counter breaks: `CASE`'s own `END` drops the depth to zero and the next
    // semicolon cuts the body in half. Two statements out means it held; three means it did not.
    const sql = "CREATE TRIGGER t BEFORE UPDATE ON a BEGIN "
      + "SELECT CASE WHEN new.x IS NULL THEN 1 ELSE 2 END; "
      + "SELECT RAISE(ABORT, 'no'); END; SELECT 9";
    const split = statementsOf(sql);
    expect(split).toHaveLength(2);
    expect(split[0]).toContain("RAISE(ABORT, 'no')");
    expect(split[1]).toBe("SELECT 9");
  });

  it("does not treat a keyword inside a string or a comment as a block", () => {
    // `'BEGIN'` is text. A tokenizer that scanned keywords before consuming quoted runs would open a block
    // that never closes and swallow the rest of the file into one statement.
    expect(statementsOf("INSERT INTO a VALUES ('BEGIN'); SELECT 1")).toEqual([
      "INSERT INTO a VALUES ('BEGIN')", "SELECT 1",
    ]);
    expect(statementsOf("SELECT 1; -- BEGIN a block that is only prose\nSELECT 2")).toEqual([
      "SELECT 1", "SELECT 2",
    ]);
  });

  it("does not treat BEGINNING or ENDPOINT as block keywords", () => {
    expect(statementsOf('CREATE TABLE a ("beginning" TEXT, endpoint TEXT); SELECT 1')).toEqual([
      'CREATE TABLE a ("beginning" TEXT, endpoint TEXT)', "SELECT 1",
    ]);
  });

  it("survives a stray END without swallowing the rest of the file", () => {
    // Depth must not go negative. If it did, every later semicolon would be "inside" a block.
    expect(statementsOf("SELECT 1 END; SELECT 2; SELECT 3")).toEqual(["SELECT 1 END", "SELECT 2", "SELECT 3"]);
  });

  it("has no migration opening its own transaction", () => {
    // `statementsOf` counts `BEGIN` as a block opener, which is right for a trigger body and would be wrong
    // for `BEGIN TRANSACTION`. It never arises because these are applied through `batch()`, which *is* the
    // transaction — asserted here rather than left as a comment in the splitter.
    for (const file of files()) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      expect(/\bBEGIN\s+(TRANSACTION|DEFERRED|IMMEDIATE|EXCLUSIVE)\b/i.test(sql), file).toBe(false);
    }
  });

  it("does not split on a semicolon inside a string literal", () => {
    expect(statementsOf("INSERT INTO a VALUES ('one;two'); SELECT 1")).toEqual([
      "INSERT INTO a VALUES ('one;two')", "SELECT 1",
    ]);
  });

  it("treats '' as an escaped quote rather than the end of a string", () => {
    // The classic way a hand-rolled splitter corrupts data: seeing `''` as close-then-open and losing
    // track of whether it is inside a literal for the rest of the file.
    expect(statementsOf("INSERT INTO a VALUES ('it''s; fine'); SELECT 2")).toEqual([
      "INSERT INTO a VALUES ('it''s; fine')", "SELECT 2",
    ]);
  });

  it("does not split on a semicolon inside a trailing comment", () => {
    // The case that made a tokenizer worth writing: every migration here has trailing prose comments,
    // and a whole-line strip does not remove them.
    expect(statementsOf("CREATE TABLE a (id TEXT); -- keep this; and this\nSELECT 3")).toEqual([
      "CREATE TABLE a (id TEXT)", "SELECT 3",
    ]);
  });

  it("does not split on a semicolon inside a block comment", () => {
    expect(statementsOf("SELECT 1 /* a ; b */ ; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps a semicolon inside a quoted identifier", () => {
    expect(statementsOf('CREATE TABLE "odd;name" (id TEXT); SELECT 4')).toEqual([
      'CREATE TABLE "odd;name" (id TEXT)', "SELECT 4",
    ]);
  });

  it("tolerates a trailing statement with no terminator", () => {
    expect(statementsOf("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("splits every real migration into at least one statement, losing none", () => {
    for (const file of files()) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      const split = statementsOf(sql);
      expect(split.length, file).toBeGreaterThan(0);
      // Every CREATE TABLE in the file has to survive as its own statement, which is the property
      // migrate.ts depends on and the one a broken splitter would quietly violate.
      const tables = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/gi)];
      for (const table of tables) {
        expect(split.some((s) => new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${table[1]}\\b`, "i").test(s)),
          `${file}: ${table[1]}`).toBe(true);
      }
    }
  });

  it("is the same list src/migrate.ts bundles", async () => {
    // A migration file that exists but is not imported would never be applied by a self-migrating
    // Node, and nothing else would notice — the CLI would apply it and the Node would not.
    const source = readFileSync(resolve(here, "../../src/migrate.ts"), "utf8");
    const imported = [...source.matchAll(/from "\.\.\/migrations\/([^"]+)"/g)].map((m) => m[1]!).sort();
    expect(imported).toEqual(files());
  });

  it("registers each import in MIGRATIONS, under its own name, in order", () => {
    /*
     * Importing a migration is half of bundling it. The other half is the `MIGRATIONS` array, and until this
     * test existed nothing checked it: deleting the `{ name: "0021_hold_lift.sql", sql: m0021 }` line left the
     * check above green, because the import was still there. What caught it was eslint's `no-unused-vars`
     * noticing the orphaned binding — a real check, doing this job by accident, and one that a `void m0021`
     * or a second use of the same import would silence.
     *
     * So the pairing is asserted directly, in both directions and in order:
     *
     *   - every imported file appears in `MIGRATIONS`, and nothing else does;
     *   - each entry's `sql` is **that file's own** binding, so `{ name: "0021…", sql: m0020 }` fails rather
     *     than silently applying 0020 twice and 0021 never;
     *   - the order is the file order, because these run in sequence and a reordered pair is a schema that
     *     depends on which Node applied it.
     */
    const source = readFileSync(resolve(here, "../../src/migrate.ts"), "utf8");
    const bindingOf = new Map(
      [...source.matchAll(/import\s+(\w+)\s+from\s+"\.\.\/migrations\/([^"]+)"/g)]
        .map((match) => [match[2]!, match[1]!] as const),
    );
    // Anti-vacuity: an import syntax this stopped recognising would make every comparison below empty.
    expect(bindingOf.size).toBe(files().length);

    const registered = [...source.matchAll(/\{\s*name:\s*"([^"]+)",\s*sql:\s*(\w+)\s*\}/g)]
      .map((match) => ({ name: match[1]!, binding: match[2]! }));

    expect(
      registered.map((entry) => entry.name),
      "MIGRATIONS must register every bundled migration exactly once, in file order — an imported migration "
        + "missing from this array is never applied, and only an unused-import lint rule would notice",
    ).toEqual(files());
    expect(
      registered.filter((entry) => bindingOf.get(entry.name) !== entry.binding),
      "a MIGRATIONS entry whose sql is not the binding its own name was imported as",
    ).toEqual([]);
  });
});
