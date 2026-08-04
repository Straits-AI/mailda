import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { isUsingDevCredentialKek, unwrapCredential, wrapCredential } from "./auth/kek.ts";
import { mintAccessToken, verifyAccessToken } from "./auth/jwt.ts";
import { isUsingDevKek } from "./evidence-store.ts";

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

  const catalog = new Proxy(env.CATALOG, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => {
          cost.d1Queries += 1;
          cost.subrequests += 1;
          return target.prepare(query);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const evidence = new Proxy(env.EVIDENCE, {
    get(target, property, receiver) {
      if (property === "head" || property === "get") {
        return (...args: unknown[]) => {
          cost.r2Reads += 1;
          cost.subrequests += 1;
          return (Reflect.get(target, property, receiver) as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  return { env: { ...env, CATALOG: catalog, EVIDENCE: evidence } as Env, cost };
}

/**
 * How many receipts get their evidence blob verified.
 *
 * Every check costs an R2 `head`, which spends a subrequest against the 1,000-per-invocation cap,
 * so this cannot be "all of them" on a Node holding millions of messages. It is a **sample**, and
 * the report says so in its own detail line — a bounded check that reads as exhaustive is worse
 * than no check.
 */
const EVIDENCE_SAMPLE = BUDGETS["doctor.evidence_sample_size"];

const EXPECTED_TABLES = [
  "relationship_tuples", "team_members", "messages", "mailbox_items", "ingress_receipts",
  "outbox", "addresses", "mailboxes", "users", "sessions", "node_claim",
  "signing_keys", "refresh_tokens", "login_attempts",
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
    ...(await checkContentKek(env, claimed)),
    ...(await checkCredentialKek(env, claimed)),
    ...(await checkSigningKeys(env, ctx)),
    ...(await checkOutbox(env, ctx)),
    ...(await checkEvidence(env)),
    planCheck(),
  );


  findings.push({
    check: "doctor_cost",
    severity: "report",
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
      detail: "The CATALOG D1 binding did not answer a query.",
      fix: "confirm the d1_databases binding is linked to this Worker (`wrangler deploy` reports it as `env.CATALOG`)",
    }];
  }

  const present = new Set(rows.results.map((r) => r.name));
  const missing = EXPECTED_TABLES.filter((table) => !present.has(table));

  return [{
    check: "migrations_applied",
    severity: "refuse",
    ok: missing.length === 0,
    detail: missing.length === 0
      ? `All ${EXPECTED_TABLES.length} expected tables present.`
      : `Missing ${missing.length} table(s): ${missing.join(", ")}.`,
    ...(missing.length === 0 ? {} : {
      fix: "run `wrangler d1 migrations apply CATALOG --remote`; a Node with a partial schema accepts mail it cannot file",
    }),
  }];
}

/**
 * The content KEK. Unbound means mail is sealed under a constant published in this repository.
 *
 * `refuse` only once the Node is **claimed**, because an unclaimed Node holds no mail and local
 * development has no Secrets Store. A claimed Node with a dev KEK is claiming "encrypted at rest"
 * and the claim is false.
 */
async function checkContentKek(env: Env, claimed: boolean): Promise<Finding[]> {
  const dev = isUsingDevKek(env);
  if (!dev) {
    return [{ check: "content_kek", severity: "refuse", ok: true, detail: "Bound to a Secrets Store secret." }];
  }
  return [{
    check: "content_kek",
    severity: claimed ? "refuse" : "report",
    ok: !claimed,
    detail: claimed
      ? "Mail on this Node is encrypted under DEV_ONLY_KEK, a constant published in the Mailda repository. It is not protected."
      : "No CONTENT_KEK binding. Acceptable while unclaimed; this Node holds no mail yet.",
    ...(claimed ? {
      fix: "bind CONTENT_KEK to a Secrets Store secret and re-seal existing evidence — a Node that looks encrypted and is not is worse than one that never claimed to be",
      receipt: "docs/receipts/evidence-frame-size.md",
    } : {}),
  }];
}

/**
 * The credential KEK, checked by **using** it rather than looking at it.
 *
 * Presence is not readability: a Secrets Store secret is `pending` for a period after creation and
 * `.get()` throws until it propagates. That presented as an HTTP 500 on the first sign-in of a
 * correctly configured Node, which is the reason this does a wrap/unwrap round trip.
 */
async function checkCredentialKek(env: Env, claimed: boolean): Promise<Finding[]> {
  if (isUsingDevCredentialKek(env)) {
    // Gated on `claimed` for the same reason as the content KEK, and stated once here because the
    // two were briefly inconsistent: an unclaimed Node has no users and no signing keys worth
    // protecting, and local development has no Secrets Store. The moment it is claimed, the
    // fallback means a database dump plus a copy of this public repository mints sessions.
    return [{
      check: "credential_kek",
      severity: claimed ? "refuse" : "report",
      ok: !claimed,
      detail: claimed
        ? "No CREDENTIAL_KEK binding. Token-signing keys are wrapped under a constant published in the Mailda repository, so anyone with a database dump and a copy of that repository could mint sessions."
        : "No CREDENTIAL_KEK binding. Acceptable while unclaimed; there are no sessions to forge yet.",
      ...(claimed ? { fix: "bind CREDENTIAL_KEK to a Secrets Store secret and rotate the signing key, since the existing one was wrapped under the published constant (ADR 22)" } : {}),
    }];
  }

  const probe = "doctor-credential-kek-round-trip";
  try {
    const recovered = await unwrapCredential(env, await wrapCredential(env, probe));
    return [{
      check: "credential_kek",
      severity: "refuse",
      ok: recovered === probe,
      detail: recovered === probe
        ? "Wrap/unwrap round trip succeeded."
        : "Wrap/unwrap round trip returned different bytes.",
      ...(recovered === probe ? {} : { fix: "the credential KEK changed; existing signing keys cannot be unwrapped and must be rotated" }),
    }];
  } catch (error) {
    return [{
      check: "credential_kek",
      severity: "refuse",
      ok: false,
      detail: `Binding present but unusable: ${(error as Error).message.split("\n")[0]}`,
      fix: "a Secrets Store secret is `pending` for a period after creation and cannot be read; wait for it to become active, or check store_id and secret_name against `wrangler secrets-store secret list <store-id> --remote`",
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
 * Evidence integrity — the one check that looks for §24's worst failure: a receipt that says a
 * message was accepted, pointing at a blob that is not there. "Accepted but absent".
 *
 * Bounded to a sample, and the detail line says how many were checked out of how many exist. A
 * check that silently examines 200 of 8 million rows and reports "ok" is a check that lies.
 *
 * Deliberately **never repaired**. A missing blob is not a bookkeeping error to tidy away; it is
 * lost mail, and the only honest response is to name the receipts and let a human decide.
 */
async function checkEvidence(env: Env): Promise<Finding[]> {
  const total = await env.CATALOG.prepare("SELECT COUNT(*) AS n FROM ingress_receipts")
    .first<{ n: number }>().catch(() => null);

  const sample = await env.CATALOG.prepare(
    "SELECT id, blob_key FROM ingress_receipts ORDER BY accepted_at DESC LIMIT ?",
  ).bind(EVIDENCE_SAMPLE).all<{ id: string; blob_key: string }>().catch(() => null);

  if (total === null || sample === null) {
    return [{
      check: "evidence_present",
      severity: "degraded",
      ok: false,
      detail: "Could not read ingress_receipts.",
      fix: "check the migrations_applied finding first",
    }];
  }

  const missing: string[] = [];
  for (const receipt of sample.results) {
    if ((await env.EVIDENCE.head(receipt.blob_key)) === null) missing.push(receipt.id);
  }

  const checked = sample.results.length;
  const scope = `${checked} of ${total.n} receipt(s) checked`;

  return [{
    check: "evidence_present",
    severity: "degraded",
    ok: missing.length === 0,
    detail: missing.length === 0
      ? `Every sampled receipt's evidence object exists (${scope}${checked < total.n ? `, most recent ${EVIDENCE_SAMPLE}` : ""}).`
      : `${missing.length} receipt(s) reference an evidence object that is absent — accepted mail that cannot be read (${scope}): ${missing.join(", ")}.`,
    ...(missing.length === 0 ? {} : {
      fix: "this is lost mail, not a bookkeeping error. Do not delete the receipts. Check R2 lifecycle rules and §24 Time Travel before anything else",
    }),
    receipt: "docs/receipts/doctor-check-cost.md",
  }];
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
