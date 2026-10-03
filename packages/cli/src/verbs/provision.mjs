import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerVerifiedDestinationsResponse } from "@mailda/contract/schemas";

import { api, capture, choose, fail, wrapAt } from "../support.mjs";
import { tokenFrom } from "../wrangler-config.mjs";

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
  const read = wranglerTokenRead();
  return read.token
    ?? fail("wrangler's login token could not be had, so the account cannot be set up from here.\n\n"
      + "  why      the install reuses the consent `wrangler login` gave rather than asking for another, and\n"
      + `           ${read.error}\n`
      + "  fix      run `npx wrangler login`, then re-run; or set CLOUDFLARE_API_TOKEN to a token that may\n"
      + "           write Email Routing, Email Sending and Queues in this account");
}

/**
 * The token wrangler would act with, or why there is none (30 September 2026): `wrangler auth token --json`, which
 * applies wrangler's own precedence (a Global API Key with its email first, then `CLOUDFLARE_API_TOKEN`, then the
 * login), refreshes an expired login, and reads wherever wrangler keeps it. It used to return
 * `CLOUDFLARE_API_TOKEN` without asking, which provisioned with a different credential from the one wrangler
 * deployed with whenever a Global API Key was set beside it.
 *
 * **Quiet**, always: `capture` echoes what it reads unless told not to, and this answer is a credential that
 * would otherwise land in the terminal or a Workers Builds log. Only stdout is parsed.
 *
 * **Kept out of wrangler's debug log.** wrangler writes every line it prints, this answer included, to a log
 * file under its config directory, kept 30 days and created with the default umask (4.118.0 and 4.90.1, run
 * with a made-up token: `docs/receipts/wrangler-json-output.md`). `WRANGLER_WRITE_LOGS=false` stops that from
 * 4.91.0; below it, `WRANGLER_LOG_PATH` sends the file into a private directory removed as soon as wrangler
 * exits. Both, because this runs before any preflight has checked the version.
 *
 * Under the Deploy button (Workers Builds, `CLOUDFLARE_API_TOKEN` and no login) nothing calls this: `mailda
 * deploy` never reads the token.
 */
export function wranglerTokenRead() {
  const logs = mkdtempSync(join(tmpdir(), "mailda-wrangler-log-"));
  try {
    const answer = capture("npx", ["wrangler", "auth", "token", "--json"], {
      quiet: true, env: { WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_PATH: logs },
    });
    return tokenFrom(answer.stdout, answer.status, answer.stderr);
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
}

/** The operator's own credential, for one request and no longer; the Node never stores it. */
const operatorHeaders = (cookie, token, accountId) =>
  ({ cookie, "content-type": "application/json", "x-cloudflare-token": token, "x-cloudflare-account": accountId });

/** A refusal, printed whole under the step it belongs to. */
const refused = (text) => { for (const line of text.split("\n")) process.stdout.write(`     ${line}\n`); process.stdout.write("\n"); };

/**
 * What a read of the account's verified destinations found, in lines to print under a step (28 September 2026).
 * Counts only, never an address. `error` is tested first: a failed read still counts the recipients, and
 * "0 of 3" there would turn could not read into none verified.
 */
export function verifiedDestinationLines(d) {
  const said = d.error !== null
    ? `could not read: ${d.error}; ${d.readAt === null ? "until a read succeeds, those recipients show as unobserved" : `the read of ${d.readAt} stands`}`
    : d.recipients === 0
      ? `nothing to compare: this Node has handed mail to nobody yet (read ${d.readAt}, account ${d.accountId})`
      : `${d.verified} of ${d.recipients} address(es) this Node has handed mail to (read ${d.readAt}, account ${d.accountId}); `
        + "no outcome is reported for verified destinations, in the one case measured "
        + "(docs/receipts/email-sending-events.md)";
  const lines = wrapAt(said, 70).map((line, i) => `${i === 0 ? "verified destinations " : "                      "} ${line}`);
  // The account's whole list (ADR 47), counted; the addresses only when the operator asked for them.
  if ((d.listed ?? null) !== null) {
    lines.push(`destination addresses  ${d.listed.verified} verified, ${d.listed.waiting} waiting for verification`);
  }
  for (const one of d.addresses ?? []) lines.push(`                       ${one.email}  ${one.state === "verified" ? "verified" : "waiting for verification"}`);
  return lines;
}

/** What registering a destination left, in one phrase: waiting is said with what ends it. */
export function destinationSaid(destination) {
  if (destination.state === "verified") return destination.added ? "registered and verified" : "already verified; nothing was sent";
  return `${destination.added ? "registered" : "already registered; no second link was sent"}: waiting for verification until `
    + `someone at ${destination.email} clicks the link Cloudflare mailed them`;
}

/**
 * One kept forward (ADR 47) as `mailda provider --forwards` prints it, the same facts People shows: where it forwards,
 * what the last read of the account's destinations said, and its latest attempt with Cloudflare's words.
 */
export function keptForwardLines(one) {
  const verified = one.verified === null ? "not checked" : one.verified === "waiting" ? "waiting for verification"
    : one.verified === "absent" ? "not a destination of the account" : "verified";
  const last = one.last === null ? "nothing has arrived since it was kept"
    : one.last.state === "handed_over" ? `last forwarded ${one.last.at}`
      : one.last.state === "refused" ? `not forwarded at ${one.last.at}: ${one.last.error}`
        : one.last.state === "withheld" ? `withheld at ${one.last.at}: ${one.last.error}`
          : `no recorded answer for the forward at ${one.last.at}: ${one.to} may or may not have it`;
  return [
    `${one.address}  forwards to ${one.to} (${verified}${one.checkedAt === null ? "" : `, read ${one.checkedAt}`})`,
    ...wrapAt(last, 88).map((line) => `  ${line}`),
  ];
}

/**
 * Asks the Node to read which of its recipients are verified destinations of the account, with the operator's
 * credential, and prints what it recorded. Cloudflare published no delivery event for mail to one in the case
 * measured (`docs/receipts/email-sending-events.md`), so without this read the Outbox and doctor wait for an
 * answer that is not coming. A refusal (a Node older than the route answers 404), an answer that broke off, or
 * one not in the route's shape is printed and the run goes on: it never exits, and never throws.
 */
export async function verifiedDestinationsStep({ origin, cookie, accountId, token }) {
  const path = api("POST", "/api/provider/verified-destinations");
  process.stdout.write("\n");
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: operatorHeaders(cookie, token, accountId) })
    .catch((error) => error);
  if (response instanceof Error) {
    process.stdout.write("   verified destinations  not read:\n");
    refused(`POST ${path} could not reach ${origin}: ${response.message}`);
    return;
  }
  // The headers arrived; the body can still break off, and that is a refusal printed, not a throw after a deploy.
  const text = await response.text().catch((error) => error);
  if (text instanceof Error) {
    process.stdout.write("   verified destinations  not read:\n");
    refused(`POST ${path} answered ${response.status} and the answer broke off: ${text.message}`);
    return;
  }
  // The route's shape, from the contract, or the answer is printed as it came: a line built from anything
  // else would throw, or say "could not read: undefined".
  const answer = response.ok ? providerVerifiedDestinationsResponse.safeParse(parsed(text)) : null;
  if (!answer?.success) {
    process.stdout.write("   verified destinations  not read:\n");
    refused(`POST ${path} answered ${response.status}:\n${text}`);
    return;
  }
  for (const line of verifiedDestinationLines(answer.data.destinations)) process.stdout.write(`   ${line}\n`);
}

/** JSON, or null for a body that is not: an answer that is not the route's is printed, not thrown. */
function parsed(text) {
  try { return JSON.parse(text); } catch { return null; }
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
    ...zones.map((zone) => ({ label: `${zone.name}   (its own name: a catch-all can route every address without a rule of its own here)`, value: zone.name })),
    { label: "a subdomain, such as mail.example.com: pick its zone, then type the name (one rule per address)", value: "typed" },
    { label: "skip for now: the Node cannot receive mail until this is done", value: "" },
  ];
}

/**
 * The zones the operator's token can see in this account, every page of them (30 September 2026).
 *
 * This read one page of 50 and stopped, so an account with a 51st zone lost it from the picker without a word.
 * It pages on the API's own `result_info.total_pages` now. A page that fails is said, with how far the read
 * got, and what was read is still offered; nothing is dropped silently. `fetchImpl` is for the test.
 */
export async function zonesOf(accountId, token, fetchImpl = fetch) {
  const zones = [];
  for (let page = 1; ; page += 1) {
    const url = `https://api.cloudflare.com/client/v4/zones?account.id=${encodeURIComponent(accountId)}&per_page=50&page=${page}`;
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } }).catch((error) => error);
    const body = response instanceof Error ? null : await response.json().catch(() => null);
    if (response instanceof Error || !response.ok || !Array.isArray(body?.result)) {
      const why = response instanceof Error ? response.message : `answered ${response.status}`;
      process.stdout.write(`   note: the zone list stopped at page ${page} (${why}); ${zones.length} zone(s) were read before it.\n`);
      break;
    }
    zones.push(...body.result.filter((one) => typeof one?.name === "string").map((one) => ({ name: one.name })));
    // The API's count when it gives one; otherwise a short page is the last.
    const total = body.result_info?.total_pages;
    if (typeof total === "number" ? page >= total : body.result.length < 50) break;
  }
  return zones;
}

/** The two routing states that deliver an address here; every other one is named, never counted as set up. */
const ROUTED_HERE = new Set(["catch_all", "rule_written"]);

/**
 * What a receiving record (`GET /api/provider`'s `provisioned.receiving`) says for a summary (28 September 2026):
 * set up only when its address was routed here. A record from before the outcome was recorded carries none and
 * reads as it always did; `routing` is then null, as it is when the address does route here.
 */
export function receivingOf(act) {
  if (act === null || act === undefined) return { receiving: null, address: null, routing: null };
  const routing = act.routing ?? null;
  const here = routing === null || ROUTED_HERE.has(routing.state);
  return { receiving: here ? act.domain : null, address: act.address ?? null, routing: here ? null : routing };
}

/**
 * The name the Node receives at, for the routing step (1 October 2026): the one on record, else the one this run's
 * receiving step put its first address on, else null (no step).
 */
export function receivingDomain(provisioned, setUp) {
  return provisioned?.receiving?.domain ?? setUp?.address?.split("@")[1] ?? null;
}

/**
 * Whether a receiving outcome's address reaches this Node: its `routing`, since a rule of its own outranks the
 * catch-all and a check that could not be made is not a yes. An answer from a Node older than `routing` has only
 * `rule`, which stands in as it always did.
 */
export function outcomeRoutesHere(outcome) {
  const routing = outcome.routing ?? null;
  return routing === null ? outcome.rule !== null : ROUTED_HERE.has(routing.state);
}

/**
 * The mailbox's first address from what was typed at the prompt, which asks for the part before the `@` and shows
 * the domain (28 September 2026), as People's address field does: blank is `defaultLocal`, a local part is put on
 * `domain`, and an answer carrying its own `@` is taken whole, so a pasted address is not given a second domain.
 */
export function firstAddress(typed, domain, defaultLocal = "hello") {
  const answer = (typed ?? "").trim().toLowerCase();
  if (answer === "") return `${defaultLocal}@${domain}`;
  return answer.includes("@") ? answer : `${answer}@${domain}`;
}

/**
 * The addresses on a domain with an Email Routing rule of their own, from the receiving proposal's `ownRules`
 * (28 September 2026), as lines to print (unindented). An enabled literal rule outranks the catch-all, so a
 * take-over does not reach its address, and the prompt that offers it read as "every address" while `sales@` and
 * `info@` went on to another Worker. A disabled one is not claimed either way, as the Setup screen's row says:
 * Cloudflare does not say whether the catch-all then applies. Unread is said, and so is a Node too old to list
 * them; neither is "none".
 */
export function ownRulesLines(ownRules, domain, { below = false } = {}) {
  if (ownRules === undefined || ownRules === null) {
    return wrapAt(`this Node does not list which addresses at ${domain} have an Email Routing rule of their own (it predates `
      + `the list); \`mailda provider --routing-rules ${domain}\` shows every rule on the zone`, 70);
  }
  if (ownRules.error !== null) {
    return wrapAt(`which addresses at ${domain} have an Email Routing rule of their own could not be read, so what the `
      + `catch-all would not reach is unknown: ${ownRules.error}`, 70);
  }
  if (ownRules.addresses.length === 0) return [`no address at ${domain} has an Email Routing rule of its own`];
  const width = Math.max(...ownRules.addresses.map((one) => one.address.length));
  return [
    ...wrapAt(`addresses at ${domain} with an Email Routing rule of their own (${ownRules.addresses.length}). An enabled `
      + "rule outranks the catch-all, so the catch-all does not reach that address; this Node leaves every one of "
      // The routing step follows the receiving step in install, setup and upgrade (1 October 2026).
      + `these rules as it is${below ? " unless you choose otherwise below" : ""}:`, 70),
    ...ownRules.addresses.map((one) => `  ${one.address.padEnd(width)}  ${one.state === "rule_written"
      ? "this Node"
      : one.state === "rule_disabled" ? `disabled (enabled, it would be ${one.where})` : one.where}`),
    // After the list rather than on each row, which would run past the terminal: what the Setup screen's row says.
    ...(ownRules.addresses.some((one) => one.state === "rule_disabled")
      ? wrapAt("for a disabled rule, Cloudflare does not say whether the catch-all then applies to its address", 70)
      : []),
  ];
}

/**
 * The first address's default local part (28 September 2026): the administrator's own, when they sign in with an
 * address on this domain that has no rule of its own sending it elsewhere, so the mailbox they reply from is the
 * address they already use. Otherwise `hello`, and `said` names why when the sign-in address was on the domain.
 */
export function defaultLocalFor(signInEmail, domain, ownRules) {
  const email = (signInEmail ?? "").trim().toLowerCase();
  if (!email.endsWith(`@${domain.toLowerCase()}`)) return { local: "hello", said: null };
  if (ownRules === undefined || ownRules === null || ownRules.error !== null) {
    return { local: "hello", said: `${email} is not the default: whether it has an Email Routing rule of its own could not be checked` };
  }
  const own = ownRules.addresses.find((one) => one.address === email);
  if (own !== undefined && own.state !== "rule_written") {
    return { local: "hello", said: `${email} is not the default: it has an Email Routing rule of its own, ${own.state === "rule_disabled" ? `disabled (enabled, it would be ${own.where})` : own.where}` };
  }
  return { local: email.slice(0, email.lastIndexOf("@")), said: null };
}

/** The routing states in which the Node could not tell where the address's mail goes: never said as "does not". */
const COULD_NOT_TELL = new Set(["unconfirmed", "rule_disabled"]);

/**
 * The install's last line (28 September 2026): the founder claimed as `admin@` and only later found replies went
 * out as the mailbox's `hello@`. The address is the one this run's receiving step put on the mailbox, when it did.
 * A refused onboarding names the address it asked for as one that may be there: the Node registers it before
 * asking Cloudflare anything, so a refusal after that leaves it on the mailbox, and the CLI cannot see which.
 */
export function signInLine(email, setUp) {
  if (setUp.address === null) {
    return setUp.attempted
      ? `You sign in as ${email}. The onboarding stopped, and ${setUp.attempted} may already be on the mailbox; People shows its addresses.`
      : `You sign in as ${email}. Mail goes out from the mailbox's address, and this run set none up; People adds one.`;
  }
  const routing = setUp.routing ?? null;
  return `You sign in as ${email}. Mail goes out as ${setUp.address}${setUp.sending === null ? " once sending is set up" : ""}`
    + `${routing === null ? "" : COULD_NOT_TELL.has(routing.state)
      ? ", and whether mail to it reaches this Node could not be confirmed (above)"
      : ", and mail to it does not reach this Node (above)"}.`;
}

export async function provisionNode({ origin, cookie, accountId, token, yes, ask, provisioned = null, signInEmail = null }) {
  const done = { receiving: null, sending: null, deliveryEvents: null, address: null, attempted: null, catchAll: false, routing: null };
  /*
   * What the Node already has on record (`GET /api/provider`'s `provisioned`) is not asked or done again.
   * A Node whose receiving was set up at install but whose sending was onboarded from the dashboard before
   * it existed reached here with only the receiving step recorded, and the upgrade ran nothing because
   * receiving was present (26 September 2026): each step is skipped on its own record, not on the first.
   */
  const recorded = provisioned?.receiving ?? null;
  let domain = "";
  if (recorded !== null) domain = recorded.domain;
  else if (yes) domain = (process.env.MAILDA_DOMAIN ?? "").trim().toLowerCase();
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
  let address = recorded?.address ?? `hello@${domain}`;

  const call = async (method, template, body, query) => {
    const path = api(method, template, query);
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: operatorHeaders(cookie, token, accountId),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, text: `${method} ${path} answered ${response.status}:\n${text}` };
    return { ok: true, value: JSON.parse(text) };
  };
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
  /** Why receiving is not set up, in a sentence the summary quotes: a refusal, or what the outcome's note said. */
  let receivingWhy = null;

  // 1. Receiving: the subdomain's records and the rule to this Worker.
  // The domain until an address is on record: the first one is asked below, and its default is not always hello.
  process.stdout.write(`\n   receiving at ${recorded?.address ?? domain}\n`);
  const receiving = recorded !== null ? null : await call("GET", "/api/provider/receiving", undefined, { domain });
  if (recorded !== null) {
    /*
     * The record and its outcome (28 September 2026): an onboarding whose address went elsewhere, or could not
     * be checked, is said again on every re-run rather than read as set up because the intent was recorded.
     */
    const was = receivingOf(recorded);
    process.stdout.write(`     recorded  ${recorded.at.slice(0, 10)}`
      + `${(recorded.routing ?? null) === null ? "; how the address is routed was not recorded (an onboarding from before 28 September 2026)" : ""}\n`);
    Object.assign(done, was, { address });
    if (was.routing !== null) {
      receivingWhy = firstSentence(was.routing.detail);
      for (const line of wrapAt(was.routing.detail, 70)) process.stdout.write(`     ${line}\n`);
    }
  } else if (!receiving.ok) refused(receiving.text);
  else {
    const { proposal } = receiving.value;
    if (proposal.zone !== null) process.stdout.write(`     zone      ${proposal.zone} (routing ${proposal.zoneRouting ?? "?"})\n`);
    if (proposal.enablesZone !== null) process.stdout.write(`     enables   Email Routing on ${proposal.enablesZone}; that writes MX and SPF at the apex\n`);
    for (const one of proposal.present) process.stdout.write(`     has       MX ${one}\n`);
    for (const one of proposal.creates) process.stdout.write(`     writes    MX ${one.name} -> ${one.content} (priority ${one.priority})\n`);
    if (proposal.refusal !== null) {
      receivingWhy = `refused: ${firstSentence(proposal.refusal)}`;
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
        // Printed before the choice, not in its prompt, which is redrawn on every arrow press; and under --yes too.
        process.stdout.write(`\n     ${domain} is a zone's own name. Its catch-all today: ${catchAllLine(proposal.catchAll ?? null)}.\n`);
        for (const line of ownRulesLines(proposal.ownRules, domain, { below: true })) process.stdout.write(`     ${line}\n`);
        catchAll = yes
          ? process.env.MAILDA_CATCH_ALL === "1"
          : await choose(
            "     How should mail reach this Node?",
            [
              { label: "every address without a rule of its own: take the catch-all; addresses live in the Node, unknown ones bounce", value: true },
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
        ? `     every address at ${domain} without an Email Routing rule of its own will reach this Node; the mailbox\n`
          + "     files the ones it holds. This is its first; more are added on People, which reads each one's rules\n"
          + "     and says when a rule of its own sends it elsewhere.\n"
        : `     one rule routes one address to this Node; each further address needs its own\n     (\`mailda provider --onboard-receiving ${domain} --address <a>\`), or take the catch-all later.\n`);
      const suggested = defaultLocalFor(signInEmail, domain, proposal.ownRules);
      if (suggested.said !== null) for (const line of wrapAt(`${suggested.said}.`, 70)) process.stdout.write(`     ${line}\n`);
      address = firstAddress(yes ? process.env.MAILDA_ADDRESS : await ask(`     the mailbox's first address: the part before @${domain} [${suggested.local}]: `), domain, suggested.local);
      const applied = await call("POST", "/api/provider/receiving", {
        domain, digest: proposal.digest, address, ...(catchAll ? { catchAll: true } : {}),
      });
      if (!applied.ok) {
        refused(applied.text);
        // A refusal after the Node registered the address (it does so before asking Cloudflare) leaves it on the
        // mailbox with no route, and this answer does not say which it was: the last line says it may be there.
        done.attempted = address;
      } else {
        // Only once the Node took it, and routed or said why not: the address mail goes out as.
        done.address = address;
        const { outcome } = applied.value;
        for (const one of outcome.confirmed) process.stdout.write(`     confirmed MX ${one}\n`);
        if (outcome.catchAll !== null && outcome.catchAll !== undefined) {
          process.stdout.write(`     catch-all ${catchAllLine(outcome.catchAll.before)} -> ${catchAllLine(outcome.catchAll.after)}\n`
            + `               put back: mailda provider --put-back <id> --domain ${domain}, the id being the catch-all's\n`
            + `               row in \`mailda provider --routing-rules ${domain}\`\n`);
          done.catchAll = true;
        } else if (outcome.rule !== null) process.stdout.write(`     rule      ${outcome.rule}\n`);
        if (outcome.note !== null) for (const line of wrapAt(outcome.note, 70)) process.stdout.write(`     ${line}\n`);
        /*
         * Set up, not verified: the read-back proves the records, and delivery is proven by a message. Whether
         * the address itself reaches this Node is `routing` (28 September 2026): a rule of its own outranks the
         * catch-all, and a check that could not be made is not a yes. The note above carries its detail; the
         * summary quotes its first sentence. An answer without `routing` is a Node from before it.
         */
        const routing = outcome.routing ?? null;
        const here = outcomeRoutesHere(outcome);
        if (here && (outcome.confirmed.length > 0 || done.catchAll)) done.receiving = domain;
        else if (routing !== null && !here) {
          done.routing = routing;
          receivingWhy = firstSentence(routing.detail);
        }
      }
    }
  }

  // 2. Sending: the domain onboarded for Email Sending.
  process.stdout.write(`\n   sending from ${domain}\n`);
  const sending = provisioned?.sending ? null : await call("GET", "/api/provider/sending", undefined, { domain });
  if (sending === null) {
    process.stdout.write(`     recorded  ${provisioned.sending.at.slice(0, 10)}${provisioned.sending.observed ? " (in place before this Node, observed)" : ""}\n`);
    done.sending = provisioned.sending.domain;
  } else if (!sending.ok) refused(sending.text);
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
  const subscription = provisioned?.deliveryEvents ? null : await call("GET", "/api/provider/subscription", undefined, { domain });
  if (subscription === null) {
    process.stdout.write(`     recorded  ${provisioned.deliveryEvents.at.slice(0, 10)}${provisioned.deliveryEvents.observed ? " (in place before this Node, observed)" : ""}\n`);
    done.deliveryEvents = provisioned.deliveryEvents.domain;
  } else if (!subscription.ok) refused(subscription.text);
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
      ? done.catchAll
        ? `catch-all on ${domain}, but ${address} is not routed here (${receivingWhy ?? "see above"})`
        : (receivingWhy === null ? "not set up" : `not set up (${receivingWhy})`)
      : `${address} on ${done.receiving}${done.catchAll ? " (catch-all: every address without a rule of its own)" : ""}`}\n`
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
  } else if (setUp.routing !== null && setUp.routing !== undefined) {
    /*
     * The step ran and recorded that its address does not reach this Node, so a re-run reads the same record and
     * says the same; "the app shows the next setup step" would send the operator to a step already done. What
     * stops it is named, and so is routing another address instead (28 September 2026).
     */
    const domain = setUp.address?.split("@")[1] ?? "<domain>";
    const lines = wrapAt(`${setUp.address} is not routed here: ${setUp.routing.detail}`, 72);
    process.stdout.write(lines.map((line, i) => `   ${i === 0 ? "then       " : "           "} ${line}\n`).join("")
      + `               or route another address: mailda provider --onboard-receiving ${domain} --address <another> --url ${origin}\n`);
  } else {
    process.stdout.write(
      "   then        the app shows the next setup step instead of an inbox until this Node has a routed\n"
      + "               address; `mailda setup` runs this step again, with another domain\n",
    );
  }
  if (setUp.catchAll === true) {
    process.stdout.write("   addresses   add more on People; the catch-all routes each one here unless a rule of its own\n"
      + "               sends it elsewhere, and People says when one does\n");
  }
  if (setUp.receiving !== null && setUp.deliveryEvents === null) {
    process.stdout.write("   outcomes    not subscribed: replies hand over but their delivery stays unobserved; `mailda setup` retries\n");
  }
  process.stdout.write("\n");
}
