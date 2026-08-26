import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { utf8 } from "@mailda/evidence";

import { assertObject } from "./access.ts";
import {
  describeShortfall, NO_TEAM_ROSTERS, planApproval, stageOf, type Stages,
} from "./approvals.ts";
import { auditedBatch } from "./audit.ts";
import { mayExportBulk, type Principal } from "./authz-read.ts";
import { decidersOf } from "./deciders.ts";
import { getEvidence, putEvidence, runKeyCache, sha256Hex, type RunKeyCache } from "./evidence-store.ts";
import { CallerError, conflict, notFound, unprocessable } from "./errors.ts";
import { readMatter } from "./matters.ts";

/**
 * eDiscovery export — the supervised bulk copy (#65, §7, §22, Layer 5).
 *
 * ## An export is a supervised act, and it inherits that frame rather than inventing one
 *
 * #63 built the frame: a matter, a bounded scope, two people who are not the actor agreeing to it, and a
 * record of what was disclosed. An export is the same shape with a different unit — a set of messages
 * instead of a mailbox and a deadline — so it reuses #61's approval machinery as the fourth subject kind
 * rather than growing a second approval path. All three of #61's defects were in the race logic that a
 * second path would have had to copy.
 *
 * ## Where the bytes go, and why every other destination was impossible
 *
 * The reachable destinations from this Worker are an object in the one R2 bucket or an HTTP response.
 * Presigned URLs do not exist here — the Workers R2 binding has no presign method at all — and pushing to a
 * customer's own destination is unreachable, because this Worker makes zero outbound `fetch()` calls. There
 * is exactly one bucket (`EVIDENCE`, `wrangler.jsonc:13`).
 *
 * Streaming straight to an HTTP response was rejected on the budget: an export past one invocation's
 * subrequests dies mid-stream leaving a partial file, with nothing staged to resume from and no way to hash
 * what was never kept. So the run **stages sealed objects** under `${orgId}/exports/${exportId}/` — sealed
 * with `putEvidence`, because §12 makes an export at rest encrypted like everything else — and the download
 * is mediated by a Worker route.
 *
 * Mediating the download is what makes §7's *"revocation terminates export jobs"* enforceable rather than
 * asserted: every page and every object re-asks whether the requester still holds `ediscovery.export` and
 * whether the approval still stands, so revoking either stops the run and stops the download mid-file.
 *
 * ## The approval binds a hash **and** a count
 *
 * §18 binds an approval to "referenced artifact hashes", and an export's target is a query. A predicate can
 * be canonicalised and hashed; what it cannot do is bound what it *matches*. The same predicate returns more
 * next week, so approving a predicate alone approves an unbounded future disclosure with a recheck that
 * passes cleanly. `max_messages` closes that and it **fails closed**: a run that would exceed it aborts and
 * needs a fresh approval, rather than exporting more than anyone agreed to or truncating to the bound and
 * reporting success.
 *
 * ## The boundary this names rather than works around
 *
 * blueprint:1280 says an export too large for the platform must have its boundary exposed rather than worked
 * around. Here the boundary is the **manifest**: it is built by paging one listing of the export's own prefix
 * and that paging stops at `export.max_messages_ceiling` objects. So `max_messages` above that is refused **at
 * request time**, with the number and the reason, instead of being discovered as a short manifest after a long
 * run.
 *
 * The ceiling was originally derived from `r2.list_max_keys_per_call` on the assumption that the build was a
 * *single* call. It is not, and it never could have been: a listing that asks for `customMetadata` returns at
 * most `r2.list_max_keys_with_metadata` keys — a hundred, measured, and documented by Cloudflare as "you may
 * receive fewer than `limit` to accommodate metadata". See `completeExport`, which pages it, and
 * `docs/receipts/r2-list-page-size.md`, which records both numbers.
 *
 * ## What is deliberately not recorded, and why
 *
 * Page progress lives in the `exports` row, not in the trail: one entry per page would put hundreds of rows
 * behind one act and falsify `audit-and-log-retention.md`'s sizing. Downloading a staged object is likewise
 * not an entry — `supervised.export_completed` already names the manifest hash and the count, so the trail
 * says exactly what was copied and to whom it was authorized, and an entry per object would be the same
 * per-row-versus-per-act mistake at the other end of the pipe. Said here rather than left to be noticed.
 */

/**
 * What an export is doing. **The declared set, and the only place it is declared.**
 *
 * `exports.state` carries no CHECK constraint, for the reason `APPROVAL_SUBJECT_KINDS` and
 * `SUPERVISED_SCOPES` already live with: SQLite cannot add one with `ALTER TABLE`, a trigger cannot exist in
 * this tree because `src/migrate.ts` splits migrations on semicolons, and recreating the table would need a
 * `DROP TABLE` that `test/node/content-deletion-world.test.ts` refuses in `migrations/`. So this union is
 * the constraint and `test/node/matter-and-scope-world.test.ts` is what makes it one rather than a
 * convention.
 *
 * `as const satisfies` and a derived union rather than `readonly string[]`, so a mistyped state is a compile
 * error instead of a row that matches no predicate and quietly stops being runnable.
 */
export const EXPORT_STATES = [
  "requested", "running", "completed", "aborted",
] as const satisfies readonly string[];

export type ExportState = (typeof EXPORT_STATES)[number];

/** The states a run may still advance. Named once, so the SQL and the checks cannot disagree. */
const RESUMABLE: readonly ExportState[] = ["requested", "running"];

/** The one spelling of "this export may still emit a page", as SQL. */
const RESUMABLE_SQL = `state IN ('requested', 'running')`;

/**
 * The gate both terminal writes ride behind, so a lost race records **nothing** rather than a second ending.
 *
 * `auditedBatch` makes the entry `INSERT ... SELECT ... WHERE EXISTS (<gate>)`, evaluated inside the same
 * transaction and before the `UPDATE` that clears the predicate. Without it the entry is unconditional: two
 * invocations that both find an empty last page both pass the cursor compare-and-swap — the cursor does not
 * move, so there is nothing for it to catch — and the loser's `UPDATE` changes no row while its
 * `supervised.export_completed` lands anyway. The trail would then say one export completed twice.
 *
 * It is the same standard `COMPLETING_EFFECT.raced` states one module over and for the same reason: an entry
 * for a state change that did not happen is worse than a missing one, because it is *wrong* rather than
 * absent. The winner's entry is the one that survives, and it is the true one.
 */
const TERMINAL_GATE = (orgId: string, exportId: string) => ({
  sql: `SELECT 1 FROM exports WHERE org_id = ? AND id = ? AND ${RESUMABLE_SQL}`,
  params: [orgId, exportId],
});

/**
 * #65's shape: **one stage, two distinct people**, exactly as a supervised read.
 *
 * Not a number anybody may tune and not a measured tripwire — 2 *is* what dual control means, and §7 asks
 * for it by name for an export. A stage set rather than a bare count, so if an export ever needs counsel to
 * sign before the data-protection officer it is `[1, 1]` with nothing else changing.
 */
export const EXPORT_STAGES: Stages = [stageOf(2)];

/** How many messages one invocation copies before checkpointing. See `docs/receipts/ediscovery-export-cost.md`. */
const PAGE_SIZE = BUDGETS["export.page_size"];

/** The most messages one approval may authorize, because the manifest is one `list()`. See the header. */
const MAX_MESSAGES_CEILING = BUDGETS["export.max_messages_ceiling"];

/* ---- the predicate, and the hash the approval binds ------------------------------------------- */

/**
 * What an export copies. **Four fields, and every one of them is in the hash.**
 *
 * Deliberately small. A predicate language is a thing an investigator learns and an approver has to read
 * before agreeing to it, and the two approvers are the control this whole mechanism rests on — so the
 * predicate is a mailbox, a window and a substring, which fits in a sentence a person can check. A richer
 * query is expressible later by adding a field, and adding one **changes the hash**, which is the property
 * that makes widening require a fresh approval rather than reusing an old one.
 */
export interface ExportPredicate {
  mailboxId: string;
  /** Inclusive bounds on `accepted_at`. Null is unbounded in that direction, as a hold's window is. */
  fromDate: string | null;
  toDate: string | null;
  /** A case-insensitive substring of the subject line, or null for "every message in the window". */
  subjectContains: string | null;
}

/**
 * The predicate as the bytes that get hashed.
 *
 * Field order is **fixed and written out** rather than derived from object iteration, for `canonical`'s
 * reason in `src/audit.ts`: a hash whose input depends on property order changes when somebody reorders an
 * interface, and a bound that breaks on a refactor teaches everyone to ignore it. Null is emitted as `null`
 * rather than omitted, so "unbounded" and "field not yet invented" are different bytes.
 */
export function canonicalPredicate(predicate: ExportPredicate): string {
  return JSON.stringify({
    v: 1,
    mailboxId: predicate.mailboxId,
    fromDate: predicate.fromDate,
    toDate: predicate.toDate,
    subjectContains: predicate.subjectContains,
  });
}

/** The hash the approval binds and the recheck re-derives. Hex SHA-256 over the canonical bytes. */
export async function predicateHash(canonical: string): Promise<string> {
  return sha256Hex(utf8(canonical));
}

/* ---- requesting ------------------------------------------------------------------------------- */

export interface RequestExportInput {
  mailboxId: string;
  /** Required. See migration 0025 for why this one is NOT NULL where a hold's and a grant's are not. */
  matterId: string;
  fromDate?: string | null;
  toDate?: string | null;
  subjectContains?: string | null;
  /** The hard bound the two approvers agree to. Never clamped, never defaulted. */
  maxMessages: number;
}

export interface ExportRequested {
  exportId: string;
  approvalId: string;
  requestedBy: string;
  mailboxId: string;
  matterId: string;
  predicate: ExportPredicate;
  predicateSha256: string;
  maxMessages: number;
  destination: string;
  requestedAt: string;
  stages: Stages;
  /** Distinct people who could decide it, the requester already excluded. */
  eligible: number;
}

/** Where one export's objects live. One spelling, shared by the run, the download and the reconciler. */
export function exportDestination(orgId: string, exportId: string): string {
  return `${orgId}/exports/${exportId}/`;
}

/** The prefix every export in one organization shares — what the reconciler lists. */
export function exportsPrefix(orgId: string): string {
  return `${orgId}/exports/`;
}

/** The manifest's object name inside a destination. Never a message's name: `.eml` is the other suffix. */
const MANIFEST_NAME = "manifest.json";

/**
 * Asks for a bulk export, and opens the approval two other people have to complete.
 *
 * ## The requester is the person the copy is for, and there is no field for it
 *
 * `requested_by` is the caller, always — the same construction `requestSupervisedRead` uses and for the same
 * reason. A request on somebody else's behalf would put the person receiving the copy outside #61's actor
 * exclusion, leaving them free to approve their own export. §18's separation of duty is a rule about that
 * person, so the two are the same principal by construction and there is no field to get wrong.
 *
 * ## A matter is required here, unlike a hold and unlike a supervised read
 *
 * Both of those allow none, because the realistic first act precedes anybody deciding what the matter is. A
 * bulk export is never the first act: it is downstream of an investigation somebody already opened, and §7
 * hangs the notice to the people whose mail was copied on that matter closing. An export citing nothing
 * would be a copy with no purpose to notice against.
 */
export async function requestExport(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  input: RequestExportInput,
): Promise<ExportRequested> {
  // The mailbox has to exist, from the same function a grant and a supervised request use. An export over a
  // mailbox that is not there would run a three-person ceremony and copy nothing.
  await assertObject(env, orgId, "ediscovery.export", input.mailboxId);

  if (!(await mayExportBulk(env, { orgId, userId: actorUserId }, input.mailboxId))) {
    // 403 naming the relation rather than §5C's 404, and the difference from the read paths is deliberate:
    // the caller has already been told the mailbox exists by `assertObject`, and their own lack of authority
    // is not a thing whose existence needs hiding. Same reasoning `assertAdmin` records.
    throw new CallerError("E_NO_EXPORT_PERMISSION", 403, {
      what: `you do not hold ediscovery.export on mailbox ${input.mailboxId}`,
      why: "§7 makes a bulk copy of somebody's mailbox the most consequential read this Node performs, so "
        + "asking for one is a granted authority rather than something any member may do — and it is "
        + "deliberately not conferred by a supervised grant, which would let one approval pair supply the "
        + "standing to ask for a second",
      fix: `ask an administrator for ediscovery.export on mailbox ${input.mailboxId} — `
        + "POST /api/access/grant — then ask again. Two other people holding approval.decide on that "
        + "mailbox still have to approve the export itself",
    });
  }

  const matter = await readMatter(env, orgId, input.matterId);
  if (matter === null) {
    throw notFound("E_NO_MATTER", {
      what: `matter ${input.matterId} does not exist`,
      why: "an export cites the matter it is for, and a citation that resolves to nothing would be a copy of "
        + "somebody's mail with no stated purpose — which is also the record §7's notice is computed from",
      fix: "POST /api/matters opens one, and GET /api/matters lists the ones you opened",
    });
  }
  if (matter.closedAt !== null) {
    throw conflict("E_MATTER_CLOSED", {
      what: `matter ${input.matterId} was closed at ${matter.closedAt}`,
      why: "§7 makes the notice to the people whose mail was read due after a matter closes, so taking a "
        + "fresh copy under a closed matter would make that notice untrue about the disclosure it describes",
      fix: "open a new matter if the investigation has resumed — POST /api/matters",
    });
  }

  const maxMessages = input.maxMessages;
  if (!Number.isInteger(maxMessages) || maxMessages <= 0) {
    throw unprocessable("E_EXPORT_BOUND_REQUIRED", {
      what: `maxMessages ${JSON.stringify(input.maxMessages)} is not a whole number of messages above zero`,
      why: "the approval binds a predicate hash **and** a count, because a predicate cannot bound what it "
        + "matches — the same predicate returns more next week, so approving one alone would approve an "
        + "unbounded future disclosure with a recheck that passes cleanly",
      fix: "send {\"maxMessages\":500} — the number the two approvers are agreeing may leave this Node",
    });
  }
  if (maxMessages > MAX_MESSAGES_CEILING) {
    // blueprint:1280 — name the boundary rather than working around it. Refused here, before the ceremony,
    // rather than discovered as a short manifest after a long run.
    throw unprocessable("E_EXPORT_TOO_LARGE", {
      what: `export.max_messages_ceiling=${MAX_MESSAGES_CEILING}, this request asked for ${maxMessages}`,
      why: "an export's manifest is built by paging one R2 listing of the export's own prefix, and that "
        + `paging stops at ${MAX_MESSAGES_CEILING} objects — so beyond the ceiling this Node could stage the `
        + "objects and then be unable to produce a manifest that names all of them. A manifest that silently "
        + "omitted messages would be worse than a refusal, because it would read as a complete account of "
        + "what was disclosed",
      fix: `ask for at most ${MAX_MESSAGES_CEILING} messages, narrowing the date window or the subject `
        + "match, and run more than one export — receipt: docs/receipts/ediscovery-export-cost.md",
    });
  }

  const predicate: ExportPredicate = {
    mailboxId: input.mailboxId,
    fromDate: normaliseBound(input.fromDate, "from"),
    toDate: normaliseBound(input.toDate, "to"),
    subjectContains: input.subjectContains === undefined || input.subjectContains === null
      || input.subjectContains === ""
      ? null
      : input.subjectContains,
  };
  const canonical = canonicalPredicate(predicate);
  const sha256 = await predicateHash(canonical);

  const deciders = await decidersOf(env, orgId, input.mailboxId);
  const exportId = ctx.id("exp");
  const requestedAt = new Date(ctx.now()).toISOString();
  const destination = exportDestination(orgId, exportId);

  const planned = planApproval(env, ctx, orgId, {
    subjectKind: "ediscovery_export",
    subjectId: exportId,
    scopeId: input.mailboxId,
    actorUserId,
    stages: EXPORT_STAGES,
    // What the two approvers are being asked to agree to, in the entry as well as in the queue. The hash
    // rather than the predicate text, because the hash is the bound object §18 names and the text is on the
    // row for anybody who wants to read it.
    detail: { exportId, predicateSha256: sha256, maxMessages, matterId: input.matterId, destination },
  // `NO_TEAM_ROSTERS`: see `requestHoldLift` — an export's stages name no team (#73).
  }, deciders, NO_TEAM_ROSTERS);

  if (!planned.satisfiable) {
    // Refused before anything is written, for `requestSupervisedRead`'s reason: an open request nobody can
    // complete reads as waiting for somebody, and the honest answer names the shortfall.
    throw conflict("E_EXPORT_UNSATISFIABLE", {
      what: `no export of mailbox ${input.mailboxId} can be approved: `
        + describeShortfall(planned.shortfall, input.mailboxId),
      why: "§7 requires dual approval for an export and #61 excludes whoever asked, so a mailbox with fewer "
        + "than two other approval.decide holders has no export anybody could complete",
      fix: `grant approval.decide on mailbox ${input.mailboxId} to two people who are not you — `
        + "POST /api/access/grant — then ask again",
    });
  }

  await auditedBatch<never>(
    env, ctx, orgId, planned.plan.event,
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `INSERT INTO exports
           (id, org_id, matter_id, mailbox_id, requested_by, predicate, predicate_sha256, max_messages,
            destination, state, state_reason, cursor_after, pages_done, messages_emitted, requested_at,
            started_at, completed_at, manifest_key, manifest_sha256)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,0,?,NULL,NULL,NULL,NULL)`,
      ).bind(exportId, orgId, input.matterId, input.mailboxId, actorUserId, canonical, sha256, maxMessages,
        destination, "requested" satisfies ExportState, requestedAt),
      ...planned.plan.statements,
    ],
  );

  return {
    exportId,
    approvalId: planned.plan.approvalId,
    requestedBy: actorUserId,
    mailboxId: input.mailboxId,
    matterId: input.matterId,
    predicate,
    predicateSha256: sha256,
    maxMessages,
    destination,
    requestedAt,
    stages: [...planned.plan.stages],
    eligible: planned.plan.eligible,
  };
}

/**
 * Widens a bare date to the inclusive edge of that day, and refuses anything unparseable.
 *
 * The same function `placeHold` needed, for the same reason and re-derived rather than imported: comparison
 * is lexical against ISO-8601 instants, so a `toDate` of `2026-08-31` would sort *below* everything that
 * happened during 31 August and silently exclude the last day somebody chose. It is **not** shared with
 * `src/holds.ts` because importing it would make `exports.ts` depend on the hold module for a string
 * function while `holds.ts` keeps it private; the honest options were to duplicate twelve lines or to move
 * it to a third module, and a third module for one helper is the shape this repository already refuses for
 * `readHoldLift`.
 *
 * For an export the direction of an error is the opposite of a hold's and matters just as much: a hold that
 * under-covers preserves too little, and an export whose bound under-widens **copies too little**, which is
 * an investigator quietly missing a day of somebody's mail.
 */
function normaliseBound(value: string | null | undefined, edge: "from" | "to"): string | null {
  if (value === undefined || value === null || value === "") return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const widened = dateOnly ? `${value}T${edge === "from" ? "00:00:00.000Z" : "23:59:59.999Z"}` : value;
  const parsed = new Date(widened);
  if (Number.isNaN(parsed.getTime())) {
    throw unprocessable("E_EXPORT_BOUND_UNREADABLE", {
      what: `${edge === "from" ? "fromDate" : "toDate"} ${JSON.stringify(value)} is not a date this Node can compare`,
      why: "the window is a comparison against ISO-8601 instants, and it is part of the hash the two "
        + "approvers agree to — a bound nothing matches would make the export copy nothing while its "
        + "approval read as agreed",
      fix: "send a date (2026-08-01) or a full instant (2026-08-01T09:00:00.000Z)",
    });
  }
  return parsed.toISOString();
}

/* ---- reading an export ------------------------------------------------------------------------ */

export interface ExportRow {
  id: string;
  orgId: string;
  matterId: string;
  mailboxId: string;
  requestedBy: string;
  predicate: ExportPredicate;
  predicateSha256: string;
  maxMessages: number;
  destination: string;
  state: ExportState;
  stateReason: string | null;
  cursorAfter: string | null;
  pagesDone: number;
  messagesEmitted: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  manifestKey: string | null;
  manifestSha256: string | null;
  /** Live, from `approvals` — never a copy on this row. See `approveStatements`. */
  approvalState: string | null;
}

interface Raw {
  id: string;
  org_id: string;
  matter_id: string;
  mailbox_id: string;
  requested_by: string;
  predicate: string;
  predicate_sha256: string;
  max_messages: number;
  destination: string;
  state: ExportState;
  state_reason: string | null;
  cursor_after: string | null;
  pages_done: number;
  messages_emitted: number;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  manifest_key: string | null;
  manifest_sha256: string | null;
  approval_state: string | null;
}

const COLUMNS = "e.id, e.org_id, e.matter_id, e.mailbox_id, e.requested_by, e.predicate, "
  + "e.predicate_sha256, e.max_messages, e.destination, e.state, e.state_reason, e.cursor_after, "
  + "e.pages_done, e.messages_emitted, e.requested_at, e.started_at, e.completed_at, e.manifest_key, "
  + "e.manifest_sha256";

function rowOf(row: Raw): ExportRow {
  return {
    id: row.id,
    orgId: row.org_id,
    matterId: row.matter_id,
    mailboxId: row.mailbox_id,
    requestedBy: row.requested_by,
    // Parsed back from the canonical text rather than from separate columns, so the thing the hash is over
    // and the thing a reader sees are the same bytes. A column-per-field shape would make the two
    // drift-able, which is what the hash exists to prevent.
    predicate: JSON.parse(row.predicate) as ExportPredicate,
    predicateSha256: row.predicate_sha256,
    maxMessages: row.max_messages,
    destination: row.destination,
    state: row.state,
    stateReason: row.state_reason,
    cursorAfter: row.cursor_after,
    pagesDone: row.pages_done,
    messagesEmitted: row.messages_emitted,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    manifestKey: row.manifest_key,
    manifestSha256: row.manifest_sha256,
    approvalState: row.approval_state,
  };
}

/**
 * One export **with its live approval state**, in one query.
 *
 * The join is the whole point: `runExport` and the download route both have to know whether two people still
 * stand behind this copy, and the answer must never come from a column on the export itself. `exp_approval`
 * and `apr_subject` make it a seek on both sides, which is what makes a per-page recheck affordable.
 */
export async function readExport(env: Env, orgId: string, exportId: string): Promise<ExportRow | null> {
  const row = await env.CATALOG.prepare(
    `SELECT ${COLUMNS}, a.state AS approval_state
       FROM exports e
       LEFT JOIN approvals a ON a.org_id = e.org_id AND a.subject_kind = 'ediscovery_export'
                            AND a.subject_id = e.id
      WHERE e.org_id = ? AND e.id = ? LIMIT 1`,
  ).bind(orgId, exportId).first<Raw>();
  return row === null ? null : rowOf(row);
}

/** Every export this organization has asked for, most recent first. For the route and for `doctor`. */
export async function exportsForReport(env: Env, orgId: string): Promise<ExportRow[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT ${COLUMNS}, a.state AS approval_state
       FROM exports e
       LEFT JOIN approvals a ON a.org_id = e.org_id AND a.subject_kind = 'ediscovery_export'
                            AND a.subject_id = e.id
      WHERE e.org_id = ? ORDER BY e.requested_at DESC, e.id DESC`,
  ).bind(orgId).all<Raw>();
  return results.map(rowOf);
}

/* ---- running ---------------------------------------------------------------------------------- */

export interface ExportManifestEntry {
  receiptId: string;
  /** The object's key, relative to the export's destination. */
  object: string;
  bytes: number;
  /** Hex SHA-256 of the message's **plaintext**, stamped on the object when it was staged. */
  sha256: string;
}

export interface ExportManifest {
  version: 1;
  exportId: string;
  orgId: string;
  mailboxId: string;
  matterId: string;
  predicateSha256: string;
  maxMessages: number;
  count: number;
  messages: ExportManifestEntry[];
}

export interface ExportRunOutcome {
  exportId: string;
  state: ExportState;
  /** Messages emitted by this invocation. Zero on a run that found nothing left to do. */
  emitted: number;
  /** Total across every invocation, read back from the row this call advanced. */
  messagesEmitted: number;
  pagesDone: number;
  /** True when the export reached a terminal state — completed or aborted. */
  done: boolean;
  /** Present once the manifest exists. */
  manifest: { key: string; sha256: string; count: number } | null;
  /** `max_messages` when the run aborted at its bound, else null. */
  abortedBecause: string | null;
}

/**
 * Runs **one page** of an approved export, and completes it if that page was the last.
 *
 * ## One page per invocation is the checkpoint unit
 *
 * blueprint:1276 requires outright that an export use resumable cursors. A page is what the cursor advances
 * over, so a page is what this function does — and the caller re-invokes until `done`. That is what dissolves
 * the plan arithmetic: a checkpointing run does not need to know its budget in advance, so the Paid/Free
 * split changes how many invocations an export takes rather than whether it finishes (#68).
 *
 * A page that comes back **shorter than it asked for** is the last one, so the ordinary export completes in
 * the same invocation that emits its final message rather than needing an extra call to discover there is
 * nothing left.
 *
 * ## Everything is rechecked before every page
 *
 * Three things, live, none of them cached anywhere: the requester still holds `ediscovery.export`, the
 * approval is still `approved`, and the predicate still hashes to what was approved. The last one is #62's
 * pre-execution recheck applied to the one artifact an export binds — if the stored canonical text and its
 * stored hash ever disagree, something rewrote a row underneath an approval, and the run stops rather than
 * copying mail under an authorization that no longer describes it.
 *
 * ## The bound is checked by asking for one message more than it allows
 *
 * `LIMIT min(page, remaining + 1)`. If the extra row comes back, the predicate matches more than the two
 * approvers agreed to, and the run **aborts with nothing further staged** — it does not emit the first
 * `remaining` of them and stop, because a truncated export that reports success is exactly the silent
 * over- or under-disclosure `max_messages` exists to prevent.
 *
 * ## The key cache
 *
 * One `RunKeyCache` per invocation, discarded when this function returns. Measured in
 * `docs/receipts/ediscovery-export-cost.md`: it removes the two vault RPCs a message would otherwise cost.
 * Run-scoped rather than isolate-wide, because an isolate-wide cache would make content-key revocation
 * eventually-consistent product-wide to speed up one feature.
 */
export async function runExport(
  env: Env,
  ctx: Ctx,
  orgId: string,
  who: Principal,
  exportId: string,
  options: { cache?: RunKeyCache } = {},
): Promise<ExportRunOutcome> {
  const row = await readExport(env, orgId, exportId);
  if (row === null || row.requestedBy !== who.userId) {
    // §5C, and the second clause is a decision rather than a shortcut: **only the requester may run their
    // own export**, because the copy is for them and the approval named them. Somebody else running it would
    // stage bytes against an authorization that did not mention them, and the trail would say the requester
    // took a copy they never asked to take. It answers as absent for the same reason every other refusal
    // here does — an export id discloses that somebody is investigating a mailbox.
    // `E_NO_SUCH_EXPORT` rather than `E_NO_EXPORT`, which `COMPLETING_EFFECT.ediscovery_export.missing`
    // already owns for the opposite situation — an approval naming an export row that vanished, which is an
    // investigate-the-database answer rather than a §5C refusal. One stable code has to mean one thing, or
    // the agent reading it cannot tell which of the two remedies applies.
    throw notFound("E_NO_SUCH_EXPORT", {
      what: `${exportId} is not an export you may run`,
      why: "an export is run by the person it was approved for; §5C keeps an export that is not yours and "
        + "one that does not exist answering alike",
      fix: "check the export id, or ask for your own export — POST /api/exports",
    });
  }

  if (!RESUMABLE.includes(row.state)) {
    throw conflict("E_EXPORT_SETTLED", {
      what: `export ${exportId} is ${row.state}, so there is nothing left to run`,
      why: row.state === "completed"
        ? "a completed export has its manifest; running it again would restage bytes under an approval that "
          + "has already been spent"
        : `this run stopped at ${row.stateReason ?? "an unrecorded reason"} and an aborted export is `
          + "terminal — the bound is what the two approvers agreed to, so exceeding it needs a fresh "
          + "approval rather than a retry",
      // The manifest, by the route that actually exists. There is deliberately no `GET /api/exports/:id`:
      // the listing is `GET /api/exports` and it is `org.admin` only, because it names who is taking copies
      // of whose mailbox under which matter. What the requester has is the manifest, which names every
      // object this export staged — so pointing at it is both true and the thing they wanted.
      fix: row.state === "completed"
        ? `GET /api/exports/${exportId}/objects/manifest.json names every object this export staged`
        : "ask for a new export with a bound that fits, or a narrower predicate — POST /api/exports",
    });
  }

  // ---- the per-page recheck ----------------------------------------------------------------
  if (row.approvalState !== "approved") {
    throw conflict("E_EXPORT_NOT_APPROVED", {
      what: `export ${exportId} is not approved (its approval is `
        + `${row.approvalState ?? "missing"}), so it copied nothing`,
      why: "§7 makes an export dual-controlled: the approval is the authority and it is re-read before "
        + "every page, so a request that has not been decided, was denied, or was withdrawn from produces "
        + "no bytes at all rather than a partial copy",
      fix: "GET /api/approvals shows the request to the two people who can decide it",
    });
  }
  if (!(await mayExportBulk(env, who, row.mailboxId))) {
    // §7's "revocation terminates export jobs", and this is the line that makes it true rather than a claim:
    // the relation is re-read here on **every** page, so revoking it stops a running export mid-file.
    throw conflict("E_EXPORT_REVOKED", {
      what: `you no longer hold ediscovery.export on mailbox ${row.mailboxId}, so export ${exportId} stopped`,
      why: "§7 requires revocation to terminate export jobs, so the authority is re-read before every page "
        + "rather than trusted from the approval — whatever has already been staged stays, and no further "
        + "message is copied",
      fix: "ask an administrator to grant ediscovery.export again, then run the export again; it resumes "
        + "from its cursor rather than starting over",
    });
  }
  const rehashed = await predicateHash(canonicalPredicate(row.predicate));
  if (rehashed !== row.predicateSha256) {
    // #62's pre-execution recheck, applied to the one artifact an export binds. Not reachable through the
    // product — nothing updates `predicate` — which is exactly why it is here: if it ever fires, a row moved
    // underneath an approval, and copying mail on the strength of that approval would be a disclosure
    // nobody agreed to.
    throw conflict("E_EXPORT_PREDICATE_CHANGED", {
      what: `export ${exportId} now hashes to ${rehashed}, and its approval bound ${row.predicateSha256}`,
      why: "§18 binds an approval to the artifact hashes it names, and #62 makes that a check before the act "
        + "rather than at the moment of approval. A predicate that no longer hashes to what two people "
        + "agreed to is not the export they approved",
      fix: "investigate; nothing in this Node updates a predicate, so this means the row was changed "
        + "outside the product. Ask for a fresh export rather than running this one",
    });
  }

  // ---- the page ------------------------------------------------------------------------------
  const remaining = row.maxMessages - row.messagesEmitted;
  const limit = Math.min(PAGE_SIZE, remaining + 1);
  const page = await messagePage(env, orgId, row, limit);
  const at = new Date(ctx.now()).toISOString();

  if (page.length > remaining) {
    return abortAtBound(env, ctx, orgId, row, at);
  }

  const cache = options.cache ?? runKeyCache();
  for (const message of page) {
    // Read, then re-seal under this Node's current key, into the export's own prefix. The key is the
    // receipt id, so a page replayed after a lost race overwrites its own identical object rather than
    // staging a second copy of one message.
    const plaintext = await getEvidence(env, message.blob_key, cache);
    await putEvidence(env, `${row.destination}${message.id}.eml`, plaintext, {
      cache,
      // Stamped here so the manifest can be built from one `list()` with `include: ["customMetadata"]`
      // instead of one `get` per message — which is what keeps the manifest build a fixed cost rather than
      // a second pass over the whole export.
      metadata: { sha256: await sha256Hex(plaintext), receiptId: message.id },
    });
  }

  const cursor = page.length === 0 ? row.cursorAfter : cursorFor(page[page.length - 1]!);

  /*
   * Advance the checkpoint, gated on the cursor **not having moved**.
   *
   * Compare-and-swap rather than a blind update (#9, the conflict is the signal): two invocations running
   * the same export would otherwise each add their page's count, double-counting messages that were staged
   * once. The loser's objects are already written and are byte-identical — the key is the receipt id and
   * the plaintext is the same mail — so a lost race costs subrequests and never correctness.
   *
   * `IS` rather than `=`, because the first page's cursor is NULL and `NULL = NULL` is not true in SQL.
   */
  const advanced = await env.CATALOG.prepare(
    `UPDATE exports
        SET state = 'running', started_at = COALESCE(started_at, ?), cursor_after = ?,
            pages_done = pages_done + 1, messages_emitted = messages_emitted + ?
      WHERE org_id = ? AND id = ? AND ${RESUMABLE_SQL} AND cursor_after IS ?`,
  ).bind(at, cursor, page.length, orgId, exportId, row.cursorAfter).run();

  if ((advanced.meta.changes ?? 0) === 0) {
    // `E_EXPORT_PAGE_RACED`, not `E_EXPORT_RACED`: the latter is the code
    // `COMPLETING_EFFECT.ediscovery_export.raced` already emits when a *decision* loses its race, and the two
    // remedies differ — run the export again here, look at who withdrew there.
    throw conflict("E_EXPORT_PAGE_RACED", {
      what: `export ${exportId} moved while this page was being staged, so its progress was not advanced`,
      why: "the checkpoint is advanced with a compare-and-swap on the cursor, so two invocations of one "
        + "export cannot both count the same page. Whatever this call staged is byte-identical to what the "
        + "winner staged, because the object key is the receipt id",
      fix: "run the export again; it resumes from whichever cursor won",
    });
  }

  const emitted = row.messagesEmitted + page.length;
  // A short page is the last page. Completing here rather than on a further invocation is what makes an
  // ordinary export one call rather than two.
  if (page.length < limit) {
    return completeExport(env, ctx, orgId, row, emitted, cache, at);
  }

  return {
    exportId,
    state: "running",
    emitted: page.length,
    messagesEmitted: emitted,
    pagesDone: row.pagesDone + 1,
    done: false,
    manifest: null,
    abortedBecause: null,
  };
}

interface MessageRow {
  id: string;
  blob_key: string;
  accepted_at: string;
}

/**
 * One page of the predicate's matches, ordered so the cursor is total.
 *
 * `(accepted_at, id)` rather than `accepted_at` alone: two messages accepted in the same millisecond are
 * ordinary, and a cursor on the timestamp alone would either skip one of them or replay it for ever. The
 * cursor is the two concatenated with a space, which sorts correctly because a space is below every
 * character an ISO-8601 instant or a Crockford ULID can contain — asserted in the export tests rather than
 * asserted here, because it is a property of two encodings rather than of this line.
 *
 * `instr(lower(...), lower(?))` rather than `LIKE '%'||?||'%'`, deliberately: `LIKE` would make `%` and `_`
 * in somebody's search string into wildcards, so the predicate that was hashed and the set it matches would
 * differ from what the approvers read. A substring match means what it says.
 */
/*
 * Named `messagePage` since #46 and **private to this file**, which is why the newer public reader of the
 * inbox URL is `messagePageRequest` rather than sharing this name. Two functions called `messagePage` in one
 * Worker meaning different things — one parses a URL into a page request, one executes a page of SQL — is the
 * kind of near-collision AGENTS.md rule 4 is about, and `case_`/`cas_` is what it costs when nobody notices.
 */
async function messagePage(
  env: Env,
  orgId: string,
  row: ExportRow,
  limit: number,
): Promise<MessageRow[]> {
  const { predicate } = row;
  const { results } = await env.CATALOG.prepare(
    `SELECT r.id, r.blob_key, r.accepted_at
       FROM ingress_receipts r
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
       LEFT JOIN messages m ON m.ingress_receipt_id = r.id
      WHERE r.org_id = ? AND a.mailbox_id = ?
        AND (? IS NULL OR r.accepted_at >= ?)
        AND (? IS NULL OR r.accepted_at <= ?)
        AND (? IS NULL OR instr(lower(COALESCE(m.subject, '')), lower(?)) > 0)
        AND (? IS NULL OR (r.accepted_at || ' ' || r.id) > ?)
      ORDER BY r.accepted_at, r.id
      LIMIT ?`,
  ).bind(
    orgId, predicate.mailboxId,
    predicate.fromDate, predicate.fromDate,
    predicate.toDate, predicate.toDate,
    predicate.subjectContains, predicate.subjectContains,
    row.cursorAfter, row.cursorAfter,
    limit,
  ).all<MessageRow>();
  return results;
}

function cursorFor(message: MessageRow): string {
  return `${message.accepted_at} ${message.id}`;
}

/**
 * Stops the run at its bound: nothing further staged, a terminal state, and an entry saying so.
 *
 * Aborting rather than truncating is the decision `max_messages` exists for. A truncated export would be a
 * partial copy carrying a manifest that read as a complete account of the predicate's matches, which is the
 * worst of the three available outcomes — worse than refusing, and worse than exporting too much, because it
 * is the only one that misleads.
 */
async function abortAtBound(
  env: Env,
  ctx: Ctx,
  orgId: string,
  row: ExportRow,
  at: string,
): Promise<ExportRunOutcome> {
  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "supervised.export_aborted",
      outcome: "refused",
      actorUserId: row.requestedBy,
      subject: row.id,
      detail: {
        exportId: row.id,
        mailboxId: row.mailboxId,
        matterId: row.matterId,
        maxMessages: row.maxMessages,
        messagesEmitted: row.messagesEmitted,
        reason: "max_messages",
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `UPDATE exports SET state = 'aborted', state_reason = 'max_messages', completed_at = ?
          WHERE org_id = ? AND id = ? AND ${RESUMABLE_SQL}`,
      ).bind(at, orgId, row.id),
    ],
    TERMINAL_GATE(orgId, row.id),
  );

  // Loud, in the four-part shape, because this is a budget a person can hit and therefore one they must see
  // (AGENTS.md principle 3). The objects already staged are left in place: they were legitimately exported
  // under the same approval, and deleting them would destroy evidence in a matter.
  throw conflict("E_EXPORT_BOUND_EXCEEDED", {
    what: `max_messages=${row.maxMessages}, and export ${row.id} matches more than that`,
    why: "the approval binds a predicate hash and a count, and exceeding the count aborts rather than "
      + "exporting more than anyone agreed to or truncating to the bound and reporting success. "
      + `${row.messagesEmitted} message(s) were staged before this stopped and they are left in place`,
    fix: "ask for a fresh export with a bound that fits, or a narrower window — POST /api/exports. Two "
      + "approvers have to agree to the new bound, which is the point",
  });
}

/**
 * Builds the manifest, seals it, and closes the export — all in the invocation that emitted the last page.
 *
 * The manifest is its own sealed object plus the `exports` row's hash of it, and the audit entry carries the
 * hash and the count and nothing else. That split is what keeps `supervised.export_completed` far inside
 * `audit.max_detail_bytes` even at the tight bound #69 measured: the list of message ids lives in the
 * manifest, and the entry names the manifest.
 *
 * **The hash is over the manifest plaintext**, not over the sealed object. Sealing uses a random nonce, so
 * the sealed bytes differ on every write and a hash over them could not be re-derived by anybody verifying
 * the export later. `ingress_receipts.blob_sha256` makes the same choice for the same reason.
 */
async function completeExport(
  env: Env,
  ctx: Ctx,
  orgId: string,
  row: ExportRow,
  emitted: number,
  cache: RunKeyCache,
  at: string,
): Promise<ExportRunOutcome> {
  /*
   * **The listing is paged, and it has to be**, because a metadata listing is not the same call as a plain
   * one. `r2.list_max_keys_per_call` is 1,000 for a bare `list()`, but Cloudflare documents that *"if you
   * request data you may receive fewer than `limit` results in your response to accommodate metadata"* and
   * says to read `truncated` rather than compare counts — and measured against workerd, a listing with
   * `include: ["customMetadata"]` returns at most `r2.list_max_keys_with_metadata` keys however large a
   * `limit` it is given. See `docs/receipts/r2-list-page-size.md`.
   *
   * A single call was therefore never able to name a 1,000-message export: it named the first hundred and
   * came back `truncated`, so every export above that staged its bytes and then refused to complete for ever
   * — a hundred copies of somebody's mail in R2 with no manifest and no completion entry, and an error
   * blaming the authorization for a bound the code itself had allowed.
   *
   * Paging is not the "unreliable workaround" blueprint:1280 warns about: the cursor is the documented way
   * to finish a listing, it costs one subrequest per hundred objects **once**, at completion, and the build
   * is idempotent — an invocation that dies mid-manifest leaves the export `running`, and the next one finds
   * an empty page and rebuilds the whole manifest from R2. The boundary is still named, and now it is named
   * at a number this Node can actually honour.
   */
  const messages: ExportManifestEntry[] = [];
  // The export's own objects plus its manifest, which exists on a rebuild. Derived from the ceiling rather
  // than chosen, so raising one raises the other and the refusal below stays unreachable by construction.
  const keyBudget = MAX_MESSAGES_CEILING + 1;
  let seen = 0;
  let cursor: string | undefined;
  let truncated = false;
  for (;;) {
    const listed: R2Objects = await env.EVIDENCE.list({
      prefix: row.destination,
      limit: BUDGETS["r2.list_max_keys_with_metadata"],
      include: ["customMetadata"],
      ...(cursor === undefined ? {} : { cursor }),
    });
    seen += listed.objects.length;
    for (const object of listed.objects) {
      const name = object.key.slice(row.destination.length);
      if (name === MANIFEST_NAME) continue;
      messages.push({
        receiptId: object.customMetadata?.receiptId ?? name.replace(/\.eml$/, ""),
        object: name,
        bytes: object.size,
        // Stamped at staging time. Absent would mean an object this Node did not stage, which is a state the
        // reconciler reports rather than one the manifest may paper over with an empty string — so it says so.
        sha256: object.customMetadata?.sha256 ?? "unknown",
      });
    }
    if (!listed.truncated) break;
    /*
     * Two ways to stop early, and neither may be a call count.
     *
     * `seen` is the bound that matters and it rises by at least one every iteration, so this terminates in
     * at most `keyBudget` passes without assuming anything about how many keys a page carries — which is the
     * assumption that produced the defect this loop replaced. A page of **zero** that still says `truncated`
     * is a runtime that cannot make progress, and refusing loudly is the honest answer to it; silently
     * spinning inside one invocation would be the worst of the three.
     */
    if (seen >= keyBudget || listed.objects.length === 0) {
      truncated = true;
      break;
    }
    cursor = listed.cursor;
  }

  if (truncated) {
    // Unreachable while `max_messages` is refused above `export.max_messages_ceiling` at request time, and
    // kept as the layer that holds if that ever stops being true. A short manifest would read as a complete
    // account of what was disclosed, which is the one failure this whole mechanism may not have.
    throw conflict("E_EXPORT_MANIFEST_TRUNCATED", {
      what: `export ${row.id} staged more than ${keyBudget} objects, so its manifest cannot name all of them`,
      why: "the manifest is built by paging one listing of the export's own prefix, and the paging stops at "
        + `export.max_messages_ceiling=${MAX_MESSAGES_CEILING} objects plus the manifest's own. A manifest `
        + "that omitted messages would be worse than none, because it reads as a complete account",
      fix: `export.max_messages_ceiling=${MAX_MESSAGES_CEILING} is supposed to make this unreachable — `
        + "investigate how this export was authorized above it. Receipt: "
        + "docs/receipts/ediscovery-export-cost.md",
    });
  }

  const manifest: ExportManifest = {
    version: 1,
    exportId: row.id,
    orgId,
    mailboxId: row.mailboxId,
    matterId: row.matterId,
    predicateSha256: row.predicateSha256,
    maxMessages: row.maxMessages,
    count: messages.length,
    messages,
  };
  // Written out field by field for `canonicalPredicate`'s reason: a hash whose input depends on property
  // order changes when somebody reorders an interface. `list()` returns keys in lexical order, so the
  // message array is deterministic without a sort of its own — and asserted in the export tests.
  const canonical = JSON.stringify({
    version: manifest.version,
    exportId: manifest.exportId,
    orgId: manifest.orgId,
    mailboxId: manifest.mailboxId,
    matterId: manifest.matterId,
    predicateSha256: manifest.predicateSha256,
    maxMessages: manifest.maxMessages,
    count: manifest.count,
    messages: manifest.messages.map((entry) => ({
      receiptId: entry.receiptId, object: entry.object, bytes: entry.bytes, sha256: entry.sha256,
    })),
  });
  const bytes = utf8(canonical);
  const manifestSha256 = await sha256Hex(bytes);
  const manifestKey = `${row.destination}${MANIFEST_NAME}`;
  await putEvidence(env, manifestKey, bytes, { cache });

  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "supervised.export_completed",
      outcome: "ok",
      actorUserId: row.requestedBy,
      subject: row.id,
      detail: {
        exportId: row.id,
        manifestSha256,
        count: messages.length,
        destination: row.destination,
        matterId: row.matterId,
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `UPDATE exports SET state = 'completed', completed_at = ?, manifest_key = ?, manifest_sha256 = ?
          WHERE org_id = ? AND id = ? AND ${RESUMABLE_SQL}`,
      ).bind(at, manifestKey, manifestSha256, orgId, row.id),
    ],
    TERMINAL_GATE(orgId, row.id),
  );

  return {
    exportId: row.id,
    state: "completed",
    emitted: emitted - row.messagesEmitted,
    messagesEmitted: emitted,
    pagesDone: row.pagesDone + 1,
    done: true,
    manifest: { key: manifestKey, sha256: manifestSha256, count: messages.length },
    abortedBecause: null,
  };
}

/* ---- downloading ------------------------------------------------------------------------------ */

/**
 * Authorizes one staged object, **re-asking everything on every request**.
 *
 * This is the half of the design that makes §7's *"revocation terminates export jobs"* real. A presigned URL
 * would have been a capability outliving the grant that minted it — and the Workers R2 binding has no
 * presign method anyway, which is how the decision got made for us. What exists instead is a route, and a
 * route can ask again: revoke `ediscovery.export`, and the very next object 404s while the ones already
 * downloaded stay downloaded. That is an honest boundary rather than a promise to un-copy bytes.
 *
 * `name` is matched against a conservative character class rather than sanitised, because the alternative is
 * a normalisation that has to be right about every encoding a client can send. An object name this Node
 * stages is a receipt id plus `.eml`, or `manifest.json`; anything else is refused before it can become a
 * key.
 */
export async function authorizeExportObject(
  env: Env,
  orgId: string,
  who: Principal,
  exportId: string,
  name: string,
): Promise<{ ok: true; blobKey: string } | { ok: false; response: Response }> {
  const missing = {
    ok: false as const,
    response: Response.json(
      { error: "not_found", message: "No such export object, or you do not have access to it." },
      { status: 404 },
    ),
  };

  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes("..")) return missing;

  const row = await readExport(env, orgId, exportId);
  if (row === null || row.requestedBy !== who.userId) return missing;
  if (row.approvalState !== "approved") return missing;
  // The live relation, re-read per object. Nothing here is cached, which is the whole mechanism.
  if (!(await mayExportBulk(env, who, row.mailboxId))) return missing;

  const blobKey = `${row.destination}${name}`;
  if ((await env.EVIDENCE.head(blobKey)) === null) return missing;
  return { ok: true, blobKey };
}
