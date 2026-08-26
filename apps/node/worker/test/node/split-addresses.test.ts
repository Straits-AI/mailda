import { describe, expect, it } from "vitest";

import { splitAddresses } from "../../src/client/app/screens/split-addresses.ts";

/**
 * The whole bug was in the punctuation, so the cases are literals from the
 * ticket (issue #100) rather than generated strings. The old
 * `value.split(/[,;]+/)` turned the first one into two invalid recipients and
 * sealed the corruption into an immutable manifest.
 */
describe("splitAddresses", () => {
  it("keeps a quoted display name containing a comma as one recipient", () => {
    expect(splitAddresses('"Doe, Jane" <jane@example.com>')).toEqual([
      '"Doe, Jane" <jane@example.com>',
    ]);
  });

  it("splits plain comma-separated addresses", () => {
    expect(splitAddresses("a@x.test, b@y.test")).toEqual(["a@x.test", "b@y.test"]);
  });

  it("keeps escaped quotes inside a quoted string intact", () => {
    expect(splitAddresses('"Say \\"hi\\"" <c@z.test>')).toEqual([
      '"Say \\"hi\\"" <c@z.test>',
    ]);
  });

  it("treats a parenthesized comment as part of one recipient", () => {
    expect(splitAddresses("Jane Doe (Support) <jane@example.com>")).toEqual([
      "Jane Doe (Support) <jane@example.com>",
    ]);
  });

  it("handles trailing separators and whitespace unchanged", () => {
    expect(splitAddresses("  a@x.test , ; b@y.test;  ")).toEqual(["a@x.test", "b@y.test"]);
  });

  it("splits on semicolons too", () => {
    expect(splitAddresses("a@x.test; b@y.test")).toEqual(["a@x.test", "b@y.test"]);
  });

  it("returns an empty list for empty input", () => {
    expect(splitAddresses("")).toEqual([]);
    expect(splitAddresses("   ")).toEqual([]);
    expect(splitAddresses(" , ; ")).toEqual([]);
  });

  it("handles a quoted name with a comma plus a following plain address", () => {
    expect(splitAddresses('"Doe, Jane" <jane@example.com>, a@x.test')).toEqual([
      '"Doe, Jane" <jane@example.com>',
      "a@x.test",
    ]);
  });

  it("does not split inside an angle-addr", () => {
    expect(splitAddresses("<jane@example.com>")).toEqual(["<jane@example.com>"]);
  });

  it("handles nested comments without losing the separator balance", () => {
    expect(splitAddresses("Jane (Support (weekends)) <jane@example.com>")).toEqual([
      "Jane (Support (weekends)) <jane@example.com>",
    ]);
  });

  it("keeps its balance at any nesting depth, because there is no ceiling to desynchronise", () => {
    /*
     * The shipped version capped nesting at `MAX_COMMENT_DEPTH = 8` — **guarding the increment and not the
     * decrement**, so past eight the counter stopped describing reality. Nine `(` followed by eight `)` left
     * it reading zero while one comment was still open, and the next comma split an address in half.
     *
     * The contrast is what makes it a defect rather than a limit: at eight deep the comma stayed inside the
     * comment, and at nine — the same input, one paren different — it did not. A ceiling that changes the
     * answer instead of refusing is the "silent budget" AGENTS.md rules out, and since nothing needed the
     * ceiling the fix was to delete the number rather than find a receipt for it.
     *
     * **The shape matters and the first version of this test got it wrong.** Fully balanced nesting does not
     * expose the cap: the separator sits inside the innermost comment and is absorbed before any `)` is
     * reached, so the counter's ceiling never affects it and the mutation survived. What exposes it is a
     * separator reached *after* enough closes to drive the capped counter to zero while a comment is still
     * open — which is what `((((((((()))))))), x)` is, and it is legitimate input: nine opens, nine closes,
     * one comma inside the outermost comment.
     *
     * Written as a loop past the old bound so a reintroduced cap fails here at whatever value it picks.
     */
    for (const depth of [8, 9, 12, 40]) {
      // Deep, then all but one close, then a comma still inside the outermost comment, then its close.
      const nested = "(".repeat(depth) + ")".repeat(depth - 1) + ", note)";
      expect(
        splitAddresses(`Jane ${nested} <jane@example.com>`),
        `depth ${depth} split a comment in half`,
      ).toEqual([`Jane ${nested} <jane@example.com>`]);
    }
  });

  it("still separates the recipients after a deeply nested comment closes", () => {
    // The other direction: a comment that genuinely ends must stop absorbing separators, or the fix above
    // would be "never split again" wearing the right answer's clothes.
    const nested = "(".repeat(9) + " note " + ")".repeat(9);
    expect(splitAddresses(`Jane ${nested} <jane@example.com>, bob@example.com`)).toEqual([
      `Jane ${nested} <jane@example.com>`,
      "bob@example.com",
    ]);
  });
});
