import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Keeps `doctor`'s expected-table list honest against the migrations.
 *
 * The list has to be a literal in `doctor.ts` — a Worker cannot read `migrations/*.sql` at runtime — and
 * a literal is exactly the kind of thing that stops describing reality. It did: it stopped at migration
 * 0006, omitting the five tables added by 0007 (outbound) and 0008 (audit), so `migrations_applied`
 * reported OK on a Node missing a third of its schema. Its own `fix` text says "a Node with a partial
 * schema accepts mail it cannot file", which is precisely what it would have allowed.
 *
 * Found by installing the product for real: the button install reported "Missing 14 table(s)" when 19
 * were absent, and the gap between those numbers is this bug.
 */

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "../..");

/** Tables the migrations create, in the order SQLite would have them. */
function tablesFromMigrations(): string[] {
  const dir = join(workerDir, "migrations");
  const created = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/gi)) {
      created.add(match[1]!);
    }
    // A migration may also drop one; honour that so a rename does not read as an addition.
    for (const match of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_]+)/gi)) {
      created.delete(match[1]!);
    }
  }
  return [...created].sort();
}

/** `doctor`'s list, parsed from source so the test cannot drift from what the Worker actually checks. */
function tablesFromDoctor(): string[] {
  const source = readFileSync(join(workerDir, "src/doctor.ts"), "utf8");
  const block = /const EXPECTED_TABLES = \[([\s\S]*?)\];/.exec(source);
  if (block === null) throw new Error("EXPECTED_TABLES not found in src/doctor.ts");
  return [...block[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
}

describe("doctor's expected tables", () => {
  it("matches exactly what the migrations create", () => {
    // If this fails, a migration added or removed a table and doctor did not follow. Update
    // EXPECTED_TABLES in src/doctor.ts — do not relax this test, because the whole point of that
    // constant is to notice a schema that is only partly applied.
    expect(tablesFromDoctor()).toEqual(tablesFromMigrations());
  });

  it("covers every migration file, not just the early ones", () => {
    // The failure mode was silent omission of later migrations, so the count is asserted separately:
    // a list that happens to match a subset would satisfy nothing useful.
    expect(tablesFromMigrations().length).toBeGreaterThanOrEqual(19);
  });
});
