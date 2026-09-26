import { api, choose, fail, flag, readSecret, sessionCookie } from "../support.mjs";
import { ask, existingNodes, rememberUrl, rememberedUrl, signInAndChooseAccount } from "./install.mjs";
import { printNext, provisionNode, wranglerToken } from "./provision.mjs";

/**
 * `mailda setup`: receiving, sending and delivery outcomes for a Node that is already deployed and claimed,
 * without deploying anything (25 September 2026).
 *
 * The install does this at the end of its run and the upgrade after its deploy; this is the same step on
 * its own, for a Node whose install predates it or whose operator skipped the question. It uses the consent
 * wrangler already has, shows each plan before applying it, and changes nothing else on the Node.
 */
export async function setup(argv) {
  process.stdout.write("\n== mailda setup\n   Receiving, sending and delivery outcomes for a Node that is already running. No deploy.\n");
  const yes = argv.includes("--yes");

  await signInAndChooseAccount();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const existing = existingNodes();
  const suggested = flag(argv, "name") ?? process.env.MAILDA_NODE_NAME ?? existing[0] ?? "mailda";
  const name = yes || flag(argv, "name") !== null
    ? suggested
    : existing.length === 0
      ? ((await ask(`\n   Node to set up [${suggested}]: `)).trim() || suggested)
      : await choose("\n== Node to set up", existing, { initial: Math.max(0, existing.indexOf(suggested)) });
  const remembered = rememberedUrl(accountId, name);
  const given = flag(argv, "url") ?? process.env.MAILDA_URL ?? remembered ?? "";
  const url = (given !== "" || yes ? given : (await ask("   its URL (https://<your-node>): ")).trim()).replace(/\/$/, "");
  if (!/^https:\/\/\S+$/.test(url)) fail(`"${url}" is not a URL; the setup talks to the Node on its own hostname.`);
  rememberUrl(accountId, name, url);

  if (process.env.MAILDA_EMAIL === undefined || process.env.MAILDA_PASSWORD === undefined) {
    if (yes) fail("--yes needs MAILDA_EMAIL and MAILDA_PASSWORD: the setup routes are administrator-only.");
    process.stdout.write("\n== an administrator of the Node\n");
    process.env.MAILDA_EMAIL = (await ask("   email: ")).trim();
    process.env.MAILDA_PASSWORD = await readSecret("   password (not echoed): ");
  }
  const cookie = await sessionCookie(url);
  if (cookie === null) fail(`could not sign in to ${url} as ${process.env.MAILDA_EMAIL}.`);

  const state = await fetch(`${url}${api("GET", "/api/provider")}`, { headers: { cookie } })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (state === null) fail(`${url} did not answer GET /api/provider; is it a Mailda Node, and is ${process.env.MAILDA_EMAIL} an administrator?`);
  /*
   * A Node from before 25 September 2026 answers without `provisioned` and ignores the operator's credential
   * on its routes, so it would try its own grant and refuse. The honest answer is that it must be updated.
   */
  if (state.provisioned === undefined) {
    fail("this Node runs code from before the setup step existed, so it cannot be set up from here yet.\n\n"
      + "  why      its routes do not take the operator's credential; they would look for a grant it does not hold\n"
      + "  fix      update it first, in the clone's directory:\n"
      + "             curl -fsSL https://mailda.site/update.sh | bash\n"
      + "           the update runs this setup itself once the Node is current");
  }
  const said = (act, noun) => act === null ? "not set up" : `${act.domain}${noun}, ${act.at.slice(0, 10)}`;
  process.stdout.write(
    `\n   receiving   ${said(state.provisioned.receiving, state.provisioned.receiving?.address ? ` (${state.provisioned.receiving.address})` : "")}\n`
    + `   sending     ${said(state.provisioned.sending, "")}\n`
    + `   outcomes    ${said(state.provisioned.deliveryEvents, "")}\n`,
  );

  process.stdout.write("\n== setting up\n   Uses the consent you already gave wrangler; nothing is changed before the plan is shown.\n");
  const setUp = await provisionNode({ origin: url, cookie, accountId, token: await wranglerToken(), yes, ask, provisioned: state.provisioned });
  printNext(url, setUp);
}
