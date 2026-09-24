import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { accountsFrom, atLeast, reportsItsVersion, resolveAccount, signedIn, urlRequirement, wranglerVersionFrom } from "./preflight.mjs";
import { BUDGETS } from "@mailda/budgets";
import { path as fillPath, route } from "@mailda/contract/routes";
import { deriveConfig, workerNameIn } from "./deploy-parse.mjs";
export const here = dirname(fileURLToPath(import.meta.url));

/**
 * A route's path from the registry, never a string written here (ADR 12: every channel from one contract).
 * `route` throws on a template this Node does not serve, so a verb naming a moved route fails at the call
 * with the route's name rather than reaching the Worker and being answered with the interface shell.
 * `query` is appended as a query string; a route's own parameters are filled by name.
 */
export function api(method, template, query = {}, params = {}) {
  const filled = fillPath(route(method, template), params);
  const search = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null),
  );
  return search.size === 0 ? filled : `${filled}?${search}`;
}

export const workerDir = resolve(here, "../../../apps/node/worker");


export function fail(message) {
  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
}


/**
 * Runs a command and **captures** its output, for the one step that has to read wrangler's answer.
 *
 * `run` below keeps the operator's terminal attached, which is right for everything an operator watches. The
 * canary upload is different: its version id is the thing the next two steps act on, so it has to be parsed.
 * The output is echoed as well, because a step whose output vanishes is a step nobody can debug.
 */
export function capture(command, args, { cwd = workerDir, quiet = false } = {}) {
  const outcome = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (outcome.error !== undefined) fail(`could not run ${command}: ${outcome.error.message}`);
  const text = `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`;
  /*
   * `quiet` exists for preflight, which asks `wrangler whoami` a question and then answers it in its own
   * words. Echoing the raw account table above a summary of that same table is noise an operator has to read
   * twice — and the deploy steps below still echo, because a step whose output vanishes is a step nobody can
   * debug. Nothing that *acts* is quiet; only the one call that is purely a question.
   */
  if (!quiet) process.stdout.write(text);
  return { status: outcome.status ?? 1, text };
}


/** Runs a command with the operator's terminal attached, so wrangler's prompts and output are theirs. */
export function run(command, args, { cwd = workerDir } = {}) {
  const outcome = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (outcome.error !== undefined) fail(`could not run ${command}: ${outcome.error.message}`);
  return outcome.status ?? 1;
}


/** Greedy wrap, so a reason prints as prose rather than as one line the terminal breaks arbitrarily. */
export function wrapAt(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line !== "") lines.push(line);
  return lines;
}


export function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1] ?? null;
}


/**
 * A session cookie, or `null` if none could be had (#98, #92).
 *
 * ## Why this exists, measured rather than supposed
 *
 * The canary check was anonymous, and the 31 August drill measured what that cost: the Node served **9
 * findings of 21**, because `withoutDataFindings` withholds everything classified as describing the
 * organization's mail from a caller who is not an administrator. So the differential gate compared 9, and a
 * regression confined to one of the withheld 12 would not have blocked a promotion.
 *
 * ## Why signing in reaches the canary at all
 *
 * A session is signed by the Node's own key, and that key lives in D1 and the vault — **state, not code**. Two
 * versions of the Worker share it. So a cookie obtained from the incumbent is honoured by the canary, and
 * sending it *with* the override header reaches the new version authenticated. Nothing about it is
 * version-specific, which is what makes this possible at all.
 *
 * ## Four callers, and only one treats absence as acceptable
 *
 * The deploy falls back to an anonymous canary check, because a Node that cannot be deployed to because its
 * credentials are wrong is a worse failure than a narrower gate. `backup`, `verify-evidence` and
 * `recovery-codes` cannot fall back at all — their routes are administrator-only — so each checks for `null`
 * and refuses. The decision is the caller's, which is why this returns rather than exits.
 *
 * ## Optional for the deploy, and honest about the cost when it is absent
 *
 * No credentials means the anonymous check, which is weaker rather than broken — it still carries every
 * `infrastructure` finding: the bindings, the schema, the vault. The deploy says which of the two it did, so
 * "the gate passed" always comes with how much the gate could see.
 *
 * An **ordinary member's** credentials buy nothing here: the full report needs `org.admin`, and anything less
 * is reduced with a different reason and the same 9 findings. Said plainly, because supplying a non-admin
 * account and believing the check widened is worse than knowing it did not.
 */
export async function sessionCookie(origin) {
  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email === undefined || password === undefined) return null;

  /*
   * **Retried, and only for a failure worth retrying** (#148).
   *
   * A backup that fails on a blip is a backup that does not happen: this runs unattended on a schedule, and
   * the failure is silent from the operator's side — the command exits, nothing is written, and the next
   * thing anybody learns is that the newest artifact is a week old. Measured during #92's drill, where a
   * single `500` aborted the whole backup and the identical command succeeded seconds later against a
   * healthy Node.
   *
   * A `401` is **not** retried. Wrong credentials will be wrong on the fourth attempt too, so retrying turns
   * a clear refusal into a slow one — and repeated failed logins against a Node that records login attempts
   * is a shape nobody wants a scheduled job producing.
   *
   * Three attempts and a short linear backoff, because the failure this is for is a cold start or a D1
   * hiccup. A longer schedule would be a Node that is down, and waiting minutes to discover it is worse than
   * failing and being re-run.
   */
  let signIn = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((settle) => setTimeout(settle, attempt * 500));
    signIn = await fetch(`${origin}${api("POST", "/api/auth/login")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }).catch(() => null);
    if (signIn !== null && signIn.ok) break;
    // Understood and refused: the answer will not change. Anything else — unreachable, 5xx — may.
    if (signIn !== null && signIn.status === 401) break;
  }
  if (signIn === null || !signIn.ok) {
    /*
     * Not fatal. A failed sign-in falls back to the anonymous check rather than stopping a deploy — the
     * alternative is a Node that cannot be deployed to because its credentials are wrong, which is a worse
     * failure than a narrower gate. It says so, because a silent downgrade is the thing this file keeps
     * removing.
     */
    process.stdout.write(
      `   note: sign-in failed (${signIn === null ? "unreachable" : signIn.status}), so the canary is checked\n`
      + "         anonymously and the gate compares only the findings an anonymous caller may see.\n",
    );
    return null;
  }
  const cookies = signIn.headers.getSetCookie?.() ?? [];
  if (cookies.length === 0) return null;
  return cookies.map((line) => line.split(";")[0]).join("; ");
}


/**
 * The canary's whole report, without exiting the process.
 *
 * `doctor` above ends in `process.exit`, which is right for a command somebody runs and wrong for a gate in
 * the middle of a sequence — exiting there would leave a canary uploaded, unpromoted and unexplained. This
 * asks the same route and hands the report back, so the caller decides what a `degraded` means.
 *
 * **The whole report rather than the verdict**, which used to be all this returned. The canary is now reached
 * by overriding to it on the production hostname, and Cloudflare falls back to the traffic percentages when
 * an override cannot be applied — so `verdict` alone cannot distinguish "the canary is healthy" from "the
 * version already serving is healthy". The caller compares `version` against the id it uploaded.
 *
 * Deliberately **unauthenticated**, and the 31 August drill measured what that costs. The reduced report
 * (`withoutDataFindings`) carries every `infrastructure` finding — the bindings, the schema, the vault — which
 * is most of what a fresh version can get wrong. On the drilled Node it was **9 findings of 21**: the other 12
 * describe the organization's mail and are withheld from an anonymous caller.
 *
 * So the differential gate below compares 9 findings, not 21, and a regression confined to a data-disclosing
 * finding is invisible to it. Written here rather than left for somebody to infer from a passing deploy.
 *
 * It is fixable and deliberately not fixed yet: sessions are signed by the Node's own key and that state is
 * shared across versions, so signing in normally and then sending the session cookie **with** the override
 * header would reach the canary authenticated and compare all 21. That needs credentials in the deploy path,
 * which is a decision about what `mailda deploy` may hold rather than a line of code.
 */
export async function doctorReport(origin, extraHeaders = {}, subject = "the Node") {
  /*
   * `subject` exists because this helper's refusals used to be written for its first caller only. Four
   * commands share it now, and `mailda verify-evidence` against a claimed Node answered:
   *
   *     the canary answered 401 at /api/doctor
   *     fix  the previous version is still serving; nothing was promoted
   *
   * — three sentences about a deploy, from a command that deploys nothing. A message that names the wrong
   * act sends its reader to the wrong place, which costs more than saying nothing.
   */
  const response = await fetch(`${origin.replace(/\/$/, "")}${api("GET", "/api/doctor")}`, {
    headers: { accept: "application/json", ...extraHeaders },
  }).catch((error) => fail(`could not reach ${subject} at ${origin}: ${error.message}`));
  const text = await response.text();
  if (!response.ok && response.status !== 503) {
    fail(
      `${subject} answered ${response.status} at /api/doctor\n${text.slice(0, 400)}\n\n`
      + `  why      an unreachable or unreadable report is not something to act on\n`
      + `  fix      ${response.status === 401
        ? "sign in — set MAILDA_EMAIL and MAILDA_PASSWORD. A claimed Node gates its report."
        : "read the body above; nothing was changed"}`,
    );
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    fail(`${subject}'s report was not JSON:\n${text.slice(0, 400)}`);
  }
  for (const finding of report.findings ?? []) {
    if (!finding.ok) process.stdout.write(`   ${finding.severity}  ${finding.check}  ${finding.detail}\n`);
  }
  return report;
}


/**
 * `--env=""`, on every wrangler call that takes it.
 *
 * `wrangler.jsonc` declares a named environment for the test suite — named environments do not inherit
 * bindings, so it duplicates the top level deliberately. With more than one environment defined and none
 * named, wrangler warns and picks the top level; the warning exists because picking is a guess. An empty
 * string names the top level explicitly, so `mailda deploy` can never act on the test environment because
 * somebody's shell had `CLOUDFLARE_ENV` set.
 */
export const ENV = ["--env", ""];

/**
 * A second Node in the same account is `mailda deploy --name <worker>` (#99's other half).
 *
 * `wrangler.jsonc` carries the Worker's name in **three** places that must agree: `name`, the Workflow's
 * `name` (`<worker>-butler-runs`, the rule `workflow-name-world.test.ts` holds) and `vars.WORKER_NAME` (what
 * the Node calls itself when it writes a routing rule). Every other resource derives its name from the
 * Worker's — measured in `deploy-drill-live-account.md` — so those three are the whole of what a second Node
 * is. The third restore drill edited them by hand and reverted them afterwards; this does that once, into a
 * derived file **beside** `wrangler.jsonc` so that `main` and `migrations_dir` resolve as they do there, and
 * passes it to every wrangler call. The file is regenerated on each run and git-ignored: the checked-in
 * config stays byte-identical across Nodes (ADR 24), and the name is an argument rather than an edit.
 *
 * Text substitution on the three literals rather than a JSON rewrite, so the comments — which are where the
 * config explains itself — survive into the derived file a reader may open to see what was deployed.
 */
export function configFor(argv) {
  const name = flag(argv, "name");
  const source = readFileSync(resolve(workerDir, "wrangler.jsonc"), "utf8");
  if (name === null) return { name: nameIn(source), path: resolve(workerDir, "wrangler.jsonc"), text: source, args: [] };
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    fail(
      `\`--name ${name}\` is not a Worker name.\n\n`
      + "  why      Cloudflare accepts lower-case letters, digits and hyphens, up to 63 characters.\n"
      + "  fix      pick one like `mailda-support`.",
    );
  }
  const base = nameIn(source);
  const derived = deriveConfig(source, name);
  const path = resolve(workerDir, `wrangler.${name}.jsonc`);
  writeFileSync(path, `// Derived by \`mailda deploy --name ${name}\` from wrangler.jsonc (base name \`${base}\`). Do not edit; do not commit.\n${derived}`);
  return { name, path, text: derived, args: ["--config", path] };
}

function nameIn(config) {
  return workerNameIn(config) ?? "mailda";
}

/** The wrangler arguments every call takes: the environment, and the derived config when `--name` was given. */
export let WRANGLER_ARGS = [...ENV];
export function useConfig(config) {
  WRANGLER_ARGS = [...ENV, ...config.args];
}


/* ------------------------------------------------------------------ preflight ---------------------- */

/**
 * Everything a deploy needs, checked before a deploy changes anything (#98).
 *
 * ## The failure that produced this
 *
 * `mailda deploy` refused on an ordinary machine and named the wrong cause. The operator's wrangler token
 * could see four Cloudflare accounts, which makes every non-interactive wrangler call fail with *"More than
 * one account available but unable to select one in non-interactive mode"*. What the operator was told, in
 * order: a **note** that the Workflow-theft guard had been skipped — so #99's protection silently did not
 * run — and then *"could not tell whether this account already has a Mailda Worker"*, with the actual remedy
 * mentioned in passing at the end of an advice block about something else.
 *
 * One `wrangler whoami` answers it. That is what this does, first, before anything is touched.
 *
 * ## Why it reports everything rather than stopping at the first problem
 *
 * An operator standing up a Node has several of these wrong at once, and a check that stops at the first
 * turns one setup into a sequence of round trips, each ending in a message about a different thing. So the
 * failures gather and print together.
 *
 * Returned rather than only printed, because `deploy` calls it and needs the resolved account.
 */
export async function runPreflight(argv, { announce = true, needsUrl = true } = {}) {
  const problems = [];
  const notes = [];

  const whoami = capture("npx", ["wrangler", "whoami"], { quiet: true });
  const version = wranglerVersionFrom(whoami.text);
  const floor = BUDGETS["workflow.schedules_min_wrangler"];

  if (!signedIn(whoami.text)) {
    problems.push({
      what: "wrangler is not signed in",
      why: "every step of a deploy is a wrangler call against your account",
      fix: "run `wrangler login`, or set CLOUDFLARE_API_TOKEN",
    });
  }

  const account = resolveAccount({
    accounts: accountsFrom(whoami.text),
    chosen: process.env.CLOUDFLARE_ACCOUNT_ID,
  });
  if (!account.ok) {
    // Headline, reason and remedy all come from the resolver, because the three cases it distinguishes —
    // ambiguous, wrong id, not signed in — fail differently and a shared sentence would be wrong for two.
    problems.push({ what: account.what, why: account.why, fix: account.fix });
  }

  if (!atLeast(version, floor)) {
    /*
     * A floor rather than a preference: below it wrangler **discards** a Workflow's `schedules` block with
     * exit 0 (`workflow-provisioning.md`), so a deploy appears to succeed and the Butler engine is not what
     * the config asked for. Compared numerically, because "4.118.0" sorts below "4.97.0" as a string.
     */
    problems.push({
      what: `wrangler ${version ?? "(version unknown)"} is below the measured floor of ${floor}`,
      why: "below it a Workflow's `schedules` block is discarded with exit 0, so the deploy looks fine and "
        + "the Butler engine is not what this config declares (docs/receipts/workflow-provisioning.md)",
      fix: "run `pnpm add -D wrangler@latest` in apps/node/worker, or use `npx wrangler@latest`",
    });
  }

  const origin = (flag(argv, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "") || null;
  const needed = urlRequirement({ origin, needsUrl });
  if (needed !== null) {
    problems.push(needed);
  }
  if (origin !== null) {
    /*
     * Asked of the Node rather than assumed, and a **note** rather than a problem. A Node deployed before the
     * `version_metadata` binding existed cannot name itself, which does not stop a deploy: the canary carries
     * the new code and will name itself, and a fall-through to the incumbent then reports no version at all,
     * which is precisely what the gate refuses on. Worth saying in advance so the refusal is not a surprise.
     */
    const response = await fetch(`${origin}${api("GET", "/api/doctor")}`, { headers: { accept: "application/json" } })
      .catch(() => null);
    if (response === null) {
      notes.push(`could not reach ${origin}. If this is a first install that is expected — there is no Node `
        + "yet. Otherwise the canary gate will have nothing to check.");
    } else {
      const report = await response.json().catch(() => null);
      if (report === null) {
        notes.push(`${origin}/api/doctor did not answer JSON, so its verdict cannot be read.`);
      } else if (typeof report.verdict !== "string") {
        /*
         * A JSON body that is not a report — a 401 from a claimed Node, or an error. Said as such, because
         * the version note below used to fire here and claim the Node "predates the `version_metadata`
         * binding", which was false three times in one afternoon's logs: twice against a claimed Node whose
         * report is simply gated, and once against a Node that did not exist yet. A note that names the wrong
         * cause is worse than no note, because it is read and believed.
         */
        notes.push(`${origin}/api/doctor answered ${response.status} rather than a report`
          + `${response.status === 401 ? " — a claimed Node gates it, which is expected here" : ""}.`
          + " Nothing about the Node's version could be read, and nothing is inferred from that.");
      } else {
        if (!reportsItsVersion(report)) {
          notes.push("this Node does not report which version answered, so it predates the "
            + "`version_metadata` binding. The next deploy installs it. Until then a version override that "
            + "fails to apply is reported as `the report named no version`, which is the gate refusing "
            + "correctly rather than a fault.");
        }
        if (report.verdict === "refuse") {
          notes.push("this Node currently reports `refuse`. A deploy will still run — the gate judges the "
            + "canary, not the incumbent — but the finding behind it is worth reading first: `mailda doctor`.");
        }
      }
    }
  }

  if (announce) {
    process.stdout.write("\n== preflight\n");
    process.stdout.write(`   wrangler        ${version ?? "unknown"} (floor ${floor})\n`);
    process.stdout.write(`   account         ${account.ok ? `${account.id}  ${account.name}` : "unresolved"}\n`);
    process.stdout.write(`   node            ${origin ?? "not given"}\n`);
    for (const note of notes) process.stdout.write(`\n   note: ${note}\n`);
  }

  if (problems.length > 0) {
    const rendered = problems.map((one, at) =>
      `  ${at + 1}. ${one.what}\n     why      ${one.why}\n     fix      ${one.fix}`).join("\n\n");
    return {
      ok: false,
      accountId: null,
      origin,
      report: `${problems.length} thing(s) must be settled before a deploy can run — nothing has been `
        + `changed.\n\n${rendered}`,
    };
  }

  if (announce) process.stdout.write("\n   ready\n");
  /*
   * The name travels with the id because the id is not readable. `dc8d1b7d…` and `1e0170aa…` are
   * distinguishable by a machine and not by a person scanning a plan, and the plan's whole job at that
   * moment is to let somebody catch a wrong account before it is built into.
   */
  return {
    ok: true,
    accountId: account.ok ? account.id : null,
    accountName: account.ok ? (account.name ?? null) : null,
    origin,
    report: null,
  };
}


/**
 * Whether this Node has been claimed, without needing to be signed in (#92).
 *
 * ## The regression this exists to fix
 *
 * The unclaimed check went in as `whyAdminCannotExist(await doctorReport(origin))`, and `doctorReport`
 * **refuses** on a non-2xx. That works on an unclaimed Node, whose report is public — and 401s on a claimed
 * one, which is every Node anybody actually uses. So a check added to make one message clearer broke both
 * commands for the normal case, and the failure was invisible until the commands were run against a claimed
 * Node.
 *
 * ## Why a 401 is the answer rather than an obstacle
 *
 * `/api/doctor` is public on an unclaimed Node and gated once claimed — that gating *is* the signal. A 401
 * here means there is an organization to sign in to, which is precisely what these commands need to know.
 * So the states are read from the status code and only then from the body:
 *
 *   401                  claimed. Gated, therefore claimed.
 *   200, claimed: false   unclaimed. There is no administrator to be.
 *   200, claimed: true    claimed, and this caller is somehow already authorized.
 *   anything else         unknown — and unknown proceeds, because refusing on an unreadable probe would
 *                         block a working backup over a network hiccup.
 */
export async function claimState(origin) {
  const response = await fetch(`${origin.replace(/\/$/, "")}/api/doctor`, {
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (response === null) return "unknown";
  if (response.status === 401) return "claimed";
  if (!response.ok) return "unknown";
  const report = await response.json().catch(() => null);
  if (report === null || typeof report.claimed !== "boolean") return "unknown";
  return report.claimed ? "claimed" : "unclaimed";
}


/**
 * One choice from a short list, with the arrow keys.
 *
 * Asked for on the first real upgrade (25 September 2026), when *"Node to upgrade [mailda]:"* under a list
 * of two names read as a text field an operator had to type into. A list is answered by pointing at a row.
 * Up/down or j/k move, a digit jumps, Enter takes the row, Ctrl-C leaves; the list is redrawn in place and
 * collapses to one line once answered, so the transcript reads as a question and its answer.
 *
 * Raw mode, like `readSecret` above and for the same reason: readline reads lines, and an arrow key is not
 * a line. No dependency: the CLI's only dependencies are the workspace's own packages, and forty lines do
 * not justify a prompt library. Not a terminal, not a question: `--yes` and the flags exist for that.
 */
export function choose(prompt, options, { initial = 0 } = {}) {
  if (process.stdin.isTTY !== true) {
    fail(`${prompt.trim()} asks for a choice; run this in a terminal, or pass it as a flag or --yes.`);
  }
  let index = Math.max(0, Math.min(initial, options.length - 1));
  const lines = options.length + 1;
  const draw = (first) => {
    if (!first) process.stdout.write(`\x1b[${lines}A`);
    process.stdout.write(`\x1b[2K${prompt}\n`);
    options.forEach((one, i) => {
      const label = typeof one === "string" ? one : one.label;
      process.stdout.write(`\x1b[2K   ${i === index ? "›" : " "} ${label}\n`);
    });
  };
  draw(true);
  return new Promise((done, reject) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const finish = (result, error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      // Collapse the list to the question and its answer.
      process.stdout.write(`\x1b[${lines}A\x1b[J`);
      if (error !== undefined) { reject(error); return; }
      const picked = options[result];
      process.stdout.write(`${prompt} ${typeof picked === "string" ? picked : picked.label}\n`);
      done(typeof picked === "string" ? picked : picked.value);
    };
    const onData = (chunk) => {
      const key = String(chunk);
      if (key === "\u0003") { finish(undefined, new Error("cancelled")); return; }
      if (key === "\r" || key === "\n") { finish(index); return; }
      if (key === "\x1b[A" || key === "k") index = (index + options.length - 1) % options.length;
      else if (key === "\x1b[B" || key === "j") index = (index + 1) % options.length;
      else if (/^[1-9]$/.test(key) && Number(key) <= options.length) index = Number(key) - 1;
      else return;
      draw(false);
    };
    process.stdin.on("data", onData);
  }).catch((error) => {
    if (error.message === "cancelled") { process.stdout.write("\n"); process.exit(130); }
    throw error;
  });
}


/**
 * Reads a secret from the terminal without echoing it.
 *
 * ## Why this is here and not imported
 *
 * `apps/node/worker/scripts/set-password.mjs` has the same function, and duplicating one is normally how a
 * repository drifts. That script dispatches on `process.argv` at the top level, so importing it would *run*
 * it — the same reason `deploy-parse.mjs` exists as a separate module. The CLI invokes it as a subprocess
 * instead, which is right for a password prompt and wrong as a way to borrow a helper.
 *
 * The duplication is bounded and the behaviour is the part that matters: a secret typed at a prompt never
 * reaches `process.argv`, and therefore never reaches shell history, which is the rule both copies exist to
 * keep.
 */
export function readSecret(prompt) {
  if (process.stdin.isTTY !== true) {
    fail("refusing to read a secret from a pipe — run this in a terminal.\n\n"
      + "  why      a code, password or token passed through a pipe or an argument is one in a shell history,\n"
      + "           a process list, and whatever captured this session's output\n"
      + "  fix      run it interactively");
  }
  process.stdout.write(prompt);
  return new Promise((done, reject) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const finish = (result, error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error !== undefined) reject(error); else done(result);
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(value);
        if (char === "\u0003") return finish(undefined, new Error("cancelled"));
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
        value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}
