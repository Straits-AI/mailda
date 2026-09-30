/**
 * wrangler's own JSON answers about its login: who is signed in (`wrangler whoami --json`), and the token
 * `mailda install` reuses (`wrangler auth token --json`), both since 30 September 2026.
 *
 * `wrangler login` is the one consent every install already has, and its token reaches every Cloudflare
 * endpoint the Node's provisioning uses except raw DNS and the registrar (`docs/receipts/wrangler-login-reach.md`).
 * The CLI used to read it out of the config file wrangler writes, after running `wrangler whoami` for its refresh, on the belief
 * that wrangler printed it nowhere. `wrangler auth token` has printed it since 4.57.0, refreshing an expired one
 * and reading through wrangler's own credential store, so a login kept in the OS keychain (`wrangler auth
 * keyring enable`) or under a profile is found too, which the file read could not. Pure here;
 * `verbs/provision.mjs` runs the command, quietly, because its answer is a credential.
 */

const ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * The last `count` lines wrangler wrote to stderr, as its reason for a failure: colour removed, blank lines and
 * npm's own `npm notice` / `npm warn` lines dropped. `npx` appends its update notice after wrangler exits, so an
 * operator whose npm is behind was told "wrangler said: npm notice" (measured 30 September 2026, npm 11.12.1),
 * and wrangler colours its `✘ [ERROR]` line on a pipe whatever `FORCE_COLOR` says. An `npm error` line stays: a
 * `npx` that could not start wrangler at all has nothing else to say.
 */
export function wranglerSaid(stderr, count) {
  return String(stderr).replace(ESCAPE, "").split("\n").map((line) => line.trim())
    .filter((line) => line !== "" && !/^npm (notice|warn)\b/.test(line)).slice(-count);
}

/**
 * The token, or why there is none, from `wrangler auth token --json`'s stdout and exit status.
 *
 * wrangler 4.118.0 answers one of three shapes: `{type: "oauth", token}` for a login, `{type: "api_token",
 * token}` for `CLOUDFLARE_API_TOKEN` (returned as set), and `{type: "api_key", key, email}` for
 * `CLOUDFLARE_API_KEY` with `CLOUDFLARE_EMAIL`. The last is refused rather than read: the Node sends the token
 * it is given as a Bearer, and a Global API Key is not one. Not signed in is exit 1 with nothing on stdout.
 *
 * `error` never quotes stdout: on success stdout is the credential. It quotes the last line of stderr on a failure,
 * which wrangler's `--json` path never writes the credential to.
 */
export function tokenFrom(stdout, status, stderr = "") {
  if (status !== 0) {
    // Its own words, because a corrupt config or a keyring error exits the same as no login (measured, 4.118.0).
    const said = wranglerSaid(stderr, 1)[0];
    return {
      token: null,
      error: `\`wrangler auth token\` exited ${status} and gave no token; ${said === undefined ? "it said nothing on stderr" : `wrangler said: ${said}`}`,
    };
  }
  let answer;
  try {
    answer = JSON.parse(stdout);
  } catch {
    answer = null; // said below, without quoting what may be a credential
  }
  if (answer?.type === "api_key") {
    return {
      token: null,
      error: "wrangler is using CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL, a Global API Key, and the Node takes a "
        + "Bearer token; set CLOUDFLARE_API_TOKEN instead",
    };
  }
  if ((answer?.type === "oauth" || answer?.type === "api_token") && typeof answer.token === "string" && answer.token !== "") {
    return { token: answer.token, error: null };
  }
  return {
    token: null,
    error: `\`wrangler auth token --json\` answered in a shape this CLI does not read (type ${JSON.stringify(answer?.type ?? null)})`,
  };
}

/**
 * Who wrangler says is signed in, from `wrangler whoami --json` (30 September 2026).
 *
 * `signed_in` with `authType` and `accounts: [{name, id}]`; `signed_out`; or `unreadable` with what wrangler
 * said. They are three, not two, because they send an operator to different places: `wrangler login` for the
 * second, and the message itself for the third (a token that cannot list accounts, a network failure).
 *
 * wrangler 4.118.0 prints `{"loggedIn":false}` on stdout and exits 1 when nobody is signed in, and
 * `{loggedIn: true, authType, email, accounts, tokenPermissions}` otherwise, with `accounts` as the API's
 * account objects. Under `CLOUDFLARE_API_TOKEN` `authType` is `User API Token` or `Account API Token` and
 * `tokenPermissions` is undefined, since it is the scope list stored with an OAuth login, so nothing here reads
 * it. This replaced reading the box-drawn account table and a prose regex, written when wrangler had no
 * structured answer; it has had one since 4.65.0 (`docs/receipts/wrangler-json-output.md`).
 */
export function whoamiFrom(stdout, status, stderr = "") {
  let answer;
  try {
    answer = JSON.parse(stdout);
  } catch {
    answer = null; // not JSON: said below as unreadable, with the text
  }
  if (answer?.loggedIn === false) return { state: "signed_out" };
  if (status !== 0 || answer?.loggedIn !== true || !Array.isArray(answer.accounts)) {
    const said = `${wranglerSaid(stderr, 3).join(" ")} ${String(stdout).trim().slice(0, 300)}`.trim();
    return { state: "unreadable", detail: `exit ${status}: ${said || "nothing said"}` };
  }
  const accounts = answer.accounts
    .filter((one) => typeof one?.id === "string" && /^[0-9a-f]{32}$/i.test(one.id))
    .map((one) => ({ name: typeof one.name === "string" && one.name !== "" ? one.name : "(unnamed)", id: one.id }));
  return { state: "signed_in", authType: String(answer.authType ?? "unknown"), accounts };
}
