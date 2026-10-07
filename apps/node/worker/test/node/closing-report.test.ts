import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * By absolute path, typed here: `deploy.mjs` has no hand-written declaration, and one would have to declare its
 * `installedUrl` binding, which `declaration-drift.test.ts` compares as functions only.
 */
const VERBS = resolve(import.meta.dirname, "../../../../../packages/cli/src/verbs");
const { closingReport } = await import(resolve(VERBS, "deploy.mjs")) as {
  closingReport: (origin: string, serving: string, beforeReport?: () => Promise<void>) => Promise<number>;
};

/**
 * `mailda upgrade` ends on the live Node's report, and its read of verified destinations comes before that
 * report (28 September 2026). It printed the report and then read them, so every upgrade that refreshed them
 * ended on a report its own read had already outdated ("2 of 5 … observed", with no snapshot yet).
 *
 * The order is tested by running `closingReport` against a stubbed Node. What the upgrade hands it, and that the
 * deploy passes it on, are facts only their source can witness, so they are read with the TypeScript parser
 * (AGENTS.md §2c, rung 3).
 */

describe("the deploy's closing report", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  /** Stdout and stderr in one stream, in the order written. */
  function capture() {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    return () => out.join("");
  }

  it("runs the caller's step first and prints the report last", async () => {
    vi.stubGlobal("fetch", async () => new Response("mailda doctor  OK  (claimed)\n  ok  delivery_outcomes\n", { status: 200 }));
    const printed = capture();

    const code = await closingReport("https://node.test", "v_old", async () => {
      process.stdout.write("   verified destinations  1 of 2 addresses\n");
    });

    const step = printed().indexOf("verified destinations  1 of 2");
    const report = printed().indexOf("== asking the live Node how it is");
    expect(step, "the caller's step never ran").toBeGreaterThan(-1);
    expect(report, "the report was never asked for").toBeGreaterThan(-1);
    expect(step).toBeLessThan(report);
    expect(printed().indexOf("mailda doctor  OK")).toBeGreaterThan(report);
    expect(code).toBe(0);
  });

  it("still asks the Node and prints the rollback when the step throws, then fails with the step's error", async () => {
    // The version serving before is the one value a person cannot look up mid-incident; a step cannot take it.
    vi.stubGlobal("fetch", async () => new Response("mailda doctor  REFUSE  (claimed)\n  refuse  key_vault\n", { status: 503 }));
    const printed = capture();

    await expect(closingReport("https://node.test", "v_old", async () => { throw new Error("the read broke off"); }))
      .rejects.toThrow("the read broke off");

    expect(printed()).toContain("the step after promotion stopped: the read broke off");
    expect(printed()).toContain("== asking the live Node how it is");
    expect(printed()).toContain("mailda doctor  REFUSE");
    expect(printed()).toContain("wrangler versions deploy v_old@100");
  });
});

describe("what runs before the report, and what waits for it", () => {
  const parse = (name: string) => {
    const file = resolve(VERBS, name);
    return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
  };
  const callsIn = (root: ts.Node, name: string): ts.CallExpression[] => {
    const found: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText() === name) found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
  };
  const declared = (source: ts.SourceFile, name: string) => {
    const found = source.statements.find((one): one is ts.FunctionDeclaration => ts.isFunctionDeclaration(one) && one.name?.text === name);
    expect(found, `${name} is not a function declared in ${source.fileName}`).toBeDefined();
    return found!;
  };
  /** Whether `inner` sits inside `outer` in the source. */
  const within = (inner: ts.Node, outer: ts.Node) => inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd();

  it("deploy hands its caller's step to the closing report", () => {
    // Dropped, the step falls to the report's no-op default: the read silently never runs and every test stays green.
    const source = parse("deploy.mjs");
    const deploy = declared(source, "deploy");
    const options = deploy.parameters[1]?.name;
    expect(options !== undefined && ts.isObjectBindingPattern(options) && options.elements.some((one) => one.name.getText() === "beforeReport"),
      "deploy takes no beforeReport, so the closing report gets none").toBe(true);
    const reports = callsIn(deploy, "closingReport");
    expect(reports, "deploy no longer ends in closingReport; this test is about nothing").toHaveLength(1);
    const handed = reports[0]!.arguments[2];
    expect(handed !== undefined && ts.isIdentifier(handed) && handed.text === "beforeReport", "deploy does not pass beforeReport on").toBe(true);
  });

  it("upgrade reads verified destinations inside the step, and sets the Node up only after the refuse exit", () => {
    const source = parse("upgrade.mjs");
    const upgrade = declared(source, "upgrade");
    const [deployCall, ...more] = callsIn(source, "deploy");
    expect(deployCall, "upgrade no longer calls deploy; this test is about nothing").toBeDefined();
    expect(more).toHaveLength(0);
    const options = deployCall!.arguments[1];
    expect(options !== undefined && ts.isObjectLiteralExpression(options), "deploy is given no options, so no step runs before its report").toBe(true);
    const hook = (options as ts.ObjectLiteralExpression).properties
      .find((one): one is ts.PropertyAssignment => ts.isPropertyAssignment(one) && one.name.getText() === "beforeReport");
    expect(hook, "deploy is given no beforeReport").toBeDefined();

    // The hook names one function in this file; every read of verified destinations is inside it.
    const named = hook!.initializer.getText().match(/\b(\w+)\(/)?.[1] ?? "";
    const read = declared(source, named);
    const reads = callsIn(source, "verifiedDestinationsStep");
    expect(reads.length).toBeGreaterThan(0);
    for (const one of reads) expect(within(one, read), "a verified-destinations read runs outside the step").toBe(true);

    // The writes are not in the step: they would run before `refuse` is known.
    const writes = callsIn(source, "provisionNode");
    expect(writes.length).toBeGreaterThan(0);
    for (const one of writes) expect(within(one, read) || within(one, hook!), "the setup's writes run before the verdict").toBe(false);

    // And the setup that makes them runs once, after the statement that exits on `refuse`.
    const refuse = upgrade.body!.statements.find((one): one is ts.IfStatement => ts.isIfStatement(one) && one.expression.getText() === "deployed === 2");
    expect(refuse, "upgrade no longer exits on refuse").toBeDefined();
    expect(callsIn(refuse!, "process.exit").length, "the refuse branch no longer exits").toBeGreaterThan(0);
    const setUps = callsIn(source, "setUpNode");
    expect(setUps).toHaveLength(1);
    expect(setUps[0]!.getStart()).toBeGreaterThan(refuse!.getEnd());
    for (const one of writes) expect(within(one, declared(source, "setUpNode"))).toBe(true);
  });
});
