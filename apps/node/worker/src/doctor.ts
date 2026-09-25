import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import {
  checkSchema, checkEvidenceBucket, planCheck, checkProviderToken, checkInboundRouting,
  checkInboundAuthentication, checkTransportAdapters,
} from "./doctor/node.ts";
import { sendingEventsConsumerCheck, checkDeliveryVisibility, checkBreakers } from "./doctor/delivery.ts";
import { checkVault, checkCredentialKek, checkSigningKeys } from "./doctor/keys.ts";
import { checkOutbox, checkEvidence, strandedDraftBodyFindings, checkEvidenceChanged, checkSearchIndex } from "./doctor/evidence.ts";
import { checkHolds, checkSelfGrants, checkSupervisionNotices, checkAgentCeilings } from "./doctor/governance.ts";
import { butlerExecutionCheck, checkButlerPauses } from "./doctor/butlers.ts";
import { checkRecoveryEscrow, checkRecoveryConflicts, checkRecoveryRestores } from "./doctor/recovery.ts";
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
  /**
   * Which version of this Worker answered (#98).
   *
   * The deploy gate checks a canary by sending `Cloudflare-Workers-Version-Overrides` to the production
   * hostname, and Cloudflare routes the request by traffic percentage when the override cannot be applied —
   * to the version already serving. A gate that read only `verdict` would therefore pass by asking the old
   * version how it is, and promote a canary nothing had examined. This is the field that makes the gate able
   * to fail: `mailda deploy` refuses unless the id here equals the id it uploaded.
   *
   * `null` when the binding is absent, which is every test that builds an env by hand. Null is not "fine":
   * the CLI treats a missing version as a refusal for the same reason it treats a mismatched one that way.
   */
  version: string | null;
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
    ...(await checkProviderToken(env)),
    ...(await checkInboundRouting(env, claim?.org_id ?? null)),
    ...(await checkInboundAuthentication(env, ctx, claim?.org_id ?? null)),
    ...(await checkRecoveryEscrow(env, claim?.org_id ?? null)),
    ...(await checkSearchIndex(env, claim?.org_id ?? null)),
    ...(await checkAgentCeilings(env, ctx, claim?.org_id ?? null)),
    ...(await checkRecoveryRestores(env, ctx, claim?.org_id ?? null)),
    ...(await checkRecoveryConflicts(env, claim?.org_id ?? null)),
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

  /*
   * Read defensively rather than as `rawEnv.CF_VERSION.id`. The binding is generated from `wrangler.jsonc`,
   * so the type says it is always there — but a test that builds an env literal does not have it, and a
   * `TypeError` here would turn a diagnostic into a 500 for the one caller whose job is to report trouble.
   */
  const metadata = (rawEnv as { CF_VERSION?: { id?: string } }).CF_VERSION;
  const version = typeof metadata?.id === "string" ? metadata.id : null;

  return { verdict, claimed, at: new Date(ctx.now()).toISOString(), version, findings, cost };
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
 * Can this Node authenticate anybody at all?
 *
 * ## Why this exists rather than reading the full report
 *
 * `/api/doctor` answered a 401 to an anonymous caller by running the **entire diagnostic** and then throwing
 * the result away — because the one question it needed was *"is authentication impossible"*, and the only way
 * to ask it was `authenticationIsImpossible(full)`. So every anonymous request to a healthy Node paid for a
 * full organization-wide sweep of D1, R2 and the vault, and received nothing.
 *
 * CI proves that sweep is bounded. Bounded is not the same as free, and it is not the same as authorized: an
 * expensive diagnostic anybody can trigger without a credential is an availability and billing surface,
 * whatever its ceiling.
 *
 * The question turns on exactly two findings — `credential_key` and `signing_key` — so this runs those two.
 * `authenticationIsImpossible` reads the same shape either way, which is what stops the cheap answer and the
 * full one disagreeing.
 */
export async function authenticationProbe(env: Env, ctx: Ctx): Promise<Finding[]> {
  return [...(await checkCredentialKek(env)), ...(await checkSigningKeys(env, ctx))];
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
/**
 * Reads a report *or* a bare finding list, so the cheap probe and the full sweep cannot answer differently.
 */
export function authenticationIsImpossible(report: DoctorReport | { findings: Finding[] }): boolean {
  return report.findings.some(
    (f) => !f.ok && f.severity === "refuse" && (f.check === "credential_key" || f.check === "signing_key"),
  );
}


/**
 * Why a report was reduced. Three distinct situations that used to share one sentence.
 *
 * - `locked_out` — nobody can sign in, because a key this Node needs is gone. The original case, and the one
 *   the wording was written for.
 * - `unclaimed` — no organization exists here yet, so there is nobody to be.
 * - `not_an_administrator` — signed in, and the organization's condition is an administrator's to read.
 *
 * There is deliberately no *"you are not signed in"*: on a claimed Node the route answers an anonymous caller
 * `401` unless authentication is impossible, so that case never reaches this function. Writing a fourth
 * reason for it would be adding wording for a state the router cannot produce — which is how the one wrong
 * sentence got here in the first place.
 */
export type ReductionReason = "locked_out" | "unclaimed" | "not_an_administrator";


const REDUCTION_WORDING: Record<ReductionReason, string> = {
  locked_out: "Served without authentication because this Node cannot currently authenticate anyone.",
  unclaimed: "Served without authentication because this Node has not been claimed yet, so it has no "
    + "organization to describe.",
  not_an_administrator:
    "You are signed in. The withheld findings describe the whole organization's mail, which is an "
    + "administrator's to read.",
};


/**
 * The reduced form. Infrastructure findings only, and it says that it is reduced **and why**.
 *
 * ## The sentence that was wrong for most of its readers
 *
 * This took no reason and always said *"Served without authentication because this Node cannot currently
 * authenticate anyone."* That is true in exactly one case — the locked-out Node it was written for. The
 * router calls this for **every** non-administrator, so the ordinary signed-in member, on a perfectly healthy
 * Node, was told that authentication was impossible.
 *
 * It matters more than a wording slip because of when it is read. `doctor` is what an operator opens during
 * an incident, and a diagnostic that contradicts the thing the reader just did — signing in — costs them the
 * first minutes of the incident wondering whether the sessions are broken too.
 *
 * The test that covered this asserted the report *was* reduced and never read the explanation, so the false
 * sentence was inside the one assertion nobody made.
 */
export function withoutDataFindings(report: DoctorReport, reason: ReductionReason): DoctorReport {
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
        detail: `${REDUCTION_WORDING[reason]} `
          + `${report.findings.length - findings.length} finding(s) that would describe this `
          + `organization's mail are withheld.`,
      },
    ],
  };
}
