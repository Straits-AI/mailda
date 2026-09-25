#!/usr/bin/env node
/**
 * `mailda` — the operator's command line (#80).
 *
 * ## Why this exists, and what it deliberately does not claim
 *
 * Ten documents, the README's limitations section and two source files referred to `mailda deploy` and
 * `mailda doctor` as the mechanism for install, plan enforcement and capability verification. There was no
 * CLI. Not partial — no `bin` entry anywhere in the workspace, and five loose scripts invoked through
 * `pnpm --filter` doing the actual work.
 *
 * The worst of it was not the gap. `doctor` shipped a finding reading `workers_paid_plan: ok` whose detail
 * said *"`mailda deploy` verifies the plan at install and refuses on Workers Free (ADR 25)"* — the product
 * telling an operator that a tool which did not exist was protecting them. That is #60's governing failure
 * (a condition backed by nothing is a policy that silently never fires) reached through a doctor finding.
 *
 * So this binary does the work that is real, and **every claim about what it verifies has been removed from
 * the product where it was not true**. Specifically:
 *
 * - **The Workers plan is not checkable.** A Worker cannot read its account's plan, and this CLI does not
 *   have a documented API to read it either. `planCheck` now says it is unverified instead of crediting a
 *   check that does not run.
 * - **Whether a sending domain is onboarded is not checkable.** Cloudflare's onboarding is a dashboard flow
 *   and the docs expose no endpoint listing onboarded sending domains. Inventing a probe would mean sending
 *   a real message to a stranger to see whether it was refused, which is not something a verify command may
 *   do. It stays unverified, and says so.
 *
 * What is left is real: a deploy that runs the four steps an operator currently types by hand in the right
 * order, a doctor that reads a running Node, and a password reset that already worked.
 */

import { doctorExitCode } from "./deploy-parse.mjs";
import { doctor } from "./verbs/doctor.mjs";
import { install } from "./verbs/install.mjs";
import { upgrade } from "./verbs/upgrade.mjs";
import { setup } from "./verbs/setup.mjs";
import { provider } from "./verbs/provider.mjs";
import { deploy, preflight } from "./verbs/deploy.mjs";
import { claimSecret, setPassword, recoveryCodes } from "./verbs/secrets.mjs";
import { search } from "./verbs/search.mjs";
import { verifyEvidence } from "./verbs/verify-evidence.mjs";
import { backup, verifyBackup } from "./verbs/backup.mjs";


const USAGE = `mailda — operate a Mailda Node

  mailda provider [--url <origin>]   this Node's Cloudflare grant: its state, or the printed ceremony
  mailda provider --connect          create the OAuth client from one API token, register it, open the consent
                                     (the install's grant step, for a Node claimed without it)
  mailda provider --client-id <id>   register the OAuth client; the secret is read from stdin
  mailda provider --scopes a,b       begin a consent and print the URL to open
  mailda provider --resolve-account  ask Cloudflare which account this grant covers, and record it
  mailda provider --email-routing    what Cloudflare says about receiving mail for this Node's domains
  mailda provider --delivery-events  whether a send's outcome would be seen: subscription, queue, consumer
  mailda provider --onboard-sending <domain>   what onboarding it for sending would do; add --confirm <digest> to do it
  mailda provider --subscribe <domain>         subscribe its delivery events to this Node's queue; add --confirm <digest> to do it
  mailda provider --onboard-receiving <domain> point a subdomain at this Node to receive; --address and --confirm to do it,
                                              --mailbox <id> when the organization has more than one
  mailda provider --routing-rules <domain>     the routing rules already on its zone, and which point here
  mailda provider --take-over <rule id> --domain <domain>  point that rule at this Node; --confirm <digest> to do it
  mailda provider --put-back <rule id> --domain <domain>   restore the action a take-over replaced
  mailda provider --ownership       who owns this installation, and where each answer came from
  mailda provider --handover [--out <file>]    a signed handover manifest, verified before it is shown
  mailda provider --domains <keyword>          cached domain suggestions with indicative prices
  mailda provider --price a.com,b.dev          real-time registry price, which is what an approval binds to
  mailda provider --buy <domain>               what buying it would cost; add --confirm <digest> to buy
  mailda provider --buy-status <domain>        how a registration is going, and whether to keep waiting
  mailda install [--yes] [--no-open] the first run as one conversation: sign in, pick the account, deploy,
                                     claim the Node, set it up to receive, send and observe outcomes with
                                     wrangler's own login, then (optional) its Cloudflare grant from one API
                                     token. --yes reads MAILDA_EMAIL, MAILDA_PASSWORD, MAILDA_DOMAIN,
                                     MAILDA_ADDRESS, CLOUDFLARE_API_TOKEN and MAILDA_GRANT_TOKEN
  mailda upgrade [--name <worker>] [--url <origin>] [--yes] [--contract]
                                     pull the release, back the Node up, list what its schema will do to
                                     the catalog, deploy through the canary, and finish a Node's setup if
                                     it was never set up to receive
  mailda setup [--name <worker>] [--url <origin>] [--yes]
                                     receiving, sending and delivery outcomes for a Node already deployed
                                     and claimed, with the consent wrangler has; no deploy. --yes reads
                                     MAILDA_DOMAIN and MAILDA_ADDRESS
  mailda deploy --plan               say what a deploy would create, adopt or unwind, and act on nothing
  mailda deploy [--url <origin>] [--name <worker>]
                                     deploy, migrate, attach the events consumer, then check
  mailda doctor --url <origin>       what the Node says about itself; exit 0 ok, 1 degraded, 2 refuse
  mailda claim-secret [--local]      write the install secret and print it once
  mailda set-password <email>        set a password from the terminal, never echoed
  mailda recovery-codes rotate       mint ten replacement recovery codes, printed once
  mailda recovery-codes confirm      prove you hold one; compared, never spent
  mailda recovery-codes redeem       spend one to restore the key vault — the disaster path
  mailda search list                 what the body index failed on, and why
  mailda search repair --id <id>     put a message back in the body index's queue
  mailda backup --url <o> --out <d>   catalog, evidence inventory and an index you can check
  mailda verify-backup --in <dir>     is this backup the one its index describes
  mailda preflight [--url <origin>]  what a deploy needs, checked before it changes anything
  mailda verify-evidence --url <o>   open every stored message and check it against its ingress hash

Two things this cannot verify, said here rather than discovered later:

  the Workers plan            a Worker cannot read its account's plan and there is no documented API
                              for it, so ADR 25's requirement is unenforced. Check it in the dashboard.
  a sending domain onboarded  Cloudflare's onboarding is a dashboard flow with no endpoint listing the
                              result. Until one is onboarded a Node can only send to addresses already
                              verified in your account — it can receive a customer's message and be
                              unable to answer it.
`;


const [verb, ...rest] = process.argv.slice(2);
/*
 * Ctrl-C at a raw-mode prompt (`choose`, `readSecret`) rejects with "cancelled" rather than letting the
 * terminal's SIGINT end the process, because raw mode has taken SIGINT away from the terminal. Awaited at
 * the top level, that rejection is a thrown error, and it printed a stack: a crash report for a decision
 * the operator made. Caught once here, for every verb.
 */
try {
  switch (verb) {
    case "deploy": process.exit(await deploy(rest)); break;
    case "doctor": process.exit(doctorExitCode(await doctor(rest))); break;
    case "claim-secret": claimSecret(rest); break;
    case "set-password": setPassword(rest); break;
    case "recovery-codes": await recoveryCodes(rest); break;
    case "backup": await backup(rest); break;
    case "verify-backup": verifyBackup(rest); break;
    case "preflight": await preflight(rest); break;
    case "verify-evidence": await verifyEvidence(rest); break;
    case "search": await search(rest); break;
    case "provider": await provider(rest); break;
    case "install": await install(rest); break;
    case "upgrade": await upgrade(rest); break;
    case "setup": await setup(rest); break;
    default:
      process.stdout.write(USAGE);
      process.exit(verb === undefined || verb === "--help" || verb === "-h" ? 0 : 1);
  }
} catch (error) {
  if (error instanceof Error && error.message === "cancelled") {
    process.stdout.write("\n\n   cancelled. Nothing past the last step that said so was changed.\n\n");
    process.exit(130);
  }
  throw error;
}

