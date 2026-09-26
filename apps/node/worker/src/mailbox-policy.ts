import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { isAdmin } from "./access.ts";
import { BUDGETS } from "@mailda/budgets";

import { allowedTypesOf } from "./attachments.ts";
import { CallerError, conflict, notFound, unprocessable } from "./errors.ts";
import { mailboxNameOrThrow } from "./mailboxes.ts";

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
  name: string;
  firstResponseMinutes: number | null;
  /** Whether this mailbox holds back a delivery whose From domain failed DMARC and asks receivers to act (0056). */
  quarantineDmarcFail: boolean;
  /** Whether it holds back a delivery carrying an executable, a script, or a program under a document's name (0057). */
  quarantineDangerousAttachments: boolean;
  /** The size bound and the allowed-type list (0065); null is unbounded. */
  attachmentMaxBytes: number | null;
  attachmentAllowedTypes: string[] | null;
}

interface SettingsRow {
  id: string;
  name: string;
  first_response_minutes: number | null;
  quarantine_dmarc_fail: number;
  quarantine_dangerous_attachments: number;
  attachment_max_bytes: number | null;
  attachment_allowed_types: string | null;
}

async function settingsOf(env: Env, orgId: string, mailboxId: string, why: string): Promise<SettingsRow> {
  const row = await env.CATALOG.prepare(
    `SELECT id, name, first_response_minutes, quarantine_dmarc_fail, quarantine_dangerous_attachments,
            attachment_max_bytes, attachment_allowed_types
       FROM mailboxes WHERE org_id = ? AND id = ? LIMIT 1`,
  ).bind(orgId, mailboxId).first<SettingsRow>();
  if (row === null) {
    throw notFound("E_NO_MAILBOX", { what: `mailbox ${mailboxId} does not exist`, why, fix: "check the mailbox id" });
  }
  return row;
}

function outcomeOf(row: SettingsRow): TargetOutcome {
  return {
    mailboxId: row.id,
    name: row.name,
    firstResponseMinutes: row.first_response_minutes,
    quarantineDmarcFail: row.quarantine_dmarc_fail === 1,
    quarantineDangerousAttachments: row.quarantine_dangerous_attachments === 1,
    attachmentMaxBytes: row.attachment_max_bytes,
    attachmentAllowedTypes: allowedTypesOf(row.attachment_allowed_types),
  };
}

/** The two switches a mailbox has, each a column. A third is a third entry here and nowhere else. */
/**
 * A mailbox's name (26 September 2026). A rail row and a queue heading are chosen by name and granted by id,
 * so both names go on the entry, and the update is gated on the old one: two renames landing together do
 * not both record having changed it from the same thing (the shape `renameTeam` settled).
 */
export async function renameMailbox(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, mailboxId: string, rawName: string,
): Promise<TargetOutcome> {
  if (!(await isAdmin(env, orgId, actorUserId))) {
    throw new CallerError("E_NOT_AN_ADMINISTRATOR", 403, {
      what: "you are not an administrator of this organization",
      why: "a mailbox's name is what everybody granted to it sees in their rail",
      fix: "ask somebody who holds org.admin",
    });
  }
  const mailbox = await settingsOf(env, orgId, mailboxId, "renaming names the mailbox it renames");
  const name = await mailboxNameOrThrow(env, orgId, rawName, mailboxId);
  if (mailbox.name === name) {
    throw conflict("E_MAILBOX_NAME_UNCHANGED", {
      what: `mailbox ${mailboxId} is already called ${JSON.stringify(name)}`,
      why: "a rename that changes nothing would put an entry in the trail claiming an act nobody took",
      fix: "send a different name, or leave it as it is",
    });
  }
  await auditedBatch<never>(env, ctx, orgId, {
    action: "mailbox.renamed", outcome: "ok", actorUserId, subject: mailboxId,
    detail: { from: mailbox.name, to: name },
  }, (entry) => [
    entry,
    env.CATALOG.prepare("UPDATE mailboxes SET name = ? WHERE id = ? AND org_id = ? AND name = ?")
      .bind(name, mailboxId, orgId, mailbox.name),
  ]);
  return outcomeOf({ ...mailbox, name });
}

export const QUARANTINE_SWITCHES = {
  dmarc: "quarantine_dmarc_fail",
  attachments: "quarantine_dangerous_attachments",
} as const;
export type QuarantineSwitch = keyof typeof QUARANTINE_SWITCHES;

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

  const mailbox = await settingsOf(env, orgId, mailboxId, "a target on a mailbox that is not there would be a promise about nothing");

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

  return outcomeOf({ ...mailbox, first_response_minutes: minutes });
}

/**
 * A quarantine switch: whether this mailbox holds back a delivery whose From domain failed DMARC and
 * published `quarantine` or `reject` (0056), or one carrying a dangerous attachment (0057). Off by default,
 * because turning one on decides that some mail will wait for an administrator, and that is the mailbox's
 * owner's to decide — same gate as the target above.
 */
export async function setQuarantineSwitch(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, mailboxId: string, which: QuarantineSwitch, on: boolean,
): Promise<TargetOutcome> {
  const column = QUARANTINE_SWITCHES[which];
  if (!(await isAdmin(env, orgId, actorUserId))) {
    throw new CallerError("E_NOT_AN_ADMINISTRATOR", 403, {
      what: "you are not an administrator of this organization",
      why: "quarantine decides whose mail a person will not see until somebody looks",
      fix: "ask somebody who holds org.admin",
    });
  }
  const mailbox = await settingsOf(env, orgId, mailboxId, "a switch on a mailbox that is not there would decide nothing");
  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "mailbox.quarantine_set", outcome: "ok", actorUserId, subject: mailboxId,
      detail: { which, from: mailbox[column] === 1, to: on },
    },
    (entry) => [
      entry,
      // The column name is one of two literals from `QUARANTINE_SWITCHES`, never a caller's string.
      env.CATALOG.prepare(`UPDATE mailboxes SET ${column} = ? WHERE org_id = ? AND id = ?`)
        .bind(on ? 1 : 0, orgId, mailboxId),
    ],
  );
  return outcomeOf({ ...mailbox, [column]: on ? 1 : 0 });
}

/** Extensions: letters and digits, a handful of characters, a bounded list. `.PDF`, `pdf` and ` pdf ` are one. */
const EXTENSION = /^[a-z0-9]{1,12}$/;
const MAX_ALLOWED_TYPES = 64;
/** The bound's ceiling is what a message can be at all: the inbound limit, from its receipt. */
const MAX_ATTACHMENT_BYTES = BUDGETS["email.inbound.max_bytes"];

/**
 * A mailbox's attachment limits (0065): a size bound and an allowed-type list, each null to say nothing.
 * The same gate as the switches, for the same reason: a limit decides that some mail will wait for an
 * administrator, and that a person in the mailbox cannot send what the mailbox will not take.
 */
export async function setAttachmentLimits(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, mailboxId: string,
  asked: { maxBytes?: number | null; allowedTypes?: readonly string[] | null },
): Promise<TargetOutcome> {
  if (!(await isAdmin(env, orgId, actorUserId))) {
    throw new CallerError("E_NOT_AN_ADMINISTRATOR", 403, {
      what: "you are not an administrator of this organization",
      why: "an attachment limit decides whose mail a person will not see until somebody looks",
      fix: "ask somebody who holds org.admin",
    });
  }
  if (asked.maxBytes !== undefined && asked.maxBytes !== null
    && (!Number.isInteger(asked.maxBytes) || asked.maxBytes < 1 || asked.maxBytes > MAX_ATTACHMENT_BYTES)) {
    throw unprocessable("E_BAD_ATTACHMENT_LIMIT", {
      what: `${asked.maxBytes} is not a usable attachment size bound`,
      why: `a bound under a byte holds every attachment; over ${MAX_ATTACHMENT_BYTES} bytes it holds none, since no message that large arrives`,
      fix: `use a whole number of bytes between 1 and ${MAX_ATTACHMENT_BYTES}, or null for no bound`,
    });
  }
  const types = asked.allowedTypes === undefined || asked.allowedTypes === null
    ? asked.allowedTypes
    : [...new Set(asked.allowedTypes.map((one) => one.trim().toLowerCase().replace(/^\./, "")))].sort();
  if (types !== undefined && types !== null) {
    const bad = types.filter((one) => !EXTENSION.test(one));
    if (bad.length > 0 || types.length > MAX_ALLOWED_TYPES || types.length === 0) {
      throw unprocessable("E_BAD_ATTACHMENT_TYPES", {
        what: bad.length > 0 ? `${bad.join(", ")} is not an extension` : `${types.length} types is not a usable list`,
        why: "an allowed-type list is a short list of extensions; an empty one would hold every attachment, and a "
          + "long one is not a policy anybody reads",
        fix: `list between 1 and ${MAX_ALLOWED_TYPES} extensions such as pdf, docx, png, or null to allow any`,
      });
    }
  }
  const mailbox = await settingsOf(env, orgId, mailboxId, "a limit on a mailbox that is not there would hold nothing");
  const next = {
    attachment_max_bytes: asked.maxBytes === undefined ? mailbox.attachment_max_bytes : asked.maxBytes,
    attachment_allowed_types: types === undefined ? mailbox.attachment_allowed_types : types === null ? null : JSON.stringify(types),
  };
  await auditedBatch<never>(env, ctx, orgId, {
    action: "mailbox.attachment_limits_set", outcome: "ok", actorUserId, subject: mailboxId,
    // The columns as stored, not parsed: an audit entry records what was there, and a column that cannot be
    // parsed is exactly the state this act repairs, so parsing it here would make the repair impossible.
    detail: {
      from: { maxBytes: mailbox.attachment_max_bytes, allowedTypes: mailbox.attachment_allowed_types },
      to: { maxBytes: next.attachment_max_bytes, allowedTypes: next.attachment_allowed_types },
    },
  }, (entry) => [
    entry,
    env.CATALOG.prepare(
      "UPDATE mailboxes SET attachment_max_bytes = ?, attachment_allowed_types = ? WHERE org_id = ? AND id = ?",
    ).bind(next.attachment_max_bytes, next.attachment_allowed_types, orgId, mailboxId),
  ]);
  return outcomeOf({ ...mailbox, ...next });
}
