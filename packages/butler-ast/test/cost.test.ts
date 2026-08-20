import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

import { checkButler } from "../src/check.ts";
import {
  costBudgetOf, priceButler, RUN_BUDGET, RUN_BUDGET_FREE, RUN_BUDGET_FREE_NAME, RUN_BUDGET_NAME,
  SHIPPED_NODE_COST,
} from "../src/cost.ts";
import { SHIPPED_KINDS } from "../src/nodes.ts";
import { assignChain, leadIntake, nestedLoops, withLoop } from "./fixture.ts";

/**
 * The price list itself (#54).
 *
 * `check.test.ts` proves what the checker *does* with a price. This file proves the price, because the two
 * fail in opposite directions and only one of them is visible: a checker that refuses correctly against a
 * table where `lookup` costs zero still under-prices every Butler containing a lookup, and every test about
 * refusals goes on passing. That is not hypothetical — it is what a mutation of `COST_BUDGET_OF` did to this
 * package's suite before this file existed, silently.
 *
 * So every shipped kind is pinned here, one row each, against the receipt key it came from. A node that
 * changes column — free to priced, or priced to free — is a change to what a Butler costs and has to be a
 * visible line in a diff.
 */

/** The receipt key behind each priced node. The four effects, plus `lookup`, which #54 measured. */
const PRICED: Record<string, keyof typeof BUDGETS> = {
  lookup: "butler.step_cost_max_lookup",
  "case.assign": "butler.step_cost_max_case_assign",
  "case.close": "butler.step_cost_max_case_close",
  draft: "butler.step_cost_max_draft",
  "mail.send.propose": "butler.step_cost_max_send_propose",
};

/**
 * The nodes `butler-step-cost.md` measured at zero, plus `map` and `foreach`, which that correction argues
 * to zero rather than measures. Listed rather than derived as "everything else", because "everything else is
 * free" is exactly the default that would price the next shipped node at nothing.
 */
const FREE = ["guard", "switch", "map", "foreach", "join", "wait", "stop", "transform", "validate"];

describe("what each shipped node costs, against the receipt that measured it", () => {
  it("covers every shipped kind exactly once, so the price list cannot go stale by omission", () => {
    expect([...Object.keys(PRICED), ...FREE].sort()).toEqual([...SHIPPED_KINDS].sort());
  });

  it("prices each effect at the receipted bound, and names which bound it was", () => {
    for (const [kind, budget] of Object.entries(PRICED)) {
      expect(SHIPPED_NODE_COST[kind as keyof typeof SHIPPED_NODE_COST], kind).toBe(BUDGETS[budget]);
      expect(costBudgetOf(kind as keyof typeof SHIPPED_NODE_COST), kind).toBe(budget);
      // Non-vacuity: a budget that read zero would satisfy the equality above while pricing nothing.
      expect(BUDGETS[budget], budget).toBeGreaterThan(0);
    }
  });

  it("leaves control flow and pure data at zero, and says so per kind rather than by default", () => {
    for (const kind of FREE) {
      expect(SHIPPED_NODE_COST[kind as keyof typeof SHIPPED_NODE_COST], kind).toBe(0);
      expect(costBudgetOf(kind as keyof typeof SHIPPED_NODE_COST), kind).toBeNull();
    }
  });

  it("divides the Paid pot, and keeps the Free one visible beside it", () => {
    // The names are asserted as well as the values, because every refusal prints the name from the same
    // constant it read the value from. A message naming a plan it did not divide is #68's overclaim
    // reappearing in the text about the fix.
    expect(RUN_BUDGET_NAME).toBe("workflow.paid.subrequest_budget_per_instance");
    expect(RUN_BUDGET_FREE_NAME).toBe("workflow.free.subrequest_budget_per_instance");
    expect(RUN_BUDGET).toBe(BUDGETS[RUN_BUDGET_NAME]);
    expect(RUN_BUDGET_FREE).toBe(BUDGETS[RUN_BUDGET_FREE_NAME]);
    expect(RUN_BUDGET).toBe(RUN_BUDGET_FREE * 10);
  });
});

describe("a lookup is priced, which nothing noticed until it was not", () => {
  /** The worked example with a chain of `count` lookups spliced in ahead of the guard. */
  function withLookups(count: number): Record<string, unknown> {
    const ast = leadIntake();
    if (count > 0) {
      // A `lookup` of a case reads queue metadata, so the ceiling has to declare metadata or content (#51).
      // Conditional on `count`, because declaring an action no node needs is refused just as firmly as
      // omitting one a node needs — which is what makes the ceiling's action set exactly the graph's.
      (ast["capabilities"] as unknown[]).push({
        action: "mailbox.metadata.read", resource: "mailbox:enquiries@example.com",
      });
    }
    const nodes = ast["nodes"] as Array<Record<string, unknown>>;
    for (let index = 0; index < count; index++) {
      nodes.push({
        id: `read_${index}`,
        type: "lookup",
        entity: "case",
        entityId: "${event.case_id}",
        as: `row_${index}`,
        next: index === count - 1 ? "security_guard" : `read_${index + 1}`,
      });
    }
    ast["entry"] = count === 0 ? "security_guard" : "read_0";
    return ast;
  }

  it("charges the receipted bound per lookup, not nothing", () => {
    const one = checkButler(withLookups(1));
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    const none = checkButler(leadIntake());
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(one.cost.total - none.cost.total).toBe(BUDGETS["butler.step_cost_max_lookup"]);
  });

  it("refuses a Butler made of lookups alone once they sum past the pot", () => {
    // 2,491 lookups at 4 is 9,964, and the worked example around them is 38 — 10,002, over by 2. This is the
    // "many small nodes" shape again with the cheapest *read* rather than the cheapest effect, and it is the
    // case that priced `lookup` at zero would have published at any size.
    const affordable = Math.floor((RUN_BUDGET - 38) / BUDGETS["butler.step_cost_max_lookup"]);
    expect(checkButler(withLookups(affordable)).ok).toBe(true);
    const refused = checkButler(withLookups(affordable + 1));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.findings.map((finding) => finding.code)).toEqual(["E_BUTLER_UNAFFORDABLE"]);
  });
});

describe("priceButler on the graph it is given", () => {
  it("prices the Butler this layer ships, node by node", () => {
    const result = checkButler(leadIntake());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // guard 0 + stop 0 + case.assign 8 + draft 10 + mail.send.propose 20.
    expect(result.cost.total).toBe(38);
    expect(result.cost.outsideLoopCount).toBe(5);
    expect(result.cost.loops).toEqual([]);
    expect(result.cost.dearest).toMatchObject({ id: "propose", type: "mail.send.propose", each: 20 });
    expect(result.cost.saturated).toBe(false);
  });

  it("counts a maxItems of 1 as a loop, so the parts of the bill add up to the bill", () => {
    /*
     * `1` is a legal bound that needs no receipt — it means "one" — and it is the one shape where "inside a
     * loop" and "runs more than once" disagree. Pricing by multiplier put `send_one` in the fixed sum *and*
     * in `fan_out`'s total, so the breakdown a refusal prints read "7 node(s) outside a loop cost 58; foreach
     * fan_out costs maxItems=1 × 20 per item = 20" against a total of 58. The parts have to add up, or the
     * refusal is asking its reader to believe two of its own numbers at once.
     */
    const result = checkButler(withLoop(1));
    expect(result.ok, result.ok ? "" : "withLoop(1) must publish").toBe(true);
    if (!result.ok) return;
    const { cost } = result;
    expect(cost.total).toBe(58);
    // Six nodes are outside the loop; `send_one` is the body and belongs to `fan_out`, not to the fixed sum.
    expect(cost.outsideLoopCount).toBe(6);
    expect(cost.outsideLoops).toBe(38);
    expect(cost.loops[0]).toMatchObject({ id: "fan_out", maxItems: 1, perItem: 20, total: 20 });
    expect(cost.outsideLoops + cost.loops.reduce((sum, loop) => sum + (loop.nested ? 0 : loop.total), 0))
      .toBe(cost.total);
    // And the same identity on the loop this receipt does its arithmetic about, so the assertion above is a
    // property of the pass rather than of the number 1.
    const two = checkButler(withLoop(200));
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(two.cost.outsideLoops + two.cost.loops[0]!.total).toBe(two.cost.total);
  });

  it("admits a Butler that spends the pot exactly, and refuses the one that spends one more", () => {
    /*
     * The boundary the comparison is made of, and `>` versus `>=` differ on exactly this input. Spending the
     * pot exactly is affordable: 10,000 is where the invocation dies, not where it becomes risky, and the
     * margin for being wrong is already inside every per-node bound — 1,250 `case.assign` nodes are priced at
     * 8 each and measured at 5, so this Butler's real cost is 6,250.
     */
    const exact = 1_250;
    expect(exact * BUDGETS["butler.step_cost_max_case_assign"]).toBe(RUN_BUDGET);
    const fits = checkButler(assignChain(exact));
    expect(fits.ok).toBe(true);
    if (fits.ok) expect(fits.cost.total).toBe(RUN_BUDGET);

    const over = checkButler(assignChain(exact + 1));
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.findings.map((finding) => finding.code)).toEqual(["E_BUTLER_UNAFFORDABLE"]);
  });

  it("keeps every figure it reports a safe integer, however deep the loops nest", () => {
    /*
     * Four loops of a million multiply to 10^24. A total that wrapped rather than clamped would still be a
     * `number`, still be greater than the pot, and still produce a refusal — with a figure in it that a
     * double cannot represent. `Number.isSafeInteger` is what tells those two apart, and asserting it on the
     * loop totals as well as the graph total is what pins the *product*, since the sum clamps either way.
     */
    const result = checkButler(nestedLoops(4, 1_000_000));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const cost = priceButler(
      (nestedLoops(4, 1_000_000)["nodes"] as never[]),
    );
    expect(Number.isSafeInteger(cost.total), `total ${cost.total}`).toBe(true);
    expect(cost.total).toBe(Number.MAX_SAFE_INTEGER);
    expect(cost.saturated).toBe(true);
    for (const loop of cost.loops) {
      expect(Number.isSafeInteger(loop.total), `${loop.id} total ${loop.total}`).toBe(true);
      expect(Number.isSafeInteger(loop.perItem), `${loop.id} perItem ${loop.perItem}`).toBe(true);
    }
    // And the refusal says "at least", because a saturated total is a floor rather than a figure.
    expect(result.findings[0]?.what).toContain(`at least ${Number.MAX_SAFE_INTEGER}`);
  });

  it("prices an empty node list at zero without inventing a floor", () => {
    // Not reachable through `checkButler` — the schema requires at least one node — so it is asserted on the
    // pricing function directly. A pass that charged for merely existing would be a number with no receipt.
    expect(priceButler([]).total).toBe(0);
  });
});
