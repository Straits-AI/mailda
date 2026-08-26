import { describe, expect, it } from "vitest";

import { splitAddresses } from "../../src/client/app/screens/split-addresses.js";

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
});
