import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { isAdmin } from "./access.ts";
import { CallerError, notFound, unprocessable } from "./errors.ts";

/**
 * A mailbox's first-response target: the one thing about a mailbox anybody can currently change.
 *
 * ## Why this exists at all, and why it was missing
 *
 * Migration 0017 gave mailboxes `first_response_minutes` with **no default**, on the reasoning that how fast
 * a business answers its customers is not a platform limit and not this Node's to invent. That was right and
 * it shipped incomplete: nothing could set the column, so every mailbox was permanently NULL, every case
 * carried no clock, and the sweep correctly found nothing forever. A decision not to pick a default is only
 * coherent alongside a way to pick one.
 *
 * ## Why an administrator
 *
 * It is a **promise to customers**, not a preference. Setting it declares that this organisation answers
 * within N minutes, and a breach recorded against it is a fact somebody may be asked about — so it takes the
 * same authority as granting access (#39) rather than being something anybody working the queue can adjust
 * to make their own numbers look better.
 *
 * Audited for the same reason: "who decided we promise an hour" is exactly the question an audit exists to
 * answer, and unlike a claim it happens rarely.
 */

/** Minutes, or null to promise nothing. Bounded so a typo cannot silently mean something absurd. */
const MAX_MINUTES = 60 * 24 * 30; // thirty days

export interface TargetOutcome {
  mailboxId: string;
  firstResponseMinutes: number | null;
  /** Whether this mailbox holds back a delivery whose From domain failed DMARC and asks receivers to act (0056). */
  quarantineDmarcFail: boolean;
}

export async function setResponseTarget(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  mailboxId: string,
  minutes: number | null,
): Promise<TargetOutcome> {
  if (!(await isAdmin(env, orgId, actorUserId))) {
    throw new CallerError("E_NOT_AN_ADMINISTRATOR", 403, {
      what: "you are not an administrator of this organization",
      why: "a first-response target is a promise to customers, and a breach against it is a fact somebody may be asked about (#39)",
      fix: "ask somebody who holds org.admin",
    });
  }

  if (minutes !== null) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
      // Zero is rejected rather than accepted as "instant": a target every case breaches on arrival is not a
      // service level, it is a way to make the breach count meaningless. Null is how you promise nothing.
      throw unprocessable("E_BAD_RESPONSE_TARGET", {
        what: `${minutes} is not a usable first-response target`,
        why: "a target under a minute is breached on arrival and says nothing; over thirty days it is not a promise anybody is making",
        fix: `use a whole number of minutes between 1 and ${MAX_MINUTES}, or null to promise nothing`,
      });
    }
  }

  const mailbox = await env.CATALOG.prepare(
    "SELECT id, first_response_minutes, quarantine_dmarc_fail FROM mailboxes WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, mailboxId).first<{ id: string; first_response_minutes: number | null; quarantine_dmarc_fail: number }>();
  if (mailbox === null) {
    throw notFound("E_NO_MAILBOX", {
      what: `mailbox ${mailboxId} does not exist`,
      why: "a target on a mailbox that is not there would be a promise about nothing",
      fix: "check the mailbox id",
    });
  }

  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "mailbox.response_target_set",
      outcome: "ok",
      actorUserId,
      subject: mailboxId,
      // Both values, because the interesting question about a target is usually what it was before.
      detail: { from: mailbox.first_response_minutes, to: minutes },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare("UPDATE mailboxes SET first_response_minutes = ? WHERE org_id = ? AND id = ?")
        .bind(minutes, orgId, mailboxId),
    ],
  );

  return { mailboxId, firstResponseMinutes: minutes, quarantineDmarcFail: mailbox.quarantine_dmarc_fail === 1 };
}

/**
 * The quarantine switch (0056): whether this mailbox holds back a delivery whose From domain failed DMARC
 * and published `quarantine` or `reject`. Off by default, because turning it on decides that some mail will
 * wait for an administrator, and that is the mailbox's owner's to decide — same gate as the target above.
 */
export async function setQuarantineSwitch(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, mailboxId: string, on: boolean,
): Promise<TargetOutcome> {
  if (!(await isAdmin(env, orgId, actorUserId))) {
    throw new CallerError("E_NOT_AN_ADMINISTRATOR", 403, {
      what: "you are not an administrator of this organization",
      why: "quarantine decides whose mail a person will not see until somebody looks",
      fix: "ask somebody who holds org.admin",
    });
  }
  const mailbox = await env.CATALOG.prepare(
    "SELECT id, first_response_minutes, quarantine_dmarc_fail FROM mailboxes WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, mailboxId).first<{ id: string; first_response_minutes: number | null; quarantine_dmarc_fail: number }>();
  if (mailbox === null) {
    throw notFound("E_NO_MAILBOX", {
      what: `mailbox ${mailboxId} does not exist`,
      why: "a switch on a mailbox that is not there would decide nothing",
      fix: "check the mailbox id",
    });
  }
  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "mailbox.quarantine_set", outcome: "ok", actorUserId, subject: mailboxId,
      detail: { from: mailbox.quarantine_dmarc_fail === 1, to: on },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare("UPDATE mailboxes SET quarantine_dmarc_fail = ? WHERE org_id = ? AND id = ?")
        .bind(on ? 1 : 0, orgId, mailboxId),
    ],
  );
  return { mailboxId, firstResponseMinutes: mailbox.first_response_minutes, quarantineDmarcFail: on };
}
