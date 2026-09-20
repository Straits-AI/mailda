import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { accountsFrom, signedIn } from "../preflight.mjs";
import { capture, configFor, fail, flag, run, useConfig, workerDir } from "../support.mjs";
import { deploy, firstInstall, installedUrl } from "./deploy.mjs";

/**
 * `mailda install`: the first run, as one conversation (#269).
 *
 * The README used to say three commands, and it was wrong twice: `queue:attach-consumer` is something a
 * first deploy already does, and the claim secret, which is the one thing a person cannot get past without,
 * was not among them. This asks the questions a first install has (which account, if several; sign in, if
 * not), runs the deploy, seeds the claim secret, and ends with the URL and the secret side by side, opened
 * in a browser where one exists. Nothing here is new authority: every step is a verb that already exists.
 *
 * A second Node in the same account is `--name <worker>`, the same flag `mailda deploy` takes: the deploy
 * derives that Node's config, and the claim secret is seeded into that Node's catalog rather than the first's.
 */
export async function install(argv) {
  process.stdout.write("\n== mailda install\n   One Node, in your Cloudflare account. Nothing is changed until the deploy step.\n");

  // 1. Signed in to Cloudflare. wrangler's own login opens a browser and waits; the terminal is theirs.
  let whoami = capture("npx", ["wrangler", "whoami"], { quiet: true });
  if (!signedIn(whoami.text)) {
    process.stdout.write("\n== signing in to Cloudflare\n   A browser opens. Approve wrangler there, then come back here.\n\n");
    if (run("npx", ["wrangler", "login"]) !== 0) fail("wrangler could not sign in.");
    whoami = capture("npx", ["wrangler", "whoami"], { quiet: true });
    if (!signedIn(whoami.text)) fail("still not signed in after `wrangler login`.");
  }

  // 2. Which account. One needs no question; several need a person's answer, and it is kept for the rest
  //    of this process only, since the id is a fact about their account and not about this clone.
  const accounts = accountsFrom(whoami.text);
  const chosen = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (chosen === "" && accounts.length > 1) {
    process.stdout.write("\n== which Cloudflare account\n");
    accounts.forEach((one, i) => process.stdout.write(`   ${i + 1}. ${one.name}  ${one.id}\n`));
    const answer = await ask(`   number [1-${accounts.length}]: `);
    const picked = accounts[Number(answer) - 1];
    if (picked === undefined) fail(`"${answer}" is not one of the numbers above.`);
    process.env.CLOUDFLARE_ACCOUNT_ID = picked.id;
  } else if (chosen === "" && accounts.length === 1) {
    process.env.CLOUDFLARE_ACCOUNT_ID = accounts[0].id;
  }
  const account = accounts.find((one) => one.id.toLowerCase() === (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").toLowerCase());
  process.stdout.write(`\n   account   ${account?.name ?? "?"}  ${process.env.CLOUDFLARE_ACCOUNT_ID ?? "(not chosen)"}\n`);
  process.stdout.write("   plan      Workers Paid is required to send mail; the Free plan deletes queued delivery events after a day.\n");

  // 3. Which Node. A name, chosen freely, with `mailda` as the default; and whether that name is already a
  //    Node in this account. Every Mailda Node registers a Workflow whose class is `ButlerRun`, so the
  //    account's Nodes are the script names on those rows of `wrangler workflows list`, and the question
  //    "upgrade or add one" is answered by the name rather than asked as a flag. The name is validated by
  //    the same rule `mailda deploy --name` uses, and the derived config is applied *before* the
  //    first-install probe, which asks wrangler whether *this* Worker exists.
  const base = configFor([]).name;
  const existing = existingNodes();
  if (existing.length > 0) {
    process.stdout.write(`\n== this account already has ${existing.length === 1 ? "a Node" : "Nodes"}\n`);
    for (const one of existing) process.stdout.write(`   ${one}\n`);
    process.stdout.write("   Choose one of them to upgrade it, or a new name to add another.\n");
  }
  const suggested = flag(argv, "name") ?? process.env.MAILDA_NODE_NAME ?? base;
  const name = argv.includes("--yes") || flag(argv, "name") !== null
    ? suggested
    : ((await ask(`\n   name for this Node [${suggested}]: `)).trim() || suggested);
  const nameArgs = name === base ? [] : ["--name", name];
  useConfig(configFor(nameArgs));
  const upgrading = !firstInstall();
  process.stdout.write(`\n   node      ${name}  ${upgrading ? "(exists: this run upgrades it)" : "(new)"}\n`);

  //    An upgrade uploads a version and checks it as a canary on the Node's own hostname, so it needs the
  //    URL. Asked once per Node on this machine and remembered in a git-ignored file, because a Node's URL
  //    does not change between upgrades and a question with a known answer is noise.
  if (upgrading) {
    const remembered = rememberedUrl(process.env.CLOUDFLARE_ACCOUNT_ID ?? "", name);
    const given = flag(argv, "url") ?? process.env.MAILDA_URL ?? remembered ?? "";
    const url = given !== "" || argv.includes("--yes")
      ? given
      : (await ask("   its URL (https://<your-node>): ")).trim();
    if (!/^https:\/\/\S+$/.test(url)) fail(`"${url}" is not a URL; the canary upgrade is checked on the Node's own hostname. Re-run and give it, or set MAILDA_URL.`);
    process.env.MAILDA_URL = url.replace(/\/$/, "");
    // Remembered now, not after the deploy: an operator who answers and then declines should not be asked again.
    rememberUrl(process.env.CLOUDFLARE_ACCOUNT_ID ?? "", name, process.env.MAILDA_URL);
    process.stdout.write(`   url       ${process.env.MAILDA_URL}${remembered !== null && given === remembered ? "  (remembered)" : ""}\n`);
  }
  const go = argv.includes("--yes") ? "y" : await ask(`\n   ${upgrading ? "upgrade" : "deploy"} now? [y/N]: `);
  if (!/^y(es)?$/i.test(go.trim())) { process.stdout.write("   nothing was changed.\n\n"); return; }
  await deploy(nameArgs);
  const url = installedUrl ?? process.env.MAILDA_URL ?? null;
  if (url !== null) rememberUrl(process.env.CLOUDFLARE_ACCOUNT_ID ?? "", name, url);

  // 4. The claim secret. Printed once by the script, captured here so it can sit beside the URL.
  process.stdout.write("\n== the claim secret\n");
  const seeded = capture("node", ["--experimental-strip-types", "scripts/seed-claim-secret.mjs", ...nameArgs], { quiet: true });
  const secret = /^\s{2}([A-Za-z0-9_-]{40,})\s*$/m.exec(seeded.text)?.[1] ?? null;
  if (seeded.status !== 0 || secret === null) {
    process.stdout.write(seeded.text);
    if (/already/.test(seeded.text)) {
      process.stdout.write(`\n   This Node already has a claim secret or an owner. Open ${url ?? "your Node"} to continue.\n\n`);
      return;
    }
    fail("could not seed the claim secret; `mailda claim-secret` retries it.");
  }

  process.stdout.write(
    "\n== done\n"
    + `   your Node   ${url ?? "(wrangler did not print the URL; `wrangler deployments list` shows it)"}\n`
    + `   secret      ${secret}\n\n`
    + "   Open the URL, paste the secret, and choose the first administrator's email and password.\n"
    + "   The secret is shown here once and only its hash is stored. Ten recovery codes follow the claim;\n"
    + "   keep them, they are the only way back in without a password.\n\n",
  );
  if (url !== null && !argv.includes("--no-open")) openInBrowser(url);
}

/**
 * The Mailda Nodes this account holds: the script name of every Workflow whose class is `ButlerRun`, which
 * every Node registers under its own name. Empty when the list cannot be read; the per-name probe that
 * follows still decides, so an unreadable list costs a suggestion and not a wrong path.
 */
function existingNodes() {
  const listed = capture("npx", ["wrangler", "workflows", "list"], { quiet: true });
  if (listed.status !== 0) return [];
  return listed.text.split("\n")
    .map((line) => line.split("│").map((cell) => cell.trim()).filter(Boolean))
    .filter((cells) => cells[2] === "ButlerRun")
    .map((cells) => cells[1])
    .filter((one, i, all) => typeof one === "string" && all.indexOf(one) === i)
    .sort();
}

/** `.mailda/nodes.json` at the clone's root, git-ignored: `{ "<account>/<name>": "<url>" }`. */
const NODES_FILE = resolve(workerDir, "../../..", ".mailda", "nodes.json");
function rememberedUrl(accountId, name) {
  try { return JSON.parse(readFileSync(NODES_FILE, "utf8"))[`${accountId}/${name}`] ?? null; } catch { return null; }
}
function rememberUrl(accountId, name, url) {
  let all = {};
  try { all = JSON.parse(readFileSync(NODES_FILE, "utf8")); } catch { /* first Node remembered on this machine */ }
  mkdirSync(dirname(NODES_FILE), { recursive: true });
  writeFileSync(NODES_FILE, `${JSON.stringify({ ...all, [`${accountId}/${name}`]: url }, null, 2)}\n`);
}

async function ask(prompt) {
  if (process.stdin.isTTY !== true) {
    fail("mailda install asks questions; run it in a terminal, or pass --yes with CLOUDFLARE_ACCOUNT_ID set "
      + "(and MAILDA_URL, when the account already has a Node).");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(prompt); } finally { rl.close(); }
}

/** Best effort, by platform; a failure to open is not a failure to install. */
function openInBrowser(url) {
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawnSync(command, args, { stdio: "ignore" });
}
