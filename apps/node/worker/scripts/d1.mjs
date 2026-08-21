/**
 * Running SQL against a Node's catalog from an operator's terminal.
 *
 * ## Why this exists, and the defect that produced it
 *
 * `set-password.mjs` and `seed-claim-secret.mjs` both need to read and write D1 from outside the Worker, and
 * both were written to pass values with `wrangler d1 execute --param`. **There is no `--param` flag.**
 * Wrangler consumes it as an unknown option, loses `--command` with it, and answers:
 *
 *     You must provide either --command or --file for this command to run successfully.
 *
 * So the password reset — the only way to recover a locked-out self-hosted Node, added in a commit called
 * *"add the password reset that had no path"* — has never worked, from the day it was written. Found by
 * building `mailda claim-secret` on the same helper and watching it fail.
 *
 * ## Substitution, and why it is not a lecture about SQL injection
 *
 * Wrangler offers no parameter binding, so the values have to reach the statement as literals. That is not a
 * choice this file gets to make; what it gets to choose is whether the escaping is careful and tested, or
 * scattered through two scripts as template strings.
 *
 * `sqlLiteral` is deliberately **narrow**: strings, finite numbers and null, nothing else. A `Date`, an
 * object or a `NaN` throws rather than being coerced, because every coercion here is a way for a value to
 * arrive in the database looking like something it is not. Strings are wrapped in single quotes with any
 * internal quote doubled, which is SQLite's own escape and the whole of it.
 *
 * The callers are operator tools run by hand, and their inputs are a password verifier, an ISO date, an
 * email somebody typed and ids this repository generated. The email is the only one a person could make
 * hostile, and it is exactly the one this escaping is for.
 */

import { spawnSync } from "node:child_process";

/** One value as a SQLite literal. Throws rather than coerce: a coercion here is a silent wrong value. */
export function sqlLiteral(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`refusing to write ${value} to D1`);
    return String(value);
  }
  if (typeof value !== "string") {
    throw new TypeError(`refusing to write a ${typeof value} to D1 — pass a string, a number or null`);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Fills `?` placeholders with escaped literals.
 *
 * Counted rather than trusted: a statement with more placeholders than values would otherwise reach D1 with
 * a literal `?` in it, and one with fewer would silently drop a value. Both are the kind of mistake that
 * shows up as a row that is subtly wrong rather than as an error.
 *
 * The scan skips `?` inside string literals, because a placeholder count that included them would refuse
 * perfectly good SQL — and because getting that wrong in the other direction would substitute into somebody's
 * data.
 */
export function fill(sql, params = []) {
  let out = "";
  let index = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'") {
      // A doubled quote inside a string is an escaped quote, not the end of one.
      if (inString && sql[i + 1] === "'") { out += "''"; i += 1; continue; }
      inString = !inString;
      out += char;
      continue;
    }
    if (char === "?" && !inString) {
      if (index >= params.length) throw new Error(`not enough values for the placeholders in: ${sql}`);
      out += sqlLiteral(params[index]);
      index += 1;
      continue;
    }
    out += char;
  }
  if (index !== params.length) {
    throw new Error(`${params.length} value(s) given for ${index} placeholder(s) in: ${sql}`);
  }
  return out;
}

/**
 * Runs one statement and returns its rows.
 *
 * `--remote` unless `--local` was asked for, because an operator tool that silently touched the local
 * miniflare database while somebody believed they were fixing production would be the worst possible
 * failure of a recovery tool.
 */
export function d1(workerDir, sql, params = [], { local = false } = {}) {
  const args = ["wrangler", "d1", "execute", "CATALOG", local ? "--local" : "--remote", "--json",
    "--command", fill(sql, params)];
  const run = spawnSync("npx", args, { cwd: workerDir, encoding: "utf8", env: process.env });
  const text = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const start = text.indexOf("[");
  if (start === -1) {
    throw new Error(`wrangler did not return a result:\n${text.slice(-800)}`);
  }
  return JSON.parse(text.slice(start))[0].results;
}
