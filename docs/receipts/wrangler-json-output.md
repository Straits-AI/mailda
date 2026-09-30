---
id: wrangler-json-output
kind: platform-limit
measured_on: 2026-09-30
stale_when: >
  wrangler's `whoami --json` stops printing `{"loggedIn":false}` with a non-zero exit when signed out, or
  changes its `accounts` shape; `auth token --json` changes its `type` values or stops returning
  CLOUDFLARE_API_TOKEN as set; `deployments status --json` stops printing the API's deployment with
  `versions: [{version_id, percentage}]`; the output file's `version-upload`, `deploy` or `version-deploy`
  entries lose `version_id`, `targets` or `deployment_id`; `version_traffic` starts serialising (it is `{}`
  on 4.118.0); `auth token` stops honouring `WRANGLER_WRITE_LOGS=false` or `WRANGLER_LOG_PATH`, or its answer
  reaches a debug log by another path; `FORCE_COLOR=0` or `WRANGLER_LOG=log` stop giving plain JSON on stdout; `npx` stops putting its
  `npm notice` lines after wrangler's stderr, or npm renames them; or
  Mailda's locked wrangler moves off 4.118.0
values:
  wrangler.json_output_min_version: 4.65
---

# The wrangler that answers in JSON, and the earliest one that does

**Why this exists.** The CLI read wrangler's tables and prose: the account table out of `whoami`, a
sign-in sentence, the first UUID anywhere in `versions upload`'s output, the last `(N%)` line of
`deployments list`, a workers.dev URL out of `deploy`'s log, and the login token out of wrangler's config file. The
comments beside those reads said wrangler offered nothing structured. That was true of older wrangler and
is false of the one `pnpm-lock.yaml` pins. On 30 September 2026 the CLI moved to:

| read | replaces |
|:--|:--|
| `wrangler whoami --json` | the account table and the sign-in sentence (`preflight.mjs`) |
| `wrangler auth token --json` | `whoami` for its refresh, then a regex over wrangler's config file (`wrangler-config.mjs`) |
| `wrangler deployments status --json` | the last `(N%)` line of `deployments list` |
| `WRANGLER_OUTPUT_FILE_PATH` entries `version-upload`, `deploy`, `version-deploy` | the first UUID in the upload's output, and the workers.dev URL regex |
| `wrangler --version` | the version out of `whoami`'s banner, which `--json` leaves out |

**Measured.** Two ways, both 30 September 2026, nothing signed in and no account touched.

1. The locked **4.118.0**, run in an isolated `HOME`:
   - `whoami --json` signed out: stdout `{"loggedIn":false}`, **exit 1**.
   - `auth token --json` signed out: stdout empty, exit 1, `Not logged in` on stderr.
   - `auth token --json` with `CLOUDFLARE_API_TOKEN` set to a made-up value: exit 0,
     `{"type": "api_token", "token": <the value as set>}`. With `CLOUDFLARE_API_KEY` and `CLOUDFLARE_EMAIL` set
     beside it, the answer is the `api_key` one below: wrangler's `getAuthFromEnv` takes the Global API Key
     first, so the CLI asks wrangler rather than reading `CLOUDFLARE_API_TOKEN` itself.
   - With `CLOUDFLARE_API_KEY` and `CLOUDFLARE_EMAIL`: exit 0, `{"type": "api_key", "key", "email"}`, no
     `token`. The CLI refuses that one: the Node takes a Bearer token.
   - `wrangler --version` prints `4.118.0` alone.
   - Read from its bundled source (the package's `wrangler-dist` build): signed in, `whoami --json` prints `{loggedIn, authType, email,
     accounts, tokenPermissions}`, `accounts` being the API's account objects and `tokenPermissions` the
     scope list stored with an OAuth login (undefined under an API token). `auth token` refreshes an expired
     login through the credential store, so a keychain or profile login is read too. `deployments status
     --json` prints the latest deployment as the API returns it. `writeOutput` appends one JSON line per
     entry. `version-deploy`'s `version_traffic` is a `Map` passed to `JSON.stringify`, so it is written as
     `{}`, and the CLI reads only `deployment_id` from that entry.
2. **The earliest version**, from the package tarballs (`npm pack wrangler@4.64.0` and `@4.65.0`, unpacked,
   not installed) and wrangler's own changelog:
   - `auth token --json` first appears in **4.57.0** (changelog, #11682); present in 4.64.0's bundled source.
   - `whoami --json` first appears in **4.65.0** (changelog, #12515): 4.64.0's bundled source has no `Return user
     information as JSON` and no `loggedIn: false`; 4.65.0's has both.
   - 4.65.0's bundled source writes `version-upload` with `version_id`, `deploy` with `version_id` and `targets`,
     `version-deploy` with `deployment_id`, and prints `deployments status --json` as the raw deployment.

3. **What `auth token --json` leaves on disk**, measured the same day with a made-up OAuth token in an
   isolated `HOME` (and the version from `wrangler --version`), nothing signed in:
   - wrangler prints the answer through its logger, and `Logger.doLog` appends every message to a debug log
     under its config directory (`.wrangler/logs/wrangler-<date>.log`) before it checks the log level, whenever
     `shouldLogToDisk()` holds; old files are deleted after 30 days. Run plainly, **4.118.0 and 4.90.1 both
     wrote the token into that file**, at the default umask (0664 in the verifier's run).
   - `WRANGLER_WRITE_LOGS=false` stops the write on 4.118.0; **4.90.1 ignores it** (the variable arrived in
     4.91.0, changelog #13750). `WRANGLER_LOG_PATH=<directory>`, which wrangler has read since 3.17.0
     (changelog #4341), moved the file into that directory on both.
   - So `wranglerTokenRead` sets both, the directory a private temporary one removed as soon as wrangler
     exits: nothing is left on either side of 4.91.0, and it holds for the token read that runs before any
     preflight has checked the version (the install's hostname question, `mailda setup`).
   - `WRANGLER_LOG` below `log` leaves `auth token --json` exit 0 with nothing on stdout, and `debug` puts its
     own lines ahead of `whoami --json`'s JSON; `FORCE_COLOR` colours piped output (`workflows describe`'s
     labels, the list's borders). Every call whose answer the CLI reads is started with `WRANGLER_LOG=log` and
     `FORCE_COLOR=0` (`captured` in `support.mjs`); the debug log still takes every level. Measured on 4.118.0:
     `workflows describe x --help` piped carries 3 escape sequences under `FORCE_COLOR=1`, and none under
     `FORCE_COLOR=0` or with it unset.
   - stderr, which the CLI quotes as "wrangler said" when a call fails, is not that clean (30 September 2026,
     4.118.0 under `npx` with npm 11.12.1, isolated HOME): wrangler's `✘ [ERROR]` line carries colour escapes on a
     pipe even under `FORCE_COLOR=0`, and `npx` appends npm's update notice (`npm notice ...`, five lines) after
     wrangler exits, so the last line was "npm notice". `wranglerSaid` in `wrangler-config.mjs` strips the escapes
     and drops `npm notice` / `npm warn` lines before quoting.

**Sized.** `wrangler.json_output_min_version = 4.65`: the first release with every read above. It sits below
`workflow.schedules_min_wrangler` (4.97, `workflow-provisioning.md`), so today it binds nothing the other
floor does not; it is its own value because it is a different fact, and naming one floor for the other's
reason would overclaim. Preflight checks both and reports each with its reason.

Two releases between the floor and the lock change what the JSON says without changing its shape, and the
CLI is correct on either side of them: 4.82.0 moved the `HTTP_PROXY` notice from stdout to stderr (before
it, `auth token --json` behind a proxy is not JSON, which the CLI reports as an unreadable answer rather than
misreading), and 4.89.0 lists the intersection of `/accounts` and `/memberships` in `whoami`'s `accounts`.

**A caution on the value's form.** Budgets are numbers, so a version is written as `major.minor`, and
`atLeast` reads `4.65` as `[4, 65]`. A minor ending in zero would not survive: `4.120` is the number `4.12`.
Remeasuring to such a version needs the value's form changed first.

**Cost if wrong.** Too low, and an older wrangler answers `whoami --json` with its banner and table: preflight
reports "wrangler could not say who is signed in" instead of the floor, which is the right refusal with the
wrong reason. Too high refuses a wrangler that would have worked.

**Not measured.** Any signed-in run of these commands: the logged-in shapes are read from source. The Deploy
button's path (Workers Builds, `CLOUDFLARE_API_TOKEN` set, no login) was not exercised; from source, `whoami
--json` answers for the token with the accounts it may list, and `auth token --json` returns it as set.
