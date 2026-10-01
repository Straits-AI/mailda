import { beforeAll, describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

import { NOT_PROSE, UNMIGRATED } from "./untranslated.registry.ts";
import { clientProgram, fixturePath, scan, scannedFiles, type Finding, type FindingKind, type Scan } from "./support/untranslated.ts";

/**
 * No interface text outside the catalog (ADR 46, critic H1): the checker-based, default-deny scan in
 * `support/untranslated.ts`, its ratchet, and the planted fixtures that prove it can see each way a string has
 * reached the screen without `t()`.
 *
 * The planted files exist only in memory, inside the real client program, so their imports and their types
 * resolve exactly as an app file's would. Each names the category it plants and the exact findings it must
 * produce: a scan that stopped seeing a category fails here, and a scan that started flagging a token fails on
 * the clean fixture.
 */

const PLANTED: Readonly<Record<string, { readonly source: string; readonly expected: ReadonlyArray<readonly [FindingKind, string]> }>> = {
  // JSX text, the parser-visible case.
  "text.tsx": {
    source: `export const A = () => <p>Nothing here yet</p>;`,
    expected: [["text", "Nothing here yet"]],
  },
  // An object's value, typed string: the largest category the parser-only scan missed.
  "object-value.tsx": {
    source: `const ACTIONS: Record<string, { label: string }> = { move: { label: "Move to Inbox" } };\nexport const B = ACTIONS;`,
    expected: [["literal", "Move to Inbox"]],
  },
  // A constant with no type at all.
  "untyped-constant.ts": {
    source: `export const NOT_SAVED = "Not saved in this browser";`,
    expected: [["literal", "Not saved in this browser"]],
  },
  // A \`??\` fallback.
  "fallback.ts": {
    source: `export function said(message: string | undefined): string { return message ?? "This Node gave no reason"; }`,
    expected: [["literal", "This Node gave no reason"]],
  },
  // A component prop typed string, which no attribute list names.
  "string-prop.tsx": {
    source: `function Row(props: { detail: string }) { return <p>{props.detail}</p>; }\nexport const C = () => <Row detail="Nothing has been handed over" />;`,
    expected: [["literal", "Nothing has been handed over"]],
  },
  // A call argument.
  "call-argument.ts": {
    source: `function recorded(what: string): string { return what; }\nexport const D = recorded("not set up yet");`,
    expected: [["literal", "not set up yet"]],
  },
  // A template literal in a perceivable attribute.
  "template-attribute.tsx": {
    source: "export const E = (props: { name: string }) => <button type=\"button\" aria-label={`Remove filter: ${props.name}`} />;",
    expected: [["literal", "Remove filter:"]],
  },
  // A returned word.
  "return.ts": {
    source: `export function phase(saving: boolean): string { if (saving) return "saving"; return "saved on your node"; }`,
    expected: [["literal", "saving"], ["literal", "saved on your node"]],
  },
  // Concatenation and a conditional as JSX children.
  "children.tsx": {
    source: `export const F = (props: { name: string; ok: boolean }) => <p>{"Draft for " + props.name}{props.ok ? "Ready to go" : null}</p>;`,
    expected: [["literal", "Draft for"], ["literal", "Ready to go"]],
  },
  // The pre-authentication script's shapes: a text node set directly, an attribute set by call, and the
  // element helper's props. Plain JavaScript, so nothing is typed and every literal with a letter is a finding.
  "dom.client.js": {
    source: `const node = document.createElement("p");\nnode.textContent = "Claiming…";\nnode.setAttribute("title", "Claim this Node");\nfunction el(tag, props) { return [tag, props]; }\nel("p", { text: "Signing in" });`,
    expected: [["literal", "Claiming…"], ["literal", "title"], ["literal", "Claim this Node"], ["literal", "p"], ["literal", "Signing in"]],
  },
  // A component's `name`, `id` or `href` is whatever the component shows (chrome.tsx's Row shows `name` as the
  // rail label); only an intrinsic element's platform attributes are structural by name.
  "component-props.tsx": {
    source: [
      `function Row(props: { name: string }) { return <span className="rail-name">{props.name}</span>; }`,
      `function Card(props: { id: string; href: string }) { return <p>{props.id}{props.href}</p>; }`,
      `export const R = () => <><Row name="Waiting for you" /><Row name={"Braced label"} /><Card id="Nothing here yet" href="Open the queue" /></>;`,
    ].join("\n"),
    expected: [["literal", "Waiting for you"], ["literal", "Braced label"], ["literal", "Nothing here yet"], ["literal", "Open the queue"]],
  },
  // A literal inside <NodeWords> is the interface's prose: the Node's words only ever arrive as an expression.
  "node-words-literal.tsx": {
    source: [
      `import { NodeWords } from "../words.tsx";`,
      `export const N = (props: { message?: string }) => <p><NodeWords>{"The Node's own words"}</NodeWords><NodeWords>{props.message ?? "Request failed"}</NodeWords><NodeWords>Plain text</NodeWords></p>;`,
    ].join("\n"),
    expected: [["literal", "The Node's own words"], ["literal", "Request failed"], ["text", "Plain text"]],
  },
  // An open union: a literal member beside `string & {}` still lets the position hold any sentence.
  "open-union.ts": {
    source: `type Token = "held" | (string & {});\nexport const x: Token = "Nothing heard yet";\nexport const y: Token | null = "held";`,
    expected: [["literal", "Nothing heard yet"], ["literal", "held"]],
  },
  // Formatting outside format.ts picks its own locale.
  "formatter.ts": {
    source: `export const G = (n: number, at: number) => [new Intl.NumberFormat().format(n), new Date(at).toLocaleTimeString()];`,
    expected: [["formatter", "Intl.NumberFormat"], ["formatter", "new Date(at).toLocaleTimeString()"]],
  },
  // Every structural pass, and a catalog call, in one file that must produce nothing.
  "clean.tsx": {
    source: [
      `import { t } from "/app/locale.js";`,
      `import { NodeWords } from "../words.tsx";`,
      `type Said = "some words in a type";`,
      `function Chip(props: { kind: "loading" | "failed" }) { return <span className={\`chip \${props.kind}\`}>{t("brand.name")}</span>; }`,
      `export function H(props: { state: string; said: Said; table: Record<string, number> }) {`,
      `  if (props.state === "handed_over") return null;`,
      `  switch (props.state) { case "held": return null; }`,
      `  const n = props.table["some key"] ?? ("other key" in props.table ? 1 : 0);`,
      `  return (`,
      `    <div className="ledger-row" id="row-one" data-kind="big" aria-labelledby="row-one">`,
      `      <button type="button" onClick={() => undefined}>{t("title.route", { screen: t("route./"), brand: t("brand.name") })}</button>`,
      `      <code>send.propose</code> <kbd>Ctrl</kbd> <samp>E_BUDGET_EXCEEDED</samp>`,
      `      <NodeWords>{props.state}</NodeWords>`,
      `      <Chip kind="loading" />{n}{props.said.length}`,
      `      <svg viewBox="0 0 16 16"><path d="M2 2h12v12H2z" fill="none" stroke="currentColor" /></svg>`,
      `    </div>`,
      `  );`,
      `}`,
    ].join("\n"),
    expected: [],
  },
};

const virtual = new Map(Object.entries(PLANTED).map(([name, { source }]) => [fixturePath(name), source]));

let real: Scan;
let planted: Scan;

/*
 * The whole client program is typed once, here, for every case below. Its own timeout, because typing it takes
 * seconds: `docs/receipts/untranslated-scan-timeout.md` measures how many.
 */
beforeAll(() => {
  const files = scannedFiles();
  const program = clientProgram(files, virtual);
  real = scan(program, files);
  planted = scan(program, [...virtual.keys()]);
}, BUDGETS["test.untranslated_scan_timeout_ms"]);

/** A file's findings, less those `NOT_PROSE` registers for it. */
function unregistered(file: string, findings: readonly Finding[]): Finding[] {
  const known = new Set((NOT_PROSE[file] ?? []).map((entry) => entry.text));
  return findings.filter((finding) => finding.file === file && !known.has(finding.text));
}

describe("the untranslated-text scan", () => {
  it("visits the whole interface, so a clean result cannot come from reading nothing", () => {
    expect(real.files).toBeGreaterThanOrEqual(35);
    expect(real.elements).toBeGreaterThanOrEqual(1_500);
    expect(real.literals).toBeGreaterThanOrEqual(5_000);
  });

  it.each(Object.keys(PLANTED))("finds exactly what %s plants", (name) => {
    const file = `src/client/app/__planted__/${name}`;
    const got = planted.findings.filter((finding) => finding.file === file).map((finding) => [finding.kind, finding.text]);
    expect(got).toEqual(PLANTED[name]!.expected);
  });

  it("holds every file to its UNMIGRATED count, which may only come down", () => {
    const files = new Set(real.findings.map((finding) => finding.file));
    const counted = Object.fromEntries([...files].sort().flatMap((file) => {
      const left = unregistered(file, real.findings).length;
      return left === 0 ? [] : [[file, left]];
    }));
    const risen = Object.entries(counted).filter(([file, n]) => n > (UNMIGRATED[file] ?? 0)).map(([file]) =>
      `${file}: ${unregistered(file, real.findings).slice(0, 5).map((f) => `line ${f.line} ${f.kind} ${JSON.stringify(f.text)}`).join("; ")}`);
    expect(risen, "new text outside the catalog: put it through t(), or register a non-word in NOT_PROSE with its reason").toEqual([]);
    expect(counted, "a count fell: lower it in test/node/untranslated.registry.ts (delete the file at zero)").toEqual(UNMIGRATED);
  });

  it("keeps no NOT_PROSE entry that matches nothing", () => {
    const stale = Object.entries(NOT_PROSE).flatMap(([file, entries]) => entries
      .filter((entry) => !real.findings.some((finding) => finding.file === file && finding.text === entry.text))
      .map((entry) => `${file}: ${JSON.stringify(entry.text)}`));
    expect(stale).toEqual([]);
    const scanned = new Set(scannedFiles().map((path) => path.slice(path.indexOf("src/client/"))));
    expect(Object.keys(NOT_PROSE).filter((file) => !scanned.has(file)), "a registry names a file the scan does not read").toEqual([]);
    expect(Object.keys(UNMIGRATED).filter((file) => !scanned.has(file))).toEqual([]);
  });
});
