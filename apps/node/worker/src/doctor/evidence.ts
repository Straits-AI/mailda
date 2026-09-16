import type { Ctx } from "@mailda/runtime";
import { bodyIndexState, unindexedMessages } from "../search.ts";
import { draftBodyPrefix, reconcileEvidence, type DraftBodyScan } from "../reconcile.ts";
import { type Finding } from "../doctor.ts";
/**
 * Is the outbox draining? An unpublished row older than the sweeper's own staleness cutoff means
 * the Durable Object alarm is not firing, and §22's guarantee is that events are *eventually*
 * delivered — a stalled outbox turns "eventually" into "never" without any error anywhere.
 */
export async function checkOutbox(env: Env, ctx: Ctx): Promise<Finding[]> {
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
export const STALLED_OUTBOX_MS = 10 * 60 * 1000;


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
export interface EvidenceCheck {
  findings: Finding[];
  draftBodies: DraftBodyScan | null;
}


export async function checkEvidence(env: Env, ctx: Ctx, orgId: string | null): Promise<EvidenceCheck> {
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
export function strandedDraftBodyFindings(scan: DraftBodyScan | null): Finding[] {
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
export async function checkEvidenceChanged(env: Env, orgId: string | null): Promise<Finding[]> {
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
export async function checkSearchIndex(env: Env, orgId: string | null): Promise<Finding[]> {
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

  const bodies = await bodyIndexState(env).catch(() => null);

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
  }, {
    /*
     * The body index's backlog, reported separately from the subject index's (#107 L2).
     *
     * **Two findings rather than one number**, because the two backfills have different costs and different
     * failure modes and an operator watching a single figure could not tell which was stuck. The subject
     * index catches up 500 messages a minute from one D1 statement; this one reads R2, unwraps a key,
     * decrypts and parses per message, doing 25 — so on any real archive it falls twenty times more slowly,
     * and a combined number would look alarming while nothing was wrong.
     */
    check: "body_index_backlog",
    severity: "report",
    discloses: "infrastructure",
    ok: true,
    detail: bodies === null
      ? "The catalog could not be read, so this report cannot say how much mail is searchable by its contents."
      : bodies.pending === 0
        ? "Every message on this Node has been through the body index."
        : `${bodies.pending} message(s) have not been through the body index yet, so a search will not match `
          + "words in their text. Their subjects and senders are searchable and they are reachable by "
          + "paging. The scheduled backfill settles 25 a minute — it reads and decrypts each message, which "
          + "is why it is slower than the subject index's.",
    fix: bodies === null || bodies.pending === 0
      ? undefined
      : "nothing — this falls on its own, slowly. If it stops falling, check the logs for "
        + "`search.body_backfill_failed`",
  }, {
    /*
     * Messages the body index **failed** on, which is a different question from how much is left (0044).
     *
     * The previous design had one "finished" timestamp, so a message whose evidence could not be fetched was
     * settled exactly like one that had no body — permanently unsearchable by its text, with no record of
     * why and no supported repair. This finding is the visible half of fixing that: `retryable` is a Node
     * working through a transient problem, `unindexable` is one that has stopped trying or cannot parse.
     *
     * `degraded` only for `unindexable`. A retryable message is not a fault — it is a Node doing what it was
     * built to do, and reporting it red would train an operator to ignore the finding during exactly the
     * incident it exists for.
     */
    check: "body_index_failed",
    severity: bodies !== null && bodies.unindexable > 0 ? "degraded" : "report",
    discloses: "infrastructure",
    ok: bodies === null || bodies.unindexable === 0,
    detail: bodies === null
      ? "The catalog could not be read, so this report cannot say whether the body index has failed on "
        + "anything."
      : bodies.unindexable === 0 && bodies.retryable === 0
        ? "The body index has failed on nothing."
        : `${bodies.unindexable} message(s) the body index has given up on and ${bodies.retryable} it is `
          + "still retrying. A message it gave up on is unsearchable by its text and is otherwise "
          + "untouched — listed, readable, and findable by subject and sender. Some are simply unparseable "
          + "and will stay that way; the rest are reads that failed on every attempt and are worth retrying "
          + "once whatever broke is fixed.",
    fix: bodies === null || bodies.unindexable === 0
      ? undefined
      : "`mailda search repair` lists them with the reason each failed and puts them back in the queue. "
        + "Fix the cause first — a repair that runs into the same failure spends its attempts again",
  }];
}
