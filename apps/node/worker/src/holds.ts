import type { Ctx } from "@mailda/runtime";

import { assertAdmin } from "./access.ts";
import { describeShortfall, planApproval, type Stages } from "./approvals.ts";
import { decidersOf } from "./deciders.ts";
import { audit, auditedBatch } from "./audit.ts";
import { conflict, notFound, unprocessable } from "./errors.ts";

/**
 * Legal hold — enforcement, and the lift (#64, Layer 5).
 *
 * ## A hold is a question, not a list
 *
 * The requirement that decided the shape: a hold placed on Tuesday must cover Wednesday's mail. So the scope
 * is a predicate over a mailbox and an optional date window, evaluated at the instant of the destroying act,
 * and there is no materialised set of ids anywhere. A frozen list needs maintenance to stay right, and a hold
 * that must be maintained to keep covering things is a hold that will quietly stop covering things.
 *
 * The predicate is deliberately coarser than the matter it serves: over-holding costs storage, under-holding
 * is unrecoverable. `migrations/0018_legal_hold.sql` carries that argument in full.
 *
 * ## Placing, refusing and lifting, and the asymmetry is the whole design
 *
 *   placing   one `org.admin`, alone, immediate, audited `hold.placed` in one transaction with the row.
 *             It only ever preserves; its worst case is wasted bytes, and ceremony in front of it is
 *             exactly how evidence is lost in the hour after somebody realises they need it.
 *   refusing  a deletion refused by a hold is audited `hold.blocked` — an attempt to destroy held mail is
 *             evidence *about the attempt*, and discarding it would be the one omission this mechanism
 *             exists to prevent.
 *   lifting   an `org.admin` **requests** it with a mandatory reason, and two other people holding
 *             `approval.decide` on the held mailbox have to approve — one stage of `{count: 2}`, distinct on
 *             `user_id`, with the requester excluded. Audited `hold.lifted` in the same transaction as the
 *             `UPDATE holds` that applies it.
 *
 * Treating placing and lifting alike would have been the error. Placing only ever preserves; lifting
 * re-permits destruction and is irreversible in effect. **A hold nobody can lift is an operational trap; a
 * hold one person can lift quietly is not a hold.**
 *
 * ## The lift is an approval, not a second approval mechanism
 *
 * `requestHoldLift` opens a `hold_lift` approval through `planApproval` (#61), and everything after that is
 * #61's: the eligible set, the actor exclusion that stops the requester deciding, the frozen stage set, the
 * conditional completion. **All three of #61's defects were in that race logic**, so a second copy of it here
 * would be a second place for them — which is why migration 0021 generalised `approvals` from a manifest to a
 * subject instead of giving the lift a table of its own.
 *
 * Two consequences worth being explicit about, because they are the difference between a lift and a button:
 *
 *   - An organization where fewer than two people hold `approval.decide` on the held mailbox **cannot lift**.
 *     That is refused at request time with the shortfall named (`E_HOLD_LIFT_UNSATISFIABLE`), and `doctor`'s
 *     `legal_hold_unliftable` finding reports the state before anybody tries — because #64's trap is a hold
 *     nobody can lift, and the only thing worse than that is one nobody knew about.
 *   - A denied lift is terminal for that request and not for the hold: asking again mints a new `hold_lifts`
 *     row, which is why the subject of a lift approval is a request rather than the hold itself (0021).
 *
 * ## What `active` means here, now that it means something
 *
 * A hold is in force while `lifted_at IS NULL`, and every reader in this file says so in SQL:
 * `coveringHolds`, `anyActiveHold` and `holdsForReport`. `coveringHolds` is the predicate standing between a
 * held mailbox and a deletion, so the lifted test is *in the predicate* rather than applied by a caller who
 * could forget — and `test/legal-hold.test.ts` proves the consequence end to end through `deleteDraft`: a
 * deletion refused before the lift succeeds after it.
 *
 * ## What consults this, and what cannot
 *
 * `test/node/content-deletion-world.test.ts` is the closed world over every content-destroying call site in
 * `src/` and `migrations/`: each site is declared with its target and whether it carries content, and a site
 * carrying content must name its guard *and have it in the same function*. That test, not this comment, is
 * what keeps the list of call sites true — and it declares its own blind spots, which are dynamic SQL,
 * `wrangler d1 execute`, and the Cloudflare dashboard. The last two are not fixable from inside a Worker.
 */

/**
 * One hold **in force**, as the rest of the Node sees it.
 *
 * There is no `liftedAt` on this shape, and that is not the omission 0018's absent column was. Every reader
 * in this file filters on `lifted_at IS NULL`, so the field would be `null` on every value that ever exists —
 * which is the placeholder-column failure `test/node/placeholder-columns.test.ts` exists to name. What a
 * lifted hold *was* is answered from the table, by an auditor or by `doctor`, not from this interface.
 */
export interface Hold {
  id: string;
  /** The matter cited, or null: the realistic first act precedes any matter, and there is no matters table. */
  matterId: string | null;
  mailboxId: string;
  /** Inclusive bounds on the content's own instant. Null is unbounded in that direction. */
  fromDate: string | null;
  toDate: string | null;
  placedBy: string;
  placedAt: string;
}

interface Row {
  id: string;
  matter_id: string | null;
  mailbox_id: string;
  from_date: string | null;
  to_date: string | null;
  placed_by: string;
  placed_at: string;
}

function holdOf(row: Row): Hold {
  return {
    id: row.id,
    matterId: row.matter_id,
    mailboxId: row.mailbox_id,
    fromDate: row.from_date,
    toDate: row.to_date,
    placedBy: row.placed_by,
    placedAt: row.placed_at,
  };
}

/**
 * The holds covering `mailboxId` for content attributed to the instant `at`.
 *
 * `at` is the instant of the **thing at risk**, not the current time. A hold's window is a statement about
 * when mail happened, so testing it against "now" would mean a hold with a closed window stopped covering
 * its own mail the moment the window passed — the exact opposite of what a window means.
 *
 * Comparison is lexical, which is sound only because every bound written through `placeHold` is a full
 * ISO-8601 instant in UTC and so is every timestamp column in this schema. `normaliseBound` is what makes
 * that true, and "nothing else may write this table" is an assertion rather than a hope:
 * `test/node/content-deletion-world.test.ts` requires `INSERT INTO holds` to appear in this file and nowhere
 * else, because a bound that skipped `normaliseBound` would make its hold cover nothing while reporting as
 * active. The other half — that every timestamp column is already ISO-8601 — is **not** checked anywhere and
 * is stated as unchecked: it is a property of every migration in the tree rather than of this feature, and a
 * scan that tried to prove it would be asserting a convention over columns this file never reads.
 *
 * **`lifted_at IS NULL` is part of this predicate, not a filter a caller applies.** A lifted hold must stop
 * covering — that is what lifting *is* — and this function is the only thing standing between a held mailbox
 * and a deletion, so the test belongs where it cannot be forgotten. `test/legal-hold.test.ts` proves the
 * consequence through `deleteDraft` rather than only against this function, because the observable is a
 * deletion that was refused and now succeeds.
 */
export async function coveringHolds(
  env: Env,
  orgId: string,
  mailboxId: string,
  at: string,
): Promise<Hold[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT id, matter_id, mailbox_id, from_date, to_date, placed_by, placed_at
       FROM holds
      WHERE org_id = ? AND mailbox_id = ? AND lifted_at IS NULL
        AND (from_date IS NULL OR from_date <= ?)
        AND (to_date IS NULL OR to_date >= ?)
      ORDER BY placed_at, id`,
  )
    .bind(orgId, mailboxId, at, at)
    .all<Row>();
  return results.map(holdOf);
}

/**
 * Is anything at all held in this organization?
 *
 * The reconciler's question, and it is org-wide on purpose. **An orphan is unattributable by definition** —
 * the collector finds it *because* its referent is missing — so nothing can establish which mailbox it
 * belonged to, and therefore nothing can prove it is not responsive. A per-hold check on orphans is not
 * expensive, it is unimplementable: it would require inferring a mailbox from exactly the data whose absence
 * defines the state. So while any hold stands, collection is refused for the whole organization, and orphans
 * are still enumerated and still reported.
 *
 * **And suppression ends when the last hold is lifted.** `lifted_at IS NULL` is what makes that true, and it
 * is the inverse of #64's own defect: lifting every hold while collection stayed suppressed would leave a
 * reconciler that never collects again with nothing to say why. `test/legal-hold.test.ts` asserts the ending,
 * not only the suppressing — a lifted hold, an orphan, and the bytes actually gone.
 *
 * The word *active* is now load-bearing rather than a courtesy: the active set and the whole table were the
 * same set while nothing could lift a hold, and they are not any more.
 */
export async function anyActiveHold(env: Env, orgId: string): Promise<boolean> {
  const row = await env.CATALOG.prepare(
    "SELECT id FROM holds WHERE org_id = ? AND lifted_at IS NULL LIMIT 1",
  )
    .bind(orgId)
    .first<{ id: string }>();
  return row !== null;
}

/** What a destroying call site is about to destroy. */
export interface HoldTarget {
  /**
   * What kind of thing this is, in the word the product uses for it. It reaches the audit `detail`, so a
   * reader of the trail can tell a refused draft deletion from a refused case merge without a second query.
   */
  kind: "draft" | "case";
  /** The id of the thing, which becomes the audit entry's subject. */
  id: string;
  /** The mailbox it belongs to. A hold covers a mailbox, so an unattributable thing cannot use this path. */
  mailboxId: string;
  /**
   * The instant the content is attributed to — what the hold's window is tested against.
   *
   * Both current call sites pass the row's `created_at`: when the content came into existence, which is the
   * thing a hold window is written about. The residual is stated rather than hidden: a draft created before
   * `from_date` and then edited *inside* the window is not covered, because one instant per object is what
   * keeps the predicate an index lookup. It only arises for a hold with a closed `to_date`; the ordinary
   * shape — an open-ended hold from a date in the past — is unaffected, and the direction of the error for
   * everything else is over-holding.
   */
  at: string;
}

/**
 * Refuses a content-destroying act while a hold covers it, and records the attempt.
 *
 * The refusal is a 409 rather than a 403: the request is well-formed and it is the *state* that does not
 * permit it, which is the distinction `errors.ts` already draws, and it is the same shape a withheld send
 * uses to say the Node declined rather than blaming something else.
 *
 * `hold.blocked` goes through `audit` rather than `auditedBatch`, and that is the one case the standalone
 * form is for: nothing is written, so there is nothing to be atomic with, and by the time this records it
 * the decision is already made. `auth.locked_out` earns it the same way. `audit` never throws, so a Node
 * that cannot record the refusal still refuses — the safe direction — and logs the failure to record where
 * `doctor` can see it.
 */
export async function assertNotHeld(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string | null,
  target: HoldTarget,
): Promise<void> {
  const holds = await coveringHolds(env, orgId, target.mailboxId, target.at);
  if (holds.length === 0) return;

  await audit(env, ctx, orgId, {
    action: "hold.blocked",
    outcome: "refused",
    actorUserId,
    subject: target.id,
    detail: {
      kind: target.kind,
      mailboxId: target.mailboxId,
      at: target.at,
      holds: holds.map((hold) => hold.id),
      matters: holds.map((hold) => hold.matterId).filter((matter) => matter !== null),
    },
  });

  const named = holds.map((hold) => hold.id).join(", ");
  throw conflict("E_LEGAL_HOLD", {
    what: `this ${target.kind} is covered by legal hold ${named} on mailbox ${target.mailboxId}, so it was not deleted`,
    why: "a hold preserves what a matter may need, evaluated at the moment of the act rather than from a "
      + "list, and the attempt has been recorded as hold.blocked",
    fix: "an administrator can request a lift with POST /api/holds/:id/lift and a reason, after which two "
      + "other people holding approval.decide on this mailbox have to approve it (#64 requires two distinct "
      + "approvers, so nobody lifts a hold alone). Until it is lifted, work with the copy rather than "
      + "destroying it — mailda doctor lists every hold, its scope and any lift already pending",
  });
}

export interface PlaceHoldInput {
  mailboxId: string;
  /** Optional, and nullable in the schema: the first act often precedes the matter. */
  matterId?: string | null;
  /** A date or an instant. Normalised to the inclusive edge of the day when only a date is given. */
  fromDate?: string | null;
  toDate?: string | null;
}

/**
 * Widens a bare date to the inclusive edge of that day, and refuses anything unparseable.
 *
 * Coverage is a string comparison, so a `to_date` of `2026-08-31` would sort *below* everything that
 * happened during 31 August and silently fail to cover the last day somebody thought they had included.
 * That is an under-hold at exactly the boundary a person chose deliberately, which is the one error class
 * this mechanism may not have. A `from_date` widens the other way for the same reason.
 *
 * Refusing an unparseable value rather than storing it matters more here than in most validation: a bound
 * that no comparison matches would make the hold cover **nothing** while reporting as active, and a hold
 * that silently enforces nothing is worse than no hold at all.
 */
function normaliseBound(value: string | null | undefined, edge: "from" | "to"): string | null {
  if (value === undefined || value === null || value === "") return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const widened = dateOnly ? `${value}T${edge === "from" ? "00:00:00.000Z" : "23:59:59.999Z"}` : value;
  const parsed = new Date(widened);
  if (Number.isNaN(parsed.getTime())) {
    throw unprocessable("E_HOLD_BOUND_UNREADABLE", {
      what: `${edge === "from" ? "fromDate" : "toDate"} ${JSON.stringify(value)} is not a date this Node can compare`,
      why: "coverage is a comparison against ISO-8601 instants, so a bound nothing matches would make the "
        + "hold cover nothing while reporting as active",
      fix: "send a date (2026-08-01) or a full instant (2026-08-01T09:00:00.000Z)",
    });
  }
  // Round-tripped through Date so what is stored is canonical UTC, which is what every other timestamp
  // column in this schema holds and what the lexical comparison in `coveringHolds` requires.
  return parsed.toISOString();
}

/**
 * Places a hold. `org.admin` only, immediate, audited in the same transaction as the row.
 *
 * The mailbox is checked to exist, for the reason `access.ts` refuses a grant on a mailbox that is not
 * there: a hold on a nonexistent mailbox would enforce nothing while reporting as active, and somebody
 * would discover that weeks later while wondering why preservation "did not work". `doctor` still reports
 * that state, because a mailbox could stop existing after the hold was placed.
 *
 * No gate on the audit entry: unlike a grant, placing is not idempotent by any derived key — two holds over
 * the same mailbox are two acts by two people at two times, and collapsing them would discard whichever
 * matter arrived second.
 */
export async function placeHold(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  input: PlaceHoldInput,
): Promise<Hold> {
  await assertAdmin(env, orgId, actorUserId);

  const mailbox = await env.CATALOG.prepare(
    "SELECT id FROM mailboxes WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, input.mailboxId).first<{ id: string }>();
  if (mailbox === null) {
    throw notFound("E_NO_MAILBOX", {
      what: `mailbox ${input.mailboxId} does not exist`,
      why: "a hold on a mailbox that is not there would cover nothing while reporting as active, which is "
        + "worse than no hold",
      fix: "check the mailbox id",
    });
  }

  const fromDate = normaliseBound(input.fromDate, "from");
  const toDate = normaliseBound(input.toDate, "to");
  if (fromDate !== null && toDate !== null && toDate < fromDate) {
    throw unprocessable("E_HOLD_WINDOW_INVERTED", {
      what: `toDate ${toDate} is before fromDate ${fromDate}`,
      why: "an inverted window matches nothing, so the hold would report as active and preserve nothing",
      fix: "either widen the window or leave one bound out — an absent bound is unbounded in that direction",
    });
  }

  const hold: Hold = {
    id: ctx.id("hld"),
    matterId: input.matterId ?? null,
    mailboxId: input.mailboxId,
    fromDate,
    toDate,
    placedBy: actorUserId,
    placedAt: new Date(ctx.now()).toISOString(),
  };

  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "hold.placed",
      outcome: "ok",
      actorUserId,
      subject: hold.id,
      detail: {
        mailboxId: hold.mailboxId,
        matterId: hold.matterId,
        fromDate: hold.fromDate,
        toDate: hold.toDate,
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `INSERT INTO holds (id, org_id, matter_id, mailbox_id, from_date, to_date, placed_by, placed_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(hold.id, orgId, hold.matterId, hold.mailboxId, hold.fromDate, hold.toDate,
        hold.placedBy, hold.placedAt),
    ],
  );

  return hold;
}

/** A hold as `doctor` reports it: the hold, its mailbox's existence, and any lift already asked for. */
export interface HoldReportRow extends Hold {
  /** False for a hold enforcing nothing while reporting as active. */
  mailboxExists: boolean;
  /** The open lift request on this hold, or null. At most one — see `requestHoldLift`'s predicate. */
  pendingLift: { liftId: string; approvalId: string; requestedBy: string; reason: string } | null;
}

/**
 * Every hold **in force** in the organization, with its mailbox's existence and any pending lift resolved.
 *
 * One query, one execution, and it lives here rather than in `doctor.ts` so that "which holds are in force"
 * has exactly one definition. `LEFT JOIN mailboxes`, because the whole point is to return the holds whose
 * mailbox is **absent**; `LEFT JOIN` for the lift for the ordinary reason, that most holds have none.
 *
 * The lift side is an **inner** join wrapped in a derived table rather than two chained `LEFT JOIN`s, and the
 * difference is a defect this nearly shipped with: chaining them matched a hold's *denied* request on the
 * left and produced a NULL approval on the right, so a hold that had once been refused a lift would have
 * needed filtering out — and filtering it out in the `WHERE` dropped the hold from the report entirely.
 *
 * It cannot fan a hold out into several rows, and that is a property rather than a hope: `requestHoldLift`
 * inserts behind a predicate that refuses a second *pending* request on one hold, so at most one row inside
 * the derived table can match a hold.
 */
export async function holdsForReport(env: Env, orgId: string): Promise<HoldReportRow[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT h.id, h.matter_id, h.mailbox_id, h.from_date, h.to_date, h.placed_by, h.placed_at,
            m.id AS mailbox_present,
            p.lift_id AS lift_id, p.reason AS lift_reason,
            p.approval_id AS lift_approval_id, p.requested_by AS lift_requested_by
       FROM holds h
       LEFT JOIN mailboxes m ON m.org_id = h.org_id AND m.id = h.mailbox_id
       LEFT JOIN (SELECT l.org_id AS org_id, l.hold_id AS hold_id, l.id AS lift_id, l.reason AS reason,
                         a.id AS approval_id, a.actor_user_id AS requested_by
                    FROM hold_lifts l
                    JOIN approvals a ON a.org_id = l.org_id AND a.subject_kind = 'hold_lift'
                                    AND a.subject_id = l.id AND a.state = 'pending') p
              ON p.org_id = h.org_id AND p.hold_id = h.id
      WHERE h.org_id = ? AND h.lifted_at IS NULL
      ORDER BY h.placed_at, h.id`,
  )
    .bind(orgId)
    .all<Row & {
      mailbox_present: string | null;
      lift_id: string | null;
      lift_reason: string | null;
      lift_approval_id: string | null;
      lift_requested_by: string | null;
    }>();

  return results.map((row) => ({
    ...holdOf(row),
    mailboxExists: row.mailbox_present !== null,
    pendingLift: row.lift_id === null || row.lift_approval_id === null ? null : {
      liftId: row.lift_id,
      approvalId: row.lift_approval_id,
      requestedBy: row.lift_requested_by ?? "",
      reason: row.lift_reason ?? "",
    },
  }));
}

/* ---- lifting ---------------------------------------------------------------------------------- */

/**
 * #64's shape for a lift: **one stage, two distinct people**.
 *
 * Not a measured tripwire and not a number anybody may tune — 2 *is* what dual control means, and the
 * receipt behind it is #64's argument that a hold one person can lift quietly is not a hold. The same class
 * as `IMPLICIT_STAGES = [1]`, which means "one decision by somebody who is not the actor".
 *
 * A stage set rather than a bare count, so the lift goes through the machinery #61 already has: `[2]` is
 * parallel dual control, and if lifting ever needed a sequence it would be `[1, 1]` with nothing else
 * changing.
 */
export const LIFT_STAGES: Stages = [2];

export interface HoldLiftRequested {
  liftId: string;
  approvalId: string;
  holdId: string;
  mailboxId: string;
  reason: string;
  /** The stage set the request was opened with, frozen at request time. */
  stages: number[];
  /** Distinct people who could decide it, the requester already excluded. */
  eligible: number;
}

/**
 * Asks for a hold to be lifted, with a reason, and opens the approval two other people have to complete.
 *
 * `org.admin` to ask — the same authority that places one, because starting the process is an administrative
 * act and keeping that set small is free. What the administrator **cannot** do is finish it: they are the
 * approval's `actor_user_id`, and #61's exclusion refuses their own decision (`E_APPROVER_IS_ACTOR`). That is
 * the whole asymmetry #64 chose, and it is enforced by the machinery rather than restated here.
 *
 * ## The reason is mandatory, and mandatory means non-empty
 *
 * A blank reason satisfies `NOT NULL` and answers nothing, so it is refused here — the column can hold the
 * first half of that guarantee and not the second (0021 explains why the table has no CHECK). The text is
 * written to `hold_lifts.reason`, where an approver **meets it before deciding**, copied onto the hold when
 * the lift is applied, and recorded in the `approval.requested` and `hold.lifted` entries. Four places, one
 * writer, and none of them is the only one: a reason that lived only in the audit trail would be invisible to
 * the two people whose decision it is supposed to inform.
 *
 * ## One open question per hold, settled by the database
 *
 * Every statement carries a predicate: *the hold exists, it is not lifted, and no lift is pending on it*.
 * There is deliberately no separate pre-read of that condition — the predicate is the only check, so the
 * ordinary path exercises it and there is nothing that can agree with itself while disagreeing with the
 * database. Two administrators asking at once therefore produce one request and one `E_HOLD_LIFT_PENDING`
 * (#9, the conflict is the signal), which is what makes the "at most one pending lift" that `holdsForReport`
 * and the completion gate both rely on a property rather than an expectation.
 */
export async function requestHoldLift(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  holdId: string,
  reason: string,
): Promise<HoldLiftRequested> {
  await assertAdmin(env, orgId, actorUserId);

  const hold = await env.CATALOG.prepare(
    "SELECT id, mailbox_id, lifted_at FROM holds WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, holdId).first<{ id: string; mailbox_id: string; lifted_at: string | null }>();
  if (hold === null) {
    throw notFound("E_NO_HOLD", {
      what: `hold ${holdId} does not exist`,
      why: "a lift names the hold it releases; there is nothing to lift here",
      fix: "mailda doctor lists every hold in force with its id and scope",
    });
  }

  const stated = reason.trim();
  if (stated === "") {
    throw unprocessable("E_HOLD_LIFT_REASON_REQUIRED", {
      what: "a lift needs a reason, and this one is empty",
      why: "#64 made the reason part of what lifting is: placing preserves and needs no justification, "
        + "lifting re-permits destruction and does. The two people asked to approve it read this text, so a "
        + "blank one asks them to agree to nothing in particular",
      fix: "send {\"reason\":\"...\"} saying why preservation should stop — the matter closed, the custodian "
        + "left, the wrong mailbox was named",
    });
  }

  // Read-then-write, and the predicate below is what makes it safe. Answered here as well because a hold
  // that was lifted last week deserves a sentence rather than a race-shaped refusal.
  if (hold.lifted_at !== null) throw alreadyLifted(holdId, hold.lifted_at);

  const deciders = await decidersOf(env, orgId, hold.mailbox_id);
  const liftId = ctx.id("hlf");
  /*
   * The hold exists, is not lifted, and has no open lift **other than this one**. Carried by every statement
   * in the batch.
   *
   * `l.id != ?` is the load-bearing clause and it is not defensive tidiness. Without it the predicate was
   * invalidated by the batch's own earlier statements: the `approvals` row goes in as `pending`, so by the
   * time the `approval_stages` inserts were evaluated the gate read "a lift is pending on this hold" — true,
   * and about this very request. The stages were silently skipped, and the first approver met
   * `E_APPROVAL_COMPLETE` on an approval whose stage set was empty. Excluding this request makes the
   * predicate mean the same thing at every point in the batch, which is what `AuditGate`'s own contract
   * requires of a gate ("the gated entry must precede the statements that change what it tests") and the
   * only way to satisfy it when several gated statements write the thing being tested.
   */
  const gate = {
    sql: `SELECT 1 FROM holds h
            WHERE h.id = ? AND h.org_id = ? AND h.lifted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM hold_lifts l
                                JOIN approvals a ON a.org_id = l.org_id
                                                AND a.subject_kind = 'hold_lift' AND a.subject_id = l.id
                               WHERE l.org_id = h.org_id AND l.hold_id = h.id AND l.id != ?
                                 AND a.state = 'pending')`,
    params: [holdId, orgId, liftId] as unknown[],
  };

  const planned = planApproval(env, ctx, orgId, {
    subjectKind: "hold_lift",
    subjectId: liftId,
    // The **held** mailbox: who may decide a lift is who holds approval.decide over the mail being preserved.
    mailboxId: hold.mailbox_id,
    actorUserId,
    stages: LIFT_STAGES,
    detail: { holdId, liftId, reason: stated },
  }, deciders, gate);

  if (!planned.satisfiable) {
    // Refused before anything is written, because an open request nobody can complete is worse than a
    // refusal: it reads as waiting for somebody. Same argument #60 made for keeping `deny` out of `awaiting`.
    throw conflict("E_HOLD_LIFT_UNSATISFIABLE", {
      what: `hold ${holdId} cannot be lifted: ${describeShortfall(planned.shortfall, hold.mailbox_id)}`,
      why: "#64 requires two distinct approvers for a lift and excludes whoever requested it, so a mailbox "
        + "with fewer than two other approval.decide holders has no lift anybody can complete. The hold "
        + "stays in force, which is the safe direction",
      fix: `grant approval.decide on mailbox ${hold.mailbox_id} to two people who are not you — `
        + "POST /api/access/grant — then request the lift again. mailda doctor reports this state as "
        + "legal_hold_unliftable before anybody tries",
    });
  }

  const { results } = await auditedBatch<never>(
    env, ctx, orgId, planned.plan.event,
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `INSERT INTO hold_lifts (id, org_id, hold_id, reason)
         SELECT ?,?,?,? WHERE EXISTS (${gate.sql})`,
      ).bind(liftId, orgId, holdId, stated, ...gate.params),
      ...planned.plan.statements,
    ],
    gate,
  );

  if ((results[1]?.meta.changes ?? 0) === 0) {
    // The predicate failed, so nothing was written — not the request, not the approval, not the entry. Two
    // reasons, and they are different answers to the person asking.
    const now = await env.CATALOG.prepare(
      `SELECT h.lifted_at,
              (SELECT a.id FROM hold_lifts l
                 JOIN approvals a ON a.org_id = l.org_id AND a.subject_kind = 'hold_lift'
                                 AND a.subject_id = l.id
                WHERE l.org_id = h.org_id AND l.hold_id = h.id AND a.state = 'pending' LIMIT 1) AS pending
         FROM holds h WHERE h.org_id = ? AND h.id = ? LIMIT 1`,
    ).bind(orgId, holdId).first<{ lifted_at: string | null; pending: string | null }>();
    if (now?.lifted_at != null) throw alreadyLifted(holdId, now.lifted_at);
    throw conflict("E_HOLD_LIFT_PENDING", {
      what: `hold ${holdId} already has a lift waiting to be decided${now?.pending == null ? "" : ` (${now.pending})`}`,
      why: "one hold has one open question at a time: two requests would ask two pairs of approvers about "
        + "the same hold, and whichever finished first would lift it while the other still read as pending",
      fix: "GET /api/approvals to see the open request and its reason. If the reason is wrong, the approvers "
        + "can deny it and a fresh request can be made",
    });
  }

  return {
    liftId,
    approvalId: planned.plan.approvalId,
    holdId,
    mailboxId: hold.mailbox_id,
    reason: stated,
    stages: [...planned.plan.stages],
    eligible: planned.plan.eligible,
  };
}

/** One sentence for the two places that meet a hold somebody has already lifted. */
function alreadyLifted(holdId: string, liftedAt: string): Error {
  return conflict("E_HOLD_ALREADY_LIFTED", {
    what: `hold ${holdId} was lifted at ${liftedAt}`,
    why: "a lifted hold preserves nothing, so there is nothing left to release; the row stays as the record "
      + "of what was preserved and why it stopped being",
    fix: "place a new hold if this mailbox needs preserving again — POST /api/holds",
  });
}
