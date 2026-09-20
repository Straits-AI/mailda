import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";

import { accountsFrom, signedIn } from "../preflight.mjs";
import { capture, fail, flag, run } from "../support.mjs";
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
 * Not for a second Node in the same account; that is `mailda deploy --name`, which the claim-secret script
 * does not yet follow.
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

  // 3. Which kind of deploy. A first install deploys directly, applies the schema and attaches the queue
  //    consumer; an account that already has a Node gets an upgrade through the canary, and the canary is
  //    checked on the Node's own hostname, so the URL is a question this conversation asks here, before
  //    "deploy now?", rather than a refusal the deploy step raises after the operator has said yes.
  const upgrading = !firstInstall();
  if (upgrading) {
    process.stdout.write("\n   this account already has a Node, so this run upgrades it: a new version is uploaded,\n"
      + "   checked as a canary on the Node's own hostname, and promoted only if doctor passes.\n");
    const given = flag(argv, "url") ?? process.env.MAILDA_URL ?? "";
    const url = given !== "" ? given : (await ask("   its URL (https://<your-node>): ")).trim();
    if (!/^https:\/\/\S+$/.test(url)) fail(`"${url}" is not a URL; re-run with --url https://<your-node>, or set MAILDA_URL.`);
    process.env.MAILDA_URL = url.replace(/\/$/, "");
    process.stdout.write(`   node      ${process.env.MAILDA_URL}\n`);
  }
  const go = argv.includes("--yes") ? "y" : await ask(`\n   ${upgrading ? "upgrade" : "deploy"} now? [y/N]: `);
  if (!/^y(es)?$/i.test(go.trim())) { process.stdout.write("   nothing was changed.\n\n"); return; }
  await deploy([]);
  const url = installedUrl ?? process.env.MAILDA_URL ?? null;

  // 4. The claim secret. Printed once by the script, captured here so it can sit beside the URL.
  process.stdout.write("\n== the claim secret\n");
  const seeded = capture("node", ["--experimental-strip-types", "scripts/seed-claim-secret.mjs"], { quiet: true });
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
