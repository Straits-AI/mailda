import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { exportsPrefix } from "./exports.ts";
import { anyActiveHold } from "./holds.ts";
import { sentPrefix } from "./outbound/manifest.ts";

/**
 * Evidence reconciliation (§13, §24).
 *
 * `ingress.ts` writes R2 before D1 deliberately, so the only reachable partial state is an **orphan
 * blob** rather than a message row pointing at nothing — §24 calls "accepted but absent" the most
 * dangerous failure in mail. That ordering has been in place since Layer 1; what did not exist was
 * anything to collect the orphans or to report the other direction. The `E_EVIDENCE_MISSING` error
 * has named this file as the fix the whole time.
 *
 * The two directions are **not symmetric**, and treating them alike is the mistake to avoid:
 *
 *   object, no referent  — a write that lost its transaction, or content whose row has been deleted.
 *                          Safe to delete after a grace period. Costs storage, reveals nothing.
 *   referent, no object  — **lost mail.** Never repaired, never tidied away, never resolved by
 *                          deleting the receipt. Enumerated and reported so a human decides.
 *
 * Deleting the receipt would turn a detectable data loss into an undetectable one, which is the worst
 * available outcome and also the tempting one, because it makes the report go green.
 *
 * ## Four prefixes, four referent rules, one delete (#67, #65, #74)
 *
 * `${orgId}/raw/` holds accepted mail, whose referent is a row in `ingress_receipts`. `${orgId}/drafts/`
 * holds draft bodies, whose referent is a row in `drafts` keyed by `body_key` — so **"no receipt" is not
 * the test for a draft body**, and that is why widening one listing was never the whole repair.
 * `${orgId}/exports/` holds eDiscovery exports (#65), whose referent is a row in `exports` **keyed by the
 * id in the key's own second segment** — a third rule again, and "no receipt" is not the test for one of
 * those either. `${orgId}/sent/` holds staged composition and submission evidence (#74), whose referent is a
 * row in `send_manifests` keyed by the id in the key's second segment — the fourth rule, argued at
 * `scanSentObjects` below rather than copied from the third one it happens to share a key shape with.
 *
 * The prefixes are scanned by different rules and then **collected by the same loop**. That is
 * deliberate: `EVIDENCE.delete` below is still the only call in the product that destroys content
 * *bytes*, so the allowlist in `test/node/content-deletion-world.test.ts` stays at one entry, which is the
 * property that tripwire exists to protect. A second delete site would be a second thing to remember to
 * put a hold in front of.
 *
 * **These four are every prefix this Worker writes**, and that is now a checked property rather than a
 * sentence: `test/node/evidence-prefix-world.test.ts` derives the written set from `src/` and fails if
 * `scannedPrefixes` does not cover it. #67 and #74 are the same defect in two places — a prefix nothing
 * listed, whose cost was invisible precisely because nothing reported it — and the third instance is what
 * that tripwire exists to prevent, since neither of the first two was found by remembering.
 *
 * #64 classified this site content-carrying and gave it the **org-wide** rule rather than a per-hold one,
 * because an unreferenced object cannot be attributed to a mailbox — see `anyActiveHold` at the top of the
 * pass. That argument covers a stranded draft body exactly as it covers an orphan: with no `drafts` row
 * there is no mailbox to test a hold against, and the key's own prefix is the organization rather than a
 * mailbox. It covers a `sent/` orphan too, and #74 re-made the argument rather than inheriting it, because a
 * `sent/` key *looks* more attributable — it carries a manifest id. See `scanSentObjects`. Enumeration and
 * reporting are unchanged while a hold stands; only the delete stops.
 */

const LIST_LIMIT = BUDGETS["reconcile.list_limit"];

/**
 * How long a blob may exist without its referent before it counts as collectable.
 *
 * It must exceed the longest possible gap between the R2 write returning and the row committing —
 * otherwise the reconciler races a write that is still in flight and deletes content that was about to be
 * referenced. Both writers order it that way for the same reason: `ingress.ts` puts evidence before the
 * receipt, and `saveDraft` puts the body before the row. A Worker invocation cannot outlive its own
 * wall-clock limit by orders of magnitude, so an hour is generous by a wide margin, and an hour of R2
 * storage for a handful of stray objects costs nothing. The asymmetry is deliberate: being slow to collect
 * is free, being fast is unrecoverable.
 */
const ORPHAN_GRACE_MS = BUDGETS["reconcile.orphan_grace_seconds"] * 1000;

/** Accepted mail. Referent: a row in `ingress_receipts`. */
function rawPrefix(orgId: string): string {
  return `${orgId}/raw/`;
}

/**
 * Draft bodies. Referent: a row in `drafts`, keyed by `body_key`.
 *
 * Exported because `doctor` reports this prefix by name and must not spell it a second time — a second
 * spelling is a second thing that can disagree, which is the shape of the defect #67 filed.
 */
export function draftBodyPrefix(orgId: string): string {
  return `${orgId}/drafts/`;
}

/**
 * Every prefix this pass lists — the one place it is written, so the report cannot claim a scope the
 * scan does not have.
 *
 * It is reported rather than merely used, because the report previously could not distinguish
 * *"nothing to collect"* from *"did not look"*. Both printed `0 orphans`. `${orgId}/drafts/` is the
 * prefix that made that ambiguity expensive: draft bodies live there, `deleteDraft` removes only the row,
 * and for a while no listing in this Worker covered it at all.
 *
 * Every entry is the same function the corresponding scan below is given, not a second description of it, so
 * a prefix named here that nothing lists would have to be a prefix nothing scans either.
 *
 * Since #74 this is also the **complete** set of prefixes this Worker writes, which is what lets
 * `formatReconcile` stop hedging about objects it did not list.
 * `test/node/evidence-prefix-world.test.ts` derives the written set from `src/` and compares it against this
 * function, so the completeness claim is enforced rather than asserted — the distinction #67 and #74 were
 * both filed over.
 */
function scannedPrefixes(orgId: string): string[] {
  return [rawPrefix(orgId), draftBodyPrefix(orgId), exportsPrefix(orgId), sentPrefix(orgId)];
}

/** One object with no live referent, in the shape both directions of this pass report it. */
export interface Unreferenced {
  blobKey: string;
  bytes: number;
  uploaded: string;
}

/**
 * Which objects under `${orgId}/drafts/` are stranded — **the one definition**, shared by this pass and by
 * `doctor`'s `draft_bodies_stranded` finding (#67).
 *
 * It is shared rather than reimplemented because two copies of "which objects are stranded" that can
 * disagree is a defect in waiting, and the disagreement would be silent in the direction that matters: the
 * diagnostic would report a count the collector then declined to act on, or the reverse. `doctor` calls
 * `reconcileEvidence` read-only already, so it reads this out of that report and lists nothing itself.
 *
 * The union is the enforcement, not a comment: a caller cannot reach `stranded` without narrowing on
 * `read`, so "0 stranded" can never stand in for "could not look". That distinction is the whole of #67.
 */
export type DraftBodyScan =
  | {
    read: "complete";
    prefix: string;
    /** Objects listed under the prefix, whatever was concluded about them. */
    examined: number;
    truncated: boolean;
    /** Inside the grace window: an autosave may be between its R2 write and its D1 commit right now. */
    tooFreshToJudge: number;
    /** Past the grace window with no `drafts` row. Deleted only when `collect` is set and no hold stands. */
    stranded: Unreferenced[];
  }
  | {
    read: "unreadable";
    prefix: string;
    /** The first line of the cause. Kept, because a report that says only "could not read" is a symptom. */
    because: string | null;
  };

/**
 * The scan itself. Throws rather than catching: the caller decides what an unreadable prefix means, and
 * `reconcileEvidence` is the one place that decides it.
 *
 * Two calls, fixed, regardless of how many objects the listing returns: one `R2Bucket.list()` for the page
 * and **one** `SELECT body_key` for every live referent at once. The bulk query is why adding this prefix
 * costs two subrequests rather than two hundred — the raw direction spends one D1 lookup per object because
 * it samples by key. Both halves of that are measured in `docs/receipts/evidence-lifecycle.md`'s correction
 * headed *"the pass gained a second prefix"*: this scan costs 2 subrequests at 0 stranded bodies and 2 at
 * five, while five raw objects with no receipt cost five extra D1 executions. The same correction derives what
 * a *full* pass can now reach — `(n + 2) × reconcile.list_limit + (2n + 2)` over `n` prefixes — and
 * `test/evidence-lifecycle.test.ts` asserts that arithmetic stays under the Workers Free subrequest ceiling,
 * because `list_limit` bounds each prefix separately and every prefix added raises the worst case by two
 * `list_limit`s. #65's third prefix is what forced the figure to be re-derived rather than re-read: at a
 * `list_limit` of 200 it comes to **1,008**, which is *over* the Free ceiling of 1,000, so that receipt's
 * 20 August correction lowers the limit instead of letting the assertion start lying.
 *
 * The referent query deliberately has **no LIMIT**. A partial set of referents would report a *live*
 * draft's body as stranded, and under `collect` that is not a false accusation, it is a deletion of
 * somebody's unfinished writing. It is bounded in practice by what it reads: one column of `drafts`, which
 * is working state deleted at seal, so it grows with drafts in progress rather than with mail volume.
 *
 * That claim was unenforced until 19 August 2026, and it is the most expensive one in this file to get wrong:
 * `LIMIT 1` here passed all 481 tests, because every fixture set up exactly one live draft and so could not
 * tell a first row from every row. `test/stranded-draft-bodies.test.ts` — *"spares every live draft, not just
 * one, because the referent read is not paged"* — now collects against **three** live drafts and one residue.
 *
 * **What that test bounds is stated rather than implied**, because a tripwire hiding its boundary is what this
 * file keeps finding defects in. It fails for any limit below three; it cannot prove the absence of a limit,
 * since a larger one needs a larger fixture and no count settles every number. Three is past the one that
 * already slipped through, and the realistic regression — `.all()` traded for a cursor, or a row cap
 * discovered at scale — truncates at any plurality rather than at a chosen literal.
 */
export async function scanDraftBodies(env: Env, ctx: Ctx, orgId: string): Promise<DraftBodyScan> {
  const prefix = draftBodyPrefix(orgId);
  const listed = await env.EVIDENCE.list({ prefix, limit: LIST_LIMIT });

  const referenced = await env.CATALOG.prepare(
    "SELECT body_key FROM drafts WHERE org_id = ? AND body_key IS NOT NULL",
  ).bind(orgId).all<{ body_key: string }>();
  const live = new Set(referenced.results.map((row) => row.body_key));

  const cutoff = ctx.now() - ORPHAN_GRACE_MS;
  const stranded: Unreferenced[] = [];
  let tooFreshToJudge = 0;
  for (const object of listed.objects) {
    if (live.has(object.key)) continue;
    if (object.uploaded.getTime() > cutoff) {
      tooFreshToJudge += 1;
      continue;
    }
    stranded.push({
      blobKey: object.key,
      bytes: object.size,
      uploaded: object.uploaded.toISOString(),
    });
  }

  return {
    read: "complete",
    prefix,
    examined: listed.objects.length,
    truncated: listed.truncated,
    tooFreshToJudge,
    stranded,
  };
}

/**
 * Which objects under `${orgId}/exports/` have no `exports` row behind them (#65).
 *
 * The same union shape as `DraftBodyScan`, and for the same reason: a caller cannot reach `stranded` without
 * narrowing on `read`, so *"0 stranded"* can never stand in for *"could not look"*. That distinction is the
 * whole of #67 and it is worth having twice rather than sharing a type that would have to be generic in the
 * referent to say anything useful.
 *
 * **The referent rule is the third one in this file.** An export object's key is
 * `${orgId}/exports/${exportId}/<name>`, so the referent is an `exports` row whose id is the second segment
 * — not a receipt, and not a row keyed by the object's full key the way a draft body is. An export stages
 * many objects under one row, which is why the id has to be cut out of the key rather than looked up whole.
 *
 * A stranded export object is **rare by construction and therefore worth reporting loudly**: the `exports`
 * row is written at request time, before the approval exists and long before any object is staged, so an
 * object with no row means the row went away. Nothing in this product deletes one.
 */
export type ExportObjectScan =
  | {
    read: "complete";
    prefix: string;
    examined: number;
    truncated: boolean;
    /** Inside the grace window: a page may be between its R2 write and its D1 checkpoint right now. */
    tooFreshToJudge: number;
    /** Past the grace window with no `exports` row. Deleted only when `collect` is set and no hold stands. */
    stranded: Unreferenced[];
  }
  | { read: "unreadable"; prefix: string; because: string | null };

/**
 * The export half of direction 1.
 *
 * Two calls, fixed, whatever the listing returns: one `R2Bucket.list()` and **one** `SELECT id FROM exports`
 * for every live referent at once — the same bulk shape `scanDraftBodies` uses, and the reason adding this
 * prefix costs two subrequests rather than two hundred. The raw direction still spends one D1 lookup per
 * object because it samples by key; this one cannot, because many objects share one row.
 *
 * The referent query deliberately has **no LIMIT**, for `scanDraftBodies`'s reason, which is sharper here: a
 * partial set of referents would report a *live* export's staged objects as stranded, and under `collect`
 * that is not a false accusation, it is the destruction of evidence in an open matter. It is bounded in
 * practice by what it reads — one column of `exports`, one row per export ever asked for, which grows with
 * investigations rather than with mail volume.
 */
export async function scanExportObjects(env: Env, ctx: Ctx, orgId: string): Promise<ExportObjectScan> {
  const prefix = exportsPrefix(orgId);
  const listed = await env.EVIDENCE.list({ prefix, limit: LIST_LIMIT });

  const referenced = await env.CATALOG.prepare(
    "SELECT id FROM exports WHERE org_id = ?",
  ).bind(orgId).all<{ id: string }>();
  const live = new Set(referenced.results.map((row) => row.id));

  const cutoff = ctx.now() - ORPHAN_GRACE_MS;
  const stranded: Unreferenced[] = [];
  let tooFreshToJudge = 0;
  for (const object of listed.objects) {
    // `${orgId}/exports/${exportId}/<name>` — the id is the segment after the prefix. A key with no slash
    // after the prefix has no export id in it at all, so it belongs to no row by definition and is treated
    // as stranded rather than skipped: skipping it would leave an object this pass can see and never
    // collect, which is the shape #67 filed.
    const rest = object.key.slice(prefix.length);
    const exportId = rest.slice(0, rest.indexOf("/"));
    if (exportId !== "" && live.has(exportId)) continue;
    if (object.uploaded.getTime() > cutoff) {
      tooFreshToJudge += 1;
      continue;
    }
    stranded.push({
      blobKey: object.key,
      bytes: object.size,
      uploaded: object.uploaded.toISOString(),
    });
  }

  return {
    read: "complete",
    prefix,
    examined: listed.objects.length,
    truncated: listed.truncated,
    tooFreshToJudge,
    stranded,
  };
}

/**
 * Which objects under `${orgId}/sent/` have no `send_manifests` row behind them (#74).
 *
 * The same union shape as the two scans above, for the reason they each have it: a caller cannot reach
 * `stranded` without narrowing on `read`, so *"0 stranded"* can never stand in for *"could not look"*.
 *
 * ## The referent rule, which is the fourth in this file and the decision #74 was filed to take
 *
 * A send stages three objects — `typed.txt` and `normalized.txt` at seal, `submitted.eml` at hand-over — all
 * under `${orgId}/sent/${manifestId}/`. So the referent is a `send_manifests` row whose `id` is the key's
 * **second segment**, and the lookup is per *manifest* rather than per *object*: three objects resolve to one
 * row, exactly as an export's many objects resolve to one `exports` row.
 *
 * That is the same key shape as `exports/`, and it is deliberately **not** the same argument. The rule was
 * chosen for what the state means, not for what the key looks like:
 *
 *   - **Nothing in this product deletes a `send_manifests` row.** Not `cancelSend`, which moves `state` to
 *     `cancelled` and touches neither R2 nor the row's existence; not retention, which has no sweep here;
 *     nothing. `test/node/content-deletion-world.test.ts` is the closed world that keeps that true. So an
 *     object here with no row is only reachable through a **lost transaction** — `sealManifest` writes both
 *     bodies to R2 before the `INSERT`, deliberately, for `ingress.ts`'s reason.
 *   - That is the `raw/` story, not the `drafts/` one. A stranded draft body is the *ordinary residue* of a
 *     sent message and happens on the happy path; a stranded `sent/` object is an anomaly. So this takes the
 *     **orphan rule**: the grace window, and #64's org-wide hold suppression.
 *   - **A cancelled or withheld send is not residue at all.** Its manifest row is still there, so its three
 *     objects are *referenced*, and this scan never reaches them. That is asserted in
 *     `test/sent-evidence.test.ts` rather than assumed, because it is the assumption whose failure would
 *     destroy the composition evidence §12 invariant 2 calls immutable.
 *
 * ## The query's shape, and why it is not the unbounded read the other two use
 *
 * `scanDraftBodies` and `scanExportObjects` each read **one whole column** of their referent table with no
 * `LIMIT`, and both justify it by what the table is: `drafts` is working state deleted at seal, `exports`
 * grows with investigations. Neither reason survives here. `send_manifests` grows with **every message this
 * Node has ever sent, for ever**, so the same shape would be a table scan that gets slower for the whole life
 * of the Node — a landmine in exactly AGENTS.md's sense, correct on the day it is typed.
 *
 * So the referents are bounded by **the page's own id span**: the smallest and largest manifest id appearing
 * in this listing, as one `BETWEEN` over the primary key. Still one query, still flat in the number of
 * objects, and the completeness argument is *stronger* than a whole-column read rather than weaker — every id
 * this page will judge lies between the minimum and maximum of that same set, by construction. It does not
 * depend on R2 returning keys in order, and it cannot return a partial set of the referents that matter, which
 * is the failure a `LIMIT` would cause: a live manifest's `submitted.eml` reported as stranded, and under
 * `collect`, deleted.
 *
 * The bound it does not give: if a page's ids happen to span the whole table, it reads the whole column, so
 * this is **never worse than the other two and usually far better** — it is not a constant. Saying which is
 * the point; a bound whose limit is unstated is the thing this file keeps finding.
 *
 * An empty page asks nothing at all, because the minimum of no ids does not exist. That is why this scan
 * costs 1 subrequest on a Node that has never sent and 2 on one that has.
 */
export type SentObjectScan =
  | {
    read: "complete";
    prefix: string;
    examined: number;
    truncated: boolean;
    /** Inside the grace window: a seal may be between its R2 writes and its `INSERT` right now. */
    tooFreshToJudge: number;
    /** Past the grace window with no `send_manifests` row. Deleted only when `collect` is set and no hold stands. */
    stranded: Unreferenced[];
  }
  | { read: "unreadable"; prefix: string; because: string | null };

/**
 * The manifest id in a `${orgId}/sent/${manifestId}/<name>` key, or `null` when the key has no second segment.
 *
 * `null` rather than an empty string, because "this key names no manifest" is a different answer from "this
 * key names a manifest called nothing", and the caller treats the two the same way only after saying so: an
 * object directly under the prefix belongs to no row by definition, so it is judged stranded rather than
 * skipped. Skipping would leave an object this pass can see and never collect, which is the shape #67 filed.
 */
function manifestIdIn(key: string, prefix: string): string | null {
  const rest = key.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash <= 0 ? null : rest.slice(0, slash);
}

/**
 * The send half of direction 1 (#74).
 *
 * Two calls at most, whatever the listing returns: one `R2Bucket.list()` and **one** bounded
 * `SELECT id FROM send_manifests` for every referent the page could need. See the type above for why the
 * bound is a `BETWEEN` over the ids in the page rather than the whole-column read the other two bulk scans
 * do.
 */
export async function scanSentObjects(env: Env, ctx: Ctx, orgId: string): Promise<SentObjectScan> {
  const prefix = sentPrefix(orgId);
  const listed = await env.EVIDENCE.list({ prefix, limit: LIST_LIMIT });

  const ids = listed.objects
    .map((object) => manifestIdIn(object.key, prefix))
    .filter((id): id is string => id !== null)
    .sort();
  const live = new Set<string>();
  if (ids.length > 0) {
    const referenced = await env.CATALOG.prepare(
      "SELECT id FROM send_manifests WHERE org_id = ? AND id >= ? AND id <= ?",
    ).bind(orgId, ids[0]!, ids[ids.length - 1]!).all<{ id: string }>();
    for (const row of referenced.results) live.add(row.id);
  }

  const cutoff = ctx.now() - ORPHAN_GRACE_MS;
  const stranded: Unreferenced[] = [];
  let tooFreshToJudge = 0;
  for (const object of listed.objects) {
    const manifestId = manifestIdIn(object.key, prefix);
    if (manifestId !== null && live.has(manifestId)) continue;
    if (object.uploaded.getTime() > cutoff) {
      tooFreshToJudge += 1;
      continue;
    }
    stranded.push({
      blobKey: object.key,
      bytes: object.size,
      uploaded: object.uploaded.toISOString(),
    });
  }

  return {
    read: "complete",
    prefix,
    examined: listed.objects.length,
    truncated: listed.truncated,
    tooFreshToJudge,
    stranded,
  };
}

export interface ReconcileReport {
  /** Raw objects with no receipt, older than the grace period. Deleted only when `collect` is set. */
  orphans: Unreferenced[];
  orphansDeleted: number;
  /**
   * The draft-body half of direction 1 (#67), by the predicate `doctor` reports from.
   *
   * A sibling of `orphans` rather than merged into it, and the counts are **not summed**. The two have
   * different referents and different meanings — an orphan is a lost transaction, a stranded draft body is
   * the ordinary residue of a sent message — so a single total would be a number nobody could act on, and
   * `evidence_orphans`'s "N object(s) have no receipt" would become false of half of it.
   */
  draftBodies: DraftBodyScan;
  draftBodiesDeleted: number;
  /**
   * The export half of direction 1 (#65), by its own referent rule.
   *
   * A third sibling rather than a third total, for the reason `draftBodies` is a sibling of `orphans`: an
   * orphan is a lost transaction, a stranded draft body is the ordinary residue of a sent message, and a
   * stranded export object is **material somebody was authorized to copy whose record has gone**. Three
   * different meanings, so three counts an operator can act on rather than one they cannot.
   */
  exportObjects: ExportObjectScan;
  exportObjectsDeleted: number;
  /**
   * The send half of direction 1 (#74), by its own referent rule.
   *
   * A fourth sibling rather than a fourth total, for the reason the other three are siblings: an orphan is a
   * lost transaction, a stranded draft body is the ordinary residue of a sent message, a stranded export
   * object is material somebody was authorized to copy whose record has gone, and a stranded `sent/` object
   * is **composition or submission evidence whose manifest is gone** — the one §12 invariant 2 calls
   * immutable. Four different meanings, so four counts an operator can act on rather than one they cannot.
   */
  sentObjects: SentObjectScan;
  sentObjectsDeleted: number;
  /**
   * What this pass was asked to delete, and whether a legal hold stopped it (#64).
   *
   * Reported rather than silent, because suppression that cannot be seen is indistinguishable from a
   * reconciler that has stopped working — and this pass is the one an operator reaches for when they suspect
   * exactly that. `requested` is here so `suppressed: false` cannot be read as "nothing was in the way" by
   * somebody who never asked for collection in the first place.
   */
  collection: { requested: boolean; suppressed: boolean };
  /** Raw objects with no receipt but still inside the grace window — a delivery may be in flight. */
  tooFreshToJudge: number;
  /** Receipts whose evidence is absent. This is lost mail. */
  missing: { receiptId: string; blobKey: string; acceptedAt: string }[];
  /**
   * What was examined, so a bounded pass cannot read as an exhaustive one — including **which
   * prefixes**, so a prefix outside the scan appears in the output instead of being absent from it.
   */
  scanned: {
    objects: number;
    truncated: boolean;
    receipts: number;
    receiptsTotal: number;
    prefixes: string[];
  };
}

/**
 * One bounded pass. `collect` deletes what has no referent; without it the pass is read-only, which is the
 * mode `doctor` uses — a diagnostic must never be the thing that deletes data.
 */
export async function reconcileEvidence(
  env: Env,
  ctx: Ctx,
  orgId: string,
  options: { collect?: boolean } = {},
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    orphans: [],
    orphansDeleted: 0,
    // Overwritten unconditionally below, and the placeholder is the *refusing* arm on purpose: an empty
    // `complete` scan would claim a clean prefix this pass had not looked at yet, which is precisely the
    // overclaim #67 is about. If a future edit ever returns before the scan, it returns "not read".
    draftBodies: {
      read: "unreadable",
      prefix: draftBodyPrefix(orgId),
      because: "the pass returned before reaching this prefix",
    },
    draftBodiesDeleted: 0,
    // Same refusing placeholder as `draftBodies` above, for the same reason: a `complete` scan with an empty
    // `stranded` would claim a clean prefix this pass had not looked at yet.
    exportObjects: {
      read: "unreadable",
      prefix: exportsPrefix(orgId),
      because: "the pass returned before reaching this prefix",
    },
    exportObjectsDeleted: 0,
    // Same refusing placeholder again (#74): a `complete` scan with an empty `stranded` would claim a clean
    // prefix this pass had not looked at yet, which is the overclaim both #67 and #74 are about.
    sentObjects: {
      read: "unreadable",
      prefix: sentPrefix(orgId),
      because: "the pass returned before reaching this prefix",
    },
    sentObjectsDeleted: 0,
    collection: { requested: options.collect === true, suppressed: false },
    tooFreshToJudge: 0,
    missing: [],
    scanned: { objects: 0, truncated: false, receipts: 0, receiptsTotal: 0, prefixes: [] },
  };

  /**
   * Any hold anywhere in the organization suppresses collection, for the whole organization (#64).
   *
   * **An unreferenced object is unattributable by definition** — this pass finds it precisely *because* its
   * referent is missing — so nothing can establish which mailbox it belonged to, and nothing can prove it is
   * not responsive. A per-hold check is not expensive here, it is unimplementable: it would need a mailbox
   * inferred from exactly the data whose absence defines the state. That holds for a stranded draft body as
   * well as for an orphan: the `drafts` row carried the mailbox, and the row is what is gone. Enumeration is
   * unaffected; only the delete is.
   *
   * Asked **once per pass and only when collection was requested**, so the read-only mode `doctor` uses
   * spends nothing on it — which is why `doctor-check-cost.md`'s figure does not move for this file.
   */
  if (options.collect === true) {
    report.collection.suppressed = await anyActiveHold(env, orgId);
  }

  // ---- direction 1: objects with no referent -----------------------------------------------
  // The reported prefixes come from the same two functions the scans below are handed, so the report
  // cannot name a prefix the scan skipped. That is the whole point of reporting them: an unscanned prefix
  // has to be visible somewhere other than in a comment.
  report.scanned.prefixes = scannedPrefixes(orgId);
  const cutoff = ctx.now() - ORPHAN_GRACE_MS;

  /**
   * What this pass may destroy, tagged with the referent it is missing.
   *
   * Both scans fill it and the single `EVIDENCE.delete` below drains it. That is what keeps this Worker's
   * R2 delete site at exactly one while covering two prefixes — the property
   * `test/node/content-deletion-world.test.ts` exists to protect, and the reason #67's residue is collected
   * here rather than by a sweep of its own.
   */
  const collectable: {
    blobKey: string;
    referent: "ingress_receipt" | "drafts_row" | "exports_row" | "send_manifests_row";
  }[] = [];

  const listed = await env.EVIDENCE.list({ prefix: rawPrefix(orgId), limit: LIST_LIMIT });
  report.scanned.objects += listed.objects.length;
  if (listed.truncated) report.scanned.truncated = true;

  for (const object of listed.objects) {
    if (object.uploaded.getTime() > cutoff) {
      // A delivery may be between its R2 write and its D1 commit right now.
      report.tooFreshToJudge += 1;
      continue;
    }

    const receipt = await env.CATALOG.prepare(
      "SELECT id FROM ingress_receipts WHERE org_id = ? AND blob_key = ? LIMIT 1",
    )
      .bind(orgId, object.key)
      .first<{ id: string }>();

    if (receipt !== null) continue;

    report.orphans.push({
      blobKey: object.key,
      bytes: object.size,
      uploaded: object.uploaded.toISOString(),
    });
    collectable.push({ blobKey: object.key, referent: "ingress_receipt" });
  }

  /**
   * The draft-body half, and the one place that decides what an unreadable prefix means.
   *
   * Caught rather than propagated, because direction 2 below — receipts pointing at absent objects, which is
   * *lost mail* — is produced by nothing else in this Node, and losing that report because a second prefix
   * would not answer trades the serious finding for the cheap one. What it must not do is fall back to a
   * silent zero: the report carries the failure so the text form can say the prefix was not read, which is
   * the same distinction `scanned.prefixes` was added for.
   */
  report.draftBodies = await scanDraftBodies(env, ctx, orgId).catch((error: unknown) => ({
    read: "unreadable" as const,
    prefix: draftBodyPrefix(orgId),
    because: (error as Error).message.split("\n")[0] ?? null,
  }));
  if (report.draftBodies.read === "complete") {
    report.scanned.objects += report.draftBodies.examined;
    if (report.draftBodies.truncated) report.scanned.truncated = true;
    for (const object of report.draftBodies.stranded) {
      collectable.push({ blobKey: object.blobKey, referent: "drafts_row" });
    }
  }

  /**
   * The export half (#65), caught for the same reason the draft half is: direction 2 below reports **lost
   * mail**, which nothing else in this Node produces, and losing that report because a third prefix would
   * not answer trades the serious finding for the cheap one.
   */
  report.exportObjects = await scanExportObjects(env, ctx, orgId).catch((error: unknown) => ({
    read: "unreadable" as const,
    prefix: exportsPrefix(orgId),
    because: (error as Error).message.split("\n")[0] ?? null,
  }));
  if (report.exportObjects.read === "complete") {
    report.scanned.objects += report.exportObjects.examined;
    if (report.exportObjects.truncated) report.scanned.truncated = true;
    for (const object of report.exportObjects.stranded) {
      collectable.push({ blobKey: object.blobKey, referent: "exports_row" });
    }
  }

  /**
   * The send half (#74), caught for the reason the other two are: direction 2 below reports **lost mail**,
   * which nothing else in this Node produces, and losing that report because a fourth prefix would not answer
   * trades the serious finding for the cheap one.
   */
  report.sentObjects = await scanSentObjects(env, ctx, orgId).catch((error: unknown) => ({
    read: "unreadable" as const,
    prefix: sentPrefix(orgId),
    because: (error as Error).message.split("\n")[0] ?? null,
  }));
  if (report.sentObjects.read === "complete") {
    report.scanned.objects += report.sentObjects.examined;
    if (report.sentObjects.truncated) report.scanned.truncated = true;
    for (const object of report.sentObjects.stranded) {
      collectable.push({ blobKey: object.blobKey, referent: "send_manifests_row" });
    }
  }

  // ---- the one R2 delete in this Worker ----------------------------------------------------
  // Everything above is enumerated whatever happens; deleted only when collection was asked for and no
  // hold stands anywhere in the organization.
  if (report.collection.requested && !report.collection.suppressed) {
    for (const object of collectable) {
      await env.EVIDENCE.delete(object.blobKey);
      // Counted per referent rule, not as one total: "3 deleted" that mixed a lost transaction with the
      // residue of a sent message would be a number an operator could not act on.
      if (object.referent === "ingress_receipt") report.orphansDeleted += 1;
      else if (object.referent === "drafts_row") report.draftBodiesDeleted += 1;
      else if (object.referent === "exports_row") report.exportObjectsDeleted += 1;
      else report.sentObjectsDeleted += 1;
    }
  }

  // ---- direction 2: receipts with no object ------------------------------------------------
  const total = await env.CATALOG.prepare(
    "SELECT COUNT(*) AS n FROM ingress_receipts WHERE org_id = ?",
  )
    .bind(orgId)
    .first<{ n: number }>();
  report.scanned.receiptsTotal = total?.n ?? 0;

  const receipts = await env.CATALOG.prepare(
    `SELECT id, blob_key, accepted_at FROM ingress_receipts
      WHERE org_id = ? ORDER BY accepted_at DESC LIMIT ?`,
  )
    .bind(orgId, LIST_LIMIT)
    .all<{ id: string; blob_key: string; accepted_at: string }>();
  report.scanned.receipts = receipts.results.length;

  for (const receipt of receipts.results) {
    if ((await env.EVIDENCE.head(receipt.blob_key)) === null) {
      // Reported, never repaired. Deleting the receipt would convert a detectable loss into an
      // undetectable one — and it is the tempting option, because it makes the report go green.
      report.missing.push({
        receiptId: receipt.id,
        blobKey: receipt.blob_key,
        acceptedAt: receipt.accepted_at,
      });
    }
  }

  return report;
}

/**
 * The one line about legal hold, in the tense the pass actually earned.
 *
 * Separated out because it is the only line in this report with three possible states rather than a value,
 * and because "we did not look" is a distinct answer from "we looked and found nothing" — the same
 * distinction §24 draws between `unobserved` and `accepted`, applied to the pass's own knowledge.
 */
function reconcileHoldLine(report: ReconcileReport): string {
  const held = report.orphans.length
    + (report.draftBodies.read === "complete" ? report.draftBodies.stranded.length : 0)
    + (report.exportObjects.read === "complete" ? report.exportObjects.stranded.length : 0)
    + (report.sentObjects.read === "complete" ? report.sentObjects.stranded.length : 0);
  if (report.collection.suppressed) {
    return `  HELD      ${held} collectable object(s) not collected: a legal hold is active in this `
      + `organization, and an object with no referent is unattributable by definition, so nothing can prove `
      + `one is not responsive. They are reported above and left in place`;
  }
  if (report.collection.requested) {
    return `  holds     collection was requested and no legal hold stands in this organization, so nothing `
      + `suppressed it`;
  }
  return `  holds     collection was not requested, so no hold was consulted — this pass could not have `
    + `deleted anything, and it does not know whether a hold stands`;
}

/**
 * The draft-body line, printed on every branch including the unreadable one.
 *
 * A prefix that could not be read has to say so here rather than contribute a zero, because a zero is
 * exactly what the old single-prefix report printed for a prefix it had never looked at.
 */
function draftBodyLine(report: ReconcileReport): string {
  const scan = report.draftBodies;
  if (scan.read === "unreadable") {
    return `  UNREAD    ${scan.prefix} could not be read, so nothing under it was counted or collected`
      + (scan.because === null ? `` : `: ${scan.because}`);
  }
  return `  drafts    ${scan.stranded.length} body object(s) with no drafts row, `
    + `${report.draftBodiesDeleted} deleted, ${scan.tooFreshToJudge} too fresh to judge, `
    + `out of ${scan.examined} examined under ${scan.prefix}`
    + (scan.truncated ? ` (truncated — more remain)` : ``);
}

/**
 * The export line, printed on every branch including the unreadable one (#65).
 *
 * Its own line rather than folded into the draft one, because the referent rule differs and a reader who
 * assumed otherwise would draw the wrong conclusion about what is missing — the same argument #67 made for
 * separating drafts from orphans, one prefix along.
 */
function exportObjectLine(report: ReconcileReport): string {
  const scan = report.exportObjects;
  if (scan.read === "unreadable") {
    return `  UNREAD    ${scan.prefix} could not be read, so nothing under it was counted or collected`
      + (scan.because === null ? `` : `: ${scan.because}`);
  }
  return `  exports   ${scan.stranded.length} staged object(s) with no exports row, `
    + `${report.exportObjectsDeleted} deleted, ${scan.tooFreshToJudge} too fresh to judge, `
    + `out of ${scan.examined} examined under ${scan.prefix}`
    + (scan.truncated ? ` (truncated — more remain)` : ``);
}

/**
 * The send line, printed on every branch including the unreadable one (#74).
 *
 * Its own line rather than folded into the export one, even though the two share a key shape: the referent is
 * a different table with a different meaning, and a count that mixed them would tell an operator that
 * *something* is missing without saying whether it is an investigator's copy or the evidence of what this Node
 * sent. That is #67's argument, three prefixes along, and it is why the issue asked for a separate line.
 */
function sentObjectLine(report: ReconcileReport): string {
  const scan = report.sentObjects;
  if (scan.read === "unreadable") {
    return `  UNREAD    ${scan.prefix} could not be read, so nothing under it was counted or collected`
      + (scan.because === null ? `` : `: ${scan.because}`);
  }
  return `  sent      ${scan.stranded.length} staged object(s) with no send_manifests row, `
    + `${report.sentObjectsDeleted} deleted, ${scan.tooFreshToJudge} too fresh to judge, `
    + `out of ${scan.examined} examined under ${scan.prefix}`
    + (scan.truncated ? ` (truncated — more remain)` : ``);
}

/** The text form, for a CLI and for a log line. */
export function formatReconcile(report: ReconcileReport): string {
  const lines = [
    `evidence reconcile`,
    `  scanned   ${report.scanned.objects} object(s)${report.scanned.truncated ? " (truncated — more remain)" : ""}, ` +
      `${report.scanned.receipts} of ${report.scanned.receiptsTotal} receipt(s)`,
    // Named, because "0 orphans" from a scan of one prefix reads exactly like "0 orphans" from a scan
    // of the bucket.
    //
    // **The sentence changed with the fourth prefix, and that is the point of #74.** It used to say objects
    // under any other prefix "were not listed", which was true while `${orgId}/sent/` was one of them and
    // would have become a description of a state the code had left the moment it stopped being. It is now the
    // stronger claim, and the claim is checked: `test/node/evidence-prefix-world.test.ts` derives every
    // `${orgId}/<segment>/` this Worker writes and fails if `scannedPrefixes` does not cover it. What is still
    // outside the scan is another organization's prefixes and anything a hand put in the bucket — neither of
    // which this pass may collect, and both of which the second clause still covers.
    `  prefixes  ${report.scanned.prefixes.join(", ")} — every prefix this Worker writes for this ` +
      `organization. An object under any other prefix was not listed, so it is neither counted above nor ` +
      `collectable by this pass`,
    `  orphans   ${report.orphans.length} collectable, ${report.orphansDeleted} deleted, ` +
      `${report.tooFreshToJudge} too fresh to judge`,
    // The second referent rule gets its own line rather than being folded into the one above, because
    // "no receipt" is not the test that produced it and a reader who assumes it was would draw the wrong
    // conclusion about what is missing (#67).
    draftBodyLine(report),
    // The third referent rule, on its own line for the same reason the second one is (#65).
    exportObjectLine(report),
    // The fourth, on its own line for the same reason again (#74) — and this one shares a key shape with the
    // third, which is exactly when folding them together would be tempting and wrong.
    sentObjectLine(report),
    // Printed on every branch, including "collection was not asked for", because a reader who sees nothing
    // about holds cannot tell whether the line is absent or the suppression is.
    //
    // **Three branches, not two**, and the third is the point. `anyActiveHold` runs only when collection was
    // requested, so a read-only pass — the one `doctor` performs — has not asked and therefore cannot say
    // that nothing is in the way. This line said "collection was not requested; nothing suppresses it" until
    // it was measured against a Node with a hold standing, where it was simply false: `suppressed` is `false`
    // there because nobody asked, which is the exact misreading `requested` was added to the report to
    // prevent. The text form now says what was not done instead of asserting the answer it never obtained.
    reconcileHoldLine(report),
  ];

  if (report.missing.length === 0) {
    lines.push(`  missing   none — every sampled receipt's evidence is present`);
  } else {
    lines.push(`  MISSING   ${report.missing.length} receipt(s) reference absent evidence. This is lost mail.`);
    for (const entry of report.missing) {
      lines.push(`            ${entry.receiptId}  accepted ${entry.acceptedAt}  ${entry.blobKey}`);
    }
    lines.push(`  fix       do not delete these receipts. Check R2 lifecycle rules and §24 Time Travel first.`);
  }
  return lines.join("\n");
}
