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
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { contractingAmong, previewUrlFrom, shouldPromote, versionIdFrom } from "./deploy-parse.mjs";

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
function capture(command, args, { cwd = workerDir } = {}) {
  const outcome = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (outcome.error !== undefined) fail(`could not run ${command}: ${outcome.error.message}`);
  const text = `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`;
  process.stdout.write(text);
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
 * The canary's verdict, without exiting the process.
 *
 * `doctor` above ends in `process.exit`, which is right for a command somebody runs and wrong for a gate in
 * the middle of a sequence — exiting there would leave a canary uploaded, unpromoted and unexplained. This
 * asks the same route and returns the word, so the caller decides what a `degraded` means.
 *
 * Deliberately **unauthenticated**. A canary has never been signed into and `MAILDA_EMAIL` would sign in to
 * the *live* Node, not this version — so the reduced report (`withoutDataFindings`) is what this reads, which
 * is the right amount: it carries every `infrastructure` finding, including the bindings and schema checks
 * that are what a fresh version can get wrong.
 */
async function doctorVerdict(origin) {
  const response = await fetch(`${origin.replace(/\/$/, "")}/api/doctor`, {
    headers: { accept: "application/json" },
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
  return report.verdict ?? "refuse";
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
 * decides whether traffic moves, which is why it can no longer be skipped by omitting `--url`.
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
   * Expansion first, because it is safe ahead of the code by construction, and refuse a contraction unless
   * the operator said so. A pending `-- phase: contract` migration applied here would break the version
   * currently serving — before the canary has even been uploaded, and while nothing has gone wrong yet.
   */
  process.stdout.write("\n== checking which migrations are pending\n");
  const pending = capture("npx", ["wrangler", "d1", "migrations", "list", "CATALOG", "--remote"]);
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
  if (run("npx", ["wrangler", "d1", "migrations", "apply", "CATALOG", "--remote"]) !== 0) {
    fail("applying migrations failed. Nothing was deployed, so the version currently serving is unchanged.");
  }

  /*
   * The canary. `--preview-alias` gives it a stable hostname to check, rather than a per-version URL that
   * would have to be scraped out of wrangler's prose.
   */
  process.stdout.write("\n== uploading a canary version (no traffic)\n");
  const uploaded = capture("npx", [
    "wrangler", "versions", "upload", "--preview-alias", "canary", "--message", "mailda deploy",
  ]);
  if (uploaded.status !== 0) {
    fail(`uploading the canary failed (exit ${uploaded.status}). No traffic moved.`);
  }
  const version = versionIdFrom(uploaded.text);
  const canaryUrl = previewUrlFrom(uploaded.text);
  if (version === null) {
    fail(
      "could not find the new version's id in wrangler's output.\n\n"
      + "  why      the id is what promotes this version, and guessing it would promote something else.\n"
      + "  fix      the canary is uploaded and serving no traffic, so nothing is broken. Read the id from\n"
      + "           the output above and finish with `wrangler versions deploy <id>@100`.",
    );
  }

  /*
   * The gate. Against the **canary**, not the live Node: checking the version that is already serving would
   * pass whatever the new one does, which is the shape of a check that reads as a check.
   */
  if (canaryUrl === null) {
    fail(
      "could not find the canary's preview URL in wrangler's output.\n\n"
      + "  why      the canary cannot be checked without one, and promoting an unchecked version is the\n"
      + "           thing this sequence exists to prevent.\n"
      + `  fix      the canary is uploaded and serving no traffic. Check it by hand, then promote with\n`
      + `           \`wrangler versions deploy ${version}@100\`.`,
    );
  }
  process.stdout.write(`\n== asking the canary how it is (${canaryUrl})\n`);
  const verdict = await doctorVerdict(canaryUrl);
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
  if (run("npx", ["wrangler", "versions", "deploy", `${version}@100`, "--yes"]) !== 0) {
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

  const origin = flag(argv, "url") ?? process.env.MAILDA_URL ?? null;
  if (origin !== null) {
    process.stdout.write("\n== asking the live Node how it is\n");
    await doctor(["--url", origin]);
  }
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

/* ------------------------------------------------------------------ dispatch ----------------------- */

const USAGE = `mailda — operate a Mailda Node

  mailda deploy [--url <origin>]     deploy, migrate, attach the events consumer, then check
  mailda doctor --url <origin>       what the Node says about itself; exit 0 ok, 1 degraded, 2 refuse
  mailda claim-secret [--local]      write the install secret and print it once
  mailda set-password <email>        set a password from the terminal, never echoed

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
  default:
    process.stdout.write(USAGE);
    process.exit(verb === undefined || verb === "--help" || verb === "-h" ? 0 : 1);
}
