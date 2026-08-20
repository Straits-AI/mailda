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
 * ## Trigger bodies, added when the first trigger arrived
 *
 * This used to say it could not handle `BEGIN … END`, and `test/node/migrations.test.ts` used to fail if a
 * migration grew a trigger — with the standing instruction that the moment one was genuinely needed, the
 * splitter should become a real parser rather than gain another rule about how to write SQL.
 *
 * #49 needed one. Migration 0027 makes a published Butler version's content **unwritable in the database**
 * rather than merely unwritten, which is a `BEFORE UPDATE … WHEN … BEGIN SELECT RAISE(ABORT, …); END`
 * trigger, and a trigger body's inner `;` is mandatory in SQLite's grammar — so "write it as one statement
 * with no inner semicolon" was not available.
 *
 * The rule is a **depth counter over block keywords**, not a special case for triggers:
 *
 *   - `BEGIN` and `CASE` open a block; `END` closes one. A `;` at depth > 0 is inside a statement.
 *   - `CASE` is counted because SQLite terminates a `CASE` expression with `END` as well. A counter that
 *     only knew `BEGIN` would see the `END` of a `CASE` inside a trigger body, drop to depth 0, and split
 *     the body in half at the next semicolon — a plausible future migration breaking the splitter in the
 *     exact way the old guard existed to prevent.
 *   - Keywords are recognised **only outside** strings, quoted identifiers and comments, because those are
 *     already consumed by the branches above. `'END'` in a string is not a keyword.
 *   - `END` at depth 0 does nothing rather than going negative, so a stray one cannot make the rest of the
 *     file un-splittable.
 *
 * `BEGIN TRANSACTION` would be counted as a block opener and is not a case that arises: these migrations
 * are applied through `batch()`, which *is* the transaction, so no migration may open one itself —
 * asserted in `test/node/migrations.test.ts` rather than assumed here.
 */
/** A word boundary in SQL: anything that is not part of an identifier. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

export function statementsOf(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  /** How many `BEGIN`/`CASE` blocks are open. A `;` inside one is not a statement boundary. */
  let depth = 0;

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
      if (depth > 0) {
        // Inside a `BEGIN … END` or `CASE … END` block: a genuine part of one statement.
        current += char;
        index += 1;
        continue;
      }
      statements.push(current);
      current = "";
      index += 1;
      continue;
    }

    // A keyword, only where a keyword can be: outside every quoted and commented run above. Matched on a
    // word boundary so `ENDPOINT` and `BEGINNING` are identifiers rather than block markers.
    if (isWordChar(char) && !isWordChar(sql[index - 1])) {
      let end = index;
      while (isWordChar(sql[end])) end += 1;
      const word = sql.slice(index, end).toUpperCase();
      if (word === "BEGIN" || word === "CASE") depth += 1;
      // Never negative: a stray END must not make the rest of the file un-splittable.
      else if (word === "END" && depth > 0) depth -= 1;
      current += sql.slice(index, end);
      index = end;
      continue;
    }

    current += char;
    index += 1;
  }

  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}
