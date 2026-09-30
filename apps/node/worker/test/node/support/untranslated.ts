import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

/**
 * The untranslated-text scan (ADR 46, critic H1): every string the interface could show that did not come from
 * the catalog, found with the TypeScript **checker**, not a phrase match (AGENTS.md §2c, rung 3).
 *
 * ## Default-deny
 *
 * A string or template literal containing a letter is a finding unless it is provably not words for a person:
 *
 * - **its contextual type is a token type**: a union with a string-literal member, or a template-literal type.
 *   `kind="loading"`, `type="button"`, `t("brand.name")`: the type already says it is one of a closed set.
 * - **its position is structural** (the lists are `ALWAYS_STRUCTURAL`, `STRUCTURAL_ATTRIBUTES` and `structural()`
 *   below, each with its reason): a property name, an import, a comparison operand, a `className`, an `href` or
 *   SVG path on an element. A platform attribute's name decides only on an intrinsic element; a component's
 *   `name` or `id` is whatever the component shows, so its type decides.
 * - **it is inside `<code>`, `<kbd>` or `<samp>`**: an identifier, a key cap, a sample of output.
 *
 * `<NodeWords>` is not on that list. The Node's words only ever reach it as an expression (`error.message`),
 * which has no literal to flag; a literal written inside it is the interface's own prose, however it is marked.
 *
 * Anything else is flagged, whatever its type: a plain `string` prop, an object value, a `??` fallback, a
 * `return`, a `textContent =`, a `setAttribute` argument, a constant with no type at all. So a new way to show
 * a string is caught the day it is written, rather than the day someone thinks to add a pattern for it. JSX
 * text with a letter is always a finding outside those three elements.
 *
 * A literal that is flagged and is not words (an API path, a storage key) is registered by file and text, with
 * its reason, in `NOT_PROSE` (`test/node/untranslated.registry.ts`). Formatting is its own finding: a call to
 * `Intl` or a `toLocale*String` outside `src/client/app/format.ts` picks its own locale.
 *
 * ## Why the checker
 *
 * A parser can see `aria-label="…"` but not that `detail="…"` goes to a `string` prop and `kind="…"` to a
 * union; the first version of this scan was parser-only and missed about a third of the interface's prose
 * (critic H1, measured). The price is time: the checker must type the whole client program, several seconds
 * (`docs/receipts/untranslated-scan-timeout.md`).
 */

export const WORKER = resolve(new URL("../../..", import.meta.url).pathname);
const APP = join(WORKER, "src/client/app");
const CLIENT = join(WORKER, "src/client");

/** The one file allowed to call `Intl` and `toLocale*String` (`src/client/app/format.ts`). */
const FORMAT_FILE = join(APP, "format.ts");

/** JSX elements whose content is not the interface's prose. */
const OPAQUE_ELEMENTS: ReadonlyMap<string, string> = new Map([
  ["code", "an identifier, in mono by ADR 30's rule, never translated"],
  ["kbd", "a key cap"],
  ["samp", "a sample of a program's output"],
]);

/**
 * JSX attributes whose value is never shown as words on any element, component or not, each with the reason.
 * `data-*` is structural too.
 */
const ALWAYS_STRUCTURAL: ReadonlyMap<string, string> = new Map([
  ["className", "a style hook, passed through by components as by elements"],
  ["key", "React's identity for a list item"],
]);

/**
 * JSX attributes whose value is never shown as words **on an intrinsic element** (`<a href>`, `<input name>`),
 * each with the reason. The platform defines these, so the name decides. A component's prop of the same name
 * means whatever the component does with it (`<Row name>` is a sidebar label), so on a component it goes
 * through the contextual-type rule like any other prop.
 */
export const STRUCTURAL_ATTRIBUTES: ReadonlyMap<string, string> = new Map([
  ["id", "a document id"],
  ["htmlFor", "an id reference"],
  ["aria-labelledby", "an id reference"],
  ["aria-describedby", "an id reference"],
  ["aria-controls", "an id reference"],
  ["aria-owns", "an id reference"],
  ["aria-activedescendant", "an id reference"],
  ["name", "a form field's name, sent, never shown"],
  ["href", "a URL"],
  ["src", "a URL"],
  ["rel", "a link relation token"],
  ["lang", "a language tag"],
  ["d", "SVG path data"],
  ["viewBox", "SVG geometry"],
  ["points", "SVG geometry"],
  ["transform", "SVG geometry"],
  ["fill", "an SVG paint"],
  ["stroke", "an SVG paint"],
  ["xmlns", "a namespace URI"],
]);

export type FindingKind = "text" | "literal" | "formatter";

export interface Finding {
  /** Repository-relative to the worker package, forward slashes: `src/client/app/chrome.tsx`. */
  readonly file: string;
  readonly line: number;
  readonly kind: FindingKind;
  /** The literal's text (a template's literal parts joined), trimmed; for a formatter, the call. */
  readonly text: string;
}

export interface Scan {
  readonly findings: readonly Finding[];
  /** Files visited, JSX elements seen and literals examined, for the anti-vacuity floors. */
  readonly files: number;
  readonly elements: number;
  readonly literals: number;
}

const LETTER = /\p{L}/u;

/** Every `.ts`/`.tsx` under `src/client/app` (declarations aside) and every `src/client/*.client.js`. */
export function scannedFiles(): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
  const scripts = readdirSync(CLIENT).filter((name) => name.endsWith(".client.js")).map((name) => join(CLIENT, name));
  return [...walk(APP), ...scripts].sort();
}

/**
 * The client program as `src/client/tsconfig.json` defines it, plus JavaScript, plus `virtual` files (planted
 * fixtures, by absolute path) that exist only in memory.
 */
export function clientProgram(files: readonly string[], virtual: ReadonlyMap<string, string> = new Map()): ts.Program {
  const config = ts.getParsedCommandLineOfConfigFile(join(CLIENT, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (config === undefined) throw new Error("src/client/tsconfig.json did not parse");
  const options: ts.CompilerOptions = { ...config.options, allowJs: true, checkJs: false, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (name) => virtual.has(name) || fileExists.call(host, name);
  host.readFile = (name) => virtual.get(name) ?? readFile.call(host, name);
  host.getSourceFile = (name, language, onError, create) => {
    const text = virtual.get(name);
    return text === undefined
      ? getSourceFile.call(host, name, language, onError, create)
      : ts.createSourceFile(name, text, language, true);
  };
  return ts.createProgram({ rootNames: [...files, ...virtual.keys()], options, host });
}

/** A union with a string-literal member, or a template-literal type: one of a closed set, not words. */
function isTokenType(checker: ts.TypeChecker, type: ts.Type | undefined): boolean {
  if (type === undefined) return false;
  const resolved = type.flags & ts.TypeFlags.TypeParameter ? checker.getBaseConstraintOfType(type) ?? type : type;
  const members = resolved.isUnion() ? resolved.types : [resolved];
  return members.some((member) =>
    member.isStringLiteral() || (member.flags & ts.TypeFlags.TemplateLiteral) !== 0
    || (member.isIntersection() && member.types.some((part) => part.isStringLiteral())));
}

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The catalog's own functions: their first argument is a key, which the type already closes. */
const CATALOG_CALLS = new Set(["t", "rich", "sentence"]);

/**
 * Whether a literal's position says it is not words, whatever its type. Each clause is a position, not a
 * phrase, and each says why.
 */
function structural(node: ts.Node): boolean {
  const parent = node.parent;
  // The name of a property, method or enum member: an identifier spelled with quotes.
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)
    || ts.isMethodDeclaration(parent) || ts.isEnumMember(parent)) && parent.name === node) return true;
  // `object["key"]`: a property access spelled with quotes.
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  // A module specifier, static or dynamic.
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true;
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  // A comparison operand or a `case` label: a state compared, not a sentence shown.
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return true;
  if (ts.isCaseClause(parent) && parent.expression === node) return true;
  // The left of `in`: a property name.
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.left === node) return true;
  // A catalog key.
  if (ts.isCallExpression(parent) && parent.arguments[0] === node && ts.isIdentifier(parent.expression)
    && CATALOG_CALLS.has(parent.expression.text)) return true;
  // A structural JSX attribute.
  if (ts.isJsxAttribute(parent) || (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent))) {
    if (structuralAttribute(ts.isJsxAttribute(parent) ? parent : (parent.parent as ts.JsxAttribute))) return true;
  }
  return false;
}

/** Whether `attribute` is never words: always-structural anywhere, or platform-structural on an intrinsic element. */
function structuralAttribute(attribute: ts.JsxAttribute): boolean {
  const name = attribute.name.getText();
  if (ALWAYS_STRUCTURAL.has(name) || name.startsWith("data-")) return true;
  // `<a>` and `<svg>` are the platform's; `<Row>` and `<ui.Card>` are ours. JSX draws the line by the first letter.
  const tag = attribute.parent.parent.tagName.getText();
  return /^[a-z]/.test(tag) && !tag.includes(".") && STRUCTURAL_ATTRIBUTES.has(name);
}

/** The literal's text: a template's literal parts joined, since the holes are not the words. */
function literalText(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression): string {
  return ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((span) => span.literal.text).join("") : node.text;
}

/** Whether `node` is the class name of a structural attribute's template value (`className={`a ${b}`}`), through `?:`. */
function withinStructuralAttribute(node: ts.Node): boolean {
  for (let at: ts.Node = node; !ts.isSourceFile(at); at = at.parent) {
    if (ts.isJsxAttribute(at)) return structuralAttribute(at);
    if (ts.isJsxElement(at) || ts.isJsxSelfClosingElement(at) || ts.isBlock(at)) return false;
  }
  return false;
}

function tagName(element: ts.JsxElement | ts.JsxSelfClosingElement): string {
  return (ts.isJsxElement(element) ? element.openingElement.tagName : element.tagName).getText();
}

/** Scans `files` in `program`. `file` in each finding is relative to the worker package. */
export function scan(program: ts.Program, files: readonly string[]): Scan {
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];
  let elements = 0;
  let literals = 0;
  for (const path of files) {
    const source = program.getSourceFile(path);
    if (source === undefined) throw new Error(`${path} is not in the client program`);
    const file = relative(WORKER, path).split("\\").join("/");
    const at = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const visit = (node: ts.Node): void => {
      // Types are not values: `type Kind = "loading"` shows nothing.
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        elements += 1;
        if (ts.isJsxElement(node) && OPAQUE_ELEMENTS.has(tagName(node))) return;
      }
      if (ts.isJsxText(node)) {
        literals += 1;
        if (LETTER.test(node.text)) findings.push({ file, line: at(node), kind: "text", text: node.text.trim() });
        return;
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        literals += 1;
        const text = literalText(node);
        if (LETTER.test(text) && !structural(node) && !withinStructuralAttribute(node)
          && !isTokenType(checker, checker.getContextualType(node))) {
          findings.push({ file, line: at(node), kind: "literal", text: text.trim() });
        }
        if (ts.isTemplateExpression(node)) for (const span of node.templateSpans) visit(span.expression);
        return;
      }
      if (path !== FORMAT_FILE && formatterCall(node)) {
        findings.push({ file, line: at(node), kind: "formatter", text: node.getText(source).slice(0, 60) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { findings, files: files.length, elements, literals };
}

/** `Intl.*` (a construction or a static call) or `x.toLocale…String(…)`. */
function formatterCall(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Intl") return true;
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && /^toLocale(?:Date|Time)?String$/.test(node.expression.name.text);
}

/** A planted fixture's absolute path: inside the app, so its imports resolve as an app file's would. */
export function fixturePath(name: string): string {
  return join(APP, "__planted__", name);
}

