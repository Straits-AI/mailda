import { describe, expect, it } from "vitest";

const { distance, onlyPackageJson, pendingByPhase, releaseRemote, resolvePackageJson } = await import("../../../../../packages/cli/src/upgrade-parse.mjs");

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

describe("joining a deploy-button clone to the release history", () => {
  it("allows exactly one conflicted file, and it is package.json", () => {
    expect(onlyPackageJson("package.json\n")).toBe(true);
    expect(onlyPackageJson("")).toBe(false);
    expect(onlyPackageJson("package.json\nREADME.md\n")).toBe(false);
    expect(onlyPackageJson("apps/node/worker/wrangler.jsonc\n")).toBe(false);
  });

  it("keeps the clone's name and takes upstream's everything else", () => {
    const ours = JSON.stringify({ name: "mailda-btn", scripts: { old: "x" } });
    const theirs = JSON.stringify({ name: "mailda", scripts: { build: "turbo build", upgrade: "y" }, engines: { node: ">=22" } });
    const merged = JSON.parse(resolvePackageJson(ours, theirs)) as { name: string; scripts: Record<string, string>; engines: unknown };
    expect(merged.name).toBe("mailda-btn");
    expect(Object.keys(merged.scripts).sort()).toEqual(["build", "upgrade"]);
    expect(merged.engines).toEqual({ node: ">=22" });
  });
});
