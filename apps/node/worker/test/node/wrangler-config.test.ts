import { describe, expect, it } from "vitest";

const { tokenFromWranglerConfig, wranglerConfigPaths } = await import("../../../../../packages/cli/src/wrangler-config.mjs");

/**
 * `mailda install` reuses wrangler's login token for the account work (25 September 2026), read from the
 * file wrangler writes. What would be wrong and still look right: a token read from a commented-out or
 * partial line, or a path list that skips the one platform the operator is on.
 */
describe("reading wrangler's token file", () => {
  it("reads the token and its expiry, and nothing from a file without one", () => {
    const toml = 'oauth_token = "tok-abc"\nexpiration_time = "2026-09-25T10:15:02.525Z"\nrefresh_token = "r"\nscopes = [ "user:read" ]\n';
    expect(tokenFromWranglerConfig(toml)).toEqual({ token: "tok-abc", expiresAt: "2026-09-25T10:15:02.525Z" });
    expect(tokenFromWranglerConfig('api_token = "x"\n')).toBeNull();
    expect(tokenFromWranglerConfig("")).toBeNull();
  });

  it("puts an explicit WRANGLER_HOME first and the legacy ~/.wrangler last, with the platform's own dir between", () => {
    const linux = wranglerConfigPaths({}, "linux", "/home/u");
    expect(linux[0]).toBe("/home/u/.config/.wrangler/config/default.toml");
    expect(linux.at(-1)).toBe("/home/u/.wrangler/config/default.toml");
    expect(linux).not.toContain("/home/u/Library/Preferences/.wrangler/config/default.toml");

    const mac = wranglerConfigPaths({}, "darwin", "/Users/u");
    expect(mac).toContain("/Users/u/Library/Preferences/.wrangler/config/default.toml");

    const explicit = wranglerConfigPaths({ WRANGLER_HOME: "/w", XDG_CONFIG_HOME: "/x" }, "linux", "/home/u");
    expect(explicit.slice(0, 2)).toEqual(["/w/config/default.toml", "/x/.wrangler/config/default.toml"]);
  });
});
