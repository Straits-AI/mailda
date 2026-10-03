import { describe, expect, it } from "vitest";

const { keptForwardLines } = await import("../../../../../packages/cli/src/verbs/provision.mjs");

/** `mailda provider --forwards`' lines for copies (ADR 47, amended 3 October 2026). */
const row = (last: unknown, copy: unknown = null) => ({
  address: "hello@acme.test", mailboxId: "mbx_1", to: "me@gmail.test", verified: "absent" as const, checkedAt: null,
  last: last as never, lastHandedOverAt: null, copy: copy as never,
});
const refused = (copy: unknown) => ({ state: "refused", at: "2026-10-03T01:00:00.000Z", error: "destination address not verified", copy });

describe("the forward lines, with copies", () => {
  it("says copies are off, and nothing about a copy when none was asked for", () => {
    const lines = keptForwardLines(row(refused(null)));
    expect(lines.at(-1)).toBe("  copies off");
    expect(lines.join("\n")).not.toContain("a copy was sealed");
  });

  it("names the sealed copy's send and its state, and who turned copies on", () => {
    const lines = keptForwardLines(row(
      refused({ state: "sealed", at: "2026-10-03T01:00:01.000Z", error: null, sendId: "snd_X", sendState: "handed_over" }),
      { by: "usr_admin", at: "2026-10-02T00:00:00.000Z" },
    )).join("\n");
    expect(lines).toContain("a copy was sealed as snd_X, handed over");
    expect(lines).toContain("copies on, by usr_admin at 2026-10-02T00:00:00.000Z");
  });

  it("prints why no copy was sealed", () => {
    const lines = keptForwardLines(row(refused({ state: "refused", at: null, error: "the message is quarantined", sendId: null, sendState: null })));
    expect(lines.join("\n")).toContain("  the message is quarantined");
  });

  it("reads an older Node, which sends neither copy field, as copies off", () => {
    const { copy: _gone, ...older } = row({ state: "handed_over", at: "2026-10-03T01:00:00.000Z", error: null });
    expect(keptForwardLines(older as never).at(-1)).toBe("  copies off");
  });
});
