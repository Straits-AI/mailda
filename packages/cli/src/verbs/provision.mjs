import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import { api, capture, fail, wrapAt } from "../support.mjs";
import { tokenFromWranglerConfig, wranglerConfigPaths } from "../wrangler-config.mjs";

/**
 * Setting a Node up to receive, send and observe outcomes, with the consent the operator already gave
 * wrangler (25 September 2026).
 *
 * The Node's provisioning routes read the account through its grant, which a browser needs and an install
 * does not: `wrangler login` already happened, and its token reaches everything those routes touch except
 * raw DNS and the registrar (`docs/receipts/wrangler-login-reach.md`). So the install sends that token and
 * the account it settled in two headers, for each request, and the Node acts with them and stores nothing.
 * The Node keeps the propose-then-confirm shape, the digest, the read-back and the refusals; this file only
 * asks the questions and prints the answers, in `mailda provider`'s words.
 *
 * Every step is allowed to refuse without failing the install. A domain not in this account, a sending
 * domain Cloudflare will not onboard, a subscription with nothing to subscribe: each is printed whole and
 * the next step still runs, because a Node that receives and cannot yet observe outcomes is a working Node
 * with one thing left to do, and the Setup screen and `mailda provider` do that thing later.
 */
export async function wranglerToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  // `whoami` refreshes an expired token and rewrites the file; the read below then sees a live one.
  capture("npx", ["wrangler", "whoami"], { quiet: true });
  const paths = wranglerConfigPaths(process.env, process.platform, homedir());
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const found = tokenFromWranglerConfig(readFileSync(path, "utf8"));
    if (found !== null) return found.token;
  }
  fail("wrangler's login token could not be found, so the account cannot be set up from here.\n\n"
    + "  why      the install reuses the consent `wrangler login` gave rather than asking for another; the\n"
    + "           token is read from the file wrangler writes, and none of these hold one:\n"
    + paths.map((one) => `             ${one}\n`).join("")
    + "  fix      run `npx wrangler login`, then re-run; or set CLOUDFLARE_API_TOKEN to a token that may\n"
    + "           write Email Routing, Email Sending and Queues in this account");
}

export async function provisionNode({ origin, cookie, accountId, token, yes, ask }) {
  const done = { receiving: null, sending: null, deliveryEvents: null, address: null };
  const domain = (yes ? process.env.MAILDA_DOMAIN ?? "" : await ask("   which domain should this Node receive mail at? (Enter to skip): ")).trim().toLowerCase();
  if (domain === "") {
    process.stdout.write("   skipped; the Setup screen in the Node, or `mailda provider`, does this later.\n");
    return done;
  }
  const address = (yes ? process.env.MAILDA_ADDRESS ?? "" : await ask(`   address to receive at [hello@${domain}]: `)).trim().toLowerCase() || `hello@${domain}`;
  done.address = address;

  const call = async (method, template, body, query) => {
    const path = api(method, template, query);
    const response = await fetch(`${origin}${path}`, {
      method,
      // The operator's own credential, for this request and no longer; the Node never stores it.
      headers: { cookie, "content-type": "application/json", "x-cloudflare-token": token, "x-cloudflare-account": accountId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, text: `${method} ${path} answered ${response.status}:\n${text}` };
    return { ok: true, value: JSON.parse(text) };
  };
  const refused = (text) => { for (const line of text.split("\n")) process.stdout.write(`     ${line}\n`); process.stdout.write("\n"); };

  // 1. Receiving: the subdomain's records and the rule to this Worker.
  process.stdout.write(`\n   receiving at ${address}\n`);
  const receiving = await call("GET", "/api/provider/receiving", undefined, { domain });
  if (!receiving.ok) refused(receiving.text);
  else {
    const { proposal } = receiving.value;
    if (proposal.zone !== null) process.stdout.write(`     zone      ${proposal.zone} (routing ${proposal.zoneRouting ?? "?"})\n`);
    if (proposal.enablesZone !== null) process.stdout.write(`     enables   Email Routing on ${proposal.enablesZone}; that writes MX and SPF at the apex\n`);
    for (const one of proposal.present) process.stdout.write(`     has       MX ${one}\n`);
    for (const one of proposal.creates) process.stdout.write(`     writes    MX ${one.name} -> ${one.content} (priority ${one.priority})\n`);
    if (proposal.refusal !== null) {
      process.stdout.write("     will not set it up:\n");
      for (const line of wrapAt(proposal.refusal, 70)) process.stdout.write(`       ${line}\n`);
      process.stdout.write("     fix       the domain must be a subdomain of a zone in this Cloudflare account; try another\n"
        + "               with `mailda setup`\n");
    } else {
      const applied = await call("POST", "/api/provider/receiving", { domain, digest: proposal.digest, address });
      if (!applied.ok) refused(applied.text);
      else {
        const { outcome } = applied.value;
        for (const one of outcome.confirmed) process.stdout.write(`     confirmed MX ${one}\n`);
        if (outcome.rule !== null) process.stdout.write(`     rule      ${outcome.rule}\n`);
        if (outcome.note !== null) for (const line of wrapAt(outcome.note, 70)) process.stdout.write(`     ${line}\n`);
        // Set up, not verified: the read-back proves the records, and delivery is proven by a message.
        if (outcome.confirmed.length > 0) done.receiving = domain;
      }
    }
  }

  // 2. Sending: the domain onboarded for Email Sending.
  process.stdout.write(`\n   sending from ${domain}\n`);
  const sending = await call("GET", "/api/provider/sending", undefined, { domain });
  if (!sending.ok) refused(sending.text);
  else {
    const { proposal } = sending.value;
    if (proposal.error !== null) {
      process.stdout.write(`     unknown   ${proposal.error}\n`
        + `     fix       \`mailda provider --onboard-sending ${domain} --url ${origin}\` shows the same answer with the Node's next step\n`);
    } else if (proposal.onboarded) { process.stdout.write("     onboarded already\n"); done.sending = domain; }
    else {
      for (const name of proposal.creates) process.stdout.write(`     creates   ${name}\n`);
      const applied = await call("POST", "/api/provider/sending", { domain, digest: proposal.digest });
      if (!applied.ok) refused(applied.text);
      else { process.stdout.write(`     onboarded for sending on ${applied.value.proposal.zone}\n`); done.sending = domain; }
    }
  }

  // 3. Delivery outcomes: the subscription into this Node's queue, and the consumer on it.
  process.stdout.write(`\n   delivery outcomes for ${domain}\n`);
  const subscription = await call("GET", "/api/provider/subscription", undefined, { domain });
  if (!subscription.ok) refused(subscription.text);
  else {
    const { proposal } = subscription.value;
    if (proposal.error !== null) {
      process.stdout.write(`     unknown   ${proposal.error}\n`
        + `     fix       \`mailda provider --subscribe ${domain} --url ${origin}\` shows the same answer with the Node's next step\n`);
    } else if (proposal.subscribed !== null && proposal.consumerAttached !== false) {
      process.stdout.write(`     subscribed already, as ${proposal.subscribed}\n`); done.deliveryEvents = domain;
    } else {
      if (proposal.subscribed === null) process.stdout.write(`     creates   a subscription publishing ${proposal.events.join(", ")} into ${proposal.queueName}\n`);
      if (proposal.consumerAttached === false) process.stdout.write(`     attaches  this Worker as the consumer of ${proposal.queueName}\n`);
      const applied = await call("POST", "/api/provider/subscription", { domain, digest: proposal.digest });
      if (!applied.ok) refused(applied.text);
      else { process.stdout.write(`     events reach ${applied.value.proposal.queueName} as ${applied.value.proposal.subscribed}\n`); done.deliveryEvents = domain; }
    }
  }

  process.stdout.write(
    "\n   set up\n"
    + `     receiving   ${done.receiving === null ? "not set up" : `${address} on ${done.receiving}`}\n`
    + `     sending     ${done.sending ?? "not set up"}\n`
    + `     outcomes    ${done.deliveryEvents === null ? "not subscribed" : `subscribed for ${done.deliveryEvents}`}\n`,
  );
  return done;
}

/**
 * What to do now, printed by every verb that ends in a set-up Node, so the run never ends on a summary
 * the operator has to interpret. An operator who opened the Node after the install and saw an inbox took
 * it for ready (25 September 2026); the next step is named here and the app shows the same step until it
 * is done.
 */
export function printNext(origin, setUp) {
  process.stdout.write(`\n== next\n   your Node   ${origin}\n`);
  if (setUp.receiving !== null) {
    process.stdout.write(
      `   prove it    send a message to ${setUp.address} from any mailbox OUTSIDE this Cloudflare account;\n`
      + "               it appears in the Node's inbox. DNS takes a little while to propagate; a same-account\n"
      + "               send is accepted and never delivered\n",
    );
  } else {
    process.stdout.write(
      "   then        the app shows the next setup step instead of an inbox until this Node has a routed\n"
      + "               address; `mailda setup` runs this step again, with another domain\n",
    );
  }
  if (setUp.receiving !== null && setUp.deliveryEvents === null) {
    process.stdout.write("   outcomes    not subscribed: replies hand over but their delivery stays unobserved; `mailda setup` retries\n");
  }
  process.stdout.write("\n");
}
