/**
 * Splits a migration file into statements.
 *
 * Its own module, with no `.sql` imports, for a practical reason: `src/migrate.ts` bundles the schema as
 * text through wrangler's Text rule, which only exists inside a wrangler build — so anything importing
 * it cannot be loaded by plain Node, and the checks that guard this run in Node because they read
 * `migrations/`. A pure function should not drag a schema behind it.
 *
 * ## Why this is a small tokenizer and not `sql.split(";")`
 *
 * It started as a split on `;`, with a test asserting the migrations contained nothing that would break
 * it. The test found three things: trailing comments like `-- The transport's messageId, only when
 * handed_over`. Not a bug yet — none of them contained a semicolon — but the guard was one comment away
 * from being load-bearing, and the answer to "a comment could break the parser" is a parser that knows
 * what a comment is, not a rule about how to write comments.
 *
 * So it tracks the four states SQLite's lexical grammar needs for this job: a single-quoted string
 * (where `''` is an escaped quote rather than a terminator), a double-quoted identifier, a `--` line
 * comment, and a block comment. A `;` inside any of them is not a boundary.
 *
 * **The one thing it still cannot do** is a `BEGIN … END` body, where the inner semicolons genuinely are
 * inside a single statement. `test/node/migrations.test.ts` fails if a migration grows a trigger,
 * because that is the point at which this should become a real parser rather than gain another case.
 */
export function statementsOf(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];

    if (char === "-" && next === "-") {
      // Line comment, dropped. It cannot change the statement's meaning, and dropping it is what stops
      // a semicolon inside prose from ever reaching the boundary check below.
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }

    if (char === "'" || char === '"') {
      // A quoted run is copied verbatim, terminator included. `''` inside a single-quoted string is an
      // escaped quote in SQL, not the end of one — the classic way a hand-rolled splitter corrupts data.
      const quote = char;
      current += char;
      index += 1;
      while (index < sql.length) {
        const inner = sql[index]!;
        current += inner;
        index += 1;
        if (inner !== quote) continue;
        if (sql[index] === quote) { current += quote; index += 1; continue; }
        break;
      }
      continue;
    }

    if (char === ";") {
      statements.push(current);
      current = "";
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}
