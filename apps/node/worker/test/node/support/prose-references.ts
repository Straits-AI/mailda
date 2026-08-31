import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, normalize, relative } from "node:path";

/**
 * Extracts every repository path a **comment or a paragraph** names, so a reference to a file that is not
 * there can be failed rather than read and believed.
 *
 * ## Why only prose
 *
 * Code that names a path is checked by the toolchain: a bad `import` fails to build, a bad `readFileSync`
 * fails at runtime. Prose is the only place a path can be wrong and stay wrong, because nothing resolves it.
 * That asymmetry is the whole reason this module exists, and it is also why the scan is restricted: sweeping
 * code as well raised 3,851 candidate tokens with 86 unresolvable, of which **zero** were defects —
 * `${gate.sql}` template holes, `ajv/dist/2020.js` package specifiers, `query.sql` property reads. A check
 * whose failures are all false is a check that gets muted.
 */

const SKIP = new Set(["node_modules", ".git", "dist", ".turbo", ".wrangler", "coverage", "generated"]);

/** Extensions worth resolving. A path-shaped token ending in anything else is prose about a file type. */
const EXT = "(?:ts|tsx|mjs|js|sql|md|json|yml|yaml|toml)";

/**
 * A path-shaped token. Requires an extension, forbids a leading word character so `foo.src/index.ts` does
 * not match from the middle, and forbids a trailing one so a sentence-final period is not eaten.
 *
 * The `(?:\.{1,2}/)*` repeats. Allowing only one leading segment silently skipped every
 * `../../../../../docs/…` in the repository — the lookbehind then blocks a match from the middle too, so
 * those references were not merely mis-resolved, they were never extracted. A scanner with a hole in it
 * reports a clean result, which is the failure mode this whole check is aimed at.
 */
const TOKEN = new RegExp(String.raw`(?<![\w/.-])((?:\.{1,2}/)*[\w][\w./-]*\.${EXT})(?![\w/])`, "g");

export type Reference = { readonly file: string; readonly line: number; readonly path: string };

function walk(root: string, at: string, into: string[]): void {
  for (const name of readdirSync(at)) {
    if (SKIP.has(name)) continue;
    const full = join(at, name);
    if (statSync(full).isDirectory()) walk(root, full, into);
    else into.push(relative(root, full));
  }
}

export function filesUnder(root: string): string[] {
  const found: string[] = [];
  walk(root, root, found);
  return found;
}

/**
 * The lines of `text` that are prose, as `[lineNumber, proseText]`.
 *
 * For markdown that is every line outside a fenced block — fences hold illustrative trees and example
 * receipt names that deliberately do not exist. For source it is comment text only: `//`, `/* … *\/` and
 * SQL `--`. A triple-slash `/// <reference path=…>` is a compiler directive rather than prose, and the
 * compiler already resolves it, so it is skipped.
 */
export function proseLines(path: string, text: string): Array<readonly [number, string]> {
  const lines = text.split("\n");
  const out: Array<readonly [number, string]> = [];
  const markdown = path.endsWith(".md");
  let fenced = false;
  let block = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (markdown) {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (!fenced && !/^\s{4,}\S/.test(line)) out.push([i + 1, line]);
      continue;
    }
    if (/^\s*\/\/\//.test(line)) continue;
    let prose = "";
    if (block) {
      const end = line.indexOf("*/");
      prose = end === -1 ? line : line.slice(0, end);
      if (end !== -1) block = false;
    } else {
      const open = line.indexOf("/*");
      const slash = line.indexOf("//");
      const dash = path.endsWith(".sql") ? line.indexOf("--") : -1;
      if (open !== -1) {
        const end = line.indexOf("*/", open);
        prose = end === -1 ? line.slice(open) : line.slice(open, end);
        if (end === -1) block = true;
      } else if (slash !== -1) prose = line.slice(slash);
      else if (dash !== -1) prose = line.slice(dash);
    }
    if (prose.trim() !== "") out.push([i + 1, prose]);
  }
  return out;
}

/**
 * The paths one line of prose names.
 *
 * Separate from the repository walk so extraction can be asserted directly. A hole in here does not fail
 * any repository-wide count loudly enough to notice — dropping every multi-segment relative path cost 14
 * references out of 2,931, which no floor would catch.
 */
export function pathsIn(prose: string): string[] {
  const found: string[] = [];
  for (const match of prose.matchAll(TOKEN)) {
    const path = match[1] as string;
    /*
     * `request.json()` and `response.text()` are method calls that happen to look like filenames. A token
     * followed by `(` is never a path reference, and excluding it removes the only false-positive class that
     * survived restricting the scan to prose.
     */
    if (prose.slice((match.index ?? 0) + path.length).startsWith("(")) continue;
    found.push(path);
  }
  return found;
}

/** Every path a comment or paragraph names, across the repository. */
export function referencesUnder(root: string): { refs: Reference[]; disk: Set<string> } {
  const all = filesUnder(root);
  const disk = new Set(all);
  const refs: Reference[] = [];
  for (const file of all) {
    if (!/\.(ts|tsx|mjs|sql|md)$/.test(file)) continue;
    if (file.includes("worker-configuration")) continue;
    for (const [line, prose] of proseLines(file, readFileSync(join(root, file), "utf8"))) {
      for (const path of pathsIn(prose)) refs.push({ file, line, path });
    }
  }
  return { refs, disk };
}

/**
 * Whether `ref` names something on disk.
 *
 * Three forms resolve, in the order a reader would try them: relative to the referencing file, from the
 * repository root, and — for a bare `outbound.test.ts` with no directory — by unique basename. The last is
 * how the repository actually cites sibling tests, so refusing it would fail hundreds of good references.
 */
export function resolves(ref: Reference, disk: Set<string>): boolean {
  if (disk.has(ref.path)) return true;
  const beside = normalize(join(dirname(ref.file), ref.path));
  if (disk.has(beside)) return true;
  /*
   * `./butler/run.ts` must suffix-match `apps/node/worker/src/butler/run.ts`. Building the suffix as
   * `"/" + path` without stripping the `./` first makes it `"/./butler/run.ts"`, which matches nothing — a
   * resolver bug that reports a live file as missing, and the exact reason this function is measured against
   * the whole repository rather than a handful of cases.
   */
  const bare = ref.path.replace(/^\.\//, "");
  const suffix = `/${bare}`;
  for (const on of disk) if (on.endsWith(suffix)) return true;
  return false;
}
