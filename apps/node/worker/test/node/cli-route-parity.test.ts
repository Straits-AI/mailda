import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ROUTES } from "@mailda/contract/routes";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
 * The CLI names no route the contract does not have (ADR 12, "contracts before channels").
 *
 * Every verb builds its path with `api()` from `support.mjs`, which throws on an unregistered template. That
 * catches a moved route when the verb runs. This catches it at test time, and it also catches the shape the
 * helper cannot see: a `/api/...` literal written into a template string or an error message by hand, which
 * is the drift #85's registry exists to make detectable. It is a parse (AGENTS.md §2c, rung 3), not a phrase:
 * the TypeScript parser walks the string and template literals, so a path in a comment is not a finding and a
 * literal split across lines is.
 */

const CLI_SRC = resolve(new URL("../../../../../packages/cli/src", import.meta.url).pathname);
const REGISTERED = new Set<string>((ROUTES as ReadonlyArray<{ path: string }>).map((one) => one.path));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".mjs") ? [full] : [];
  });
}

function apiPathsIn(file: string): Array<{ path: string; line: number }> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const found: Array<{ path: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      ? node.text
      : null;
    if (text !== null) {
      for (const match of text.matchAll(/\/api\/[a-z0-9/_.-]+/g)) {
        found.push({ path: match[0], line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("the CLI names only routes the contract registers", () => {
  const sites = sourceFiles(CLI_SRC).flatMap((file) => apiPathsIn(file).map((one) => ({ ...one, file })));

  it("finds the sites, so the assertion below rests on something", () => {
    // Anti-vacuity: a parser that stopped matching would pass over an empty set and guard nothing.
    expect(sites.length).toBeGreaterThan(20);
  });

  it("every one of them is a registered path", () => {
    const strays = sites
      .filter((one) => !REGISTERED.has(one.path))
      .map((one) => `${one.file.replace(CLI_SRC, "packages/cli/src")}:${one.line} ${one.path}`);
    expect(strays, "a path the Node does not serve: register it, or use the route it moved to").toEqual([]);
  });
});
