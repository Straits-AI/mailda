import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { SHELL_CSS } from "../../src/shell-css.ts";
import { cssRules } from "./support/theme-blocks.ts";

/**
 * Every class the client emits has a rule in the served sheet.
 *
 * The redesign rewrote the stylesheet whole, and the way a rewrite breaks a screen nobody opened is a class
 * the screen still emits and the sheet no longer styles: the screen renders, in browser defaults, with no
 * error anywhere. This reads the classes the way the compiler does (AGENTS.md §2c, rung 3: the TypeScript
 * parser, as `support/handlers.ts` uses it), so a class written across lines, in a conditional or in a
 * template is found, and one quoted in a comment is not.
 *
 * What it reads: every string literal that reaches a JSX `className` (or a `className` property, as in a
 * link's `activeProps`) in `src/client/**` `.tsx`, and every `class:` in `src/client/app.client.js`. A
 * template's static parts count; a fragment glued to a substitution (`state-` in `state-${state}`) is a prefix,
 * not a class, and is skipped, so the dynamic families are not checked here. What it cannot see: a class
 * held in a variable before it reaches the attribute.
 */

const worker = join(import.meta.dirname, "../..");
const client = join(worker, "src/client");

/**
 * Classes emitted on purpose with no rule of their own: a name for an element whose look comes from another
 * class it wears, or from its element. Each says why; the last test fails when one stops being emitted or
 * gains a rule, so the list cannot outlive its reasons.
 */
const NO_RULE_BY_DESIGN: Readonly<Record<string, string>> = {
  "rail-mailbox": "a sidebar row, styled by the .rail-row it also wears; the name says what the row links to",
  "filter-button": "an icon button, styled by the .btn and .btn-icon it also wears; the name says which one",
  "search-failed": "a ledger table like the others, styled as a table; the name says which one",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

const words = (text: string): string[] => text.split(/\s+/).filter((word) => word !== "");

/**
 * The class names in one expression. `left` and `right` say whether the expression is glued to template
 * text on that side (`message-row${…}`), in which case a literal that does not start or end with a space
 * is only part of a name there, and that part is dropped.
 */
function classesIn(node: ts.Node, left = false, right = false): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const found = words(node.text);
    if (left && !/^\s/.test(node.text)) found.shift();
    if (right && !/\s$/.test(node.text)) found.pop();
    return found;
  }
  if (ts.isTemplateExpression(node)) {
    const spans = node.templateSpans;
    const parts = [node.head.text, ...spans.map((span) => span.literal.text)];
    return parts.flatMap((text, index) => {
      const found = words(text);
      // Text straight after a substitution is the end of a name the substitution began.
      if ((index > 0 || left) && !/^\s/.test(text)) found.shift();
      // A name ending in a hyphen before a substitution is a prefix it completes: state-, verdict-, case-.
      if (index < spans.length ? /[-_]$/.test(text) : right && !/\s$/.test(text)) found.pop();
      if (index === spans.length) return found;
      const next = parts[index + 1]!;
      return [...found, ...classesIn(spans[index]!.expression, text !== "" && !/\s$/.test(text), next !== "" && !/^\s/.test(next))];
    });
  }
  if (ts.isParenthesizedExpression(node)) return classesIn(node.expression, left, right);
  // `popover ${className}`.trim(): the classes are the receiver's.
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "trim") {
    return classesIn(node.expression.expression, left, right);
  }
  if (ts.isConditionalExpression(node)) return [...classesIn(node.whenTrue, left, right), ...classesIn(node.whenFalse, left, right)];
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return classesIn(node.right, left, right);
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
      return [...classesIn(node.left, left, right), ...classesIn(node.right, left, right)];
    }
  }
  return [];
}

/** Every class the client emits, with where, for the failure message. */
function emitted(): Map<string, string> {
  const found = new Map<string, string>();
  const read = (path: string, attribute: string): void => {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext, true);
    const record = (node: ts.Node): void => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      for (const name of classesIn(node)) if (!found.has(name)) found.set(name, `${relative(worker, path)}:${line}`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === attribute && node.initializer !== undefined) {
        record(ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined
          ? node.initializer.expression
          : node.initializer);
      } else if (ts.isPropertyAssignment(node) && node.name.getText(source).replace(/["']/g, "") === attribute) {
        record(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  for (const path of files(client)) read(path, "className");
  read(join(client, "app.client.js"), "class");
  return found;
}

/** Every class a selector in the served sheet names. */
function styled(): Set<string> {
  const names = new Set<string>();
  for (const rule of cssRules(SHELL_CSS)) {
    for (const selector of rule.selectors) {
      for (const match of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(match[1]!);
    }
  }
  return names;
}

describe("every class the client emits has a rule", () => {
  const classes = emitted();
  const rules = styled();

  it("reads the client's classes, so nothing below passes by reading none", () => {
    expect(classes.size).toBeGreaterThan(100);
  });

  it("finds a rule for each", () => {
    const missing = [...classes]
      .filter(([name]) => !rules.has(name) && !(name in NO_RULE_BY_DESIGN))
      .map(([name, where]) => `.${name} (${where})`);
    expect(missing, "a class the client emits with no rule in src/shell-css.ts: style it, or list it in NO_RULE_BY_DESIGN with the reason").toEqual([]);
  });

  it("keeps no exemption for a class that is gone or styled", () => {
    const stale = Object.keys(NO_RULE_BY_DESIGN).filter((name) => !classes.has(name) || rules.has(name));
    expect(stale).toEqual([]);
  });
});
