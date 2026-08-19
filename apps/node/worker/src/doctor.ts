import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { unwrapCredential, wrapCredential } from "./auth/kek.ts";
import { mintAccessToken, verifyAccessToken } from "./auth/jwt.ts";
import { vault } from "./keyvault.ts";
import { holdsForReport } from "./holds.ts";
import { draftBodyPrefix, reconcileEvidence, type DraftBodyScan } from "./reconcile.ts";
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
   * measured number and because the per-invocation subrequest cap is the reason the evidence check is
   * bounded at all. A diagnostic that cannot say what it cost is one more number without a receipt.
   */
  cost: { d1Queries: number; r2Reads: number; subrequests: number };
}

/**
 * Counts what a doctor run spends, by standing in front of the two bindings it uses.
 *
 * Subrequests are the cap that matters — 10,000 per invocation on Paid since 11 February 2026, when the
 * 1,000 this comment used to quote was withdrawn (`doctor-check-cost.md` carried the stale figure as a
 * *value* for six months) — and both D1 queries and R2 reads spend one. Rows read is deliberately *not* counted: `D1PreparedStatement.first()` returns the row
 * without `meta`, so a rows-read total would silently omit most of this file's queries — and a
 * partial figure presented as a total is exactly the kind of number this project refuses to write.
 */
/**
 * The cost meter, and **what it cannot measure** — recorded because the figure it produces is correct today
 * for a reason that has nothing to do with the meter being right.
 *
 * It counts `prepare`, not execution. A statement prepared once and executed twenty-five times counts **1**.
 * `batch` is not intercepted at all, so a batch of eight statements counts its eight prepares and **zero**
 * executions, while two hundred inserts inside one batch count two hundred rather than one. And it proxies
 * `CATALOG` and `EVIDENCE` only, so **Durable Object RPCs are invisible** — the two `KEY_VAULT` calls behind
 * every evidence read and write do not appear at all.
 *
 * Today's number is nonetheless right, and that is the landmine in the AGENTS.md sense: every `prepare`
 * reachable from `runDoctor` is chained into exactly one execution, so prepare-count happens to equal
 * execution-count on this path. Nothing enforces that, nothing would notice it changing, and the meter would
 * keep reporting a plausible figure.
 *
 * **So this meter must not be reused to price anything else — use `src/cost-meter.ts`**, which counts
 * executions, prices a `batch()` as the one round trip it is, and proxies the vault. Butler step costing was
 * going to use *this* meter and would have measured `mail.send.propose` at 6 subrequests against a measured
 * 10 (`butler-step-cost.md`), the missing ones being vault RPCs it cannot see. `test/node/doctor-meter-honesty.test.ts` pins the property that makes the
 * current figure true, so that if a reused statement or a `batch` ever appears on the doctor path, the
 * assumption fails loudly instead of the number drifting quietly.
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
  // Migration 0014 (Layer 3: conversations and cases).
  "conversations", "cases",
  // Migration 0018 (Layer 5: legal hold).
  "holds",
];

export async function runDoctor(rawEnv: Env, ctx: Ctx): Promise<DoctorReport> {
  const { env, cost } = metered(rawEnv);
  const findings: Finding[] = [];
  const claim = await env.CATALOG.prepare(
    "SELECT org_id, claimed_at FROM node_claim LIMIT 1",
  ).first<{ org_id: string | null; claimed_at: string | null }>().catch(() => null);
  const claimed = claim?.claimed_at != null;

  /**
   * Hoisted out of the list below because **two findings read one scan** (#67).
   *
   * `checkEvidence` performs the reconciler's read-only pass, and that pass now scans `${orgId}/drafts/`
   * as well as `${orgId}/raw/`. `draft_bodies_stranded` reports the draft-body half of it rather than
   * listing the prefix a second time — two listings of the same prefix that could disagree is the defect
   * #67 filed, in miniature, and it would cost two extra subrequests per run to build.
   *
   * Hoisting moves *when* these subrequests are spent, not how many, and that is measured rather than
   * reasoned: 13 subrequests before and after, in `doctor-check-cost.md`'s correction headed *"the draft-body
   * scan moved into the reconcile pass"*. The findings are still pushed in their original order.
   */
  const evidence = await checkEvidence(env, ctx, claim?.org_id ?? null);

  findings.push(
    ...(await checkSchema(env)),
    ...(await checkEvidenceBucket(env)),
    // Before the evidence-based one, because it says which question this report cannot answer at all, and a
    // reader meeting a blind Node needs that first. Costs no subrequest: it reads nothing.
    sendingEventsConsumerCheck(),
    ...(await checkDeliveryVisibility(env, ctx, claim?.org_id ?? null)),
    ...(await checkVault(env)),
    ...(await checkCredentialKek(env)),
    ...(await checkSigningKeys(env, ctx)),
    ...(await checkOutbox(env, ctx)),
    ...evidence.findings,
    ...strandedDraftBodyFindings(evidence.draftBodies),
    ...(await checkHolds(env, ctx, claim?.org_id ?? null)),
    planCheck(),
  );


  findings.push({
    check: "doctor_cost",
    severity: "report",
    discloses: "data",
    ok: cost.subrequests <= BUDGETS["doctor.max_subrequests_per_run"],
    // Both plans' caps, because this Worker cannot tell which one it is under — the `workers_paid_plan`
    // finding in this same report says exactly that. Printing only the Paid figure told an operator on
    // Free a ceiling ten times theirs, and a wrong number ends the question a blank would have prompted
    // (#68, docs/receipts/doctor-check-cost.md).
    detail: `${cost.subrequests} subrequest(s): ${cost.d1Queries} D1 quer${cost.d1Queries === 1 ? "y" : "ies"}, ${cost.r2Reads} R2 read(s). Cap per invocation is ${BUDGETS["doctor.paid.max_subrequests"]} on Workers Paid and ${BUDGETS["doctor.free.max_subrequests"]} on Workers Free; a Worker cannot tell which plan it is on.`,
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
 * Two things a Node needs before a delivery outcome can reach it, and **neither is in this Worker's
 * config** — so neither can be checked from inside a Worker, and both are reported rather than omitted.
 *
 *   the queue consumer   — this Worker subscribed to its own sending-events queue. Since #72 the producer
 *                          binding names no queue (a queue name is account-scoped, so a committed one made
 *                          the second Node in an account bind to the first Node's queue), and a consumer
 *                          block cannot name a queue whose name the config does not know. So the consumer
 *                          is attached out of band.
 *   the subscription     — the account-level `email.sending` object that feeds the queue. API-only:
 *                          `queue-provisioning.md` records `queues.subscription_creatable_by_cli: 0`.
 *
 * `workers_paid_plan` is the precedent for the shape and the argument is the same one: an absent check
 * reads exactly like a passing one. A Worker holds no account credential — §5A forbids it retaining one —
 * so it cannot ask Queues who consumes its queue, and inventing a check that cannot work would be worse
 * than saying which question this report cannot answer.
 *
 * `report`, `ok: true`, always. It is a fact about how a Node is installed rather than a fault, it varies
 * with nothing this Node can see, and a finding that fails on every Node forever is one somebody mutes —
 * the failure mode `DELIVERY_SILENCE_MS` names in this same file. What *does* fail, from evidence, is
 * `delivery_visibility` below: hand-overs old enough to have been answered with nothing heard back. So the
 * un-actionable capability is stated once and the observable consequence is what carries a severity.
 */
function sendingEventsConsumerCheck(): Finding {
  return {
    check: "sending_events_consumer",
    severity: "report",
    // The queue's name is derived from the Worker's name and the binding's name, both of which are in this
    // public repository or chosen by the operator. No organization content, so this survives into the
    // reduced report an unauthenticated locked-out operator sees, for the reason planCheck's does.
    discloses: "infrastructure",
    ok: true,
    detail:
      "Not checkable from inside a Worker — no account API access, so this Node cannot ask Queues who " +
      "consumes its sending-events queue. The consumer is attached out of band by " +
      "`pnpm --filter @mailda/worker run queue:attach-consumer`, which discovers the queue from this " +
      "Worker's deployed binding; the queue itself is provisioned by the deploy, which Cloudflare documents " +
      "and this repository has not measured, so that step refuses rather than assume a name. That step is " +
      "necessary and NOT sufficient: an `email.sending` event subscription has to publish to the queue as " +
      "well, and wrangler cannot create one (re-measured 19 August 2026 — `email.sending` is not a " +
      "`queues subscription create --source` choice). So a button-only install has never observed a " +
      "delivery outcome, before the per-Node queue or after it, and attaching the consumer alone does not " +
      "change that. `delivery_visibility` reports the consequence from evidence.",
    receipt: "docs/receipts/queue-provisioning.md",
  };
}

/**
 * Can this Node see what happened to the mail it sent?
 *
 * A Node cannot receive its own bounces (`cloudflare-email-sending.md`, corrected), so delivery outcomes
 * arrive only on a queue, fed by a Queues event subscription. Two account-level things stand between a
 * hand-over and an observed outcome, and the `sending_events_consumer` finding above names both: the
 * subscription is not in `wrangler.jsonc`, wrangler's CLI cannot create it, and the dashboard's own modal
 * currently throws — so it is created through the API by `mailda deploy` (`queue-provisioning.md`) — and
 * since #72 the consumer is attached out of band too.
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
       -- Split, and the split is the point. An event this Node could not tie to a manifest is evidence
       -- that ATTRIBUTION is broken, not evidence that the Node can see. Counting the two together meant
       -- one unattributable event flipped the blindness flag to false and suppressed the very warning the
       -- check exists to raise. Migration 0010 built the sre_unattributed index over exactly these rows
       -- and nothing ever read it, which is the tell that somebody expected them to matter.
       --
       -- No backticks in this comment: it sits inside a TypeScript template literal, so one would end it.
       -- That hazard has now bitten four times in this codebase (ui.ts, response-clock.ts, and here).
       (SELECT COUNT(*) FROM send_recipient_events
         WHERE org_id = ? AND manifest_id IS NOT NULL) AS attributed,
       (SELECT COUNT(*) FROM send_recipient_events
         WHERE org_id = ? AND manifest_id IS NULL) AS unattributed`,
  )
    .bind(orgId, window, orgId, window, orgId, orgId)
    .first<{ awaiting: number; unobserved: number; attributed: number; unattributed: number }>()
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
  // recipient means nothing; all of them, with zero **attributed** events ever received, means the channel
  // is not there. `attributed`, not the total: see the query above.
  const blind = counted.awaiting > 0 && counted.unobserved === counted.awaiting
    && counted.attributed === 0;

  /**
   * The third state, which used to be invisible.
   *
   * A Node receiving events it cannot tie to a manifest is **neither blind nor healthy**, and §5C's rule
   * against collapsing distinct states applies with more force in a diagnostic than anywhere else — the
   * whole value of `doctor` is that it does not blur. It is `degraded` rather than `refuse` because mail is
   * still leaving correctly; what is broken is this Node's ability to say what happened to it.
   */
  const attribution: Finding[] = counted.unattributed === 0 ? [] : [{
    check: "delivery_attribution",
    severity: "degraded",
    discloses: "data",
    ok: false,
    detail: `${counted.unattributed} delivery event(s) could not be matched to anything this Node sent. ` +
      `Their outcome is recorded against no recipient, so those sends stay unobserved however many ` +
      `events arrive. This is not the same as receiving no events, and not the same as being healthy.`,
    fix: "check that the event subscription is scoped to this Node's sending domain and no other — the " +
      "usual cause is a subscription covering a domain sent from elsewhere, whose events arrive here " +
      "with no matching manifest. transport_message_id is written only on hand-over, so a send whose " +
      "outcome was never determined has no join key and its events land here too",
    receipt: "docs/receipts/email-sending-events.md",
  }];

  return [...attribution, {
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
          `an observed outcome, from ${counted.attributed} attributed event(s).`,
    ...(blind ? {
      fix: "two things have to exist and neither is in this Worker's config, so check both. First attach " +
        "the queue consumer: pnpm --filter @mailda/worker run queue:attach-consumer, which discovers this " +
        "Worker's queue rather than naming it — the name is derived per Node since #72 and is not written " +
        "down anywhere. Then create an Email Sending event subscription for this sending domain, " +
        "delivering to that queue (docs/receipts/email-sending-events.md). The sending_events_consumer " +
        "finding says why neither can be checked from in here. Without both, every recipient stays " +
        "unobserved forever",
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
      fix: "the key is unwrappable only with the credential key that wrapped it — check the credential_key finding first",
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
 *
 * ## It returns the draft-body scan as well as its own findings
 *
 * Because the pass it delegates to produces both (#67), and `draft_bodies_stranded` must report **the same
 * set the collector would act on**, not a second opinion about it. That is why the return type is a pair
 * rather than a `Finding[]`: the alternative is a second `R2Bucket.list()` of the same prefix and a second
 * definition of "stranded", which is the shape of the defect #67 filed. `null` means there was no prefix
 * to scan — an unclaimed Node — and is the only case that is not a scan result.
 */
interface EvidenceCheck {
  findings: Finding[];
  draftBodies: DraftBodyScan | null;
}

async function checkEvidence(env: Env, ctx: Ctx, orgId: string | null): Promise<EvidenceCheck> {
  if (orgId === null) {
    return {
      findings: [{
        check: "evidence_present",
        severity: "degraded",
        discloses: "data",
        ok: true,
        detail: "No organization yet, so there is no evidence to check.",
      }],
      draftBodies: null,
    };
  }

  let report;
  try {
    report = await reconcileEvidence(env, ctx, orgId);
  } catch (error) {
    // The cause is kept, not discarded — a finding that says only "failed" leaves an operator with a
    // symptom and no lead. It is also the one channel by which the draft-body check learns it could not
    // judge: the whole pass threw, so there is no scan, and saying so is not the same as saying zero.
    const because = (error as Error).message.split("\n")[0] ?? null;
    return {
      findings: [{
        check: "evidence_present",
        severity: "degraded",
        discloses: "data",
        ok: false,
        detail: `Reconciliation failed: ${because}`,
        fix: "check the migrations_applied and key_vault findings first",
      }],
      draftBodies: { read: "unreadable", prefix: draftBodyPrefix(orgId), because },
    };
  }

  const scope =
    `${report.scanned.receipts} of ${report.scanned.receiptsTotal} receipt(s) and ` +
    // The prefixes, so "no orphans" cannot be read as a statement about the whole bucket. The truncation
    // clause goes last rather than inside the phrase "examined under", which it used to split.
    `${report.scanned.objects} object(s) examined under ${report.scanned.prefixes.join(", ")}` +
    (report.scanned.truncated ? `, listing truncated — more objects remain unexamined` : ``);

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
      // The caveat is unconditional rather than computed, so this check spends no query on holds and the
      // advice cannot be wrong: collection is suppressed org-wide while any hold stands (#64), and the
      // finding that knows whether one does is named here rather than restated.
      fix: "POST /api/maintenance/reconcile?collect=1 to delete them — unless a legal hold is in force, " +
        "which suppresses orphan collection for the whole organization because an orphan is unattributable " +
        "by definition. The legal_holds_active finding says whether one is",
      receipt: "docs/receipts/evidence-lifecycle.md",
    });
  }

  return { findings, draftBodies: report.draftBodies };
}

/**
 * Draft bodies with no `drafts` row (#67).
 *
 * A draft body is an R2 object at `${orgId}/drafts/{draftId}.txt` whose only referent is a `drafts`
 * row. `deleteDraft` issues one `DELETE FROM drafts` and touches R2 not at all, and a draft is deleted
 * when its message is *sealed* — the ordinary path through the composer. So every message ever sent
 * from a draft, and every draft anybody abandoned, leaves its body behind.
 *
 * ## What this finding means now, which is not what it meant when it was written
 *
 * It used to say these were **not collectable**: `reconcile.ts` listed `${orgId}/raw/` and nothing else,
 * its `EVIDENCE.delete` only ever saw objects from that listing, and so no code path deleted a draft body
 * at all. That was the defect. The reconciler now scans `${orgId}/drafts/` under its own referent rule and
 * collects from it through the same single delete, so residue no longer means *"nothing can ever collect
 * these"*. It means one of exactly two things, and the `fix` says both:
 *
 *   - **the collector has not been run.** Collection happens on `POST /api/maintenance/reconcile?collect=1`
 *     and nowhere else — there is no cron for it — so residue is the ordinary state of a Node between runs.
 *   - **a legal hold is suppressing it.** Any hold in the organization stops collection org-wide (#64),
 *     because an object with no referent is unattributable by definition.
 *
 * ## It takes the scan rather than performing one
 *
 * The set is computed by `scanDraftBodies` in `reconcile.ts` — **one definition**, called by the collector
 * and read here out of the read-only pass `checkEvidence` already performs. Two copies of "which objects
 * are stranded" that can disagree is a defect in waiting, and the disagreement would be silent in the
 * direction that matters: this finding would report a count the collector then declined to act on.
 *
 * That also makes this function pure. It spends no subrequest of its own, which is a **reduction** in what
 * it used to cost: the `R2Bucket.list()` and the `SELECT body_key` moved into the pass rather than being
 * added to it. Measured both ways in `doctor-check-cost.md`'s correction headed *"the draft-body scan moved
 * into the reconcile pass"* — 13 subrequests with it, 11 with the pass's call to `scanDraftBodies` disabled.
 * Cited by heading rather than by date because three corrections in that file now share 19 August 2026, and
 * the file records what an ordinal cross-reference cost the last time one was inserted.
 *
 * ## Every branch discloses `data`
 *
 * Including the ones that read like plumbing failures. The prefix this finding names *is* the org id, so
 * a detail naming it is org-scoped by construction — and `withoutDataFindings` keeps every
 * `infrastructure` finding for the unauthenticated reduced report, where `discloses` promises only
 * names already public in this repository. `checkEvidence` takes the same line on all of its branches,
 * including its catch. `test/stranded-draft-bodies.test.ts` asserts that the reduced report contains no
 * org id, on the failing branch as well as the passing one.
 */
function strandedDraftBodyFindings(scan: DraftBodyScan | null): Finding[] {
  if (scan === null) {
    return [{
      check: "draft_bodies_stranded",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so no draft body has been written.",
    }];
  }

  if (scan.read === "unreadable") {
    return [{
      check: "draft_bodies_stranded",
      // `degraded` here, unlike the finding below, because *this* one is actionable: a bucket or a
      // catalog that will not answer is a repair somebody can perform today, and it is the same
      // condition `evidence_present` and `migrations_applied` refuse on.
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `Could not read ${scan.prefix}, so no draft body was counted and none could be collected`
        + (scan.because === null ? "." : `: ${scan.because}.`),
      // Both, because one catch now covers both halves of the scan and this finding cannot tell which
      // failed. Naming one would send an operator to a healthy subsystem, which is worse than naming two.
      fix: "check the evidence_present, evidence_bucket_reachable and migrations_applied findings first",
    }];
  }

  // One scope clause, used by both branches. The truncation note goes at the end rather than inside
  // the phrase it used to split — "200 object(s), truncated — more remain examined under org_x/drafts/"
  // was a sentence about nothing. The too-fresh count is printed even when it is zero, matching
  // `formatReconcile`: a judgement withheld on N objects is part of the scope of the answer, and a
  // count that appears only when non-zero cannot be relied on by the reader who sees it absent.
  const examined =
    `${scan.examined} object(s) examined under ${scan.prefix}, ` +
    `${scan.tooFreshToJudge} too fresh to judge` +
    (scan.truncated ? `, listing truncated — more objects remain unexamined` : ``);
  // Whether this pass judged everything under the prefix. It is the success branch that needs it:
  // "every" from a scan that skipped objects is the overclaim #67 is about.
  const judgedEverything = !scan.truncated && scan.tooFreshToJudge === 0;
  const stranded = scan.stranded.length;

  return [{
    check: "draft_bodies_stranded",
    /**
     * Still `report`, and the argument had to be made again because the old one expired.
     *
     * The comment here used to say *"promote it to `degraded` when a collector exists"*. A collector now
     * exists, so that condition has been met — and it turns out to have been the wrong condition, which is
     * worth writing down rather than quietly honouring or quietly dropping.
     *
     * **What `degraded` has to mean is "something is wrong here".** Residue does not mean that. Collection
     * runs only on `POST /api/maintenance/reconcile?collect=1`; there is no cron and #67 deliberately did
     * not add one, because the sweep belongs to the pass an operator invokes rather than to a schedule
     * nobody asked for. So a Node that has sent one message from the composer and has not been swept since
     * has residue, correctly, and it is **healthy**. Degrading it would put a permanent WARN on the
     * ordinary state of the product — the failure mode `DELIVERY_SILENCE_MS` names in this same file, where
     * a false alarm gets a check muted and a muted check guards nothing. It gets worse under a hold, where
     * collection is refused org-wide on purpose and no operator action can close the finding at all.
     *
     * `evidence_orphans` is `degraded` for the opposite reason, and the contrast is the argument: a raw
     * orphan only exists because a write lost its transaction, so a nonzero count there really is evidence
     * that something went wrong. Residue here is evidence that somebody used the composer.
     *
     * **The condition that would justify `degraded` is residue that survives a collection run** — the
     * collector ran, was not suppressed, and the bytes are still there. Nothing in this report can know
     * that today: no collection run is recorded anywhere, so there is no last-swept instant to compare
     * against. That is the missing input, stated rather than approximated, and it is not invented here
     * because a guessed one would degrade exactly the healthy Nodes described above.
     *
     * What did change is the `fix`: it was *"nothing to run yet, and that is the finding"*, and there is
     * now a command. `workers_paid_plan` remains the precedent for the shape — a real fact, correctly
     * reported, that does not by itself mean a fault.
     */
    severity: "report",
    discloses: "data",
    ok: stranded === 0,
    detail: stranded === 0
      ? `No draft body without a drafts row among those judged (${examined}).` +
        (judgedEverything
          ? ` Every object under the prefix was listed and judged.`
          : ` Not every draft body was judged, so this is a clean sample rather than a clean prefix.`)
      : `${stranded} draft body object(s) have no drafts row (${examined}). ` +
        `A draft is deleted when its message is sealed, and deleting it removes the row only — so ` +
        `these are the bodies of messages already sent and of drafts somebody abandoned. The ` +
        `reconciler collects them under its own referent rule, through the same single R2 delete as ` +
        `raw orphans, so residue means the collector has not run or a legal hold is suppressing it — ` +
        `not that nothing can collect them, which is what this said until #67.` +
        // A floor for either reason it withheld judgement, not only truncation. A too-fresh object may
        // prove stranded on the next run, so a count that omits it is a floor exactly as a truncated
        // listing is — and the success branch already caveats both. Saying it on one branch and not the
        // other is the asymmetry this slice's own D-fix argued against.
        (scan.truncated || scan.tooFreshToJudge > 0 ? ` This count is a floor, not a total.` : ``),
    ...(stranded === 0 ? {} : {
      // A command, at last, and the hold caveat is unconditional rather than computed for the reason
      // `evidence_orphans` gives above: this finding spends no query, so the advice must be true whether
      // or not a hold stands, and the finding that knows is named instead of restated.
      fix: "POST /api/maintenance/reconcile?collect=1 to delete them — unless a legal hold is in force, " +
        "which suppresses collection for the whole organization because an object with no referent is " +
        "unattributable by definition. The legal_holds_active finding says whether one is. Do not delete " +
        "this prefix by hand: that is the same deletion performed without the hold check",
    }),
    receipt: "docs/receipts/evidence-lifecycle.md",
  }];
}

/**
 * Legal hold (#64): what is held, what a hold is failing to enforce, and the lift path that does not exist.
 *
 * ## Why a mechanism with no observable was not an option
 *
 * A hold changes what the Node refuses to destroy and nothing else. It has no screen, and until #64's place
 * route there was no way to make one — so if `doctor` did not report holds, the only evidence a hold existed
 * would be a deletion failing. Three of this month's defects took exactly that shape: a mechanism whose only
 * observable was the failure it caused.
 *
 * ## One query, three findings, and one of them is a gap
 *
 * `holdsForReport` is a single `LEFT JOIN` — one fixed D1 query per run, not one per hold, which is the
 * distinction `doctor-check-cost.md`'s `stale_when` cares about — see its correction headed *"legal hold added
 * a fixed-cost check"*, named that way because three of its corrections share the date 19 August 2026.
 *
 * **The "matter closed but unlifted" finding #64 asked for is deliberately absent**, and this is where that
 * is recorded: there are no matters. #63 charted them and settled that `legal_hold` is one of their types,
 * but nothing builds them, `holds.matter_id` is a nullable TEXT with no table behind it, and a check for a
 * closed matter would have to read a table that does not exist. It arrives with matters.
 *
 * ## Severities
 *
 *   legal_holds_active         `report`. A hold is a normal state of a governed Node, not a fault.
 *   legal_hold_mailbox_missing `degraded`, and only when one exists. A hold naming an absent mailbox is a
 *                              hold enforcing nothing while reporting as active — a false statement about
 *                              preservation, which is the one error class this mechanism may not make. It is
 *                              also **not** reachable through the product: `placeHold` refuses an absent
 *                              mailbox and nothing deletes a mailbox, so this cannot become the permanent
 *                              WARN that `DELIVERY_SILENCE_MS` names and `draft_bodies_stranded` avoids.
 *   legal_hold_lift_path       `report`, `ok: true`, always. `workers_paid_plan` is the precedent for the
 *                              honest shape: a real gap, correctly reported, that no operator action closes.
 *                              Reporting it as a failure would make **every** Node carry a failing finding
 *                              for good, and a check that always fails is a check somebody mutes.
 *
 * ## Disclosure
 *
 * A hold names a mailbox, and the two findings that name one disclose `data` — the reduced report served
 * without authentication promises only names already public in this repository, and a mailbox id is not one.
 * `legal_hold_lift_path` is the exception and it is deliberate: it names no mailbox and no count, because it
 * is a fact about this **build** rather than about this organization, and it must survive into the reduced
 * report for the same reason `workers_paid_plan` does. That is also why it does not vary with the hold count:
 * a finding whose text moved when a hold was placed would leak that a hold exists to an unauthenticated
 * caller.
 */
async function checkHolds(env: Env, ctx: Ctx, orgId: string | null): Promise<Finding[]> {
  const lift: Finding = {
    check: "legal_hold_lift_path",
    severity: "report",
    discloses: "infrastructure",
    ok: true,
    detail:
      "There is no way to lift a legal hold on this Node. #64 decided lifting takes dual approval — one " +
      "stage of two distinct approvers with a mandatory reason — and #61's approval machinery is not built, " +
      "so a hold placed here is permanent until a lift ships. Placing is deliberately the easy half: it " +
      "only ever preserves. Nothing here should grow a single-admin lift, which would contradict #64.",
  };

  if (orgId === null) {
    return [
      {
        check: "legal_holds_active",
        severity: "report",
        discloses: "data",
        ok: true,
        detail: "No organization yet, so no hold can have been placed.",
      },
      lift,
    ];
  }

  const holds = await holdsForReport(env, orgId).catch(() => null);
  if (holds === null) {
    return [
      {
        check: "legal_holds_active",
        // Actionable, and the same condition `migrations_applied` refuses on: a Node that cannot read this
        // table cannot enforce a hold either, and it must not read as "no holds".
        severity: "degraded",
        discloses: "data",
        ok: false,
        detail: "Could not read the holds table, so this report cannot say what is preserved.",
        fix: "check the migrations_applied finding first — a Node that cannot read holds also cannot enforce one",
      },
      lift,
    ];
  }

  const orphaned = holds.filter((hold) => !hold.mailboxExists);
  const day = 24 * 60 * 60 * 1000;
  const scope = (hold: (typeof holds)[number]): string => {
    const age = Math.floor((ctx.now() - new Date(hold.placedAt).getTime()) / day);
    const window = hold.fromDate === null && hold.toDate === null
      ? "all dates"
      : `${hold.fromDate ?? "the beginning"} to ${hold.toDate ?? "ongoing"}`;
    return `${hold.id} on mailbox ${hold.mailboxId}, ${window}, ` +
      `matter ${hold.matterId ?? "none cited"}, placed by ${hold.placedBy} ${age} day(s) ago`;
  };

  const findings: Finding[] = [{
    check: "legal_holds_active",
    severity: "report",
    discloses: "data",
    // A hold is not a fault. What would be a fault is one enforcing nothing, which is the finding below.
    ok: true,
    detail: holds.length === 0
      ? "No legal hold is in force, so nothing suppresses orphan collection."
      : `${holds.length} legal hold(s) in force. Orphan collection is suppressed for the whole ` +
        `organization while any hold stands — an orphan is unattributable by definition, so nothing can ` +
        `prove one is not responsive; they are still enumerated by reconcile and never deleted. ` +
        holds.map(scope).join("; ") + ".",
  }];

  if (orphaned.length > 0) {
    findings.push({
      check: "legal_hold_mailbox_missing",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `${orphaned.length} hold(s) name a mailbox that no longer exists, so they enforce nothing ` +
        `while reporting as active: ${orphaned.map((hold) => `${hold.id} on ${hold.mailboxId}`).join(", ")}.`,
      fix: "this Node cannot reach that state on its own — placing refuses an absent mailbox and nothing " +
        "deletes a mailbox — so either the mailbox row was removed outside the product or the hold was " +
        "inserted outside it. Restore the mailbox row: the hold cannot be lifted (see the " +
        "legal_hold_lift_path finding) and must not be deleted by hand, which would destroy the record of " +
        "what somebody decided to preserve",
    });
  }

  findings.push(lift);
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
 *
 * ## Both names below are the names checks emit, and something checks that
 *
 * This predicate tested `credential_kek` until #70. Nothing in this file has ever emitted that —
 * `checkCredentialKek` emits `credential_key` — so half of the disjunction was permanently false, and the
 * half that was dead was the case the paragraph above was written for: a credential key that cannot wrap
 * while the signing key is fine. `signing_key` is real, so the commonest lockout worked and every test
 * passed. `test/node/doctor-check-names.test.ts` now derives the emitted set from this file and fails on
 * any name referenced here — in this predicate or in a `fix:` that points at "the X finding" — that no
 * check emits, and `test/doctor.test.ts` covers the KEK-alone lockout end to end.
 */
export function authenticationIsImpossible(report: DoctorReport): boolean {
  return report.findings.some(
    (f) => !f.ok && f.severity === "refuse" && (f.check === "credential_key" || f.check === "signing_key"),
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
