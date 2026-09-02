import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withoutComments } from "../without-comments.ts";

/**
 * The verifier names no table of its own (#131).
 *
 * ## Why a value comparison was not enough
 *
 * `test/evidence-audit.test.ts` checks that the tables swept equal the tables the inventory can name. A
 * mutation replacing the derivation with a **literal list of the same four names** passed it — correctly, in
 * the sense that the literal is right today. What the comparison cannot see is the property that matters: a
 * fifth prefix must reach the verifier because it reached the inventory, without anybody remembering.
 *
 * That is the whole of #131. Neither list was wrong on its own; they had merely stopped agreeing, and nothing
 * could tell — which is #67 and #74 a third time, arriving as a difference in coverage rather than a gap.
 *
 * So this asserts the **absence** of a second list, which is the only form the property takes in source.
 *
 * ## Scope
 *
 * Comments stripped, so the file's own prose about `ingress_receipts` — the table it used to sweep alone —
 * does not fail its own test. That is the eighth entry in `without-comments.ts` arriving as a prediction
 * rather than a cost: this file mentions all four names in the docstring explaining why it must not name them.
 */

const AUDIT = join(import.meta.dirname, "../../src/evidence-audit.ts");
const INVENTORY = join(import.meta.dirname, "../../src/evidence-inventory.ts");

/** The evidence tables, read from the file that is allowed to name them. */
function tables(): string[] {
  const source = withoutComments(INVENTORY);
  const found = [...source.matchAll(/table:\s*"([a-z_]+)"/g)].map((one) => one[1] as string);
  expect(found.length, "no referents were found, so nothing below is being checked").toBeGreaterThan(3);
  return [...new Set(found)];
}

describe("the verifier carries no list of its own", () => {
  it("finds the referent list, so nothing here passes by comparing against nothing", () => {
    // Four tables and six columns; the count is asserted against the receipt in the workerd suite.
    expect(tables()).toHaveLength(4);
  });

  it("names none of the evidence tables in its own code", () => {
    const code = withoutComments(AUDIT);
    const named = tables().filter((table) => code.includes(table));

    expect(
      named,
      "evidence-audit.ts names an evidence table directly. It must group `INVENTORY_REFERENTS` instead: two "
      + "lists that are each correct today is exactly how #67, #74 and #131 happened, and a fifth prefix has "
      + "to reach the verifier because it reached the inventory rather than because somebody remembered.",
    ).toEqual([]);
  });

  it("gets its tables from the inventory's referents, by name", () => {
    /*
     * The positive half. The check above is satisfied by a file that sweeps nothing at all, which is a worse
     * defect than the one it guards — so this requires the derivation to be present as well as the literals
     * absent.
     */
    const code = withoutComments(AUDIT);
    expect(code).toContain("INVENTORY_REFERENTS");
    expect(code).toMatch(/for \(const referent of INVENTORY_REFERENTS\)/);
  });
});
