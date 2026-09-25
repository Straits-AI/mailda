import { readFileSync, writeFileSync } from "node:fs";
import { api, fail, flag, sessionCookie, wrapAt } from "../support.mjs";
import { catchAllLine } from "./provision.mjs";
/**
 * One domain's price, or the reason there is not one.
 *
 * The refusal prints where the price would have been rather than as a footnote: the two most confusable
 * outcomes are *taken* and *Cloudflare sells this extension but not through the API*, and an operator
 * skimming a column of blanks would read the second as the first.
 */
function printDomain(one) {
  const price = one.registrationCost === null
    ? "—"
    : `${one.currency ?? ""} ${one.registrationCost}`.trim()
      + (one.renewalCost === null ? "" : `, renews ${one.renewalCost}`);
  const mark = one.buyable ? "buyable" : one.registrable ? "no" : "no";
  process.stdout.write(`   ${mark.padEnd(8)} ${one.name.padEnd(28)} ${price}\n`);
  if (one.tier === "premium") process.stdout.write(`            ${" ".repeat(28)} premium tier\n`);
  if (one.refusal !== null) {
    for (const line of wrapAt(one.refusal, 66)) process.stdout.write(`            ${line}\n`);
  }
}


/** How a registration is going, and whether anything may keep asking on its own. */
function printOutcome(outcome) {
  process.stdout.write(`\n   ${outcome.domain}: ${outcome.state}\n`);
  if (outcome.error !== null) process.stdout.write(`   error: ${outcome.error}\n`);
  process.stdout.write(
    outcome.mayPoll
      ? `   still running — check again with: mailda provider --buy-status ${outcome.domain}\n`
      : `   this Node will not ask again on its own\n`,
  );
  if (outcome.next !== null) {
    process.stdout.write("\n");
    for (const line of wrapAt(outcome.next, 72)) process.stdout.write(`   ${line}\n`);
  }
  process.stdout.write("\n");
}



/* ------------------------------------------------------------------ provider ----------------------- */

/**
 * The Node's Cloudflare grant, from the terminal (#162 L1).
 *
 * L1 shipped five routes and two `doctor` findings and **no way to reach them**: no screen, no verb. So the
 * one step that needs a human — pasting a client id and secret Cloudflare shows once — had no surface but
 * raw curl with a session cookie. That is the gap this closes, and it is the CLI half of #162's requirement
 * that every state be distinguishable in the interface *and* in the CLI.
 *
 * The secret is read from **stdin**, never an argument: an argv is in the shell history and in `ps`.
 */
export async function provider(argv) {
  const origin = (flag(argv, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "");
  if (origin === "") fail("pass `--url https://<your-node>`, or set MAILDA_URL.");
  const cookie = await sessionCookie(origin);
  if (cookie === null) fail("set MAILDA_EMAIL and MAILDA_PASSWORD to sign in to this Node.");

  const call = async (method, template, body, query) => {
    const path = api(method, template, query);
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) fail(`${method} ${path} answered ${response.status}:\n${text}`);
    return JSON.parse(text);
  };

  /*
   * `--token`: the Node's browser-side credential, an API token the operator made in the dashboard with the
   * permissions `GET /api/provider` lists (26 September 2026; it replaced the OAuth client). Read from
   * stdin, never argv, which is in `ps` and the shell's history; `MAILDA_GRANT_TOKEN` under `--yes`. The
   * account the CLI settled rides along so the Node does not have to ask the token which it can see.
   */
  if (argv.includes("--token")) {
    const token = (argv.includes("--yes") ? process.env.MAILDA_GRANT_TOKEN ?? "" : readFileSync(0, "utf8")).trim();
    if (token === "") fail("pipe the token in: `echo -n <token> | mailda provider --token --url <origin>`");
    const { provider: after } = await call("PUT", "/api/provider/token", {
      token, ...(process.env.CLOUDFLARE_ACCOUNT_ID ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID } : {}),
    });
    process.stdout.write(`\n   held. state: ${after.state}${after.accountName ? `, account ${after.accountName}` : ""}\n`);
    return;
  }
  if (argv.includes("--forget-token")) {
    const { provider: after } = await call("DELETE", "/api/provider/token");
    process.stdout.write(`\n   forgotten. state: ${after.state}. Revoke it in the dashboard too; forgetting is local.\n`);
    return;
  }

  if (argv.includes("--email-routing")) {
    const { routing } = await call("GET", "/api/provider/email-routing");
    for (const one of routing) {
      process.stdout.write(`\n   ${one.domain}\n`);
      if (one.zone !== null) process.stdout.write(`     zone      ${one.zone}\n`);
      if (one.status !== null) {
        process.stdout.write(`     receiving ${one.status}${one.enabled === false ? " (disabled)" : ""}\n`);
      }
      if (one.error !== null) process.stdout.write(`     unknown   ${one.error}\n`);
      for (const record of one.required) {
        process.stdout.write(
          `     needs     ${record.type} ${record.name} -> ${record.content}`
          + `${record.priority === null ? "" : ` (priority ${record.priority})`}\n`,
        );
      }
    }
    return;
  }

  if (argv.includes("--delivery-events")) {
    const { delivery } = await call("GET", "/api/provider/delivery-events");
    for (const one of delivery) {
      process.stdout.write(`\n   ${one.domain}\n`);
      /*
       * Each of the four objects on its own line, present or absent. A single verdict would be shorter and
       * would leave an operator with nothing to do about it — the whole point of this surface is naming
       * which one is missing.
       */
      if (one.zone !== null) process.stdout.write(`     zone      ${one.zone}\n`);
      process.stdout.write(
        one.sending === null
          ? (one.zone === null
            ? `     sending   no zone in this account carries this domain\n`
            : `     sending   not onboarded — this domain cannot send, so no event will ever exist\n`)
          : `     sending   ${one.sending.name}${one.sending.enabled === false ? " (disabled)" : ""}`
            + `${one.sending.dkimSelector === null ? "" : ` — dkim ${one.sending.dkimSelector}`}\n`,
      );
      for (const record of one.sending?.required ?? []) {
        process.stdout.write(
          `     needs     ${record.type} ${record.name} -> ${record.content}`
          + `${record.priority === null ? "" : ` (priority ${record.priority})`}\n`,
        );
      }
      if (one.sending?.error != null) process.stdout.write(`     unknown   ${one.sending.error}\n`);
      process.stdout.write(
        one.subscription === null
          ? `     events    no email.sending subscription covers this domain\n`
          : `     events    ${one.subscription}${one.enabled === false ? " (disabled)" : ""}`
            + `${one.events.length === 0 ? "" : ` — ${one.events.join(", ")}`}\n`,
      );
      if (one.queueName !== null) process.stdout.write(`     queue     ${one.queueName}\n`);
      if (one.subscription !== null) {
        process.stdout.write(
          one.consumers.length === 0
            ? `     consumer  none — events are published into a queue nobody reads\n`
            : `     consumer  ${one.consumers.join(", ")}\n`,
        );
      }
      if (one.error !== null) process.stdout.write(`     unknown   ${one.error}\n`);
    }
    if (delivery.length === 0) process.stdout.write(`\n   this Node routes no domains\n`);
    return;
  }

  const rulesOn = flag(argv, "routing-rules");
  if (rulesOn !== null) {
    const { routing } = await call("GET", "/api/provider/routing-rules", undefined, { domain: rulesOn });
    process.stdout.write(`\n   ${routing.domain}${routing.zone === null ? "" : `  (zone ${routing.zone})`}\n`);
    if (routing.error !== null) { process.stdout.write(`     unknown   ${routing.error}\n\n`); return; }
    if (routing.rules.length === 0) process.stdout.write("     no rules\n");
    for (const rule of routing.rules) {
      const where = `${rule.action}${rule.destinations.length === 0 ? "" : ` -> ${rule.destinations.join(", ")}`}`;
      process.stdout.write(
        `     ${rule.catchAll ? "catch-all" : rule.to}\n`
        + `               ${where}${rule.ours ? "  (this Node)" : ""}${rule.enabled ? "" : "  (disabled)"}\n`
        + `               id ${rule.id}  digest ${rule.digest}\n`,
      );
    }
    process.stdout.write(
      "\n   take one over: mailda provider --take-over <id> --domain "
      + `${routing.domain} --confirm <digest>\n\n`,
    );
    return;
  }

  const takeOver = flag(argv, "take-over");
  const putBack = flag(argv, "put-back");
  if (takeOver !== null || putBack !== null) {
    const domain = flag(argv, "domain");
    if (domain === null) fail("pass --domain <the domain whose zone holds the rule>");
    if (takeOver !== null && flag(argv, "confirm") === null) {
      fail(`pass --confirm <digest>, from: mailda provider --routing-rules ${domain}`);
    }
    const { outcome } = takeOver !== null
      ? await call("POST", "/api/provider/routing-rules/take-over", {
        domain, ruleId: takeOver, digest: flag(argv, "confirm"),
        ...(flag(argv, "mailbox") === null ? {} : { mailboxId: flag(argv, "mailbox") }),
      })
      : await call("POST", "/api/provider/routing-rules/put-back", { domain, ruleId: putBack });
    const said = (one) => `${one.action}${one.destinations.length === 0 ? "" : ` -> ${one.destinations.join(", ")}`}`;
    process.stdout.write(
      `\n   ${outcome.to}\n     was       ${said(outcome.before)}\n     now       ${said(outcome.after)}\n`
      + (takeOver !== null
        ? `\n   put it back: mailda provider --put-back ${outcome.ruleId} --domain ${domain}\n\n`
        : "\n"),
    );
    return;
  }

  const receiving = flag(argv, "onboard-receiving");
  if (receiving !== null) {
    const confirming = flag(argv, "confirm");
    const address = flag(argv, "address");
    if (confirming === null) {
      const { proposal } = await call("GET", "/api/provider/receiving", undefined, { domain: receiving });
      process.stdout.write(`\n   ${proposal.domain}\n`);
      if (proposal.zone !== null) {
        process.stdout.write(`     zone      ${proposal.zone} (routing ${proposal.zoneRouting ?? "?"})\n`);
      }
      /*
       * The zone-level change is printed first and in full, because it is the biggest thing on this page: it
       * decides where the **whole domain's** mail goes, not one subdomain's.
       */
      if (proposal.enablesZone !== null) {
        process.stdout.write(`     enables   Email Routing on ${proposal.enablesZone}\n`);
        for (const line of wrapAt(
          "that writes MX and SPF at the apex, so mail for the whole domain begins arriving at Cloudflare "
          + "— not just this subdomain's. The records this subdomain needs are read afterwards, because a "
          + "zone that is not routing yet lists none.", 66,
        )) process.stdout.write(`               ${line}\n`);
      }
      for (const one of proposal.present) process.stdout.write(`     has       MX ${one}\n`);
      // A zone's own name may take a catch-all (apex only); what it routes today is the thing to know first.
      if (proposal.apex === true) {
        process.stdout.write(`     apex      yes; catch-all today: ${catchAllLine(proposal.catchAll ?? null)}\n`);
      }
      /*
       * An existing rule is printed **with what it is worth**, not as a tick. A rule whose subdomain has no
       * MX is accepted by Cloudflare, enabled, and never matches — the defect this command exists for.
       */
      if (proposal.rule !== null) {
        const inert = proposal.present.length === 0;
        process.stdout.write(`     rule      ${proposal.rule}${inert ? "  — INERT" : ""}\n`);
        if (inert) {
          for (const line of wrapAt(
            "that rule names an address here and the subdomain has no MX, so mail to it never reaches "
            + "Cloudflare at all. It reads as configured everywhere and receives nothing.", 68,
          )) process.stdout.write(`               ${line}\n`);
        }
      }
      if (proposal.refusal !== null) {
        process.stdout.write(`\n   will not onboard it:\n`);
        for (const line of wrapAt(proposal.refusal, 72)) process.stdout.write(`     ${line}\n`);
        process.stdout.write("\n");
        return;
      }
      for (const one of proposal.creates) {
        process.stdout.write(
          `     writes    MX ${one.name} -> ${one.content} (priority ${one.priority})\n`,
        );
      }
      process.stdout.write(
        proposal.enablesZone === null
          ? `\n   these are the records Cloudflare says ${proposal.zone} needs — copied onto the subdomain,\n`
            + `   not invented here\n`
          : `\n   the records will be whatever Cloudflare requires once ${proposal.zone} is routing —\n`
            + `   read from it, not invented here\n`
        + `\n   confirm: mailda provider --onboard-receiving ${proposal.domain} \\\n`
        + `              --address <you>@${proposal.domain} --confirm ${proposal.digest}\n`
        + (proposal.apex === true
          ? "   add --catch-all to route every address at it here instead of one rule per address\n\n"
          : "\n"),
      );
      return;
    }
    if (address === null) fail("pass --address <the address mail should arrive at>");

    const { outcome } = await call("POST", "/api/provider/receiving", {
      domain: receiving, digest: confirming, address,
      // The mailbox it files into. Omitted when the organization has one; refused when it has several.
      ...(flag(argv, "mailbox") === null ? {} : { mailboxId: flag(argv, "mailbox") }),
      ...(argv.includes("--catch-all") ? { catchAll: true } : {}),
    });
    process.stdout.write(`\n   ${outcome.domain}\n`);
    for (const one of outcome.written) process.stdout.write(`     wrote     MX ${one}\n`);
    // Read back, because a write that answered 200 is not a record in DNS.
    for (const one of outcome.confirmed) process.stdout.write(`     confirmed MX ${one}\n`);
    if (outcome.catchAll !== null && outcome.catchAll !== undefined) {
      process.stdout.write(`     catch-all ${catchAllLine(outcome.catchAll.before)} -> ${catchAllLine(outcome.catchAll.after)}\n`
        + `               put back: mailda provider --put-back <id> --domain ${outcome.domain}, the id from --routing-rules\n`);
    } else if (outcome.rule !== null) process.stdout.write(`     rule      ${outcome.rule}\n`);
    if (outcome.note !== null) {
      process.stdout.write("\n");
      for (const line of wrapAt(outcome.note, 72)) process.stdout.write(`   ${line}\n`);
    }
    process.stdout.write("\n   DNS takes a little while to propagate. Send a message from OUTSIDE this\n"
      + "   Cloudflare account — a same-account send is accepted and never delivered.\n\n");
    return;
  }

  const buying = flag(argv, "buy");
  if (buying !== null) {
    const confirming = flag(argv, "confirm");
    if (confirming === null) {
      const { proposal } = await call("GET", "/api/provider/domains/purchase", undefined, { domain: buying });
      process.stdout.write(`\n   ${proposal.domain}\n`);
      printDomain(proposal.price);
      if (proposal.existing !== null) {
        process.stdout.write(`     already   this account holds it (${proposal.existing})\n`);
      }
      if (proposal.refusal !== null) {
        process.stdout.write(`\n   will not buy it:\n`);
        for (const line of wrapAt(proposal.refusal, 72)) process.stdout.write(`     ${line}\n`);
        process.stdout.write("\n");
        return;
      }
      /*
       * The renewal is printed as its own line rather than trailing the price. It is the figure that
       * surprises people a year later — `.site` is $4.99 to register and $27.70 to renew — and a number
       * read past is a number nobody agreed to.
       */
      process.stdout.write(
        `\n   registering costs ${proposal.price.currency} ${proposal.price.registrationCost}\n`
        + `   renewing will cost ${proposal.price.currency} ${proposal.price.renewalCost} a year\n`
        + `\n   auto-renew is OFF unless you add --auto-renew, which authorises Cloudflare to charge\n`
        + `   this account up to 30 days before expiry\n`
        + `\n   confirm: mailda provider --buy ${proposal.domain} --confirm ${proposal.digest}\n\n`,
      );
      return;
    }

    const { outcome } = await call("POST", "/api/provider/domains/purchase", {
      domain: buying, digest: confirming, autoRenew: argv.includes("--auto-renew"),
    });
    printOutcome(outcome);
    return;
  }

  const watching = flag(argv, "buy-status");
  if (watching !== null) {
    const { outcome } = await call("GET", "/api/provider/domains/purchase/status", undefined, { domain: watching });
    printOutcome(outcome);
    return;
  }

  const suggesting = flag(argv, "domains");
  if (suggesting !== null) {
    const { suggestions } = await call("GET", "/api/provider/domains", undefined, { q: suggesting });
    process.stdout.write(`\n   suggestions for "${suggesting}" — cached, and not a basis to buy\n\n`);
    for (const one of suggestions) printDomain(one);
    process.stdout.write(
      `\n   these prices are Cloudflare's cached ones. Before buying, price the exact name:\n`
      + `   mailda provider --price <domain>[,<domain>…]\n\n`,
    );
    return;
  }

  const pricing = flag(argv, "price");
  if (pricing !== null) {
    const names = pricing.split(",").map((one) => one.trim()).filter((one) => one !== "");
    const { domains, checkedAt } = await call("POST", "/api/provider/domains/check", { domains: names });
    process.stdout.write(`\n   priced against the registries at ${checkedAt}\n\n`);
    for (const one of domains) printDomain(one);
    process.stdout.write("\n");
    return;
  }

  if (argv.includes("--handover")) {
    const { jws } = await call("GET", "/api/provider/handover");
    const [header, payload, signature] = jws.split(".");
    const head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    const manifest = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

    /*
     * **Verified before it is printed, against the JWKS the manifest names** — fetched over the network like
     * any other client would, not read from the response that carried the manifest. A CLI that decoded and
     * displayed would be the convenient copy this whole shape exists to avoid, and it would be the one tool
     * most likely to be trusted.
     */
    const jwks = await fetch(manifest.verification.jwks)
      .then((r) => r.json())
      .catch((error) => fail(`could not fetch ${manifest.verification.jwks}: ${error.message}`));
    const jwk = (jwks.keys ?? []).find((one) => one.kid === head.kid);
    if (jwk === undefined) {
      fail(
        `the manifest is signed with kid ${head.kid}, which ${manifest.verification.jwks} does not offer.\n\n`
        + "  why      a signature nobody can check is not a signature. The key may have been rotated out,\n"
        + "           or this manifest may not come from that Node\n"
        + "  fix      re-export the manifest, or verify against a copy of the JWKS taken before rotation",
      );
    }

    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key,
      Buffer.from(signature, "base64url"),
      Buffer.from(`${header}.${payload}`, "utf8"),
    );
    if (!ok) fail("the manifest's signature does not verify. Nothing below it can be trusted, so nothing is printed.");

    const out = flag(argv, "out");
    if (out !== null) {
      writeFileSync(out, `${jws}\n`, "utf8");
      process.stdout.write(`\n   wrote ${out} — the signed manifest, which is the artifact to keep\n`);
    }

    process.stdout.write(`\n== handover manifest, signature verified against ${manifest.verification.jwks}\n`);
    process.stdout.write(`   issued ${manifest.issuedAt} by ${manifest.node}\n`);

    process.stdout.write(`\n-- what the client owns\n`);
    const MARK = { provider: "cloudflare", node: "this node", structural: "by design", unreadable: "unknown" };
    for (const fact of manifest.ownership) {
      process.stdout.write(`   ${MARK[fact.source].padEnd(10)} ${fact.question}: ${fact.answer ?? "—"}\n`);
    }

    process.stdout.write(`\n-- what a person must still do at the provider\n`);
    for (const one of manifest.ceremonies) {
      process.stdout.write(`\n   ${one.what}\n`);
      for (const line of wrapAt(one.why, 74)) process.stdout.write(`     ${line}\n`);
      // The measurement, so a client can check the claim rather than take it.
      process.stdout.write(
        `     evidence: ${one.evidence.value} = ${one.evidence.is}`
        + ` (${one.evidence.receipt}, measured ${one.evidence.measuredOn})\n`,
      );
    }

    process.stdout.write(`\n-- what this signature proves\n`);
    for (const line of wrapAt(manifest.verification.proves, 74)) process.stdout.write(`   ${line}\n`);
    process.stdout.write(`\n-- and what it does not\n`);
    for (const line of wrapAt(manifest.verification.doesNotProve, 74)) process.stdout.write(`   ${line}\n`);
    process.stdout.write("\n");
    return;
  }

  if (argv.includes("--ownership")) {
    const { ownership } = await call("GET", "/api/provider/ownership");
    const MARK = { provider: "cloudflare", node: "this node", structural: "by design", unreadable: "unknown" };
    for (const fact of ownership) {
      process.stdout.write(`\n   ${fact.question}\n`);
      process.stdout.write(`     ${MARK[fact.source].padEnd(10)} ${fact.answer ?? "—"}\n`);
      /*
       * The reason is printed, not footnoted. A field marked `this node` with its reason elsewhere is the
       * cache pretending to be a fact that #108 is about — the reader has to meet the caveat where they
       * meet the answer.
       */
      if (fact.because !== null) {
        for (const line of wrapAt(fact.because, 74)) process.stdout.write(`                ${line}\n`);
      }
    }
    process.stdout.write("\n");
    return;
  }

  const onboarding = flag(argv, "onboard-sending");
  if (onboarding !== null) {
    /*
     * Two steps, and the second one quotes the first. `deploy --plan` then `deploy`, and
     * `recovery-codes rotate` then `confirm`, are the same shape — but the digest here is doing more than
     * ceremony: it is what makes *the thing applied* and *the thing shown* provably the same proposal, which
     * is the failure this route actually has. The read side already matched the wrong domain once and
     * printed six perfectly correct records about it.
     */
    const confirming = flag(argv, "confirm");
    if (confirming === null) {
      const { proposal } = await call("GET", "/api/provider/sending", undefined, { domain: onboarding });
      process.stdout.write(`\n   ${proposal.domain}\n`);
      if (proposal.zone !== null) process.stdout.write(`     zone      ${proposal.zone}\n`);
      if (proposal.error !== null) {
        process.stdout.write(`     unknown   ${proposal.error}\n\n`);
        return;
      }
      if (proposal.onboarded) {
        process.stdout.write(`     onboarded already — nothing to do\n\n`);
        return;
      }
      // Said before the act, because it is the reason somebody might not want it.
      if (proposal.coveredBy !== null) {
        process.stdout.write(
          `     covered   ${proposal.coveredBy} already sends for this domain — onboarding it as itself\n`
          + `               gives it its own DKIM key and bounce domain, and is a separate thing\n`,
        );
      }
      for (const name of proposal.creates) process.stdout.write(`     creates   ${name}\n`);
      for (const name of proposal.leavesBehind) {
        process.stdout.write(
          `     keeps     ${name} — un-onboarding removes the rest and leaves this one, on a name\n`
          + `               Cloudflare stops managing. Measured, not documented\n`,
        );
      }
      process.stdout.write(
        `\n   confirm: mailda provider --onboard-sending ${proposal.domain}`
        + ` --confirm ${proposal.digest}\n\n`,
      );
      return;
    }

    const { proposal } = await call("POST", "/api/provider/sending", {
      domain: onboarding, digest: confirming,
    });
    process.stdout.write(`\n   ${proposal.domain} is onboarded for sending on ${proposal.zone}\n`);
    process.stdout.write(`   next: mailda provider --subscribe ${proposal.domain}\n\n`);
    return;
  }

  const subscribing = flag(argv, "subscribe");
  if (subscribing !== null) {
    // The third object `--delivery-events` reports on (#222), proposed and confirmed like onboarding.
    const confirming = flag(argv, "confirm");
    if (confirming === null) {
      const { proposal } = await call("GET", "/api/provider/subscription", undefined, { domain: subscribing });
      process.stdout.write(`\n   ${proposal.domain}\n`);
      if (proposal.zone !== null) process.stdout.write(`     zone      ${proposal.zone}\n`);
      if (proposal.sendingDomain !== null) process.stdout.write(`     sending   ${proposal.sendingDomain}\n`);
      if (proposal.error !== null) {
        process.stdout.write(`     unknown   ${proposal.error}\n\n`);
        return;
      }
      if (proposal.subscribed !== null && proposal.consumerAttached !== false) {
        process.stdout.write(`     subscribed already, as ${proposal.subscribed} — nothing to do\n\n`);
        return;
      }
      if (proposal.subscribed === null) {
        process.stdout.write(`     creates   a subscription publishing ${proposal.events.join(", ")}\n`);
        process.stdout.write(`     into      queue ${proposal.queueName} (${proposal.queueId})\n`);
      }
      if (proposal.consumerAttached === false) {
        process.stdout.write(`     attaches  this Worker as the consumer of ${proposal.queueName} — nothing reads it today\n`);
      }
      process.stdout.write(
        `\n   confirm: mailda provider --subscribe ${proposal.domain} --confirm ${proposal.digest}\n\n`,
      );
      return;
    }

    const { proposal } = await call("POST", "/api/provider/subscription", {
      domain: subscribing, digest: confirming,
    });
    process.stdout.write(
      `\n   ${proposal.domain}'s delivery events now reach ${proposal.queueName} as ${proposal.subscribed}\n`,
    );
    process.stdout.write(`   next: mailda provider --delivery-events\n\n`);
    return;
  }

  const { provider: state, permissions, note } = await call("GET", "/api/provider");
  process.stdout.write(`\n== provider: ${state.state}\n`);
  for (const [key, value] of Object.entries(state)) {
    if (key !== "state" && value !== null && value !== undefined) process.stdout.write(`   ${key}: ${JSON.stringify(value)}\n`);
  }
  process.stdout.write("\n   an API token for this Node carries exactly these, restricted to this account:\n");
  for (const one of permissions ?? []) {
    process.stdout.write(`     ${one.scope.padEnd(8)} ${one.name}${one.optional ? "  (optional)" : ""}\n`);
    for (const line of wrapAt(one.why, 66)) process.stdout.write(`              ${line}\n`);
  }
  if (typeof note === "string" && note !== "") for (const line of wrapAt(note, 72)) process.stdout.write(`   ${line}\n`);
  process.stdout.write("\n   create it at https://dash.cloudflare.com/profile/api-tokens, then: echo -n <token> | mailda provider --token --url <origin>\n");
}
