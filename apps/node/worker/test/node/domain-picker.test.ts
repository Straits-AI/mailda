import { describe, expect, it } from "vitest";

const { domainChoices } = await import("../../../../../packages/cli/src/verbs/provision.mjs");

/**
 * The domain question is a list (25 September 2026): three runs ended in "skipped" under a prompt that
 * said "Enter to skip" and needed a domain spelled into it. A zone is a row, a subdomain is typed, and
 * skipping is a named row that says what it costs, never an empty line.
 */
describe("the domain picker's rows", () => {
  it("lists every zone as its own row, then the typed subdomain, then an explicit skip", () => {
    const rows = domainChoices([{ name: "whymelabs.com" }, { name: "mailda.site" }]);
    expect(rows.map((row) => row.value)).toEqual(["whymelabs.com", "mailda.site", "typed", ""]);
    expect(rows[0]!.label).toContain("catch-all");
    expect(rows.at(-1)!.label).toContain("cannot receive");
  });

  it("offers the typed subdomain and the skip even with no zones listed", () => {
    expect(domainChoices([]).map((row) => row.value)).toEqual(["typed", ""]);
  });
});
