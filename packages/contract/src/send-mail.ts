import * as z from "zod";

import { ID_PREFIXES, idPattern } from "@mailda/runtime";

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

/**
 * The three identifiers here come from `@mailda/runtime`'s registry rather than from a pattern written
 * beside them (#49).
 *
 * `mbx_` and `snd_` were correct. **`case_` was not**, and it is the divergence #49 recorded: this file
 * required `case_` while `src/cases.ts` mints `ctx.id("cas")`, so a case id this Node produces could not
 * pass its own contract's validation. It was latent only because `caseId` is optional and nothing
 * populates it — and `case.assign` / `case.close` are shipping Butler nodes that name case ids, which is
 * where latent stops. The runtime spelling won, because it is on every row of every installed Node and
 * this one had never matched anything. See `packages/runtime/src/ids.ts` for the full argument, and
 * `apps/node/worker/test/node/id-prefix-world.test.ts` for what now makes a third divergence impossible.
 */
export const sendMailInput = z.object({
  mailboxId: z.string().regex(idPattern(ID_PREFIXES.mailbox)),
  /**
   * **Unconstrained in shape, and that is the correction rather than a relaxation.**
   *
   * This required `/^snd_[…]{26}$/` until 20 August 2026, and `snd_` is the **send manifest** —
   * `0007_outbound.sql` says so on the column itself, *"snd_<ulid>; this IS the effect key"*. A sender
   * identity is a real product concept (§5, §18) with **no table**, so this field was validating one
   * object's id space against another's, and pointing it at `ID_PREFIXES.sendManifest` would have written
   * that collision down as though somebody had decided it. Nothing can say what a sender identity's id
   * looks like until a sender identity exists, so nothing here says. Found by
   * `apps/node/worker/test/node/id-prefix-world.test.ts` the day it was written (#49).
   */
  senderIdentityId: z.string().min(1),
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
  caseId: z.string().regex(idPattern(ID_PREFIXES.case)).optional(),
  scheduledFor: z.iso.datetime().optional(),
  requireApproval: z.boolean().default(false),
});

export type SendMailInput = z.infer<typeof sendMailInput>;

/** OpenAPI 3.1 uses JSON Schema draft 2020-12, so no lossy conversion (#3). */
export const sendMailInputJsonSchema = z.toJSONSchema(sendMailInput, {
  target: "draft-2020-12",
  io: "input",
});
