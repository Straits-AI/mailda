import type { Ctx } from "@mailda/runtime";

import { isAdmin } from "./access.ts";
import { auditedBatch } from "./audit.ts";
import { conflict, notFound, unprocessable } from "./errors.ts";
import { noticesDueOnMatterClose } from "./notifications.ts";

/**
 * Matters: the purpose a supervised read is for, as an object with a lifecycle (#63, §7, Layer 5).
 *
 * ## Why this is an object and not a text field, which was forced rather than preferred
 *
 * §7 binds a supervised grant to *"purpose, **matter**, resource scope, session and time"* and requires
 * notifying the employee **after the matter closes**. Free text cannot close. That single requirement decides
 * the shape — this was not a preference between two designs, one of them simply cannot satisfy the contract.
 *
 * It pays for itself twice more. Several grants can belong to one investigation, and §7's *"widening scope
 * requires a new approval"* becomes **a second grant citing the same matter** rather than an edit to a live
 * one. That second property is the one worth stating out loud: an editable grant is an audit trail that can be
 * rewritten in place, and this is what makes every widening a new row with its own two approvers.
 *
 * ## A grant cites a matter **or nothing**
 *
 * Deliberately optional, and the reason is about how investigations actually start: the realistic first act is
 * somebody needing to look at a mailbox *now*, before anybody has decided what the matter is. `holds.matter_id`
 * made the same call in 0018 and #64 left it alone for the same reason. Requiring a matter would produce
 * matters named "unknown" within a week, which is free text again with a table around it.
 *
 * ## What closing does, now that part B has built the other half
 *
 * §7 requires the person whose mail was read to be notified after the matter closes, and the obligation is a
 * row in `notifications` written in the same transaction as the grant. Closing is what **dates** it: the
 * notices this matter was holding get `due_at = max(closed_at, the grant's own expires_at)`, in the close's
 * own transaction, and the one-minute cron delivers them from there.
 *
 * That `max` is the resolution of the collision below. A close can precede the reading it describes — because
 * closing does not revoke a live grant, and deliberately so — which would have let a notice tell somebody
 * their mail *was* read while it still was. Holding the notice until the last grant citing the matter has
 * expired makes "after the matter closes" mean *after the reading stopped*. `src/notifications.ts` carries the
 * argument, including what refusing the close instead would have cost.
 */

/**
 * The kinds of matter this Node recognises. **The declared set, and the only place it is declared.**
 *
 * `matters.type` carries no CHECK constraint — SQLite cannot add one with `ALTER TABLE`, a trigger cannot exist
 * in this tree because `src/migrate.ts` splits migrations on semicolons (`test/node/migrations.test.ts`), and
 * recreating the table would need a `DROP TABLE`, which `test/node/content-deletion-world.test.ts` refuses in
 * `migrations/`. So this union is the constraint, and `test/node/matter-and-scope-world.test.ts` is what makes
 * it one rather than a convention. Two assertions, and the pair is chosen rather than the obvious one: that
 * `matters` has **exactly one writer**, and that `openMatter` calls `isMatterType` **before** its `INSERT`.
 *
 * It does deliberately *not* scan `src/` for undeclared literals, because that scan would be vacuous today —
 * there is no matter-type literal anywhere outside this declaration, since nothing names a type and
 * `openMatter` narrows a string from the wire. A scan over an empty set passes whatever the source says.
 * Exactly how `APPROVAL_SUBJECT_KINDS` is held, minus the one assertion that would mean nothing here.
 *
 * #63 declared the enum open and left it to the tickets that own its members; #64 settled the first outright.
 * The four:
 *
 *   legal_hold           #64's own type. A hold placed to preserve mail for something, cited by
 *                        `holds.matter_id`, and the type that makes `doctor`'s "matter closed but the hold is
 *                        still in force" finding computable at all.
 *   security_incident    a compromised account or a suspected exfiltration, where the mail *is* the evidence.
 *   departure_handover   somebody left and their mailbox has live customer threads in it. The commonest real
 *                        reason anybody reads a colleague's mail, and the one most likely to be done by
 *                        self-grant if the front door has no word for it.
 *   regulatory_request   a regulator or a court asked. #65's eDiscovery export is a supervised act under one
 *                        of these.
 *
 * A fifth type is a one-line change *and* a decision about what the notice to the employee says, which is why
 * the set is closed rather than free.
 */
export const MATTER_TYPES = [
  "legal_hold",
  "security_incident",
  "departure_handover",
  "regulatory_request",
] as const;

export type MatterType = (typeof MATTER_TYPES)[number];

/** Narrows a string from the wire. A type not declared above is refused, never stored. */
export function isMatterType(value: string): value is MatterType {
  return (MATTER_TYPES as readonly string[]).includes(value);
}

export interface Matter {
  id: string;
  type: MatterType;
  description: string;
  openedBy: string;
  openedAt: string;
  /** Null means **open**. Written with `closedBy` by one statement, so one cannot exist without the other. */
  closedAt: string | null;
  closedBy: string | null;
}

interface Row {
  id: string;
  type: MatterType;
  description: string;
  opened_by: string;
  opened_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

function matterOf(row: Row): Matter {
  return {
    id: row.id,
    type: row.type,
    description: row.description,
    openedBy: row.opened_by,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
  };
}

const COLUMNS = "id, type, description, opened_by, opened_at, closed_at, closed_by";

/** One matter, or null. The lookup `src/supervised.ts` needs before it will let a grant cite one. */
export async function readMatter(env: Env, orgId: string, matterId: string): Promise<Matter | null> {
  const row = await env.CATALOG.prepare(
    `SELECT ${COLUMNS} FROM matters WHERE org_id = ? AND id = ? LIMIT 1`,
  ).bind(orgId, matterId).first<Row>();
  return row === null ? null : matterOf(row);
}

/**
 * The matters this caller may see, most recent first. One query, through `mtr_org`.
 *
 * ## `openedBy` is not a filter for convenience — it is the disclosure boundary
 *
 * A matter's description is *"suspected exfiltration by Dana"*. The first version of this function returned
 * every matter in the organization to every authenticated member, which handed that sentence to Dana — and §7
 * requires the person whose mail was read to be told **after the matter closes**, which is a contract that
 * pre-close confidentiality is what makes meaningful. A listing that discloses the investigation on the day it
 * opens is the notice arriving early, badly, and to the wrong audience.
 *
 * So: `null` means every matter and is passed only for an `org.admin`; a user id means the ones that person
 * opened. What that leaves out is the case the open listing was justified by — *"the approvers read this text
 * before deciding"* — and that is served where it belongs instead, on the request itself:
 * `pendingApprovals` carries the cited matter's type and description to the two people being asked. An
 * approver reads the matter they are deciding on, not every matter in the building.
 */
export async function listMatters(
  env: Env,
  orgId: string,
  openedBy: string | null,
): Promise<Matter[]> {
  const mine = openedBy === null ? "" : " AND opened_by = ?";
  const params = openedBy === null ? [orgId] : [orgId, openedBy];
  const { results } = await env.CATALOG.prepare(
    `SELECT ${COLUMNS} FROM matters WHERE org_id = ?${mine} ORDER BY opened_at DESC, id DESC`,
  ).bind(...params).all<Row>();
  return results.map(matterOf);
}

export interface OpenMatterInput {
  type: string;
  description: string;
}

/**
 * Opens a matter. Audited in the same transaction as the row.
 *
 * ## Any member may open one, and that is the decision rather than an oversight
 *
 * A matter on its own confers **nothing** — it is a purpose somebody wrote down, and reading anything still
 * takes a grant two other people approve. Gating it on `org.admin` would mean the only people who can state a
 * purpose are the people who already have the back door, which is exactly backwards: the value of the
 * supervised path is that an investigator, HR or counsel can use it *without* being made an administrator.
 *
 * The check that matters is on the grant, and it is two people who hold `approval.decide` on the mailbox in
 * question. A matter nobody approves a grant against is a row that did nothing.
 *
 * ## The description is mandatory, and mandatory means non-empty
 *
 * A blank description satisfies `NOT NULL` and answers nothing. It is refused here because the column can hold
 * the first half of that guarantee and not the second (0023 explains why the table has no CHECK), and because
 * two people are going to be asked whether reading somebody's mail for this is warranted — a blank matter asks
 * them to agree to nothing in particular. Same split, same argument, as `hold_lifts.reason`.
 */
export async function openMatter(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  input: OpenMatterInput,
): Promise<Matter> {
  if (!isMatterType(input.type)) {
    throw unprocessable("E_MATTER_TYPE_UNKNOWN", {
      what: `${input.type === "" ? "(none)" : input.type} is not a matter type this Node recognises`,
      why: "the type decides what the matter means to everything that reads it — a legal hold cites one, and "
        + "§7's notice to the person whose mail was read is written for a kind of matter, not for free text",
      fix: `send {"type":"..."} as one of ${MATTER_TYPES.join(", ")}`,
    });
  }

  const description = input.description.trim();
  if (description === "") {
    throw unprocessable("E_MATTER_DESCRIPTION_REQUIRED", {
      what: "a matter needs a description, and this one is empty",
      why: "two people are asked to approve reading somebody's mail for this matter, and they read this text "
        + "before deciding; a blank one asks them to agree to nothing in particular",
      fix: "send {\"description\":\"...\"} saying what this matter is — the incident, the departure, the "
        + "regulator's reference",
    });
  }

  const matter: Matter = {
    id: ctx.id("mtr"),
    type: input.type,
    description,
    openedBy: actorUserId,
    openedAt: new Date(ctx.now()).toISOString(),
    closedAt: null,
    closedBy: null,
  };

  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "matter.opened",
      outcome: "ok",
      actorUserId,
      subject: matter.id,
      detail: { type: matter.type, description: matter.description },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `INSERT INTO matters (id, org_id, type, description, opened_by, opened_at, closed_at, closed_by)
         VALUES (?,?,?,?,?,?,NULL,NULL)`,
      ).bind(matter.id, orgId, matter.type, matter.description, matter.openedBy, matter.openedAt),
    ],
  );

  return matter;
}

/**
 * Closes a matter. Conditional on it being open, audited in the same transaction.
 *
 * ## Who may close, and why it is deliberately not only the opener
 *
 * The opener, or any `org.admin`. Closing is the act §7 hangs the employee's notice on, so the person with the
 * most reason to delay it for ever is the investigator who opened the matter — making them the only person who
 * can close it would put the obligation entirely in the hands of the one party it exists to constrain. An
 * administrator can close somebody else's matter, and the trail says who did.
 *
 * ## Closing does not revoke a live grant, and the notice is what absorbs that
 *
 * A grant's authority ends at its own `expires_at` and nowhere else. Cascading revocation from a closed matter
 * would be a second expiry mechanism — a second place for "may this person still read" to be answered — and
 * `authz-read.ts` re-reads the grant on every request, so the honest single answer is the grant's own deadline.
 * What a closed matter *does* change is that no new grant may cite it (`src/supervised.ts` refuses), so the
 * matter cannot be reused to open fresh access after it has been declared over.
 *
 * The consequence part A left open: a close can therefore land while the reading is still going on, and §7
 * hangs its notice on the close. Rather than making the close wait — which would hand the investigator, the
 * one person with a reason to delay it, a way to do so — the **notice** waits: its `due_at` is
 * `max(closed_at, the grant's own expires_at)`, written by the statement in this function's own batch. So
 * closing stays available to anybody entitled to close, and nobody is ever told their mail *was* read while it
 * still is.
 */
export async function closeMatter(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  matterId: string,
): Promise<Matter> {
  const matter = await readMatter(env, orgId, matterId);
  if (matter === null) {
    throw notFound("E_NO_MATTER", {
      what: `matter ${matterId} does not exist`,
      why: "closing names the matter it closes; there is nothing here to close",
      fix: "GET /api/matters lists the matters you opened, with their ids and state — every matter in the "
        + "organization if you hold org.admin",
    });
  }
  if (matter.closedAt !== null) {
    throw conflict("E_MATTER_ALREADY_CLOSED", {
      what: `matter ${matterId} was closed at ${matter.closedAt} by ${matter.closedBy ?? "an unknown actor"}`,
      why: "a matter closes once: §7 makes the notice to the people whose mail was read due after the close, "
        + "and a second close would be a second due date for one obligation",
      fix: "open a new matter if this investigation has resumed — POST /api/matters",
    });
  }
  if (matter.openedBy !== actorUserId && !(await isAdmin(env, orgId, actorUserId))) {
    throw notFound("E_NO_MATTER", {
      what: `matter ${matterId} is not a matter you may close`,
      why: "the person who opened a matter may close it, and so may an org.admin — because the investigator "
        + "is the one party with a reason to leave it open, and §7's notice is due after the close",
      fix: "ask the person who opened it, or somebody holding org.admin, to close it",
    });
  }

  const at = new Date(ctx.now()).toISOString();
  /*
   * Conditional on the matter still being open, and every statement carries it. Two closes landing together
   * would otherwise both record a `matter.closed` entry for one act — #9's shape, the conflict is the signal.
   */
  const gate = {
    sql: "SELECT 1 FROM matters WHERE id = ? AND org_id = ? AND closed_at IS NULL",
    params: [matterId, orgId] as unknown[],
  };

  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "matter.closed",
      outcome: "ok",
      actorUserId,
      subject: matterId,
      detail: { type: matter.type, openedBy: matter.openedBy, openedAt: matter.openedAt },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `UPDATE matters SET closed_at = ?, closed_by = ?
          WHERE id = ? AND org_id = ? AND closed_at IS NULL`,
      ).bind(at, actorUserId, matterId, orgId),
      /*
       * §7's notices become due here, and **after** the close, in the same transaction (#63 part B).
       *
       * The order is load-bearing in both directions. It runs after the `UPDATE matters` so that it can read
       * the `closed_at` that update wrote — one instant, from the row, rather than a second copy of `at` that
       * could disagree with it — and it is inside the same transaction so a matter that closes without dating
       * the notices it was holding is not representable.
       *
       * What it computes is the F-A resolution: `max(closed_at, the grant's own expires_at)`, so "after the
       * matter closes" means after the reading actually stopped. See `noticesDueOnMatterClose`.
       */
      noticesDueOnMatterClose(env, orgId, matterId),
    ],
    gate,
  );

  if ((results[1]?.meta.changes ?? 0) === 0) {
    // Nothing committed: the predicate failed, so somebody else closed it between the read above and this
    // write. Read again rather than reporting the close as ours.
    const now = await readMatter(env, orgId, matterId);
    throw conflict("E_MATTER_ALREADY_CLOSED", {
      what: `matter ${matterId} was closed by somebody else while this close was being prepared`
        + `${now?.closedAt == null ? "" : ` (at ${now.closedAt})`}`,
      why: "one close, one notice: the state moved under this call, so nothing was recorded rather than a "
        + "second entry claiming a second act",
      fix: "GET /api/matters — it is closed",
    });
  }

  return { ...matter, closedAt: at, closedBy: actorUserId };
}
