import { recordedInName } from "@mailda/contract/routing-rule-name";
import { MAX_MAILBOX_NAME_CHARS } from "@mailda/contract/schemas";

import { api, choose as chooseInTerminal, fail, wrapAt } from "../support.mjs";
import { plural } from "@mailda/runtime";

/**
 * The Email Routing rules that keep addresses from reaching this Node, shown on every setup and upgrade, with the
 * choice of pointing each one here (1 October 2026, the owner's request of 29 September).
 *
 * A rule for one address outranks the catch-all, so on a zone that received mail before this Node existed, the
 * addresses people actually use (`sales@` to another Worker, `someone@` forwarded to a personal inbox) never
 * reach it, and nothing said so after the first install. This step lists them and offers, per rule, "leave it"
 * (the default) or the one change the Node itself proposes for that kind of rule, in the Node's own words
 * (`GET /api/provider/routing-rules`' `takeOver`, which the Setup screen shows too). "Point here" is the existing
 * take-over: the rule is repointed, the change is audited, its previous action is written into the rule's name,
 * and a put-back restores it. Nothing is deleted.
 *
 * Shaped like `verifiedDestinationsStep`: it never exits and never throws, and every refusal is printed under its
 * row while the other rows go ahead. Under `--yes`, or with no terminal to ask in, it prints the list and the exact
 * command for each rule and changes nothing, as Wrangler applies no destructive routing change without a person.
 */

/** The sentence that heads the list, and every claim it makes (critic M9: never "every change can be undone"). */
const HEADER = [
  "A rule for one address outranks the catch-all, so each address below goes where its own rule says, not to the catch-all "
    + "(a disabled rule's address, Cloudflare does not say).",
  "Nothing changes unless you choose it here. Every rule can be pointed back; mail that arrived here meanwhile stays here.",
];

/** The host part of an address. */
const hostOf = (address) => address.slice(address.lastIndexOf("@") + 1);

/**
 * What the step shows for one zone's listing, pure: the rows on the names this Node receives for, and a count of
 * the rules on other names. A name is received for when it is the receiving domain or a rule on it already names
 * this Node. The catch-all is the receiving step's, and is not a row here.
 */
export function rulesPlan(listing, domain) {
  const literal = listing.rules.filter((rule) => !rule.catchAll);
  const served = new Set([domain, ...literal.filter((rule) => rule.ours).map((rule) => hostOf(rule.to))]);
  const shown = literal.filter((rule) => served.has(hostOf(rule.to)));
  const hidden = literal.filter((rule) => !served.has(hostOf(rule.to)));
  return {
    shown,
    offered: shown.filter((rule) => rule.offer === "take_over" && (rule.takeOver ?? null) !== null),
    hidden: { count: hidden.length, names: [...new Set(hidden.map((rule) => hostOf(rule.to)))].sort() },
  };
}

/** Where a rule sends its address today, in one phrase. */
export function whereTo(rule) {
  if (rule.ours) return "this Node";
  const to = rule.destinations.join(", ");
  const said = rule.action === "forward" ? `forward to ${to}` : rule.action === "drop" ? "drop" : `${rule.action} ${to}`;
  return `${said}${rule.enabled ? "" : "  (disabled)"}`;
}

/**
 * Whether taking `rule` over by hand needs `--mailbox`, which is wherever the Node would refuse without one: a forward,
 * or an address with no row of its own when the organization has other than one mailbox
 * (`E_RECEIVING_MAILBOX_AMBIGUOUS`), or when that is not known (`mailboxes` null). `mailda provider --routing-rules`
 * asks the same.
 */
export function needsMailbox(rule, mailboxes) {
  return rule.takeOver?.filesInto == null && (rule.takeOver?.asksMailbox === true || mailboxes?.length !== 1);
}

/**
 * What a Worker rule's code names as forward destinations (ADR 47, amended 7 October 2026), in one sentence: the
 * addresses the account lists, each with its state, or why the code or the list was not read. Pure.
 */
export function foundSaid(forwardTo, worker) {
  if ((forwardTo?.found ?? null) === null) return `${worker}'s code was not read: ${forwardTo?.foundError ?? "this Node did not say why"}`;
  if (forwardTo.found.length === 0) return `${worker}'s code names no address the account lists as a destination`;
  const state = (one) => one.verified === "verified" ? "verified" : one.verified === "waiting" ? "waiting for verification"
    : one.verified === "absent" ? "not a destination of the account" : "not checked";
  return `found in ${worker}'s code: ${forwardTo.found.map((one) => `${one.to} (${state(one)})`).join(", ")}`;
}

/** The addresses a forward is offered to start from: the verified ones a Worker's code names. Pure. */
export function suggested(forwardTo) {
  return (forwardTo?.found ?? []).filter((one) => one.verified === "verified").map((one) => one.to);
}

/**
 * The command that takes one rule over by hand: printed under `--yes`, and wherever the step could not ask. A forward
 * rule needs `--forward keep` or `--forward stop` (ADR 47), and neither is a default: `forward` picks which one is
 * printed, and with none the command says `--forward <keep|stop>` for the operator to fill in.
 */
export function takeOverCommand(rule, domain, origin, mailboxes = null, forward = null, copy = false, forwardTo = null) {
  // A Node older than ADR 47 lists no `keep` and refuses the field, so it is named only to a Node that offers it.
  const choice = forward !== null ? ` --forward ${forward}${copy ? " --copy" : ""}`
    : forwardTo !== null ? ` --forward-to ${forwardTo.length === 0 ? "<addresses>" : forwardTo.join(",")}${copy ? " --copy" : ""}`
    : rule.action === "forward" && rule.takeOver?.keep != null ? " --forward <keep|stop>" : "";
  return `mailda provider --take-over ${rule.id} --domain ${domain} --confirm ${rule.digest}`
    + `${needsMailbox(rule, mailboxes) ? " --mailbox <mailbox id>" : ""}${choice} --url ${origin}`;
}

/** The commands for one rule under `--yes`: a forward rule's two choices each with the Node's words, else the one. */
export function takeOverCommands(rule, domain, origin, mailboxes = null) {
  // A Worker rule's forward (ADR 47, amended 7 October 2026), only to a Node that lists it, starting from its code.
  const forwardTo = rule.takeOver?.forwardTo ?? null;
  if (forwardTo !== null) {
    return [
      { label: rule.takeOver.label, command: takeOverCommand(rule, domain, origin, mailboxes) },
      { label: forwardTo.label, command: takeOverCommand(rule, domain, origin, mailboxes, null, false, suggested(forwardTo)) },
    ];
  }
  if (rule.action !== "forward" || (rule.takeOver?.keep ?? null) === null) return [{ label: null, command: takeOverCommand(rule, domain, origin, mailboxes) }];
  // Copies (ADR 47 amended) only to a Node that lists them, in its words: an older one refuses the field.
  const copy = rule.takeOver.keep.copy ?? null;
  return [
    { label: rule.takeOver.label, command: takeOverCommand(rule, domain, origin, mailboxes, "stop") },
    { label: rule.takeOver.keep.label, command: takeOverCommand(rule, domain, origin, mailboxes, "keep") },
    ...(copy === null ? [] : [{ label: copy.label, command: takeOverCommand(rule, domain, origin, mailboxes, "keep", true) }]),
  ];
}

/**
 * The mailboxes a rule's address may be filed into, in the order offered: one already named after the address first
 * (made by an earlier run whose take-over was refused, so it is never made twice), then, for a forward, a new one
 * named after it, which is offered only while no mailbox has that name and the address fits a mailbox name.
 */
function mailboxChoices(rule, mailboxes) {
  const named = mailboxes.find((box) => box.name.toLowerCase() === rule.to.toLowerCase()) ?? null;
  const fresh = named === null && rule.to.length <= MAX_MAILBOX_NAME_CHARS
    ? [{ label: `a new mailbox named ${rule.to}`, value: { id: null, name: rule.to } }] : [];
  const others = mailboxes.filter((box) => box !== named).map((box) => ({ label: box.name, value: box }));
  const first = named === null ? [] : [{ label: named.name, value: named }];
  return rule.takeOver.asksMailbox ? [...first, ...fresh, ...others] : [...first, ...others, ...fresh];
}

/** One row as printed in the list: the address, where it goes, and under it the put-back or why nothing is offered. */
export function ruleLines(rule, domain, origin, width) {
  const head = `${rule.to.padEnd(width)}  ${whereTo(rule)}`;
  const under = (text) => wrapAt(text, 96 - width).map((line) => `${" ".repeat(width)}  ${line}`);
  // A command is printed whole, never wrapped, so it can be copied.
  if (rule.offer === "put_back") return [head, `${" ".repeat(width)}  put back: mailda provider --put-back ${rule.id} --domain ${domain} --url ${origin}`];
  if (rule.offer === "take_over" && (rule.takeOver ?? null) === null) {
    return [head, ...under(`not offered here: this Node is older than this step; ${takeOverCommand(rule, domain, origin)} does it by hand`)];
  }
  if (rule.offer === null && rule.refusal != null) return [head, ...under(`${rule.ours ? "" : "not offered: "}${rule.refusal.what}; ${rule.refusal.fix}`)];
  return [head];
}

/**
 * The step itself. `domain` is the name the Node receives for (null: nothing to show). `ask` and `choose` are the
 * terminal's, injectable so the prompt flow runs under a test.
 */
export async function routingRulesStep({ origin, cookie, accountId, token, yes, domain, ask, choose = chooseInTerminal }) {
  if (domain === null || domain === undefined || cookie === null) return;
  const out = (line = "") => process.stdout.write(line === "" ? "\n" : `   ${line}\n`);
  const headers = {
    cookie, "content-type": "application/json",
    ...(token === null || token === undefined ? {} : { "x-cloudflare-token": token, "x-cloudflare-account": accountId }),
  };
  const call = async (method, template, body, query) => {
    const path = api(method, template, query);
    try {
      const response = await fetch(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      if (!response.ok) {
        const code = (() => { try { return JSON.parse(text)?.error ?? null; } catch { return null; } })();
        // What the Node could not confirm, or never answered, may have happened (AGENTS.md §3: never rounded to failed).
        return { ok: false, unknown: response.status >= 500 || code === "E_ROUTING_RULE_NOT_CONFIRMED", text: `${method} ${path} answered ${response.status}:\n${text}` };
      }
      return { ok: true, value: JSON.parse(text) };
    } catch (error) {
      return { ok: false, unknown: true, text: `${method} ${path} could not be read from ${origin}: ${error.message}` };
    }
  };
  const refused = (text, indent = "  ") => { for (const line of text.split("\n")) out(`${indent}${line}`); };

  process.stdout.write(`\n== Email Routing rules on ${domain}\n`);
  const listed = await call("GET", "/api/provider/routing-rules", undefined, { domain });
  if (!listed.ok) { out("not read:"); refused(listed.text); return; }
  const listing = listed.value.routing;
  if (listing.error !== null) { out(`not read: ${listing.error}`); return; }
  const plan = rulesPlan(listing, domain);
  for (const line of HEADER.flatMap((one) => wrapAt(one, 96))) out(line);
  out();
  if (plan.shown.length === 0) out(`no address at ${domain} has a rule of its own`);
  const width = Math.max(0, ...plan.shown.map((rule) => rule.to.length));
  for (const rule of plan.shown) for (const line of ruleLines(rule, domain, origin, width)) out(line);
  if (plan.hidden.count > 0) {
    for (const line of wrapAt(`${plan.hidden.count} ${plural(plan.hidden.count, "rule", "rules")} on ${plan.hidden.names.join(" and ")} ${plural(plan.hidden.count, "is", "are")} not shown: this Node does not `
      + "receive for those names. List them:", 96)) out(line);
    out(`  mailda provider --routing-rules ${plan.hidden.names[0]} --url ${origin}`);
  }
  if (plan.offered.length === 0) return;

  const mailboxesNow = async () => {
    const boxes = await call("GET", "/api/mailboxes");
    return boxes.ok ? { ok: true, mailboxes: boxes.value.mailboxes.map((one) => ({ id: one.id, name: one.name })) } : boxes;
  };

  if (yes || process.stdin.isTTY !== true) {
    const boxes = await mailboxesNow();
    const commands = plan.offered.map((rule) => [rule, takeOverCommands(rule, domain, origin, boxes.ok ? boxes.mailboxes : null)]);
    out();
    out(`${yes ? "--yes" : "With no terminal to ask in, this"} changes no routing rule. To point one here:`);
    for (const [rule, choices] of commands) {
      out(`  ${rule.to}`);
      for (const { label, command } of choices) { if (label !== null) out(`    ${label}:`); out(`    ${command}`); }
    }
    if (commands.some(([, choices]) => choices.some(({ command }) => command.includes("--mailbox")))) {
      if (!boxes.ok) { out("the mailboxes, for <mailbox id>, could not be listed:"); refused(boxes.text); return; }
      out("the mailboxes, for <mailbox id>:");
      const width = Math.max(0, ...boxes.mailboxes.map((box) => box.id.length));
      for (const box of boxes.mailboxes) out(`  ${box.id.padEnd(width)}  ${box.name}`);
    }
    return;
  }
  const go = await ask("\n   Point any of these at this Node? [y/N] ");
  if (!/^y(es)?$/i.test(go.trim())) { out("left as they are."); return; }

  const boxes = await mailboxesNow();
  const mailboxes = boxes.ok ? boxes.mailboxes : [];
  if (!boxes.ok) { out("the mailboxes could not be listed, so only a new one is offered:"); refused(boxes.text); }

  // Each rule: leave it (the default) or the Node's one change; then, when the Node leaves it open, which mailbox.
  const chosen = [];
  for (const rule of plan.offered) {
    process.stdout.write("\n");
    out(`${rule.to}   ${whereTo(rule)}`);
    for (const line of wrapAt(`${rule.takeOver.label}: ${rule.takeOver.says}.`, 90)) out(`  ${line}`);
    // A forward rule's third choice (ADR 47): keep the forward, in the Node's words.
    const keep = rule.takeOver.keep ?? null;
    if (keep !== null) for (const line of wrapAt(`${keep.label}: ${keep.says}.`, 90)) out(`  ${line}`);
    // The fourth (ADR 47 amended): keep, and copy when the forward is refused as not verified, in the Node's words.
    const copying = keep?.copy ?? null;
    if (copying !== null) for (const line of wrapAt(`${copying.label}: ${copying.says}.`, 90)) out(`  ${line}`);
    // A Worker rule's forward and its copy (ADR 47, amended 7 October 2026), with what the Worker's code names.
    const forwardTo = rule.takeOver.forwardTo ?? null;
    if (forwardTo !== null) {
      for (const line of wrapAt(`${forwardTo.label}: ${forwardTo.says}. ${foundSaid(forwardTo, rule.destinations[0])}.`, 90)) out(`  ${line}`);
      for (const line of wrapAt(`${forwardTo.copy.label}: ${forwardTo.copy.says}.`, 90)) out(`  ${line}`);
    }
    const take = await choose(`   ${rule.to}`, [
      { label: "leave it", value: false },
      // "stop" only to a Node that offers the choice: an older one lists no `keep` and refuses the field.
      { label: rule.takeOver.label, value: keep !== null ? "stop" : true },
      ...(keep === null ? [] : [{ label: keep.label, value: "keep" }]),
      ...(copying === null ? [] : [{ label: copying.label, value: "keep-copy" }]),
      ...(forwardTo === null ? [] : [{ label: forwardTo.label, value: "to" }, { label: forwardTo.copy.label, value: "to-copy" }]),
    ]);
    if (!take) continue;
    const forward = take === "keep" || take === "keep-copy" ? "keep" : take === "stop" ? "stop" : null;
    const copy = take === "keep-copy" || take === "to-copy";
    // The addresses, starting from the verified ones the Worker's code names: Enter takes them as offered.
    let to = null;
    if (take === "to" || take === "to-copy") {
      const offer = suggested(forwardTo);
      const typed = (await ask(`   forward ${rule.to} to (comma-separated)${offer.length === 0 ? "" : ` [${offer.join(", ")}]`}: `)).trim();
      to = (typed === "" ? offer : typed.split(",")).map((one) => one.trim().toLowerCase()).filter((one) => one !== "");
      if (to.length === 0) { out(`  left as it is: no address was given to forward ${rule.to} to`); continue; }
    }
    const options = mailboxChoices(rule, mailboxes);
    if (rule.takeOver.filesInto === null && options.length === 0) {
      out(`  left as it is: no mailbox could be listed, and ${rule.to} is longer than a mailbox name may be`);
      continue;
    }
    const mailbox = rule.takeOver.filesInto !== null
      ? rule.takeOver.filesInto
      : !rule.takeOver.asksMailbox && mailboxes.length === 1
        ? mailboxes[0]
        : await choose(`   which mailbox receives ${rule.to}?`, options);
    chosen.push({ rule, mailbox, forward, copy, to });
  }
  if (chosen.length === 0) { process.stdout.write("\n"); out("left as they are."); return; }

  process.stdout.write("\n");
  out("Plan");
  for (const { rule, mailbox, forward, copy, to } of chosen) {
    out(`  ${rule.to}   ${whereTo(rule)}  ->  this Node, into ${mailbox.id === null ? `a new mailbox named ${mailbox.name}` : `mailbox ${mailbox.name}`}`
      + `${forward === "keep" ? `, and keeps forwarding to ${rule.destinations[0]}` : ""}${to === null ? "" : `, and forwards to ${to.join(", ")}`}`
      + `${copy ? ", with copies" : ""}`);
    const offer = to !== null ? rule.takeOver.forwardTo : forward === "keep" ? rule.takeOver.keep : rule.takeOver;
    for (const line of wrapAt(`${copy ? offer.copy.says : offer.says}.`, 88)) out(`    ${line}`);
  }
  const apply = await ask("   Apply? [y/N] ");
  if (!/^y(es)?$/i.test(apply.trim())) { out("nothing was changed."); return; }

  // Take-overs whose rule read back with the name that records where it went: the only ones `--without-node` restores.
  let recorded = 0;
  for (const { rule, mailbox, forward, copy, to } of chosen) {
    process.stdout.write("\n");
    let mailboxId = mailbox.id;
    if (mailboxId === null) {
      const made = await call("POST", "/api/mailboxes", { name: mailbox.name });
      if (!made.ok) { out(`${rule.to}   not taken over: the mailbox could not be made`); refused(made.text); continue; }
      mailboxId = made.value.mailboxId;
    }
    const taken = await call("POST", "/api/provider/routing-rules/take-over", {
      domain, ruleId: rule.id, digest: rule.digest, mailboxId, ...(forward === null ? {} : { forward }), ...(copy ? { copy: true } : {}),
      ...(to === null ? {} : { forwardTo: to }),
    });
    if (!taken.ok && taken.unknown) {
      // The address row is written before the PUT, so the mailbox is not "empty"; and the rule may route here now.
      out(`${rule.to}   not confirmed: Cloudflare may have applied this`);
      refused(taken.text);
      out(`  put back, if it was: mailda provider --put-back ${rule.id} --domain ${domain} --url ${origin}`);
      continue;
    }
    if (!taken.ok) {
      out(`${rule.to}   not taken over:`);
      refused(taken.text);
      if (mailbox.id === null) out(`  the mailbox ${mailbox.name} was made for it and stays, empty`);
      continue;
    }
    // Every destination it forwards to now; an older Node answers only the kept one.
    const forwards = taken.value.outcome.forwards ?? ((taken.value.outcome.keptForward ?? null) === null ? [] : [taken.value.outcome.keptForward]);
    out(`${rule.to}   taken over, files into ${taken.value.outcome.mailbox?.name ?? mailbox.name}`
      + `${forwards.length === 0 ? "" : `, and forwards to ${forwards.join(", ")}`}`);
    out(`  put back: mailda provider --put-back ${rule.id} --domain ${domain} --url ${origin}`);
    if (taken.value.outcome.nameRecorded === true) recorded += 1;
    if (taken.value.outcome.nameRecorded === false) {
      for (const line of wrapAt("its name does not record where it went, so only this Node can put it back: do that before "
        + "the Node is ever deleted", 90)) out(`  ${line}`);
    }
  }
  if (recorded === 0) return;
  process.stdout.write("\n");
  for (const line of wrapAt("Before this Node is ever deleted, put these rules back. The name of each one taken over above "
    + "records where it went, unless it says otherwise, and if the Node is already gone this restores it from that name "
    + "with your own Cloudflare login:", 96)) out(line);
  out(`  mailda provider --put-back <rule id> --domain ${domain} --without-node`);
}

/**
 * The put-back for a Node that cannot answer (critic H1, 1 October 2026): the rule's own name records the action
 * a take-over replaced (`@mailda/contract/routing-rule-name`), so the operator's Cloudflare token restores it with
 * no Node at all. No audit entry is written, because the Node that keeps them is the one that is gone; the rule's
 * name is cleared, since the name it had before the take-over was only on that audit trail. `fetchImpl` is for
 * the test.
 */
export async function putBackWithoutNode({ domain, ruleId, token, accountId, fetchImpl = fetch }) {
  const cf = async (method, path, body) => {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch((error) => error);
    if (response instanceof Error) return { ok: false, error: response.message };
    const answer = await response.json().catch(() => null);
    if (!response.ok || answer?.success !== true) return { ok: false, error: `${method} ${path} answered ${response.status}: ${JSON.stringify(answer?.errors ?? answer)}` };
    return { ok: true, result: answer.result };
  };
  // The zone carrying the domain: its own name, or the nearest parent that is a zone in this account.
  let zone = null;
  for (let name = domain; zone === null && name.includes("."); name = name.slice(name.indexOf(".") + 1)) {
    const found = await cf("GET", `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(accountId)}`);
    if (!found.ok) fail(`the zone carrying ${domain} could not be looked up: ${found.error}`);
    zone = found.result[0] ?? null;
  }
  if (zone === null) fail(`no zone in account ${accountId} carries ${domain}.`);
  const path = `/zones/${zone.id}/email/routing/rules/${ruleId}`;
  const read = await cf("GET", path);
  if (!read.ok) fail(`rule ${ruleId} could not be read on ${zone.name}: ${read.error}`);
  const rule = read.result;
  const recorded = recordedInName(rule.name ?? "");
  const now = rule.actions?.[0];
  if (recorded === null) {
    fail(`rule ${ruleId} has no take-over recorded in its name (it is named ${JSON.stringify(rule.name ?? "")}).\n\n`
      + "  why      a take-over writes what the rule did into its name only from 1 October 2026 on, and never for\n"
      + "           the catch-all (the receiving step takes that over), so there is nothing to restore from but the\n"
      + "           Node's audit trail\n"
      + "  fix      put it back through the Node (mailda provider --put-back <id> --domain <d> --url <node>), or edit\n"
      + "           it in the Cloudflare dashboard (Email, Email Routing, Routing rules)");
  }
  if (now?.type !== "worker" || !(now.value ?? []).includes(recorded.worker)) {
    fail(`rule ${ruleId} no longer routes to ${recorded.worker} (it is ${now?.type ?? "?"} ${(now?.value ?? []).join(", ")}).\n\n`
      + "  why      somebody changed it since the take-over, and overwriting that is not a put-back\n"
      + "  fix      nothing, or edit it in the Cloudflare dashboard");
  }
  const actions = [{ type: recorded.action, ...(recorded.destinations.length === 0 ? {} : { value: recorded.destinations }) }];
  const put = await cf("PUT", path, { name: "", enabled: rule.enabled === true, matchers: rule.matchers ?? [], actions });
  const back = await cf("GET", path);
  const after = back.ok ? back.result.actions?.[0] : null;
  const confirmed = after !== null && after?.type === recorded.action
    && JSON.stringify(after.value ?? []) === JSON.stringify(recorded.destinations);
  if (!confirmed) {
    fail(`the put-back of ${ruleId} is not confirmed.\n\n`
      + `  why      the PUT: ${put.ok ? "answered" : put.error}; the read-back: ${back.ok ? `${after?.type ?? "?"} ${(after?.value ?? []).join(", ")}` : back.error}\n`
      + "  fix      check the rule in the Cloudflare dashboard (Email, Email Routing, Routing rules) before relying on it");
  }
  const said = `${recorded.action}${recorded.destinations.length === 0 ? "" : ` -> ${recorded.destinations.join(", ")}`}`;
  process.stdout.write(`\n   ${ruleId} on ${zone.name}\n     was       worker -> ${recorded.worker}\n     now       ${said}, read back\n`
    + "     from      its name; no Node was asked, so no audit entry records this\n\n");
}
