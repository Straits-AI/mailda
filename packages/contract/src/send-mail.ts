import * as z from "zod";

/**
 * A representative command from the catalog (#3), used to measure validation cost (#15).
 *
 * Deliberately a realistic command rather than a toy: `mail.send` is the most
 * consequential operation in the product and one of the widest schemas. It also exercises
 * the constraints #3 recorded — no `z.date()` (unrepresentable in JSON Schema, so
 * timestamps are ISO strings with `format`), and separate input/output shapes.
 */
export const emailAddress = z.object({
  address: z.string().email().max(320),
  name: z.string().max(255).optional(),
});

export const attachmentRef = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.int().min(0).max(26_214_400),
  disposition: z.enum(["attachment", "inline"]),
  contentId: z.string().max(255).optional(),
});

export const sendMailInput = z.object({
  mailboxId: z.string().regex(/^mbx_[0-9A-HJKMNP-TV-Z]{26}$/),
  senderIdentityId: z.string().regex(/^snd_[0-9A-HJKMNP-TV-Z]{26}$/),
  idempotencyKey: z.string().min(1).max(255),
  to: z.array(emailAddress).min(1).max(50),
  cc: z.array(emailAddress).max(50).default([]),
  bcc: z.array(emailAddress).max(50).default([]),
  replyTo: emailAddress.optional(),
  subject: z.string().max(998),
  bodyText: z.string().max(1_000_000),
  bodyHtml: z.string().max(2_000_000).optional(),
  attachments: z.array(attachmentRef).max(100).default([]),
  headers: z.record(z.string().max(100), z.string().max(1000)).optional(),
  inReplyTo: z.string().max(998).optional(),
  caseId: z.string().regex(/^case_[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  scheduledFor: z.iso.datetime().optional(),
  requireApproval: z.boolean().default(false),
});

export type SendMailInput = z.infer<typeof sendMailInput>;

/** OpenAPI 3.1 uses JSON Schema draft 2020-12, so no lossy conversion (#3). */
export const sendMailInputJsonSchema = z.toJSONSchema(sendMailInput, {
  target: "draft-2020-12",
  io: "input",
});
