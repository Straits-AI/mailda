import type { Ctx } from "@mailda/runtime";
import { type Finding } from "../doctor.ts";
/**
 * The evidence scan's bound now lives with the reconciler that performs it
 * (`reconcile.list_limit`, receipt: `evidence-lifecycle.md`). It was duplicated here while `doctor`
 * had its own scan; one number with two owners drifts.
 */
/**
 * Every table the migrations create.
 *
 * Kept explicit rather than read from the migration files, because a Worker has no filesystem — and
 * drift-checked by `test/node/schema-tables.test.ts`, which parses `migrations/*.sql` and fails when
 * this list and those files disagree. That guard exists because this list *was* wrong: it stopped at
 * migration 0006 and omitted the five tables that 0007 and 0008 added, so a Node holding a partial
 * schema passed the one check whose whole job is to notice a partial schema. Found on a real button
 * install, which reported "Missing 14 table(s)" when 19 were absent.
 */
export const EXPECTED_TABLES = [
  "relationship_tuples", "team_members", "messages", "mailbox_items", "ingress_receipts",
  "outbox", "addresses", "mailboxes", "users", "sessions", "node_claim",
  "signing_keys", "refresh_tokens", "login_attempts",
  // Migration 0007 (outbound) and 0008 (audit). Absent here until 6 August 2026.
  "send_manifests", "send_counters", "node_capabilities", "invitations",
  // Migration 0036 (#86): the REST send API's credentials, wrapped under the credential KEK.
  "sending_transport",
  // Migration 0037 (#84): passkeys, and the single-use challenges that make the ceremony replay-proof.
  "credentials", "webauthn_challenges",
  "audit_entries", "log_entries",
  // Migration 0010 (per-recipient outcome).
  "send_recipients", "send_recipient_events",
  // Migration 0012 (durable drafts).
  "drafts",
  // Migration 0014 (Layer 3: conversations and cases).
  "conversations", "cases",
  // Migration 0018 (Layer 5: legal hold).
  "holds",
  // Migration 0019 (Layer 5: the policy object).
  "policies", "policy_versions",
  // Migration 0020 (Layer 5: approvals).
  "policy_stages", "approvals", "approval_stages", "approval_decisions",
  // Migration 0021 (Layer 5: lifting a hold).
  "hold_lifts",
  // Migration 0023 (Layer 5: matters and supervised reading).
  "matters", "supervised_grants",
  // Migration 0024 (Layer 5: per-act recording and the employee notice).
  "notifications",
  // Migration 0025 (Layer 5: eDiscovery export).
  "exports",
  // Migration 0026 (Layer 5: send circuit breakers). The three *rate* breakers add no table at all — they
  // are a windowed COUNT(*) over rows that already exist — so this one row is the whole of what the latched
  // breaker needed.
  "domain_pauses",
  // Migration 0027 (Layer 4: the Butler object).
  "butlers", "butler_versions",
  // Migration 0028 (Layer 4: the Butler engine, #50). The run record and one row per effect. Not the run
  // ledger — #53 owns the four replay modes and adds to these two rather than replacing them.
  "butler_runs", "butler_run_effects",
  // Migration 0029 (#75): the latched Butler pause #66 designed and named absent for want of these tables.
  "butler_pauses",
  // Migration 0032 (#73): the team as a first-class object, so `team_members` gains a writer and an approval
  // stage can require a member of a named team. `team_members` itself is above — it has existed since 0001,
  // and what it lacked was never a table.
  "teams",
  // Migration 0039 (#92): ADR 29's recovery codes, carrying ADR 28's key escrow. The table ADR 28 said this
  // Node "does not ship without" — three refusals in this file and in `keyvault.ts` named it as the remedy
  // before anything created it.
  "recovery_codes",
  "recovery_restores",
  "recovery_key_conflict_acknowledgements",
  // #109 L2: the agent identity and its pinned action ceiling.
  "agents",
  "agent_actions",
  // Migration 0053 (#162 L1, ADR 42): the Node's own Cloudflare grant, and a consent in flight.
  "provider_binding",
  "provider_authorizations",
];


/** Migrations applied. Checked by looking for the tables, not by trusting a version row. */
export async function checkSchema(env: Env): Promise<Finding[]> {
  const rows = await env.CATALOG.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all<{ name: string }>().catch(() => null);

  if (rows === null) {
    return [{
      check: "catalog_reachable",
      severity: "refuse",
      ok: false,
      discloses: "infrastructure",
      detail: "The CATALOG D1 binding did not answer a query.",
      fix: "confirm the d1_databases binding is linked to this Worker (`wrangler deploy` reports it as `env.CATALOG`)",
    }];
  }

  const present = new Set(rows.results.map((r) => r.name));
  const missing = EXPECTED_TABLES.filter((table) => !present.has(table));

  return [{
    check: "migrations_applied",
    severity: "refuse",
    discloses: "infrastructure",
    ok: missing.length === 0,
    detail: missing.length === 0
      ? `All ${EXPECTED_TABLES.length} expected tables present.`
      : `Missing ${missing.length} table(s): ${missing.join(", ")}.`,
    ...(missing.length === 0 ? {} : {
      fix: "POST /api/prepare — the Node applies its own migrations, idempotently. Or run `wrangler d1 migrations apply CATALOG --remote`. A Node with a partial schema accepts mail it cannot file",
    }),
  }];
}


/**
 * Is the evidence bucket actually there?
 *
 * The D1 counterpart of this has existed since the beginning; R2 had none, and R2 is the binding a
 * customer is most likely to be missing. The Deploy to Cloudflare button provisions D1 but **not** R2,
 * while writing a `bucket_name` for the bucket it did not create (receipt:
 * `deploy-button-behaviour.md`). So "the binding names a bucket that does not exist" is the single most
 * likely state of a freshly-deployed Node.
 *
 * Without this, that state surfaced as `evidence_present` reporting "Reconciliation failed", whose
 * `fix` sends the reader to migrations and the key vault — both fine, neither the problem. Being sent
 * to the wrong place is worse than a bare failure, because it costs the reader the time to eliminate
 * two healthy subsystems.
 *
 * Whether a Worker whose R2 binding points at a missing bucket even deploys is **not known** — the
 * measurement observed a failed deploy in that state but did not isolate the cause. If the deploy fails
 * first, this check simply never fires, and it is still worth having: it costs one HEAD and removes a
 * misleading `fix` from the path a real operator walks.
 */
export async function checkEvidenceBucket(env: Env): Promise<Finding[]> {
  // HEAD on a key that will not exist. Cheaper than a list, and it distinguishes "the bucket answered
  // and has no such object" — which is the healthy answer — from "the bucket did not answer at all".
  const reachable = await env.EVIDENCE.head("__mailda_doctor_probe__")
    .then(() => true)
    .catch(() => false);

  return [{
    check: "evidence_bucket_reachable",
    severity: "refuse",
    discloses: "infrastructure",
    ok: reachable,
    detail: reachable
      ? "The EVIDENCE R2 binding answered."
      : "The EVIDENCE R2 binding did not answer. Mail cannot be stored, so this Node must not accept any.",
    ...(reachable ? {} : {
      fix:
        "create the R2 bucket and bind it as EVIDENCE. The Deploy to Cloudflare button provisions D1 but " +
        "not R2 (docs/receipts/deploy-button-behaviour.md), so on a button-installed Node this is the " +
        "expected first failure and is not a sign anything else is wrong",
    }),
  }];
}


/**
 * ADR 25 requires Workers Paid, and **nothing verifies it**. Reported as an explicit gap rather than
 * omitted: a check that is absent is indistinguishable from one that passes, which is the same reasoning
 * that put `stale_when` on every receipt.
 *
 * This used to read *"`mailda deploy` verifies the plan at install and refuses on Workers Free"*, and there
 * was no `mailda deploy` — no CLI at all (#80). So a Node on Workers Free read `ok` and was told the check
 * had happened somewhere else, which is #60's governing failure — a condition backed by nothing is a policy
 * that silently never fires — reached through a doctor finding rather than a policy row. Worse than the
 * missing check was the sentence saying it was covered.
 *
 * The CLI exists now and still cannot answer this: a Worker cannot read its account's plan, and Cloudflare
 * exposes no documented endpoint for it either. So the honest report is *unverified*, and it names where a
 * person can actually look. `ok: true` with severity `report` is kept deliberately — an unverified fact is
 * not a failing check, and marking it `degraded` would make every correctly-installed Node permanently
 * yellow, which is how a warning stops being read.
 */
/**
 * Which send adapters this Node actually has (#86, ADR 33).
 *
 * ADR 33 locks *"the transport offers **both** send APIs"* and until #86 one was wired, so `adapter` on
 * every sealed envelope had a single possible value. This reports what is really available rather than what
 * the ADR says should be — which is the whole difference between a decision and its implementation, and the
 * kind of gap `butler_execution` above exists to keep visible.
 *
 * **Never `ok: false`.** Having only the binding is the ordinary, preferred configuration: it needs no
 * credential and it is the only adapter that can carry authored bytes. A degraded severity here would tell
 * an operator to fix something that is not broken. `report` is the honest level — this is a fact about the
 * deployment, and the finding that *does* fail when a Node cannot send is `outbound_send` beside it.
 *
 * One D1 read, and it reads no secret: `restConfigured` selects the account id and the date and never the
 * wrapped token.
 */
export async function checkTransportAdapters(env: Env): Promise<Finding[]> {
  const { restConfigured } = await import("../outbound/rest-transport.ts");
  const rest = await restConfigured(env).catch(() => null);
  const binding = env.EMAIL !== undefined;
  const chosen = binding ? "cloudflare-email-sending" : (rest === null ? "none" : "cloudflare-email-rest");

  return [{
    check: "transport_adapters",
    severity: "report",
    discloses: "data",
    ok: true,
    detail:
      `${binding ? "The EMAIL binding is present" : "There is no EMAIL binding"}; `
      + `${rest === null
        ? "no sending API token is configured"
        : `a sending API token is configured for account ${rest.accountId} (since ${rest.at})`}. `
      + `Sends would go through ${chosen === "none" ? "nothing — this Node cannot send" : chosen}. `
      + "The binding is preferred wherever it exists: it holds no credential, and it is the only adapter "
      + "that can submit the exact recorded bytes an authored send requires. The REST adapter carries "
      + "reconstructed sends only.",
    ...(binding || rest !== null ? {} : {
      fix: "add a `send_email` binding to wrangler.jsonc and deploy, or supply REST credentials with "
        + "PUT /api/transport if this Node cannot be redeployed",
    }),
  }];
}


export async function checkInboundRouting(env: Env, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) return [];

  /*
   * Both counts in one round trip. Two queries would be the obvious shape and this report is bounded by a
   * subrequest budget it has to report on — `doctor_cost` is the finding that would have to absorb it.
   */
  const counted = await env.CATALOG.prepare(
    `SELECT (SELECT COUNT(*) FROM addresses WHERE org_id = ?) AS addresses,
            (SELECT COUNT(*) FROM ingress_receipts WHERE org_id = ?) AS received`,
  ).bind(orgId, orgId).first<{ addresses: number; received: number }>().catch(() => null);

  if (counted === null) {
    return [{
      check: "inbound_routing",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "The catalog could not be read, so this report cannot say whether anything can arrive.",
      fix: "check the `catalog_reachable` finding in this same report first — this one is downstream of it",
    }];
  }

  const addresses = Number(counted.addresses);
  const received = Number(counted.received);

  /*
   * `ok` is true once an address exists, and deliberately does **not** require that mail has arrived. A
   * freshly installed Node that has been set up correctly and has simply not been written to yet is not
   * unhealthy, and the file's own precedent for this is `loopDetectionFinding`: a check that fails on every
   * quiet Node gets read as noise and then gets ignored on the Node where it means something.
   */
  return [{
    check: "inbound_routing",
    severity: "report",
    discloses: "data",
    ok: addresses > 0,
    detail: addresses === 0
      ? "No address is configured on this Node, so nothing can be delivered to it — `email()` refuses an "
        + "unknown recipient. Whatever the zone's DNS says, this Node cannot receive yet."
      : `${addresses} address(es) configured. `
        + (received === 0
          ? "**Nothing has ever arrived.** That is consistent with correct setup and no mail yet, and equally "
            + "consistent with routing that was never enabled, MX records pointing elsewhere, or a catch-all "
            + "aimed at a different Worker. This Node cannot tell those apart from the inside."
          : `${received} message(s) have been accepted, so routing did reach this Worker at least once. `
            + "That is history rather than a live status: it does not establish that routing is still "
            + "pointing here, because the zone's configuration can have changed since the last one arrived."),
    // Spread rather than an explicit `undefined`, matching this file: a Node that has received mail has
    // nothing to fix, and `fix` is documented as present on every *failure*.
    ...(addresses === 0
      ? {
        fix: "add an address on /people or via POST /api/addresses, then verify Email Routing in the "
          + "Cloudflare dashboard points the recipient at this Worker",
      }
      : received === 0
        ? {
          fix: "send a message to an address on this Node. If it does not arrive, check Email Routing on "
            + "the zone in the Cloudflare dashboard: the rule must target this Worker, and the MX records "
            + "must be Cloudflare's. Neither is readable from here.",
        }
        : {}),
  }];
}


export function planCheck(): Finding {
  return {
    check: "workers_paid_plan",
    severity: "report",
    discloses: "infrastructure",
    ok: true,
    detail: "Unverified. A Worker cannot read its account's plan and there is no documented API for it, so "
      + "ADR 25's requirement that this Node runs on Workers Paid is not enforced anywhere — check it in "
      + "the Cloudflare dashboard.",
    receipt: "docs/receipts/cloudflare-plan-costs.md",
  };
}


/**
 * The Node's own Cloudflare grant, and whether the endpoints it holds are still where it read them (#162 L1).
 *
 * ## Two findings, because they fail for unrelated reasons
 *
 * **The connection state.** #162 requires every state be distinguishable in the interface *and* in the CLI,
 * and `doctor` is the CLI's. It reports the state and, for the one state the Node cannot observe, says which
 * of the two it is — an operator reading `account_not_selectable` in a report months later has no other way
 * to know it was somebody's account of a consent screen rather than a measurement.
 *
 * **The endpoints.** `cloudflare-grant.ts` holds four URLs as constants and its own docstring says `doctor`
 * compares them against live discovery. That promise is this check. It is here rather than on the
 * authorization path for the reason the receipt records: `dash.cloudflare.com` answers the RFC 8414 path with
 * a **200 carrying HTML**, so a Node discovering its endpoints at runtime would parse a web page and fail at
 * the moment an operator was trying to connect.
 *
 * A network failure here is `ok` with a `report`, not a warning. `doctor` runs on a schedule and in a deploy,
 * and a Node whose report degraded because a third party was briefly unreachable would teach an operator to
 * ignore the report — the failure mode `checkTransportAdapters` and the deploy's canary both avoid.
 */
export async function checkProviderBinding(env: Env): Promise<Finding[]> {
  const { providerStatus, CLOUDFLARE_OAUTH } = await import("../provider/cloudflare-grant.ts");
  const status = await providerStatus(env).catch(() => null);

  const findings: Finding[] = [];

  if (status === null) {
    findings.push({
      check: "provider_binding",
      severity: "report",
      discloses: "infrastructure",
      ok: true,
      detail: "The provider binding could not be read, which on a Node predating migration 0053 means the "
        + "table does not exist yet rather than that anything is wrong.",
    });
  } else {
    /*
     * The state, and what kind of fact it is. `evidence` is carried into the detail rather than left in the
     * API's JSON, because this text is what ends up pasted into an issue.
     */
    const said: Record<string, string> = {
      no_client: "This Node has no Cloudflare OAuth client. It holds no grant and can read nothing about the "
        + "account it runs in.",
      awaiting_consent: "A Cloudflare OAuth client is registered and nobody has consented yet.",
      account_not_selectable: "An operator reported that their account was not listed on Cloudflare's "
        + "consent screen. This is their account of it and not this Node's measurement — the Node cannot see "
        + "which accounts a consent screen lists, because the authorization request never returns.",
      consent_granted: "This Node holds a Cloudflare grant. Nothing has been read with it yet.",
      grant_refused: "Cloudflare rejected the grant this Node holds. Mail, users, Butlers, schedules, the "
        + "API and recovery are unaffected: nothing on those paths uses this grant.",
    };
    findings.push({
      check: "provider_binding",
      /*
       * **`report` with `ok: false`, which is the first finding in this file to use that pair.**
       *
       * `degraded` means *something is wrong here*, and it escalates the verdict — which `mailda deploy`
       * reads as a failure. #162 requires that revoking this grant in Cloudflare leaves mail, users,
       * Butlers, schedules, the API, backup and recovery working, and it does: nothing on those paths
       * touches it. A Node reporting `degraded` because its operator revoked a grant on purpose would fail
       * a deploy for a deliberate act, which is the failure this file's own comments call out twice.
       *
       * So the finding is not `ok` — something a person may want to act on is true — and the verdict does
       * not move. That distinction is what `ok` and `severity` are two fields for.
       */
      severity: "report",
      discloses: "infrastructure",
      ok: status.state !== "grant_refused",
      detail: `${said[status.state] ?? status.state} (state=${status.state}, evidence=${status.evidence}`
        + `${status.clientId === null ? "" : `, client=${status.clientId}`}`
        + `${status.accountId === null ? "" : `, account=${status.accountId}`}`
        + `${status.scopesGranted === null ? "" : `, scopes=${status.scopesGranted.join(" ")}`})`
        + (status.scopesMissing.length === 0 ? "" : ` This grant predates a scope this Node now asks for: `
          + `${status.scopesMissing.join(" ")}. What needs it is refused until somebody adds it to the OAuth `
          + "client in the Cloudflare dashboard and authorizes again — a client may request only what it was "
          + "registered with, so consenting first answers invalid_scope."),
      ...(status.state === "grant_refused"
        ? {
          fix: "authorize again from the connection screen. If the grant was revoked deliberately, that is "
            + "the expected state and nothing needs fixing — this Node keeps running without it",
        }
        : {}),
      ...(status.state === "consent_granted" && status.accountId === null
        ? {
          /*
           * Measured: the token response does not name the account (`oauth.token_response_names_account:
           * 0`), so it costs a call. Not made here — `doctor` runs on a schedule and in a deploy, and a
           * diagnostic that renewed a token and read an account as a side effect would be spending the
           * grant to describe it. `mailda provider --resolve-account` is the deliberate act.
           */
          fix: "run `mailda provider --resolve-account`. Cloudflare's token response does not name the "
            + "account (measured), so it takes one GET /accounts through the grant",
        }
        : {}),
    });
  }

  let live: Record<string, unknown> | null = null;
  try {
    const response = await fetch(CLOUDFLARE_OAUTH.discovery, { headers: { accept: "application/json" } });
    live = response.ok ? ((await response.json()) as Record<string, unknown>) : null;
  } catch {
    live = null;
  }

  if (live === null) {
    findings.push({
      check: "provider_oauth_endpoints",
      severity: "report",
      discloses: "infrastructure",
      ok: true,
      detail: `Cloudflare's discovery document at ${CLOUDFLARE_OAUTH.discovery} could not be read, so the `
        + "four endpoints this Node holds were not compared against it. Not a failure: a report that "
        + "degraded because a third party was briefly unreachable is a report an operator learns to ignore.",
    });
    return findings;
  }

  const expected: Array<[string, string]> = [
    ["issuer", CLOUDFLARE_OAUTH.issuer],
    ["authorization_endpoint", CLOUDFLARE_OAUTH.authorize],
    ["token_endpoint", CLOUDFLARE_OAUTH.token],
    ["revocation_endpoint", CLOUDFLARE_OAUTH.revoke],
  ];
  const drifted = expected.filter(([field, held]) => live?.[field] !== held);

  findings.push({
    check: "provider_oauth_endpoints",
    // Same pair, same reason: a moved Cloudflare endpoint stops *new* connections and touches no mail, so it
    // is a finding to act on rather than a reason for this Node's deploy to fail.
    severity: "report",
    discloses: "infrastructure",
    ok: drifted.length === 0,
    receipt: "docs/receipts/cloudflare-oauth-endpoints.md",
    detail: drifted.length === 0
      ? `All four OAuth endpoints this Node holds match Cloudflare's discovery document (${expected.length} `
        + "checked: issuer, authorization, token, revocation)."
      : `${drifted.length} of ${expected.length} OAuth endpoints have moved: `
        + drifted.map(([field, held]) => `${field} is ${String(live?.[field])}, this Node holds ${held}`)
          .join("; "),
    ...(drifted.length === 0 ? {} : {
      fix: "the endpoints are constants in src/provider/cloudflare-grant.ts with a receipt behind them. "
        + "Update both, and re-read cloudflare-oauth-endpoints.md's stale_when — a moved endpoint is one of "
        + "the conditions it names",
    }),
  });

  return findings;
}

/**
 * What the receiving server has been saying about senders (0055), counted over the last seven days.
 *
 * A `report`, and `ok` whatever the counts: a message whose From domain disowned it is not this Node being
 * unhealthy, it is this Node doing its job and saying so. What the finding is *for* is the shape of the
 * week — a Node seeing `absent` on every message is one whose mail is not arriving through the MX that
 * authenticates, which is a routing fact worth a sentence; a Node with a run of `fail` against `reject`
 * policies is one whose operator should be reading the sender line. `unevaluated` is the count from before
 * this check existed, and it only goes down. Deliveries held back by a mailbox's quarantine (0056) are
 * counted whole, not over the week: a held delivery nobody has looked at is the fact, however old.
 */
export async function checkInboundAuthentication(
  env: Env, ctx: Ctx, orgId: string | null,
): Promise<Finding[]> {
  if (orgId === null) return [];
  const since = new Date(ctx.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const row = await env.CATALOG.prepare(
    `SELECT
       SUM(CASE WHEN auth_dmarc = 'pass' THEN 1 ELSE 0 END) AS pass,
       SUM(CASE WHEN auth_dmarc = 'fail' THEN 1 ELSE 0 END) AS fail,
       SUM(CASE WHEN auth_dmarc = 'fail' AND auth_dmarc_policy = 'reject' THEN 1 ELSE 0 END) AS fail_reject,
       SUM(CASE WHEN auth_dmarc = 'none' THEN 1 ELSE 0 END) AS none,
       SUM(CASE WHEN auth_dmarc = 'absent' THEN 1 ELSE 0 END) AS absent,
       SUM(CASE WHEN auth_dmarc IS NULL THEN 1 ELSE 0 END) AS unevaluated,
       COUNT(*) AS total,
       SUM(CASE WHEN attachments_dangerous > 0 THEN 1 ELSE 0 END) AS dangerous,
       (SELECT COUNT(*) FROM messages h WHERE h.org_id = ? AND h.quarantined_at IS NOT NULL) AS held
     FROM messages WHERE org_id = ? AND received_at >= ?`,
  ).bind(orgId, orgId, since).first<{
    pass: number | null; fail: number | null; fail_reject: number | null; none: number | null;
    absent: number | null; unevaluated: number | null; total: number; dangerous: number | null; held: number;
  }>().catch(() => null);
  if (row === null) {
    return [{
      check: "inbound_authentication", severity: "report", discloses: "data", ok: true,
      detail: "Could not read the messages table.",
      fix: "check the migrations_applied finding first",
    }];
  }
  const n = (value: number | null) => Number(value ?? 0);
  return [{
    check: "inbound_authentication",
    severity: "report",
    discloses: "data",
    ok: true,
    detail: row.total === 0
      ? "No message has arrived in the last seven days, so there is nothing to say about senders."
      : `Of ${row.total} message(s) in the last seven days, DMARC: ${n(row.pass)} pass, ${n(row.fail)} fail`
        + `${n(row.fail_reject) > 0 ? ` (${n(row.fail_reject)} against a domain asking receivers to reject)` : ""}, `
        + `${n(row.none)} from domains publishing no policy, ${n(row.absent)} with no authentication header from `
        + `the receiving server${n(row.unevaluated) > 0 ? `, ${n(row.unevaluated)} from before this Node evaluated senders` : ""}. `
        + "A fail is the From domain saying the message is not theirs; the sender line on each message says so."
        + (n(row.dangerous) > 0
          ? ` ${n(row.dangerous)} carried an executable, a script, or a program under a document's name (0057).`
          : "")
        // Not bounded by the week: a delivery held a month ago and never looked at is the one to mention.
        + (row.held > 0
          ? ` ${row.held} deliver${row.held === 1 ? "y is" : "ies are"} held back (0056), waiting for an administrator on the queue screen.`
          : ""),
    receipt: "docs/receipts/email-authentication-results.md",
  }];
}

