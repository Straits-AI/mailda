import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import { api, capture, choose, fail, wrapAt } from "../support.mjs";
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

/** The zone's catch-all as Cloudflare holds it, in one line: `worker -> butler (enabled)`, or `nothing`. */
export function catchAllLine(catchAll) {
  if (catchAll === null) return "nothing";
  const to = catchAll.destinations.length === 0 ? "" : ` -> ${catchAll.destinations.join(", ")}`;
  return `${catchAll.action}${to} (${catchAll.enabled ? "enabled" : "disabled"})`;
}

/**
 * The rows of the domain picker, from the zones the token can see. Pure, so the shape is tested: every
 * zone is a row (an apex, where a catch-all is on offer), then "a subdomain, typed", then an explicit skip
 * that says what it costs. Three runs on 25 September 2026 ended in "skipped" because the question said
 * "Enter to skip" under a prompt a person had to spell a domain into; a list is answered by pointing.
 */
export function domainChoices(zones) {
  return [
    ...zones.map((zone) => ({ label: `${zone.name}   (its own name: a catch-all can route every address here)`, value: zone.name })),
    { label: "a subdomain, such as mail.example.com: pick its zone, then type the name (one rule per address)", value: "typed" },
    { label: "skip for now: the Node cannot receive mail until this is done", value: "" },
  ];
}

/** The zones the operator's token can see in this account, or an empty list when the read fails. */
export async function zonesOf(accountId, token) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones?account.id=${encodeURIComponent(accountId)}&per_page=50`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  const body = await response?.json().catch(() => ({}));
  const zones = Array.isArray(body?.result) ? body.result : [];
  return zones.filter((one) => typeof one?.name === "string").map((one) => ({ name: one.name }));
}

export async function provisionNode({ origin, cookie, accountId, token, yes, ask }) {
  const done = { receiving: null, sending: null, deliveryEvents: null, address: null, catchAll: false };
  let domain = "";
  if (yes) domain = (process.env.MAILDA_DOMAIN ?? "").trim().toLowerCase();
  else {
    const zones = await zonesOf(accountId, token);
    if (zones.length === 0) process.stdout.write("   (no zone could be listed with this token; the domain is typed)\n");
    const picked = zones.length === 0 ? "typed" : await choose("\n   which domain should this Node receive mail at?", domainChoices(zones));
    if (picked !== "typed") domain = picked;
    else if (zones.length === 0) domain = (await ask("   the domain (e.g. mail.example.com; Enter to skip): ")).trim().toLowerCase();
    else {
      // The zone is pointed at and only the label is typed: a subdomain spelled whole is a typo waiting to
      // happen, and the zone decides which account records it lands in.
      const zone = zones.length === 1 ? zones[0].name : await choose("\n   under which zone?", zones.map((one) => ({ label: one.name, value: one.name })));
      const label = (await ask(`   the subdomain's name under ${zone} (e.g. mail; Enter to skip): `)).trim().toLowerCase().replace(/\.$/, "");
      domain = label === "" ? "" : label.endsWith(`.${zone}`) ? label : `${label}.${zone}`;
    }
  }
  if (domain === "") {
    process.stdout.write(
      "   skipped. This Node cannot receive mail until a domain is routed to it: the app shows this step\n"
      + "   instead of an inbox, and `pnpm mailda setup` asks again without redeploying.\n",
    );
    return done;
  }
  // The address is asked after the catch-all choice, where it can be explained; see there.
  let address = `hello@${domain}`;

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
  /*
   * A `fix` line only when the refusal does not already carry one, and derived from what it says. The first
   * real run (25 September 2026) printed "the domain must be a subdomain of a zone in this account" under a
   * refusal that was really a credential unable to read the zone: a guess, and a wrong one.
   */
  const fixFor = (text) => {
    if (/\bfix\b/i.test(text)) return null;
    if (/not carried|no zone/i.test(text)) return "the domain must be a subdomain of a zone in this Cloudflare account; try another with `mailda setup`";
    if (/authentication|could not read/i.test(text)) {
      return "the credential in use could not read this zone's routing state; run the update again after the fix, "
        + "or `mailda provider --onboard-receiving` with the Node connected";
    }
    return null;
  };
  const firstSentence = (text) => text.split(/(?<=[.!?])\s/)[0].trim();
  let receivingRefusal = null;

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
      receivingRefusal = proposal.refusal;
      process.stdout.write("     will not set it up:\n");
      for (const line of wrapAt(proposal.refusal, 70)) process.stdout.write(`       ${line}\n`);
      const fix = fixFor(proposal.refusal);
      if (fix !== null) for (const [i, line] of wrapAt(fix, 66).entries()) process.stdout.write(`     ${i === 0 ? "fix      " : "         "} ${line}\n`);
    } else {
      /*
       * A zone's own name can take a catch-all: one rule, and every address decision lives in the Node,
       * which bounces the ones it does not know. Cloudflare offers this for apex zones only; a subdomain
       * needs a literal rule per address (docs/receipts/wrangler-login-reach.md). Asked, never assumed:
       * the catch-all is the whole domain's unmatched mail, and where it goes today is printed first.
       */
      let catchAll = false;
      if (proposal.apex === true) {
        catchAll = yes
          ? process.env.MAILDA_CATCH_ALL === "1"
          : await choose(
            `\n     ${domain} is a zone's own name. Its catch-all today: ${catchAllLine(proposal.catchAll ?? null)}.\n     How should mail reach this Node?`,
            [
              { label: "every address at it: take the catch-all; addresses live in the Node, unknown ones bounce", value: true },
              { label: "one address only: one rule; each further address needs its own", value: false },
            ],
          );
      }
      /*
       * The mailbox's first address, asked after the routing choice so it can be said what it is: the
       * catch-all decides where a domain's unmatched mail goes, and a mailbox files the addresses it holds
       * and needs one to send from (`E_MAILBOX_HAS_NO_ADDRESS` is what a mailbox without one refuses
       * with). Asked before the catch-all, it read as a second routing act, and the founder asked why.
       */
      process.stdout.write(catchAll
        ? `     every address at ${domain} will reach this Node; the mailbox files the ones it holds. This is its first;\n     more are added on People, with nothing to do in Cloudflare.\n`
        : `     one rule routes one address to this Node; each further address needs its own\n     (\`mailda provider --onboard-receiving ${domain} --address <a>\`), or take the catch-all later.\n`);
      address = (yes ? process.env.MAILDA_ADDRESS ?? "" : await ask(`     the mailbox's first address [hello@${domain}]: `)).trim().toLowerCase() || `hello@${domain}`;
      done.address = address;
      const applied = await call("POST", "/api/provider/receiving", {
        domain, digest: proposal.digest, address, ...(catchAll ? { catchAll: true } : {}),
      });
      if (!applied.ok) refused(applied.text);
      else {
        const { outcome } = applied.value;
        for (const one of outcome.confirmed) process.stdout.write(`     confirmed MX ${one}\n`);
        if (outcome.catchAll !== null && outcome.catchAll !== undefined) {
          process.stdout.write(`     catch-all ${catchAllLine(outcome.catchAll.before)} -> ${catchAllLine(outcome.catchAll.after)}\n`
            + `               put back: mailda provider --put-back <id> --domain ${domain}, the id being the catch-all's\n`
            + `               row in \`mailda provider --routing-rules ${domain}\`\n`);
          done.catchAll = true;
        } else if (outcome.rule !== null) process.stdout.write(`     rule      ${outcome.rule}\n`);
        if (outcome.note !== null) for (const line of wrapAt(outcome.note, 70)) process.stdout.write(`     ${line}\n`);
        // Set up, not verified: the read-back proves the records, and delivery is proven by a message.
        if (outcome.confirmed.length > 0 || done.catchAll) done.receiving = domain;
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
      process.stdout.write(`     unknown   ${proposal.error}\n`);
      if (!/\bfix\b/i.test(proposal.error)) process.stdout.write(`     fix       \`mailda provider --onboard-sending ${domain} --url ${origin}\` shows the same answer with the Node's next step\n`);
    } else {
      /*
       * Posted even when Cloudflare already has it (26 September 2026): the Node then records what it saw
       * rather than onboarding, and without that entry its own record said sending was never set up — on
       * the first-run progress list and at the end of every `mailda upgrade`.
       */
      for (const name of proposal.creates) process.stdout.write(`     creates   ${name}\n`);
      const applied = await call("POST", "/api/provider/sending", { domain, digest: proposal.digest });
      if (!applied.ok) refused(applied.text);
      else {
        process.stdout.write(proposal.onboarded ? "     onboarded already, recorded\n" : `     onboarded for sending on ${applied.value.proposal.zone}\n`);
        done.sending = domain;
      }
    }
  }

  // 3. Delivery outcomes: the subscription into this Node's queue, and the consumer on it.
  process.stdout.write(`\n   delivery outcomes for ${domain}\n`);
  const subscription = await call("GET", "/api/provider/subscription", undefined, { domain });
  if (!subscription.ok) refused(subscription.text);
  else {
    const { proposal } = subscription.value;
    if (proposal.error !== null) {
      process.stdout.write(`     unknown   ${proposal.error}\n`);
      if (!/\bfix\b/i.test(proposal.error)) process.stdout.write(`     fix       \`mailda provider --subscribe ${domain} --url ${origin}\` shows the same answer with the Node's next step\n`);
    } else {
      const already = proposal.subscribed !== null && proposal.consumerAttached !== false;
      if (proposal.subscribed === null) process.stdout.write(`     creates   a subscription publishing ${proposal.events.join(", ")} into ${proposal.queueName}\n`);
      if (proposal.consumerAttached === false) process.stdout.write(`     attaches  this Worker as the consumer of ${proposal.queueName}\n`);
      // Posted when already in place too, for sending's reason above: the Node records the sighting.
      const applied = await call("POST", "/api/provider/subscription", { domain, digest: proposal.digest });
      if (!applied.ok) refused(applied.text);
      else {
        process.stdout.write(already
          ? `     subscribed already, as ${proposal.subscribed}, recorded\n`
          : `     subscribed: ${applied.value.proposal.subscribed} (events reach ${applied.value.proposal.queueName})\n`);
        done.deliveryEvents = domain;
      }
    }
  }

  process.stdout.write(
    "\n   set up\n"
    + `     receiving   ${done.receiving === null
      ? (receivingRefusal === null ? "not set up" : `not set up (refused: ${firstSentence(receivingRefusal)})`)
      : `${address} on ${done.receiving}${done.catchAll ? " (catch-all: every address)" : ""}`}\n`
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
  if (setUp.catchAll === true) {
    process.stdout.write("   addresses   add more on People; no Cloudflare step is needed for this domain\n");
  }
  if (setUp.receiving !== null && setUp.deliveryEvents === null) {
    process.stdout.write("   outcomes    not subscribed: replies hand over but their delivery stays unobserved; `mailda setup` retries\n");
  }
  process.stdout.write("\n");
}
