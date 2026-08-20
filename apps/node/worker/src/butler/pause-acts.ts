import type { Ctx } from "@mailda/runtime";

import { assertAdmin } from "../access.ts";
import { auditedBatch } from "../audit.ts";
import { conflict, notFound, unprocessable } from "../errors.ts";
import type { PauseReason } from "./pause.ts";

/**
 * The two acts that write a `butler_pauses` row: the machine places, a person resumes (#75, §18).
 *
 * ## Why this is a second file
 *
 * `src/doctor.ts` imports `src/butler/pause.ts`, and `test/node/doctor-meter-honesty.test.ts` pins two
 * properties over every file on that path — **no `batch()` and no prepared statement bound to a name** —
 * because `doctor`'s own meter counts `prepare` rather than execution. Both acts here are transactions, so
 * neither can satisfy that. `src/deciders.ts`, `src/notice-delivery.ts` and #66's own split between
 * `src/breakers.ts` and `src/domain-pause.ts` are the same seam, carved for the same reason.
 *
 * ## Who places, who resumes, and why that is the opposite asymmetry to #66's
 *
 * #66 gave the domain pause **ceremony to place** — two administrators and a mandatory reason — and **one
 * administrator to lift**, because placing stops a customer's mail and the harm of a wrongly paused domain
 * grows every minute it stands. This is the same principle producing a different answer, and the reason is
 * that both halves of its premise are different here:
 *
 *   places    the **machine**, automatically, with no human anywhere in it. A breaker that waits for a person
 *             is not a breaker: the chain it stops is measured in minutes, and every link of it is a proposed
 *             send and a Workflow instance. Nothing in this Node lets a person place one — migration 0029
 *             says so and says what a person can do instead.
 *   resumes   **one** administrator, alone, with a **mandatory reason**.
 *
 * **One administrator and not two**, because *an automatic pause nobody can resume is an outage*. Placement
 * needs no administrators at all, so requiring two to undo it would make the machine strictly more powerful
 * than the organization it runs in, and a Node with a single administrator could never restart a Butler the
 * machine stopped. `org.admin` and not *anybody*, because *one anybody can resume is not a pause* — and
 * because it is the authority `src/butlers.ts` already requires to publish a Butler: the person who may make
 * a program live is the person who may make it live again.
 *
 * **A mandatory reason, which inverts `domain_pauses.lifted_reason`**, and the inversion has the same premise
 * as #66's own inversion of #64. A domain pause was placed by two people who wrote down why, so lifting needs
 * no second justification and delay is the harm to avoid. A Butler pause was placed by a **machine**: this
 * resume is the *only* human judgement anywhere in its lifecycle, so a resume with no stated reason would
 * mean nobody recorded a decision at any point in it. And what a wrongly paused Butler costs is **stopped
 * automation, not stopped mail** — the customer's message still arrives, is still filed into the mailbox and
 * is still answerable by hand — so ceremony here delays a convenience rather than somebody's mail. That is
 * the whole of why the two asymmetries point in opposite directions.
 *
 * ## Republishing does not resume, and that is the decision rather than a side effect
 *
 * Nothing in `src/butlers.ts` touches this table, and the pause is keyed on `butler_id`, so a new version
 * inherits the pause its predecessor was stopped under. An operator who fixes a looping Butler has to publish
 * **and** resume. `test/butler-pause.test.ts` holds that as its loudest assertion, because it is the property
 * the whole key choice exists to give and the one a later refactor would remove by accident.
 */

export interface ButlerPausePlaced {
  pauseId: string;
  butlerId: string;
  reason: PauseReason;
}

/**
 * The machine stops a Butler.
 *
 * Called from `triggerButlers`, in the sweeper's invocation, at the moment a detector's reading goes over its
 * limit — so the pause exists **before** the run it refuses would have started, and the delivery that tripped
 * it is on the row.
 *
 * ## Returns `null` when it lost the race rather than throwing
 *
 * Two deliveries into one mailbox can be materialised concurrently, and both can compute a reading over the
 * limit. `bpz_in_force` makes two pauses on one Butler unrepresentable, so exactly one insert commits — and
 * the loser has nothing to report: the Butler is paused, which is what it wanted. Throwing would fail an
 * outbox handler over a race whose outcome was the desired one, and #9's rule is that the conflict is the
 * signal.
 *
 * The gate is the same predicate the insert carries, and it precedes the insert in the batch, which
 * `AuditGate` requires: an entry recording a pause that was not placed would be a false statement in the one
 * table that is supposed to be checkable.
 *
 * ## The actor is `null`, which `kindOfActor` renders as `node`
 *
 * Not the Butler: the Butler did not stop itself, the Node stopped it. Not the person who published it: they
 * are not present and did not decide this. `node` is `src/audit.ts`'s word for *"an alarm, a sweeper"*, and
 * the trigger runs in the sweeper's invocation.
 */
export async function placeButlerPause(
  env: Env,
  ctx: Ctx,
  orgId: string,
  input: {
    butlerId: string;
    butlerName: string;
    reason: PauseReason;
    /** AGENTS.md §3's four parts, already built. See `describeLoopTrip`. */
    detail: string;
    /** The `msg_` id whose arrival took the reading over the limit. */
    trippedBy: string;
  },
): Promise<ButlerPausePlaced | null> {
  /*
   * `bpz`, spelled here and nowhere else, and deliberately **not** in `packages/runtime`'s `ID_PREFIXES`.
   * That registry exists for prefixes *validated* somewhere other than where they are minted — a contract
   * schema, an AST, a route pattern — and its own header says a prefix spelled in exactly one place cannot
   * diverge from anything. A pause id is minted here and matched by a route's `([^/]+)`, so there is no
   * second spelling for this one to disagree with.
   */
  const pauseId = ctx.id("bpz");
  const at = new Date(ctx.now()).toISOString();

  const gate = {
    sql: `SELECT 1 WHERE NOT EXISTS (
            SELECT 1 FROM butler_pauses p
             WHERE p.org_id = ? AND p.butler_id = ? AND p.resumed_at IS NULL)`,
    params: [orgId, input.butlerId] as unknown[],
  };

  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "butler.paused",
      outcome: "ok",
      // See the header. `null` is what makes `actor_kind` say `node`.
      actorUserId: null,
      // The **Butler**, not the pause, so one filter answers everything that has happened to this Butler —
      // `butler.drafted` and `butler.published` are keyed the same way.
      subject: input.butlerId,
      detail: {
        pauseId, butler: input.butlerName, reason: input.reason,
        trippedBy: input.trippedBy, said: input.detail,
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `INSERT INTO butler_pauses
           (id, org_id, butler_id, reason, detail, tripped_by, placed_at,
            resumed_at, resumed_by, resumed_reason)
         SELECT ?,?,?,?,?,?,?,NULL,NULL,NULL WHERE EXISTS (${gate.sql})`,
      ).bind(pauseId, orgId, input.butlerId, input.reason, input.detail, input.trippedBy, at, ...gate.params),
    ],
    gate,
  );

  if ((results[1]?.meta.changes ?? 0) === 0) return null;
  return { pauseId, butlerId: input.butlerId, reason: input.reason };
}

export interface ButlerPauseResumed {
  pauseId: string;
  butlerId: string;
  resumedAt: string;
}

/**
 * A person restarts a Butler. **One administrator, alone, with a reason.** See the header for both halves.
 *
 * The whole act is one conditional `UPDATE` with its audit entry in the same transaction. `resumed_at IS
 * NULL` is what makes two concurrent resumes produce one resume and one refusal (#9), and it is what makes
 * the entry true: an entry written for an `UPDATE` that changed nothing would say an administrator restarted
 * a Butler that was already running.
 */
export async function resumeButlerPause(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  pauseId: string,
  reason: string,
): Promise<ButlerPauseResumed> {
  await assertAdmin(env, orgId, actorUserId);

  const stated = reason.trim();
  if (stated === "") {
    // The database holds nullability; this holds *mandatory*, because SQLite cannot express the difference
    // without a CHECK and a mandatory field satisfied by a space is mandatory in name only. Same split
    // `requestDomainPause` makes on the reason for placing one.
    throw unprocessable("E_BUTLER_PAUSE_REASON_REQUIRED", {
      what: "a Butler resume needs a reason, and this one is empty",
      why: "the pause was placed by a machine, so this is the only human judgement anywhere in its "
        + "lifecycle — a blank reason means nobody recorded a decision at any point in it, and the next "
        + "person to read the trail cannot tell a considered restart from a reflex",
      fix: "send {\"reason\":\"...\"} saying what was fixed, or why the loop was legitimate",
    });
  }

  const paused = await env.CATALOG.prepare(
    "SELECT id, butler_id, placed_at, resumed_at FROM butler_pauses WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, pauseId)
    .first<{ id: string; butler_id: string; placed_at: string; resumed_at: string | null }>();

  if (paused === null) {
    throw notFound("E_NO_BUTLER_PAUSE", {
      what: `${pauseId} is not a Butler pause in this organization`,
      why: "a resume names the pause it releases; there is nothing here to release",
      fix: "GET /api/butler-pauses lists every pause in force with its Butler, its reason and what tripped it",
    });
  }
  if (paused.resumed_at !== null) {
    throw conflict("E_BUTLER_PAUSE_ALREADY_RESUMED", {
      what: `pause ${pauseId} was resumed at ${paused.resumed_at}`,
      why: "a resumed pause stops nothing, so there is nothing left to release; the row stays as the record "
        + "of what was stopped, why, and when it started again",
      fix: `nothing to do — ${paused.butler_id} runs on the next delivery its trigger matches`,
    });
  }

  const at = new Date(ctx.now()).toISOString();
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "butler.resumed",
      outcome: "ok",
      actorUserId,
      // The Butler, like the placement, so one filter answers everything that has happened to it.
      subject: paused.butler_id,
      detail: { pauseId, placedAt: paused.placed_at, reason: stated },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `UPDATE butler_pauses SET resumed_at = ?, resumed_by = ?, resumed_reason = ?
          WHERE org_id = ? AND id = ? AND resumed_at IS NULL`,
      ).bind(at, actorUserId, stated, orgId, pauseId),
    ],
    {
      sql: "SELECT 1 FROM butler_pauses WHERE org_id = ? AND id = ? AND resumed_at IS NULL",
      params: [orgId, pauseId],
    },
  );

  if ((results[1]?.meta.changes ?? 0) === 0) {
    // Somebody else resumed it between the read above and this write. Their resume stands and nothing here
    // was recorded, which is the honest outcome: two entries for one resume would say two administrators
    // restarted a Butler, and one of them did not.
    throw conflict("E_BUTLER_PAUSE_ALREADY_RESUMED", {
      what: `pause ${pauseId} was resumed by somebody else while this request was in flight`,
      why: "the resume and its audit entry share one transaction, so a resume that lost the race recorded "
        + "nothing rather than claiming an act that did not happen",
      fix: `nothing to do — ${paused.butler_id} is running again`,
    });
  }

  return { pauseId, butlerId: paused.butler_id, resumedAt: at };
}
