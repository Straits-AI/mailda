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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  activeVersionFrom, contractingAmong, servedVersionOf, shouldPromote, versionIdFrom,
} from "./deploy-parse.mjs";
import {
  accountsFrom, atLeast, reportsItsVersion, resolveAccount, signedIn, wranglerVersionFrom,
} from "./preflight.mjs";
import { BUDGETS } from "@mailda/budgets";

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
  const verdict = wantsJson ? JSON.parse(body).verdict : body.split(/\s+/)[2]?.toLowerCase();
  // The exit code is the verdict, so this is usable in a deploy script or a health check.
  process.exit(verdict === "refuse" ? 2 : verdict === "degraded" ? 1 : 0);
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
 * Deliberately **unauthenticated**. A canary has never been signed into and `MAILDA_EMAIL` would sign in to
 * the *live* Node, not this version — so the reduced report (`withoutDataFindings`) is what this reads, which
 * is the right amount: it carries every `infrastructure` finding, including the bindings and schema checks
 * that are what a fresh version can get wrong.
 */
async function doctorReport(origin, extraHeaders = {}) {
  const response = await fetch(`${origin.replace(/\/$/, "")}/api/doctor`, {
    headers: { accept: "application/json", ...extraHeaders },
  }).catch((error) => fail(`could not reach the canary at ${origin}: ${error.message}`));
  const text = await response.text();
  if (!response.ok && response.status !== 503) {
    fail(
      `the canary answered ${response.status} at /api/doctor\n${text.slice(0, 400)}\n\n`
      + "  why      an unreachable or unreadable canary is not a version to move traffic to\n"
      + "  fix      the previous version is still serving; nothing was promoted",
    );
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    fail(`the canary's report was not JSON:\n${text.slice(0, 400)}`);
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
      await doctor(["--url", origin]);
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
  const report = await doctorReport(origin, {
    "Cloudflare-Workers-Version-Overrides": `mailda="${version}"`,
  });
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
  const verdict = report.verdict ?? "refuse";
  if (!shouldPromote(verdict)) {
    fail(
      `the canary reports \`${verdict}\`, so traffic was not moved.\n\n`
      + "  why      the version that was serving before this command ran is still the one serving. There is\n"
      + "           nothing to roll back, which is why the canary is uploaded before it is promoted.\n"
      + "  fix      read the findings above. To promote it anyway once you have decided the finding is\n"
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
  await doctor(["--url", origin]);
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
  if (action !== "rotate" && action !== "confirm") {
    fail("usage: mailda recovery-codes rotate|confirm --url https://your-node.workers.dev\n"
      + "  rotate   mint ten replacement codes and print them once\n"
      + "  confirm  type one back, proving you hold the set. Compared, never spent\n"
      + "  why      the codes open the escrow holding this Node's content and credential keys. They are\n"
      + "           shown once, so an unconfirmed set is one nobody can prove reached a human\n"
      + "  fix      set MAILDA_EMAIL and MAILDA_PASSWORD, then pass --url");
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

  const signIn = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
  if (!signIn.ok) fail(`sign-in failed (${signIn.status}) — these routes need an administrator`);
  const token = (await signIn.json()).access_token;

  const post = async (path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
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

  const typed = flag(argv, "code");
  if (typed === undefined) {
    fail("pass --code <one of the codes>\n"
      + "  why      confirmation is proof you hold the sheet. It compares against the stored hash and does\n"
      + "           not spend the code, so all ten stay usable\n"
      + "  fix      mailda recovery-codes confirm --url <origin> --code XXXX-XXXX-...");
  }
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

  const signIn = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
  if (!signIn.ok) fail(`sign-in failed (${signIn.status}) — these routes need an administrator`);
  const token = (await signIn.json()).access_token;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

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

  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email === undefined || password === undefined) {
    fail("set MAILDA_EMAIL and MAILDA_PASSWORD\n"
      + "  why      the route is administrator-only: what it reports is how much of the whole\n"
      + "           organization's evidence is intact, which is not a mailbox grant\n"
      + "  fix      export them, then re-run");
  }

  const signIn = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
  if (!signIn.ok) fail(`sign-in failed (${signIn.status}) — this route needs an administrator`);
  const token = (await signIn.json()).access_token;

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
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
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

  process.stdout.write(`\n   ${faults.length} fault(s) across ${checked} message(s) checked:\n\n`);
  for (const kind of ["altered", "missing", "unreadable"]) {
    const group = faults.filter((one) => one.kind === kind);
    if (group.length === 0) continue;
    process.stdout.write(`   ${kind} (${group.length})\n`);
    for (const fault of group) process.stdout.write(`     ${fault.receiptId}  ${fault.detail}\n`);
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

const USAGE = `mailda — operate a Mailda Node

  mailda deploy [--url <origin>]     deploy, migrate, attach the events consumer, then check
  mailda doctor --url <origin>       what the Node says about itself; exit 0 ok, 1 degraded, 2 refuse
  mailda claim-secret [--local]      write the install secret and print it once
  mailda set-password <email>        set a password from the terminal, never echoed
  mailda recovery-codes rotate       mint ten replacement recovery codes, printed once
  mailda recovery-codes confirm      prove you hold one; compared, never spent
  mailda search list                 what the body index failed on, and why
  mailda search repair --id <id>     put a message back in the body index's queue
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
  case "doctor": await doctor(rest); break;
  case "claim-secret": claimSecret(rest); break;
  case "set-password": setPassword(rest); break;
  case "recovery-codes": await recoveryCodes(rest); break;
  case "preflight": await preflight(rest); break;
  case "verify-evidence": await verifyEvidence(rest); break;
  case "search": await search(rest); break;
  default:
    process.stdout.write(USAGE);
    process.exit(verb === undefined || verb === "--help" || verb === "-h" ? 0 : 1);
}
