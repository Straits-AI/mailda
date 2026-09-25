import { join } from "node:path";

/**
 * Where wrangler keeps the login token `mailda install` reuses, and how to read it (25 September 2026).
 *
 * `wrangler login` is the one consent every install already has, and its token reaches every Cloudflare
 * endpoint the Node's provisioning uses except raw DNS and the registrar (`docs/receipts/wrangler-login-reach.md`).
 * wrangler offers no command that prints the token, so the CLI reads the file wrangler writes, after
 * `wrangler whoami` has refreshed it. Pure here; `verbs/provision.mjs` does the reading.
 */

/** The oauth_token and expiration_time lines of wrangler's token file, or null when there is no token. */
export function tokenFromWranglerConfig(toml) {
  const token = /^\s*oauth_token\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  if (token === null) return null;
  const expiresAt = /^\s*expiration_time\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  return { token, expiresAt };
}

/**
 * Every place wrangler may keep its token file, most specific first: an explicit `WRANGLER_HOME`, then the
 * XDG config dir, then the per-platform default (`~/.config` on Linux, `~/Library/Preferences` on macOS,
 * `%APPDATA%/xdg.config` on Windows), then the legacy `~/.wrangler`.
 */
export function wranglerConfigPaths(env, platform, home) {
  const tail = ["config", "default.toml"];
  const paths = [];
  if (env.WRANGLER_HOME) paths.push(join(env.WRANGLER_HOME, ...tail));
  if (env.XDG_CONFIG_HOME) paths.push(join(env.XDG_CONFIG_HOME, ".wrangler", ...tail));
  paths.push(join(home, ".config", ".wrangler", ...tail));
  if (platform === "darwin") paths.push(join(home, "Library", "Preferences", ".wrangler", ...tail));
  if (platform === "win32" && env.APPDATA) paths.push(join(env.APPDATA, "xdg.config", ".wrangler", ...tail));
  paths.push(join(home, ".wrangler", ...tail));
  return paths;
}
