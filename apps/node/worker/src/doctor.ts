import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { unwrapCredential, wrapCredential } from "./auth/kek.ts";
import { mintAccessToken, verifyAccessToken } from "./auth/jwt.ts";
import { vault } from "./keyvault.ts";
import { escrowState } from "./recovery.ts";
import { unindexedMessages } from "./search.ts";
import { evaluateBreakers, pausesInForce, RATE_BREAKERS } from "./breakers.ts";
import { deliveryActivity, isPauseReason, publishedButlerState } from "./butler/pause.ts";
import { decidersByMailbox } from "./deciders.ts";
import { holdsForReport } from "./holds.ts";
import { noticeState } from "./notifications.ts";
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
 * The Workers Paid plan (ADR 25). A Worker cannot read its own account's plan, and **nothing else checks
 * it either** — this used to say the check "belongs to `mailda deploy`, which holds an account token", and
 * there was no CLI at all (#80). The one that exists now still cannot: Cloudflare exposes no documented
 * endpoint for an account's Workers plan. Recorded as `report` naming the gap, rather than silently
 * omitted — an absent check reads exactly like a passing one, and a *credited* check reads better than
 * either.
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

  /*
   * Hoisted out of the list below because #66's breaker check **reads its answer** rather than recomputing
   * it: an unarmed rate breaker matters when this Node is sending and hearing nothing back, and is entirely
   * benign on a Node that has simply not sent much. `delivery_visibility` is exactly that predicate, already
   * computed, and a second copy of it would be a second definition of "blind" for the two to disagree about.
   */
  const delivery = await checkDeliveryVisibility(env, ctx, claim?.org_id ?? null);
  const blind = delivery.some((finding) => finding.check === "delivery_visibility" && !finding.ok);

  findings.push(
    ...(await checkSchema(env)),
    ...(await checkEvidenceBucket(env)),
    // Before the evidence-based one, because it says which question this report cannot answer at all, and a
    // reader meeting a blind Node needs that first. Costs no subrequest: it reads nothing.
    sendingEventsConsumerCheck(),
    // Same shape and same zero cost: a capability this Node does not have, stated once.
    butlerExecutionCheck(),
    ...delivery,
    ...(await checkVault(env)),
    ...(await checkCredentialKek(env)),
    ...(await checkSigningKeys(env, ctx)),
    ...(await checkOutbox(env, ctx)),
    ...evidence.findings,
    ...strandedDraftBodyFindings(evidence.draftBodies),
    ...(await checkEvidenceChanged(env, claim?.org_id ?? null)),
    ...(await checkHolds(env, ctx, claim?.org_id ?? null)),
    ...(await checkSelfGrants(env, claim?.org_id ?? null)),
    ...(await checkSupervisionNotices(env, ctx, claim?.org_id ?? null)),
    ...(await checkBreakers(env, ctx, claim?.org_id ?? null, blind)),
    ...(await checkButlerPauses(env, claim?.org_id ?? null)),
    planCheck(),
    ...(await checkTransportAdapters(env)),
    ...(await checkInboundRouting(env, claim?.org_id ?? null)),
    ...(await checkRecoveryEscrow(env, claim?.org_id ?? null)),
    ...(await checkSearchIndex(env, claim?.org_id ?? null)),
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
 * Says what a Butler can do here, which since #50 includes **running**.
 *
 * ## What this check was, and why the sentence had to change rather than stay
 *
 * It used to say that a Butler could be published and could not run, because migration 0027 shipped the
 * store and the checker with no engine. `test/node/butler-execution-world.test.ts` existed to make that
 * sentence fail the day an engine landed — the hazard in a permanently-true `detail` is that it stays in the
 * file long after it stops describing the code, and *nothing looks wrong*: the check still runs, still
 * passes, still reads as verified. The engine has landed, so the sentence is rewritten and that test now
 * asserts the opposite absence: that the binding and the class are both present, and that this text no
 * longer claims otherwise.
 *
 * ## Still `report`, still `ok: true`, and still costing nothing
 *
 * It reports how far this layer is built rather than a fault, so it fails on no Node — `sendingEventsConsumer`
 * is the precedent and the argument is the same: a finding that fails on every Node forever is one somebody
 * mutes. And it asks this Node's tables nothing, so it adds no subrequest to `doctor.max_subrequests_per_run`,
 * whose receipt names exactly that as a staleness clause. A count of runs would be evidence and would also be
 * a new fixed-cost query on every run of `doctor`; the gap being reported is a property of the bundle.
 *
 * ## What is still not built, named here because an operator is entitled to the list
 *
 * The capability ceiling at publication, static taint tracking (#52), the run ledger and its four replay
 * modes (#53), simulation, and every trigger except `mail.received`. Two of those are §16 guarantees this
 * Node does not yet keep, and saying so in the report is the difference between a layer that is honest about
 * its edges and one that lets an absence read as a feature.
 */
function butlerExecutionCheck(): Finding {
  return {
    check: "butler_execution",
    severity: "report",
    // The shape of the bundle and the names of tickets. No organization content, so this survives into the
    // reduced report an unauthenticated locked-out operator sees.
    discloses: "infrastructure",
    ok: true,
    detail:
      "Butlers run on this Node. A published Butler fires when mail arrives at the mailbox its trigger " +
      "names: one generic Workflow interprets the version's frozen AST, and the run's id is the Butler " +
      "version plus the delivery, so the same message cannot start two runs — the platform refuses the " +
      "duplicate. Every effect goes through the same code a person's does, with the **Butler itself** as " +
      "the principal: it holds only the relations an administrator granted to its btl_ id, revoking one " +
      "stops it on the next node, and audit entries name it with actor_kind=butler. A send a Butler " +
      "proposes is sealed awaiting a human release and will not be handed over until somebody who may " +
      "send as that mailbox releases it. Every run leaves a record in butler_runs with one row per effect " +
      "and per refusal. Reserved nodes (llm.*, label, route, archive, quarantine, case.upsert, case.task, " +
      "case.note, connector.*, approval.request, template.render) are refused at publication and refused " +
      "again at run start, so a hand-edited AST cannot execute one. A published version's AST and source " +
      "text are frozen, enforced by database triggers, so the Butler that runs is the exact program that " +
      "was published. A Butler that could not afford to run is also refused: the whole graph is priced " +
      "against one Workflow instance's subrequest pot, which this Node divides at the Workers Paid figure " +
      "of 10,000 because it cannot detect its own plan and ADR 25 requires Paid. On Workers Free the pot " +
      "is 1,000 and every such refusal prints that row too — and the engine re-prices the graph at run " +
      "start with its own overhead added, then meters itself and refuses an effect it cannot afford rather " +
      "than being killed mid-loop. A Butler that re-triggers itself off its own mail is stopped: the run " +
      "record and the manifests it sealed make that chain a join, so a windowed count of self-provoked runs " +
      "latches a pause on the **Butler** — not on a version, so republishing a fixed Butler does not clear " +
      "it — and one administrator resumes it alone with a reason. What is still not built: the capability " +
      "ceiling at publication, static taint tracking (#52), the run ledger and its four replay modes (#53), " +
      "simulation, and every trigger except mail.received.",
  };
}

/**
 * Can this Node see what happened to the mail it sent?
 *
 * A Node cannot receive its own bounces (`cloudflare-email-sending.md`, corrected), so delivery outcomes
 * arrive only on a queue, fed by a Queues event subscription. Two account-level things stand between a
 * hand-over and an observed outcome, and the `sending_events_consumer` finding above names both: the
 * subscription is not in `wrangler.jsonc`, wrangler's CLI cannot create it, and the dashboard's own modal
 * currently throws — so it has to be created through the API (`queue-provisioning.md`), which **no tool in
 * this repository does**: `mailda deploy` attaches the consumer and stops there. And since #72 the consumer
 * is attached out of band too.
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
      fix: "if the vault reports an unknown generation, restore it with POST /api/recovery/redeem — " +
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
 * Sends this Node refused because their stored body no longer hashed to what the manifest recorded (#62).
 *
 * ## Why this exists at all, when the outbox already shows the send
 *
 * Five of the six reasons a dispatch can withhold a send are the system working: authority was withdrawn, a
 * policy tightened, an approval lapsed. The person who wrote the message reads their own outbox row and knows
 * what to do. `evidence_changed` is not that. It means **the archive differs from its own record** —
 * corruption, or tampering — and the person who needs to know is whoever runs the Node, not whoever wrote the
 * message. #62 required a log entry *and* a finding for exactly that reason, and before this there was nothing
 * for `doctor` to read.
 *
 * It is the same claim `evidence_present` makes about inbound mail — a receipt pointing at bytes that are not
 * there — arriving from the other direction: a manifest pointing at bytes that are not the ones it sealed.
 *
 * ## `degraded`, not `refuse`
 *
 * The precedent is `evidence_present`, and the argument is the one this file's header gives: taking a whole
 * mail system offline over damaged evidence helps nobody and does not undamage it. What the Node must not do
 * is *send* those bytes, and it did not — that is the state this finding reads.
 *
 * ## One query, and it costs nothing on a healthy Node
 *
 * `sm_evidence_changed` (migration 0022) is partial on this reason, so on a Node where nothing has ever
 * mismatched the index is empty and this is a seek into nothing rather than a scan of every send the
 * organization has made. That matters because `doctor.max_subrequests_per_run` exists to catch exactly the
 * check that has quietly become proportional to mail volume.
 *
 * Bounded at ten manifests in the detail, and the count is the whole count: an operator needs to know how bad
 * it is and needs enough ids to start, not every id in a paragraph.
 */
async function checkEvidenceChanged(env: Env, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "send_evidence_changed",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so nothing has been sealed and no evidence can have changed.",
    }];
  }

  const affected = await env.CATALOG.prepare(
    // One statement, prepared and executed once: `test/node/doctor-meter-honesty.test.ts` requires that of
    // everything on this path, because the meter here counts prepares rather than executions.
    `SELECT id, state_at, last_error FROM send_manifests
      WHERE org_id = ? AND state_reason = 'evidence_changed' ORDER BY state_at DESC`,
  ).bind(orgId).all<{ id: string; state_at: string; last_error: string | null }>().catch(() => null);

  if (affected === null) {
    return [{
      check: "send_evidence_changed",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: "Could not read the send manifests, so this report cannot say whether stored evidence has "
        + "changed under a send.",
      fix: "check the migrations_applied finding first — a Node that cannot read send_manifests cannot "
        + "dispatch either",
    }];
  }

  if (affected.results.length === 0) {
    return [{
      check: "send_evidence_changed",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No send has been withheld for changed evidence. Every approved send that reached hand-over "
        + "had both stored bodies re-hashed against the manifest first.",
    }];
  }

  const shown = affected.results.slice(0, 10);
  return [{
    check: "send_evidence_changed",
    severity: "degraded",
    discloses: "data",
    ok: false,
    detail: `${affected.results.length} send(s) were withheld because a stored body no longer hashed to what `
      + `the manifest recorded. This is not a policy decision: the archive disagrees with its own record, `
      + `which is corruption or tampering. `
      + shown.map((row) => `${row.id} at ${row.state_at}: ${row.last_error ?? "no reason recorded"}`)
        .join("; ")
      + (affected.results.length > shown.length ? `; and ${affected.results.length - shown.length} more.` : "."),
    fix: "read the send.evidence_changed entries in the operational log for the blob keys and the two hashes, "
      + "then compare the R2 objects against the backup that predates the mismatch. Do not re-dispatch and do "
      + "not overwrite the recorded hash — the manifest is the evidence, and the bytes are what is in doubt",
    receipt: "docs/receipts/dispatch-recheck-cost.md",
  }];
}

/**
 * Legal hold (#64): what is held, what a hold is failing to enforce, and whether anybody could lift it.
 *
 * ## Why a mechanism with no observable was not an option
 *
 * A hold changes what the Node refuses to destroy and nothing else. It has no screen, and until #64's place
 * route there was no way to make one — so if `doctor` did not report holds, the only evidence a hold existed
 * would be a deletion failing. Three of this month's defects took exactly that shape: a mechanism whose only
 * observable was the failure it caused.
 *
 * ## What changed when the lift arrived, and what it cost
 *
 * `legal_hold_lift_path` is **gone**, because its whole content was the sentence *"there is no way to lift a
 * legal hold on this Node"* and that is now false. A finding kept alive by rewriting it into "lifting works"
 * would be a check that always passes and tells an operator nothing they can act on — which is not the same
 * shape as `workers_paid_plan`, the gap it was modelled on: that one names something no operator action can
 * close, and this one named something a ticket closed.
 *
 * What replaces it is a finding about the state that actually traps people. #64's argument was that *a hold
 * nobody can lift is an operational trap*, and with a lift built that trap is computable: a hold over a
 * mailbox where fewer than two people hold `approval.decide` cannot be lifted by anybody, because #64
 * requires two distinct approvers and excludes whoever requested it. `legal_hold_unliftable` says so **before**
 * an administrator finds out by being refused.
 *
 * Cost: `holdsForReport` is still one fixed query per run, and one further query — `decidersByMailbox`, the
 * single definition of who may decide — is spent **only when a hold is in force**. Three holds still cost what
 * one hold costs, which is the distinction `doctor-check-cost.md`'s `stale_when` separates, and that receipt
 * carries the measured delta.
 *
 * **The "matter closed but unlifted" finding #64 asked for is still deliberately absent**, and the reason is
 * unchanged rather than newly convenient: there are no matters. #63 charted them and settled that `legal_hold`
 * is one of their types, but nothing builds them, `holds.matter_id` is a nullable TEXT with no table behind
 * it, and a check for a closed matter would have to read a table that does not exist. Now that lifting works,
 * the finding it would produce is *actionable* rather than rhetorical — so it arrives with matters, and this
 * paragraph is what stops it being silently dropped in the meantime.
 *
 * ## Severities
 *
 *   legal_holds_active         `report`. A hold is a normal state of a governed Node, not a fault.
 *   legal_hold_lift_pending    `report`, and only when one is open. Somebody is being asked to re-permit
 *                              destruction; that is a normal act with a normal answer, and the reason it was
 *                              asked for is in the detail because that is the fact a reader needs.
 *   legal_hold_mailbox_missing `degraded`, and only when one exists. A hold naming an absent mailbox is a
 *                              hold enforcing nothing while reporting as active — a false statement about
 *                              preservation, which is the one error class this mechanism may not make. It is
 *                              also **not** reachable through the product: `placeHold` refuses an absent
 *                              mailbox and nothing deletes a mailbox, so this cannot become the permanent
 *                              WARN that `DELIVERY_SILENCE_MS` names and `draft_bodies_stranded` avoids.
 *   legal_hold_unliftable      `degraded`, and only when a hold in force has too few eligible approvers. It
 *                              has a fix somebody can run, which is what separates it from a permanent WARN:
 *                              grant `approval.decide` to two people who are not the requester.
 *
 * ## Disclosure
 *
 * Every finding here names a mailbox or a hold id and therefore discloses `data`: the reduced report served
 * without authentication promises only names already public in this repository, and a mailbox id is not one.
 * That is a change — `legal_hold_lift_path` was the one `infrastructure` finding in this group, and it earned
 * that by being a fact about the **build** rather than about the organization. Nothing that survives it is,
 * so nothing here reaches the unauthenticated report, and a Node that cannot authenticate anybody reports no
 * holds at all. Stated because it is a real reduction in what a locked-out operator can see, and the
 * alternative — a finding whose text moved when a hold was placed — would leak that a hold exists.
 */
async function checkHolds(env: Env, ctx: Ctx, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "legal_holds_active",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so no hold can have been placed.",
    }];
  }

  const holds = await holdsForReport(env, orgId).catch(() => null);
  if (holds === null) {
    return [{
      check: "legal_holds_active",
      // Actionable, and the same condition `migrations_applied` refuses on: a Node that cannot read this
      // table cannot enforce a hold either, and it must not read as "no holds".
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: "Could not read the holds table, so this report cannot say what is preserved.",
      fix: "check the migrations_applied finding first — a Node that cannot read holds also cannot enforce one",
    }];
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

  // Nothing below has anything to say about a Node with no holds, and the eligibility query at the end costs
  // a subrequest. So a clean Node pays for `holdsForReport` and nothing else — the same shape
  // `draft_bodies_stranded` uses to spend nothing on an unclaimed Node.
  if (holds.length === 0) return findings;

  const pending = holds.filter((hold) => hold.pendingLift !== null);
  if (pending.length > 0) {
    findings.push({
      check: "legal_hold_lift_pending",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: `${pending.length} lift request(s) waiting on two distinct approvers: ` +
        pending.map((hold) =>
          `${hold.id} on mailbox ${hold.mailboxId}, requested by ${hold.pendingLift?.requestedBy} ` +
          `(approval ${hold.pendingLift?.approvalId}), reason: ${hold.pendingLift?.reason}`).join("; ") +
        ". The hold is still in force until the last stage closes.",
      // Not a fault and not an instruction: whether to approve is the approvers' judgement, and doctor
      // pointing at the queue is the whole of its business here.
      fix: "the people holding approval.decide on that mailbox see it at GET /api/approvals and decide with " +
        "POST /api/approvals/:id/decide — the requester cannot be one of them (§18)",
    });
  }

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
        "inserted outside it. Restore the mailbox row rather than deleting the hold by hand, which would " +
        "destroy the record of what somebody decided to preserve. Lifting it needs two approvers holding " +
        "approval.decide on a mailbox that is not there, which is why the legal_hold_unliftable finding is " +
        "the one to read next",
    });
  }

  /*
   * Can anybody actually lift these? #64's operational trap, computed rather than warned about.
   *
   * One query for the whole organization — `decidersByMailbox` is the single definition of who may decide, and
   * duplicating its team-resolving UNION here to save nothing would be the second copy of an eligibility
   * computation this repository has already refused once (0021). Spent only when a hold is in force, so a Node
   * with no holds pays nothing, and it does not grow with the number of holds.
   *
   * The arithmetic is deliberately the pessimistic one: a lift needs two approvers **who did not request it**,
   * and the requester is any `org.admin`. So two holders are enough only if neither of them is the person who
   * asks. Reporting "fewer than two holders" as the trap and naming the requester rule in the fix is honest
   * without pretending to know who will ask.
   */
  const eligible = await decidersByMailbox(env, orgId).catch(() => null);
  if (eligible === null) {
    findings.push({
      check: "legal_hold_unliftable",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: "Could not read who holds approval.decide, so this report cannot say whether these holds can " +
        "be lifted.",
      fix: "check the migrations_applied finding first",
    });
    return findings;
  }

  const stuck = holds.filter((hold) => (eligible.get(hold.mailboxId)?.size ?? 0) < 2);
  if (stuck.length > 0) {
    findings.push({
      check: "legal_hold_unliftable",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `${stuck.length} hold(s) in force cannot be lifted by anybody: ` +
        stuck.map((hold) =>
          `${hold.id} on mailbox ${hold.mailboxId}, where ${eligible.get(hold.mailboxId)?.size ?? 0} ` +
          "person(s) hold approval.decide").join("; ") +
        ". A lift takes two distinct approvers and excludes whoever requested it (#64), so this hold is " +
        "permanent until somebody is granted the relation. Preservation is unaffected — the failure " +
        "direction is over-holding.",
      fix: "grant approval.decide on those mailboxes to at least two people who will not be the one " +
        "requesting the lift — POST /api/access/grant with {\"relation\":\"approval.decide\"} — then " +
        "POST /api/holds/:id/lift with a reason",
    });
  }

  return findings;
}

/**
 * The self-grant, made visible (#63, §7).
 *
 * ## What this finding is about, and what it deliberately does not claim
 *
 * §7 says *"mailbox administration alone does not imply content access"*. On this Node that is true about the
 * **relation** and false about the **administrator**: `org.admin` can grant any grantable relation to any
 * subject including itself, so an administrator can give themselves `mailbox.content.read` on any mailbox in
 * one audited call. #63 decided not to close that, and the reasoning is worth carrying here because this is
 * where somebody will come looking for the rule they expect to find: refusing a grant where actor and subject
 * match traps a two-person organization, where the only other approver is the person being examined — and
 * "impossible" for an administrator genuinely responsible for a mailbox is the wall that gets solved by
 * editing the database directly, which is strictly worse than an audited self-grant.
 *
 * So there are two doors and this finding is what makes them look different:
 *
 *   `supervised.read`   the front door. Matter, scope, expiry, two approvers who are not the reader, and a
 *                       `supervised.granted` entry saying all of it.
 *   the self-grant      still open, and now conspicuous.
 *
 * **This does not prevent an administrator from reading mail, and it does not try to.** It makes the
 * difference between the front door and the back door visible in the record. Written down here rather than
 * left implied, because a finding whose text suggested it *stopped* something would be exactly the claim
 * nothing enforces.
 *
 * ## `report`, not `degraded`, and this was the hard call
 *
 * `degraded` means *something is wrong here*, and a self-grant is not by itself wrong: the two-person
 * organization above is the case #63 kept the door open for, and in it the self-grant is the **correct** act.
 * A `degraded` on a legitimate act is the permanent WARN that `DELIVERY_SILENCE_MS` names in this same file —
 * a false alarm gets a check muted, and a muted check guards nothing. `workers_paid_plan` is the precedent for
 * the shape: a real fact, correctly reported, that no operator action can or should close. `draft_bodies_
 * stranded` reached the same answer from the other side.
 *
 * The thing that *would* justify `degraded` is a self-grant on a mailbox where a supervised read **was**
 * available — two other `approval.decide` holders existed and the front door was walked past. That is
 * computable, and it is not computed here for an honest reason: eligibility is live, so it would be measured
 * now rather than at the instant of the grant, and a finding that changed its verdict about a past act because
 * somebody joined the team is worse than one that reports the act plainly.
 *
 * ## `data`, and one query that costs nothing on a clean Node
 *
 * The detail carries a count and an instant derived from this organization's audit trail — so it never
 * reaches the unauthenticated report. The query is one statement and it rides `audit_by_action` (0008),
 * seeking straight to this organization's `access.granted` entries and applying the actor-equals-subject test
 * over those, so its cost is proportional to **grants made** rather than to how long the Node has been
 * running. That distinction is what `doctor.max_subrequests_per_run` exists to protect.
 *
 * Migration 0023 first carried a purpose-built partial index for this, keyed on the condition itself.
 * **SQLite never chose it**, and forced with `INDEXED BY` it was worse — usable on `org_id` alone, because
 * SQLite's test for whether a query implies a partial index's predicate does not credit a column-to-column
 * comparison. It was deleted rather than left as dead weight under a comment claiming it was load-bearing.
 * The plan is printed in `test/explain.test.ts`, which is where that was found.
 *
 * The finding deliberately does **not** name each entry. Audit entries are never trimmed, so a detail listing
 * every self-grant over a Node's life would grow without bound inside a bounded `detail` column. The entries
 * are in the trail, filtered by action and actor.
 */
async function checkSelfGrants(env: Env, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "self_granted_access",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so nobody can have granted themselves anything.",
    }];
  }

  const row = await env.CATALOG.prepare(
    // One statement, prepared and executed once: `test/node/doctor-meter-honesty.test.ts` requires that of
    // everything on this path, because the meter in this file counts prepares rather than executions.
    `SELECT COUNT(*) AS n, MAX(at) AS last FROM audit_entries
      WHERE org_id = ? AND action = 'access.granted' AND actor_user_id = subject`,
  ).bind(orgId).first<{ n: number; last: string | null }>().catch(() => null);

  if (row === null) {
    return [{
      check: "self_granted_access",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: "Could not read the audit trail, so this report cannot say whether anybody has granted "
        + "themselves access to a mailbox.",
      fix: "check the migrations_applied finding first — a Node that cannot read audit_entries cannot record "
        + "an act either",
    }];
  }

  const count = row.n ?? 0;
  return [{
    check: "self_granted_access",
    severity: "report",
    discloses: "data",
    // `ok` says "nothing to look at", not "nothing is wrong". A self-grant is reported, not faulted — see the
    // header for why a `degraded` here would be the permanent WARN this file avoids elsewhere.
    ok: count === 0,
    detail: count === 0
      ? "Nobody has granted a relation to themselves. Every relation in force was granted by one person to "
        + "another, and reading a mailbox you hold nothing on goes through a supervised read with two "
        + "approvers (§7)."
      : `${count} access.granted entr${count === 1 ? "y" : "ies"} where the actor and the subject are the `
        + `same principal, most recently at ${row.last ?? "an unrecorded instant"}. An administrator granting `
        + `themselves a relation is a single audited call and it is not blocked: refusing it would trap a `
        + `two-person organization into seeking approval from the person being examined. This finding does `
        + `not prevent an administrator reading mail — it makes the front door and the back door `
        + `distinguishable in the record.`,
    ...(count === 0 ? {} : {
      fix: "read them in the trail — GET /api/audit filtered on access.granted — and check each was the "
        + "shortest path available. The front door is POST /api/supervised: a time-boxed read with a matter, "
        + "a scope and two approvers who are not the reader, which produces a defensible record where a "
        + "self-grant produces only this finding. Nothing here needs undoing if the self-grant was the right "
        + "call; if it was not, POST /api/access DELETE revokes the relation and §7 makes that effective on "
        + "the next request",
    }),
  }];
}

/**
 * Is this Node discharging §7's notification obligation? (#63 part B.)
 *
 * ## This is the check the whole mechanism was chosen for
 *
 * #63 rejected a Workflow instance and a Durable Object alarm for the notice, and the deciding argument was
 * about *this function*: **`doctor` can count rows and cannot see inside a sleeping instance.** An instance
 * culled by retention and one patiently waiting look identical from outside, so a report built on one could
 * only ever say "we started something". A row that is due and undelivered is a number.
 *
 * Two findings, from **one** statement — `doctor-meter-honesty.test.ts` requires every `prepare` on this path
 * to be executed exactly once, because the meter in this file counts prepares.
 *
 * ## `supervision_notices_overdue` is `degraded`, unlike `self_granted_access`
 *
 * The hard call one function up went the other way, and the difference is what makes both defensible. A
 * self-grant can be the **correct** act in a two-person organization, so faulting it would be the permanent
 * WARN this file avoids elsewhere. An overdue notice cannot be correct: the row says the obligation fell due
 * and the scan has not discharged it, which means the cron is not running, or it is failing, and both are
 * things an operator must fix. The `fix` names the log event the scan writes when it fails.
 *
 * ## `supervision_notice_missing` is the one that makes suppression loud
 *
 * Every notice row was inserted in the same transaction as the `supervised.granted` entry that records the
 * grant taking effect. So the two counts agree unless somebody removed one of them — and the audit side is
 * hash-linked, so removing *that* half breaks `verifyChain` at a nameable point. Deleting the row instead
 * shows up here. **Neither half can be removed quietly**, which is the property §7's "cannot be disabled by
 * the investigator" needs and which no timer can offer.
 *
 * It is deliberately a comparison of counts rather than a per-grant join. A join would name which grant lost
 * its notice, and would cost a query proportional to grants rather than a scalar; the count answers the
 * question the finding exists to ask — *has anything been removed* — and the trail answers the next one.
 * `refuse` would be wrong too: a Node in this state still refuses unauthorized reads, and refusing to start
 * over a governance discrepancy would take mail down for a records problem.
 *
 * ## `supervision_notice_stranded` is the third, and it exists because the pair above has a blind spot
 *
 * Both checks above are about a row being **removed**. Neither can see a row that is present and *inert*: a
 * notice with no due date whose matter has already closed is one nothing will ever deliver, and it passes the
 * missing-notice count (the row is there) and the overdue count (which is `due_at IS NOT NULL` by
 * construction). That was a real, reachable state until `noticeOwedByGrant` grew its already-closed arm —
 * reached by closing a matter while the grant citing it was still waiting for its second approver, which the
 * investigator can arrange for themselves — so the check is here to keep the repair honest rather than to
 * describe a hypothesis.
 */
async function checkSupervisionNotices(env: Env, ctx: Ctx, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "supervision_notices_overdue",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so nobody's mail can have been read under supervision.",
    }];
  }

  const state = await noticeState(env, ctx, orgId);
  if (state === null) {
    return [{
      check: "supervision_notices_overdue",
      // The same condition `legal_holds_active` degrades on, for the same reason: a Node that cannot read the
      // table cannot deliver from it either, and this must not read as "nothing is owed".
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: "Could not read the notifications table, so this report cannot say whether §7's notices to the "
        + "people whose mail was read have been delivered.",
      fix: "check the migrations_applied finding first — a Node that cannot read notifications cannot deliver "
        + "one either, and the obligation does not lapse because the table is unreachable",
    }];
  }

  const findings: Finding[] = [{
    check: "supervision_notices_overdue",
    severity: "degraded",
    discloses: "data",
    ok: state.overdue === 0,
    detail: state.overdue === 0
      ? "No notification is due and undelivered. §7's notices to the people whose mail was read are dated "
        + "when the matter closes — or when the grant expires, if it cited no matter — and delivered by the "
        + "one-minute cron into those people's own interface."
      : `${state.overdue} notification(s) fell due and have not been delivered, the oldest at `
        + `${state.oldestOverdueDueAt ?? "an unrecorded instant"}. Each one is a person who has not been told `
        + `their mail was read, or somebody who has not been told they are being asked to decide something.`,
    ...(state.overdue === 0 ? {} : {
      fix: "the delivering scan runs on this Worker's scheduled trigger every minute. Check GET /api/log for "
        + "notifications.scan_failed, and confirm the cron trigger exists on this Worker — a Node deployed "
        + "without one accrues these silently and this finding is the only thing that says so",
    }),
    receipt: "docs/receipts/supervised-notice-scan.md",
  }];

  if (state.stranded > 0) {
    findings.push({
      check: "supervision_notice_stranded",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `${state.stranded} notification(s) have no due date and cite a matter that has already closed, `
        + "so they can never fall due and nobody will be told their mail was read. This Node writes a due "
        + "date on both orderings — when the matter closes, and when a grant takes effect under a matter that "
        + "is already closed — so it cannot produce this state.",
      fix: "read the supervised.granted entries for the grants these notices name (GET /api/audit) — they "
        + "carry the mailbox, the scope, the matter and the deadline. Do not clear the rows: a notice that "
        + "cannot fall due is an obligation this Node still owes, and deleting it removes the only evidence "
        + "that it does",
    });
  }

  if (state.noticesOwed < state.grantsRecorded) {
    findings.push({
      check: "supervision_notice_missing",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `The trail records ${state.grantsRecorded} supervised grant(s) taking effect and this Node holds `
        + `${state.noticesOwed} notification(s) for them. Every notice is written in the same transaction as `
        + `the grant, so this Node cannot produce that difference: ${state.grantsRecorded - state.noticesOwed} `
        + `row(s) were removed outside the product.`,
      fix: "do not re-create the rows by hand — a notice minted now would carry a due date nobody decided. "
        + "Run the audit verification (GET /api/audit) to see whether the trail itself was edited too, then "
        + "read the supervised.granted entries: they name the grant, the mailbox, the scope, the matter and "
        + "the deadline, which is what the missing notices were going to say",
    });
  }

  return findings;
}

/**
 * Can this Node's circuit breakers see anything, and is anything currently stopping mail? (#66)
 *
 * ## Why a breaker needs a check at all
 *
 * A rate breaker keeps **no state**: it is a windowed `COUNT(*)` re-asked on every send. That is the property
 * that makes it impossible to leave un-armed by accident, and it is also what makes it **invisible** — there
 * is no row anywhere saying whether the thing is working, and a tripped breaker nobody can see is the failure
 * shape this repository has now hit repeatedly. So the readings are reported here, on every claimed run,
 * whether or not anything is over.
 *
 * ## `armed: false, reason: no_observations` rather than a reassuring 0%
 *
 * This is the whole reason the check is not one line. A bounce-rate breaker reading **0%** because the
 * delivery channel is dead is the silent failure the breakers exist to prevent, and `doctor` already computes
 * that exact predicate one function up: `delivery_visibility` fails when hand-overs old enough to have been
 * answered have produced no attributed events at all. A Node in that state has a bounce breaker that will
 * never fire and a report that says everything is fine.
 *
 * So an under-observed rate reports `armed: false` with the reason, and the finding is **degraded** rather
 * than `ok` — not because the Node is broken, but because a governance control that cannot fire is a control
 * nobody should be relying on, and `report`/`ok: true` is how somebody comes to.
 *
 * **Failing closed on no observations was rejected**, and the reason is short: a Node that has never sent
 * anything has no observations, so failing closed means a new Node refuses to send. That is worse than the
 * thing it protects against.
 *
 * ## Two findings, because they answer different questions
 *
 * `send_breakers` is *can this Node see, and is anything over*. `domain_paused` is *is a human decision
 * currently stopping a customer's mail* — which is not a fault at all, and is `degraded` anyway: mail is not
 * leaving, somebody has to know, and the pause's own reason and age are what they need. §5C's rule against
 * collapsing distinct states applies with more force in a diagnostic than anywhere else.
 *
 * Costs **one** subrequest on a clean Node and two when a pause exists — the rate statement, plus the pause
 * listing only when the first said something is paused. `doctor-check-cost.md`'s `stale_when` names "any new
 * fixed-cost check", and this is one.
 */
async function checkBreakers(
  env: Env,
  ctx: Ctx,
  orgId: string | null,
  blind: boolean,
): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "send_breakers",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so nothing has been sent and there is nothing to rate.",
    }];
  }

  // No domain: `doctor` asks the rate questions and not the pause one, because "is this domain paused" needs
  // a domain and a report about every domain is the second statement below.
  const decision = await evaluateBreakers(env, ctx, orgId, null).catch(() => null);
  if (decision === null) {
    return [{
      check: "send_breakers",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "Could not read the tables the send breakers count over, so this Node cannot say whether they "
        + "would fire.",
      fix: "check the migrations_applied finding first",
    }];
  }

  const unarmed = decision.rates.filter((rate) => !rate.armed);
  const tripped = decision.rates.filter((rate) => rate.tripped);
  /*
   * **When an unarmed breaker is a fault, and when it is just a quiet Node.** This is the line the whole
   * check turns on, and getting it wrong in either direction is a documented failure of this file.
   *
   * `ok: false` on every unarmed breaker would fail on every freshly deployed Node, for ever, until somebody
   * sent a few hundred messages — and `DELIVERY_SILENCE_MS` names the consequence three hundred lines up: a
   * finding that fails on every Node forever is one somebody mutes, and a muted check is worse than no check
   * because it still reads as verified.
   *
   * `ok: true` on every unarmed breaker is the opposite failure and the one #66 exists to prevent: a Node
   * whose event subscription was never created hears nothing, so its bounce breaker has no denominator and
   * can never fire — and the report would say so in a sentence nobody reads while the verdict stays green.
   *
   * The discriminator is `blind`, which is `delivery_visibility`'s own predicate: hand-overs old enough to
   * have been answered, none of them observed, and **zero attributed events ever**. A Node that is sending
   * and hearing nothing has breakers that cannot fire; a Node that has not sent has breakers with nothing to
   * rate yet. Same reading, two different facts, and §5C's rule against collapsing them applies hardest in a
   * diagnostic.
   */
  const cannotFire = blind && unarmed.length > 0;
  const findings: Finding[] = [{
    check: "send_breakers",
    // `degraded` when something is wrong, `report` when the readings are simply a fact worth printing. The
    // severity moves with the finding rather than being fixed, because a permanent WARN is the muted check.
    severity: cannotFire || tripped.length > 0 ? "degraded" : "report",
    discloses: "data",
    ok: !cannotFire && tripped.length === 0,
    detail: decision.rates.map((rate) => {
      const window = `${Math.round(rate.windowSeconds / 60)}m`;
      if (!rate.armed) {
        return `${rate.breaker}: armed=false (${rate.unarmedReason}) — ${rate.observations} observation(s) `
          + `in ${window}, and this breaker needs more before a rate means anything. It is NOT 0%.`;
      }
      const at = rate.percent === null ? `${rate.observed}` : `${rate.percent}% of ${rate.observations}`;
      return `${rate.breaker}: armed=true, at ${at} against ${rate.limit} in ${window}`
        + (rate.tripped ? " — OVER, sends are gating" : "");
    }).join(" | "),
    ...(!cannotFire && tripped.length === 0 ? {} : {
      fix: tripped.length > 0
        ? "sends are being gated to awaiting and will go when the window clears — nobody has to clear them. "
          + "Read the outbox for the exact figure and the time remaining, and find out what is being sent "
          + `before raising ${tripped.map((rate) => RATE_BREAKERS[rate.breaker].limitBudget).join(", ")}`
        : "these breakers cannot fire, and the cause is the one delivery_visibility above is reporting: this "
          + "Node has handed mail over and received no delivery outcome it could attribute, so the rates "
          + "have no denominator. Fix the event subscription and the consumer — the fix on that finding "
          + "names both — and these arm themselves as outcomes start arriving. Nothing here needs resetting",
    }),
    receipt: "docs/receipts/send-breakers.md",
  }];

  // The second statement, and only when the first says there is one to describe — `pausedDomains` is a
  // seventh sub-select on a statement already being issued, so asking costs nothing. A listing on every run
  // would spend a subrequest on every Node to report nothing on almost all of them.
  if (decision.pausedDomains > 0) {
    const paused = await pausesInForce(env, orgId);
    findings.push({
      check: "domain_paused",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: paused.map((pause) =>
        `${pause.domain} has been paused since ${pause.placedAt} (${pause.pauseId}): "${pause.reason}"`,
      ).join(" | "),
      fix: "no send from these domains is leaving. Any one administrator can restart a domain alone — "
        + `POST /api/domain-pauses/${paused[0]!.pauseId}/lift — because the harm of a wrongly paused domain `
        + "grows every minute it stands. Placing one took two administrators; lifting takes one",
      receipt: "docs/receipts/send-breakers.md",
    });
  }

  return findings;
}

/**
 * Is a Butler stopped, has one gone quiet, and can the loop detector see anything at all? (#75)
 *
 * ## Three findings, because a paused Butler's observable is **silence**
 *
 * #66's rate breakers gate a *send*, and a gated send is a row somebody can look at. A Butler pause stops a
 * *Butler*, and what that produces is **no runs** — which is exactly what a Butler nothing has triggered
 * produces, and exactly what a Butler whose trigger names a mailbox that was renamed produces. Silence is
 * what `doctor` exists to distinguish from health, so all three questions are asked:
 *
 *   butler_paused           is a human decision — or in this case a machine one — currently stopping a Butler
 *   butler_run_silence      has a published Butler produced no runs while mail was arriving at the address
 *                           its trigger names
 *   butler_loop_detection   can the loop detector fire at all, or is it reading zero because it is blind
 *
 * ## `butler_run_silence` is the hard one, and this is what makes it answerable
 *
 * From `butler_runs` alone, *stopped* and *never triggered* are the same reading — the `no_observations` shape
 * `checkBreakers` names one function up. What separates them is whether **mail arrived at the address the
 * trigger names**, and both halves of that are available: the address is in the frozen AST (parsed, never
 * projected into a column, for `triggerButlers`' reason), and the arrivals are one grouped read of
 * `ingress_receipts`.
 *
 * So the answer is a real one rather than a hedge:
 *
 *   mail arrived after publication, no runs   **degraded** — it should have run and did not
 *   no mail arrived after publication         **report** — nothing has triggered it, which is not a fault
 *   the stored AST will not parse             **degraded** — it can never run, and `triggerButlers` agrees
 *
 * Anchored on `published_at` rather than on a window, deliberately: a window would need a figure for *"how
 * long may a Butler legitimately go without running"*, and a Butler on a quiet mailbox may honestly go a
 * month. Publication is an instant this schema already records.
 *
 * **A paused Butler is excluded from that count**, because its silence is explained and reporting it twice
 * would make the second finding fire on every Node with a pause — a permanent WARN is the muted check
 * `DELIVERY_SILENCE_MS` names three hundred lines up.
 *
 * ## Cost: one statement, two when this Node has a Butler
 *
 * The pause fields, the run counts and both visibility figures are sub-selects on one read of published
 * versions. The delivery activity is a second statement, issued only when that read found something — the
 * mechanism `checkBreakers` uses for its pause listing, and what keeps this whole feature at **+1** on a Node
 * with no Butlers. Measured: `docs/receipts/butler-pause.md`, and `doctor-check-cost.md`'s `stale_when` names
 * "any new fixed-cost check", which this is.
 */
async function checkButlerPauses(env: Env, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "butler_paused",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so there are no Butlers to pause.",
    }];
  }

  const report = await publishedButlerState(env, orgId).catch(() => null);
  if (report === null) {
    return [{
      check: "butler_paused",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "Could not read butler_pauses or butler_versions, so this Node cannot say whether any Butler "
        + "is stopped.",
      fix: "check the migrations_applied finding first",
    }];
  }

  const findings: Finding[] = [];
  const stopped = report.butlers.filter((butler) => butler.paused !== null);

  findings.push({
    check: "butler_paused",
    severity: stopped.length === 0 ? "report" : "degraded",
    discloses: "data",
    ok: stopped.length === 0,
    detail: stopped.length === 0
      ? `${report.butlers.length} published Butler(s), none paused.`
      : stopped.map((butler) =>
        `${butler.butlerName} (${butler.butlerId}) paused since ${butler.paused!.placedAt} `
        + `(${butler.paused!.pauseId}, ${butler.paused!.reason}`
        // A stored reason this build does not declare. Named rather than rendered as though it were
        // understood: a `butler_pauses` row is data, and the row that says a Butler is stopped for a reason
        // nobody can look up is exactly the one an operator must be told about.
        + `${isPauseReason(butler.paused!.reason) ? "" : " — NOT a reason this build declares"}) `
        + `by delivery ${butler.paused!.trippedBy}: "${butler.paused!.detail}"`,
      ).join(" | "),
    ...(stopped.length === 0 ? {} : {
      fix: "these Butlers start no runs, and mail into their mailboxes is arriving unautomated — it is still "
        + "filed, still visible and still answerable by hand, which is why this is degraded rather than "
        + `refuse. One administrator resumes one alone, with a reason: POST /api/butler-pauses/`
        + `${stopped[0]!.paused!.pauseId}/resume with {"reason":"..."}. **Publishing a new version does not `
        + "resume it** — the pause is keyed on the Butler, deliberately, so that fixing a looping Butler and "
        + "deciding it is safe to run again are two separate acts",
    }),
    receipt: "docs/receipts/butler-pause.md",
  });

  if (report.butlers.length === 0) {
    // No Butlers, so no silence to explain and nothing that could loop. The second statement is not issued.
    return findings;
  }

  const activity = await deliveryActivity(env, orgId, earliest(report.butlers)).catch(() => null);
  findings.push(silenceFinding(report.butlers, activity));
  findings.push(loopDetectionFinding(report.visibility));
  return findings;
}

/** The earliest publication among live Butlers: the epoch the delivery scan is bounded by. */
function earliest(butlers: readonly { publishedAt: string | null }[]): string {
  const dates = butlers.map((butler) => butler.publishedAt).filter((at): at is string => at !== null);
  // No `published_at` anywhere means a hand-written row, since `publishButler` always writes one. The epoch
  // is then the beginning of time rather than now: an unbounded scan is the honest fallback, because a bound
  // of "now" would report every Butler as never triggered.
  return dates.length === 0 ? "0000" : dates.sort()[0]!;
}

/**
 * A published Butler that has produced no runs since it went live, and whether that is a fault.
 *
 * `activity` is `null` when the delivery scan failed, and that is reported rather than assumed benign: the
 * whole point of the second statement is to be the discriminator, so without it the honest answer is *this
 * check cannot tell* and not *nothing is wrong*.
 */
function silenceFinding(
  butlers: readonly Awaited<ReturnType<typeof publishedButlerState>>["butlers"][number][],
  activity: Awaited<ReturnType<typeof deliveryActivity>> | null,
): Finding {
  if (activity === null) {
    return {
      check: "butler_run_silence",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "Could not read the deliveries a Butler's trigger would have matched, so this Node cannot tell "
        + "a Butler that stopped running from one nothing has triggered.",
      fix: "check the migrations_applied finding first",
    };
  }

  const lastAt = new Map(activity.map((row) => [row.address, row.lastAt]));
  const quiet: string[] = [];
  const idle: string[] = [];
  const unreadable: string[] = [];

  for (const butler of butlers) {
    // A paused Butler's silence is explained by the finding above, and saying it twice would make this one
    // fail on every Node with a pause — a permanent WARN is a muted check.
    if (butler.paused !== null) continue;
    if (butler.triggerMailbox === null) {
      unreadable.push(`${butler.butlerName} (${butler.versionId})`);
      continue;
    }
    if (butler.runsSincePublished > 0) continue;
    const arrived = lastAt.get(butler.triggerMailbox) ?? null;
    if (arrived !== null && (butler.publishedAt === null || arrived >= butler.publishedAt)) {
      quiet.push(`${butler.butlerName} (${butler.butlerId}) listens on ${butler.triggerMailbox}, which last `
        + `received mail at ${arrived}, and has produced no run since it was published at `
        + `${butler.publishedAt ?? "an unrecorded time"}`);
    } else {
      idle.push(`${butler.butlerName} on ${butler.triggerMailbox}`);
    }
  }

  const broken = [...quiet, ...unreadable.map((one) => `${one}: its stored AST will not parse`)];
  return {
    check: "butler_run_silence",
    severity: broken.length === 0 ? "report" : "degraded",
    discloses: "data",
    ok: broken.length === 0,
    detail: broken.length > 0
      ? broken.join(" | ")
      : idle.length === 0
        ? "Every published Butler has run since it was published."
        : `${idle.length} published Butler(s) have not run, and no mail has arrived at the addresses their `
          + `triggers name since they were published — nothing has triggered them, which is not a fault: `
          + idle.join(", "),
    ...(broken.length === 0 ? {} : {
      fix: "mail arrived at the address these Butlers listen on and no run started, so this is not a quiet "
        + "mailbox. Three causes, in the order they are worth checking: the trigger's mailbox no longer "
        + "matches any address on this Node (compare it against GET /api/mailboxes — the comparison is "
        + "case-insensitive and trimmed and nothing else); the stored AST will not parse, which this detail "
        + "names when it is the cause; or the outbox is not being swept, which the outbox finding above "
        + "reports. GET /api/butler-runs shows what did run",
    }),
    receipt: "docs/receipts/butler-pause.md",
  };
}

/**
 * Can the loop detector fire at all? (#75)
 *
 * `checkBreakers`' `no_observations` reasoning, one layer along and with a different denominator. The causal
 * link the detector counts on is `messages.in_reply_to` matching a manifest this Node authored, so a Node
 * whose correspondents never set `In-Reply-To` — or whose inbound headers do not parse — has a loop detector
 * that reads zero for ever and cannot fire. Reporting that as *"no loops"* is the reassuring-zero failure the
 * whole breaker mechanism exists to refuse.
 *
 * **`degraded` only when there is something that could be looping**, which is the line `checkBreakers` draws
 * with `blind` and for the same reason: `ok: false` on every Node with no threaded inbound would fail on every
 * freshly installed Node for ever, and a finding that always fails is one somebody mutes. A Butler has to have
 * proposed at least one send before an unseen reply to it is possible at all.
 */
function loopDetectionFinding(visibility: { threadedInbound: number; butlerSends: number }): Finding {
  const armed = visibility.threadedInbound > 0;
  const couldLoop = visibility.butlerSends > 0;
  const blind = !armed && couldLoop;
  return {
    check: "butler_loop_detection",
    severity: blind ? "degraded" : "report",
    discloses: "data",
    ok: !blind,
    detail: armed
      ? `armed=true — ${visibility.threadedInbound} inbound message(s) carry an In-Reply-To this Node can `
        + `read, and Butlers have proposed ${visibility.butlerSends} send(s). A reply to one of those is `
        + "traceable back to it, which is what the detector counts."
      : `armed=false (no_threaded_replies) — no inbound message on this Node carries an In-Reply-To, and `
        + `Butlers have proposed ${visibility.butlerSends} send(s). The loop detector matches an inbound `
        + "In-Reply-To against a manifest this Node authored, so it is reading zero because it cannot see, "
        + "not because there is no loop. It is NOT a clean bill of health.",
    ...(blind ? {
      fix: "a Butler has proposed mail and nothing coming back is threaded, so a reply provoked by that mail "
        + "would be invisible to the loop detector. Check that inbound mail is being parsed at all — a "
        + "message whose headers could not be read carries parse_error and no In-Reply-To — and read "
        + "docs/receipts/butler-pause.md, which records this blindness as the named absence rather than "
        + "pretending the detector is total. What still bounds a runaway Butler meanwhile is the volume "
        + "breaker on its sends and the per-run subrequest guard",
    } : {}),
    receipt: "docs/receipts/butler-pause.md",
  };
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
async function checkTransportAdapters(env: Env): Promise<Finding[]> {
  const { restConfigured } = await import("./outbound/rest-transport.ts");
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

/**
 * Whether this Node's keys can be recovered if its Durable Object storage is lost (#92, ADR 28/29).
 *
 * ## Why this is the finding that matters most on this report
 *
 * `keyvault.ts` calls that storage the crown jewels and says losing it makes every message permanently
 * unreadable. Every other check here reports something recoverable; this one reports whether the
 * *irrecoverable* thing has a way back. It is `degraded` rather than `report` when the escrow is missing,
 * which no other honesty check in this file is — a Node holding mail it cannot recover is not healthy, and
 * calling it healthy is the kind of reassurance this repository keeps finding and removing.
 *
 * ## Stale is a distinct state from absent, and it is the more dangerous one
 *
 * `rotate()` mints a new generation, and objects sealed after it are opened only by that key. An escrow taken
 * before the rotation therefore restores a vault that can read old mail and not new — a **half recovery that
 * reports success**, discovered at the worst possible moment. So the escrow records which generations it
 * carries and this compares them against the vault's own inventory, rather than checking that some codes
 * exist. "Ten codes are present" is exactly the sort of true-and-useless statement a check like this
 * degenerates into.
 */
async function checkRecoveryEscrow(env: Env, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) return [];
  const [state, inventory] = await Promise.all([
    escrowState(env, orgId),
    vault(env).inventory().catch(() => null),
  ]);

  if (state === null) {
    return [{
      check: "recovery_escrow",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "No key escrow. This Node's content and credential keys exist **only** in its Durable Object "
        + "storage, so losing that storage makes every message permanently unreadable — which is the "
        + "condition ADR 28 says it does not ship without covering.",
      fix: "a Node claimed before #92 has no codes and there is no route that mints a set for one — the "
        + "escrow is written at claim, because a Node that has accepted a single message without one already "
        + "holds content it cannot recover. Re-claiming is not possible either. Treat this Node as "
        + "unrecoverable and plan a migration to a freshly claimed one",
    }];
  }

  const stale = inventory !== null
    && (state.content < inventory.content || state.credential < inventory.credential);

  return [{
    check: "recovery_escrow",
    severity: stale ? "degraded" : "report",
    discloses: "data",
    ok: !stale && state.unredeemed > 0,
    detail: stale
      ? `The escrow carries content generation ${state.content} and credential generation `
        + `${state.credential}; the vault is now at ${inventory.content} and ${inventory.credential}. A `
        + "restore from these codes would recover mail sealed before the rotation and **not** mail sealed "
        + `since — a half recovery that looks like a whole one. ${state.unredeemed} of ${state.total} codes `
        + "are unspent."
      : `${state.unredeemed} of ${state.total} recovery codes unspent, carrying content generation `
        + `${state.content} and credential generation ${state.credential} — current. The codes themselves `
        + "are not here and cannot be: this Node keeps a hash that recognises one and an escrow only the "
        + "code itself opens.",
    ...(stale
      ? { fix: "mint a fresh set of codes, which re-escrows every generation the vault now holds and "
          + "invalidates the old set. The previously printed codes stop working, which is the point" }
      : state.unredeemed === 0
        ? { fix: "every code has been spent, so nothing can restore this vault. Mint a fresh set" }
        : {}),
  }];
}

/**
 * Whether anything can arrive here, and how much of that this Node is able to know (#101).
 *
 * ## Why this finding exists
 *
 * The empty inbox used to say *"This Node is claimed and routing is live."* It concluded that from an empty
 * result set, which establishes neither half. Every way of being broken — Email Routing never enabled, MX
 * records absent or pointing elsewhere, a catch-all aimed at a different Worker, no address configured at
 * all, inbound failing SPF upstream — produces exactly that screen, so somebody would be told the thing
 * works and wait. It is the same defect `planCheck` above describes in its own words: a status derived from
 * nothing, phrased with the confidence of a check.
 *
 * The screen now says only what an empty list means and points here. So this has to be worth arriving at.
 *
 * ## What is knowable from inside, and what is not
 *
 * Two things are provable without leaving the Worker, and both are evidence rather than inference:
 *
 *   - **is there an address at all** — no row in `addresses` means nothing routed here has anywhere to land,
 *     and `email()` rejects an unknown recipient. A Node in that state cannot receive, whatever DNS says.
 *   - **has anything ever arrived** — one `ingress_receipts` row is proof that routing reached this Worker
 *     at least once. It is the only positive evidence available, and it is conclusive as far as it goes.
 *
 * One thing is **not** knowable and this finding says so rather than guessing: whether Email Routing is
 * enabled on the zone and pointing at this Worker *right now*. That lives in the account, needs a token this
 * Node deliberately does not hold (ADR 22, ADR 24), and a Node that has received mail before can have had
 * its routing changed a minute ago. So "has received" is history, not a live status, and the detail is
 * careful to be worded as history.
 *
 * `discloses: "data"` because the counts are derived from an organization's mail (§5C).
 */
/**
 * How much mail is not searchable yet (#107).
 *
 * ## Why this is a finding rather than a log line
 *
 * The search index was added after this product had already been receiving mail, so on any existing Node
 * there is a period during which a search is **honestly incomplete**. A person searching for a message from
 * last month and finding nothing has no way to tell "no such mail" from "not indexed yet", and those are
 * different answers — the first is information and the second is a Node still catching up.
 *
 * The backfill runs from the scheduled handler every minute and logs when it makes progress, but a log line
 * scrolls past and answers the question only for whoever is watching at the time. A count answers it whenever
 * somebody asks.
 *
 * ## `report`, not `degraded`
 *
 * Unindexed mail is unsearchable, not lost: it is still reachable by paging, which is what the listing is for.
 * So a backlog is a fact about this Node rather than a fault in it, and `ok` is true — a fresh install with no
 * mail at all and a Node three passes from finishing are both fine, and neither should colour a health check
 * red. What would be a fault is a backlog that stops falling, and that is visible from two reports rather than
 * from one, which is a thing this check cannot honestly claim to detect.
 */
async function checkSearchIndex(env: Env, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) return [];

  const backlog = await unindexedMessages(env).catch(() => null);
  if (backlog === null) {
    return [{
      check: "search_index_backlog",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "The catalog could not be read, so this report cannot say how much mail is searchable.",
      fix: "check the `catalog_reachable` finding in this same report first — this one is downstream of it",
    }];
  }

  return [{
    check: "search_index_backlog",
    severity: "report",
    discloses: "infrastructure",
    ok: true,
    detail: backlog === 0
      ? "Every message on this Node is in the search index."
      : `${backlog} message(s) are not in the search index yet, so a search will not find them. They are `
        + "still reachable by paging the mailbox. The scheduled backfill indexes up to 500 a minute.",
    fix: backlog === 0
      ? undefined
      : "nothing — this falls on its own. If it stops falling, check the logs for `search.backfill_failed`",
  }];
}

async function checkInboundRouting(env: Env, orgId: string | null): Promise<Finding[]> {
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

function planCheck(): Finding {
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
