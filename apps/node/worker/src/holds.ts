import type { Ctx } from "@mailda/runtime";

import { assertAdmin } from "./access.ts";
import { audit, auditedBatch } from "./audit.ts";
import { conflict, notFound, unprocessable } from "./errors.ts";

/**
 * Legal hold — **enforcement**, with no lifting (#64, Layer 5).
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
 * ## Every row in `holds` is active, because nothing can lift one
 *
 * There is **no lift path in this build**, and that is not an omission to be tidied up by whoever reads this
 * next. #64 decided lifting takes dual approval — one stage of `{count: 2}`, distinct on `user_id`, plus a
 * mandatory reason — and #61's approval machinery does not exist. A single-admin lift would contradict that
 * decision, so there is none, and the table has no `lifted_at` for the same reason: a column nothing writes
 * cannot tell a reader whether `NULL` means "still in force" or "lifting was never built".
 *
 * That is why `anyActiveHold` does not overclaim by using the word *active*: the active set and the whole
 * table are the same set today, and the moment a lift lands this file is where the difference appears.
 * `doctor`'s `legal_hold_lift_path` finding names the gap in the report rather than leaving it to a comment,
 * because a gap named only in a comment is the shape of three of this month's defects.
 *
 * ## Placing and refusing are asymmetric
 *
 *   placing   one `org.admin`, alone, immediate, audited `hold.placed` in one transaction with the row.
 *             It only ever preserves; its worst case is wasted bytes, and ceremony in front of it is
 *             exactly how evidence is lost in the hour after somebody realises they need it.
 *   refusing  a deletion refused by a hold is audited `hold.blocked` — an attempt to destroy held mail is
 *             evidence *about the attempt*, and discarding it would be the one omission this mechanism
 *             exists to prevent.
 *
 * ## What consults this, and what cannot
 *
 * `test/node/content-deletion-world.test.ts` is the closed world over every content-destroying call site in
 * `src/` and `migrations/`: each site is declared with its target and whether it carries content, and a site
 * carrying content must name its guard *and have it in the same function*. That test, not this comment, is
 * what keeps the list of call sites true — and it declares its own blind spots, which are dynamic SQL,
 * `wrangler d1 execute`, and the Cloudflare dashboard. The last two are not fixable from inside a Worker.
 */

/** One hold, as the rest of the Node sees it. */
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
 * There is no `lifted_at` predicate here because there is no lift. See the header.
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
      WHERE org_id = ? AND mailbox_id = ?
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
 */
export async function anyActiveHold(env: Env, orgId: string): Promise<boolean> {
  const row = await env.CATALOG.prepare("SELECT id FROM holds WHERE org_id = ? LIMIT 1")
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
    fix: "nothing in this build can lift a hold: #64 requires two distinct approvers and #61's approval "
      + "machinery is not built. Until it is, work with the copy rather than destroying it — an "
      + "administrator can see every hold and its scope in mailda doctor",
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

/** A hold as `doctor` reports it: the hold, plus whether the mailbox it names is still there. */
export interface HoldReportRow extends Hold {
  /** False for a hold enforcing nothing while reporting as active. */
  mailboxExists: boolean;
}

/**
 * Every active hold in the organization, with the existence of its mailbox resolved.
 *
 * One query, one execution, and it lives here rather than in `doctor.ts` so that "which holds are active"
 * has exactly one definition — the one place a lift would have to change. `LEFT JOIN`, because the whole
 * point is to return the holds whose mailbox is **absent**.
 */
export async function holdsForReport(env: Env, orgId: string): Promise<HoldReportRow[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT h.id, h.matter_id, h.mailbox_id, h.from_date, h.to_date, h.placed_by, h.placed_at,
            m.id AS mailbox_present
       FROM holds h
       LEFT JOIN mailboxes m ON m.org_id = h.org_id AND m.id = h.mailbox_id
      WHERE h.org_id = ?
      ORDER BY h.placed_at, h.id`,
  )
    .bind(orgId)
    .all<Row & { mailbox_present: string | null }>();

  return results.map((row) => ({ ...holdOf(row), mailboxExists: row.mailbox_present !== null }));
}
