import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { statementsOf } from "../../src/sql-statements.ts";

/**
 * Guards the assumption `src/migrate.ts` makes about its own SQL.
 *
 * The Node applies its own schema by splitting each migration on `;`, which is **wrong for SQL in
 * general** — a semicolon inside a string literal or a `BEGIN … END` trigger body is not a statement
 * boundary. It is correct for these files, and correct only as long as they stay this shape. Rather
 * than pretend to a general SQL parser, the limit is stated and this test is what keeps it true.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../migrations");

function files(): string[] {
  return readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
}

describe("migration SQL stays splittable", () => {
  it("contains no trigger bodies, which a semicolon split would cut in half", () => {
    const offenders = files().filter((file) => {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      return /\bCREATE\s+TRIGGER\b/i.test(sql) || /\bBEGIN\b[\s\S]*\bEND\b/i.test(sql);
    });
    // If this fails, `statementsOf` will silently produce broken statements. Either write the trigger
    // as a single statement with no inner semicolons, or replace the splitter with a real parser.
    expect(offenders).toEqual([]);
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
});
