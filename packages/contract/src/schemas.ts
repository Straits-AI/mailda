import * as z from "zod";

import { ID_PREFIXES, idPattern } from "@mailda/runtime";

/**
 * What each route accepts and answers (#85 step 2, ADR 12).
 *
 * ## Why these are separate from `routes.ts`
 *
 * The registry pins **which routes exist** and is checked against the handler in both directions. That is
 * step 1, and it is complete: every path and every verb. This file is step 2 — what travels over them — and
 * it is deliberately **partial**, with the boundary declared rather than implied.
 *
 * A schema is only worth having if something checks it. A file of eighty-six hand-written shapes that no
 * test compares against a real response is eighty-six guesses wearing the clothes of a contract, and it
 * would be *worse* than none: a generated client would trust it. So schemas arrive with their validation,
 * one tranche at a time, and `SCHEMALESS` below names what has not been done yet so the gap is a number
 * somebody can watch shrink rather than an impression.
 *
 * ## What validates them
 *
 * `apps/node/worker/test/contract-responses.test.ts` drives each schema-bearing route against a real Node
 * and parses the answer with the schema declared here. A schema that does not describe what the route
 * actually returns fails there, which is the property that makes this a contract instead of documentation.
 *
 * ## Why `.strict()` on responses and not on requests
 *
 * A response schema that tolerated extra keys would pass while the route quietly grew a field the contract
 * does not mention — which is exactly the drift ADR 12 is about, arriving through the door marked
 * "compatible". Requests are the opposite: a caller sending a field this Node ignores is harmless, and
 * refusing it would break every client written against a later version.
 */

/* ------------------------------------------------------------------ shared shapes ------------------- */

/** The four-part refusal every `CallerError` renders. AGENTS.md §3's shape, as a schema. */
export const refusal = z.object({
  error: z.string().min(1),
  message: z.string().min(1),
}).loose();

const isoDate = z.iso.datetime();
const userId = z.string().regex(idPattern(ID_PREFIXES.user));

/* ------------------------------------------------------------------ authentication ------------------ */

export const loginRequest = z.object({
  email: z.string().max(320),
  password: z.string().max(1024),
});

/**
 * What every sign-in answers, whichever mechanism was used.
 *
 * **The shape is the property.** ADR 29 makes passkeys primary and passwords the fallback, and #84's rule is
 * that nothing downstream learns which one signed you in — so `POST /api/auth/login` and
 * `POST /api/auth/passkeys/verify` answer with the same fields, and `credentialId` is the single optional
 * addition that tells a person *which of their own devices* answered. A schema that gave the two routes
 * different shapes would be the first place that property broke.
 */
export const signedInResponse = z.object({
  signedIn: z.literal(true),
  userId,
  organizationId: z.string().min(1),
  accessExpiresAt: z.number().int().positive(),
  credentialId: z.string().min(1).optional(),
}).strict();

export const meResponse = z.object({
  userId,
  organizationId: z.string().min(1),
}).loose();

/* ------------------------------------------------------------------ passkeys (#84) ------------------ */

export const passkeyChallengeRequest = z.object({
  purpose: z.enum(["register", "authenticate"]).optional(),
});

/**
 * The options a browser is handed.
 *
 * Two shapes under one route, because the ceremonies genuinely differ: a registration names the account it
 * is for, and an authentication **must not** — that absence is what stops the route answering *"does this
 * address have a passkey"*, and a union is how a schema can say so.
 */
export const passkeyChallengeResponse = z.object({
  publicKey: z.union([
    z.object({
      challenge: z.string().min(1),
      rp: z.object({ id: z.string(), name: z.string() }),
      user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
      pubKeyCredParams: z.array(z.object({ alg: z.number().int(), type: z.literal("public-key") })),
      attestation: z.literal("none"),
      authenticatorSelection: z.object({ residentKey: z.string(), userVerification: z.string() }),
      excludeCredentials: z.array(z.object({
        id: z.string(), type: z.literal("public-key"), transports: z.array(z.string()).optional(),
      })),
      timeout: z.number().int().positive(),
    }).strict(),
    z.object({
      challenge: z.string().min(1),
      rpId: z.string().min(1),
      userVerification: z.string(),
      timeout: z.number().int().positive(),
    }).strict(),
  ]),
}).strict();

/**
 * One passkey, as the list returns it.
 *
 * **No public key**, and the schema is where that is enforced rather than remembered. `.strict()` means a
 * route that started returning `publicKey` would fail its own contract — which is the only kind of guarantee
 * worth having about a field nobody should send.
 */
export const passkeyRow = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  createdAt: isoDate,
  lastUsedAt: isoDate.nullable(),
  transports: z.array(z.string()).nullable(),
}).strict();

export const passkeyListResponse = z.object({ passkeys: z.array(passkeyRow) }).strict();

export const passkeyRegisteredResponse = z.object({
  registered: z.object({ id: z.string().min(1), label: z.string(), createdAt: isoDate }).strict(),
}).strict();

export const passkeyForgottenResponse = z.object({ forgotten: z.literal(true) }).strict();

/* ------------------------------------------------------------------ the transport (#86) ------------- */

export const transportRequest = z.object({
  accountId: z.string().min(1).max(64),
  apiToken: z.string().min(1).max(512),
});

/**
 * What the transport reports.
 *
 * `.strict()` is load-bearing here for one specific reason: this route reads a **credential** and must never
 * return it. A schema that tolerated extra keys would pass a route that had grown an `apiToken` field, which
 * is the one mistake this surface cannot afford.
 */
export const transportResponse = z.object({
  transport: z.object({
    adapter: z.string().min(1),
    capability: z.object({
      canSend: z.boolean(),
      arbitraryRecipients: z.boolean(),
      verifiedAt: isoDate.nullable(),
      detail: z.string().min(1),
    }).strict(),
    available: z.object({
      binding: z.boolean(),
      rest: z.object({ accountId: z.string(), configuredAt: isoDate }).strict().nullable(),
    }).strict(),
  }).strict(),
}).strict();

export const transportConfiguredResponse = z.object({
  configured: z.object({ accountId: z.string().min(1), configuredAt: isoDate }).strict(),
}).strict();

/* ------------------------------------------------------------------ Butlers (#49, #87) -------------- */

export const butlerSourceFormat = z.enum(["json", "yaml"]);

export const createButlerRequest = z.object({
  name: z.string().min(1).max(200),
  source: z.string().min(1),
  sourceFormat: butlerSourceFormat.optional(),
});

export const editButlerDraftRequest = z.object({
  source: z.string().min(1),
  sourceFormat: butlerSourceFormat.optional(),
});

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const butlerDraftResponse = z.object({
  butler: z.object({
    butlerId: z.string().regex(idPattern(ID_PREFIXES.butler)),
    versionId: z.string().regex(idPattern(ID_PREFIXES.butlerVersion)),
    ast: z.unknown(),
    astSha256: sha256,
    sourceSha256: sha256,
  }).strict(),
}).strict();

export const butlerPublishedResponse = z.object({
  published: z.object({
    butlerId: z.string().regex(idPattern(ID_PREFIXES.butler)),
    versionId: z.string().regex(idPattern(ID_PREFIXES.butlerVersion)),
    version: z.number().int().positive(),
    supersededVersionId: z.string().nullable(),
  }).strict(),
}).strict();

/** The dry run (#87). `limits` is the field that stops a report reading as a green light. */
export const simulationResponse = z.object({
  simulation: z.object({
    butlerId: z.string().regex(idPattern(ID_PREFIXES.butler)),
    butlerName: z.string(),
    versionId: z.string().regex(idPattern(ID_PREFIXES.butlerVersion)),
    version: z.number().int().nullable(),
    state: z.string().min(1),
    reason: z.string().nullable(),
    nodesExecuted: z.number().int().nonnegative(),
    effects: z.array(z.object({
      seq: z.number().int().positive(),
      nodeId: z.string(),
      nodeType: z.string(),
      outcome: z.enum(["ok", "refused", "failed", "would"]),
      reason: z.string().nullable(),
      subject: z.string().nullable(),
      detail: z.record(z.string(), z.unknown()).optional(),
    }).strict()),
    wouldSpend: z.number().int().nonnegative(),
    bindings: z.record(z.string(), z.unknown()),
    limits: z.array(z.string()),
  }).strict(),
}).strict();

export const simulateRequest = z.object({
  facts: z.record(z.string(), z.unknown()),
  event: z.string().optional(),
  key: z.string().optional(),
});
