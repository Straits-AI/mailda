import { describe, expect, it } from "vitest";

import { parseReceipt, ReceiptError } from "../src/parse.ts";

const GOOD = `---
id: butler-fanout-max-effects
kind: measured-tripwire
measured_on: 2026-08-03
stale_when: a certified pack ships a legitimate fan-out above 200
values:
  butler.fanout.max_effects: 500
---

**Measured:** prose below the frontmatter is free-form.
`;

describe("parseReceipt", () => {
  it("reads a well-formed receipt", () => {
    const receipt = parseReceipt("docs/receipts/x.md", GOOD);
    expect(receipt.id).toBe("butler-fanout-max-effects");
    expect(receipt.kind).toBe("measured-tripwire");
    expect(receipt.values).toEqual({ "butler.fanout.max_effects": 500 });
  });

  // AGENTS.md: their agents read our errors. Each rejection has to say what is wrong
  // AND what to do, or it is a blank window with extra steps.
  const rejections: Array<{ why: string; text: string; says: RegExp[] }> = [
    {
      why: "no frontmatter",
      text: "# just prose\n",
      says: [/no YAML frontmatter/, /id, kind, measured_on/],
    },
    {
      why: "unknown kind",
      text: GOOD.replace("measured-tripwire", "vibes"),
      says: [/kind=vibes/, /platform-limit, measured-tripwire, slo/],
    },
    {
      why: "measured_on is not a date",
      text: GOOD.replace("2026-08-03", "last Tuesday"),
      says: [/measured_on=last Tuesday/, /YYYY-MM-DD/],
    },
    {
      why: "stale_when is empty",
      text: GOOD.replace("stale_when: a certified pack ships a legitimate fan-out above 200", 'stale_when: ""'),
      says: [/stale_when is empty/, /nobody will recheck/],
    },
    {
      why: "a value is not a number",
      text: GOOD.replace("500", '"about five hundred"'),
      says: [/values\.butler\.fanout\.max_effects/, /not a finite number/],
    },
    {
      why: "no values at all",
      text: GOOD.replace("values:\n  butler.fanout.max_effects: 500", "values: {}"),
      says: [/values is empty/, /establishes nothing/],
    },
  ];

  for (const { why, text, says } of rejections) {
    it(`rejects ${why}, and says how to fix it`, () => {
      let thrown: unknown;
      try {
        parseReceipt("docs/receipts/x.md", text);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ReceiptError);
      const message = (thrown as ReceiptError).message;
      expect(message).toContain("docs/receipts/x.md");
      for (const pattern of says) expect(message).toMatch(pattern);
    });
  }
});
