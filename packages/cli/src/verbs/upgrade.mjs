import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { contractingAmong } from "../deploy-parse.mjs";
import { WRANGLER_ARGS, api, capture, choose, configFor, fail, flag, readSecret, run, sessionCookie, useConfig, workerDir, wrapAt } from "../support.mjs";
import { RELEASE_URL, asksHostname, distance, onlyPackageJson, pendingByPhase, releaseRemote, resolvePackageJson } from "../upgrade-parse.mjs";
import { backup } from "./backup.mjs";
import { deploy, firstInstall } from "./deploy.mjs";
import { ask, existingNodes, hostnameQuestion, rememberUrl, rememberedUrl, signInAndChooseAccount } from "./install.mjs";
import { printNext, provisionNode, receivingDomain, receivingOf, verifiedDestinationsStep, wranglerToken, wranglerTokenRead } from "./provision.mjs";
import { routingRulesStep } from "./routing-step.mjs";
import { plural } from "@mailda/runtime";
import { askAdministrator } from "../credentials.mjs";
import { progress } from "../progress.mjs";

const REPO = resolve(workerDir, "../../..");

/**
 * `mailda upgrade`: bring a Node that exists up to the code this clone can have, with a backup first.
 *
 * `mailda install` already upgrades when given an existing name, and it does so with whatever code is in
 * the clone. That is the landmine this verb removes: an operator who never pulled gets a canary, a gate, a
 * promotion and the word "upgraded", and nothing changed. So the first thing this does is pull the release,
 * and say how far the clone was behind it. It does not stop when the clone was already current: that says
 * nothing about the Node, which may be running older code than the clone, and was.
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
/** What an upgrade does, in order: each prints its banner as it begins (`progress.mjs`). */
export const UPGRADE_STEPS = [
  "Get the release", "Choose the Node", "Back up the Node", "Review what changes", "Deploy through the canary",
  "Receiving, sending and delivery outcomes", "Email Routing rules",
];

export async function upgrade(argv) {
  process.stdout.write("\n== mailda upgrade\n   Pull the release, back the Node up, list what its schema will do, then deploy through the canary.\n");
  const yes = argv.includes("--yes");
  const steps = progress(UPGRADE_STEPS);

  steps.step("Get the release");
  // 1. Is there anything to upgrade to. The release channel is the git remote, and nothing else (ADR 43).
  //    A deploy-button clone has no remote and no history; both are given here, once, so no git command is
  //    ever the operator's to type.
  let remote = releaseRemote(git(["remote", "-v"]).text);
  if (remote === null) {
    if (git(["remote", "add", "upstream", RELEASE_URL]).status !== 0) fail("could not add the release remote.");
    remote = "upstream";
    process.stdout.write(`   remote    upstream added: ${RELEASE_URL}\n`);
  }
  if (git(["fetch", "--quiet", remote, "main"]).status !== 0) fail(`could not fetch ${remote}; is the network up?`);
  /*
   * Unrelated histories are detected by `merge-base` failing, not by `rev-list`: measured in a drill on
   * 24 September 2026, `rev-list --left-right --count` on two unrelated branches does not fail, it counts
   * every commit on both sides, and a deploy-button clone read as "402 behind, 1 ahead" and was refused as
   * a clone with its own commits. `test/node/update-path.test.ts` uses the same detector.
   */
  if (git(["merge-base", "HEAD", `${remote}/main`]).status !== 0) {
    if (git(["status", "--porcelain"]).text.trim() !== "") {
      fail("this clone has uncommitted changes, so the release cannot be merged over them.\n\n  fix      commit or stash them, then re-run");
    }
    joinHistories(remote);
  }
  const where = distance(git(["rev-list", "--left-right", "--count", `HEAD...${remote}/main`]).text);
  if (where === null) fail(`could not compare this clone with ${remote}/main; \`git status\` in the clone says why.`);
  /*
   * "Current" describes the clone against the release and nothing else, so it does not end the run. It did,
   * until the first real update (25 September 2026): `update.sh` had already pulled the clone to the release,
   * the verb then read the clone as current and stopped, and the Node kept running the old code. What is
   * deployed is not readable from here, since a Node does not know its commit, so the deploy always runs;
   * its own gate compares the canary with what is serving, and deploying code that is already serving costs
   * one deployment entry and changes nothing.
   */
  process.stdout.write(`\n   code      ${where.behind === 0 ? "current with the release" : `${where.behind} release ${plural(where.behind, "commit", "commits")} behind`}`
    + `${where.ahead > 0 ? `, ${where.ahead} local ${plural(where.ahead, "commit", "commits")} ahead` : ""}\n`);
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
  steps.step("Choose the Node");
  await signInAndChooseAccount();
  const base = configFor([]).name;
  const existing = existingNodes();
  const suggested = flag(argv, "name") ?? process.env.MAILDA_NODE_NAME ?? (existing.length === 1 ? existing[0] : base);
  // Point at the Node. Typed only when the account's list could not be read, which is the one case a name
  // has to be spelled; the probe below still refuses a name that is not a Node.
  const name = yes || flag(argv, "name") !== null
    ? suggested
    : existing.length === 0
      ? ((await ask(`\n   Node to upgrade [${suggested}]: `)).trim() || suggested)
      : await choose("\n== Node to upgrade", existing, { initial: Math.max(0, existing.indexOf(suggested)) });
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const remembered = rememberedUrl(accountId, name);
  /*
   * A hostname of the operator's own (8 October 2026): asked while the Node is still on its workers.dev address, the
   * same question `mailda install` asks. It goes into the derived config, and the deploy attaches it after promotion.
   */
  const given = flag(argv, "hostname") ?? process.env.MAILDA_HOSTNAME ?? null;
  const hostname = asksHostname({ given, yes, remembered })
    ? await hostnameQuestion(argv)
    : (given ?? "").trim().toLowerCase() || null;
  if (hostname !== null && given === null) {
    for (const line of wrapAt(`${hostname} is attached to the Node after the deploy. Sign in again there: a session and a `
      + "passkey belong to the address they were made on. The workers.dev address keeps working.", 90)) {
      process.stdout.write(`   ${line}\n`);
    }
  }
  const nameArgs = [...(name === base ? [] : ["--name", name]), ...(hostname === null ? [] : ["--hostname", hostname])];
  useConfig(configFor(nameArgs));
  if (firstInstall()) {
    fail(`\`${name}\` is not a Node in this account, and an upgrade never creates one.\n\n  fix      mailda install, which does`);
  }
  const givenUrl = flag(argv, "url") ?? process.env.MAILDA_URL ?? remembered ?? "";
  const url = (givenUrl !== "" || yes ? givenUrl : (await ask("   its URL (https://<your-node>): ")).trim()).replace(/\/$/, "");
  if (!/^https:\/\/\S+$/.test(url)) fail(`"${url}" is not a URL; the backup and the canary both need the Node's own hostname.`);
  process.env.MAILDA_URL = url;
  rememberUrl(accountId, name, url);
  process.stdout.write(`   node      ${name}  ${url}\n`);

  steps.step("Back up the Node");
  // 3. The backup, before anything touches the catalog. Administrator credentials, because the inventory it
  //    indexes is administrator-only; they also let the canary gate below see the whole doctor report.
  if (process.env.MAILDA_EMAIL === undefined || process.env.MAILDA_PASSWORD === undefined) {
    if (yes) fail("--yes needs MAILDA_EMAIL and MAILDA_PASSWORD, for the backup and the canary gate.");
    process.stdout.write("\n== an administrator, for the backup\n");
    await askAdministrator(url, { ask, readSecret, fail });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = flag(argv, "backup-out") ?? resolve(REPO, ".mailda", "backups", name, stamp);
  process.stdout.write(`   into ${out}\n`);
  await backup(["--url", url, "--out", out, ...nameArgs]);
  process.stdout.write(`   backup    ${out}\n   restore   docs/disaster-recovery.md, if the upgrade goes wrong\n`);

  steps.step("Review what changes");
  // 4. What the schema will do to the data, on screen, before agreeing.
  const listed = capture("npx", ["wrangler", "d1", "migrations", "list", "CATALOG", "--remote", ...WRANGLER_ARGS], { quiet: true });
  if (listed.status !== 0) fail(`could not list pending migrations:\n${listed.text}`);
  const migrationsDir = resolve(workerDir, "migrations");
  const names = readdirSync(migrationsDir).filter((one) => one.endsWith(".sql"));
  const phases = pendingByPhase(listed.text, names, contractingAmong(listed.text, migrationsDir));
  if (phases.expand.length + phases.contract.length === 0) process.stdout.write("   no schema change; the code only\n");
  for (const one of phases.expand) process.stdout.write(`   expand    ${one}  (adds; safe for the running version)\n`);
  for (const one of phases.contract) process.stdout.write(`   contract  ${one}  (drops or narrows; refused unless --contract)\n`);
  process.stdout.write("   The expansions run on the live catalog before the new version is uploaded; the canary is\n"
    + "   then checked and promoted only if doctor is no worse than today's. Contractions wait for --contract.\n");

  const go = yes ? "y" : await ask("\n   upgrade now? [y/N]: ");
  if (!/^y(es)?$/i.test(go.trim())) { process.stdout.write("   nothing was changed; the backup stays.\n\n"); return; }
  /*
   * The read of verified destinations runs after promotion and before the deploy's closing report (28 September
   * 2026), because it changes what that report says: it used to come after, and every upgrade that refreshed it
   * ended on a report the read had already outdated. The route exists only in the promoted version, hence after.
   * Only the read moved: it writes nothing to Cloudflare and never ends the run, so it costs nothing when the
   * report then says `refuse`. The setup's writes still wait for that verdict.
   */
  let session = { cookie: null, state: null, token: null };
  steps.step("Deploy through the canary");
  const deployed = await deploy([...nameArgs, "--url", url, ...(argv.includes("--contract") ? ["--contract"] : [])], {
    beforeReport: async () => { session = await readVerifiedDestinations({ url, accountId }); },
  });
  if (hostname !== null) rememberUrl(accountId, name, `https://${hostname}`);
  if (deployed === 2) {
    // `refuse` after promotion is the one fault the canary cannot see (a Durable Object runs the promoted
    // version only after traffic moves). The deploy printed the rollback; setting up receiving on a Node
    // that refuses would be work on top of a fault, so this ends here and says so.
    process.stdout.write("\n   the Node reports refuse, so the setup did not run. Fix that first, then re-run the update.\n\n");
    process.exit(2);
  }
  steps.step("Receiving, sending and delivery outcomes");
  const setUp = await setUpNode({ url, accountId, yes, ...session });
  /*
   * The routing rules, on every upgrade and outside `setUpNode`'s missing-step branch (1 October 2026): a Node set
   * up long ago never saw its zone's rules again, and they change in the dashboard, not here. It asks only when a
   * rule can be offered, and under --yes it prints and changes nothing.
   */
  steps.step("Email Routing rules");
  await routingRulesStep({
    origin: url, cookie: session.cookie, accountId, token: session.token, yes, ask,
    domain: receivingDomain(session.state?.provisioned, setUp),
  });
  process.stdout.write(
    `\n== upgraded\n   ${name} at ${url}; backup from before it at ${out}\n`
    + `   receiving   ${setUp.receiving === null
      ? setUp.routing === null ? "not set up" : `${setUp.address ?? "?"} is not routed here (below)`
      : `${setUp.address ?? "?"} on ${setUp.receiving}`}\n`
    + `   sending     ${setUp.sending ?? "not set up"}\n`
    + `   outcomes    ${setUp.deliveryEvents === null ? "not subscribed" : `subscribed for ${setUp.deliveryEvents}`}\n`,
  );
  printNext(url, setUp);
}

/**
 * Which recipients are verified destinations, read with the operator's credential on every upgrade: it changes
 * with every send, so a Node set up long ago still needs it read. Handed to the deploy as `beforeReport`. It never
 * exits and never throws on its own account (a token that could not be had is printed with wrangler's reason, a refused read is printed), and it
 * hands on the session and the Node's record so the setup after the verdict does not ask again.
 */
async function readVerifiedDestinations({ url, accountId }) {
  const cookie = await sessionCookie(url);
  if (cookie === null) return { cookie, state: null, token: null };
  const state = await fetch(`${url}${api("GET", "/api/provider")}`, { headers: { cookie } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (state?.provisioned === undefined) return { cookie, state, token: null };
  const { token, error } = wranglerTokenRead();
  if (token === null) {
    // Why, in wrangler's terms: a Global API Key, a refused refresh and no login at all each have their own fix.
    process.stdout.write("\n   verified destinations  not read (mailda setup reads them later):\n");
    for (const line of wrapAt(error, 70)) process.stdout.write(`                          ${line}\n`);
  } else await verifiedDestinationsStep({ origin: url, cookie, accountId, token });
  return { cookie, state, token };
}

/**
 * Receiving, sending and outcomes for a Node that lacks them, with the operator's credential, once the deploy's
 * verdict is known and is not `refuse`.
 */
async function setUpNode({ url, accountId, yes, cookie, state, token }) {
  /*
   * A Node deployed before the install did the account work has never been set up to receive: no routing,
   * no grant, and nothing on it looks wrong. The audit trail says so (`provisioned.receiving` is null), and
   * the upgrade finishes the job the same way the install does, with wrangler's login. Each of the three
   * steps is judged on its own record: a Node with receiving recorded and sending not (onboarded from the
   * dashboard before the Node existed, 26 September 2026) gets the sending and outcomes steps only.
   */
  const setUp = { receiving: null, sending: null, deliveryEvents: null, address: null, routing: null };
  if (cookie === null || state === null || state.provisioned === undefined) return setUp;
  const missing = ["receiving", "sending", "deliveryEvents"].filter((step) => state.provisioned[step] === null);
  if (missing.length > 0) {
    process.stdout.write(missing.includes("receiving")
      ? "\n== this Node has never been set up to receive\n"
      : `\n== this Node has no record of ${missing.join(" or ")}\n`);
    process.stdout.write("   Uses the consent you already gave wrangler; nothing is changed before the plan is shown.\n");
    Object.assign(setUp, await provisionNode({
      origin: url, cookie, accountId, token: token ?? await wranglerToken(), yes, ask, provisioned: state.provisioned,
      // The administrator `sessionCookie` signed in as, whose own address the first one defaults to on its domain.
      signInEmail: process.env.MAILDA_EMAIL,
    }));
    return setUp;
  }
  // A receiving record counts only when its address was routed here (`receivingOf`, 28 September 2026).
  Object.assign(setUp, receivingOf(state.provisioned.receiving));
  // A record of a sighting is a record: a domain onboarded before this Node counts, and says so.
  const seen = (act) => (act === null || act === undefined ? null : act.observed ? `${act.domain} (in place before this Node, observed)` : act.domain);
  setUp.sending = seen(state.provisioned.sending);
  setUp.deliveryEvents = seen(state.provisioned.deliveryEvents);
  return setUp;
}

function git(args) {
  return capture("git", args, { cwd: REPO, quiet: true });
}

/**
 * The deploy button's first update: a clone with no common ancestor is merged with upstream once, and the
 * one conflict the update path allows, package.json's `name`, is resolved by keeping the clone's name and
 * taking upstream's everything else. Any other conflict is a clone somebody edited, and the merge is
 * aborted with the file names rather than resolved by guessing. `test/node/update-path.test.ts` is the
 * measurement that package.json is the only file that can conflict.
 */
function joinHistories(remote) {
  process.stdout.write("   history   none shared with the release: merging once, as a deploy-button clone needs\n");
  const merged = git(["merge", `${remote}/main`, "--allow-unrelated-histories", "-m", "Join this clone to the Mailda release history"]);
  if (merged.status === 0) return;
  const conflicted = git(["diff", "--name-only", "--diff-filter=U"]).text;
  if (!onlyPackageJson(conflicted)) {
    git(["merge", "--abort"]);
    fail(`the first merge conflicts in more than package.json: ${conflicted.trim().split("\n").join(", ")}.\n\n`
      + "  why      the update path allows exactly one conflict, the Worker's name in package.json; the rest is\n"
      + "           an edit this clone made that only its author can merge\n"
      + `  fix      git merge ${remote}/main --allow-unrelated-histories, resolve by hand, then re-run`);
  }
  const ours = git(["show", ":2:package.json"]).text;
  const theirs = git(["show", ":3:package.json"]).text;
  writeFileSync(resolve(REPO, "package.json"), resolvePackageJson(ours, theirs));
  git(["add", "package.json"]);
  if (git(["commit", "--no-edit"]).status !== 0) fail("could not commit the first merge; `git status` in the clone says why.");
  process.stdout.write(`   merged    package.json keeps this clone's name (${JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")).name}) and takes the rest\n`);
}
