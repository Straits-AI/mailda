#!/usr/bin/env node
/**
 * `mailda` — the operator's command line (#80).
 *
 * ## Why this exists, and what it deliberately does not claim
 *
 * Ten documents, the README's limitations section and two source files referred to `mailda deploy` and
 * `mailda doctor` as the mechanism for install, plan enforcement and capability verification. There was no
 * CLI. Not partial — no `bin` entry anywhere in the workspace, and five loose scripts invoked through
 * `pnpm --filter` doing the actual work.
 *
 * The worst of it was not the gap. `doctor` shipped a finding reading `workers_paid_plan: ok` whose detail
 * said *"`mailda deploy` verifies the plan at install and refuses on Workers Free (ADR 25)"* — the product
 * telling an operator that a tool which did not exist was protecting them. That is #60's governing failure
 * (a condition backed by nothing is a policy that silently never fires) reached through a doctor finding.
 *
 * So this binary does the work that is real, and **every claim about what it verifies has been removed from
 * the product where it was not true**. Specifically:
 *
 * - **The Workers plan is not checkable.** A Worker cannot read its account's plan, and this CLI does not
 *   have a documented API to read it either. `planCheck` now says it is unverified instead of crediting a
 *   check that does not run.
 * - **Whether a sending domain is onboarded is not checkable.** Cloudflare's onboarding is a dashboard flow
 *   and the docs expose no endpoint listing onboarded sending domains. Inventing a probe would mean sending
 *   a real message to a stranger to see whether it was refused, which is not something a verify command may
 *   do. It stays unverified, and says so.
 *
 * What is left is real: a deploy that runs the four steps an operator currently types by hand in the right
 * order, a doctor that reads a running Node, and a password reset that already worked.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  activeVersionFrom, contractingAmong, deployExitCode, doctorExitCode, promotionVerdict, servedVersionOf,
  versionIdFrom,
} from "./deploy-parse.mjs";
import {
  accountsFrom, atLeast, reportsItsVersion, resolveAccount, signedIn, wranglerVersionFrom,
} from "./preflight.mjs";
import { BUDGETS } from "@mailda/budgets";
import {
  backupIndex, checkBackup, exportableTables, needsIndexRebuild, whyAdminCannotExist,
} from "./backup.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "../../../apps/node/worker");

function fail(message) {
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
function capture(command, args, { cwd = workerDir, quiet = false } = {}) {
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
function run(command, args, { cwd = workerDir } = {}) {
  const outcome = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (outcome.error !== undefined) fail(`could not run ${command}: ${outcome.error.message}`);
  return outcome.status ?? 1;
}

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1] ?? null;
}

/* ------------------------------------------------------------------ doctor ------------------------- */

/**
 * Reads a running Node's own verdict.
 *
 * Over HTTP rather than by importing the checks, and that is the point: `runDoctor` needs the Worker's
 * bindings — D1, R2, the vault, the queue — so the only place it can answer honestly is inside the Worker.
 * A CLI that re-implemented the checks would be a second opinion about the Node's health, produced without
 * access to the things it is judging.
 *
 * **The text comes from the Node too.** `/api/doctor?format=text` renders `formatReport`, so this prints
 * what the Node wrote rather than a second spelling of the same layout — the first draft of this file
 * carried its own copy, which is exactly the drift this repository keeps paying for.
 *
 * ## Signing in, and why a claimed Node needs it
 *
 * The report is public on an **unclaimed** Node and gated once claimed — with one exception the route calls
 * out: if the Node cannot authenticate anybody at all, the gate is not one a caller can satisfy, so a
 * reduced report is served instead of a 401. That exception is the reason this command is worth having, and
 * it is also why credentials are optional here: the moment you most need `doctor` is the moment you cannot
 * sign in.
 *
 * Credentials come from the environment rather than the command line, which is `axe.mjs`'s rule and the
 * same one `set-password` follows: a password on a command line ends up in shell history.
 */
async function doctor(argv) {
  const origin = (flag(argv, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "");
  if (origin === "") {
    fail("usage: mailda doctor --url https://your-node.workers.dev\n"
      + "  why      the report comes from the Node itself: `runDoctor` needs the bindings it is judging,\n"
      + "           so a CLI that answered locally would be guessing about D1, R2 and the queue\n"
      + "  fix      pass --url, or set MAILDA_URL");
  }

  const headers = {};
  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email !== undefined && password !== undefined) {
    const signIn = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
    if (!signIn.ok) {
      // Not fatal. A claimed Node with a broken sign-in is precisely the case the route's exception exists
      // for, and giving up here would withhold the report in the one situation it was designed for.
      process.stderr.write(`sign-in failed (${signIn.status}); asking for the report anyway\n`);
    }
    const cookies = signIn.headers.getSetCookie?.() ?? [];
    if (cookies.length > 0) headers.cookie = cookies.map((line) => line.split(";")[0]).join("; ");
  }

  const wantsJson = argv.includes("--json");
  const url = `${origin}/api/doctor${wantsJson ? "" : "?format=text"}`;
  const response = await fetch(url, { headers })
    .catch((error) => fail(`could not reach ${origin}: ${error.message}`));
  const body = await response.text();

  /*
   * 503 is a **report**, not a failure to get one.
   *
   * The route answers 503 when the verdict is `refuse`, so that a load balancer and a person are told the
   * same thing. Treating every non-2xx as an error would make this command silent in the one case it exists
   * for — the Node saying it cannot do its job.
   */
  if (!response.ok && response.status !== 503) {
    fail(`${origin}/api/doctor answered ${response.status}\n${body.slice(0, 600)}\n\n`
      + "  why      a claimed Node gates its report behind a session\n"
      + "  fix      set MAILDA_EMAIL and MAILDA_PASSWORD, or read it in the application at /doctor");
  }

  process.stdout.write(wantsJson ? `${JSON.stringify(JSON.parse(body), null, 2)}\n` : body);

  /*
   * Returned rather than exited, which is the change. This used to end in
   * `process.exit(verdict === "refuse" ? 2 : ...)` — right for somebody running the command, and wrong for
   * the deploy that calls it as a closing step: a Node reporting `degraded` made a **successful** deploy
   * exit 1, and on a fresh Node `degraded` means `signing_key`, which self-heals on the next sign-in. Every
   * green deploy reported failure.
   *
   * The dispatch below still exits on this command's own verdict. What moved is *who decides*, because the
   * two commands are asked different questions — argued in `doctorExitCode`.
   */
  return wantsJson ? JSON.parse(body).verdict : body.split(/\s+/)[2]?.toLowerCase();
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
async function sessionCookie(origin) {
  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email === undefined || password === undefined) return null;

  const signIn = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).catch(() => null);
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
async function doctorReport(origin, extraHeaders = {}, subject = "the Node") {
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
  const response = await fetch(`${origin.replace(/\/$/, "")}/api/doctor`, {
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
const ENV = ["--env", ""];

/**
 * Whether this account has no `mailda` Worker yet.
 *
 * **Found by running the drill, not by reading**, and it broke the sequence this file shipped with. On a
 * fresh account:
 *
 *   - `wrangler d1 migrations apply` fails with *"Couldn't find an auto-provisioned D1 DB named
 *     'mailda-catalog' … Run 'wrangler deploy' to provision it"*, because `wrangler.jsonc` declares its D1
 *     and R2 bindings with **no ids and no names** — ADR 24 requires the repository to be byte-identical
 *     across installs, so the resources are provisioned from the deploy;
 *   - and `wrangler versions upload` fails with *"You cannot upload a new version of a Worker that does not
 *     yet exist"*.
 *
 * So neither of the first two steps of the expand-canary-check-shift sequence can run first on a new Node,
 * and the sequence as shipped would have failed every customer's very first deploy. A plain `wrangler
 * deploy` is the only thing that can go first — and it is *safe* there for the reason the canary exists:
 * there is no previous version to protect and no user to serve a broken one to.
 *
 * ## Ambiguity refuses rather than guesses
 *
 * A network failure would also make this probe fail, and treating that as "first install" would send an
 * **existing** Node down the direct-deploy path — skipping the canary, on a Node with users. So only
 * wrangler's own words for absence count; anything else stops the command.
 */
function firstInstall() {
  const probe = capture("npx", ["wrangler", "versions", "list", ...ENV]);
  if (probe.status === 0) return false;
  if (/does not yet exist|workers\.api\.error\.script_not_found|\[code: 10007\]/i.test(probe.text)) return true;
  fail(
    "could not tell whether this account already has a Mailda Worker.\n\n"
    + "  why      the two paths differ: a first install deploys directly, and every later one uploads a\n"
    + "           canary and checks it before moving traffic. Guessing wrong on an existing Node would\n"
    + "           skip the check, so this refuses rather than picks.\n"
    + "  fix      check `wrangler whoami` and CLOUDFLARE_ACCOUNT_ID, then re-run. wrangler said:\n"
    + `           ${probe.text.trim().split("\n").slice(-3).join(" ")}`,
  );
  return true;
}

/**
 * Refuses to deploy if this account's Butler Workflow already belongs to another Worker (#99).
 *
 * ## The theft this stops, measured rather than supposed
 *
 * Every other resource a Node provisions derives its name from the Worker's, so a second Node collides with
 * nothing — `mailda2-catalog`, `mailda2-evidence`, `mailda2-sending-events`. The Workflow's name is written
 * in `wrangler.jsonc` because Cloudflare **requires** it on the binding, and a Workflow is owned by exactly
 * one script.
 *
 * Drilled on a live account (`deploy-drill-live-account.md`): deploying a second Node beside the first
 * **succeeded, exit 0, no warning**, and ownership of `mailda-butler-runs` moved from `mailda` to `mailda2`.
 * The first Node kept a binding pointing at a Workflow now served by the second Node's code against the
 * second Node's bindings — a cross-Node execution path into another organization's D1. It does not refuse;
 * it reassigns.
 *
 * ## Why here as well as in a test
 *
 * `test/node/workflow-name-world.test.ts` holds the naming rule for this repository. It cannot help an
 * operator who edits `wrangler.jsonc`, changes the Worker name, forgets the Workflow, and runs `mailda
 * deploy` without running a suite. This check asks the **account** rather than the file, so it sees who
 * actually owns the Workflow rather than what the config intends.
 *
 * Not fatal when the answer cannot be read. `wrangler workflows list` needs a permission a deploy token may
 * not carry, and refusing every deploy because a *diagnostic* was unavailable is the wrong trade — a warning
 * that names what went unchecked is. The reverse of `firstInstall`, deliberately: there, being wrong means
 * skipping the canary on a live Node, so ambiguity stops the command.
 */
function refuseIfWorkflowBelongsElsewhere() {
  const config = readFileSync(resolve(workerDir, "wrangler.jsonc"), "utf8");
  const workerName = /"name"\s*:\s*"([^"]+)"/.exec(config)?.[1] ?? null;
  const workflowName = /"workflows"[\s\S]{0,400}?"name"\s*:\s*"([^"]+)"/.exec(config)?.[1] ?? null;
  if (workerName === null || workflowName === null) return;

  const listed = capture("npx", ["wrangler", "workflows", "list"]);
  if (listed.status !== 0) {
    process.stdout.write(
      `\n   note: could not read this account's Workflows, so whether \`${workflowName}\` already belongs to\n`
      + "         another Worker went unchecked. If a second Node in this account shares that name, this\n"
      + "         deploy will take its Butler engine without saying so (#99).\n",
    );
    return;
  }

  /*
   * `wrangler workflows list` prints a table; the row is `│ <name> │ <script> │ …`. Matched on the workflow's
   * own name so a second, unrelated Workflow in the account cannot be mistaken for this one.
   */
  const row = listed.text.split("\n").find((line) => line.includes(workflowName));
  const owner = row?.split("│").map((cell) => cell.trim()).filter(Boolean)[1] ?? null;
  if (owner !== null && owner !== workerName) {
    fail(
      `refusing to deploy: the Workflow \`${workflowName}\` belongs to the Worker \`${owner}\`, and this\n`
      + `config deploys \`${workerName}\`.\n\n`
      + "  why      a Workflow is owned by exactly one script. Deploying would move it to this Worker —\n"
      + `           silently, with no warning from wrangler — and \`${owner}\` would keep a BUTLER_RUNS\n`
      + "           binding pointing at a Workflow now running this Node's code against this Node's\n"
      + "           bindings. That is one organization's Butler runs executing inside another's.\n"
      + "  fix      give this Node its own Workflow: in wrangler.jsonc, set the workflows entry's `name`\n"
      + `           to \`${workerName}-butler-runs\`, so it derives from the Worker name the way every other\n`
      + "           resource here already does. Then deploy again.",
    );
  }
}

/* ------------------------------------------------------------------ deploy ------------------------- */

/**
 * Expand, canary, check, shift (#98).
 *
 * ## What the previous order got wrong, and why swapping it was not the fix
 *
 * It deployed the Worker and *then* applied migrations, so new code served requests against a schema that
 * did not yet have what it needed — and if the migration failed, the incompatible Worker stayed deployed
 * while `doctor` was optional. The reason given was that *"the Worker bundles them"*. That is false:
 * `wrangler d1 migrations apply` reads the `.sql` files from `migrations/` and needs no deployed Worker.
 *
 * Simply reversing it is also unsafe, and that is the substance of this change rather than a caveat. A
 * migration that **drops, renames or narrows** breaks the code that is *currently* serving, so applying it
 * first opens the same window pointing the other way. No order makes both safe. What does is splitting
 * migrations by phase — `test/node/migration-phase-world.test.ts` derives the phase from the statements
 * rather than trusting a comment, because the comment convention it replaces was observed by five of
 * thirty-nine files and was **wrong on both of the five that contracted**.
 *
 * ## The rollback is that traffic never moved
 *
 * `wrangler versions upload` publishes a version and shifts **no traffic**. So the sequence is: expand,
 * upload, check the canary, and only then `versions deploy` to shift. A failed check needs no undo — the
 * previous version is still the one serving, which is a stronger guarantee than a rollback step that has to
 * run correctly during an incident.
 *
 * `doctor` against the canary is therefore not the closing courtesy it used to be. It is the gate that
 * decides whether traffic moves, which is why it can no longer be skipped.
 *
 * ## How the canary is reached, after two drills spent looking in the wrong place
 *
 * It used to be checked at `canary-mailda.<subdomain>.workers.dev`, from `--preview-alias`. That hostname
 * **404s and always will**, and two rounds of the live drill recorded the cause as "unestablished, possibly
 * an account setting". It is not a setting. Measured against the account: the script's subdomain settings
 * already read `{"enabled": true, "previews_enabled": true}`, the alias is recorded on every version, and no
 * preview hostname routes at all. Cloudflare does not generate preview URLs for Workers that implement a
 * **Durable Object**, and ADR 28 put both root keys in `KeyVault`. No configuration reaches that.
 *
 * So the canary is reached on the production hostname instead:
 *
 *   1. upload it — no traffic;
 *   2. publish a deployment of `canary@0% + incumbent@100%`, because an override is only applied to a version
 *      **in the current deployment**, and 0% means nothing reaches it but the override;
 *   3. send `Cloudflare-Workers-Version-Overrides: mailda="<id>"` to `/api/doctor`;
 *   4. **require the report to name that id.** This is the gate. Cloudflare routes by percentage when an
 *      override cannot be applied — no error, no header — so a check that read only `verdict` would ask the
 *      incumbent how it is, hear `ok`, and promote a canary nothing had examined. That is why the Worker has
 *      a `version_metadata` binding at all.
 *   5. promote to 100%.
 *
 * The 0% step is a real deployment, so `wrangler deployments list` gains an entry per deploy. That is the
 * cost of the mechanism and it is visible rather than hidden.
 *
 * ## What the canary check does **not** cover, and it is not what you would guess
 *
 * **Durable Object code is not the canary's.** Cloudflare guarantees global uniqueness by running exactly one
 * version of each Durable Object at a time, and under a gradual deployment each object is assigned a version
 * by the traffic percentages. The canary has **0%**, so `KeyVault` and `OutboxSweeper` run the *previous*
 * version's code while the canary's `fetch` runs the new one.
 *
 * Two consequences, and the first is more useful than it sounds:
 *
 *   - What the canary actually validates is **mixed-version compatibility** — new Worker code against old DO
 *     code — which is the state every gradual rollout passes through anyway, and the state a big-bang deploy
 *     never tests at all. So the check is exercising something real.
 *   - But a change *inside* a Durable Object class is **not** what the canary checked. A broken `restore()` or
 *     a broken alarm would pass the gate and only take effect once traffic moved. This is the one part of the
 *     sequence where "checked before promotion" is not true, and it is written here rather than left for
 *     somebody to find out during a rollout.
 *
 * Nothing here fixes that; it is a property of how Durable Objects and versions interact. What would is a
 * check that exercises the DO paths after promotion and can still roll back — which needs the rollback to be
 * a real step again, and is a decision rather than an omission.
 *
 * **It does not refuse Workers Free**, and the README no longer says it does. A Worker cannot read its
 * account's plan and this CLI has no documented endpoint for it either; the honest state is unverified,
 * which is what `doctor` reports.
 */
async function deploy(argv) {
  const contracting = flag(argv, "contract") !== null || argv.includes("--contract");

  /*
   * Preflight first, and before `refuseIfWorkflowBelongsElsewhere` specifically. That guard is the one that
   * used to run first and silently no-op: on an ambiguous account `wrangler workflows list` fails, and the
   * guard printed a note and returned, so #99's protection against one Node stealing another's Butler engine
   * was skipped in exactly the situation where nothing else worked either. Settling the account before the
   * guard runs is what makes the guard's answer mean something.
   */
  const ready = await runPreflight(argv);
  if (!ready.ok) fail(ready.report);
  const origin = ready.origin;

  /*
   * **Is there anything here yet?** Measured against a real account rather than assumed, and it changed this
   * whole function — see `firstInstall` for what the drill found.
   */
  refuseIfWorkflowBelongsElsewhere();

  const first = firstInstall();
  if (first) {
    process.stdout.write(
      "\n== first install: no Worker exists yet\n"
      + "   Deploying directly. There is no previous version to protect, so there is nothing a canary could\n"
      + "   roll back to and nothing a migration could break — and the bindings do not exist until a deploy\n"
      + "   provisions them, which is why neither step below can come first.\n",
    );
    if (run("npx", ["wrangler", "deploy", ...ENV]) !== 0) fail("the first deploy failed.");
    process.stdout.write("\n== applying migrations for the first time\n");
    if (run("npx", ["wrangler", "d1", "migrations", "apply", "CATALOG", "--remote", ...ENV]) !== 0) {
      fail("applying migrations failed. The Worker is deployed against an empty schema — re-run to finish.");
    }
    process.stdout.write("\n== attaching the delivery-events consumer on a new Node\n");
    if (run("node", ["scripts/attach-queue-consumer.mjs"]) !== 0) {
      fail("attaching the consumer failed. Delivery outcomes will be unobserved until it is.");
    }
    if (origin !== null) {
      process.stdout.write("\n== asking the Node how it is\n");
      /*
       * The same rule as the canary path: a first install that ends with the Node refusing exits 2, and
       * anything less than that is not this command's failure. There is no previous version to name here —
       * that is what makes a first install a first install — so the refusal below prints no rollback.
       */
      const verdict = await doctor(["--url", origin]);
      if (verdict === "refuse") {
        process.stderr.write(
          "\n  the first install completed and the Node reports `refuse`.\n\n"
          + "  why      there is no previous version to fall back to on a first install, which is also why\n"
          + "           this step could not be a gate.\n"
          + "  fix      read the findings above; `mailda doctor` repeats them.\n\n",
        );
      }
      process.exit(deployExitCode(verdict));
    }
    return;
  }

  /*
   * The gate needs the Node's own hostname, so a missing one is refused **here** — before a migration has
   * been applied or a version uploaded. The canary used to be checked at a preview URL that wrangler
   * printed, so no origin was needed; it is needed now because that URL does not exist for a Worker with
   * Durable Objects, and the check reaches the canary through the production hostname instead.
   */
  /*
   * Unreachable in practice: preflight above refuses a missing origin as one of its numbered problems, and
   * this deploy needs one for the canary gate. Kept as an assertion rather than deleted, because "some other
   * caller cannot reach here" is the kind of claim that stops being true quietly — and the cost of it being
   * wrong is a gate that checks `undefined/api/doctor` and reads as an unreachable canary.
   */
  if (origin === null) {
    fail(
      "this deploy needs the Node's URL, and nothing has been changed.\n\n"
      + "  why      the canary is checked by overriding to it on the Node's own hostname. There is no\n"
      + "           preview URL to check instead: Cloudflare does not generate one for a Worker that\n"
      + "           implements a Durable Object, and this one holds its root keys in `KeyVault`.\n"
      + "  fix      re-run with `--url https://<your-node>` or set MAILDA_URL.",
    );
  }

  /*
   * Expansion first, because it is safe ahead of the code by construction, and refuse a contraction unless
   * the operator said so. A pending `-- phase: contract` migration applied here would break the version
   * currently serving — before the canary has even been uploaded, and while nothing has gone wrong yet.
   */
  process.stdout.write("\n== checking which migrations are pending\n");
  const pending = capture("npx", ["wrangler", "d1", "migrations", "list", "CATALOG", "--remote", ...ENV]);
  if (pending.status !== 0) fail(`could not list migrations (exit ${pending.status}).`);
  const contractions = contractingAmong(pending.text, resolve(workerDir, "migrations"));
  if (contractions.length > 0 && !contracting) {
    fail(
      `refusing to apply a contracting migration: ${contractions.join(", ")}\n\n`
      + "  why      it drops, renames or narrows something, so it breaks the version currently serving —\n"
      + "           which is still the version serving until the canary below is checked and promoted.\n"
      + "  fix      deploy the expansion and the new code first, then run `mailda deploy --contract` in a\n"
      + "           later release, once you no longer want to roll back to the version that needs the old\n"
      + "           shape. Or split the migration so the contraction is its own file.",
    );
  }

  process.stdout.write("\n== applying migrations\n");
  if (run("npx", ["wrangler", "d1", "migrations", "apply", "CATALOG", "--remote", ...ENV]) !== 0) {
    fail("applying migrations failed. Nothing was deployed, so the version currently serving is unchanged.");
  }

  /*
   * Which version is serving now. Read **before** the upload, so the pair below is built from the version
   * this command found live rather than from whatever the list says after it has changed.
   */
  process.stdout.write("\n== reading the version currently serving\n");
  const deployments = capture("npx", ["wrangler", "deployments", "list", ...ENV]);
  if (deployments.status !== 0) fail(`could not list deployments (exit ${deployments.status}).`);
  const serving = activeVersionFrom(deployments.text);
  if (serving === null) {
    fail(
      "could not tell which version is currently serving.\n\n"
      + "  why      the canary is checked by placing it alongside that version at 0% and overriding to it.\n"
      + "           Without the incumbent's id this command cannot build that pair, and guessing would\n"
      + "           publish a deployment that drops the version now serving.\n"
      + "  fix      nothing has changed. Run `wrangler deployments list` and check the output.",
    );
  }

  process.stdout.write("\n== uploading a canary version (no traffic)\n");
  const uploaded = capture("npx", [
    "wrangler", "versions", "upload", "--message", "mailda deploy", ...ENV,
  ]);
  if (uploaded.status !== 0) {
    fail(`uploading the canary failed (exit ${uploaded.status}). No traffic moved.`);
  }
  const version = versionIdFrom(uploaded.text);
  if (version === null) {
    fail(
      "could not find the new version's id in wrangler's output.\n\n"
      + "  why      the id is what promotes this version, and guessing it would promote something else.\n"
      + "  fix      the canary is uploaded and serving no traffic, so nothing is broken. Read the id from\n"
      + "           the output above and finish with `wrangler versions deploy <id>@100`.",
    );
  }

  /*
   * Put the canary **in** the current deployment at 0%. A version override is only applied if the version is
   * in the current deployment, so without this step the header below would be ignored and the check would
   * silently interrogate the incumbent. 0% means no request reaches it except one carrying the override.
   */
  process.stdout.write("\n== placing the canary in the deployment at 0%\n");
  if (run("npx", [
    "wrangler", "versions", "deploy", `${version}@0`, `${serving}@100`, "--yes", ...ENV,
  ]) !== 0) {
    fail(
      "could not place the canary in the deployment.\n\n"
      + `  why      the canary cannot be reached without being in it, and ${serving} is still at 100%.\n`
      + "  fix      nothing was promoted. Re-run, or check `wrangler deployments list`.",
    );
  }

  /*
   * The gate. Against the **canary**, reached through a version override on the production hostname — a
   * Worker with Durable Objects gets no preview URL, which two rounds of the deploy drill spent on an
   * account setting that was already correct (`preview-urls-and-durable-objects.md`).
   *
   * The identity check is the gate, not the verdict. Cloudflare routes by percentage when an override cannot
   * be applied, so a report that came from the incumbent would say `ok` and promote an unexamined canary.
   */
  process.stdout.write(`\n== asking the canary how it is (${origin}, version ${version})\n`);

  /*
   * One cookie, used for **both** reports, and that is load-bearing rather than tidy. Asking the canary
   * authenticated and the incumbent anonymously would compare 21 findings against 9 — twelve of them would
   * read as new, and every deploy would be blocked by a difference in who was asking rather than in what
   * the code does. Like for like or not at all.
   */
  const cookie = await sessionCookie(origin);
  const asked = cookie === null ? {} : { cookie };
  process.stdout.write(`   checking ${cookie === null ? "anonymously" : "signed in"}\n`);

  const report = await doctorReport(origin, {
    ...asked,
    "Cloudflare-Workers-Version-Overrides": `mailda="${version}"`,
  }, "the canary");
  const answered = servedVersionOf(report);
  if (answered !== version) {
    fail(
      `the override did not reach the canary: ${answered ?? "the report named no version"} answered.\n\n`
      + "  why      Cloudflare routes a request by traffic percentage when a version override cannot be\n"
      + `           applied, so this check just asked ${serving} how it is. Promoting on that answer would\n`
      + "           move every request onto a version nothing examined.\n"
      + "  fix      no traffic moved. If the Node predates the `version_metadata` binding it cannot report\n"
      + "           its version and this gate cannot run — deploy once by hand to install it:\n"
      + `           \`wrangler versions deploy ${version}@100\`.`,
    );
  }
  /*
   * Judged against what is already serving, not against perfection — and the drill is what taught this. The
   * gate was `shouldPromote(canary.verdict)`, which refused a canary whose only finding was the *same* one
   * the incumbent had (`signing_key`, self-healing on an unclaimed Node). A version neither better nor worse
   * than the one taking every request was withheld, and an operator was told to promote it by hand. Every
   * deploy to such a Node would go that way, and a gate that always has to be overridden is not a gate.
   *
   * The incumbent's report is fetched **without** the override header, which reaches it because it holds
   * 100% of the traffic. Asked after the canary rather than before, so the two are as close together in time
   * as the sequence allows — a finding that appeared between them belongs to the Node, not to the canary.
   */
  const incumbent = await doctorReport(origin, asked, "the version now serving");
  const gate = promotionVerdict({ canary: report, incumbent });

  for (const check of gate.carried) {
    process.stdout.write(`   carried  ${check}  — the version now serving reports this too\n`);
  }

  /*
   * How much the gate could see, printed next to its verdict. A reduced report says so in a finding of its
   * own, and the number it withholds is the honest measure of this check's reach — 9 of 21 on the Node this
   * was drilled against. "The gate passed" is worth less without it.
   */
  const withheld = (report.findings ?? []).find((one) => one?.check === "report_reduced");
  process.stdout.write(
    `   compared ${(report.findings ?? []).length} finding(s)`
    + `${withheld === undefined ? " — the whole report" : `, and ${withheld.detail}`}\n`,
  );

  if (!gate.promote) {
    fail(
      `${gate.why}, so traffic was not moved.\n\n`
      + "  why      the version that was serving before this command ran is still the one serving. There is\n"
      + "           nothing to roll back, which is why the canary is uploaded before it is promoted.\n"
      + "  fix      read the findings above. To promote it anyway once you have decided they are\n"
      + `           acceptable: \`wrangler versions deploy ${version}@100\`.`,
    );
  }

  process.stdout.write("\n== moving traffic to the checked version\n");
  if (run("npx", ["wrangler", "versions", "deploy", `${version}@100`, "--yes", ...ENV]) !== 0) {
    fail("promoting the canary failed. The previous version is still serving.");
  }

  /*
   * The consumer last, because it attaches to a queue the deploy provisions — and out of band, because a
   * consumer cannot name a queue whose name Cloudflare derives (`queue-provisioning.md`).
   */
  process.stdout.write("\n== attaching the delivery-events consumer\n");
  if (run("node", ["scripts/attach-queue-consumer.mjs"]) !== 0) {
    fail("attaching the consumer failed. The new version is live but delivery outcomes are unobserved.");
  }

  /*
   * Unconditional now, where it used to depend on `--url` being passed. The canary path refuses without an
   * origin long before this line, so there is no branch left in which it could be absent — and this run is
   * the one that covers what the canary could not: Durable Object code, which runs the promoted version only
   * after traffic moves.
   */
  process.stdout.write("\n== asking the live Node how it is\n");
  const after = await doctor(["--url", origin]);

  /*
   * The deploy's own exit code, not doctor's. A carried degradation is the incumbent's condition and the gate
   * already refused anything the canary made worse, so it is not this command's failure — see
   * `deployExitCode`.
   *
   * `refuse` is different and is the one case the canary gate provably cannot have caught: Durable Object code
   * runs the promoted version only **after** traffic moves, so a broken `KeyVault` or `OutboxSweeper` appears
   * exactly here and nowhere earlier. Hence the rollback command, with the version that was serving before
   * this ran — the one value a person cannot look up mid-incident.
   */
  if (after === "refuse") {
    process.stderr.write(
      `\n  the deploy completed and the Node now reports \`refuse\`.\n\n`
      + "  why      the canary gate cannot see this one. A Durable Object runs the promoted version only\n"
      + "           after traffic moves, so a fault inside `KeyVault` or `OutboxSweeper` appears here and\n"
      + "           could not have appeared earlier.\n"
      + `  fix      to put the previous version back: \`wrangler versions deploy ${serving}@100\`\n\n`,
    );
  }
  process.exit(deployExitCode(after));
}




/* ------------------------------------------------------------------ claim-secret ------------------- */

/**
 * Writes the secret that lets somebody claim this Node, and prints it once.
 *
 * `seedClaimSecret` was documented as *"Called by `mailda deploy`"* and had no caller but its own test, so
 * the install path had no producer at all. This is it. Generated rather than chosen, because a claim secret
 * an operator invents is one they can reuse, and it is the single credential between an unclaimed Node and
 * whoever finds its URL first.
 */
function claimSecret(argv) {
  process.exit(run("node", [
    "--experimental-strip-types", "scripts/seed-claim-secret.mjs",
    ...(argv.includes("--local") ? ["--local"] : []),
  ]));
}

/* ------------------------------------------------------------------ set-password ------------------- */

/** The existing operator tool, under the name every document already uses. */
function setPassword(argv) {
  const email = argv[0];
  if (email === undefined) fail("usage: mailda set-password <email>");
  process.exit(run("node", ["--experimental-strip-types", "scripts/set-password.mjs", email]));
}

/**
 * Minting a replacement set of recovery codes, and confirming one landed.
 *
 * ## Why this is a command and not a dashboard button
 *
 * `doctor` tells an operator to "mint a fresh set" — it has since #92, and migration 0042 made it say so to
 * every Node whose codes predate the encoder fix. Until now there was **no supported way to do it**: the mint
 * was reachable from the initial claim and from nothing else, so the instruction named no door.
 *
 * ## Two steps on purpose
 *
 * The plaintext is returned once and cannot be produced again. If that response is lost — a closed terminal,
 * a dropped connection — this Node looks exactly as it would if the codes had been written down: ten rows,
 * good hashes, current escrow. `doctor` would report health over an organization that cannot recover, and it
 * would find out during the incident.
 *
 * So `rotate` prints and `confirm` proves. Confirmation compares a code against its stored hash and does
 * **not** spend it, so all ten stay usable; until it happens, `doctor` holds the finding at degraded.
 *
 * Credentials come from the environment, which is this file's rule throughout: a password on a command line
 * ends up in shell history, and the thing being protected here is the last resort.
 */
async function recoveryCodes(argv) {
  const action = argv[0];
  if (action !== "rotate" && action !== "confirm" && action !== "redeem") {
    fail("usage: mailda recovery-codes rotate|confirm|redeem --url https://your-node.workers.dev\n"
      + "  rotate   mint ten replacement codes and print them once\n"
      + "  confirm  type one back, proving you hold the set. Compared, never spent\n"
      + "  redeem   spend one to restore this Node's key vault. The disaster path\n"
      + "  why      the codes open the escrow holding this Node's content and credential keys. They are\n"
      + "           shown once, so an unconfirmed set is one nobody can prove reached a human\n"
      + "  fix      set MAILDA_EMAIL and MAILDA_PASSWORD, then pass --url");
  }

  /*
   * **Redeem is handled before anything else, because it is the one that must work when nothing does** (#134).
   *
   * `POST /api/recovery/redeem` is deliberately unauthenticated: the state it exists for is one where the
   * signing key cannot be unwrapped, so no session can be issued and no administrator can prove they are one.
   * Requiring credentials here would put the door behind the lock it opens — measured during #92's restore
   * drill, where the destination Node answered 500 to every sign-in and its own doctor said
   * `signing_key: E_EVIDENCE_AUTH_FAILED`.
   *
   * It had no interface at all until now: no screen, and no verb here. The only way to spend a code was a
   * hand-written `curl`, for the operation whose entire purpose is to be performed during a disaster by
   * somebody who has lost everything else.
   */
  if (action === "redeem") {
    const origin = (flag(argv, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "");
    if (origin === "") fail("usage: mailda recovery-codes redeem --url https://your-node.workers.dev");

    // Read from the terminal, never from a flag: the CLI's own rule, and a recovery code in shell history is
    // a recovery code in a backup of the shell history.
    const code = (await readSecret("Recovery code: ")).trim();
    if (code === "") fail("no code entered; nothing was spent.");

    const response = await fetch(`${origin}/api/recovery/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      fail(
        `the Node refused the code (${response.status}).\n\n`
        + `  why      ${body.message ?? body.error ?? "no detail given"}\n`
        + "  fix      each code is single-use, so a code spent earlier will not work twice. Try another\n"
        + "           from the same set — the set that was shown when this Node was claimed.",
      );
    }

    /*
     * **Read what came back before saying what happened** (#138).
     *
     * This printed `the vault is restored` over whatever the body said, and #92's drill answered:
     *
     *     HTTP 200
     *     {"restored":{"content":[],"credential":[]},"conflicted":{"content":[1],"credential":[1]}}
     *
     * Nothing installed, a single-use code spent, and this command called it a restore. A generation the
     * vault already holds under a *different* key cannot take the escrowed one — `redeemForVault` keeps the
     * live key deliberately, because losing newer mail to recover older is the worse trade — and the mail
     * sealed under the escrowed key stays unreadable. That is the moment an operator has to be told, and it
     * was the moment this told them the opposite.
     *
     * Counted rather than described: the sum is what decides which of the three things happened, so a partial
     * restore cannot read as either a success or a failure.
     */
    const installed = (body.restored?.content?.length ?? 0) + (body.restored?.credential?.length ?? 0);
    const collided = (body.conflicted?.content?.length ?? 0) + (body.conflicted?.credential?.length ?? 0);

    const displaced = (body.adopted?.content?.length ?? 0) + (body.adopted?.credential?.length ?? 0);

    if (installed > 0) {
      process.stdout.write(
        `\n   ${installed} key generation(s) installed`
        + (displaced > 0
          ? `, ${displaced} of them replacing a generation this Node had reserved and never sealed under`
          : "")
        + (collided > 0 ? `, and ${collided} could not be — see below` : "") + ".\n\n"
        + "   That code is spent. Run `mailda doctor --url " + origin + "` to see what the Node says now —\n"
        + "   a restored vault should clear the signing-key refusal, and the Node should sign people in again.\n\n",
      );
    }

    if (collided > 0) {
      /*
       * The **Node's** words when it has them, and the decision made from the counts either way.
       *
       * Deciding on `body.notice` alone would make an older Node — one that answers without the field, which
       * is every Node deployed before this — look like a clean restore again, which is the whole defect. And
       * restating the explanation here would give an operator two texts to reconcile during an incident.
       *
       * `fail` rather than a note, even when something was installed: a generation that could not be put back
       * is mail that cannot be read, and an exit code is the only part of this a script notices.
       */
      fail(
        `${collided} escrowed key generation(s) could NOT be installed`
        + (installed === 0 ? " — nothing was restored" : "") + ".\n\n"
        + "  what     content " + JSON.stringify(body.conflicted?.content ?? [])
        + ", credential " + JSON.stringify(body.conflicted?.credential ?? []) + "\n"
        + "  why      " + (typeof body.notice === "string" && body.notice !== ""
          ? body.notice
          : "this Node already holds keys of those generation numbers under a different secret, and one "
            + "number cannot hold both. The code is spent and mail sealed under the escrowed key stays "
            + "unreadable. Another code will not help — all ten carry the same generations")
        + "\n"
        + "  fix      do NOT spend more codes on it. See #138.",
      );
    }

    if (installed === 0) {
      // Neither installed nor collided: a 200 that did nothing at all, which no known path produces.
      fail(
        "the Node answered success and reported no keys at all.\n\n"
        + `  what     ${JSON.stringify(body)}\n`
        + "  why      unknown. A redemption installs generations, collides with them, or refuses — this is\n"
        + "           none of the three, so nothing here will guess which\n"
        + "  fix      `mailda doctor --url " + origin + "` and read `recovery_restore_state`.",
      );
    }
    return;
  }

  const origin = (flag(argv, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "");
  if (origin === "") fail("pass --url https://your-node.workers.dev, or set MAILDA_URL");

  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email === undefined || password === undefined) {
    fail("set MAILDA_EMAIL and MAILDA_PASSWORD\n"
      + "  why      both routes are administrator-only: minting destroys the current set, and confirming\n"
      + "           asserts that a person holds the replacement\n"
      + "  fix      export them, or use the dashboard");
  }

  /*
   * A **cookie**, not a bearer token. `POST /api/auth/login` answers
   * `{signedIn, userId, organizationId, accessExpiresAt}` and sets cookies — it has never returned an
   * `access_token`. This read `(await signIn.json()).access_token`, which is `undefined`, and sent
   * `Authorization: Bearer undefined`, so every one of these routes answered 401. Found by running the
   * command against a real claimed Node; nothing in the suite could see it, because the tests drive the
   * routes directly and never the CLI's own sign-in.
   */
  const cookie = await sessionCookie(origin);
  if (cookie === null) fail("could not sign in — these routes need an administrator.");

  const post = async (path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body ?? {}),
    }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      fail(`${path} refused (${response.status})\n  ${payload.what ?? payload.message ?? "no detail"}`);
    }
    return payload;
  };

  if (action === "rotate") {
    const { codes, notice } = await post("/api/recovery-codes/rotate");
    process.stdout.write("\n== ten replacement recovery codes, shown once\n\n");
    for (const code of codes) process.stdout.write(`   ${code}\n`);
    process.stdout.write(`\n${notice}\n\n`);
    /*
     * The next step is printed rather than assumed. An operator who stops here has a Node that reports
     * degraded and codes nothing has verified they hold, which is the state this command pair exists to
     * remove — and it is exactly the state somebody reaches by reading the codes and closing the terminal.
     */
    process.stdout.write("   next: mailda recovery-codes confirm --url " + origin + "\n\n");
    return;
  }

  /*
   * **Typed at a prompt, not passed as a flag** (#136), for two reasons and the second is the load-bearing one.
   *
   * This command required `--code` while `redeem`, forty lines up, refuses one — and confirm's leak is the
   * worse of the two. A redeemed code in a shell history is a *spent* code; a confirmed one is live, because
   * confirming deliberately does not spend it. So the command with the gentler verb was the one putting a
   * working key to the escrow into `~/.zsh_history`, a CI log and a `ps` snapshot.
   *
   * And a code a script reads from a file cannot make this assertion at all. Confirmation asserts exactly one
   * thing — that a **person** holds the sheet — and `doctor`'s warning is worded as that: *"nobody has
   * confirmed holding one"*. Automating it clears the warning without the fact becoming true, which is 2b: an
   * assertion that cannot fail. The agent that found this had just rotated a Node's codes and could have
   * cleared its warning from the file it had written, making the Node claim a human held codes no human had
   * read.
   *
   * `--code` is refused **by name** rather than ignored, because somebody has it in a script and a silent
   * behaviour change would leave them with a Node that stays degraded for no stated reason.
   */
  if (flag(argv, "code") !== undefined) {
    fail("--code is not accepted; the code is typed at a prompt.\n\n"
      + "  why      confirming does not spend the code, so one on a command line is a live key to this\n"
      + "           organization's escrow sitting in shell history — worse than the spent one `redeem`\n"
      + "           already refuses to take that way. And a code a script reads from a file proves nothing\n"
      + "           about a person holding the sheet, which is the only thing confirmation asserts\n"
      + "  fix      mailda recovery-codes confirm --url " + origin);
  }
  const typed = (await readSecret("Recovery code: ")).trim();
  if (typed === "") fail("no code entered; nothing was confirmed.");
  const { message } = await post("/api/recovery-codes/confirm", { code: typed });
  process.stdout.write(`\n${message}\n\n`);
}

/**
 * Listing and repairing what the body index failed on.
 *
 * ## Why a command rather than a documented UPDATE
 *
 * The receipt for #107 said, in as many words, that repairing a message meant clearing `body_indexed_at` by
 * hand and that no route exposed it. An operator whose search cannot find a message they know exists was
 * being handed a `wrangler d1 execute` — which is not a repair path, it is an invitation to write an
 * `UPDATE` with no `WHERE` during an incident.
 *
 * ## It lists before it repairs, and the default is to list
 *
 * Some failures are deterministic: a body no parser will ever read. Repairing those spends the backfill's
 * attempts on work that cannot succeed, while the mail behind them waits. So `list` shows the reason against
 * each id and `repair` takes the ids worth retrying — a sweep would be one flag and the wrong shape.
 */
async function search(argv) {
  const action = argv[0] ?? "list";
  if (action !== "list" && action !== "repair") {
    fail("usage: mailda search list|repair --url https://your-node.workers.dev\n"
      + "  list     what the body index failed on, with the reason for each\n"
      + "  repair   put named messages back in the queue: --id msg_… (repeatable), or --all\n"
      + "  why      a message the index gave up on is unsearchable by its text and otherwise untouched.\n"
      + "           Fix the cause before repairing, or the attempts are spent again");
  }

  const origin = (flag(argv, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "");
  if (origin === "") fail("pass --url https://your-node.workers.dev, or set MAILDA_URL");
  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email === undefined || password === undefined) {
    fail("set MAILDA_EMAIL and MAILDA_PASSWORD — both routes are administrator-only");
  }

  // A cookie, for the reason argued at `recovery-codes`: the login route has never returned a bearer token.
  const held = await sessionCookie(origin);
  if (held === null) fail("could not sign in — these routes need an administrator.");
  const auth = { cookie: held, "content-type": "application/json" };

  const listed = await fetch(`${origin}/api/search/failed`, { headers: auth })
    .then((response) => response.json())
    .catch((error) => fail(`could not reach ${origin}: ${error.message}`));
  const failures = listed.failed ?? [];

  if (action === "list" || failures.length === 0) {
    if (failures.length === 0) {
      process.stdout.write("\nthe body index has failed on nothing\n\n");
      return;
    }
    process.stdout.write(`\n== ${failures.length} message(s) the body index failed on\n\n`);
    for (const row of failures) {
      process.stdout.write(`   ${row.messageId}  ${row.state}  ${row.attempts} attempt(s)\n`);
      process.stdout.write(`      ${row.error ?? "no reason recorded"}\n`);
    }
    /*
     * The distinction is printed rather than left for the operator to infer from the error text, because it
     * is the decision the command exists to support: `retryable` is a Node still working, `unindexable` has
     * stopped — and among those, "abandoned after N attempts" is worth retrying and a parse failure is not.
     */
    process.stdout.write("\n   retryable    still being retried automatically; nothing to do\n");
    process.stdout.write("   unindexable  stopped. \"abandoned after N attempts\" is worth a repair once the\n");
    process.stdout.write("                cause is fixed; a parse failure will fail again\n\n");
    process.stdout.write(`   repair: mailda search repair --url ${origin} --id <msg_…>\n\n`);
    return;
  }

  const ids = argv.includes("--all")
    ? failures.map((row) => row.messageId)
    : argv.flatMap((arg, at) => (arg === "--id" ? [argv[at + 1]] : [])).filter(Boolean);
  if (ids.length === 0) {
    fail("pass --id msg_… (repeatable) or --all\n"
      + "  why      repair is per message. Some of these are deterministically unparseable and repairing\n"
      + "           them spends the backfill's attempts on work that cannot succeed\n"
      + "  fix      run `mailda search list` first and choose");
  }

  const response = await fetch(`${origin}/api/search/repair`, {
    method: "POST", headers: auth, body: JSON.stringify({ messageIds: ids }),
  }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) fail(`repair refused (${response.status})\n  ${payload.what ?? "no detail"}`);
  process.stdout.write(`\n${payload.requeued} message(s) re-queued. ${payload.message}\n\n`);
}

/* ------------------------------------------------------------------ dispatch ----------------------- */

/* ------------------------------------------------------------------ verify-evidence ---------------- */

/**
 * Sweeps every stored message against the hash taken when it arrived (#92).
 *
 * ## Why the CLI pages and the route does not
 *
 * The route is bounded at a measured batch (`evidence-integrity-cost.md`) because a whole-database sweep
 * cannot fit in one invocation's subrequest budget — and a request that hit the cap partway would return a
 * clean partial result, which is the failure this whole feature exists to prevent. So the route answers
 * *"here is what I checked, resume after this"*, and the loop belongs to the caller.
 *
 * That makes this the only place a **complete** answer exists. A person calling the route once learns about
 * two hundred messages and can easily believe they learned about all of them; this keeps going until the
 * Node says there is no more, and prints the total it actually covered.
 *
 * ## What it prints when something is wrong
 *
 * Every fault, grouped by kind, with the receipt id — because the three kinds are different problems.
 * `missing` means the evidence is gone and the metadata that says it existed is not. `unreadable` means the
 * key generation the object names cannot be produced, which is the ADR 28 loss the escrow exists for.
 * `altered` means the bytes changed after ingress, which cannot happen by accident.
 *
 * Exit 1 on any fault, so this can be a scheduled check rather than something somebody reads.
 */
async function verifyEvidence(argv) {
  const origin = (flag(argv, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "");
  if (origin === "") {
    fail("usage: mailda verify-evidence --url https://your-node.workers.dev\n"
      + "  why      the check runs inside the Node: it needs the R2 bucket and the key vault, so a CLI\n"
      + "           that answered locally would be guessing about both\n"
      + "  fix      pass --url, or set MAILDA_URL");
  }

  // The same check `backup` makes, for the same reason: this route is administrator-only too, and on an
  // unclaimed Node there is no administrator to be.
  const unclaimed = whyAdminCannotExist({ claimed: await claimState(origin) === "unclaimed" ? false : true });
  if (unclaimed !== null) {
    fail(`${unclaimed.what}.\n\n  why      ${unclaimed.why}.\n  fix      ${unclaimed.fix}.`);
  }

  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email === undefined || password === undefined) {
    fail("set MAILDA_EMAIL and MAILDA_PASSWORD\n"
      + "  why      the route is administrator-only: what it reports is how much of the whole\n"
      + "           organization's evidence is intact, which is not a mailbox grant\n"
      + "  fix      export them, then re-run");
  }

  // A cookie, for the reason argued at `recovery-codes`: the login route has never returned a bearer token.
  const cookie = await sessionCookie(origin);
  if (cookie === null) fail("could not sign in — this route needs an administrator.");

  process.stdout.write("\n== checking stored evidence against the hashes taken at ingress\n");

  let after = null;
  let checked = 0;
  let bytes = 0;
  let batches = 0;
  const faults = [];

  /*
   * Bounded by the Node's own cursor rather than by a page limit here. The guard is `resumeAfter` going
   * null, which the route returns only on a short page — so a sweep ends because the Node said it had
   * nothing more, never because this loop decided it had seen enough.
   */
  for (;;) {
    const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
    const response = await fetch(`${origin}/api/evidence/verify${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      fail(`/api/evidence/verify refused (${response.status})\n  ${payload.what ?? payload.message ?? "no detail"}`
        + `\n\n  covered ${checked} message(s) before this, so the sweep is incomplete rather than clean.`);
    }

    batches += 1;
    checked += payload.checked ?? 0;
    bytes += payload.bytesRead ?? 0;
    faults.push(...(payload.faults ?? []));
    process.stdout.write(`   batch ${batches}: ${payload.checked} checked, ${(payload.faults ?? []).length} fault(s)\n`);

    if (payload.resumeAfter === null || payload.resumeAfter === undefined) break;
    after = payload.resumeAfter;
  }

  const megabytes = (bytes / 1024 / 1024).toFixed(1);

  /*
   * Nothing checked is not a clean bill of health, and this said it was. Run against a freshly claimed Node
   * it printed *"0 message(s) checked … Every one opened and hashed to what was recorded"*, which is true and
   * reads as reassurance about evidence that does not exist. The verifier itself has a test for exactly this
   * — `intact: true` with `checked: 0` is honest only because the caller reads `checked` — and then the
   * caller wrote a sentence that did not.
   */
  if (checked === 0) {
    process.stdout.write(
      "\n   nothing to check: this Node holds no stored evidence yet.\n"
      + "   That is not a clean sweep. A Node that has received no mail has nothing to verify, and this\n"
      + "   command cannot tell you anything about one until it does.\n\n",
    );
    return;
  }

  if (faults.length === 0) {
    process.stdout.write(
      `\n   ${checked} message(s) checked in ${batches} batch(es), ${megabytes} MiB read. Every one opened and\n`
      + "   hashed to what was recorded when it arrived.\n\n",
    );
    /*
     * Said explicitly, because it is the limit of what was just established. A clean sweep is a statement
     * about the objects D1 knows about; an R2 object with no receipt is invisible to it, and so is a message
     * that never reached ingress.
     */
    process.stdout.write(
      "   what this does not cover: an R2 object no receipt names, and anything that never reached ingress.\n\n",
    );
    return;
  }

  process.stdout.write(`\n   ${faults.length} fault(s) across ${checked} object(s) checked:\n\n`);
  for (const kind of ["altered", "missing", "unreadable"]) {
    const group = faults.filter((one) => one.kind === kind);
    if (group.length === 0) continue;
    process.stdout.write(`   ${kind} (${group.length})\n`);
    /*
     * The table as well as the row id (#131). This swept `ingress_receipts` only, so a bare id was
     * unambiguous; it now covers drafts, exports and sends, and an id with no table sends somebody looking
     * in the wrong one during an incident.
     */
    for (const fault of group) {
      process.stdout.write(`     ${fault.table ?? "?"}  ${fault.rowId}  ${fault.detail}\n`);
    }
    process.stdout.write("\n");
  }
  process.stderr.write(
    "  altered      the bytes changed after ingress. This does not happen by accident.\n"
    + "  missing      the evidence is gone; the row saying it existed is not.\n"
    + "  unreadable   the object names a key generation this vault cannot produce — the ADR 28 loss the\n"
    + "               recovery codes exist for. `mailda doctor` reports whether the escrow is current.\n\n",
  );
  process.exit(1);
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
async function runPreflight(argv, { announce = true } = {}) {
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
  if (origin === null) {
    problems.push({
      what: "the Node's URL is not known",
      why: "the canary is checked by overriding to it on the Node's own hostname — there is no preview URL "
        + "for a Worker with Durable Objects — so a deploy cannot verify what it is about to promote",
      fix: "pass `--url https://<your-node>`, or set MAILDA_URL",
    });
  } else {
    /*
     * Asked of the Node rather than assumed, and a **note** rather than a problem. A Node deployed before the
     * `version_metadata` binding existed cannot name itself, which does not stop a deploy: the canary carries
     * the new code and will name itself, and a fall-through to the incumbent then reports no version at all,
     * which is precisely what the gate refuses on. Worth saying in advance so the refusal is not a surprise.
     */
    const response = await fetch(`${origin}/api/doctor`, { headers: { accept: "application/json" } })
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
  return { ok: true, accountId: account.ok ? account.id : null, origin, report: null };
}

/** `mailda preflight` — the same checks, on their own, so they can be run before committing to a deploy. */
async function preflight(argv) {
  const outcome = await runPreflight(argv);
  if (!outcome.ok) fail(outcome.report);
  process.stdout.write("\n");
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
async function claimState(origin) {
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
function readSecret(prompt) {
  if (process.stdin.isTTY !== true) {
    fail("refusing to read a recovery code from a pipe — run this in a terminal.\n\n"
      + "  why      a code passed through a pipe or an argument is a code in a shell history, a process\n"
      + "           list, and whatever captured this session's output\n"
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

/* ------------------------------------------------------------------ backup ------------------------- */

/**
 * Takes a backup that can be restored into a **different** Cloudflare account (#92).
 *
 * ## Why the account matters
 *
 * Durable Object point-in-time recovery and D1 Time Travel both cover thirty days and both operate inside the
 * account that failed. #92 puts it plainly: *"A backup that only restores into the account that failed is not
 * a backup for a product whose selling point is that you own the account."* So this writes files an operator
 * holds, not a snapshot Cloudflare holds.
 *
 * ## Three files, and what each is for
 *
 *   `catalog.sql`      `wrangler d1 export`. The thing you restore. It carries the composition manifests, the
 *                      audit chain and the **wrapped vault escrow**, because all three are rows — which is why
 *                      the escrow had to exist before this was worth writing, and why #92's layers came in
 *                      that order.
 *   `inventory.jsonl`  every R2 object with the hash its plaintext should have. The bucket itself is not
 *                      copied here — a bucket-to-bucket copy is the operator's tool, and this is what makes
 *                      the result checkable object by object afterwards.
 *   `index.json`       what the other two should contain, with a SHA-256 of each, so `verify-backup` can tell
 *                      a complete copy from a truncated one without a Node.
 *
 * ## What this deliberately does not do
 *
 * **Copy the evidence bytes.** Streaming a mailbox's worth of R2 through a laptop is not a backup strategy,
 * and pretending otherwise would produce a command that works on a demo Node and fails on a real one. The
 * inventory is what turns somebody else's copy — `rclone`, an R2 bucket-to-bucket job — into a copy that can
 * be verified. That is the honest division, and the receipt says so.
 *
 * **Verify by default.** `--verify` runs the evidence sweep first and records what it found, which opens every
 * object and costs accordingly. Without it the index records `verified: null`, and `verify-backup` reports
 * that as *not asked* rather than as clean.
 */
async function backup(argv) {
  const ready = await runPreflight(argv);
  if (!ready.ok) fail(ready.report);
  const origin = ready.origin;

  const out = flag(argv, "out");
  if (out === null) {
    fail("usage: mailda backup --url https://your-node --out ./backup-2026-08-31\n"
      + "  why      a backup is files you hold. D1 Time Travel and Durable Object recovery both restore\n"
      + "           only into the account that failed, which is the one thing a customer-owned deployment\n"
      + "           has to survive losing\n"
      + "  fix      pass --out with a directory to write");
  }

  /*
   * The claim state first, because the answer changes what to ask for. On an unclaimed Node the credentials
   * this command needs cannot exist at all, and telling the operator to go and find them sends them after the
   * one thing that cannot work.
   */
  const unclaimed = whyAdminCannotExist({ claimed: await claimState(origin) === "unclaimed" ? false : true });
  if (unclaimed !== null) {
    fail(`${unclaimed.what}.\n\n  why      ${unclaimed.why}.\n  fix      ${unclaimed.fix}.`);
  }

  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email === undefined || password === undefined) {
    fail("set MAILDA_EMAIL and MAILDA_PASSWORD\n"
      + "  why      the inventory is administrator-only: it lists every object this organization holds\n"
      + "  fix      export them, then re-run");
  }
  const cookie = await sessionCookie(origin);
  if (cookie === null) fail("could not sign in, so the inventory cannot be read.");

  mkdirSync(out, { recursive: true });

  /*
   * Which tables to ask for, derived from the database rather than listed. `wrangler d1 export` refuses a
   * whole database that contains a virtual table — *"cannot export databases with Virtual Tables (fts5)"* —
   * and this catalog has two, so asking for the database exported nothing at all. Naming the tables is
   * accepted; the reasoning about which to leave out is in `exportableTables`.
   */
  process.stdout.write("\n== reading the catalog's shape\n");
  const schema = capture("npx", ["wrangler", "d1", "execute", "CATALOG", "--remote", "--json",
    "--command", "SELECT name, sql FROM sqlite_master WHERE type = 'table'", ...ENV], { quiet: true });
  if (schema.status !== 0) fail(`could not read the catalog's table list (exit ${schema.status}).`);
  let master;
  try {
    const parsed = JSON.parse(schema.text.slice(schema.text.indexOf("[")));
    master = parsed[0]?.results ?? [];
  } catch {
    fail("could not parse the catalog's table list. Nothing was written.");
  }
  const { included, excluded } = exportableTables(master);
  if (included.length === 0) fail("the catalog reported no exportable tables. Nothing was written.");
  process.stdout.write(`   ${included.length} table(s) to export, ${excluded.length} left out\n`);
  for (const one of excluded) process.stdout.write(`   omitting  ${one.name}  — ${one.why}\n`);

  process.stdout.write("\n== exporting the catalog\n");
  const catalogPath = `${out}/catalog.sql`;
  if (run("npx", ["wrangler", "d1", "export", "CATALOG", "--remote", "--output", catalogPath,
    "--skip-confirmation", "--no-schema", ...ENV,
    ...included.flatMap((name) => ["--table", name])]) !== 0) {
    fail("exporting D1 failed, so there is no backup. Nothing was written that could be mistaken for one.");
  }

  /*
   * **Data only.** The schema comes from the restoring Node's own migrations — ADR 24 makes the repository
   * the source of truth for it, and the runbook deploys before it restores, so the tables already exist.
   * Carrying `CREATE TABLE` as well would make every restore fail on its first statement.
   */
  const rebuild = needsIndexRebuild(master);
  if (rebuild) {
    process.stdout.write("\n   the search index is excluded and must be rebuilt after restoring\n");
  }

  process.stdout.write("\n== listing the evidence\n");
  let cursor = null;
  let objects = 0;
  let unaccounted = 0;
  const lines = [];
  for (;;) {
    const query = cursor === null ? "" : `?after=${encodeURIComponent(cursor)}`;
    const response = await fetch(`${origin}/api/evidence/inventory${query}`, {
      headers: { accept: "application/json", cookie },
    }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
    if (!response.ok) {
      fail(`/api/evidence/inventory answered ${response.status}, so the backup is incomplete and was not `
        + `indexed. ${objects} object(s) had been listed.`);
    }
    const page = await response.json();
    for (const object of page.objects ?? []) lines.push(JSON.stringify(object));
    objects += (page.objects ?? []).length;
    unaccounted += page.unaccounted ?? 0;
    /*
     * `\r` only on a terminal. Piped or captured, a carriage return is not a rewind — the drill's log read
     * `3 object(s)   3 object(s)   3 object(s) listed`, one copy per page, because nothing overwrote anything.
     */
    if (process.stdout.isTTY) process.stdout.write(`   ${objects} object(s)\r`);
    if (page.resumeAfter === null || page.resumeAfter === undefined) break;
    cursor = page.resumeAfter;
  }
  process.stdout.write(`   ${objects} object(s) listed\n`);

  let verified = null;
  if (argv.includes("--verify")) {
    process.stdout.write("\n== checking the evidence before recording it\n");
    let after = null;
    let checked = 0;
    let faults = 0;
    for (;;) {
      const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
      const response = await fetch(`${origin}/api/evidence/verify${query}`, {
        method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}",
      }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
      if (!response.ok) fail(`/api/evidence/verify answered ${response.status}; the backup was not indexed.`);
      const page = await response.json();
      checked += page.checked ?? 0;
      faults += (page.faults ?? []).length;
      for (const fault of page.faults ?? []) {
        process.stdout.write(`   ${fault.kind}  ${fault.table ?? "?"}  ${fault.rowId}  ${fault.detail}\n`);
      }
      if (page.resumeAfter === null || page.resumeAfter === undefined) break;
      after = page.resumeAfter;
    }
    verified = { checked, faults };
    process.stdout.write(`   ${checked} checked, ${faults} fault(s)\n`);
  }

  const inventoryText = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  writeFileSync(`${out}/inventory.jsonl`, inventoryText);

  const report = await doctorReport(origin, { cookie });
  const index = backupIndex({
    node: origin,
    nodeVersion: typeof report.version === "string" ? report.version : null,
    takenAt: new Date().toISOString(),
    catalog: readFileSync(catalogPath),
    inventory: inventoryText,
    objects,
    unaccounted,
    verified,
    excludedTables: excluded,
    rebuildSearchIndex: rebuild,
  });
  writeFileSync(`${out}/index.json`, `${JSON.stringify(index, null, 2)}\n`);

  process.stdout.write(
    `\n   written to ${out}\n`
    + `   catalog    ${index.catalog.bytes} bytes\n`
    + `   inventory  ${objects} object(s), ${unaccounted} named by no live row\n`
    + `   version    ${index.nodeVersion ?? "not reported by this Node"}\n`,
  );
  /*
   * The bucket, said plainly and last, because it is the half this command does not do and the half an
   * operator will assume it did. An inventory without the objects restores nothing.
   */
  process.stdout.write(
    "\n   the evidence bytes are NOT in this backup — copy the R2 bucket separately (rclone, or an R2\n"
    + "   bucket-to-bucket job). The inventory is what makes that copy checkable afterwards.\n\n",
  );
}

/**
 * Checks that a backup on disk is the one its index describes (#92).
 *
 * Reads the artifact and nothing else — no Node, no network — so it can run on the copy an operator keeps
 * rather than on the machine that took it. That is the point: the failures it catches are a truncated copy, a
 * partial download and a directory somebody edited, which is most of how a backup is discovered to be
 * useless, and all of it discoverable before the day it is needed.
 *
 * What it cannot establish is stated in its own output rather than left to a reader, because *"the backup
 * verified"* is the sentence somebody will remember on the day it matters.
 */
function verifyBackup(argv) {
  const dir = flag(argv, "in");
  if (dir === null) fail("usage: mailda verify-backup --in ./backup-2026-08-31");

  const read = (name) => {
    try {
      return readFileSync(`${dir}/${name}`);
    } catch {
      return null;
    }
  };
  const indexBytes = read("index.json");
  let index = null;
  if (indexBytes !== null) {
    try {
      index = JSON.parse(indexBytes.toString("utf8"));
    } catch {
      index = null;
    }
  }

  const outcome = checkBackup({ index, catalog: read("catalog.sql"), inventory: read("inventory.jsonl") });

  if (index !== null) {
    process.stdout.write(
      `\n== ${dir}\n`
      + `   taken       ${index.takenAt ?? "(unrecorded)"}\n`
      + `   from        ${index.node ?? "(unrecorded)"}\n`
      + `   version     ${index.nodeVersion ?? "not reported by that Node"}\n`
      + `   objects     ${index.inventory?.objects ?? "?"}\n`,
    );
  }
  for (const note of outcome.notes) process.stdout.write(`\n   note: ${note}\n`);

  if (!outcome.ok) {
    fail(
      `${outcome.problems.length} problem(s) with this backup.\n\n`
      + outcome.problems.map((one, at) => `  ${at + 1}. ${one.what}\n     fix      ${one.fix}`).join("\n\n"),
    );
  }

  process.stdout.write(
    "\n   this backup is the one its index describes: every file present, every hash matching.\n\n"
    + "   what that does not establish, said here rather than left implied:\n"
    + "     - that the evidence decrypts. The objects are not in the backup; the inventory lists them.\n"
    + "     - that the catalog restores. Both are properties of a restore, which is the step that makes\n"
    + "       the rest true.\n\n",
  );
}

const USAGE = `mailda — operate a Mailda Node

  mailda deploy [--url <origin>]     deploy, migrate, attach the events consumer, then check
  mailda doctor --url <origin>       what the Node says about itself; exit 0 ok, 1 degraded, 2 refuse
  mailda claim-secret [--local]      write the install secret and print it once
  mailda set-password <email>        set a password from the terminal, never echoed
  mailda recovery-codes rotate       mint ten replacement recovery codes, printed once
  mailda recovery-codes confirm      prove you hold one; compared, never spent
  mailda recovery-codes redeem       spend one to restore the key vault — the disaster path
  mailda search list                 what the body index failed on, and why
  mailda search repair --id <id>     put a message back in the body index's queue
  mailda backup --url <o> --out <d>   catalog, evidence inventory and an index you can check
  mailda verify-backup --in <dir>     is this backup the one its index describes
  mailda preflight [--url <origin>]  what a deploy needs, checked before it changes anything
  mailda verify-evidence --url <o>   open every stored message and check it against its ingress hash

Two things this cannot verify, said here rather than discovered later:

  the Workers plan            a Worker cannot read its account's plan and there is no documented API
                              for it, so ADR 25's requirement is unenforced. Check it in the dashboard.
  a sending domain onboarded  Cloudflare's onboarding is a dashboard flow with no endpoint listing the
                              result. Until one is onboarded a Node can only send to addresses already
                              verified in your account — it can receive a customer's message and be
                              unable to answer it.
`;

const [verb, ...rest] = process.argv.slice(2);
switch (verb) {
  case "deploy": await deploy(rest); break;
  case "doctor": process.exit(doctorExitCode(await doctor(rest))); break;
  case "claim-secret": claimSecret(rest); break;
  case "set-password": setPassword(rest); break;
  case "recovery-codes": await recoveryCodes(rest); break;
  case "backup": await backup(rest); break;
  case "verify-backup": verifyBackup(rest); break;
  case "preflight": await preflight(rest); break;
  case "verify-evidence": await verifyEvidence(rest); break;
  case "search": await search(rest); break;
  default:
    process.stdout.write(USAGE);
    process.exit(verb === undefined || verb === "--help" || verb === "-h" ? 0 : 1);
}
