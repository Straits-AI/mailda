import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { unwrapCredential, wrapCredential } from "./auth/kek.ts";
import { mintAccessToken, verifyAccessToken } from "./auth/jwt.ts";
import { vault } from "./keyvault.ts";
import { reconcileEvidence } from "./reconcile.ts";
import { pendingReseal } from "./reseal.ts";

/**
 * `doctor` — the thing that checks the claims every other decision made.
 *
 * Each closed decision produced at least one statement that has to be **true at runtime**, and
 * until now nothing checked any of them. Two examples that actually bit during development: a Node
 * will happily encrypt mail under a KEK published in this repository, and a Secrets Store secret is
 * `pending` for a while after creation so a *present* binding can still throw. Both look fine.
 *
 * ## Three severities, and the distinction is the whole design
 *
 *   refuse   — the Node must not serve. Something is untrue that makes its promises false, and
 *              continuing means lying rather than degrading.
 *   degraded — it serves, but a human has to see this. Never auto-repaired, never hidden.
 *   report   — a figure worth reading. Says nothing is wrong.
 *
 * A `refuse` is reserved for what makes the *product's claims* false, not for what is merely
 * broken. A missing evidence blob is data loss — the worst thing in §24 — and it is nevertheless
 * `degraded`, because taking a whole mail system offline over one unreadable message helps nobody
 * and refusing does not bring the message back. Encrypting under a published key is `refuse`,
 * because "encrypted at rest" is then untrue for every message.
 *
 * ## Who may see it
 *
 * An **unclaimed** Node answers anyone: it has no organization, no users and no mail, and this is
 * exactly when an operator most needs to know what is wrong. There is nothing to protect yet.
 *
 * Once **claimed**, it requires an authenticated principal. A diagnostic is the obvious place to
 * leak the thing §5C forbids leaking — whether a resource exists — and this one names tables,
 * bindings, receipt ids and counts. `/health` stays the unauthenticated surface and stays
 * deliberately dull.
 *
 * ## What it cannot check
 *
 * The Workers Paid plan (ADR 25). A Worker cannot read its own account's plan; that check belongs
 * to `mailda deploy`, which holds an account token. Recorded as `report` naming the gap, rather
 * than silently omitted — an absent check reads exactly like a passing one.
 */

export type Severity = "refuse" | "degraded" | "report";

export interface Finding {
  check: string;
  severity: Severity;
  ok: boolean;
  detail: string;
  /** What to actually do. Present on every failure, per AGENTS.md's error shape. */
  fix?: string;
  receipt?: string;
  /**
   * What this finding's detail reveals.
   *
   *   infrastructure — binding names, table names, config shape. All of it is already in a public
   *                    repository, so disclosing it tells an attacker nothing they cannot read.
   *   data           — counts, receipt ids, anything derived from an organization's mail. §5C's
   *                    rule applies: never reveal whether a resource exists.
   *
   * This distinction is what lets a locked-out operator still be told why they are locked out.
   */
  discloses: "infrastructure" | "data";
}

export interface DoctorReport {
  verdict: "ok" | "degraded" | "refuse";
  claimed: boolean;
  at: string;
  findings: Finding[];
  /**
   * What this run cost. Reported rather than assumed, because the receipt for this file needs a
   * measured number and because the 1,000-subrequest cap is the reason the evidence check is
   * bounded at all. A diagnostic that cannot say what it cost is one more number without a receipt.
   */
  cost: { d1Queries: number; r2Reads: number; subrequests: number };
}

/**
 * Counts what a doctor run spends, by standing in front of the two bindings it uses.
 *
 * Subrequests are the cap that matters (1,000 per invocation), and both D1 queries and R2 reads
 * spend one. Rows read is deliberately *not* counted: `D1PreparedStatement.first()` returns the row
 * without `meta`, so a rows-read total would silently omit most of this file's queries — and a
 * partial figure presented as a total is exactly the kind of number this project refuses to write.
 */
function metered(env: Env): { env: Env; cost: DoctorReport["cost"] } {
  const cost = { d1Queries: 0, r2Reads: 0, subrequests: 0 };

  /**
   * Every passthrough is **bound to the target**, not returned bare.
   *
   * `Reflect.get(target, property, receiver)` hands back an unbound method, which then runs with
   * `this` set to the proxy and fails with "Illegal invocation" — a native binding rejects a `this`
   * that is not itself. It surfaced on `R2Bucket.list()`, the one method here that was not
   * special-cased, and it presented as "Reconciliation failed" rather than as a proxy bug.
   */
  const passthrough = <T extends object>(target: T, property: string | symbol) => {
    const value = Reflect.get(target, property) as unknown;
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  };

  const catalog = new Proxy(env.CATALOG, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          cost.d1Queries += 1;
          cost.subrequests += 1;
          return target.prepare(query);
        };
      }
      return passthrough(target, property);
    },
  });

  const evidence = new Proxy(env.EVIDENCE, {
    get(target, property) {
      if (property === "head" || property === "get" || property === "list" || property === "delete") {
        return (...args: unknown[]) => {
          cost.r2Reads += 1;
          cost.subrequests += 1;
          return (Reflect.get(target, property) as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return passthrough(target, property);
    },
  });

  return { env: { ...env, CATALOG: catalog, EVIDENCE: evidence } as Env, cost };
}

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
const EXPECTED_TABLES = [
  "relationship_tuples", "team_members", "messages", "mailbox_items", "ingress_receipts",
  "outbox", "addresses", "mailboxes", "users", "sessions", "node_claim",
  "signing_keys", "refresh_tokens", "login_attempts",
  // Migration 0007 (outbound) and 0008 (audit). Absent here until 6 August 2026.
  "send_manifests", "send_counters", "node_capabilities",
  "audit_entries", "log_entries",
  // Migration 0010 (per-recipient outcome).
  "send_recipients", "send_recipient_events",
  // Migration 0012 (durable drafts).
  "drafts",
];

export async function runDoctor(rawEnv: Env, ctx: Ctx): Promise<DoctorReport> {
  const { env, cost } = metered(rawEnv);
  const findings: Finding[] = [];
  const claim = await env.CATALOG.prepare(
    "SELECT org_id, claimed_at FROM node_claim LIMIT 1",
  ).first<{ org_id: string | null; claimed_at: string | null }>().catch(() => null);
  const claimed = claim?.claimed_at != null;

  findings.push(
    ...(await checkSchema(env)),
    ...(await checkEvidenceBucket(env)),
    ...(await checkDeliveryVisibility(env, ctx, claim?.org_id ?? null)),
    ...(await checkVault(env)),
    ...(await checkCredentialKek(env)),
    ...(await checkSigningKeys(env, ctx)),
    ...(await checkOutbox(env, ctx)),
    ...(await checkEvidence(env, ctx, claim?.org_id ?? null)),
    planCheck(),
  );


  findings.push({
    check: "doctor_cost",
    severity: "report",
    discloses: "data",
    ok: cost.subrequests <= BUDGETS["doctor.max_subrequests_per_run"],
    detail: `${cost.subrequests} subrequest(s): ${cost.d1Queries} D1 quer${cost.d1Queries === 1 ? "y" : "ies"}, ${cost.r2Reads} R2 read(s). Cap is ${BUDGETS["doctor.max_subrequests"]} per invocation.`,
    ...(cost.subrequests <= BUDGETS["doctor.max_subrequests_per_run"] ? {} : {
      fix: `a doctor run now costs more than the tripwire allows — a check has become proportional to mailbox size, which is how the authorization path grew a full table scan unnoticed`,
    }),
    receipt: "docs/receipts/doctor-check-cost.md",
  });

  // Derived after every finding exists, so it can never depend on the order they were pushed in.
  const verdict = findings.some((f) => !f.ok && f.severity === "refuse")
    ? "refuse"
    : findings.some((f) => !f.ok && f.severity === "degraded")
      ? "degraded"
      : "ok";

  return { verdict, claimed, at: new Date(ctx.now()).toISOString(), findings, cost };
}

/** Migrations applied. Checked by looking for the tables, not by trusting a version row. */
async function checkSchema(env: Env): Promise<Finding[]> {
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
async function checkEvidenceBucket(env: Env): Promise<Finding[]> {
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
 * Can this Node see what happened to the mail it sent?
 *
 * A Node cannot receive its own bounces (`cloudflare-email-sending.md`, corrected), so delivery outcomes
 * arrive only on a Queues event subscription. That subscription is an **account-level** object: it is not
 * in `wrangler.jsonc`, wrangler's CLI cannot create it, and the dashboard's own modal currently throws —
 * so it is created through the API by `mailda deploy` (`queue-provisioning.md`).
 *
 * Which means it can be absent, deleted, disabled, or pointed at the wrong sending domain, and **nothing
 * about a Node in that state looks wrong**: sends still hand over, the outbox still fills, and every
 * recipient sits at `unobserved` forever. No events is indistinguishable from nothing having bounced,
 * which is the exact ambiguity Layer 2 exists to remove — so the silence has to be named.
 *
 * `degraded`, not `refuse`. A Node without it still sends honest mail and still reports `handed_over`
 * truthfully; what it cannot do is tell you what happened next. Refusing to run would trade a working
 * product for a missing observation, which is precisely the trade AGENTS.md forbids.
 *
 * Inferred from evidence rather than asked of the platform, deliberately: reading the subscription would
 * need an account credential §5A forbids a Node retaining. Instead it compares what this Node has handed
 * over against what it has heard back — which is the thing a person actually wants to know, and is true
 * even if a subscription exists but is misrouted.
 */
async function checkDeliveryVisibility(env: Env, ctx: Ctx, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "delivery_visibility",
      severity: "degraded",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so nothing has been sent.",
    }];
  }

  const window = new Date(ctx.now() - DELIVERY_SILENCE_MS).toISOString();
  const counted = await env.CATALOG.prepare(
    `SELECT
       (SELECT COUNT(*) FROM send_recipients r
          JOIN send_manifests m ON m.id = r.manifest_id
         WHERE r.org_id = ? AND r.submission_state = 'handed_over' AND m.state_at < ?) AS awaiting,
       (SELECT COUNT(*) FROM send_recipients r
          JOIN send_manifests m ON m.id = r.manifest_id
         WHERE r.org_id = ? AND r.submission_state = 'handed_over' AND m.state_at < ?
           AND r.delivery_state IS NULL) AS unobserved,
       (SELECT COUNT(*) FROM send_recipient_events WHERE org_id = ?) AS events`,
  )
    .bind(orgId, window, orgId, window, orgId)
    .first<{ awaiting: number; unobserved: number; events: number }>()
    .catch(() => null);

  if (counted === null) {
    return [{
      check: "delivery_visibility",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "Could not read the delivery tables.",
      fix: "check the migrations_applied finding first",
    }];
  }

  // Every hand-over old enough to have been answered, and not one answer among them. One unobserved
  // recipient means nothing; all of them, with zero events ever received, means the channel is not there.
  const blind = counted.awaiting > 0 && counted.unobserved === counted.awaiting && counted.events === 0;

  return [{
    check: "delivery_visibility",
    severity: "degraded",
    discloses: "data",
    ok: !blind,
    detail: blind
      ? `${counted.awaiting} recipient(s) were handed over more than ` +
        `${Math.round(DELIVERY_SILENCE_MS / 60000)} minutes ago and this Node has received no delivery ` +
        `events at all. It cannot tell you whether any of them arrived, and "no bounces" here means ` +
        `"nothing heard" rather than "nothing failed".`
      : counted.awaiting === 0
        ? "Nothing has been handed over long enough to expect an answer yet."
        : `${counted.awaiting - counted.unobserved} of ${counted.awaiting} handed-over recipient(s) have ` +
          `an observed outcome, from ${counted.events} event(s).`,
    ...(blind ? {
      fix: "create an Email Sending event subscription for this sending domain, delivering to the " +
        "mailda-sending-events queue (docs/receipts/email-sending-events.md). Without it every recipient " +
        "stays unobserved forever",
    } : {}),
  }];
}

/**
 * The vault (ADR 28).
 *
 * There is no binding to be absent any more, which is the point: a Node generates its own keys on
 * first use, so "encrypted under a constant published in the public repository" stopped being a
 * representable state rather than one this function has to catch. What is left to check is whether
 * any evidence is *still* at generation 0 from before the vault existed — which is a migration in
 * progress, not a misconfiguration, so it is `degraded` and names the remedy.
 */
async function checkVault(env: Env): Promise<Finding[]> {
  let inventory: { content: number; credential: number };
  try {
    // Deliberately `sealingKey`, not `inventory` — this **initialises** the vault if it is empty.
    //
    // A diagnostic that mutates needs a reason, and here it is: generation-0 evidence can only be
    // *detected* by comparing it against a newer key, so a Node that predates the vault would never
    // learn it has a backlog until something happened to seal. Generating is idempotent, and
    // `sealingKey` never returns the legacy constant, so this cannot create an unprotected state.
    const content = await vault(env).sealingKey("content");
    const credential = await vault(env).sealingKey("credential");
    inventory = { content: content.generation, credential: credential.generation };
  } catch (error) {
    return [{
      check: "key_vault",
      severity: "refuse",
      discloses: "infrastructure",
      ok: false,
      detail: `The KeyVault Durable Object did not answer: ${(error as Error).message.split("\n")[0]}`,
      fix: "check the KEY_VAULT durable_objects binding and the migrations tag declaring the class; " +
        "without it this Node can neither seal nor open evidence",
    }];
  }

  const findings: Finding[] = [{
    check: "key_vault",
    severity: "refuse",
    discloses: "infrastructure",
    ok: true,
    detail: `content key generation ${inventory.content}, credential key generation ${inventory.credential}. ` +
      `Generated by this Node; generation 0 is the published constant and is decrypt-only.`,
  }];

  const behind = await pendingReseal(env, inventory.content).catch(() => null);
  if (behind !== null && behind > 0) {
    findings.push({
      check: "evidence_key_generation",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `${behind} receipt(s) reference evidence sealed under an older key generation. ` +
        `Generation 0 is a constant published in the Mailda repository, so that mail is not protected.`,
      fix: "POST /api/maintenance/reseal repeatedly until `remaining` reaches 0; it is resumable and " +
        "verifies each message against its recorded plaintext SHA-256",
      receipt: "docs/receipts/evidence-lifecycle.md",
    });
  }

  return findings;
}

/**
 * The credential key, checked by **using** it rather than by looking at it.
 *
 * There is no binding to be present any more (ADR 28), so the failure this catches has changed shape:
 * a wrap/unwrap round trip fails when the vault holds a different key than the one that wrapped an
 * existing value — a restored backup whose Durable Object storage did not come with it, or a rotation
 * that was interrupted. Presence was never the interesting question; usability is.
 */
async function checkCredentialKek(env: Env): Promise<Finding[]> {
  const probe = "doctor-credential-key-round-trip";
  try {
    const recovered = await unwrapCredential(env, await wrapCredential(env, probe));
    return [{
      check: "credential_key",
      severity: "refuse",
      discloses: "infrastructure",
      ok: recovered === probe,
      detail: recovered === probe
        ? "Wrap/unwrap round trip succeeded."
        : "Wrap/unwrap round trip returned different bytes.",
      ...(recovered === probe ? {} : {
        fix: "the credential key changed; existing signing keys cannot be unwrapped and must be rotated",
      }),
    }];
  } catch (error) {
    return [{
      check: "credential_key",
      severity: "refuse",
      discloses: "infrastructure",
      ok: false,
      detail: `Could not wrap and unwrap with the credential key: ${(error as Error).message.split("\n")[0]}`,
      fix: "if the vault reports an unknown generation, restore it from the ADR 29 recovery codes — " +
        "the data is intact but unreadable without its key",
    }];
  }
}

/**
 * Signing keys, also checked by using them: mint a token and verify it.
 *
 * Absence is `degraded`, not `refuse` — a key is generated on first use, so an empty table
 * self-heals on the next sign-in. A key that exists and cannot sign or verify does not.
 */
async function checkSigningKeys(env: Env, ctx: Ctx): Promise<Finding[]> {
  const counts = await env.CATALOG.prepare(
    `SELECT
       SUM(CASE WHEN status = 'current'  THEN 1 ELSE 0 END) AS current_keys,
       SUM(CASE WHEN status = 'retiring' THEN 1 ELSE 0 END) AS retiring_keys
     FROM signing_keys`,
  ).first<{ current_keys: number | null; retiring_keys: number | null }>().catch(() => null);

  const current = counts?.current_keys ?? 0;
  if (current === 0) {
    return [{
      check: "signing_key",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "No current signing key. One is generated on the next sign-in, so this self-heals — but no existing access token can be verified until then.",
      fix: "sign in once, or POST /api/auth/rotate-signing-key",
    }];
  }

  try {
    const minted = await mintAccessToken(env, ctx, { orgId: "org_doctor", userId: "usr_doctor" });
    const verified = await verifyAccessToken(env, minted.token, ctx.now());
    return [{
      check: "signing_key",
      severity: "refuse",
      discloses: "infrastructure",
      ok: verified.ok,
      detail: verified.ok
        ? `Sign and verify round trip succeeded. ${current} current, ${counts?.retiring_keys ?? 0} still verifying.`
        : `A token signed by the current key does not verify: ${verified.reason}.`,
      ...(verified.ok ? {} : { fix: "rotate the signing key; sign-in cannot work while this fails" }),
    }];
  } catch (error) {
    return [{
      check: "signing_key",
      severity: "refuse",
      discloses: "infrastructure",
      ok: false,
      detail: `Could not use the current signing key: ${(error as Error).message.split("\n")[0]}`,
      fix: "the key is unwrappable only with the credential KEK that wrapped it — check the credential_kek finding first",
    }];
  }
}

/**
 * Is the outbox draining? An unpublished row older than the sweeper's own staleness cutoff means
 * the Durable Object alarm is not firing, and §22's guarantee is that events are *eventually*
 * delivered — a stalled outbox turns "eventually" into "never" without any error anywhere.
 */
async function checkOutbox(env: Env, ctx: Ctx): Promise<Finding[]> {
  const cutoff = new Date(ctx.now() - STALLED_OUTBOX_MS).toISOString();
  const row = await env.CATALOG.prepare(
    `SELECT COUNT(*) AS stalled, MIN(created_at) AS oldest
       FROM outbox WHERE published_at IS NULL AND created_at < ?`,
  ).bind(cutoff).first<{ stalled: number; oldest: string | null }>().catch(() => null);

  const stalled = row?.stalled ?? 0;
  return [{
    check: "outbox_draining",
    severity: "degraded",
    discloses: "data",
    ok: stalled === 0,
    detail: stalled === 0
      ? "No outbox events older than the sweeper's cutoff."
      : `${stalled} unpublished event(s) older than ${STALLED_OUTBOX_MS / 1000}s; oldest ${row?.oldest}.`,
    ...(stalled === 0 ? {} : {
      fix: "the OUTBOX_SWEEPER alarm is not firing — check the durable_objects binding and the migrations tag that declares the class",
    }),
  }];
}

/** Ten minutes: long enough that fast-path publication and one alarm retry have both had a turn. */
const STALLED_OUTBOX_MS = 10 * 60 * 1000;

/**
 * How long a hand-over may go unanswered before silence is worth reporting.
 *
 * Derived from a measured arrival, not chosen: `email-sending-events.md` observed a bounce landing about
 * 60 seconds after hand-over, and this is 15x that. Deliberately generous, because the errors are not
 * symmetric — a false alarm gets a check muted, and a muted check guards nothing.
 */
const DELIVERY_SILENCE_MS = BUDGETS["events.delivery_silence_minutes"] * 60 * 1000;

/**
 * Evidence integrity — §24's worst failure: a receipt saying a message was accepted, pointing at a
 * blob that is not there. "Accepted but absent".
 *
 * Delegates to the reconciler rather than reimplementing the scan, so there is exactly one answer to
 * "is the mail actually there" and it cannot drift between the diagnostic and the repair tool. Called
 * **read-only** — `collect` is not set — because a diagnostic must never be the thing that deletes
 * data, however safe the deletion looks.
 */
async function checkEvidence(env: Env, ctx: Ctx, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "evidence_present",
      severity: "degraded",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so there is no evidence to check.",
    }];
  }

  let report;
  try {
    report = await reconcileEvidence(env, ctx, orgId);
  } catch (error) {
    return [{
      check: "evidence_present",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `Reconciliation failed: ${(error as Error).message.split("\n")[0]}`,
      fix: "check the migrations_applied and key_vault findings first",
    }];
  }

  const scope =
    `${report.scanned.receipts} of ${report.scanned.receiptsTotal} receipt(s) and ` +
    `${report.scanned.objects} object(s)${report.scanned.truncated ? ", truncated" : ""} examined`;

  const findings: Finding[] = [{
    check: "evidence_present",
    severity: "degraded",
    discloses: "data",
    ok: report.missing.length === 0,
    detail: report.missing.length === 0
      ? `Every sampled receipt's evidence object exists (${scope}).`
      : `${report.missing.length} receipt(s) reference an evidence object that is absent — accepted ` +
        `mail that cannot be read (${scope}): ${report.missing.map((m) => m.receiptId).join(", ")}.`,
    ...(report.missing.length === 0 ? {} : {
      fix: "this is lost mail, not a bookkeeping error. Do not delete the receipts. Check R2 lifecycle " +
        "rules and §24 Time Travel before anything else",
    }),
    receipt: "docs/receipts/evidence-lifecycle.md",
  }];

  if (report.orphans.length > 0) {
    findings.push({
      check: "evidence_orphans",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `${report.orphans.length} object(s) have no receipt and are past the grace period — ` +
        `writes that lost their transaction. They cost storage and reveal nothing.`,
      fix: "POST /api/maintenance/reconcile?collect=1 to delete them",
      receipt: "docs/receipts/evidence-lifecycle.md",
    });
  }

  return findings;
}

/**
 * ADR 25 requires Workers Paid, and a Worker cannot read its own account's plan. Reported as an
 * explicit gap rather than omitted: a check that is absent is indistinguishable from one that
 * passes, which is the same reasoning that put `stale_when` on every receipt.
 */
function planCheck(): Finding {
  return {
    check: "workers_paid_plan",
    severity: "report",
    discloses: "infrastructure",
    ok: true,
    detail: "Not checkable from inside a Worker — no account API access. `mailda deploy` verifies the plan at install and refuses on Workers Free (ADR 25).",
    receipt: "docs/receipts/cloudflare-plan-costs.md",
  };
}

/**
 * The four-part text form, for a CLI and for a log line. The report is structured; this is how a
 * human reads it.
 */
export function formatReport(report: DoctorReport): string {
  const lines = [`mailda doctor  ${report.verdict.toUpperCase()}  (${report.claimed ? "claimed" : "unclaimed"})`];
  for (const finding of report.findings) {
    const mark = finding.ok ? "ok  " : finding.severity === "refuse" ? "FAIL" : finding.severity === "degraded" ? "WARN" : "note";
    lines.push(`  ${mark}  ${finding.check}`, `        ${finding.detail}`);
    if (finding.fix !== undefined) lines.push(`        fix      ${finding.fix}`);
    if (finding.receipt !== undefined) lines.push(`        receipt  ${finding.receipt}`);
  }
  return lines.join("\n");
}

/**
 * Can this Node authenticate anyone at all?
 *
 * Found by measurement, not by reasoning: removing the `CREDENTIAL_KEK` binding made every signing
 * key unwrappable, so sign-in returned 500 — and `doctor`, which requires authentication on a
 * claimed Node, became unreachable at exactly the moment it was needed. A diagnostic that is only
 * available while the system is healthy is not a diagnostic.
 *
 * When authentication is impossible, the authentication gate is not a gate anyone can satisfy, and
 * refusing to explain why is worse than disclosing which binding is missing. So the report is served
 * unauthenticated — reduced to `infrastructure` findings, whose contents are all already published
 * in this repository. Nothing derived from an organization's mail crosses that line.
 */
export function authenticationIsImpossible(report: DoctorReport): boolean {
  return report.findings.some(
    (f) => !f.ok && f.severity === "refuse" && (f.check === "credential_kek" || f.check === "signing_key"),
  );
}

/** The reduced form. Infrastructure findings only, and it says that it is reduced. */
export function withoutDataFindings(report: DoctorReport): DoctorReport {
  const findings = report.findings.filter((f) => f.discloses === "infrastructure");
  return {
    ...report,
    findings: [
      ...findings,
      {
        check: "report_reduced",
        severity: "report",
        ok: true,
        discloses: "infrastructure",
        detail:
          `Served without authentication because this Node cannot currently authenticate anyone. ` +
          `${report.findings.length - findings.length} finding(s) that would describe this ` +
          `organization's mail are withheld. Sign in once the failure above is fixed to see them.`,
      },
    ],
  };
}
