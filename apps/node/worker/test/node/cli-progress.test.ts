import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const { banner, overview, progress } = await import("../../../../../packages/cli/src/progress.mjs");
// Computed specifiers, as `provider-routing-rules.test.ts` imports a verb: the verbs have no declaration files.
type Steps = { readonly [name: string]: readonly string[] };
const verb = async (name: string) => await import(`${import.meta.dirname}/../../../../../packages/cli/src/verbs/${name}.mjs`) as Steps;
const { UPGRADE_STEPS } = await verb("upgrade");
const { INSTALL_STEPS } = await verb("install");
const { SETUP_STEPS } = await verb("setup");

/**
 * Where a long command is, and how many steps are left (8 October 2026, the owner's: "better progress indication on
 * which step we are now and how many steps left").
 */
describe("a command's steps", () => {
  it("opens with every step numbered, and says each as it begins, by its place in the list", () => {
    const said: string[] = [];
    const steps = progress(["Get the release", "Back up the Node", "Deploy"], (text: string) => said.push(text));
    expect(said[0]).toBe("   3 steps:\n      1  Get the release\n      2  Back up the Node\n      3  Deploy\n");
    expect(overview(["Deploy"])).toBe("   1 step:\n      1  Deploy\n");
    // A step skipped is skipped: the next one keeps its own number.
    steps.step("Deploy");
    expect(said[1]).toMatch(/^\n━━ Step 3 of 3 · Deploy ━+\n$/);
  });

  it("draws every banner to the same width, however long the step's name", () => {
    for (const name of ["Deploy", "Receiving, sending and delivery outcomes"]) {
      expect([...banner(2, 7, name).trim()].length).toBe(96);
    }
  });

  it("refuses a step that is not the command's, naming the ones that are", () => {
    const steps = progress(["Deploy"], () => {});
    expect(() => steps.step("Deploy it")).toThrow(/"Deploy it" is not one of this command's steps: Deploy/);
  });
});

/**
 * Every banner a command asks for is one of its declared steps, read from the command's source with the TypeScript
 * parser (AGENTS.md §2c, rung 3): a misspelt step would otherwise throw at the operator, mid-upgrade.
 */
describe("each command's banners", () => {
  const asked = (file: string): string[] => {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "step"
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "steps") {
        const [first] = node.arguments;
        found.push(first !== undefined && ts.isStringLiteral(first) ? first.text : "<not a literal>");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };
  const verbs = (name: string) => `${import.meta.dirname}/../../../../../packages/cli/src/verbs/${name}.mjs`;

  it.each([["upgrade", UPGRADE_STEPS!], ["install", INSTALL_STEPS!], ["setup", SETUP_STEPS!]] as const)(
    "%s asks only for its own steps, each once, in the order it declares them",
    (name, steps) => {
      const said = asked(verbs(name));
      // Found at all, so this cannot pass by reading nothing.
      expect(said.length).toBeGreaterThan(2);
      expect(said).toEqual([...steps]);
    },
  );
});
