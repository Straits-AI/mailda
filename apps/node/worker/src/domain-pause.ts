import type { Ctx } from "@mailda/runtime";

import { assertAdmin } from "./access.ts";
import {
  describeShortfall, NO_TEAM_ROSTERS, planApproval, stageOf, type Stages,
} from "./approvals.ts";
import { auditedBatch } from "./audit.ts";
import { adminsOf } from "./deciders.ts";
import { conflict, notFound, unprocessable } from "./errors.ts";
import { domainOf } from "./policy.ts";

/**
 * The domain-wide send pause: #66's **abuse** breaker, and the one that latches (§18, Layer 5).
 *
 * ## Why this one latches when the three rates do not
 *
 * A rate breaker says *too much, too fast* — the mail is still wanted, so it gates and goes when the window
 * clears (`src/breakers.ts`). A pause says *this must not be sent at all*, and a windowed answer to that would
 * flap: a domain stopped because it is sending something it must not send would resume by itself at the top of
 * the hour. So a pause is a row, and only a person removes it.
 *
 * ## #64's asymmetry, inverted, for the same reason it held there
 *
 * #64 made **placing** a legal hold the easy act — one administrator, immediate, no justification — because
 * placing only ever preserves, and ceremony in front of it is how evidence is lost in the hour after somebody
 * realises they need it. Lifting re-permits destruction, so it takes two people and a reason.
 *
 * Placing a domain pause **stops a customer's mail**. So the safe direction reverses, and the conclusion
 * reverses with it:
 *
 *   place   two distinct administrators (#61's machinery, subject kind `domain_pause`) and a **mandatory
 *           reason** the second one reads before agreeing. The requester is never one of the two.
 *   lift    **one** administrator, alone, immediately, with no reason required — because the harm of a
 *           wrongly-paused domain grows every minute it stands, and a lift waiting for a second person to
 *           wake up is an outage with a governance story attached.
 *
 * Same principle, opposite conclusion, which is what a principle looks like when it is real rather than a
 * habit. The lift is still audited (`domain.pause_lifted`) and still names who did it: what #66 removed is the
 * *ceremony*, not the *record*.
 *
 * ## The eligible set comes from `org.admin`, which is the question 0021 deferred
 *
 * Every other approval subject is about a mailbox, and its approvers are that mailbox's `approval.decide`
 * holders. A pause is about a **domain**, which every mailbox with an address on it sends from — so no single
 * mailbox's holders have authority over it, and naming one would be picking an arbitrary mailbox to decide
 * something about all of them. Migration 0021 named exactly this case on the column it is now renaming and
 * said the kind would have to *"bring a second source for its eligible set"*. `adminsOf` is that source, and
 * `SCOPE_OF` in `src/approvals.ts` is what makes reaching for it a compile-time obligation rather than a habit.
 *
 * ## What is deliberately not here
 *
 * **No `pausesInForce` read.** It is in `src/breakers.ts`, because `doctor` needs it and `doctor`'s cost meter
 * pins a property over every file it imports — no `batch()`, no named prepared statement — that this module
 * cannot satisfy, since placing a pause is a transaction. That is the same seam `src/deciders.ts` and
 * `src/notice-delivery.ts` were carved out along, for the same reason.
 *
 * **No unpause-by-expiry.** A pause with a deadline would resume a domain's mail because a clock ran out
 * rather than because somebody decided the problem was over, which is the flapping this design latched to
 * avoid — one level up.
 */

/**
 * Two distinct administrators, in one stage, neither of them the requester.
 *
 * `[2]` rather than `[1, 1]`: the two decisions are the same decision asked of two people, and there is no
 * order in which one must precede the other. #64's `LIFT_STAGES` made the same call for the same reason, and
 * the shape means the second approver's `approve` completes the request whichever of them answers first.
 */
export const PAUSE_STAGES: Stages = [stageOf(2)];

export interface DomainPauseRequested {
  pauseId: string;
  approvalId: string;
  domain: string;
  reason: string;
  stages: Stages;
  /** Distinct administrators who could decide, the requester already removed. */
  eligible: number;
}

/**
 * Asks two other administrators to stop every send from a domain.
 *
 * Writes the `domain_pauses` row **and** the approval in one transaction, with `placed_at` NULL: a request is
 * not a pause, and the row exists from the moment somebody asks so that the reason the two approvers read is
 * a stored fact rather than a parameter travelling beside the request. A request whose row committed without
 * its approval would be a pause nobody was asked about; the reverse would be an approval whose subject does
 * not exist.
 *
 * ## One open question per domain, settled by the database
 *
 * Every statement carries the same predicate: *no pause is in force on this domain, and no request is pending
 * on it other than this one*. There is deliberately no separate pre-read of that condition — the predicate is
 * the only check, so the ordinary path exercises it and nothing can agree with itself while disagreeing with
 * the database. Two administrators asking at once produce one request and one `E_DOMAIN_PAUSE_PENDING` (#9,
 * the conflict is the signal).
 *
 * `p.id != ?` is the clause that makes the predicate mean the same thing at every point in the batch, and it
 * is not defensive tidiness: without it the `approvals` row this batch inserts as `pending` would, by the time
 * the `approval_stages` inserts were evaluated, make the gate read "a request is pending on this domain" —
 * true, and about this very request. `requestHoldLift` records the same defect, found the same way.
 */
export async function requestDomainPause(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  domainInput: string,
  reason: string,
): Promise<DomainPauseRequested> {
  await assertAdmin(env, orgId, actorUserId);

  // Normalised through the same parse the policy plane uses on a recipient address, so "ACME.example",
  // "@acme.example" and "someone@acme.example" all land on one stored value. A second normalisation here
  // would be a second answer to "what is this domain", and the breaker compares on equality.
  const domain = (domainInput.includes("@") ? domainOf(domainInput) : domainInput.trim().toLowerCase());
  if (domain === "" || !domain.includes(".")) {
    throw unprocessable("E_DOMAIN_PAUSE_DOMAIN_REQUIRED", {
      what: `${JSON.stringify(domainInput)} is not a domain this Node could pause`,
      why: "a pause is compared against the domain of a sealed manifest's From address, so a value that "
        + "cannot be one would be a rule that silently never fires — #60's governing failure",
      fix: "send {\"domain\":\"acme.example\"} — the sending domain, or any address on it",
    });
  }

  const stated = reason.trim();
  if (stated === "") {
    throw unprocessable("E_DOMAIN_PAUSE_REASON_REQUIRED", {
      what: "a domain pause needs a reason, and this one is empty",
      why: "#66 made the reason part of what placing is: this stops every send from the domain, and the two "
        + "administrators asked to approve it read this text — a blank one asks them to agree to nothing in "
        + "particular",
      fix: "send {\"reason\":\"...\"} saying what this domain is doing that has to stop",
    });
  }

  const admins = await adminsOf(env, orgId);
  const pauseId = ctx.id("dpz");

  /*
   * The predicate, and it is anchored on **nothing** rather than on a table.
   *
   * `holds.ts` anchors its gate on the `holds` row it is about, because a lift has a subject that already
   * exists. A pause's subject is the row this batch is inserting, so there is nothing to anchor on — and
   * there is no `organizations` table in this schema to stand in for one. `SELECT 1 WHERE …` is the honest
   * shape: the condition is entirely about what must *not* exist, and inventing a row to hang it off would
   * have made the predicate quietly depend on that row existing (`node_claim` is the obvious candidate and it
   * is absent on an unclaimed Node, which would refuse every pause with a conflict about a race).
   */
  const gate = {
    sql: `SELECT 1
            WHERE NOT EXISTS (SELECT 1 FROM domain_pauses p
                               WHERE p.org_id = ? AND p.domain = ?
                                 AND p.placed_at IS NOT NULL AND p.lifted_at IS NULL)
              AND NOT EXISTS (SELECT 1 FROM domain_pauses p
                                JOIN approvals a ON a.org_id = p.org_id
                                                AND a.subject_kind = 'domain_pause' AND a.subject_id = p.id
                               WHERE p.org_id = ? AND p.domain = ? AND p.id != ?
                                 AND a.state = 'pending')`,
    params: [orgId, domain, orgId, domain, pauseId] as unknown[],
  };

  const planned = planApproval(env, ctx, orgId, {
    subjectKind: "domain_pause",
    subjectId: pauseId,
    // The **organization**: who may decide a pause is who administers the Node whose mail it stops. See
    // `SCOPE_OF`, which is what makes this a decision the compiler asked for rather than a value chosen here.
    scopeId: orgId,
    actorUserId,
    stages: PAUSE_STAGES,
    detail: { pauseId, domain, reason: stated },
  // `NO_TEAM_ROSTERS`: see `requestHoldLift` — a pause's stages name no team (#73), and its approvers come
  // from `org.admin` rather than from a mailbox in any case.
  }, admins, NO_TEAM_ROSTERS, gate);

  if (!planned.satisfiable) {
    // Refused before anything is written, because an open request nobody can complete reads as waiting for
    // somebody. Same argument #60 made for keeping `deny` out of `awaiting`, and #64's lift makes it too.
    //
    // The **safe direction here is refusing to pause**, and that is worth stating because it is the opposite
    // of the hold's: a hold that cannot be lifted keeps preserving, while a pause that cannot be placed keeps
    // sending. Both refusals leave the world as it was, which is the only property either can offer, and the
    // remedy in this case is a second administrator — which a Node with one administrator should have anyway,
    // for the reason `grant` permits admins to grant `org.admin`.
    throw conflict("E_DOMAIN_PAUSE_UNSATISFIABLE", {
      what: `${domain} cannot be paused: ${describeShortfall(planned.shortfall, orgId, "organization")}`,
      why: "#66 requires two distinct administrators to stop a domain's mail and excludes whoever asked, so "
        + "an organization with fewer than two other org.admin holders has no pause anybody can complete. "
        + "The domain keeps sending, which is the only thing a refusal here can leave behind",
      fix: "grant org.admin to two people who are not you — POST /api/access/grant — then ask again. If the "
        + "domain has to stop right now and nobody else holds it, the acts that are available to one "
        + "administrator are a policy that denies (POST /api/policies) and cancelling the sends in flight",
    });
  }

  const { results } = await auditedBatch<never>(
    env, ctx, orgId, planned.plan.event,
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `INSERT INTO domain_pauses (id, org_id, domain, reason, placed_at, lifted_at, lifted_by, lifted_reason)
         SELECT ?,?,?,?,NULL,NULL,NULL,NULL WHERE EXISTS (${gate.sql})`,
      ).bind(pauseId, orgId, domain, stated, ...gate.params),
      ...planned.plan.statements,
    ],
    gate,
  );

  if ((results[1]?.meta.changes ?? 0) === 0) {
    // The predicate failed, so nothing was written — not the row, not the approval, not the entry. Two
    // reasons, and they are different answers to the person asking.
    const now = await env.CATALOG.prepare(
      `SELECT
         (SELECT p.id FROM domain_pauses p
           WHERE p.org_id = ? AND p.domain = ? AND p.placed_at IS NOT NULL AND p.lifted_at IS NULL) AS live,
         (SELECT a.id FROM domain_pauses p
            JOIN approvals a ON a.org_id = p.org_id AND a.subject_kind = 'domain_pause' AND a.subject_id = p.id
           WHERE p.org_id = ? AND p.domain = ? AND a.state = 'pending' LIMIT 1) AS pending`,
    ).bind(orgId, domain, orgId, domain).first<{ live: string | null; pending: string | null }>();

    if (now?.live != null) {
      throw conflict("E_DOMAIN_ALREADY_PAUSED", {
        what: `${domain} is already paused (${now.live})`,
        why: "one domain has one pause: two would need two lifts to restore the mail, and an administrator "
          + "who lifted the one they could see would believe they had",
        fix: `nothing to do — mail from ${domain} is already stopped. To restore it, `
          + `POST /api/domain-pauses/${now.live}/lift, which one administrator may do alone`,
      });
    }
    throw conflict("E_DOMAIN_PAUSE_PENDING", {
      what: `${domain} already has a pause waiting to be decided${now?.pending == null ? "" : ` (${now.pending})`}`,
      why: "one domain has one open question at a time: two requests would ask two pairs of administrators "
        + "about the same domain, and whichever finished first would stop it while the other still read as "
        + "pending",
      fix: "GET /api/approvals to see the open request and the reason it was asked for. If the reason is "
        + "wrong, the administrators can deny it and a fresh request can be made",
    });
  }

  return {
    pauseId,
    approvalId: planned.plan.approvalId,
    domain,
    reason: stated,
    stages: [...planned.plan.stages],
    eligible: planned.plan.eligible,
  };
}

export interface DomainPauseLifted {
  pauseId: string;
  domain: string;
  liftedAt: string;
}

/**
 * Releases a pause. **One administrator, alone**, and that is the decision rather than a shortcut.
 *
 * The whole act is one conditional UPDATE with its audit entry in the same transaction. `lifted_at IS NULL`
 * is what makes two concurrent lifts produce one lift and one refusal (#9), and it is what makes the entry
 * true: an entry written for an UPDATE that changed nothing would say an administrator restored mail that was
 * already flowing.
 *
 * `reason` is optional here and mandatory on the way in, which is the asymmetry stated once more where it is
 * implemented: stopping a customer's mail needs a justification two people read; restarting it does not need
 * one at all, because delay is the harm this direction is trying to avoid. The text is recorded when given.
 */
export async function liftDomainPause(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  pauseId: string,
  reason?: string | null,
): Promise<DomainPauseLifted> {
  await assertAdmin(env, orgId, actorUserId);

  const paused = await env.CATALOG.prepare(
    "SELECT id, domain, placed_at, lifted_at FROM domain_pauses WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, pauseId)
    .first<{ id: string; domain: string; placed_at: string | null; lifted_at: string | null }>();

  if (paused === null) {
    throw notFound("E_NO_DOMAIN_PAUSE", {
      what: `${pauseId} is not a domain pause in this organization`,
      why: "a lift names the pause it releases; there is nothing here to release",
      fix: "GET /api/domain-pauses lists every pause in force with its id, its domain and its reason",
    });
  }
  if (paused.placed_at === null) {
    // A request nobody decided is not a pause, and lifting it would be a third answer to an open question
    // that already has two. The act available on a request is to decide it.
    throw conflict("E_DOMAIN_PAUSE_NOT_PLACED", {
      what: `pause ${pauseId} was requested and never placed, so ${paused.domain} is not stopped`,
      why: "a pause takes two administrators; until they decide, the row is a request and the domain is "
        + "sending normally — there is nothing to lift",
      fix: "POST /api/approvals/:id/decide to deny the request, which closes it. GET /api/approvals finds it",
    });
  }
  if (paused.lifted_at !== null) {
    throw conflict("E_DOMAIN_PAUSE_ALREADY_LIFTED", {
      what: `pause ${pauseId} was lifted at ${paused.lifted_at}`,
      why: "a lifted pause stops nothing, so there is nothing left to release; the row stays as the record "
        + "of what was stopped and when it started again",
      fix: `nothing to do — mail from ${paused.domain} is flowing. Ask for a new pause if it has to stop `
        + "again: POST /api/domain-pauses",
    });
  }

  const at = new Date(ctx.now()).toISOString();
  const stated = reason?.trim() ?? "";

  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "domain.pause_lifted",
      outcome: "ok",
      actorUserId,
      // The pause, like the placement, so one filter answers everything that happened to it.
      subject: pauseId,
      detail: {
        pauseId,
        domain: paused.domain,
        placedAt: paused.placed_at,
        // Null rather than an invented phrase. This Node does not write "no reason given" into a record: an
        // absent justification is an absent justification, and a placeholder reads as one somebody gave.
        reason: stated === "" ? null : stated,
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `UPDATE domain_pauses SET lifted_at = ?, lifted_by = ?, lifted_reason = ?
          WHERE org_id = ? AND id = ? AND placed_at IS NOT NULL AND lifted_at IS NULL`,
      ).bind(at, actorUserId, stated === "" ? null : stated, orgId, pauseId),
    ],
    {
      sql: `SELECT 1 FROM domain_pauses
             WHERE org_id = ? AND id = ? AND placed_at IS NOT NULL AND lifted_at IS NULL`,
      params: [orgId, pauseId],
    },
  );

  if ((results[1]?.meta.changes ?? 0) === 0) {
    // Somebody else lifted it between the read above and this write. Their lift stands and nothing here was
    // recorded, which is the honest outcome: two entries for one lift would say two administrators restored
    // a domain's mail, and one of them did not.
    throw conflict("E_DOMAIN_PAUSE_ALREADY_LIFTED", {
      what: `pause ${pauseId} was lifted by somebody else while this request was in flight`,
      why: "the lift and its audit entry share one transaction, so a lift that lost the race recorded "
        + "nothing rather than claiming an act that did not happen",
      fix: `nothing to do — mail from ${paused.domain} is flowing again`,
    });
  }

  return { pauseId, domain: paused.domain, liftedAt: at };
}
