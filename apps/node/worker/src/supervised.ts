import type { Ctx } from "@mailda/runtime";

import { assertObject, SUPERVISED_RELATION } from "./access.ts";
import { describeShortfall, planApproval, type Stages } from "./approvals.ts";
import { auditedBatch } from "./audit.ts";
import { decidersOf } from "./deciders.ts";
import { conflict, notFound, unprocessable } from "./errors.ts";
import { readMatter } from "./matters.ts";

/**
 * `supervised.read` — the sanctioned path to mail somebody holds no standing relation to (#63, §7, Layer 5).
 *
 * ## What this relation is, and why it is not a tuple
 *
 * A supervised read carries four things a `relationship_tuples` row cannot: the **matter** it is for, **how
 * much** of the mailbox, **when it stops**, and **two people who are not the reader** having agreed to all
 * three. `relationship_tuples` has no expiry column — checked, not assumed — and giving it one would put a
 * time comparison into every authorization check in the product for the benefit of one relation, which is the
 * measured path `docs/receipts/authz-check-rows-read.md` describes. So a supervised grant is its own row and
 * `supervised.read` is what `src/authz-read.ts` calls the authority that row confers.
 *
 * It is also the more honest shape. *"Who can read this mailbox"* now has two answers with different
 * structures — a standing relation, and a time-boxed matter-bound grant — and they **are** different things.
 *
 * ## The self-grant is not closed by this, and nothing here claims otherwise
 *
 * `org.admin` can grant any grantable relation to any subject including itself, so an administrator can give
 * themselves `mailbox.content.read` on any mailbox today in one audited call. #63 decided not to close that:
 * refusing a grant where actor and subject match traps a two-person organization, where the only other
 * approver is the person being examined, and "impossible" for an administrator genuinely responsible for a
 * mailbox is the wall that gets solved by editing the database directly. What this module provides is the
 * **front door**; `doctor`'s `self_granted_access` finding makes the back door conspicuous. Stated plainly
 * because the alternative phrasing would be a claim nothing enforces: **this does not prevent an
 * administrator from reading mail.** It makes the two paths distinguishable in the record.
 *
 * ## The request is its own row, and asking again mints a new one
 *
 * The approval's subject is a `supervised_grants` row, not a person-and-mailbox pair, for #64's reason:
 * keying it on the pair would make one denial permanent, and a denial that permanently forecloses a
 * legitimate later investigation is the operational trap that gets solved outside the product. A denied
 * request stays as the record that somebody asked and was told no; a fresh ask is a fresh row with its own
 * two approvers.
 *
 * ## Expiry is a hard stop, and it needed no mechanism
 *
 * Nothing caches authorization. `src/authz-read.ts` re-reads on every call, so the request after the deadline
 * checks and finds the grant over — that is the whole of the enforcement, and it is why this module has no
 * revocation path and no sweep. §7's list of things an expiry must terminate came back **empty** on this
 * Node: nothing presigns, nothing streams, and the raw-evidence read is authorized per request in
 * `authorize()`. `test/supervised-read.test.ts` proves the stop rather than asserting the absence of a cache.
 *
 * **Renewal is a new grant needing fresh approval.** §7 makes time part of the bound scope, so extending it is
 * widening, and widening requires a new approval. The matter is reused; the authorization is not. There is
 * deliberately no `UPDATE` of `expires_at` anywhere — an editable grant is an audit trail that can be
 * rewritten in place.
 *
 * ## Named absent
 *
 * - **Per-act recording.** §7 requires a record of every query, result opened, preview and attachment read.
 *   `src/audit.ts` names the three actions #63 settled on and declares none of them, because a declared
 *   action nothing emits is a category of one. So this Node records **who was granted access, by whom, over
 *   what, until when** — and not what they then read. That is a real gap in §7's contract and it is #63 part
 *   B's work.
 * - **The notification.** §7 requires the person whose mail was read to be told after the matter closes. #63
 *   settled the mechanism — the obligation is a row written in the same transaction as the grant, delivered by
 *   the `scheduled` handler `wrangler.jsonc` already declares, with `doctor` counting the overdue ones — and
 *   #61 deferred its own notification to this ticket explicitly. **No row, no cron branch, no count.** Both
 *   tickets are owed that answer and neither is paid here.
 * - **A maximum duration.** A request states its own duration and nothing caps it, so an approved 10-year
 *   grant is expressible. That is deliberate rather than overlooked: a cap is a number, AGENTS.md admits three
 *   kinds of number and this is none of them — not a platform limit, not measurable against any corpus, and
 *   not an objective computed from evidence. Inventing one would be a figure with no receipt sitting in front
 *   of a governance decision nobody made. The control that does exist is that the deadline is part of what the
 *   two approvers are shown before they decide (`pendingApprovals` carries it), so an implausible duration is
 *   refused by people rather than by a constant. If an organization wants a ceiling, that is a policy object
 *   (#60) with a condition on this subject kind, and it arrives with the ticket that asks for it.
 */

/**
 * How much of a mailbox a supervised grant reaches. **The declared set, and the only place it is declared.**
 *
 * `supervised_grants.scope` carries no CHECK constraint, for the reason `migrations/0023_supervised_read.sql`
 * gives and `APPROVAL_SUBJECT_KINDS` already lives with: SQLite cannot add one with `ALTER TABLE`, a trigger
 * cannot exist in this tree because `src/migrate.ts` splits migrations on semicolons, and recreating the table
 * would need a `DROP TABLE` that `test/node/content-deletion-world.test.ts` refuses in `migrations/`. So this
 * union is the constraint and `test/node/matter-and-scope-world.test.ts` is what makes it one rather than a
 * convention: it requires `supervised_grants` to have exactly one writer, requires that writer to call
 * `isSupervisedScope` before its `INSERT`, and requires both satisfying sets below to name only declared
 * scopes.
 *
 * `as const satisfies` and a derived union rather than a `readonly string[]`, because the last change to this
 * area shipped a helper that accepted any string: `Record<string, X>` makes `keyof` equal `string`, and a
 * mistyped scope would have compiled, matched no grant, and denied silently.
 *
 * **These two words are not invented for this table.** They are the two read relations this product already
 * has, so a scope maps onto a path that exists rather than onto one that would have to be built:
 *
 *   metadata   subject lines and sender addresses — what `mailbox.metadata.read` confers.
 *   content    the bytes — what `mailbox.content.read` confers, which strictly implies the metadata.
 *
 * There is deliberately no third scope for *one message* or *one date range*. An authorization check has a
 * mailbox and no message in hand — `mayReadMetadata` answers a question about a queue — so a finer scope would
 * either grant nothing on that path or leak out-of-scope subject lines while claiming not to. #65's eDiscovery
 * export is the ticket that needs the finer grain, and it needs a different check to hang it on.
 */
export const SUPERVISED_SCOPES = ["metadata", "content"] as const satisfies readonly string[];

export type SupervisedScope = (typeof SUPERVISED_SCOPES)[number];

/** Narrows a string from the wire. A scope not declared above is refused, never stored. */
export function isSupervisedScope(value: string): value is SupervisedScope {
  return (SUPERVISED_SCOPES as readonly string[]).includes(value);
}

/**
 * The scopes that satisfy a **content** read, and the ones that satisfy a **metadata** read.
 *
 * Named here rather than spelled at each check, and the asymmetry is the same one `mayReadMetadata` already
 * encodes for relations: content is strictly the stronger authority, so a content grant satisfies a metadata
 * question and not the other way round. Somebody holding the stronger scope being told they lack the weaker
 * would be a rule with no defence.
 *
 * `satisfies` pins them to the declared union, so a scope renamed above is a compile error here rather than a
 * list that silently stops matching anything.
 */
export const SCOPES_FOR_CONTENT = ["content"] as const satisfies readonly SupervisedScope[];
export const SCOPES_FOR_METADATA = ["metadata", "content"] as const satisfies readonly SupervisedScope[];

/**
 * **The one spelling of "may this person still read".**
 *
 * `granted_at IS NOT NULL AND expires_at > ?` — a requested grant grants nothing, and an expired one grants
 * nothing. Both halves live here and nowhere else, because two spellings of that predicate is exactly the
 * drift `coveringHolds` moved `lifted_at IS NULL` into itself to avoid: the one that counts would be whichever
 * file the reader happened to open.
 *
 * A string constant rather than a whole statement, because there are genuinely two questions with different
 * shapes — *"this one mailbox"* on a check, and *"which mailboxes"* inside the message listing — and the part
 * that can drift dangerously is this one. The two builders below both spell it from here.
 */
export const LIVE_SUPERVISED_GRANT = "granted_at IS NOT NULL AND expires_at > ?";

/**
 * A sub-select answering *"does this person hold a live supervised grant over this mailbox, wide enough?"*.
 *
 * Returned as SQL plus parameters so `hasAnyRelation` can place it as a `UNION ALL` arm of the tuple lookup
 * rather than as a second round trip. That is not a micro-optimisation: `authz.check.max_queries = 2` is a
 * measured tripwire, a third query would break it, and the receipt's whole point is that the authorization
 * path's cost is bounded. Folded into one statement, the extra cost is one seek into `sgr_live` — a **partial**
 * index on `granted_at IS NOT NULL`, so on a Node where nobody holds supervised access it is empty and the
 * seek reads nothing. Measured either way in `test/authz.measure.test.ts`.
 */
export function liveGrantOnMailbox(
  orgId: string,
  userId: string,
  mailboxId: string,
  at: string,
  scopes: readonly SupervisedScope[],
): { sql: string; params: unknown[] } {
  return {
    sql: `SELECT 1 FROM supervised_grants
           WHERE org_id = ? AND subject_id = ? AND mailbox_id = ?
             AND ${LIVE_SUPERVISED_GRANT}
             AND scope IN (${scopes.map(() => "?").join(", ")})`,
    params: [orgId, userId, mailboxId, at, ...scopes],
  };
}

/**
 * The mailboxes a person holds a live supervised grant over, as a sub-select.
 *
 * The many-objects form, for `listMessages`, which bounds its query by a set of mailbox ids rather than
 * checking one. A genuinely different question, so a genuinely different statement — but *"still live"* comes
 * from `LIVE_SUPERVISED_GRANT` above, which is the half that must not disagree.
 *
 * **Bound to the user id alone, never to a team.** A team-held supervised access would defeat the question the
 * record exists to answer — who read this mailbox, under what matter — because team membership is not part of
 * the record and moves independently of it. So this deliberately does not take the `readableSubjects` list
 * that the tuple side uses.
 */
export function liveGrantMailboxes(
  orgId: string,
  userId: string,
  at: string,
  scopes: readonly SupervisedScope[],
): { sql: string; params: unknown[] } {
  return {
    sql: `SELECT mailbox_id FROM supervised_grants
           WHERE org_id = ? AND subject_id = ?
             AND ${LIVE_SUPERVISED_GRANT}
             AND scope IN (${scopes.map(() => "?").join(", ")})`,
    params: [orgId, userId, at, ...scopes],
  };
}

/* ---- requesting ------------------------------------------------------------------------------- */

/**
 * #63's shape for a supervised read: **one stage, two distinct people**.
 *
 * Not a measured tripwire and not a number anybody may tune, exactly as `LIFT_STAGES` is not — 2 *is* what
 * dual control means, and §7 asks for it by name. A stage set rather than a bare count, so this goes through
 * the machinery #61 already has: if supervised reading ever needed counsel to sign before the manager, it is
 * `[1, 1]` with nothing else changing.
 */
export const SUPERVISED_STAGES: Stages = [2];

export interface RequestSupervisedInput {
  mailboxId: string;
  scope: string;
  /** How long the grant should last, in seconds, from the instant it is requested. */
  durationSeconds: number;
  /** The matter this is for, or absent. **Absent is a real answer** — see below. */
  matterId?: string | null;
}

export interface SupervisedRequested {
  grantId: string;
  approvalId: string;
  subjectId: string;
  mailboxId: string;
  scope: SupervisedScope;
  matterId: string | null;
  requestedAt: string;
  expiresAt: string;
  /** The stage set frozen at request time. */
  stages: number[];
  /** Distinct people who could decide it, the requester already excluded. */
  eligible: number;
}

/**
 * Asks for a time-boxed read over a mailbox, and opens the approval two other people have to complete.
 *
 * ## The requester **is** the reader, and that is structural rather than a convenience
 *
 * `subject_id` is the caller, always. A request on somebody else's behalf would put the reader outside #61's
 * actor exclusion — the excluded person would be the requester, leaving the *reader* free to approve their own
 * access. Self-approval reached through a second name is exactly what §18's separation of duty is about, so
 * the two are the same principal by construction and there is no field to get wrong.
 *
 * ## Any member may ask, and the check that matters is on the approval
 *
 * Not gated on `org.admin`, for `openMatter`'s reason: the value of the supervised path is that an
 * investigator, HR or counsel can use it **without** being made an administrator, and gating the ask on
 * `org.admin` would mean the only people who can use the front door are the people who already have the back
 * one. A request confers nothing. What confers is two people holding `approval.decide` on that mailbox, and
 * the requester is not one of them.
 *
 * ## A grant cites a matter **or nothing**
 *
 * #63 settled this: the realistic first act is somebody needing to look at a mailbox *now*, before anybody has
 * decided what the matter is. `holds.matter_id` made the same call in 0018. Requiring one would produce
 * matters named "unknown" within a week, which is free text again with a table around it. What a cited matter
 * must be is **this organization's and still open** — a closed matter is one whose §7 notice is already due,
 * so opening fresh access under it would make that notice a lie.
 */
export async function requestSupervisedRead(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  input: RequestSupervisedInput,
): Promise<SupervisedRequested> {
  if (!isSupervisedScope(input.scope)) {
    throw unprocessable("E_SUPERVISED_SCOPE_UNKNOWN", {
      what: `${input.scope === "" ? "(none)" : input.scope} is not a supervised scope this Node recognises`,
      why: "the scope decides how much of the mailbox this grant reaches, and the two approvers are asked to "
        + "agree to that amount — a scope nothing recognises would match no read path and grant nothing while "
        + "reading as approved",
      fix: `send {"scope":"..."} as one of ${SUPERVISED_SCOPES.join(", ")} — metadata is subject lines and `
        + "sender addresses, content is the bytes",
    });
  }

  // A duration, not a deadline, and it must be a whole positive number of seconds. `0` and a negative value
  // are refused rather than clamped: either would mint a grant that was over before it existed, which is a
  // ceremony involving three people producing nothing. Non-integers are refused because the stored instant
  // would then depend on floating-point arithmetic nobody asked for.
  const seconds = input.durationSeconds;
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw unprocessable("E_SUPERVISED_DURATION_REQUIRED", {
      what: `durationSeconds ${JSON.stringify(input.durationSeconds)} is not a whole number of seconds above zero`,
      why: "a supervised grant with no end is not supervised, and one that ends before it starts would run a "
        + "three-person ceremony for nothing. §7 makes time part of the bound scope, so the deadline is part "
        + "of what the two approvers agree to",
      fix: "send {\"durationSeconds\":259200} for three days. There is no maximum — the ceiling is the two "
        + "people who see the deadline before they approve it",
    });
  }

  // The same refusal a grant on an absent mailbox gets, from the same function rather than a second sentence
  // saying nearly the same thing. A supervised grant on a mailbox that is not there would run the whole
  // ceremony and authorize nothing.
  await assertObject(env, orgId, SUPERVISED_RELATION, input.mailboxId);

  const matterId = input.matterId ?? null;
  if (matterId !== null) {
    const matter = await readMatter(env, orgId, matterId);
    if (matter === null) {
      throw notFound("E_NO_MATTER", {
        what: `matter ${matterId} does not exist`,
        why: "a grant cites the matter it is for, and a citation that resolves to nothing is worse than the "
          + "absent citation this endpoint already allows",
        fix: "GET /api/matters lists the matters you opened, and every matter if you hold org.admin — or "
          + "leave matterId out, because the first act often precedes the matter",
      });
    }
    if (matter.closedAt !== null) {
      throw conflict("E_MATTER_CLOSED", {
        what: `matter ${matterId} was closed at ${matter.closedAt}`,
        why: "§7 makes the notice to the people whose mail was read due after a matter closes, so granting "
          + "fresh access under a closed matter would make that notice untrue about the access it describes",
        fix: "open a new matter if the investigation has resumed — POST /api/matters — or cite none",
      });
    }
  }

  const deciders = await decidersOf(env, orgId, input.mailboxId);
  const grantId = ctx.id("sgr");
  const requestedAt = new Date(ctx.now()).toISOString();
  /*
   * The deadline, computed from `requestedAt` rather than from a second `ctx.now()`.
   *
   * A Worker's clock advances across I/O and `ctx.now()` is not required to be stable, so two calls would put
   * the deadline a few milliseconds off the request it belongs to — the defect `submitPerRecipient` records
   * for `submission_state_at`, where it silently counted a three-recipient send as one.
   *
   * Absolute, and never moved afterwards: what the two approvers are shown before they decide is exactly what
   * they authorize. The residual is stated rather than left to be found — an approval decided *after* this
   * instant produces a grant that is already over, and there is deliberately no second enforcement point for
   * that, because 0022 made the same call for `approvals.expires_at`: a lapsed request an approver can still
   * decide has one terminal check rather than two.
   */
  const expiresAt = new Date(Date.parse(requestedAt) + seconds * 1000).toISOString();

  /*
   * One open question per person per mailbox, settled by the database rather than by a pre-read.
   *
   * Two requests pending at once would ask two pairs of approvers about the same access, and whichever
   * finished first would grant it while the other still read as waiting for somebody — the state #60 refused
   * to let `deny` occupy. A *denied* request does not block: it is not pending, so asking again is a fresh row
   * with fresh approvers, which is the whole reason the approval's subject is a request rather than the pair.
   *
   * `g.id != ?` is the clause `requestHoldLift` paid for and it is load-bearing for the same reason: this
   * batch's own `approvals` insert makes a request pending, so without excluding *this* request the predicate
   * would read "a request is already pending" — true, and about this very row — by the time the
   * `approval_stages` inserts were evaluated, and the stages would be silently skipped.
   */
  const gate = {
    sql: `SELECT 1 FROM mailboxes m
            WHERE m.org_id = ? AND m.id = ?
              AND NOT EXISTS (SELECT 1 FROM supervised_grants g
                                JOIN approvals a ON a.org_id = g.org_id
                                                AND a.subject_kind = 'supervised_read' AND a.subject_id = g.id
                               WHERE g.org_id = m.org_id AND g.subject_id = ? AND g.mailbox_id = m.id
                                 AND g.id != ? AND a.state = 'pending')`,
    params: [orgId, input.mailboxId, actorUserId, grantId] as unknown[],
  };

  const planned = planApproval(env, ctx, orgId, {
    subjectKind: "supervised_read",
    subjectId: grantId,
    mailboxId: input.mailboxId,
    actorUserId,
    stages: SUPERVISED_STAGES,
    detail: { grantId, scope: input.scope, matterId, expiresAt, durationSeconds: seconds },
  }, deciders, gate);

  if (!planned.satisfiable) {
    // Refused before anything is written, for `requestHoldLift`'s reason: an open request nobody can complete
    // reads as waiting for somebody. The honest answer names the shortfall and the back door, because an
    // administrator told only "no" is the person who grants themselves content.read instead.
    throw conflict("E_SUPERVISED_UNSATISFIABLE", {
      what: `no supervised read of mailbox ${input.mailboxId} can be approved: `
        + describeShortfall(planned.shortfall, input.mailboxId),
      why: "§7 requires dual approval and #61 excludes whoever asked, so a mailbox with fewer than two other "
        + "approval.decide holders has no supervised read anybody can complete",
      fix: `grant approval.decide on mailbox ${input.mailboxId} to two people who are not you — `
        + "POST /api/access/grant — then ask again. Until then the only way into that mailbox is an "
        + "administrator granting a standing relation, which doctor reports as self_granted_access when they "
        + "grant it to themselves",
    });
  }

  const { results } = await auditedBatch<never>(
    env, ctx, orgId, planned.plan.event,
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `INSERT INTO supervised_grants
           (id, org_id, subject_id, mailbox_id, scope, matter_id, requested_at, expires_at, granted_at)
         SELECT ?,?,?,?,?,?,?,?,NULL WHERE EXISTS (${gate.sql})`,
      ).bind(grantId, orgId, actorUserId, input.mailboxId, input.scope, matterId, requestedAt, expiresAt,
        ...gate.params),
      ...planned.plan.statements,
    ],
    gate,
  );

  if ((results[1]?.meta.changes ?? 0) === 0) {
    // The predicate failed, so nothing was written — not the request, not the approval, not the entry. The
    // mailbox was proved to exist by `assertObject` above, so the clause that failed is the pending one.
    throw conflict("E_SUPERVISED_PENDING", {
      what: `you already have a supervised read of mailbox ${input.mailboxId} waiting to be decided`,
      why: "one open question at a time: two requests would ask two pairs of approvers about the same access, "
        + "and whichever finished first would grant it while the other still read as pending",
      fix: "GET /api/approvals shows the open request to the people who can decide it. If the scope or the "
        + "duration is wrong, they can deny it and a fresh request can be made",
    });
  }

  return {
    grantId,
    approvalId: planned.plan.approvalId,
    subjectId: actorUserId,
    mailboxId: input.mailboxId,
    scope: input.scope,
    matterId,
    requestedAt,
    expiresAt,
    stages: [...planned.plan.stages],
    eligible: planned.plan.eligible,
  };
}

/* ---- reading a grant --------------------------------------------------------------------------- */

/** One supervised grant, as the approval machinery and the API see it. */
export interface SupervisedGrant {
  id: string;
  subjectId: string;
  mailboxId: string;
  scope: SupervisedScope;
  matterId: string | null;
  requestedAt: string;
  expiresAt: string;
  /** Null until the dual approval completes. **A requested grant grants nothing.** */
  grantedAt: string | null;
}

interface Row {
  id: string;
  subject_id: string;
  mailbox_id: string;
  scope: SupervisedScope;
  matter_id: string | null;
  requested_at: string;
  expires_at: string;
  granted_at: string | null;
}

const COLUMNS =
  "id, subject_id, mailbox_id, scope, matter_id, requested_at, expires_at, granted_at";

function grantOf(row: Row): SupervisedGrant {
  return {
    id: row.id,
    subjectId: row.subject_id,
    mailboxId: row.mailbox_id,
    scope: row.scope,
    matterId: row.matter_id,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    grantedAt: row.granted_at,
  };
}

/*
 * There is deliberately **no** single-grant read here.
 *
 * The one caller that needs one is `decideApproval`, and it reads the row itself — for the reason
 * `readHoldLift` gives one table over: this module calls `planApproval`, so an `approvals.ts` that imported
 * from here would close a cycle. A read placed on the wrong side of that seam is a smaller problem than a
 * cycle, and it is the precedent the lift already set.
 */

/**
 * The supervised grants over this organization's mailboxes that **took effect**, most recent first.
 *
 * Granted rows only: a pending request is visible in the approvals queue, where it is somebody's work, and a
 * denied one is visible in the trail. What this answers is *"who has been let into whose mailbox"*, which is
 * §7's own question and includes grants that have since expired — an expired grant is the record of an access
 * that happened, not an absence. `live` is computed against the caller's instant rather than stored, because
 * a stored one would be a second answer to a question the read path already answers.
 */
export async function grantsForReport(
  env: Env,
  ctx: Ctx,
  orgId: string,
): Promise<Array<SupervisedGrant & { live: boolean }>> {
  const at = new Date(ctx.now()).toISOString();
  const { results } = await env.CATALOG.prepare(
    `SELECT ${COLUMNS} FROM supervised_grants
      WHERE org_id = ? AND granted_at IS NOT NULL ORDER BY granted_at DESC, id DESC`,
  ).bind(orgId).all<Row>();
  return results.map((row) => ({ ...grantOf(row), live: row.expires_at > at }));
}
