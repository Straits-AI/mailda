import * as z from "zod";

import { ID_PREFIXES, idPattern } from "@mailda/runtime";

import { AGENT_GRANTABLE_RELATIONS } from "./relations.ts";

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
 * ## Why `.strict()` on responses, and on requests only where it is argued
 *
 * A response schema that tolerated extra keys would pass while the route quietly grew a field the contract
 * does not mention — which is exactly the drift ADR 12 is about, arriving through the door marked
 * "compatible". Requests were the opposite by default: a caller sending a field this Node ignores is usually
 * harmless, and refusing it would break every client written against a later version.
 *
 * **"Usually" was doing too much work, and #93 is where it broke.** That argument holds where an ignored
 * field means *one thing less*. It fails where an ignored field means *the opposite rule* — a policy's
 * condition bag, whose whole purpose is a closed set of five, and where a misspelled key published a version
 * matching every send in the organization and told the caller it was created. So strictness is decided per
 * schema and the decision is written beside it (`policyConditions`, `createPolicyRequest`), rather than
 * turned on globally: routes that genuinely want to tolerate additions still do, and a strict one carries
 * the argument for why it is not one of them.
 *
 * A strict schema also carries the `E_` code its refusal should use, in `.meta({ refusal })`, so the code
 * and the closed set it describes cannot drift apart. `apps/node/worker/src/request-shape.ts` reads it.
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

/**
 * Who this credential is acting as.
 *
 * ## It describes a **principal**, not a user session
 *
 * `userId` was required and `usr_`-patterned, which was true while the only caller was a person. An agent
 * token reaching this route got `userId: "agt_…"` back — a response the route's own contract rejects, in the
 * one place a caller asks *who am I*. `identity.read` is a capability an agent may hold, so this was reachable
 * by design rather than by accident.
 *
 * So the principal's identifier and kind are their own fields, and `userId` stays as the **person**: present
 * for somebody signed in, null for a machine. Nullable rather than absent, because a field that disappears
 * cannot be told apart by a client from a Node too old to send it — the same argument `next_cursor` makes
 * above.
 *
 * `delegatorUserId` is the human accountable when the principal is a machine, which is the same fact
 * `audit_entries` records and the reason a caller can ask *whose authority am I borrowing* without reading the
 * trail.
 */
export const meResponse = z.object({
  /**
   * Always true here — the route answers 401 otherwise. Declared because the handler sends it and the client
   * reads it, and a field that exists in both and in no schema is one nothing can check.
   */
  signedIn: z.literal(true),
  /** The principal itself: `usr_` for a person, `agt_` for an agent. */
  principalId: z.string().min(1),
  principalKind: z.enum(["user", "agent"]),
  /** The person, when the principal is one. Null for a machine. */
  userId: userId.nullable(),
  /** The human accountable for a machine's acts. Null when the principal is that human. */
  delegatorUserId: userId.nullable(),
  organizationId: z.string().min(1),
  /** The person's address. Null for a machine, which has none, and for a person with none recorded. */
  email: z.string().nullable(),
  /*
   * `.strict()`, and the change is the point. This was `.loose()` with two of the fields it actually sends
   * undeclared — so the contract described less than the route answered and nothing could tell. A loose schema
   * on a route this small is not tolerance, it is a place for fields to accumulate unchecked.
   */
}).strict();

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

/* ---------------------------------------- the Node's Cloudflare grant (#162 L1, ADR 42) ------------- */

export const providerState = z.enum([
  "no_client", "awaiting_consent", "account_not_selectable", "consent_granted", "grant_refused",
]);

/**
 * The connection state and the guided ceremony.
 *
 * `.strict()` is load-bearing for `transportResponse`'s reason and one more. This route reads a row holding
 * **four** secrets — the client secret, the access token, the refresh token, and by association the PKCE
 * verifier — and must return none of them. A schema tolerating extra keys would pass a handler that had grown
 * an `accessToken` field, which is the one mistake this surface cannot afford.
 *
 * `evidence` is in the contract rather than left to prose. `account_not_selectable` is a state the Node
 * **cannot observe** — an administrator disabling public OAuth app access produces a consent screen missing
 * an account, with no error and no response the Node ever sees — so every generated surface has to be able to
 * say which of the two kinds of fact it is showing. A field nobody can omit is how that stays true.
 */
export const providerStateResponse = z.object({
  provider: z.object({
    state: providerState,
    evidence: z.enum(["observed", "reported"]),
    clientId: z.string().nullable(),
    redirectUri: z.string().nullable(),
    registeredAt: isoDate.nullable(),
    accountId: z.string().nullable(),
    grantedAt: isoDate.nullable(),
    scopesGranted: z.array(z.string()).nullable(),
    refusedDetail: z.string().nullable(),
  }).strict(),
}).strict();

/**
 * The state **and** the guided ceremony, which only the read route returns.
 *
 * Two schemas rather than one with an optional `ceremony`, and the reason is what optional means here: a
 * writer that forgot to return the steps and a reader that has none would be the same shape, so the route an
 * operator reaches for guidance could stop carrying it without anything failing.
 */
export const providerResponse = z.object({
  provider: providerStateResponse.shape.provider,
  ceremony: z.object({
    steps: z.array(z.string().min(1)).min(1),
    redirectUri: z.string().min(1),
    capabilities: z.array(z.object({
      capability: z.string().min(1),
      why: z.string().min(1),
      layer: z.string().min(1),
    }).strict()).min(1),
    /*
     * Not optional, and that is the point. The scope names are not measured, and an operator following
     * printed steps is entitled to know which parts of them this Node has verified — so the admission is a
     * required field rather than a sentence somebody may forget to render.
     */
    unmeasured: z.string().min(1),
  }).strict(),
}).strict();

/** The client id and secret the operator created in the dashboard. The redirect URI is not theirs to choose. */
export const providerClientRequest = z.object({
  clientId: z.string().min(1).max(128),
  clientSecret: z.string().min(1).max(512),
}).strict().meta({ refusal: "E_PROVIDER_FIELD_UNKNOWN" });

export const providerAuthorizeRequest = z.object({
  /*
   * The operator supplies these because this repository has not measured Cloudflare's scope names: they
   * correspond to API-token permission names and are enumerated from an endpoint needing a token. The
   * operator selected them in Cloudflare's own picker when they created the client, so they are the only
   * party who knows the strings.
   */
  scopes: z.array(z.string().min(1)).max(64),
}).strict().meta({ refusal: "E_PROVIDER_FIELD_UNKNOWN" });

export const providerAuthorizeResponse = z.object({
  authorize: z.object({ url: z.string().min(1) }).strict(),
}).strict();

/** What the callback did. Carries no token, by the same `.strict()` argument. */
export const providerConsentResponse = z.object({
  consent: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    detail: z.string().nullable(),
    accountId: z.string().nullable(),
    scopesGranted: z.array(z.string()),
    /** Asked for and not granted. Computed by this Node, because Cloudflare reports only what it gave. */
    scopesDeclined: z.array(z.string()),
  }).strict(),
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

/* ------------------------------------------------------------------ the ledgers --------------------- */

/**
 * The read surfaces, tranche two (#85 step 2).
 *
 * Written from the shapes `src/client/app/api.ts` declares — the consumer's own view, exercised by every
 * screen — and then **arbitrated by the test**, which seeds a real row and parses the real answer. That
 * order is deliberate: a schema derived from a reading of nine SQL projections would be nine chances to
 * transcribe one wrong, and the transcription would be invisible. A schema derived from the consumer and
 * checked against the producer fails loudly when the two disagree, which is the disagreement worth finding.
 */

/**
 * What `/health` answers.
 *
 * `schema` is the last migration applied, and it is the field that makes this endpoint worth having: a Node
 * that answers at all but is behind on migrations is the failure a bare `ok: true` cannot express. The first
 * draft of this schema *did* say `ok: boolean`, and the route has never returned one — which is the whole
 * reason step 2's schemas arrive with a test that drives the route.
 */
export const healthResponse = z.object({
  node: z.literal("mailda"),
  schema: z.string().min(1),
  claimed: z.boolean(),
  outboxPending: z.number().int().nonnegative(),
  at: isoDate,
}).loose();

/** One `doctor` finding. `fix` is present only when there is something to do about it. */
export const doctorFinding = z.object({
  check: z.string().min(1),
  severity: z.enum(["report", "degraded", "refuse"]),
  discloses: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().min(1),
  fix: z.string().min(1).optional(),
  receipt: z.string().min(1).optional(),
}).strict();

export const doctorResponse = z.object({
  verdict: z.enum(["ok", "degraded", "refuse"]),
  claimed: z.boolean(),
  at: isoDate,
  findings: z.array(doctorFinding),
}).loose();

export const mailboxRow = z.object({
  id: z.string().regex(idPattern(ID_PREFIXES.mailbox)),
  name: z.string(),
  unclaimed: z.number().int().nonnegative(),
  claimed: z.number().int().nonnegative(),
  mine: z.number().int().nonnegative(),
  first_response_minutes: z.number().nullable(),
  breached: z.number().int().nonnegative(),
  addresses: z.string().nullable(),
}).strict();

export const mailboxListResponse = z.object({ mailboxes: z.array(mailboxRow) }).strict();

export const messageRow = z.object({
  id: z.string().min(1),
  message_id: z.string().nullable(),
  subject: z.string().nullable(),
  from_addr: z.string().nullable(),
  envelope_from: z.string(),
  envelope_to: z.string(),
  mailbox_id: z.string(),
  raw_bytes: z.number().int().nonnegative(),
  accepted_at: isoDate,
  parse_error: z.string().nullable(),
  conversation_id: z.string().nullable(),
  case_id: z.string().nullable(),
}).strict();

export const messageListResponse = z.object({
  messages: z.array(messageRow),
  /**
   * Where the next page resumes, or null (#91).
   *
   * `nullable()` rather than `optional()`, because the two say different things and only one of them is true:
   * a null is the Node saying *"nothing older is visible to you at this instant"*, which is an answer. An
   * absent field would be the Node saying nothing, and a client cannot tell that apart from a Node too old to
   * page — which is how a reader ends up with the same fifty messages and no way to know there are more.
   */
  next_cursor: z.string().nullable(),
}).loose();

export const auditRow = z.object({
  id: z.string().min(1),
  seq: z.number().int().positive(),
  at: isoDate,
  actor_user_id: z.string().nullable(),
  actor_kind: z.string().min(1),
  /**
   * The person accountable for an act a machine performed; null when the actor is a person acting for
   * themselves, which is nearly every entry.
   *
   * **Required, and nullable** — not optional. The column had been written and hashed into the chain since
   * #109 L1 while the route selected it nowhere and no surface showed it, so the trail knew which human stood
   * behind an `agt_` and no reader could ask (audit P1-1). Optional here would let a Node answer without the
   * field and stay in contract, which is the same silence in a new place: a client cannot tell "nobody was
   * delegated" apart from "this Node does not say".
   */
  delegator_user_id: z.string().nullable(),
  action: z.string().min(1),
  subject: z.string().nullable(),
  outcome: z.string().min(1),
  detail: z.string(),
  hash: sha256,
}).strict();

export const auditListResponse = z.object({ entries: z.array(auditRow) }).loose();

export const logRow = z.object({
  // A `log_` identifier, not a rowid. The client had this right and the first draft of this schema did not.
  id: z.string().min(1),
  at: isoDate,
  level: z.string().min(1),
  event: z.string().min(1),
  message: z.string(),
  detail: z.string().nullable(),
  request_id: z.string().nullable(),
}).strict();

export const logListResponse = z.object({
  entries: z.array(logRow),
  counts: z.array(z.object({ level: z.string(), n: z.number().int() }).strict()),
}).loose();

/**
 * One rate breaker's reading.
 *
 * `sentence` is here because #66's rule is that a limit a developer can hit is one they must see, and the
 * number alone does not say what it means. A schema without it would let the field be dropped.
 */
export const breakerReading = z.object({
  breaker: z.string().min(1),
  sentence: z.string().min(1),
  observations: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  percent: z.number().nullable(),
  limit: z.number().int(),
  windowSeconds: z.number().int().positive(),
  armed: z.boolean(),
  unarmedReason: z.literal("no_observations").nullable(),
  tripped: z.boolean(),
  /*
   * **Two fields the client's own `BreakerReading` does not declare**, found by this schema's first run
   * against the real route. Not a bug — nothing in the interface reads them — but it is precisely the drift
   * ADR 12 is about: the consumer's view and the producer's answer had quietly diverged, and neither side
   * could have noticed. `retryAfterExact` says whether `retryAfterSeconds` is a computed instant or an
   * estimate, which is the difference between telling somebody *when* they may send and roughly when.
   */
  retryAfterSeconds: z.number().int().nullable(),
  retryAfterExact: z.boolean(),
}).strict();

export const breakerListResponse = z.object({ breakers: z.array(breakerReading) }).loose();

export const notificationRow = z.object({
  id: z.string().min(1),
  kind: z.enum(["supervised_read", "approval_request"]),
  subjectId: z.string().min(1),
  mailboxId: z.string().nullable(),
  matterId: z.string().nullable(),
  dueAt: isoDate.nullable(),
  deliveredAt: isoDate.nullable(),
  body: z.unknown(),
}).strict();

export const notificationListResponse = z.object({
  notifications: z.array(notificationRow),
}).strict();

/* ------------------------------------------------------------------ people and teams (#73, #83) ---- */

export const personRow = z.object({
  id: userId,
  email: z.string().min(1),
  created_at: isoDate,
  relations: z.array(z.object({
    relation: z.string().min(1),
    objectType: z.string().min(1),
    objectId: z.string().min(1),
  }).strict()),
}).strict();

export const peopleListResponse = z.object({ people: z.array(personRow) }).loose();

export const teamRow = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: isoDate,
  /*
   * **Another field the client's own `TeamRow` does not declare**, found the same way `BreakerReading`'s two
   * were: by parsing the real answer. Who made a team is who a reader asks about when its grants turn out to
   * be wider than expected, so it is worth having in the contract even while no screen renders it.
   */
  createdBy: userId,
  memberCount: z.number().int().nonnegative(),
}).strict();

export const teamListResponse = z.object({ teams: z.array(teamRow) }).loose();
export const teamMembersResponse = z.object({ members: z.array(z.string().min(1)) }).loose();

export const invitationRow = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  invitedBy: userId,
  createdAt: isoDate,
  expiresAt: isoDate,
  /**
   * Computed at read time rather than stored, and the schema says so by carrying it beside `expiresAt`.
   * An invitation that has passed its window is still a row — the history of who was invited survives
   * every redemption — so "expired" is a question about now, not a state a row moves into.
   */
  expired: z.boolean(),
}).strict();

export const invitationListResponse = z.object({ invitations: z.array(invitationRow) }).loose();

/* ------------------------------------------------------------------ governance --------------------- */

export const matterRow = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  description: z.string(),
  openedBy: userId,
  openedAt: isoDate,
  closedAt: isoDate.nullable(),
  closedBy: userId.nullable(),
}).strict();

export const matterListResponse = z.object({ matters: z.array(matterRow) }).loose();

export const holdRow = z.object({
  id: z.string().min(1),
  matterId: z.string().nullable(),
  mailboxId: z.string().min(1),
  fromDate: z.string().nullable(),
  toDate: z.string().nullable(),
  placedBy: userId,
  placedAt: isoDate,
  /**
   * Whether the mailbox a hold names still exists.
   *
   * Computed, and it is the field that stops a hold list quietly describing preservation over something
   * gone. A schema without it would let the answer be dropped and the list keep looking complete.
   */
  mailboxExists: z.boolean(),
  pendingLift: z.object({
    liftId: z.string().min(1),
    approvalId: z.string().min(1),
    requestedBy: userId,
    reason: z.string(),
  }).strict().nullable(),
}).strict();

export const holdListResponse = z.object({ holds: z.array(holdRow) }).loose();

export const domainPauseRow = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  placedAt: isoDate,
  reason: z.string(),
}).strict();

export const domainPauseListResponse = z.object({ pauses: z.array(domainPauseRow) }).loose();

export const policyVersionRow = z.object({
  policy_id: z.string().min(1),
  name: z.string().min(1),
  version_id: z.string().min(1),
  version: z.number().int().nullable(),
  state: z.enum(["draft", "published", "superseded"]),
  outcome: z.enum(["allow", "hold", "require_approval", "deny"]),
  when_mailbox_id: z.string().nullable(),
  when_actor_user_id: z.string().nullable(),
  when_recipient_external: z.number().int().nullable(),
  when_is_reply: z.number().int().nullable(),
  when_org_daily_volume_min: z.number().int().nullable(),
  created_at: isoDate,
  published_at: isoDate.nullable(),
  superseded_at: isoDate.nullable(),
}).strict();

export const policyListResponse = z.object({ policies: z.array(policyVersionRow) }).loose();

export const exportRow = z.object({
  id: z.string().min(1),
  matterId: z.string().min(1),
  mailboxId: z.string().min(1),
  requestedBy: userId,
  maxMessages: z.number().int().positive(),
  state: z.string().min(1),
  stateReason: z.string().nullable(),
  messagesEmitted: z.number().int().nonnegative(),
  requestedAt: isoDate,
  completedAt: isoDate.nullable(),
}).strict();

export const exportListResponse = z.object({ exports: z.array(exportRow) }).loose();

/* ------------------------------------------------------------------ Butlers, read ------------------ */

export const butlerRow = z.object({
  id: z.string().regex(idPattern(ID_PREFIXES.butler)),
  name: z.string().min(1),
  created_at: isoDate,
  live_version_id: z.string().nullable(),
  live_version: z.number().int().nullable(),
  published_at: isoDate.nullable(),
  draft_version_id: z.string().nullable(),
  /** A machine stopped it (#75). Null is the ordinary state; the object is what a reader needs next. */
  pause: z.object({
    pauseId: z.string().min(1),
    butlerId: z.string().min(1),
    butlerName: z.string(),
    reason: z.string().min(1),
    detail: z.string(),
    trippedBy: z.string(),
    placedAt: isoDate,
  }).strict().nullable(),
}).strict();

export const butlerListResponse = z.object({ butlers: z.array(butlerRow) }).loose();

export const butlerVersionRow = z.object({
  id: z.string().regex(idPattern(ID_PREFIXES.butlerVersion)),
  version: z.number().int().nullable(),
  state: z.enum(["draft", "published", "superseded"]),
  source_format: butlerSourceFormat,
  ast_sha256: sha256,
  source_sha256: sha256,
  created_by: userId,
  created_at: isoDate,
  published_by: userId.nullable(),
  published_at: isoDate.nullable(),
  superseded_at: isoDate.nullable(),
  /** Withheld for a superseded version: its bytes are immutable and named by its digest (#77). */
  source_text: z.string().nullable(),
}).strict();

export const butlerDetailResponse = z.object({
  butler: z.object({ id: z.string(), name: z.string(), created_at: isoDate }).loose(),
  versions: z.array(butlerVersionRow),
}).loose();

export const butlerRunRow = z.object({
  id: z.string().min(1),
  butler_id: z.string().min(1),
  version_id: z.string().min(1),
  trigger_event: z.string().min(1),
  trigger_key: z.string().min(1),
  state: z.string().min(1),
  /*
   * **A third field the client's own interface omits**, after `BreakerReading`'s two and `TeamRow`'s one.
   * `RUN_COLUMNS` is shared by the list and the single read, so both have always returned it.
   *
   * It surfaced late for a reason worth recording: tranche three asserted the runs list was empty, so the
   * row schema was declared and never exercised. A list schema is only as good as a row to check it with,
   * and this is what that costs when there is not one.
   *
   * `state_at` is when the run entered its current state, which is not `finished_at` — a run parked on a
   * release gate has the first and not the second.
   */
  state_at: isoDate,
  outcome_reason: z.string().nullable(),
  started_at: isoDate,
  finished_at: isoDate.nullable(),
  nodes_executed: z.number().int().nonnegative(),
  effects: z.number().int().nonnegative(),
  refusals: z.number().int().nonnegative(),
  subrequests_spent: z.number().int().nonnegative(),
  replay_of: z.string().nullable(),
  replayed_by: z.string().nullable(),
}).strict();

export const butlerRunListResponse = z.object({ runs: z.array(butlerRunRow) }).loose();
export const butlerPauseListResponse = z.object({
  pauses: z.array(z.object({
    pauseId: z.string().min(1),
    butlerId: z.string().min(1),
    butlerName: z.string(),
    reason: z.string().min(1),
    detail: z.string(),
    trippedBy: z.string(),
    placedAt: isoDate,
  }).strict()),
}).loose();

/* ------------------------------------------------------------------ the acts ----------------------- */

/**
 * Tranche four (#85 step 2): what the write routes answer.
 *
 * Captured by driving every one of them against a real Node and reading the body, then written down —
 * which is the opposite order from the ledgers above and the right one here. A write's answer is not
 * declared anywhere on the consumer side: `butlerAct` and its siblings return `unknown` and the screens
 * destructure what they need, so there was no second view to compare against and no divergence to find.
 * What these schemas add is the first statement of the shape at all.
 */

export const teamCreatedResponse = z.object({ team: teamRow.omit({ memberCount: true }) }).strict();
export const teamDetailResponse = z.object({
  team: teamRow.omit({ memberCount: true }),
  members: z.array(z.string().min(1)),
}).strict();

/**
 * Adding or removing somebody from a team.
 *
 * `changed` is the field worth having: both routes are idempotent, so the answer to *"was this already the
 * case"* is the only thing distinguishing a no-op from an act, and `members` is the count afterwards rather
 * than a delta — a caller reconciling a roster wants the state, not the change.
 */
export const teamMembershipResponse = z.object({
  membership: z.object({
    teamId: z.string().min(1),
    userId,
    changed: z.boolean(),
    members: z.number().int().nonnegative(),
  }).strict(),
}).strict();

/**
 * Minting an invitation, and the one route in this product that returns a secret.
 *
 * **Deliberate, and the only time it is readable.** `invitations` stores the hash, so a lost invitation is
 * re-minted rather than recovered — the same mechanism `mailda claim-secret` uses and the same sentence it
 * prints. The schema names the field so that its presence is a decision on the record, not an accident
 * somebody notices in a log.
 *
 * `replacedId` is the invitation this one withdrew, because `inv_one_open_per_email` permits one at a time:
 * re-inviting somebody revokes the outstanding one, and a caller that did not know would leave a colleague
 * holding a secret that no longer works.
 */
export const invitationCreatedResponse = z.object({
  invitation: z.object({
    invitationId: z.string().min(1),
    email: z.string().min(1),
    expiresAt: isoDate,
    secret: z.string().min(1),
    replacedId: z.string().nullable(),
  }).strict(),
}).strict();

export const matterResponse = z.object({ matter: matterRow }).strict();

/**
 * Placing a hold.
 *
 * Deliberately **not** `holdRow`: the list computes `mailboxExists` and `pendingLift`, which are questions
 * about now rather than columns, and neither is knowable at the moment of placing one. Reusing the list's
 * shape here would have been the tidier-looking mistake.
 */
export const holdPlacedResponse = z.object({
  hold: holdRow.omit({ mailboxExists: true, pendingLift: true }),
}).strict();

export const accessResponse = z.object({
  subjectId: z.string().min(1),
  relations: z.array(z.object({
    relation: z.string().min(1),
    objectType: z.string().min(1),
    objectId: z.string().min(1),
    createdAt: isoDate,
  }).strict()),
}).loose();

export const supervisedListResponse = z.object({
  supervised: z.array(z.object({
    id: z.string().min(1),
    subjectId: z.string().min(1),
    mailboxId: z.string().min(1),
    scope: z.string().min(1),
    matterId: z.string().nullable(),
    requestedAt: isoDate,
    expiresAt: isoDate,
    grantedAt: isoDate.nullable(),
    live: z.boolean(),
  }).strict()),
}).loose();

export const caseListResponse = z.object({
  cases: z.array(z.object({
    id: z.string().regex(idPattern(ID_PREFIXES.case)),
    conversation_id: z.string().min(1),
    mailbox_id: z.string().min(1),
    state: z.enum(["open", "claimed", "closed"]),
    state_at: isoDate,
    assignee: z.string().nullable(),
    claimed_at: isoDate.nullable(),
    created_at: isoDate,
    subject: z.string().nullable(),
    from_addr: z.string().nullable(),
    content_restricted: z.boolean(),
    message_count: z.number().int().nonnegative(),
    assignee_email: z.string().nullable(),
    response_due_at: isoDate.nullable(),
    first_response_at: isoDate.nullable(),
    response_breached_at: isoDate.nullable(),
  }).strict()),
}).loose();

export const draftRow = z.object({
  id: z.string().min(1),
  mailboxId: z.string().min(1),
  inReplyToMessageId: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  /** The body's size beside the body, so a list can render one without measuring the other. */
  bodyBytes: z.number().int().nonnegative(),
  /**
   * Why `body` is empty when `bodyBytes` says it should not be (#143).
   *
   * `null` when the body is what was written. `unreadable` means the object is present and this vault cannot
   * open it — the ADR 28 loss the recovery codes exist for, and it may clear. `missing` means the object is
   * gone and the row saying it existed is not, which is ADR 32's reportable-only side.
   *
   * In the payload because it was silence, and an empty body in a composer is an invitation to type over
   * evidence that was never lost. A client that cannot tell the states apart cannot help.
   */
  bodyUnavailable: z.enum(["missing", "unreadable"]).nullable(),
  updatedAt: isoDate,
}).strict();

export const draftListResponse = z.object({ drafts: z.array(draftRow.omit({ body: true })) }).loose();
export const draftSavedResponse = z.object({ draft: draftRow }).strict();

export const sendListResponse = z.object({
  // Tightened from `z.unknown()` in tranche seven, once a sealed manifest could be produced to check it
  // against. A list schema whose elements are unknown checks an envelope and nothing in it.
  sends: z.array(z.lazy(() => sendRow)),
  /** Today's count, for the volume breaker. `throttledAtCount` is null until something is throttled. */
  daily: z.object({
    day: z.string().min(1),
    handedOver: z.number().int().nonnegative(),
    throttledAtCount: z.number().int().nullable(),
    firstThrottledAt: isoDate.nullable(),
  }).strict(),
  capability: z.object({
    canSend: z.boolean(),
    arbitraryRecipients: z.boolean(),
    verifiedAt: isoDate.nullable(),
    detail: z.string().min(1),
  }).strict(),
}).loose();

/**
 * Verifying the audit chain.
 *
 * `intact` is the answer; the other four are what make it checkable rather than asserted. `resumeFrom` is
 * how a chain longer than one invocation's budget is verified in passes — a `null` there means the whole
 * of it was covered, which is a materially different claim from `intact: true` alone.
 */
export const auditVerifyResponse = z.object({
  checked: z.number().int().nonnegative(),
  from: z.number().int(),
  intact: z.boolean(),
  brokenAt: z.number().int().nullable(),
  resumeFrom: z.number().int().nullable(),
}).strict();

/**
 * Whether the evidence still matches what this Node recorded (#92).
 *
 * The three fault kinds are separate values rather than a boolean, because an operator does something
 * different with each: `missing` means the object is gone and its metadata is not, `unreadable` means the key
 * generation it names cannot be produced — the ADR 28 loss the escrow exists for — and `altered` means the
 * bytes changed after ingress, which cannot happen by accident.
 */
export const evidenceFault = z.object({
  /**
   * The row that names the object, and where to find it.
   *
   * `receiptId` until #131, which stopped being true the moment the sweep covered drafts, exports and sends
   * as well as inbound mail — a draft's id under that name is a field lying about which table to look in,
   * read by somebody trying to find one row during an incident. `column` distinguishes the three objects a
   * single send stages.
   */
  rowId: z.string(),
  table: z.string(),
  column: z.string(),
  blobKey: z.string(),
  kind: z.enum(["missing", "unreadable", "altered"]),
  detail: z.string(),
}).strict();

export const evidenceVerifyResponse = z.object({
  /** Objects opened and hashed — not rows read. A send stages up to three; a structured one, two. */
  checked: z.number().int().nonnegative(),
  after: z.string().nullable(),
  /** The table this batch swept, so a partial sweep says what it covered and not only how much (#131). */
  table: z.string().nullable(),
  intact: z.boolean(),
  /** Every fault in the batch. Evidence objects are independent, so stopping at the first would hide a count. */
  faults: z.array(evidenceFault),
  resumeAfter: z.string().nullable(),
  bytesRead: z.number().int().nonnegative(),
}).strict();

/**
 * What the bucket holds, and what each object should hash to (#92).
 *
 * `recordedSha256` is nullable on purpose: `null` means the bucket holds something no live row names, which is
 * `reconcile.ts`'s "object, no referent". Reported rather than omitted — a backup that silently drops what it
 * cannot explain restores less than the operator thinks.
 */
export const inventoryObject = z.object({
  key: z.string(),
  bytes: z.number().int().nonnegative(),
  uploaded: z.string(),
  keyGeneration: z.number().int().nonnegative(),
  recordedSha256: z.string().nullable(),
}).strict();

export const evidenceInventoryResponse = z.object({
  objects: z.array(inventoryObject),
  /** Opaque: it encodes which prefix is being walked and where in it. Never construct one by hand. */
  resumeAfter: z.string().nullable(),
  unaccounted: z.number().int().nonnegative(),
}).strict();

/* ------------------------------------------------------------------ policy authoring (#60, #93) ---- */

/**
 * The five conditions a policy can name, and **nothing else** (#93).
 *
 * ## Why this one object is strict when request schemas are not
 *
 * The header above says requests tolerate unknown keys because a caller sending a field this Node ignores
 * is harmless. That reasoning is about *forward compatibility* — an older Node should not refuse a newer
 * client — and it does not survive contact with a condition bag, because here an ignored field does not
 * mean "one thing less". It means **the opposite rule**.
 *
 * `POST /api/policies` with `{"conditions":{"mailbox_id":"mbx_…"}}` used to yield `{}` from
 * `conditionsFrom`, which stores five NULLs, which is a version matching *every send in the organization*.
 * An `allow` written to narrow a gate widened it; a `deny` stopped all outbound mail; a
 * `require_approval` gated the whole Node — and the caller was told the policy was created, because it
 * was. The publish path is immutable and versioned, so the wrong rule is now a numbered version doing
 * exactly what it was written to do.
 *
 * So this is the one place where refusing is the compatible answer: a client that learns a sixth condition
 * is talking to a Node whose schema has a sixth column, and until it does, silently dropping the condition
 * produces a rule nobody wrote. `PolicyConditions` in `apps/node/worker/src/policy.ts` is the same closed
 * five, held to this by `apps/node/worker/test/node/request-shape-world.test.ts`.
 *
 * `refusal` is read by the boundary that applies this — see `apps/node/worker/src/request-shape.ts`. It
 * lives here rather than there so the code and the closed set it describes cannot drift apart.
 *
 * The **names** are closed and the **types** are not: `orgDailyVolumeMin` takes a string as well as a number
 * because a form posts `"10"` and `conditionsFrom` coerces it, and `nullish()` throughout because null is a
 * defined answer — *no constraint on this dimension* — rather than a missing one. A schema that refused the
 * string would reject a well-formed rule with a message about its own value, which is the refusal
 * `E_BAD_POLICY_VOLUME` was written to avoid.
 */
export const policyConditions = z.object({
  mailboxId: z.string().nullish(),
  actorUserId: z.string().nullish(),
  recipientExternal: z.boolean().nullish(),
  isReply: z.boolean().nullish(),
  orgDailyVolumeMin: z.union([z.number(), z.string()]).nullish(),
}).strict().meta({ refusal: "E_POLICY_CONDITION_UNKNOWN" });

/**
 * One approval stage: how many decisions, and the team the deciders must belong to.
 *
 * Strict for the reason `policyConditions` is, one field along: `team` is a **constraint**, so
 * `{"count":1,"teem":"tm_finance"}` dropped silently is not a stage with less detail — it is separation of
 * duty replaced by any single approver, in a rule whose author believed they had written the opposite.
 *
 * `team` and `teamId` are both accepted because `stagesFrom` accepts both, and the schema describes what
 * the route does rather than what it ought to. `count` is a string or a number because JSON from a form
 * carries `"1"` and the route coerces it — refusing it here would reject a well-formed rule.
 */
export const policyStage = z.union([
  // A bare number is sugar for an unconstrained stage: `2` and `{"count":2}` arrive as the same stage.
  z.number(),
  z.string(),
  z.object({
    count: z.union([z.number(), z.string()]).nullish(),
    team: z.string().nullish(),
    teamId: z.string().nullish(),
  }).strict().meta({ refusal: "E_POLICY_STAGE_FIELD_UNKNOWN" }),
]);

/**
 * Creating a policy, and **strict at the top level too**.
 *
 * The same defect as `policyConditions`, one level out and equally quiet: `{"name":…,"outcome":"deny",
 * "conditons":{…}}` — `conditions` misspelled — reaches `conditionsFrom(undefined)`, yields `{}`, and
 * publishes a `deny` that stops all outbound mail. Every field of a policy body either narrows or widens
 * what the rule catches, so there is no field here this Node can ignore harmlessly, which is exactly the
 * test the loose default is meant to pass and cannot.
 */
/**
 * Saving a draft — the one **writing** act a machine is offered, and it had no request schema at all.
 *
 * The consequence was invisible until the organization-scoped routes stopped being offered to machines: the
 * MCP tool builder adds a `body` property only when a route declares a `request`, so `putDrafts` was
 * published as a tool taking **no arguments**. An agent holding `mail.draft` could call it and had no way to
 * say what the draft said. Every tool that did carry a body was an `org.admin` route the catalogue should
 * never have offered, so the surface looked complete while the one act agents exist to perform did not work.
 *
 * Not `.strict()`, unlike the policy and Butler bodies. Those refuse an unknown field because every field
 * changes which sends a rule catches; a draft is text a person will read before anything leaves, and the
 * handler already ignores what it does not know. A strict schema here would refuse a client that sent a field
 * a newer Node added, which is the rolling-upgrade case rather than a safety one.
 */
export const saveDraftRequest = z.object({
  id: z.string().nullish(),
  mailboxId: z.string(),
  inReplyToMessageId: z.string().nullish(),
  to: z.array(z.string()),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string(),
  body: z.string(),
});

/**
 * Opening a matter, for the same reason `saveDraftRequest` exists: it became a machine-reachable act when its
 * authority declaration was corrected, and a tool with no declared body is a tool that cannot be called.
 *
 * `type` is a string here and an enum in `src/matters.ts`. Deliberate: the refusal names the four it accepts,
 * and a caller who sends a fifth gets `E_MATTER_TYPE_UNKNOWN` with the list — which is more use than a schema
 * error, and keeps the vocabulary in the domain that owns it rather than copied into the wire contract.
 */
export const openMatterRequest = z.object({
  type: z.string(),
  description: z.string(),
});

export const createPolicyRequest = z.object({
  name: z.string(),
  outcome: z.string(),
  conditions: policyConditions.optional(),
  stages: z.array(policyStage).optional(),
}).strict().meta({ refusal: "E_POLICY_FIELD_UNKNOWN" });

/** Replacing a policy's draft: the create body without the name, which is the policy's and not the version's. */
export const editPolicyDraftRequest = z.object({
  outcome: z.string(),
  conditions: policyConditions.optional(),
  stages: z.array(policyStage).optional(),
}).strict().meta({ refusal: "E_POLICY_FIELD_UNKNOWN" });

export const policyDraftResponse = z.object({
  policy: z.object({
    policyId: z.string().min(1),
    versionId: z.string().min(1),
    outcome: z.enum(["allow", "hold", "require_approval", "deny"]),
    conditions: z.record(z.string(), z.unknown()),
    stages: z.array(z.unknown()),
  }).strict(),
}).strict();

export const policyPublishedResponse = z.object({
  published: z.object({
    policyId: z.string().min(1),
    versionId: z.string().min(1),
    version: z.number().int().positive(),
    outcome: z.enum(["allow", "hold", "require_approval", "deny"]),
    supersededVersionId: z.string().nullable(),
  }).strict(),
}).strict();

/**
 * Signing out.
 *
 * Answers `200` with an `error` field, which reads oddly and is correct: the body is the same
 * `signedOutResponse` every expired-session path returns, so a client has **one** shape to recognise for
 * "you are not signed in" rather than one for being thrown out and another for leaving. Written down here
 * because the alternative is somebody tidying it into `{ ok: true }` and breaking that.
 */
export const signedOutResponse = z.object({
  error: z.string().min(1),
  message: z.string().min(1),
  refreshable: z.literal(false),
}).strict();

/* ------------------------------------------------------------------ tranche five ------------------- */

export const jwksResponse = z.object({
  keys: z.array(z.object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    alg: z.literal("ES256"),
    use: z.literal("sig"),
    kid: z.string().min(1),
    x: z.string().min(1),
    y: z.string().min(1),
    key_ops: z.array(z.literal("verify")),
    ext: z.boolean(),
  }).strict()),
}).strict();

/**
 * Granting and revoking.
 *
 * `alreadyHeld` is the field that makes granting idempotent *and* legible: without it, a caller cannot tell
 * a grant it just made from one that was already there, which is the difference between "I did this" and "I
 * confirmed this" in an access review.
 */
export const grantedResponse = z.object({
  granted: z.literal(true),
  alreadyHeld: z.boolean(),
}).strict();

export const revokedResponse = z.object({ revoked: z.boolean() }).strict();

export const mailboxPatchedResponse = z.object({
  mailboxId: z.string().regex(idPattern(ID_PREFIXES.mailbox)),
  firstResponseMinutes: z.number().int().nullable(),
}).strict();

export const draftDetailResponse = z.object({ draft: draftRow }).loose();
export const draftDeletedResponse = z.object({ deleted: z.boolean() }).strict();

/** One prefix the reconciler swept, and how completely it could read it. */
const sweep = z.object({
  read: z.enum(["complete", "truncated"]),
  prefix: z.string().min(1),
  examined: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /**
   * Objects too recent to judge.
   *
   * Counted rather than listed, and separated from `stranded` rather than folded into it: an object written
   * seconds ago has no transaction to be missing yet, and calling it stranded would make the reconciler
   * delete writes that were still in flight.
   */
  tooFreshToJudge: z.number().int().nonnegative(),
  stranded: z.array(z.unknown()),
}).strict();

export const reconcileResponse = z.object({
  orphans: z.array(z.unknown()),
  orphansDeleted: z.number().int().nonnegative(),
  draftBodies: sweep,
  draftBodiesDeleted: z.number().int().nonnegative(),
  exportObjects: sweep,
  exportObjectsDeleted: z.number().int().nonnegative(),
  sentObjects: sweep,
}).loose();

export const resealResponse = z.object({
  resealed: z.number().int().nonnegative(),
  alreadyCurrent: z.number().int().nonnegative(),
  failed: z.array(z.unknown()),
  /** What is left under an older generation — the number `doctor` reports and `reseal` drives to zero. */
  remaining: z.number().int().nonnegative(),
  targetGeneration: z.number().int().nonnegative(),
}).strict();


/**
 * Rotating the token signing key.
 *
 * `stillVerifiesForSeconds` is the field that matters and the one a tidier shape would drop: the retiring
 * key keeps verifying for a grace window, so a rotation is not a cliff — and a caller that did not know
 * would expect every existing token to fail immediately.
 */
export const keyRotatedResponse = z.object({
  rotated: z.literal(true),
  kid: z.string().min(1),
  retiring: z.string().min(1).nullable(),
  stillVerifiesForSeconds: z.number().int().nonnegative(),
}).strict();

/* ------------------------------------------------------------------ dual control (#61, §7, §18) ---- */

/** How many distinct people a stage needs, and whether it is scoped to a team. */
const approvalStage = z.object({
  count: z.number().int().positive(),
  teamId: z.string().nullable(),
}).strict();

/**
 * A request waiting on people.
 *
 * `eligible` travels with `stages` on every route that *opens* one, and that pairing is the point: a request
 * needing two approvers on a Node with one eligible person is unsatisfiable, and the refusals say so up
 * front rather than letting it sit for ever. Returning the count beside the requirement is what lets a
 * caller see the arithmetic instead of waiting to discover it.
 */
const opened = { stages: z.array(approvalStage), eligible: z.number().int().nonnegative() };

export const supervisedRequestedResponse = z.object({
  supervised: z.object({
    grantId: z.string().min(1),
    approvalId: z.string().min(1),
    subjectId: userId,
    mailboxId: z.string().regex(idPattern(ID_PREFIXES.mailbox)),
    scope: z.string().min(1),
    matterId: z.string().nullable(),
    requestedAt: isoDate,
    expiresAt: isoDate,
    ...opened,
  }).strict(),
}).strict();

export const approvalRow = z.object({
  id: z.string().min(1),
  subjectKind: z.enum([
    "send_manifest", "hold_lift", "supervised_read", "ediscovery_export", "domain_pause",
  ]),
  subjectId: z.string().min(1),
  scopeId: z.string().min(1),
  actorUserId: userId,
  state: z.string().min(1),
  requestedAt: isoDate,
  resolvedAt: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  stages: z.array(approvalStage),
  /** Which stage is open, or null when none is. What tells a reader whether anything is waiting on them. */
  openStage: z.number().int().nullable(),
  /** Whether *this* caller has already decided. §18 counts distinct people, so it is per-reader. */
  decidedByMe: z.boolean(),
  reason: z.string().nullable(),
}).loose();

/**
 * Deciding.
 *
 * `.loose()`, and it is the one response in this file where that is the honest answer rather than a
 * concession. The body carries a **kind-specific outcome flag** — `supervisedGranted` for a supervised
 * read, `exportApproved` for an export — because what an approval completing *does* differs by what was
 * approved. Only those two were observed against a real Node, and inventing names for the other three
 * subject kinds would be exactly the guessing these schemas exist to stop.
 *
 * What is strict is the part that is common to all five, which is everything a caller needs to know whether
 * the request is still waiting.
 */
export const approvalDecidedResponse = z.object({
  decided: z.object({
    approvalId: z.string().min(1),
    subjectKind: z.string().min(1),
    subjectId: z.string().min(1),
    decision: z.enum(["approve", "deny"]),
    stageOrdinal: z.number().int().positive(),
    approvalState: z.string().min(1),
    /** True only on the decision that completed the whole request, not each stage. */
    completed: z.boolean(),
    openStage: z.number().int().nullable(),
  }).loose(),
}).strict();

export const exportRequestedResponse = z.object({
  export: z.object({
    exportId: z.string().min(1),
    approvalId: z.string().min(1),
    requestedBy: userId,
    mailboxId: z.string().regex(idPattern(ID_PREFIXES.mailbox)),
    matterId: z.string().min(1),
    /**
     * What was asked for, and its digest.
     *
     * The digest is what makes an export's scope provable after the fact: the predicate is frozen at the
     * request, so an approval is an approval of *that* question rather than of a name somebody could widen
     * afterwards.
     */
    predicate: z.object({
      mailboxId: z.string().min(1),
      fromDate: z.string().nullable(),
      toDate: z.string().nullable(),
      subjectContains: z.string().nullable(),
    }).strict(),
    predicateSha256: sha256,
  }).loose(),
}).strict();

export const holdLiftRequestedResponse = z.object({
  lift: z.object({
    liftId: z.string().min(1),
    approvalId: z.string().min(1),
    holdId: z.string().min(1),
    mailboxId: z.string().min(1),
    reason: z.string(),
    ...opened,
  }).strict(),
}).strict();

export const domainPauseRequestedResponse = z.object({
  pause: z.object({
    pauseId: z.string().min(1),
    approvalId: z.string().min(1),
    domain: z.string().min(1),
    reason: z.string(),
    ...opened,
  }).strict(),
}).strict();

/**
 * The approvals waiting on somebody.
 *
 * Declared here rather than beside the other lists because `approvalRow` is defined with the dual-control
 * shapes below it — and a list of a row is not worth writing before the row exists. The first draft had it
 * up there with `z.unknown()` elements, which is a list schema that checks the envelope and nothing in it.
 */
export const approvalListResponse = z.object({ approvals: z.array(approvalRow) }).loose();

/* ------------------------------------------------------------------ cases and dispatch ------------- */

/** The case row a claim or a steal answers with: the row itself, without the list's computed columns. */
const claimedCase = z.object({
  id: z.string().regex(idPattern(ID_PREFIXES.case)),
  conversation_id: z.string().min(1),
  mailbox_id: z.string().min(1),
  state: z.enum(["open", "claimed", "closed"]),
  state_at: isoDate,
  assignee: z.string().nullable(),
  claimed_at: isoDate.nullable(),
  created_at: isoDate,
}).strict();

/**
 * One route, four acts, four answers.
 *
 * A union rather than a loose object, because the four shapes are genuinely different and each one's key is
 * what says which act happened: `claimed` for taking or stealing, `released`, `closed`. All four were
 * observed against a real Node — a shape guessed for the fourth would have been the invention these schemas
 * exist to prevent.
 *
 * `claim` and `steal` answer identically, and that is correct rather than an oversight: stealing is claiming
 * a case somebody else holds, and the difference is in the audit trail (`case.claim_taken`) rather than in
 * what the caller gets back.
 */
export const caseActionResponse = z.union([
  z.object({ claimed: z.literal(true), case: claimedCase }).strict(),
  z.object({ released: z.literal(true) }).strict(),
  z.object({ closed: z.literal(true) }).strict(),
]);

/**
 * Merging two conversations.
 *
 * `mailboxId` travels with the refusal as well as the success, because the reason a merge is refused is
 * always *about one mailbox* — two cases in it disagree — and a caller with several would otherwise be told
 * only that something somewhere was wrong.
 */
export const conversationMergedResponse = z.object({
  merged: z.literal(true),
  messagesMoved: z.number().int().nonnegative(),
}).loose();

/** What a dispatch sweep handed over. Empty is the ordinary answer on a Node with nothing due. */
export const dispatchResponse = z.object({ dispatched: z.array(z.unknown()) }).loose();

/* ------------------------------------------------------------------ sending (#61, ADR 33, ADR 40) -- */

/** One recipient's own state, because migration 0013 makes the **delivery** the unit rather than the send. */
export const recipientRow = z.object({
  manifest_id: z.string().regex(idPattern(ID_PREFIXES.sendManifest)),
  kind: z.enum(["to", "cc", "bcc"]),
  address: z.string().min(1),
  submission_state: z.string().min(1),
  delivery_state: z.string().nullable(),
  bounce_type: z.string().nullable(),
  last_error: z.string().nullable(),
}).strict();

export const sendRow = z.object({
  id: z.string().regex(idPattern(ID_PREFIXES.sendManifest)),
  subject: z.string(),
  /** JSON, as stored. A string rather than an array, which is worth writing down because it looks like one. */
  envelope_to: z.string(),
  state: z.string().min(1),
  state_at: isoDate,
  release_at: isoDate,
  attempts: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  transport_message_id: z.string().nullable(),
  fidelity: z.enum(["authored", "reconstructed"]),
  state_reason: z.string().nullable(),
  policy_outcome: z.string().nullable(),
  /** 0 or 1, not a boolean: it is `EXISTS` from SQL, and the client reads it as a number. */
  has_submitted: z.number().int(),
  recipients: z.array(recipientRow),
  /**
   * Which retry this send offers, and why.
   *
   * ADR 40's distinction made answerable rather than left to a caller's judgement: `retry-effect` reuses the
   * original idempotency key and provably cannot duplicate; `resend-may-duplicate` mints a new one and
   * might. `why` carries the reason the mode is what it is — `not_yet_attempted` for a send that has never
   * been handed over — so a UI can explain a disabled button instead of just disabling it.
   */
  retry: z.object({ mode: z.string().nullable(), why: z.string().min(1) }).strict(),
}).strict();

const capability = z.object({
  canSend: z.boolean(),
  arbitraryRecipients: z.boolean(),
  verifiedAt: isoDate.nullable(),
  detail: z.string().min(1),
}).strict();

/**
 * Sealing a manifest: the act that commits a send to policy (#61).
 *
 * Answers at the **top level** rather than under a `send` key, unlike every other act in this contract. That
 * is worth writing down rather than tidying: this response is the sealed envelope itself — the policy
 * outcome, the approval it needs, the breaker that would stop it, the capability of the Node that would
 * carry it — and wrapping it would suggest there is something else in the reply.
 */
export const sendSealedResponse = z.object({
  id: z.string().regex(idPattern(ID_PREFIXES.sendManifest)),
  state: z.string().min(1),
  releaseAt: isoDate,
  rfcMessageId: z.string().min(1),
  /** Null when the send answers nothing. Present as a header value, brackets and all. */
  referencesHeader: z.string().nullable(),
  policyOutcome: z.string().min(1),
  policyVersionIds: z.array(z.string()),
  stateReason: z.string().nullable(),
  approvalId: z.string().nullable(),
  /** How many more approvers the request needs than exist. Non-null is a send nobody can release. */
  approvalShortfall: z.unknown().nullable(),
  breaker: z.string().nullable(),
  breakerError: z.string().nullable(),
  capability,
  /** Whether the draft survived the seal. False is the ordinary case: sealing consumes it. */
  draftRetained: z.boolean(),
}).strict();

export const sendCancelledResponse = z.object({ cancelled: z.literal(true) }).strict();

/* ------------------------------------------------------------------ the account lifecycle (§5A) ---- */

/**
 * `POST /api/prepare` — the migration endpoint, and not what its name suggests.
 *
 * It does not mint a claim secret or prepare an account: it applies pending migrations, which is why
 * `alreadyCurrent` is the ordinary answer. Written down because the first reading of the name was wrong,
 * and a generated client whose author guessed the same way would call it at the wrong moment.
 */
export const prepareResponse = z.object({
  applied: z.array(z.string()),
  /** Migrations another invocation applied first. A race is expected, not an error: installs are concurrent. */
  raced: z.array(z.string()),
  alreadyCurrent: z.boolean(),
  message: z.string().min(1),
}).loose();

/**
 * Claiming an unclaimed Node.
 *
 * **No `userId`.** The caller is the account that was just created, and it is signed in by the cookies on
 * the response — so a body naming the id would be handing back something the session already carries. The
 * email is echoed because it is what the operator typed and what they will sign in with.
 */
export const claimedResponse = z.object({
  claimed: z.literal(true),
  organizationId: z.string().min(1),
  email: z.string().min(1),
  accessExpiresAt: z.number().int().positive(),
  /**
   * ADR 29's ten recovery codes, in plaintext (#92). The **only** response in this contract that carries
   * them: the Node keeps a hash to recognise one and an escrow only the code itself opens, so nothing can
   * produce them again. Optional because a Node claimed before this shipped has none.
   */
  recoveryCodes: z.array(z.string().min(1)).optional(),
}).strict();

/**
 * What a redeemed recovery code put back: the generations, per purpose. Never key material.
 *
 * `conflicted` is the half worth reading. A generation the vault already held under a *different* secret
 * could not be installed — reachable when storage was lost and the Node kept working, minting a fresh
 * generation 1 while the escrow carries the old one. The live key is kept, so mail sealed under the escrowed
 * key stays unreadable, and this is where an operator finds that out.
 */
export const vaultRestoredResponse = z.object({
  restored: z.object({
    content: z.array(z.number().int().nonnegative()),
    credential: z.array(z.number().int().nonnegative()),
  }).strict(),
  conflicted: z.object({
    content: z.array(z.number().int().nonnegative()),
    credential: z.array(z.number().int().nonnegative()),
  }).strict(),
  /**
   * The subset of `restored` that displaced a generation this Node had reserved and never sealed under.
   *
   * Present only when something was displaced. Counted in `restored` as well, because it was restored — the
   * escrowed key is in the vault and the mail it sealed opens. Named separately because replacing a key is a
   * different event from filling an empty slot, and a reader should not have to infer that from silence.
   */
  adopted: z.object({
    content: z.array(z.number().int().nonnegative()),
    credential: z.array(z.number().int().nonnegative()),
  }).strict().optional(),
  /**
   * What a collision means, present **exactly when `conflicted` is not empty** (#138).
   *
   * In the payload rather than only in a document, for the reason `recoveryCodesMintedResponse` gives about
   * its own notice. #92's drill answered this route with `200`, both generations conflicted and nothing
   * restored, and every client read it as a success — including this repository's own CLI, which printed
   * *"the vault is restored"*. Two arrays of integers do not tell a caller that a single-use code has been
   * spent and the mail is still unreadable, and that is the one thing they have to know.
   */
  notice: z.string().min(1).optional(),
}).strict();

/**
 * Ten fresh recovery codes, shown once (audit follow-up to ADR 29).
 *
 * `codes` is the only place the plaintext ever exists. Nothing stores it and nothing can produce it again, so
 * a client that discards this response has discarded the organization's ability to recover its vault — which
 * is why `notice` is in the payload rather than only in a document, and why `confirm` exists.
 */
export const recoveryCodesMintedResponse = z.object({
  codes: z.array(z.string().min(1)),
  escrowed: z.object({
    content: z.number().int().nonnegative(),
    credential: z.number().int().nonnegative(),
  }).strict(),
  /** Which sheet these are, so a caller confirms *this* one rather than "whatever is current". */
  set: z.string().min(1),
  notice: z.string().min(1),
}).strict();

/** Proof that an operator holds one of the codes. Compared, never spent. */
export const recoveryCodesConfirmedResponse = z.object({
  confirmed: z.number().int().nonnegative(),
  /**
   * True when the code came from the sheet that was **already** active: nothing was marked and, the
   * load-bearing half, nothing was retired. A count of zero cannot carry that — it is also what a
   * confirmation that changed nothing looks like.
   */
  alreadyConfirmed: z.boolean(),
  message: z.string().min(1),
}).strict();

/**
 * What the body index failed on, with the reason against each id.
 *
 * The reason is the payload's point. "Eleven messages failed" is a number nobody can act on; a caller has to
 * see which are deterministically unparseable — repairing those spends attempts on work that cannot
 * succeed — and which are reads that failed on every try and are worth another once the cause is fixed.
 */
export const searchFailedResponse = z.object({
  failed: z.array(z.object({
    messageId: z.string().min(1),
    state: z.enum(["unindexable", "retryable"]),
    attempts: z.number().int().nonnegative(),
    error: z.string().nullable(),
  }).strict()),
}).strict();

/** Message ids to put back in the body index's queue. Per message, never a sweep. */
export const searchRepairRequest = z.object({
  messageIds: z.array(z.string().min(1)),
}).strict().meta({ refusal: "E_SEARCH_REPAIR_FIELD" });

export const searchRepairedResponse = z.object({
  requeued: z.number().int().nonnegative(),
  message: z.string().min(1),
}).strict();

/** A delegated agent principal (#109 L2). Never the token, and never its hash. */
export const agentSummary = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sponsorUserId: z.string().min(1),
  createdBy: z.string().min(1),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  revokedAt: z.string().nullable(),
  /**
   * The pinned ceiling as it is **enforced**: route strings.
   *
   * Kept alongside `held` rather than replaced by it, and that is deliberate. This is the answer to *"what is
   * actually checked"*, and a surface that showed only capability names would be one step removed from the
   * thing enforced — with no way for an operator to see a route the vocabulary no longer names.
   */
  actions: z.array(z.string().min(1)),
  /**
   * The same ceiling in capability terms, with `held` against `total`.
   *
   * Held-of-total rather than a bare name, because the routes are what is pinned. A stored capability resolved
   * at check time would silently widen every agent holding it the day somebody added a route to it — §16's
   * rule for Butlers, applied unchanged — so an agent minted before a capability grew genuinely holds part of
   * it. `4 of 5` is the truth; `mail.read` would imply a fifth route the agent does not have and never will.
   */
  held: z.array(z.object({
    id: z.string().min(1),
    says: z.string().min(1),
    reachesContent: z.boolean(),
    held: z.number().int().positive(),
    total: z.number().int().positive(),
  }).strict()),
  /**
   * Pinned routes belonging to no current capability. Normally empty; non-empty after a route is renamed.
   *
   * Present and required, because dropping it would under-report a live ceiling: the authority is still in
   * `agent_actions` and still checked, so hiding it is the one thing this must not do.
   */
  unnamed: z.array(z.string().min(1)),
  /**
   * Which mailboxes this agent may reach, and whether each relation is **live right now**.
   *
   * Two facts rather than one, because `effective(agent)` intersects the agent's tuples with its sponsor's: a
   * sponsor who loses a relation silently narrows every agent that borrowed it. An access review reading only
   * what was granted gets an answer that was true on the day of the mint.
   */
  grants: z.array(z.object({
    mailboxId: z.string().min(1),
    /** Null when the mailbox has been deleted out from under the tuple. Shown, never dropped. */
    mailboxName: z.string().nullable(),
    relation: z.string().min(1),
    effective: z.boolean(),
  }).strict()),
}).strict();

export const agentListResponse = z.object({ agents: z.array(agentSummary) }).strict();

/** The capability vocabulary, so a client never restates it. */
export const agentCapabilityListResponse = z.object({
  capabilities: z.array(z.object({
    id: z.string().min(1),
    says: z.string().min(1),
    reachesContent: z.boolean(),
    /**
     * The mailbox relations this capability's routes check. Published so the mint form does not carry its own
     * copy — a hand-written "which capabilities need a mailbox" list is a second correspondence table, and it
     * drifted from the vocabulary the moment it existed.
     */
    requires: z.array(z.enum(AGENT_GRANTABLE_RELATIONS)),
    routes: z.array(z.string().min(1)).min(1),
  }).strict()),
}).strict();

/**
 * Minting one.
 *
 * `capabilities` is the pinned ceiling and is required: an agent with an empty one can do nothing, and there
 * is no route that widens it later. `sponsorUserId` defaults to the caller, which is the common case and the
 * one an administrator setting up their own automation wants.
 *
 * **Capability ids, not route strings.** It took routes once, which made every mint a translation from a
 * policy question into a routing table — and a ceiling assembled by hand has no completeness, so an
 * administrator granting three of the four routes reading mail needs created an agent that worked until it
 * did not. The names are expanded at mint and the expansion is what gets stored; `capability.ts` carries the
 * argument for why that is pinning rather than indirection.
 */
export const agentMintRequest = z.object({
  name: z.string().min(1),
  sponsorUserId: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).min(1),
  /**
   * The mailboxes this agent may act in, and how.
   *
   * Optional and allowed to be empty, because `health.read` and `identity.read` need no mailbox — but an agent
   * granted `mail.read` and no relation is a credential that authenticates and reads nothing, which is the
   * state the mint surface used to hand over by construction.
   */
  grants: z.array(z.object({
    mailboxId: z.string().min(1),
    /*
     * Read from `capability.ts` rather than restated. A capability's `requires` names relations from this same
     * set, and the two disagreeing means a warning that tells an administrator to grant something the form
     * cannot offer — which is how `export.read` came to need `ediscovery.export` against an enum that omitted
     * it.
     */
    relation: z.enum(AGENT_GRANTABLE_RELATIONS),
    // The refusal code is on the nested object too, so an unknown key inside a grant answers with this
    // route's own code rather than the generic one. `test/request-shape.test.ts` probes every position,
    // including nested ones, which is how the omission was found.
  }).strict().meta({ refusal: "E_AGENT_FIELD_UNKNOWN" })).optional(),
  lifetimeDays: z.number().int().positive().optional(),
}).strict().meta({ refusal: "E_AGENT_FIELD_UNKNOWN" });

/** The one moment the token exists. Nothing stores it and nothing can produce it again. */
export const agentMintedResponse = z.object({
  agent: agentSummary,
  token: z.string().min(1),
  notice: z.string().min(1),
}).strict();

export const agentRevokedResponse = z.object({
  revoked: z.literal(true),
  message: z.string().min(1),
}).strict();

/** A recovery code, as typed. Hyphens and case are cosmetic and normalised by the Node. */
export const redeemRecoveryRequest = z.object({
  code: z.string().min(1),
}).loose();

export const redeemedResponse = z.object({
  joined: z.literal(true),
  userId,
  email: z.string().min(1),
  accessExpiresAt: z.number().int().positive(),
}).strict();

/* ------------------------------------------------------------------ tranche ten -------------------- */

/**
 * Exchanging a refresh token.
 *
 * **`replayed` is the field that matters and the one a summary would drop.** A refresh token is single-use,
 * so presenting one twice is either a client retrying or a stolen token being used — and this Node answers
 * both by rotating the family and saying so, rather than by silently succeeding or silently failing. A
 * caller that ignores the flag cannot tell a retry from a compromise.
 */
export const refreshedResponse = z.object({
  refreshed: z.literal(true),
  replayed: z.boolean(),
  userId,
  organizationId: z.string().min(1),
  accessExpiresAt: z.number().int().positive(),
}).strict();

export const domainPauseLiftedResponse = z.object({
  lifted: z.object({
    pauseId: z.string().min(1),
    domain: z.string().min(1),
    liftedAt: isoDate,
  }).strict(),
}).strict();

/**
 * Advancing an export.
 *
 * Paged rather than atomic, and the shape says so: `pagesDone` and `done` are what let a caller drive it to
 * completion across invocations, because a bulk copy of a mailbox does not fit one subrequest budget.
 *
 * The manifest's `sha256` and `count` are what make the export provable afterwards — the same reason the
 * request froze its predicate. `abortedBecause` is non-null when it stopped early, which is a materially
 * different state from `done` and would be invisible if the two were folded into one flag.
 */
export const exportRunResponse = z.object({
  run: z.object({
    exportId: z.string().min(1),
    state: z.string().min(1),
    emitted: z.number().int().nonnegative(),
    messagesEmitted: z.number().int().nonnegative(),
    pagesDone: z.number().int().nonnegative(),
    done: z.boolean(),
    manifest: z.object({
      key: z.string().min(1),
      sha256,
      count: z.number().int().nonnegative(),
    }).strict().nullable(),
    abortedBecause: z.string().nullable(),
  }).loose(),
}).strict();

/**
 * Withdrawing a decision.
 *
 * The reply carries the **shortfall the withdrawal created**, which is the point of returning anything at
 * all: taking a decision back can make a request unsatisfiable, and a caller that only learned the new state
 * would not know whether anybody can still complete it. `available` against `needed` is the arithmetic.
 */
export const approvalWithdrawnResponse = z.object({
  withdrawn: z.object({
    approvalId: z.string().min(1),
    approvalState: z.string().min(1),
    stageOrdinal: z.number().int().positive(),
    shortfall: z.object({
      ordinal: z.number().int().positive(),
      required: z.number().int().nonnegative(),
      available: z.number().int().nonnegative(),
      short: z.number().int().nonnegative(),
      eligible: z.number().int().nonnegative(),
      needed: z.number().int().nonnegative(),
      team: z.string().nullable(),
    }).strict().nullable(),
  }).strict(),
}).strict();

/* ------------------------------------------------------------------ Butler runs, one at a time ----- */

/** One recorded effect of a run. `at` is here and not on the summary row, which carries only counts. */
const runEffect = z.object({
  seq: z.number().int().positive(),
  node_id: z.string().min(1),
  node_type: z.string().min(1),
  outcome: z.enum(["ok", "refused", "failed"]),
  reason: z.string().nullable(),
  subject: z.string().nullable(),
  at: isoDate,
  /** Present for a `mail.send.propose` whose manifest survives — what the send is doing *now*. */
  send: z.object({
    state: z.string().min(1),
    fidelity: z.enum(["authored", "reconstructed"]),
    retry: z.object({ mode: z.string().nullable(), why: z.string().min(1) }).strict(),
    resentAs: z.string().nullable(),
  }).strict().optional(),
}).strict();

export const butlerRunDetailResponse = z.object({
  run: butlerRunRow,
  effects: z.array(runEffect),
}).loose();

/**
 * Inspecting a run (#53).
 *
 * Two fields here are the honest half of the record and would both be lost by a summary:
 *
 * `triggerFacts` is **what the run was given**, which is what makes a replay a replay: the input is
 * inherited and the judgement re-asked. `triggerFactsRedacted` is non-null when the reader may not see all
 * of it — mail content is not disclosed by an inspection.
 *
 * `notRecorded` is a sentence, in the payload, saying what this record cannot tell you: the pure nodes of
 * the walk leave no row, because this Node keeps one row per **effect** rather than one per step. Which
 * branch a guard took is not recoverable. A reader who assumed otherwise would draw conclusions from an
 * absence, and the field exists so they cannot.
 */
export const butlerRunInspectionResponse = z.object({
  run: butlerRunRow,
  program: z.object({
    state: z.string().min(1),
    trigger: z.unknown(),
    entry: z.unknown(),
    nodes: z.array(z.object({ id: z.string(), type: z.string() }).loose()),
    /** `checkButler` over the stored AST — whether a re-run would refuse itself before performing anything. */
    checks: z.boolean(),
    findings: z.string().nullable(),
  }).loose().nullable(),
  triggerFacts: z.record(z.string(), z.unknown()).nullable(),
  triggerFactsRedacted: z.unknown().nullable(),
  effects: z.array(runEffect),
  replays: z.array(z.unknown()),
  reRun: z.object({ available: z.boolean(), why: z.string().nullable() }).strict(),
  notRecorded: z.string().min(1),
}).loose();

export const butlerRunReplayedResponse = z.object({
  mode: z.string().min(1),
  /** The **new** run's id. A replay is a new instance with its own budget, never a resumption. */
  runId: z.string().min(1),
  replayOf: z.string().min(1),
}).loose();

export const butlerPauseResumedResponse = z.object({
  resumed: z.object({
    pauseId: z.string().min(1),
    butlerId: z.string().regex(idPattern(ID_PREFIXES.butler)),
    resumedAt: isoDate,
  }).strict(),
}).strict();

/**
 * Releasing a send parked on a Butler's gate (#61).
 *
 * `resumed` says whether the parked **run** was woken, and it is separate from `released` on purpose: a
 * timed-out run leaves its manifest releasable, so a send can be released long after the instance that
 * proposed it has gone. Folding the two would make a release of an orphaned send look like a failure.
 */
export const sendReleasedResponse = z.object({
  released: z.literal(true),
  runId: z.string().min(1).nullable(),
  resumed: z.boolean(),
}).loose();

/* ------------------------------------------------------------------ a message body (ADR 37) -------- */

/**
 * One message's body, extracted and sanitised.
 *
 * `state` is the honest header: `text-only` says there was no HTML part rather than that HTML was stripped,
 * and the two are different facts about the message. `blockedRemote` counts what sanitising removed — remote
 * images are trackers, and a reader deciding whether to trust a message wants to know some were there.
 * `problem` is non-null when the body could not be produced, which is not the same as an empty one.
 */
export const messageBodyResponse = z.object({
  state: z.string().min(1),
  html: z.string().nullable(),
  text: z.string().nullable(),
  blockedRemote: z.number().int().nonnegative(),
  truncated: z.boolean(),
  problem: z.string().nullable(),
}).loose();

/** Releasing a send a policy put on hold (#60). One field, because there is one question. */
export const sendHoldReleasedResponse = z.object({ released: z.literal(true) }).strict();

/**
 * Retrying a send (ADR 40).
 *
 * `detail` is a sentence rather than a code, and it is the field that carries the epistemic claim: a
 * `retry-effect` says *"this Node has a recorded outcome proving it never left"*, which is the whole reason
 * that mode is safe and `resend-may-duplicate` is not. A caller shown only `mode` would have the label
 * without the justification.
 *
 * `dispatch` is nested because a retry hands the message to the dispatcher and reports what **that** did —
 * which may be "not due, or already moved by another dispatcher", a perfectly ordinary outcome that would
 * look like a failure if flattened into the outer result.
 */
export const sendRetriedResponse = z.object({
  mode: z.enum(["retry-effect", "resend-may-duplicate"]),
  manifestId: z.string().regex(idPattern(ID_PREFIXES.sendManifest)),
  dispatch: z.object({
    manifestId: z.string().min(1),
    state: z.string().min(1),
    detail: z.string(),
  }).loose(),
  detail: z.string().min(1),
}).loose();

/**
 * The mailboxes a caller may **read**, which is not the work-queue list.
 *
 * `GET /api/mailboxes` answers *where do I have work*, by `send.propose`. This answers *what may I read*, and
 * they are different questions — the agent capability vocabulary had the first inside `mail.read`, so a
 * read-only agent could open messages and received an empty catalogue.
 */
export const readableMailboxListResponse = z.object({
  mailboxes: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }).strict()),
}).strict();

/**
 * Every mailbox in the organization, with the relations a named sponsor holds on each.
 *
 * The mint form's resource catalogue. It used the work-queue list, which answers *what can the caller send
 * from* — so a read-only sponsor's mailboxes were unselectable, and an administrator could not provision an
 * agent for a mailbox they administer without working in.
 *
 * Mailboxes the sponsor holds nothing on are **included with an empty list**, deliberately: a form that
 * omitted them would leave somebody concluding the mailbox had been deleted.
 */
export const sponsorMailboxListResponse = z.object({
  mailboxes: z.array(z.object({
    mailboxId: z.string().min(1),
    mailboxName: z.string().min(1),
    relations: z.array(z.string().min(1)),
  }).strict()),
}).strict();

/**
 * Acknowledging a permanent key collision.
 *
 * Both fields are required here, and **blankness is refused in `recovery.ts`, not by this schema.** Zod would
 * express it with `.min(1)` and deliberately does not: the refusal names which field was empty and why it
 * matters, which a schema error cannot. Said precisely because the first version of this note claimed the
 * schema did both, and a comment describing a check that lives elsewhere is how somebody later removes the
 * one that is real.
 *
 * An acknowledgement with no scope is unreadable to the only reader it has — somebody arriving long after
 * everybody involved has gone — and one with no conclusion is a dismissal wearing the shape of an assessment.
 */
export const acknowledgeConflictRequest = z.object({
  scope: z.string(),
  conclusion: z.string(),
});

/** What the Node recorded, read back so the caller can see the generations it was filed against. */
export const conflictAcknowledgedResponse = z.object({
  acknowledged: z.object({
    restoreId: z.string(),
    generations: z.string(),
    acknowledgedAt: z.string(),
  }),
}).strict();
