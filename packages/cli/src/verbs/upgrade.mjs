import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { contractingAmong } from "../deploy-parse.mjs";
import { WRANGLER_ARGS, capture, configFor, fail, flag, readSecret, run, useConfig, workerDir } from "../support.mjs";
import { distance, pendingByPhase, releaseRemote } from "../upgrade-parse.mjs";
import { backup } from "./backup.mjs";
import { deploy, firstInstall } from "./deploy.mjs";
import { ask, existingNodes, rememberUrl, rememberedUrl, signInAndChooseAccount } from "./install.mjs";

const REPO = resolve(workerDir, "../../..");

/**
 * `mailda upgrade`: bring a Node that exists up to the code this clone can have, with a backup first.
 *
 * `mailda install` already upgrades when given an existing name, and it does so with whatever code is in
 * the clone. That is the landmine this verb removes: an operator who never pulled gets a canary, a gate, a
 * promotion and the word "upgraded", and nothing changed. So the first thing this does is ask git whether
 * there is anything to upgrade *to*, and it says "already current" and stops when there is not.
 *
 * The second thing it adds is the backup. The deploy applies expand-phase migrations to the live catalog
 * before the canary is even uploaded, and a backfill runs in place on the customer's only copy of their
 * mail. `mailda backup` exists for exactly the day one of those is wrong, so it runs here, before, every
 * time, into a git-ignored directory under `.mailda/`; an upgrade that cannot take one does not proceed.
 *
 * Then the pending migrations are listed by phase, because "what will this do to my data" is a question
 * the operator is entitled to have answered on screen before agreeing, and the deploy proper runs: expand,
 * canary, gate, promote. Nothing in the mechanism is new; `mailda deploy` is called, not copied.
 */
export async function upgrade(argv) {
  process.stdout.write("\n== mailda upgrade\n   Pull the release, back the Node up, list what its schema will do, then deploy through the canary.\n");
  const yes = argv.includes("--yes");

  // 1. Is there anything to upgrade to. The release channel is the git remote, and nothing else (ADR 43).
  const remote = releaseRemote(git(["remote", "-v"]).text);
  if (remote === null) {
    fail("this clone has no remote pointing at Straits-AI/mailda, so there is no release to pull.\n\n"
      + "  why      a deploy-button clone has no history and no remote; the README's \"Updating an installed\n"
      + "           Node\" section has the one-time merge that gives it one\n"
      + "  fix      git remote add upstream https://github.com/Straits-AI/mailda.git, follow that section once,\n"
      + "           then re-run");
  }
  if (git(["fetch", "--quiet", remote, "main"]).status !== 0) fail(`could not fetch ${remote}; is the network up?`);
  const where = distance(git(["rev-list", "--left-right", "--count", `HEAD...${remote}/main`]).text);
  if (where === null) {
    fail(`could not compare this clone with ${remote}/main.\n\n`
      + "  why      the histories may be unrelated, which is what a deploy-button clone has before its first merge\n"
      + "  fix      the README's \"Updating an installed Node\" section, once; every later upgrade is this command");
  }
  process.stdout.write(`\n   code      ${where.behind === 0 ? "current" : `${where.behind} release commit(s) behind`}`
    + `${where.ahead > 0 ? `, ${where.ahead} local commit(s) ahead` : ""}\n`);
  if (where.behind === 0 && !argv.includes("--force")) {
    process.stdout.write("   Nothing to upgrade to. --force deploys this clone's code anyway.\n\n");
    return;
  }
  if (where.behind > 0) {
    if (git(["status", "--porcelain"]).text.trim() !== "") {
      fail("this clone has uncommitted changes, so the release cannot be pulled over them.\n\n"
        + "  fix      commit or stash them, then re-run");
    }
    if (git(["merge", "--ff-only", `${remote}/main`]).status !== 0) {
      fail(`this clone has its own commits, so ${remote}/main cannot be fast-forwarded onto it.\n\n`
        + `  fix      git merge ${remote}/main yourself, resolve what conflicts (package.json is the only file that\n`
        + "           should), then re-run");
    }
    process.stdout.write(`   pulled    ${git(["rev-parse", "--short", "HEAD"]).text.trim()}\n`);
    process.stdout.write("\n== installing dependencies\n");
    if (run("pnpm", ["install", "--frozen-lockfile"], { cwd: REPO }) !== 0) fail("pnpm install failed; nothing was deployed.");
  }

  // 2. Which account, which Node. The name must already be a Node: an upgrade never creates one.
  await signInAndChooseAccount();
  const base = configFor([]).name;
  const existing = existingNodes();
  if (existing.length > 0) {
    process.stdout.write(`\n== this account's ${existing.length === 1 ? "Node" : "Nodes"}\n`);
    for (const one of existing) process.stdout.write(`   ${one}\n`);
  }
  const suggested = flag(argv, "name") ?? process.env.MAILDA_NODE_NAME ?? (existing.length === 1 ? existing[0] : base);
  const name = yes || flag(argv, "name") !== null ? suggested : ((await ask(`\n   Node to upgrade [${suggested}]: `)).trim() || suggested);
  const nameArgs = name === base ? [] : ["--name", name];
  useConfig(configFor(nameArgs));
  if (firstInstall()) {
    fail(`\`${name}\` is not a Node in this account, and an upgrade never creates one.\n\n  fix      mailda install, which does`);
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const remembered = rememberedUrl(accountId, name);
  const given = flag(argv, "url") ?? process.env.MAILDA_URL ?? remembered ?? "";
  const url = (given !== "" || yes ? given : (await ask("   its URL (https://<your-node>): ")).trim()).replace(/\/$/, "");
  if (!/^https:\/\/\S+$/.test(url)) fail(`"${url}" is not a URL; the backup and the canary both need the Node's own hostname.`);
  process.env.MAILDA_URL = url;
  rememberUrl(accountId, name, url);
  process.stdout.write(`   node      ${name}  ${url}\n`);

  // 3. The backup, before anything touches the catalog. Administrator credentials, because the inventory it
  //    indexes is administrator-only; they also let the canary gate below see the whole doctor report.
  if (process.env.MAILDA_EMAIL === undefined || process.env.MAILDA_PASSWORD === undefined) {
    if (yes) fail("--yes needs MAILDA_EMAIL and MAILDA_PASSWORD, for the backup and the canary gate.");
    process.stdout.write("\n== an administrator, for the backup\n");
    process.env.MAILDA_EMAIL = (await ask("   email: ")).trim();
    process.env.MAILDA_PASSWORD = await readSecret("   password (not echoed): ");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = flag(argv, "backup-out") ?? resolve(REPO, ".mailda", "backups", name, stamp);
  process.stdout.write(`\n== backing up first\n   into ${out}\n`);
  await backup(["--url", url, "--out", out, ...nameArgs]);
  process.stdout.write(`   backup    ${out}\n   restore   docs/disaster-recovery.md, if the upgrade goes wrong\n`);

  // 4. What the schema will do to the data, on screen, before agreeing.
  const listed = capture("npx", ["wrangler", "d1", "migrations", "list", "CATALOG", "--remote", ...WRANGLER_ARGS], { quiet: true });
  if (listed.status !== 0) fail(`could not list pending migrations:\n${listed.text}`);
  const migrationsDir = resolve(workerDir, "migrations");
  const names = readdirSync(migrationsDir).filter((one) => one.endsWith(".sql"));
  const phases = pendingByPhase(listed.text, names, contractingAmong(listed.text, migrationsDir));
  process.stdout.write("\n== what this does to the catalog\n");
  if (phases.expand.length + phases.contract.length === 0) process.stdout.write("   no schema change; the code only\n");
  for (const one of phases.expand) process.stdout.write(`   expand    ${one}  (adds; safe for the running version)\n`);
  for (const one of phases.contract) process.stdout.write(`   contract  ${one}  (drops or narrows; refused unless --contract)\n`);
  process.stdout.write("   The expansions run on the live catalog before the new version is uploaded; the canary is\n"
    + "   then checked and promoted only if doctor is no worse than today's. Contractions wait for --contract.\n");

  const go = yes ? "y" : await ask("\n   upgrade now? [y/N]: ");
  if (!/^y(es)?$/i.test(go.trim())) { process.stdout.write("   nothing was changed; the backup stays.\n\n"); return; }
  await deploy([...nameArgs, "--url", url, ...(argv.includes("--contract") ? ["--contract"] : [])]);
  process.stdout.write(`\n== upgraded\n   ${name} at ${url}; backup from before it at ${out}\n\n`);
}

function git(args) {
  return capture("git", args, { cwd: REPO, quiet: true });
}
