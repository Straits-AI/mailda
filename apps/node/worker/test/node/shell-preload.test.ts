import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Where the framework-free script may reach for the React shell (ADR 30, critic M6), read with the TypeScript
 * parser from `src/client/app.client.js` (AGENTS.md §2c, rung 3).
 *
 * `test/shell-split.test.ts` holds the page and the served script's static imports, and names a modulepreload
 * as "the obvious way to lose" the split. The shell is now preloaded, beside its words, when it is handed the
 * page: a preload anywhere else would fetch the bundle before sign-in with every test there still passing, and
 * silently falsify `shell.pre_auth_bundle_bytes: 0`. So each reach for the shell, and the load of its words,
 * must sit inside `handOverToShell`, and the words inside its `try`, so a table that cannot be fetched shows the
 * "could not be loaded" notice rather than an empty page. Here rather than in the workerd suite, because the
 * parser is a Node dependency.
 */

const path = new URL("../../src/client/app.client.js", import.meta.url).pathname;
const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

/** Every node for which `match` holds, with the function declaration and try block it sits in. */
function sites(match: (node: ts.Node) => boolean): Array<{ fn: string | null; inTry: boolean }> {
  const found: Array<{ fn: string | null; inTry: boolean }> = [];
  const visit = (node: ts.Node): void => {
    if (match(node)) {
      let fn: string | null = null;
      let inTry = false;
      for (let at: ts.Node = node; !ts.isSourceFile(at); at = at.parent) {
        if (ts.isTryStatement(at.parent) && at.parent.tryBlock === at) inTry = true;
        if (ts.isFunctionDeclaration(at) && fn === null) fn = at.name?.text ?? null;
      }
      found.push({ fn, inTry });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const preloads = sites((node) => ts.isStringLiteral(node) && node.text === "modulepreload");
const shellImports = sites((node) => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
  && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "/app/shell.js");
const wordLoads = sites((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "loadApp");

describe("the framework-free script reaches the shell only when handing it the page", () => {
  it("finds the preload, the import and the words' load, so nothing below passes by finding none", () => {
    expect([preloads.length, shellImports.length, wordLoads.length]).toEqual([1, 1, 1]);
  });

  it("preloads and imports the shell nowhere but handOverToShell", () => {
    expect([...preloads, ...shellImports].map((site) => site.fn)).toEqual(["handOverToShell", "handOverToShell"]);
  });

  it("loads the shell's words inside handOverToShell's try, so a failed load shows the notice", () => {
    expect(wordLoads).toEqual([{ fn: "handOverToShell", inTry: true }]);
  });
});
