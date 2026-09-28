import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import ts from "typescript";

const SRC = resolve(new URL("../../../src", import.meta.url).pathname);

/**
 * `doctor` as one text: `src/doctor.ts` — the report, the meter and the verdict — and every check module
 * under `src/doctor/`. Split on 16 September 2026 from one 3,139-line file, so a test that reads the doctor
 * for a check name or a phrase reads all of it rather than the file that happens to hold `runDoctor`.
 */
export function doctorFiles(): string[] {
  return [
    join(SRC, "doctor.ts"),
    ...readdirSync(join(SRC, "doctor")).filter((one) => one.endsWith(".ts")).map((one) => join(SRC, "doctor", one)),
  ];
}

export function doctorSource(): string {
  return doctorFiles().map((file) => readFileSync(file, "utf8")).join("\n");
}

/**
 * `doctor` as the TypeScript parser reads it: every identifier, and the text of every string and template
 * literal, with comments left out. For a claim about what doctor's code references (AGENTS.md §2c, rung 3), so
 * a comment that names a thing cannot turn a check red, and a reference split across lines cannot hide from one.
 */
export function doctorTokens(): { identifiers: Set<string>; literals: string[] } {
  const identifiers = new Set<string>();
  const literals: string[] = [];
  for (const file of doctorFiles()) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) identifiers.add(node.text);
      else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literals.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true));
  }
  return { identifiers, literals };
}
