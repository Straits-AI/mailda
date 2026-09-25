import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { accountsFrom, signedIn } from "../preflight.mjs";
import { api, capture, choose, configFor, fail, flag, readSecret, run, useConfig, workerDir } from "../support.mjs";
import { deploy, firstInstall, installedUrl } from "./deploy.mjs";
import { provisionNode, wranglerToken } from "./provision.mjs";

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
 *
 * **It goes on to claim the Node and give it its Cloudflare grant** (23 September 2026, ADR 42 as amended).
 * The claim is `POST /api/claim` from here, with the secret this run just seeded, so the recovery codes are
 * printed in the same terminal and the session it answers with is what the next step signs in with. The
 * grant used to be a dashboard form of twelve fields, filled after the install from the Node's Setup screen.
 * **Since 25 September 2026 the account work happens here, with wrangler's login**, and the grant is
 * optional. After the claim, one question — which domain receives — and the Node is set up to receive, send
 * and observe outcomes through its own provisioning routes, carrying wrangler's token for each request
 * (`provision.mjs`). The grant, one API token the operator makes by hand, is only for changing that setup
 * from the browser later; Enter skips it and nothing below needs it. Under `--yes`, `CLOUDFLARE_API_TOKEN`
 * is the operator token for the account work and `MAILDA_GRANT_TOKEN` is the grant step's. Every step still has its own verb
 * (`mailda claim-secret`, `mailda provider`) and the Setup screen keeps the printed steps, for the deploy
 * button path and for an operator who declines here.
 */
export async function install(argv) {
  process.stdout.write("\n== mailda install\n   One Node, in your Cloudflare account. Nothing is changed until the deploy step.\n");

  await signInAndChooseAccount();

  // 3. Which Node. A name, chosen freely, with `mailda` as the default; and whether that name is already a
  //    Node in this account. Every Mailda Node registers a Workflow whose class is `ButlerRun`, so the
  //    account's Nodes are the script names on those rows of `wrangler workflows list`, and the question
  //    "upgrade or add one" is answered by the name rather than asked as a flag. The name is validated by
  //    the same rule `mailda deploy --name` uses, and the derived config is applied *before* the
  //    first-install probe, which asks wrangler whether *this* Worker exists.
  const base = configFor([]).name;
  const existing = existingNodes();
  const suggested = flag(argv, "name") ?? process.env.MAILDA_NODE_NAME ?? base;
  let name = suggested;
  if (!argv.includes("--yes") && flag(argv, "name") === null) {
    // Existing Nodes are rows to point at; a new one is typed. One list, so the choice between upgrading
    // and adding is made by pointing rather than by spelling a name that happens to match.
    const picked = existing.length === 0 ? "" : await choose("\n   this run is for:", [
      ...existing.map((one) => ({ label: `${one}  (upgrade it)`, value: one })),
      { label: "a new Node, named below", value: "" },
    ]);
    name = picked !== "" ? picked : ((await ask(`   name for the new Node [${suggested}]: `)).trim() || suggested);
  }
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

  // 5. The claim, from here. Skipped when the Node's URL is unknown or the operator declines; then the
  //    ending is the one it always was, and the browser's claim page does the same thing.
  const yes = argv.includes("--yes");
  const claimHere = url !== null && (yes
    ? process.env.MAILDA_EMAIL !== undefined && process.env.MAILDA_PASSWORD !== undefined
    : /^y(es)?$/i.test((await ask("\n== claim the Node\n   Choose the first administrator here, now? [Y/n]: ")).trim() || "y"));
  if (!claimHere) {
    process.stdout.write(
      "\n== done\n"
      + `   your Node   ${url ?? "(wrangler did not print the URL; `wrangler deployments list` shows it)"}\n`
      + `   secret      ${secret}\n\n`
      + "   Open the URL, paste the secret, and choose the first administrator's email and password.\n"
      + "   The secret is shown here once and only its hash is stored. Ten recovery codes follow the claim;\n"
      + "   keep them, they are the only way back in without a password.\n\n",
    );
    if (url !== null && !argv.includes("--no-open")) openInBrowser(url);
    return;
  }
  const claimed = await claim(url, secret, yes);
  process.stdout.write(
    "\n   claimed. These ten recovery codes are shown once and never again; they are the only way back in\n"
    + "   without a password, and the only thing that can reopen the key vault after a disaster.\n\n"
    + claimed.recoveryCodes.map((code) => `      ${code}\n`).join("") + "\n",
  );

  // 6. The account work, with the consent wrangler already has: receiving, sending, delivery outcomes.
  process.stdout.write(
    "\n== setting up receiving, sending and delivery outcomes\n"
    + "   Uses the consent you already gave wrangler; nothing is changed before the plan is shown.\n",
  );
  const setUp = await provisionNode({
    origin: url, cookie: claimed.cookie, accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: await wranglerToken(), yes, ask,
  });

  // 7. The Cloudflare grant, optional: the OAuth client, created through the API from one token.
  const connected = await grant(url, name, claimed.cookie, yes, !argv.includes("--no-open"));

  process.stdout.write(
    "\n== done\n"
    + `   your Node   ${url}\n`
    + `   signed in   ${claimed.email}\n`
    + `   receiving   ${setUp.receiving ?? "not set up; the Setup screen or mailda provider does it"}\n`
    + `   sending     ${setUp.sending ?? "not set up"}\n`
    + `   outcomes    ${setUp.deliveryEvents ?? "not subscribed"}\n`
    + (connected === null
      ? "   grant       not yet: the Setup screen in the Node prints the steps, or re-run this install\n"
      : `   grant       consent opened in the browser; if it did not open, visit\n               ${connected}\n`)
    + "\n",
  );
  if (!argv.includes("--no-open")) openInBrowser(connected ?? url);
}

/**
 * `POST /api/claim` with the secret this run seeded. Asked for the organization's name, the administrator's
 * email and a password typed twice with echo off; a password the Node calls weak is explained in the Node's
 * words and asked again, because the claim is the irreversible step and a wrong answer must not spend it.
 */
async function claim(origin, secret, yes) {
  const email = yes ? process.env.MAILDA_EMAIL : (await ask("   administrator email: ")).trim();
  const organization = yes ? (process.env.MAILDA_ORGANIZATION ?? "Mailda")
    : ((await ask("   organization name [Mailda]: ")).trim() || "Mailda");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let password = process.env.MAILDA_PASSWORD;
    if (!yes) {
      password = await readSecret("   password (not echoed): ");
      const again = await readSecret("   once more: ");
      if (password !== again) { process.stdout.write("   they differ; again.\n"); continue; }
    }
    const response = await fetch(`${origin}${api("POST", "/api/claim")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, email, password, organization }),
    }).catch((error) => fail(`could not reach ${origin}: ${error.message}. The claim secret above still works in the browser.`));
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      const cookies = response.headers.getSetCookie?.() ?? [];
      return { email, recoveryCodes: body.recoveryCodes ?? [], cookie: cookies.map((line) => line.split(";")[0]).join("; ") };
    }
    if (body.error === "weak_password" && !yes) { process.stdout.write(`\n   ${body.message}\n\n`); continue; }
    fail(`the Node refused the claim (${response.status} ${body.error ?? ""}): ${body.message ?? ""}\n`
      + `The secret above still works at ${origin} unless the refusal says it is already claimed.`);
  }
  fail("three passwords refused; the claim secret above still works in the browser.");
}

/**
 * Creates the Node's private OAuth client in the operator's account and registers it with the Node, then
 * begins the consent and returns the URL to open — or `null` when the operator gave no token.
 *
 * The scopes and the redirect URI come from the Node's own `GET /api/provider`, never from here: the Node
 * is the one source of what it needs, and a list typed into the CLI would be the drift the contract exists
 * to prevent. The token is read with echo off, used for one request, and not kept.
 */
export async function grant(origin, name, cookie, yes, open = true) {
  const node = async (method, template, body) => {
    const path = api(method, template);
    const response = await fetch(`${origin}${path}`, {
      method, headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) fail(`${method} ${path} answered ${response.status}:\n${text}`);
    return JSON.parse(text);
  };
  // The Node's own ceremony: the token page link, the permission's name, and what is unverified about it.
  const { ceremony } = await node("GET", "/api/provider");
  process.stdout.write(
    "\n== the Cloudflare grant (optional)\n"
    + "   Only to change this Node's Cloudflare setup from the browser later: another domain, a sending\n"
    + "   domain, buying a domain. Enter skips it; nothing below needs it. The Node acts through a private\n"
    + "   OAuth client only members of your account can authorize; with an API token the Node creates it\n"
    + "   exactly, spends the token on one request, and never stores it.\n\n"
    + "   1. a token form opens in your browser with the one permission filled in\n"
    + `      (${ceremony.token.permission}; pick this account when asked, and check the permission is ticked)\n`
    + `      ${ceremony.token.url}\n`
    + "   2. Continue, Create Token, copy it\n"
    + "   3. paste it below, and delete the token afterwards; nothing needs it again\n\n"
    + "   While it exists, that token can edit or delete every OAuth client in the account, not only this\n"
    + "   one. If the account runs other services, press Enter instead: the Node's Setup screen prints the\n"
    + "   dashboard steps, and no token ever exists.\n\n",
  );
  if (open && !yes) openInBrowser(ceremony.token.url);
  const token = yes ? (process.env.MAILDA_GRANT_TOKEN ?? "") : await readSecret("   API token (Enter to skip): ");
  if (token.trim() === "") { process.stdout.write("   skipped; the Node's Setup screen offers the same field whenever it is wanted.\n"); return null; }

  // The account the CLI already settled, so the Node does not have to ask the token which it can see.
  const { provider } = await node("POST", "/api/provider/client", {
    token: token.trim(), ...(process.env.CLOUDFLARE_ACCOUNT_ID ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID } : {}),
  });
  process.stdout.write(`   client ${provider.clientId} created and registered; state: ${provider.state}\n`);
  const { authorize } = await node("POST", "/api/provider/authorize", {});
  process.stdout.write("   delete the API token now, on the page it came from; the Node holds the client and needs nothing else.\n");
  return authorize.url;
}


/**
 * Steps one and two of an install, shared with `mailda upgrade`: signed in to Cloudflare, and which account.
 * wrangler's own login opens a browser and waits; the terminal is theirs. One account needs no question;
 * several need a person's answer, kept for this process only, since the id is a fact about their account and
 * not about this clone.
 */
export async function signInAndChooseAccount() {
  let whoami = capture("npx", ["wrangler", "whoami"], { quiet: true });
  if (!signedIn(whoami.text)) {
    process.stdout.write("\n== signing in to Cloudflare\n   A browser opens. Approve wrangler there, then come back here.\n\n");
    if (run("npx", ["wrangler", "login"]) !== 0) fail("wrangler could not sign in.");
    whoami = capture("npx", ["wrangler", "whoami"], { quiet: true });
    if (!signedIn(whoami.text)) fail("still not signed in after `wrangler login`.");
  }

  const accounts = accountsFrom(whoami.text);
  const chosen = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (chosen === "" && accounts.length > 1) {
    process.env.CLOUDFLARE_ACCOUNT_ID = await choose(
      "\n== which Cloudflare account",
      accounts.map((one) => ({ label: `${one.name}  ${one.id}`, value: one.id })),
    );
  } else if (chosen === "" && accounts.length === 1) {
    process.env.CLOUDFLARE_ACCOUNT_ID = accounts[0].id;
  }
  const account = accounts.find((one) => one.id.toLowerCase() === (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").toLowerCase());
  process.stdout.write(`\n   account   ${account?.name ?? "?"}  ${process.env.CLOUDFLARE_ACCOUNT_ID ?? "(not chosen)"}\n`);
  process.stdout.write("   plan      Workers Paid is required to send mail; the Free plan deletes queued delivery events after a day.\n");
}

/**
 * The Mailda Nodes this account holds: the script name of every Workflow whose class is `ButlerRun`, which
 * every Node registers under its own name. Empty when the list cannot be read; the per-name probe that
 * follows still decides, so an unreadable list costs a suggestion and not a wrong path.
 */
export function existingNodes() {
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
export function rememberedUrl(accountId, name) {
  try { return JSON.parse(readFileSync(NODES_FILE, "utf8"))[`${accountId}/${name}`] ?? null; } catch { return null; }
}
export function rememberUrl(accountId, name, url) {
  let all = {};
  try { all = JSON.parse(readFileSync(NODES_FILE, "utf8")); } catch { /* first Node remembered on this machine */ }
  mkdirSync(dirname(NODES_FILE), { recursive: true });
  writeFileSync(NODES_FILE, `${JSON.stringify({ ...all, [`${accountId}/${name}`]: url }, null, 2)}\n`);
}

export async function ask(prompt) {
  if (process.stdin.isTTY !== true) {
    fail("mailda install asks questions; run it in a terminal, or pass --yes with CLOUDFLARE_ACCOUNT_ID set "
      + "(and MAILDA_URL, when the account already has a Node).");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(prompt); } finally { rl.close(); }
}

/** Best effort, by platform; a failure to open is not a failure to install. */
export function openInBrowser(url) {
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawnSync(command, args, { stdio: "ignore" });
}
