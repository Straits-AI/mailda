import { describe, expect, it } from "vitest";

import { checkButler, describeFindings, parseButler } from "../src/check.ts";
import { leadIntake, withLoop } from "./fixture.ts";

/**
 * The structural checker (#49).
 *
 * The three refusals the ticket asks for are here — a reserved node, a cycle, an unbounded loop — plus the
 * structural minimum that makes cycle detection mean anything: unique ids, an entry that exists, and no
 * edge pointing at nothing.
 *
 * Each refusal is asserted on its **code**, not on its prose. A test that matches wording is a test that
 * fails when somebody improves the message, and the thing an agent reads programmatically is the code.
 */

function codes(input: unknown): string[] {
  const result = checkButler(input);
  return result.ok ? [] : result.findings.map((finding) => finding.code);
}

function nodesOf(ast: Record<string, unknown>): Array<Record<string, unknown>> {
  return ast["nodes"] as Array<Record<string, unknown>>;
}

describe("the checker admits what ships", () => {
  it("accepts the Butler this layer actually delivers", () => {
    const result = checkButler(leadIntake());
    expect(result.ok ? "ok" : describeFindings(result.findings)).toBe("ok");
  });

  it("accepts a bounded loop", () => {
    expect(codes(withLoop(200))).toEqual([]);
  });
});

describe("a reserved node parses, and is then refused by name", () => {
  function withReserved(type: string): Record<string, unknown> {
    const ast = leadIntake();
    nodesOf(ast).push({ id: "classify", type, profile: "sales-intake@3" });
    (nodesOf(ast).find((node) => node["id"] === "security_guard")!)["then"] = "classify";
    return ast;
  }

  it("parses — which is the whole point of reserving rather than omitting", () => {
    const parsed = parseButler(withReserved("llm.classify"));
    expect(parsed.ok, parsed.ok ? "" : parsed.issues).toBe(true);
  });

  it("is refused, with the node named and a reason that is not 'unsupported'", () => {
    const result = checkButler(withReserved("llm.classify"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const finding = result.findings.find((f) => f.code === "E_BUTLER_NODE_RESERVED");
    expect(finding).toBeDefined();
    expect(finding?.node).toBe("classify");
    expect(finding?.what).toContain("llm.classify");
    expect(finding?.why).toContain("LLM control plane");
  });

  it("refuses template.render, which the correction moved off the shipping side", () => {
    // Named on its own rather than folded into the loop below, because this is the one reserved node that
    // was once written down as shipping. A regression here is somebody quietly putting it back.
    const result = checkButler(withReserved("template.render"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings.some((f) => f.code === "E_BUTLER_NODE_RESERVED" && f.why.includes("template")))
      .toBe(true);
  });

  it("refuses every reserved node, not just the ones with a test", () => {
    for (const type of [
      "llm.classify", "llm.extract", "llm.summarize", "llm.draft", "llm.evaluate", "label", "route",
      "archive", "quarantine", "case.upsert", "case.task", "case.note", "connector.call",
      "approval.request", "template.render",
    ]) {
      expect(codes(withReserved(type)), type).toContain("E_BUTLER_NODE_RESERVED");
    }
  });

  it("refuses an unknown type at parse, and says which types exist", () => {
    // The stated boundary of enumerating a family: `connector.call` is reserved and refused with a reason,
    // while `connector.salesforce.upsert` is not a member of the union at all.
    const result = checkButler(withReserved("connector.salesforce.upsert"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const finding = result.findings.find((f) => f.code === "E_BUTLER_NODE_UNKNOWN");
    expect(finding?.fix).toContain("mail.send.propose");
  });
});

describe("a cycle is refused", () => {
  it("catches a two-node loop, and names the path", () => {
    const ast = leadIntake();
    nodesOf(ast).push({ id: "chase", type: "wait", seconds: 86_400, next: "nudge" });
    nodesOf(ast).push({ id: "nudge", type: "transform", as: "n", value: "1", next: "chase" });

    const result = checkButler(ast);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const cycle = result.findings.find((f) => f.code === "E_BUTLER_CYCLE");
    expect(cycle?.what).toMatch(/chase -> nudge -> chase|nudge -> chase -> nudge/);
  });

  it("catches a self-edge", () => {
    const ast = leadIntake();
    nodesOf(ast).push({ id: "spin", type: "transform", as: "n", value: "1", next: "spin" });
    expect(codes(ast)).toContain("E_BUTLER_CYCLE");
  });

  it("catches a cycle nothing reaches from the entry", () => {
    // Acyclicity is a property of the graph. A cycle in a disconnected component is one the next edit
    // connects, and a checker that only walked from `entry` would publish it today and fail on the edit.
    const ast = leadIntake();
    nodesOf(ast).push({ id: "orphan_a", type: "transform", as: "a", value: "1", next: "orphan_b" });
    nodesOf(ast).push({ id: "orphan_b", type: "transform", as: "b", value: "1", next: "orphan_a" });
    expect(codes(ast)).toContain("E_BUTLER_CYCLE");
  });

  it("catches a loop body that jumps back to its own loop header", () => {
    // The case that would otherwise be an unbounded loop wearing a bounded loop's clothes: the implicit
    // return from a body is not an edge, so an explicit one is a cycle.
    const ast = withLoop(10);
    (nodesOf(ast).find((node) => node["id"] === "note_one")!)["next"] = "fan_out";
    expect(codes(ast)).toContain("E_BUTLER_CYCLE");
  });

  it("does not call a diamond a cycle", () => {
    // Two branches converging on one node is the shape `join` exists for, and a colour-blind traversal
    // that marked visited-once nodes as open would report it as a cycle.
    const ast = leadIntake();
    nodesOf(ast).push({ id: "merge", type: "join", next: null });
    (nodesOf(ast).find((node) => node["id"] === "drop")!)["type"] = "transform";
    const drop = nodesOf(ast).find((node) => node["id"] === "drop")!;
    delete drop["reason"];
    drop["as"] = "dropped";
    drop["value"] = "1";
    drop["next"] = "merge";
    (nodesOf(ast).find((node) => node["id"] === "propose")!)["next"] = "merge";
    expect(codes(ast)).toEqual([]);
  });
});

describe("a loop without a well-formed bound is refused", () => {
  it("refuses an absent maxItems, naming the field and the failure semantics", () => {
    const ast = withLoop(undefined);
    delete (nodesOf(ast).find((node) => node["id"] === "fan_out")!)["maxItems"];
    const result = checkButler(ast);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const finding = result.findings.find((f) => f.code === "E_BUTLER_LOOP_UNBOUNDED");
    expect(finding?.node).toBe("fan_out");
    expect(finding?.what).toContain("maxItems");
    // The refusal has to carry the semantics, because "add a maxItems" invites 100000.
    expect(finding?.why).toContain("processes nothing");
  });

  it("refuses zero, a negative, a float and a string", () => {
    for (const bad of [0, -1, 1.5, "200", null, Number.MAX_VALUE]) {
      expect(codes(withLoop(bad)), String(bad)).toContain("E_BUTLER_LOOP_UNBOUNDED");
    }
  });

  it("says nothing about whether a bound is affordable — that seam is #54's", () => {
    // A million items is structurally fine and certainly unaffordable. This checker admits it, on purpose:
    // affordability depends on the cost of the rest of the graph against a plan-scoped whole-run budget,
    // and a number invented here would be the wrong one in the permissive direction.
    expect(codes(withLoop(1_000_000))).toEqual([]);
  });
});

describe("the structural minimum that makes the rest mean anything", () => {
  it("refuses two nodes with one id", () => {
    const ast = leadIntake();
    nodesOf(ast).push({ id: "propose", type: "stop", reason: "again" });
    expect(codes(ast)).toContain("E_BUTLER_DUPLICATE_NODE_ID");
  });

  it("refuses an entry that names nothing", () => {
    const ast = leadIntake();
    ast["entry"] = "nowhere";
    expect(codes(ast)).toContain("E_BUTLER_NO_ENTRY");
  });

  it("refuses an edge pointing at nothing", () => {
    const ast = leadIntake();
    (nodesOf(ast).find((node) => node["id"] === "propose")!)["next"] = "ghost";
    expect(codes(ast)).toContain("E_BUTLER_EDGE_DANGLING");
  });

  it("refuses a document that is not a mailda/v1 Butler at all", () => {
    expect(codes({ apiVersion: "mailda/v2", kind: "Butler" })).toEqual(["E_BUTLER_MALFORMED"]);
    expect(codes(null)).toEqual(["E_BUTLER_MALFORMED"]);
    expect(codes("a string")).toEqual(["E_BUTLER_MALFORMED"]);
  });

  it("refuses a malformed shipped node, naming the node and the field", () => {
    const ast = leadIntake();
    delete (nodesOf(ast).find((node) => node["id"] === "acknowledge")!)["subject"];
    const result = checkButler(ast);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const finding = result.findings.find((f) => f.code === "E_BUTLER_NODE_MALFORMED");
    expect(finding?.node).toBe("acknowledge");
    expect(finding?.what).toContain("subject");
  });

  it("reports every problem in one pass, not the first one", () => {
    // A checker that stopped at the first finding is a checker somebody runs eleven times, and the reader
    // is an agent fixing its own mistake.
    const ast = leadIntake();
    nodesOf(ast).push({ id: "classify", type: "llm.classify" });
    nodesOf(ast).push({ id: "spin", type: "transform", as: "n", value: "1", next: "spin" });
    ast["entry"] = "nowhere";
    const found = codes(ast);
    expect(new Set(found)).toEqual(new Set(["E_BUTLER_NO_ENTRY", "E_BUTLER_NODE_RESERVED", "E_BUTLER_CYCLE"]));
  });

  it("renders findings in AGENTS.md's shape", () => {
    const result = checkButler({ ...leadIntake(), entry: "nowhere" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = describeFindings(result.findings);
    expect(text).toContain("E_BUTLER_NO_ENTRY");
    expect(text).toContain("why      ");
    expect(text).toContain("fix      ");
  });
});
