/**
 * Every route this Node serves, described once (#85, ADR 12).
 *
 * ## What this is for, and what it deliberately is not yet
 *
 * ADR 12 locks *"UI, CLI, SDK, Skill and MCP parity is **generated from shared contracts**"*. The
 * interesting half of that sentence is the last three words: the property that stops five clients drifting
 * from one Node. Writing an SDK by hand would add a sixth thing to keep in step and satisfy the letter of the
 * decision while defeating it.
 *
 * So this is the first artefact, and it is the smallest one that makes drift **detectable** rather than
 * merely discouraged: the set of routes, in one place, with a tripwire —
 * `apps/node/worker/test/node/route-registry.test.ts` — asserting it and the Worker's own handler agree in
 * both directions. A route added without an entry here fails; an entry here for a route nobody serves fails.
 *
 * It is **not** request and response schemas. Those come next, per route, and they are worth having only
 * once the set of routes is pinned — a schema for a route that has quietly moved is a schema for nothing.
 *
 * ## Why the whole path set rather than the twelve the UI uses
 *
 * Because the drift this exists to catch is between *surfaces*, and the surfaces that do not exist yet are
 * the ones ADR 12 is about. A registry covering only what `api.ts` already calls would be a description of
 * the UI, and the next surface would extend it — which is the same hand-maintained correspondence with an
 * extra file in it.
 *
 * ## What the first pass found
 *
 * Two things, recorded here rather than quietly fixed, because both are decisions:
 *
 * **1. `packages/contract` declared `"main": "./src/index.ts"` and had no `index.ts`** — and nothing in the
 * repository imported the package at all. So *"the shared contract"* was one command's schemas, unreachable
 * through its own entry point, consumed by nobody. `index.ts` now exists and exports both this and
 * `send-mail`.
 *
 * **2. Five routes have no method guard.** `/health`, `/api/doctor`, `/api/me`, `/index.html` and
 * `/.well-known/jwks.json` test only `url.pathname`, so `DELETE /health` is served exactly as `GET /health`
 * is. All five are read-only handlers, so nothing is destroyed — but a generated client would state a method
 * this Node does not check, and that gap is the shape ADR 12 exists to close. They are registered below as
 * `GET`, which is what they mean, and `METHOD_UNCHECKED` names them so the tripwire can assert the *set* of
 * such routes rather than letting a sixth join quietly.
 */

import type { ZodType } from "zod";

import * as S from "./schemas.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteSpec {
  readonly method: HttpMethod;
  /**
   * The path, with `:name` for a segment the Worker captures.
   *
   * The names are this file's own: the handler captures positionally, so `:sendId` here and `sends[1]` there
   * describe the same segment. That is the one place a reader has to trust prose, and it is why `path()`
   * below refuses an unknown parameter rather than ignoring it.
   */
  readonly path: string;
  /** What it does, in the words a generated client would carry as a doc comment. */
  readonly summary: string;

  /**
   * What the route accepts and answers (#85 step 2).
   *
   * **Optional, and the optionality is the honest part.** Step 1 pinned the route *set* and is complete;
   * these describe what travels, and they arrive one tranche at a time — because a schema nothing checks is
   * a guess wearing the clothes of a contract, and a generated client would trust it.
   * `apps/node/worker/test/contract-responses.test.ts` drives every schema-bearing route against a real
   * Node and parses the answer, so a schema that does not describe reality fails rather than misleads.
   *
   * A route with no `response` is one nobody has done yet, which `SCHEMAS_MISSING` counts.
   */
  readonly request?: ZodType;
  readonly response?: ZodType;
}

/**
 * The five routes whose handler tests the path and not the method.
 *
 * Listed rather than described, so the tripwire can assert this exact set. A sixth appearing means somebody
 * wrote a handler that answers every verb, which is worth a conversation rather than a silent addition.
 */
export const METHOD_UNCHECKED: readonly string[] = [
  "/.well-known/jwks.json",
  "/api/doctor",
  "/api/me",
  "/health",
  "/index.html",
];

export const ROUTES = [
  // ---- the surface an unauthenticated caller reaches (ADR 30) ----------------------------------------
  {
    method: "GET", path: "/health",
    summary: "Whether this Node is up, and what is missing if it is not",
    response: S.healthResponse,
  },
  { method: "GET", path: "/index.html", summary: "The interface shell" },
  { method: "GET", path: "/.well-known/jwks.json", summary: "The public keys that verify this Node's tokens", response: S.jwksResponse },
  { method: "POST", path: "/api/claim", summary: "Claim an unclaimed Node: the first account and organization", response: S.claimedResponse },
  {
    method: "POST", path: "/api/prepare",
    // Named for claiming and actually the migration endpoint — see `prepareResponse`.
    summary: "Apply pending migrations",
    response: S.prepareResponse,
  },
  {
    method: "GET", path: "/api/doctor",
    summary: "What this Node can and cannot do, with the evidence",
    response: S.doctorResponse,
  },

  // ---- authentication (#38, ADR 29) -----------------------------------------------------------------
  {
    method: "POST", path: "/api/auth/login",
    summary: "Exchange a password for a session",
    request: S.loginRequest, response: S.signedInResponse,
  },
  { method: "POST", path: "/api/auth/refresh", summary: "Exchange a refresh token for a new access token", response: S.refreshedResponse },
  { method: "POST", path: "/api/auth/logout", summary: "End this session", response: S.signedOutResponse },
  { method: "POST", path: "/api/auth/logout-everywhere", summary: "End every session this person holds", response: S.signedOutResponse },
  { method: "POST", path: "/api/auth/rotate-signing-key", summary: "Mint a new token signing key, keeping the old one for the verify grace", response: S.keyRotatedResponse },
  { method: "GET", path: "/api/me", summary: "Who this session is", response: S.meResponse },

  // ---- passkeys (#84, ADR 29) -----------------------------------------------------------------------
  {
    method: "POST", path: "/api/auth/passkeys/challenge",
    summary: "A single-use challenge for either ceremony. Unauthenticated for authentication, which is what keeps it from answering whether an address has a passkey",
    request: S.passkeyChallengeRequest, response: S.passkeyChallengeResponse,
  },
  {
    method: "POST", path: "/api/auth/passkeys",
    summary: "Finish registration: verify the attestation and store the public key",
    response: S.passkeyRegisteredResponse,
  },
  {
    method: "POST", path: "/api/auth/passkeys/verify",
    summary: "Finish authentication: verify the assertion and issue a session",
    response: S.signedInResponse,
  },
  {
    method: "GET", path: "/api/auth/passkeys",
    summary: "The passkeys this account holds. Never returns a public key",
    response: S.passkeyListResponse,
  },
  {
    method: "DELETE", path: "/api/auth/passkeys",
    summary: "Revoke one, bound to its owner by the statement's own predicate",
    response: S.passkeyForgottenResponse,
  },

  // ---- membership (#83) ------------------------------------------------------------------------------
  { method: "GET", path: "/api/invitations", summary: "Invitations still outstanding", response: S.invitationListResponse },
  { method: "POST", path: "/api/invitations", summary: "Invite an address to this organization", response: S.invitationCreatedResponse },
  { method: "POST", path: "/api/invitations/redeem", summary: "Redeem an invitation by choosing a password", response: S.redeemedResponse },
  { method: "GET", path: "/api/people", summary: "Everybody in this organization", response: S.peopleListResponse },
  { method: "GET", path: "/api/teams", summary: "Every team", response: S.teamListResponse },
  { method: "POST", path: "/api/teams", summary: "Create a team", response: S.teamCreatedResponse },
  { method: "GET", path: "/api/teams/:teamId", summary: "One team", response: S.teamDetailResponse },
  { method: "POST", path: "/api/teams/:teamId/rename", summary: "Rename a team", response: S.teamCreatedResponse },
  { method: "GET", path: "/api/teams/:teamId/members", summary: "Who is in a team", response: S.teamMembersResponse },
  { method: "POST", path: "/api/teams/:teamId/members", summary: "Put somebody in a team, conferring every relation it holds", response: S.teamMembershipResponse },
  { method: "DELETE", path: "/api/teams/:teamId/members", summary: "Take somebody out of a team, effective on their next request", response: S.teamMembershipResponse },

  // ---- authorization (#39) ---------------------------------------------------------------------------
  { method: "GET", path: "/api/access", summary: "Who holds what on which mailbox", response: S.accessResponse },
  { method: "POST", path: "/api/access", summary: "Grant a relation on a mailbox", response: S.grantedResponse },
  { method: "DELETE", path: "/api/access", summary: "Revoke a relation on a mailbox", response: S.revokedResponse },
  { method: "GET", path: "/api/supervised", summary: "Live supervised-access grants (§7)", response: S.supervisedListResponse },
  { method: "POST", path: "/api/supervised", summary: "Grant supervised access, which expires", response: S.supervisedRequestedResponse },

  // ---- mail: reading -------------------------------------------------------------------------------
  {
    method: "GET", path: "/api/mailboxes",
    summary: "The mailboxes this person may act in",
    response: S.mailboxListResponse,
  },
  { method: "PATCH", path: "/api/mailboxes/:mailboxId", summary: "Change a mailbox's settings", response: S.mailboxPatchedResponse },
  {
    method: "GET", path: "/api/messages", summary: "Message metadata, paged",
    response: S.messageListResponse,
  },
  { method: "GET", path: "/api/messages/:messageId/body", summary: "One message's rendered body" },
  { method: "GET", path: "/api/messages/:messageId/raw", summary: "One message's stored bytes, as message/rfc822" },
  {
    method: "GET", path: "/api/notifications",
    summary: "What has changed since the last poll",
    response: S.notificationListResponse,
  },

  // ---- cases and conversations (#42) -----------------------------------------------------------------
  { method: "GET", path: "/api/cases", summary: "Cases in the mailboxes this person may act in", response: S.caseListResponse },
  {
    method: "POST",
    path: "/api/cases/:caseId/:action",
    /*
     * One route, four acts, because the handler is one regex with an alternation — `claim|steal|release|close`
     * — rather than four guards. Registered as it is served rather than expanded into four entries that no
     * handler corresponds to one-for-one: this file's job is to describe what exists.
     */
    summary: "Claim, steal, release or close a case",
    response: S.caseActionResponse,
  },
  { method: "POST", path: "/api/conversations/merge", summary: "Merge two conversations into one", response: S.conversationMergedResponse },

  // ---- drafting and sending (ADR 36, #61) ------------------------------------------------------------
  { method: "GET", path: "/api/drafts", summary: "Drafts this person is writing", response: S.draftListResponse },
  { method: "PUT", path: "/api/drafts", summary: "Save a draft", response: S.draftSavedResponse },
  { method: "GET", path: "/api/drafts/:draftId", summary: "One draft", response: S.draftDetailResponse },
  { method: "DELETE", path: "/api/drafts/:draftId", summary: "Discard a draft", response: S.draftDeletedResponse },
  { method: "GET", path: "/api/sends", summary: "The outbox", response: S.sendListResponse },
  { method: "POST", path: "/api/sends", summary: "Seal a manifest: the act that commits a send to policy", response: S.sendSealedResponse },
  { method: "POST", path: "/api/sends/dispatch", summary: "Hand every due send to the transport now", response: S.dispatchResponse },
  { method: "POST", path: "/api/sends/:sendId/cancel", summary: "Cancel a send that has not left", response: S.sendCancelledResponse },
  { method: "POST", path: "/api/sends/:sendId/retry", summary: "Retry a send that failed" },
  { method: "POST", path: "/api/sends/:sendId/release", summary: "Release a send parked on a Butler's gate" },
  { method: "POST", path: "/api/sends/:sendId/release-hold", summary: "Release a send a policy put on hold" },
  { method: "GET", path: "/api/sends/:sendId/submitted", summary: "The exact bytes handed to the transport" },

  // ---- governance: policy, approvals, holds, breakers (#60, #61, #63, #75) --------------------------
  { method: "GET", path: "/api/policies", summary: "Every policy, with the version that is live", response: S.policyListResponse },
  { method: "POST", path: "/api/policies", summary: "Create a policy", response: S.policyDraftResponse },
  {
    method: "PUT",
    path: "/api/policies/:policyId/draft",
    /*
     * PUT since #85. The handler answered POST while the client sent PUT, so editing a policy draft from the
     * interface returned 404 `not_found` for as long as the route existed. Found by writing this registry.
     */
    summary: "Replace a policy's draft",
    response: S.policyDraftResponse,
  },
  { method: "POST", path: "/api/policies/:policyId/publish", summary: "Publish a policy's draft, which is the versioning event", response: S.policyPublishedResponse },
  { method: "GET", path: "/api/approvals", summary: "Approvals waiting on somebody", response: S.approvalListResponse },
  { method: "POST", path: "/api/approvals/:approvalId/decide", summary: "Approve or refuse a send", response: S.approvalDecidedResponse },
  { method: "POST", path: "/api/approvals/:approvalId/withdraw", summary: "Withdraw your own decision on a request", response: S.approvalWithdrawnResponse },
  { method: "GET", path: "/api/holds", summary: "Legal holds in force", response: S.holdListResponse },
  { method: "POST", path: "/api/holds", summary: "Place a legal hold", response: S.holdPlacedResponse },
  { method: "POST", path: "/api/holds/:holdId/lift", summary: "Lift a legal hold, which takes more than one person", response: S.holdLiftRequestedResponse },
  { method: "GET", path: "/api/matters", summary: "Matters a hold or an export can be scoped to", response: S.matterListResponse },
  { method: "POST", path: "/api/matters", summary: "Open a matter", response: S.matterResponse },
  { method: "POST", path: "/api/matters/:matterId/close", summary: "Close a matter", response: S.matterResponse },
  {
    method: "GET", path: "/api/breakers",
    summary: "The rate breakers, with the readings behind them",
    response: S.breakerListResponse,
  },
  { method: "GET", path: "/api/domain-pauses", summary: "Domains this Node has stopped sending to", response: S.domainPauseListResponse },
  { method: "POST", path: "/api/domain-pauses", summary: "Stop sending to a domain", response: S.domainPauseRequestedResponse },
  { method: "POST", path: "/api/domain-pauses/:pauseId/lift", summary: "Resume sending to a domain, which takes more than one person", response: S.domainPauseLiftedResponse },

  // ---- Butlers (#49, #50, #75, #77, #87) -------------------------------------------------------------
  { method: "GET", path: "/api/butlers", summary: "Every Butler, with the version that is live", response: S.butlerListResponse },
  {
    method: "POST", path: "/api/butlers", summary: "Create a Butler and its first draft",
    request: S.createButlerRequest, response: S.butlerDraftResponse,
  },
  { method: "GET", path: "/api/butlers/:butlerId", summary: "One Butler and its version history", response: S.butlerDetailResponse },
  {
    method: "PUT", path: "/api/butlers/:butlerId/draft", summary: "Replace a Butler's draft",
    request: S.editButlerDraftRequest, response: S.butlerDraftResponse,
  },
  {
    method: "POST", path: "/api/butlers/:butlerId/publish",
    summary: "Publish a Butler's draft, which is the versioning event",
    response: S.butlerPublishedResponse,
  },
  {
    method: "POST", path: "/api/butlers/:butlerId/simulate",
    summary: "Dry-run a Butler: walk it, cause nothing, report what a live run would do",
    request: S.simulateRequest, response: S.simulationResponse,
  },
  { method: "GET", path: "/api/butler-runs", summary: "What the Butlers have done", response: S.butlerRunListResponse },
  { method: "GET", path: "/api/butler-runs/:runId", summary: "One run" },
  { method: "GET", path: "/api/butler-runs/:runId/inspect", summary: "One run's input, program and effects, with the replay modes it offers" },
  { method: "POST", path: "/api/butler-runs/:runId/replay", summary: "Replay a run in a named mode" },
  { method: "GET", path: "/api/butler-pauses", summary: "Butlers a machine has stopped", response: S.butlerPauseListResponse },
  { method: "POST", path: "/api/butler-pauses/:pauseId/resume", summary: "Restart a stopped Butler, with a reason" },

  // ---- the record: audit, logs, export (#28, #43) ----------------------------------------------------
  {
    method: "GET", path: "/api/audit", summary: "The audit trail",
    response: S.auditListResponse,
  },
  { method: "POST", path: "/api/audit/verify", summary: "Verify the audit chain", response: S.auditVerifyResponse },
  {
    method: "GET", path: "/api/logs", summary: "The operational log",
    response: S.logListResponse,
  },
  { method: "GET", path: "/api/exports", summary: "Export jobs", response: S.exportListResponse },
  { method: "POST", path: "/api/exports", summary: "Start an e-discovery export", response: S.exportRequestedResponse },
  { method: "POST", path: "/api/exports/:exportId/run", summary: "Advance an export", response: S.exportRunResponse },
  { method: "GET", path: "/api/exports/:exportId/objects/:objectId", summary: "One object from a completed export" },

  // ---- the sending transport's credentials (#86, ADR 33) ------------------------------------------
  {
    method: "GET", path: "/api/transport",
    summary: "Which adapter carries this Node's mail, and what both can say about themselves",
    response: S.transportResponse,
  },
  {
    method: "PUT", path: "/api/transport",
    summary: "Supply the Cloudflare account id and Email Sending API token. The token is never returned",
    request: S.transportRequest, response: S.transportConfiguredResponse,
  },

  // ---- maintenance ------------------------------------------------------------------------------------
  { method: "POST", path: "/api/maintenance/reseal", summary: "Reseal evidence under the current key", response: S.resealResponse },
  { method: "POST", path: "/api/maintenance/reconcile", summary: "Reconcile stored evidence against its metadata", response: S.reconcileResponse },
  /*
   * `as const satisfies` rather than a `readonly RouteSpec[]` annotation, and the difference is the whole
   * enforcement rather than a stylistic preference.
   *
   * An annotation widens every `path` to `string`, which makes `route("GET", "/api/sendz")` a runtime throw
   * — found when a test happens to exercise that call, and shipped otherwise. `as const` keeps the literals,
   * so the overload below can accept **only** templates that appear in this array: a client naming a route
   * this Node does not serve stops compiling. That is ADR 12's property for the surfaces that exist, held by
   * the type checker rather than by review.
   *
   * `satisfies` keeps the shape checked, so an entry missing a `summary` or carrying a method outside
   * `HttpMethod` is still an error here rather than at the first caller.
   */
] as const satisfies readonly RouteSpec[];

/** Every registered route, as literal types. The source of the compile-time check in `route`. */
export type Registered = (typeof ROUTES)[number];

/** The templates registered for one method — what `route` will accept as its second argument. */
export type PathFor<M extends HttpMethod> = Extract<Registered, { method: M }>["path"];

/**
 * The export routes, named.
 *
 * Every other caller writes its template inline, which is the point of `PathFor<M>` — the string *is* the
 * lookup key and naming each of eighty-odd routes would be a second vocabulary to keep in step. These two
 * are the exception, and the exception is not stylistic.
 *
 * `apps/node/worker/test/node/matter-and-scope-world.test.ts` scans the Worker's source for the literal
 * `/exports/`, because the R2 key `${orgId}/exports/${exportId}/` is written by the export run, read by the
 * download route and listed by the reconciler — and three spellings would let the reconciler scan a prefix
 * nothing writes and report it clean. An **HTTP path is a different thing**, but a lexical guard cannot tell
 * them apart, and the client already carried a comment saying the right answer: *"stop needing the
 * exception, not widen the guard."*
 *
 * So the literal lives here, in the file whose job is to hold each route exactly once, and the client names
 * these two instead of spelling them.
 */
export const EXPORTS_LIST = route("GET", "/api/exports");
export const EXPORT_RUN = route("POST", "/api/exports/:exportId/run");

/**
 * Fills a route's parameters, refusing anything it cannot account for.
 *
 * Both directions are refusals rather than best-effort substitutions, and that is the point of having this
 * at all. A missing parameter would produce a URL containing a literal `:sendId`, which reaches the Worker,
 * misses every guard and returns the interface shell with a 200 — the single worst failure available,
 * because it looks like it worked. An extra one is a caller who believes this route takes something it does
 * not, which is the same misunderstanding one step earlier.
 */
export function path(spec: RouteSpec, params: Readonly<Record<string, string>> = {}): string {
  const wanted = [...spec.path.matchAll(/:(\w+)/g)].map((match) => match[1]!);
  const filled = spec.path.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") {
      throw new Error(`${spec.method} ${spec.path} needs ${name}, and none was given`);
    }
    return encodeURIComponent(value);
  });
  for (const given of Object.keys(params)) {
    if (!wanted.includes(given)) {
      throw new Error(`${spec.method} ${spec.path} takes ${wanted.join(", ") || "no parameters"}, not ${given}`);
    }
  }
  return filled;
}

/**
 * Looks a route up by method and template.
 *
 * **The types are the check.** `PathFor<M>` is the union of templates registered for that method, so a
 * caller naming a route this Node does not serve — or the right path under the wrong verb — does not
 * compile. The runtime throw below is unreachable from typed code and is kept for the one caller that is
 * not: `.mjs` operator scripts, which no compiler ever looks at.
 */
/**
 * The routes that do not answer JSON, and therefore can never carry a response schema.
 *
 * Named rather than left in the missing count, because a denominator that includes them can never reach its
 * numerator and a target nobody can hit is one nobody aims at. `/index.html` is the interface shell,
 * `/api/messages/:id/raw` is `message/rfc822` — the stored bytes, whose whole value is being unaltered — and
 * an export object is whatever was exported.
 *
 * Three, and asserted as exactly three, so a fourth is a decision somebody makes rather than a route that
 * quietly opted out of being described.
 */
export const NOT_JSON: readonly string[] = [
  "GET /index.html",
  "GET /api/messages/:messageId/raw",
  "GET /api/exports/:exportId/objects/:objectId",
];

/**
 * How much of the surface has a response schema, and how much does not (#85 step 2).
 *
 * A number rather than a feeling. Step 1 pinned every route; step 2 describes what travels over them, and it
 * is partial on purpose — schemas arrive with the tests that check them, because a schema nothing validates
 * is a guess a generated client would trust.
 *
 * Read through `RouteSpec` rather than off the literal tuple, because `as const` gives each entry only the
 * fields it actually has — so the elements without a `response` have no such property to read. The widening
 * is what makes "which of these lack one" askable at all.
 */
export function schemaCoverage(): { described: number; total: number; missing: readonly string[] } {
  const all: readonly RouteSpec[] = ROUTES;
  // `NOT_JSON` is excluded from both sides: a route that answers `message/rfc822` is not undescribed, it is
  // not describable this way, and counting it as a gap would make the target unreachable.
  const describable = all.filter((spec) => !NOT_JSON.includes(`${spec.method} ${spec.path}`));
  const missing = describable.filter((spec) => spec.response === undefined)
    .map((spec) => `${spec.method} ${spec.path}`);
  return { described: describable.length - missing.length, total: describable.length, missing };
}

export function route<M extends HttpMethod>(method: M, template: PathFor<M>): RouteSpec {
  const found = ROUTES.find((spec) => spec.method === method && spec.path === template);
  if (found === undefined) throw new Error(`no route ${method} ${template} is registered`);
  return found;
}
