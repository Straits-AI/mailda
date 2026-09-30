import { readFileSync } from "node:fs";
import { relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { isComposingKey } from "../../src/client/app/ui/ime.ts";
import { scannedFiles, WORKER } from "./support/untranslated.ts";

/**
 * An input method's Enter is not a submit (ADR 46, `src/client/app/ui/ime.ts`). Every Enter handler in the
 * interface asks this first; the Safari case is the one a bare `isComposing` misses.
 */
describe("a key press belonging to an input method", () => {
  it("is the composing one, in the browsers that say so", () => {
    expect(isComposingKey({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it("is the one Safari sends after compositionend, marked only by keyCode 229", () => {
    expect(isComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("is not a plain Enter", () => {
    expect(isComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

/**
 * Every handler that compares a key with `"Enter"` asks `isComposingKey` in the same function (AGENTS.md §2c, rung
 * 3: the source is the only witness, read with the parser). A new Enter handler without the guard fails here the day
 * it is written, rather than the day a Pinyin reader submits half a word. The behaviour itself is rendered in
 * `test/client/palette.test.tsx` and `test/client/queue-hand-to.test.tsx`.
 */
describe("the interface's Enter handlers", () => {
  /** Each `<x>.key === "Enter"` (or `!==`) in the client, and whether its enclosing function calls isComposingKey. */
  function enterSites(): Array<{ at: string; guarded: boolean }> {
    const sites: Array<{ at: string; guarded: boolean }> = [];
    for (const path of scannedFiles()) {
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node)
          && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)
          && [node.left, node.right].some((side) => ts.isStringLiteral(side) && side.text === "Enter")
          && [node.left, node.right].some((side) => ts.isPropertyAccessExpression(side) && side.name.text === "key")) {
          let fn: ts.Node = node;
          while (!ts.isSourceFile(fn) && !ts.isFunctionLike(fn)) fn = fn.parent;
          let guarded = false;
          const find = (inner: ts.Node): void => {
            if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "isComposingKey") guarded = true;
            else ts.forEachChild(inner, find);
          };
          find(fn);
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          sites.push({ at: `${relative(WORKER, path)}:${line}`, guarded });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return sites;
  }

  it("each asks isComposingKey first", () => {
    const sites = enterSites();
    // The palette, the hand-to field, the response-target field and the reader's label field: a parser that stopped
    // finding them would pass over nothing.
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(sites.filter((site) => !site.guarded).map((site) => site.at)).toEqual([]);
  });
});
