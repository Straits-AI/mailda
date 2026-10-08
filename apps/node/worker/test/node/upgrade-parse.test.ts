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

describe("whether an upgrade asks for a hostname of the operator's own (8 October 2026)", () => {
  it("asks while the Node is known by its workers.dev address, or not remembered, and never once it has a name of its own", async () => {
    const { asksHostname } = await import("../../../../../packages/cli/src/upgrade-parse.mjs");
    const on = (remembered: string | null) => asksHostname({ given: null, yes: false, remembered });
    expect(on("https://mailda-whymelabs.someone.workers.dev")).toBe(true);
    expect(on("https://mailda-whymelabs.someone.workers.dev/")).toBe(true);
    expect(on(null)).toBe(true);
    expect(on("https://mail.whymelabs.com")).toBe(false);
  });

  it("never asks under --yes, or when the hostname was given", async () => {
    const { asksHostname } = await import("../../../../../packages/cli/src/upgrade-parse.mjs");
    const remembered = "https://mailda.someone.workers.dev";
    expect(asksHostname({ given: null, yes: true, remembered })).toBe(false);
    expect(asksHostname({ given: "mail.whymelabs.com", yes: false, remembered })).toBe(false);
    // Given empty (`--hostname ""`) is an answer too: none.
    expect(asksHostname({ given: "", yes: false, remembered })).toBe(false);
  });
});

describe("whether an upgrade backs the Node up first (8 October 2026)", () => {
  it("backs up when a migration is pending or a backup was asked for, and not for code alone", async () => {
    const { backupWanted } = await import("../../../../../packages/cli/src/upgrade-parse.mjs");
    const none = { expand: [], contract: [] };
    expect(backupWanted(none, false)).toBe(false);
    expect(backupWanted(none, true)).toBe(true);
    expect(backupWanted({ expand: ["0078_x.sql"], contract: [] }, false)).toBe(true);
    expect(backupWanted({ expand: [], contract: ["0079_y.sql"] }, false)).toBe(true);
  });
});

describe("an upgrade asks Cloudflare which hostname the Worker has (8 October 2026)", () => {
  it("does not ask for one when Cloudflare lists one, whatever this clone remembers; asks as before when it lists none or cannot say", async () => {
    const { asksHostname } = await import("../../../../../packages/cli/src/upgrade-parse.mjs");
    const remembered = "https://mailda-whymelabs.someone.workers.dev";
    expect(asksHostname({ given: null, yes: false, remembered, attached: ["mail.whymelabs.com"] })).toBe(false);
    expect(asksHostname({ given: null, yes: false, remembered, attached: [] })).toBe(true);
    expect(asksHostname({ given: null, yes: false, remembered, attached: null })).toBe(true);
  });

  it("reads the Worker's own custom domains, and says it could not when Cloudflare does not answer", async () => {
    const { attachedHostnames } = await import(`${import.meta.dirname}/../../../../../packages/cli/src/verbs/provision.mjs`) as {
      attachedHostnames: (a: string, t: string, w: string, f: typeof fetch) => Promise<string[] | null>;
    };
    const asked: string[] = [];
    const answer = (body: unknown, status = 200) => (async (url: string) => { asked.push(url); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
    expect(await attachedHostnames("acc", "tok", "mailda-x", answer({ success: true, result: [
      { hostname: "mail.example.com", service: "mailda-x" }, { hostname: "other.example.com", service: "another-worker" },
    ] }))).toEqual(["mail.example.com"]);
    expect(asked[0]).toBe("https://api.cloudflare.com/client/v4/accounts/acc/workers/domains?service=mailda-x");
    expect(await attachedHostnames("acc", "tok", "mailda-x", answer({ success: false, errors: [] }, 403))).toBeNull();
  });
});
