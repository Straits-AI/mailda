import { describe, expect, it } from "vitest";
import { plural } from "../src/index.ts";

describe("plural", () => {
  it("is the singular at exactly one and the plural at zero and at many", () => {
    expect([0, 1, 2].map((n) => `${n} ${plural(n, "person holds", "people hold")}`))
      .toEqual(["0 people hold", "1 person holds", "2 people hold"]);
  });
});
