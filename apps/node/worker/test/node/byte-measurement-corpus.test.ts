import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The measuring script's schema copy is the third one, and it is the copy nothing watched.
 *
 * ## The failure this closes, which has now happened four times
 *
 * `docs/receipts/message-metadata-bytes.md` sets §11B's shard thresholds, and re-measuring it needs remote D1
 * — so `scripts/measure-message-bytes.mjs` **restates** the `messages` schema instead of reading
 * `migrations/`. There are therefore three copies: the migrations, `test/schema-drift.test.ts`'s
 * `MEASURED_SHAPE`, and the script's `SCHEMA`. The drift test compares its own copy against the migrated
 * database. **Nothing compared the script's.**
 *
 * Every consequence has been in the same direction, which is what makes it dangerous:
 *
 * | round | what the script omitted | what it reported |
 * |:--|:--|:--|
 * | #107 L2 | `body_indexed_at` | unchanged — because the column was absent |
 * | 0044, first run | the four state columns | unchanged |
 * | 0044, second run | `msg_body_index_due` | unchanged |
 * | 0048 | `body_index_attempt_version` | would have been unchanged |
 *
 * A measurement that omits something reports that the thing costs nothing. Four rounds of good news, three of
 * them false, each caught by somebody rereading the script rather than by anything that fails. The receipt and
 * the script both carry a comment warning about it, which is precisely the shape of defect this repository
 * keeps meeting: **a comment describing a hazard reads as a guard against it.**
 *
 * ## What this asserts
 *
 * That the script's `SCHEMA` names exactly the columns and indexes `MEASURED_SHAPE` does. Not against the
 * migrations directly — `MEASURED_SHAPE` is already pinned to the migrated database by `schema-drift`, so
 * chaining to it means one comparison rather than a second SQL parser, and the two guards compose: drift
 * catches the schema moving, this catches the script failing to follow.
 */

const worker = new URL("../..", import.meta.url).pathname;
const script = readFileSync(`${worker}/scripts/measure-message-bytes.mjs`, "utf8");
const drift = readFileSync(`${worker}/test/schema-drift.test.ts`, "utf8");

/** The `CREATE TABLE`/`CREATE INDEX` block the script seeds its scratch database with. */
function scriptSchema(): string {
  const start = script.indexOf("const SCHEMA = `");
  expect(start, "the script's SCHEMA constant has moved or been renamed").toBeGreaterThan(-1);
  const body = script.slice(start + "const SCHEMA = `".length);
  return body.slice(0, body.indexOf("`;"));
}

/** Column names the script declares for one table, in declaration order. */
function scriptColumns(table: string): string[] {
  const schema = scriptSchema();
  const start = schema.indexOf(`CREATE TABLE ${table} (`);
  expect(start, `the script declares no ${table} table`).toBeGreaterThan(-1);
  const body = schema.slice(start + `CREATE TABLE ${table} (`.length);
  return body.slice(0, body.indexOf(");"))
    // Comments are stripped first: the block carries `--` lines, and a word inside one is not a column.
    .split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
    .split(",")
    .map((entry) => /^\s*(\w+)\s+(?:TEXT|INTEGER)\b/.exec(entry)?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * Column names `MEASURED_SHAPE` records for one table.
 *
 * Read out of the source text rather than imported, because that file is a vitest suite for the workerd pool
 * — importing it here would execute its `it()` blocks under the node config against no D1 binding.
 */
function measuredColumns(table: string): string[] {
  const start = drift.indexOf(`  ${table}: {`);
  expect(start, `MEASURED_SHAPE records no ${table}`).toBeGreaterThan(-1);
  const block = drift.slice(start, drift.indexOf("],", drift.indexOf("columns: [", start)));
  return [...block.matchAll(/"(\w+)"/g)].map((match) => match[1]!).filter((name) => name !== table);
}

describe("the byte-measurement corpus follows the schema it claims to measure", () => {
  for (const table of ["messages", "mailbox_items"]) {
    it(`declares the same ${table} columns the drift guard pins`, () => {
      /*
       * Order included, not just membership. SQLite stores a row as values in declaration order with a header
       * of serial types, so two schemas with the same columns in a different order are not the same table to
       * measure — and a reordering is exactly what an `ALTER TABLE ADD COLUMN` in the wrong migration would
       * produce.
       */
      expect(
        scriptColumns(table),
        `scripts/measure-message-bytes.mjs declares a different ${table} from the one the receipt is `
        + "measured against. A measurement that omits a column reports that the column costs nothing, which "
        + "is how the last three rounds all produced false good news.",
      ).toEqual(measuredColumns(table));
    });
  }

  it("finds real column lists, so a broken parser cannot pass by comparing nothing", () => {
    // The control, and it is not hypothetical: this file's first parser matched the `--` comment lines inside
    // the block and produced two empty lists, which compared equal.
    expect(scriptColumns("messages").length).toBeGreaterThan(20);
    expect(measuredColumns("messages").length).toBeGreaterThan(20);
    expect(scriptColumns("mailbox_items").length).toBeGreaterThan(5);
  });

  it("seeds every NOT NULL column, since a default is not a measurement", () => {
    /*
     * The other half of the same failure. A column can be present in the scratch schema and absent from the
     * `INSERT`, in which case every row takes its default — and for `body_index_attempt_version` that default
     * is `0`, which SQLite stores as a header-only serial type costing no payload bytes. Present in the table,
     * free in the measurement, and identical to the column not existing.
     *
     * So every `NOT NULL` column has to appear in the corpus. The nullable ones deliberately do not: a real
     * Node has `body_index_error` and `body_index_lease_until` null on all but a handful of rows, and
     * populating them here would price a table nobody runs.
     */
    const notNull = scriptSchema()
      .slice(scriptSchema().indexOf("CREATE TABLE messages ("))
      .split(");")[0]!
      .split(",")
      .map((entry) => /^\s*(\w+)\s+(?:TEXT|INTEGER)\s+NOT NULL/.exec(entry)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(notNull.length, "no NOT NULL columns found — has the parser rotted?").toBeGreaterThan(10);

    /*
     * Comments stripped first, and this is not defensive tidying — it is the bug this assertion had.
     *
     * The column list is built from several template fragments with a `//` comment block between them, and
     * that block *names the columns it is explaining*. So the first version of this check searched the
     * comment along with the code, deleting `body_index_attempt_version` from the `INSERT` still left the
     * name present in the prose above it, and the assertion passed. A lexical check satisfied by a comment
     * about the thing it is checking is the same defect this whole file exists to catch, one level down.
     */
    const inserted = script.slice(script.indexOf("INSERT INTO messages ("));
    const columnList = inserted.slice(0, inserted.indexOf(")`"))
      .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("")
      .replace(/`|\s|\+/g, "");
    const missing = notNull.filter((name) => !columnList.includes(name));
    expect(
      missing,
      "these NOT NULL columns exist in the scratch schema and are not in the corpus, so every row takes a "
      + "default and the measurement prices them at zero: " + missing.join(", "),
    ).toEqual([]);
  });

  it("declares the same indexes, because an index cost 17 of the last 17 bytes", () => {
    /*
     * The 0044 round measured the four new columns as free and `msg_body_index_due` as the whole of the
     * increase — an index carries an entry per row and cannot hide in page slack, which is where a column can.
     * So an omitted index is the single most expensive thing this script can leave out, and it left one out
     * on that round's second run.
     */
    const declared = [...scriptSchema().matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((m) => m[1]!).sort();
    const pinned = [...drift.matchAll(/indexes: \[([^\]]*)\]/g)]
      .flatMap((match) => [...match[1]!.matchAll(/"(\w+)"/g)].map((inner) => inner[1]!))
      .sort();
    expect(pinned.length, "no indexes found in MEASURED_SHAPE — has that constant's shape changed?")
      .toBeGreaterThan(4);
    expect(declared, "the script measures a different set of indexes from the ones the receipt covers")
      .toEqual(pinned);
  });
});
