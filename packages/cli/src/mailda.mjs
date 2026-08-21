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

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "../../../apps/node/worker");

function fail(message) {
  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
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

/* ------------------------------------------------------------------ deploy ------------------------- */

/**
 * The four steps an operator currently types by hand, in the order that works.
 *
 * The order is the whole value. Migrations after the deploy, because the Worker bundles them and a schema
 * ahead of the code it serves is a Node answering requests it cannot honour. The queue consumer after both,
 * because it attaches to a queue the deploy provisions — and out of band, because a consumer cannot name a
 * queue whose name Cloudflare derives (`queue-provisioning.md`). Doctor last, because it is the only step
 * that can tell you whether the other three worked.
 *
 * **It does not refuse Workers Free**, and the README no longer says it does. A Worker cannot read its
 * account's plan and this CLI has no documented endpoint for it either; the honest state is unverified,
 * which is now what `doctor` reports.
 */
async function deploy(argv) {
  const steps = [
    ["deploying the Worker", "npx", ["wrangler", "deploy"]],
    ["applying migrations", "npx", ["wrangler", "d1", "migrations", "apply", "CATALOG", "--remote"]],
    ["attaching the delivery-events consumer", "node", ["scripts/attach-queue-consumer.mjs"]],
  ];

  for (const [what, command, args] of steps) {
    process.stdout.write(`\n== ${what}\n`);
    const status = run(command, args);
    if (status !== 0) {
      fail(`${what} failed (exit ${status}). Nothing after this step ran.`);
    }
  }

  const origin = flag(argv, "url") ?? process.env.MAILDA_URL ?? null;
  if (origin === null) {
    process.stdout.write(
      "\n== skipping the health check\n"
      + "   Pass --url https://your-node.workers.dev to finish with `mailda doctor`.\n"
      + "   A deploy that ran is not a Node that works, and only the Node can tell you which it is.\n",
    );
    return;
  }
  process.stdout.write("\n== asking the Node how it is\n");
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
