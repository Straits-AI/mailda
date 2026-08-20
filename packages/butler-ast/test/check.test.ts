import { describe, expect, it } from "vitest";

import { checkButler, describeFindings, parseButler, type Finding } from "../src/check.ts";
import {
  assignChain as manyAssigns, leadIntake, loopOfPureTransforms, manyCheapNodes, withLoop,
} from "./fixture.ts";

/**
 * The checker (#49, #54).
 *
 * The three refusals #49 asked for are here — a reserved node, a cycle, an unbounded loop — plus the
 * structural minimum that makes cycle detection mean anything: unique ids, an entry that exists, and no
 * edge pointing at nothing. #54 adds the fourth: a graph that cannot afford to run.
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
    (nodesOf(ast).find((node) => node["id"] === "send_one")!)["next"] = "fan_out";
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

  it("refuses a maxItems of a million, which this file used to assert publishes (#54)", () => {
    /*
     * **A pinned absence became a pinned presence, and that is the point of the change.** #49 asserted
     * `expect(codes(withLoop(1_000_000))).toEqual([])` — a million items publishes — with the comment *"This
     * checker admits it, on purpose: affordability depends on the cost of the rest of the graph against a
     * plan-scoped whole-run budget, and a number invented here would be the wrong one in the permissive
     * direction."* Every word of that was true while the seam was empty. The seam is filled, the pot is
     * chosen (Workers Paid, argued in `src/cost.ts`), and the same document is now refused.
     *
     * The fixture changed with it: the loop's body is a `mail.send.propose` rather than a `transform`,
     * because a body that performs no I/O is genuinely free at any bound. That is asserted on its own below
     * rather than left implied.
     */
    expect(codes(withLoop(1_000_000))).toEqual(["E_BUTLER_UNAFFORDABLE"]);
  });

  it("admits a million iterations of a body that spends nothing, and says so out loud", () => {
    // The boundary of what this pass can claim. Subrequests are the only currency with a measurement behind
    // them; CPU cannot be metered from inside a Worker, so `butler-step-cost.md` records which of the two
    // binds first as unestablished. A loop that only binds values costs zero subrequests, and a refusal here
    // would be a number this repository never measured.
    expect(codes(loopOfPureTransforms(1_000_000))).toEqual([]);
  });
});

describe("a Butler that cannot afford itself is refused, naming the arithmetic (#54)", () => {
  function finding(input: unknown): Finding {
    const result = checkButler(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    const found = result.findings.find((f) => f.code === "E_BUTLER_UNAFFORDABLE");
    expect(found, describeFindings(result.findings)).toBeDefined();
    return found as Finding;
  }

  it("publishes the largest loop that fits and refuses the next one up", () => {
    /*
     * 498 and 499, not 500 and 501, and the gap is the whole reason the rule sums the graph. The receipt's
     * headline is `10,000 / 20 = 500`, which is what a sending loop costs *alone*. This loop is not alone:
     * the guard, the assign, the draft and the propose around it have already spent 38, so the pot has room
     * for 498 items and the 499th is over by 18.
     */
    expect(codes(withLoop(498))).toEqual([]);
    expect(codes(withLoop(499))).toEqual(["E_BUTLER_UNAFFORDABLE"]);
  });

  it("names the loop, its bound, its per-item cost and their product", () => {
    const found = finding(withLoop(499));
    expect(found.node).toBe("fan_out");
    expect(found.what).toContain("10018 subrequests per run");
    expect(found.what).toContain("workflow.paid.subrequest_budget_per_instance=10000");
    expect(found.what).toContain("6 node(s) outside a loop cost 38");
    expect(found.what).toContain("foreach fan_out costs maxItems=499 × 20 per item = 9980");
    // Which node inside the loop makes it expensive, and which receipted bound priced it.
    expect(found.what).toContain("send_one, a mail.send.propose at butler.step_cost_max_send_propose=20");
  });

  it("tells the author the bound that would have worked, and names both plans' pots", () => {
    const found = finding(withLoop(499));
    expect(found.fix).toContain("lower fan_out's maxItems to 498 or fewer");
    // The pot divided is Paid; the Free row is printed beside it because a Free Node is unsupported rather
    // than impossible, and its arithmetic is a tenth of the size.
    expect(found.fix).toContain("Workers Paid because ADR 25 requires it");
    expect(found.fix).toContain("workflow.free.subrequest_budget_per_instance=1000");
    expect(found.fix).toContain("fan_out's affordable maxItems there is 48");
    expect(found.fix).toContain("docs/receipts/butler-step-cost.md");
  });

  it("says what a run that overspends actually does, which is not what an exceeded maxItems does", () => {
    // The two failures are different and the refusal has to distinguish them, or an author reads "bounded"
    // and assumes the safe one. #49's bound fails the step and processes nothing; the platform ceiling kills
    // the invocation after the effects it already performed.
    const found = finding(withLoop(499));
    expect(found.why).toContain("one subrequest pot for the whole run");
    expect(found.why).toContain("killed wherever it has got to, mid-loop");
    expect(found.why).toContain("processes nothing");
  });

  it("refuses many cheap nodes that sum past the pot, where no single node is large", () => {
    /*
     * The case a per-node check would publish, and the reason the rule is *sum the graph*. `case.close` is
     * the cheapest effect in the shipped set at a bound of 3, and 3,334 of them are 10,002 — over the pot by
     * two, with the dearest node in the Butler costing 3.
     */
    const found = finding(manyCheapNodes(3_334));
    expect(found.what).toContain("10002 subrequests per run");
    expect(found.what).toContain("3334 node(s) outside a loop cost 10002");
    // No loop to blame and none to shrink, so the fix says so instead of inventing one.
    expect(found.fix).toContain("Nothing here is a loop bound that could be lowered");
    // And no node is named: the "dearest" of 3,334 identical nodes is whichever the scan reached first, and
    // pointing an author at it would blame a line no more at fault than the other 3,333.
    expect(found.node).toBeUndefined();
    // Nor does it say "mid-loop" about a graph with no loop in it.
    expect(found.why).not.toContain("mid-loop");
    expect(codes(manyCheapNodes(3_333))).toEqual([]);
  });

  it("does not blame a loop that costs nothing, or say mid-loop about a chain", () => {
    /*
     * The same rule the 3,334-`case.close` case states — do not point an author at a line that is not the
     * reason — applied to the one node that is *provably* not the reason. A `foreach` of a million pure
     * transforms contributes 0, so a graph that overspends beside one has not overspent because of it, and a
     * run that dies is not dying mid-loop. Naming it would be worse than naming nothing: `close_0` is at
     * least one of the 3,334 culprits, and this loop is none of them.
     */
    const ast = manyCheapNodes(3_334);
    const nodes = nodesOf(ast);
    nodes.push({
      id: "spin", type: "foreach", over: "${event.recipients}", as: "r",
      maxItems: 1_000_000, body: "noted", next: null,
    });
    nodes.push({ id: "noted", type: "transform", as: "n", value: "${r}", next: null });
    (nodes.find((node) => node["id"] === "close_3333")!)["next"] = "spin";

    const found = finding(ast);
    expect(found.what).toContain("10002 subrequests per run");
    // The free loop is still described — its bound is 0 per item, which is the useful thing to know — but it
    // is not the node the finding points at, and it does not turn the chain's death into a loop's.
    expect(found.what).toContain("foreach spin costs maxItems=1000000 × 0 per item = 0");
    expect(found.node).toBeUndefined();
    expect(found.why).not.toContain("mid-loop");
    expect(found.fix).toContain("Nothing here is a loop bound that could be lowered");
  });

  it("multiplies nested loops, and prices the inner body per outer iteration", () => {
    // Two loops of 200 is 40,000 sends, and neither bound looks alarming on its own. The multiplier is what
    // makes that visible: a node in two bodies is priced at both bounds.
    const ast = withLoop(200);
    const nodes = nodesOf(ast);
    (nodes.find((node) => node["id"] === "fan_out")!)["body"] = "inner";
    nodes.push({
      id: "inner", type: "foreach", over: "${recipient.addresses}", as: "one",
      maxItems: 200, body: "send_one", next: null,
    });
    const found = finding(ast);
    expect(found.what).toContain("800038 subrequests per run");
    expect(found.what).toContain("per outer iteration, because this loop is inside another");
  });

  it("reports a saturated total as a floor rather than a number it made up", () => {
    // Four nested loops of a million multiply past what a double represents exactly. A silently rounded
    // total would be wrong in whichever direction the rounding fell.
    const ast = loopOfPureTransforms(1_000_000);
    const nodes = nodesOf(ast);
    (nodes.find((node) => node["id"] === "note_one")!)["type"] = "case.close";
    delete (nodes.find((node) => node["id"] === "note_one")!)["as"];
    delete (nodes.find((node) => node["id"] === "note_one")!)["value"];
    (nodes.find((node) => node["id"] === "note_one")!)["caseId"] = "${event.case_id}";
    let outer = "fan_out";
    for (let depth = 0; depth < 3; depth++) {
      const id = `nest_${depth}`;
      nodes.push({
        id, type: "foreach", over: "${recipient.more}", as: `r${depth}`,
        maxItems: 1_000_000, body: depth === 2 ? "note_one" : `nest_${depth + 1}`, next: null,
      });
      (nodes.find((node) => node["id"] === outer)!)["body"] = id;
      outer = id;
    }
    const found = finding(ast);
    expect(found.what).toContain(`at least ${Number.MAX_SAFE_INTEGER}`);
  });

  it("does not price a graph with a structural problem, however expensive that graph looks", () => {
    /*
     * 1,252 `case.assign` nodes cost 10,016 — over the pot — and one of them points at a node that does not
     * exist. Only the dangling edge is reported. A second finding about the cost would be a number computed
     * over a graph whose shape is not yet known to be a graph, and it would send the author to shrink a
     * Butler whose actual problem is a typo in an edge.
     */
    const ast = manyAssigns(1_252);
    expect(1_252 * 8).toBeGreaterThan(10_000);
    nodesOf(ast)[0]!["next"] = "ghost";
    expect(codes(ast)).toEqual(["E_BUTLER_EDGE_DANGLING"]);
    // And with the typo fixed, the cost is what it was all along.
    nodesOf(ast)[0]!["next"] = "assign_1";
    expect(codes(ast)).toEqual(["E_BUTLER_UNAFFORDABLE"]);
  });

  it("prices nothing and reports the structural problem instead, when the graph has one", () => {
    // An unbounded loop has no `maxItems` to multiply, so there is no cost to report — and a second finding
    // carrying a fabricated total would end the reader's question rather than prompt it.
    const codesFound = codes(withLoop(0));
    expect(codesFound).not.toContain("E_BUTLER_UNAFFORDABLE");
    // Two symptoms of one cause, which #49 already says of a dangling edge: `fan_out` failed its own check,
    // so the node pointing at it is now pointing at nothing checkable.
    expect(codesFound).toEqual(["E_BUTLER_LOOP_UNBOUNDED", "E_BUTLER_EDGE_DANGLING"]);
  });

  it("hands the cost back on the way through, so an author who fits can still see the bill", () => {
    const result = checkButler(withLoop(200));
    expect(result.ok, result.ok ? "" : describeFindings(result.findings)).toBe(true);
    if (!result.ok) return;
    expect(result.cost.total).toBe(4038);
    expect(result.cost.outsideLoops).toBe(38);
    expect(result.cost.loops[0]).toMatchObject({ id: "fan_out", maxItems: 200, perItem: 20, total: 4000 });
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
