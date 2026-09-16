import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import ts from "typescript";

/**
 * Every route handler, read from the handler table rather than from the router's prose.
 *
 * `src/routes/*.ts` each export one object literal whose keys are `"METHOD /path"` strings from the registry
 * and whose values are the handlers. That shape is what makes a closed-world test cheap to write honestly:
 * a handler is a property with a string-literal key, found by the TypeScript parser, so a scanner cannot
 * miss one that was written on two lines or match one that is only mentioned in a comment — the two ways
 * the regular expressions this replaced could be wrong.
 *
 * `text` is the handler's own source — the arrow function, or the named function it refers to when several
 * keys share one — so a test asking "does this route's handler consult a mailbox gate" reads exactly the
 * code that answers the route and nothing beside it.
 */
export interface HandlerSite {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  /** Absolute path of the file the handler is in. */
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export const ROUTES_DIR = resolve(new URL("../../../src/routes", import.meta.url).pathname);

export function handlerFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((entry) => entry.endsWith(".ts") && entry !== "index.ts" && entry !== "support.ts")
    .map((entry) => join(ROUTES_DIR, entry));
}

export function handlerSites(): HandlerSite[] {
  const sites: HandlerSite[] = [];
  for (const file of handlerFiles()) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
    const named = new Map<string, ts.Node>();
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          named.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
        const match = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(node.name.text);
        if (match !== null) {
          const value = ts.isIdentifier(node.initializer)
            ? named.get(node.initializer.text) ?? node.initializer
            : node.initializer;
          sites.push({
            key: node.name.text,
            method: match[1]!,
            path: match[2]!,
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            text: value.getText(source),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}
