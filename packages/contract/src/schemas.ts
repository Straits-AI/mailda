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

export const messageListResponse = z.object({ messages: z.array(messageRow) }).loose();

export const auditRow = z.object({
  id: z.string().min(1),
  seq: z.number().int().positive(),
  at: isoDate,
  actor_user_id: z.string().nullable(),
  actor_kind: z.string().min(1),
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
}).strict();

export const redeemedResponse = z.object({
  joined: z.literal(true),
  userId,
  email: z.string().min(1),
  accessExpiresAt: z.number().int().positive(),
}).strict();
