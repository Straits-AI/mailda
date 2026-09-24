import { describe, expect, it } from "vitest";

const { distance, pendingByPhase, releaseRemote } = await import("../../../../../packages/cli/src/upgrade-parse.mjs");

/**
 * `mailda upgrade` decides three things from text before it touches anything: which remote carries
 * releases, whether the clone is behind it, and what the pending migrations will do to the catalog.
 */
describe("what mailda upgrade reads before acting", () => {
  it("finds the release remote by URL, not by the name origin", () => {
    const fork = "origin\thttps://github.com/someone/mailda.git (fetch)\norigin\thttps://github.com/someone/mailda.git (push)\n"
      + "upstream\thttps://github.com/Straits-AI/mailda.git (fetch)\nupstream\thttps://github.com/Straits-AI/mailda.git (push)\n";
    expect(releaseRemote(fork)).toBe("upstream");
    expect(releaseRemote("origin\tgit@github.com:Straits-AI/mailda.git (fetch)\n")).toBe("origin");
    // A deploy-button clone: no remote at all.
    expect(releaseRemote("")).toBeNull();
    // Fetching from a fork and pushing to us is not a release remote; only the fetch URL is where code comes from.
    expect(releaseRemote("origin\thttps://github.com/someone/mailda.git (fetch)\norigin\thttps://github.com/Straits-AI/mailda.git (push)\n")).toBeNull();
  });

  it("reads ahead and behind from rev-list's two counts, and nothing from anything else", () => {
    expect(distance("0\t3\n")).toEqual({ ahead: 0, behind: 3 });
    expect(distance("2\t0\n")).toEqual({ ahead: 2, behind: 0 });
    // Unrelated histories make rev-list fail and print an error, which must not read as "current".
    expect(distance("fatal: no merge base")).toBeNull();
  });

  it("puts every pending migration in exactly one phase, and only pending ones", () => {
    const listed = "┌ 0066_widen.sql │\n│ 0067_drop_old.sql │\n";
    const phases = pendingByPhase(listed, ["0001_init.sql", "0066_widen.sql", "0067_drop_old.sql"], ["0067_drop_old.sql"]);
    expect(phases).toEqual({ expand: ["0066_widen.sql"], contract: ["0067_drop_old.sql"] });
  });
});
