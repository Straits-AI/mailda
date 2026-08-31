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

import type { Authority } from "./authority.ts";
import * as S from "./schemas.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteSpec {
  readonly method: HttpMethod;
  /**
   * What this route requires of the caller — see `authority.ts`.
   *
   * Declared beside the route because that is where the check is. The agent capability vocabulary used to
   * describe the same fact per *capability*, as a hand-written summary of a set of routes, and every summary
   * was a second copy that drifted: `mail.read` promising the original `.eml` on content read alone,
   * `send.observe` omitting `message.export`, and seven capabilities declaring no relation at all while their
   * routes require `org.admin` — authority no mint can confer.
   *
   * Optional on the type and **required in practice** for anything a machine may hold:
   * `test/node/capability-world.test.ts` fails on a grantable route with no `authority`, and
   * `machineProvisionable` answers `false` for an undeclared one, which is the fail-closed direction.
   */
  readonly authority?: Authority;
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
   * Query parameters the route reads, if any — **optional strings, every one of them.**
   *
   * There is deliberately no `required` flag and no type other than string. A query parameter that a route
   * cannot answer without is a path segment wearing a disguise: it belongs in `path` where `path()` refuses
   * to build a URL without it. Everything that legitimately lives here narrows or positions a result the
   * route already answers, so omitting it has a meaning — and a generated client that can only send strings
   * is honest about a query string, which is what a URL carries.
   *
   * Declared here rather than in prose because it is what the SDK and MCP generate from: a paging control
   * described in a summary is a control only the browser can use. See `GET /api/messages`.
   *
   * **`GET /api/cases` reads one and does not declare one**, which is a parity gap of exactly the kind this
   * field exists to close: it *requires* `?mailbox=`, so the generated `getCases()` — which has no way to send
   * it — can only ever produce that route's 400. Left as it is rather than fixed in passing, because #91 is
   * about the message listing and a second route's refusal deserves its own ticket rather than a drive-by; it
   * is written down here so the next reader finds it as a known gap and not as a surprise.
   */
  readonly query?: readonly { readonly name: string; readonly description: string }[];

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
/**
 * The two query parameters `GET /api/messages` reads, spelled once (#91).
 *
 * Three surfaces name them — the registry entry below, `listMessages` which parses them, and the interface
 * which sends them — and a query parameter is a name a client can only get wrong silently: a `?cursor=` the
 * Node reads as `?after=` is not an error, it is the newest page, for ever. That is the defect #91 fixed;
 * spelling it in three places would be a way to reintroduce it one refactor later. Path templates are
 * already pinned this way, and this is the same problem one character to the right of the `?`.
 */
export const MESSAGE_PAGE_PARAMS = { cursor: "cursor", mailbox: "mailbox", q: "q" } as const;

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
    authority: { scope: "public" },
    method: "GET", path: "/health",
    summary: "Whether this Node is up, and what is missing if it is not",
    response: S.healthResponse,
  },
  { method: "GET", path: "/index.html", summary: "The interface shell" },
  { method: "GET", path: "/.well-known/jwks.json", summary: "The public keys that verify this Node's tokens", authority: { scope: "public" }, response: S.jwksResponse },
  { method: "POST", path: "/api/claim", summary: "Claim an unclaimed Node: the first account and organization", response: S.claimedResponse },
  { method: "POST", path: "/api/recovery/redeem", summary: "Spend an ADR 29 recovery code to restore this Node's key vault", request: S.redeemRecoveryRequest, response: S.vaultRestoredResponse },
  { method: "POST", path: "/api/agents", summary: "Mint a delegated agent, returning its token once", request: S.agentMintRequest, response: S.agentMintedResponse },
  { method: "GET", path: "/api/agents", summary: "Every agent in this organization", response: S.agentListResponse },
  { method: "GET", path: "/api/people/:userId/mailboxes", summary: "Every mailbox, with what this person holds on each — the mint surface's resource catalogue", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.sponsorMailboxListResponse },
  { method: "GET", path: "/api/agent-capabilities", summary: "What an agent may be granted, in this Node's own vocabulary", response: S.agentCapabilityListResponse },
  { method: "DELETE", path: "/api/agents/:agentId", summary: "Withdraw an agent's credential immediately", response: S.agentRevokedResponse },
  { method: "GET", path: "/api/search/failed", summary: "Messages the body index failed on, with the reason for each", response: S.searchFailedResponse },
  { method: "POST", path: "/api/search/repair", summary: "Put named messages back in the body index's queue", request: S.searchRepairRequest, response: S.searchRepairedResponse },
  /*
   * Acknowledging a permanent key collision (P2-2). `organization`, because it is a statement about the whole
   * Node's evidence made on the organization's behalf — and `governed` in the exposure tiers, because it is a
   * conclusion a person reaches and not an act a machine should be able to file.
   */
  { method: "POST", path: "/api/recovery/conflicts/:restoreId/acknowledge", summary: "Record that a permanent key collision has been assessed", authority: { scope: "organization", allOf: ["org.admin"] }, request: S.acknowledgeConflictRequest, response: S.conflictAcknowledgedResponse },
  { method: "POST", path: "/api/recovery-codes/rotate", summary: "Mint a replacement set of ten recovery codes, shown once", response: S.recoveryCodesMintedResponse },
  { method: "POST", path: "/api/recovery-codes/confirm", summary: "Prove an operator holds one of the current recovery codes, without spending it", request: S.redeemRecoveryRequest, response: S.recoveryCodesConfirmedResponse },
  {
    method: "POST", path: "/api/prepare",
    // Named for claiming and actually the migration endpoint — see `prepareResponse`.
    summary: "Apply pending migrations",
    response: S.prepareResponse,
  },
  {
    authority: { scope: "recovery" },
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
  { method: "GET", path: "/api/me", summary: "Who this session is", authority: { scope: "member" }, response: S.meResponse },

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
    /*
     * The caller's **own** passkeys, and registering one is withheld from machines — so an agent holding this
     * reads an empty list for ever. It was `member` and inside the offered `identity.read`, which made it the
     * same empty promise `GET /api/approvals` is withheld for, one capability to the left.
     */
    authority: { scope: "filtered", by: "self" },
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
  { method: "GET", path: "/api/invitations", summary: "Invitations still outstanding", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.invitationListResponse },
  { method: "POST", path: "/api/invitations", summary: "Invite an address to this organization", response: S.invitationCreatedResponse },
  { method: "POST", path: "/api/invitations/redeem", summary: "Redeem an invitation by choosing a password", response: S.redeemedResponse },
  { method: "GET", path: "/api/people", summary: "Everybody in this organization", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.peopleListResponse },
  { method: "GET", path: "/api/teams", summary: "Every team", authority: { scope: "member" }, response: S.teamListResponse },
  { method: "POST", path: "/api/teams", summary: "Create a team", response: S.teamCreatedResponse },
  { method: "GET", path: "/api/teams/:teamId", summary: "One team", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.teamDetailResponse },
  { method: "POST", path: "/api/teams/:teamId/rename", summary: "Rename a team", response: S.teamCreatedResponse },
  { method: "GET", path: "/api/teams/:teamId/members", summary: "Who is in a team", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.teamMembersResponse },
  { method: "POST", path: "/api/teams/:teamId/members", summary: "Put somebody in a team, conferring every relation it holds", response: S.teamMembershipResponse },
  { method: "DELETE", path: "/api/teams/:teamId/members", summary: "Take somebody out of a team, effective on their next request", response: S.teamMembershipResponse },

  // ---- authorization (#39) ---------------------------------------------------------------------------
  { method: "GET", path: "/api/access", summary: "Who holds what on which mailbox", authority: { scope: "self-or-admin" }, response: S.accessResponse },
  { method: "POST", path: "/api/access", summary: "Grant a relation on a mailbox", response: S.grantedResponse },
  { method: "DELETE", path: "/api/access", summary: "Revoke a relation on a mailbox", response: S.revokedResponse },
  { method: "GET", path: "/api/supervised", summary: "Live supervised-access grants (§7)", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.supervisedListResponse },
  { method: "POST", path: "/api/supervised", summary: "Grant supervised access, which expires", response: S.supervisedRequestedResponse },

  // ---- mail: reading -------------------------------------------------------------------------------
  {
    authority: { scope: "mailbox", allOf: ["send.propose"] },
    method: "GET", path: "/api/mailboxes",
    summary: "The mailboxes this person may act in",
    response: S.mailboxListResponse,
  },
  { method: "PATCH", path: "/api/mailboxes/:mailboxId", summary: "Change a mailbox's settings", response: S.mailboxPatchedResponse },
  {
    authority: { scope: "mailbox", anyOf: ["mailbox.metadata.read", "mailbox.content.read"] },
    method: "GET", path: "/api/messages",
    summary: "Message metadata, newest first, one page at a time. Pass the previous page's next_cursor to "
      + "continue; null means nothing older is visible",
    /*
     * The first route to declare query parameters, and #91 is why the field exists rather than the paging
     * being documented in this sentence and reachable only from the browser. `listMessages` returned the
     * newest fifty and nothing else, so the fifty-first message was unreachable — and a fix that taught the
     * UI to page while leaving `getMessages()` on page one for ever would have rebuilt the same defect in the
     * SDK, the Skill and MCP. ADR 12's parity rule is not satisfied by three of four surfaces.
     */
    query: [
      {
        name: MESSAGE_PAGE_PARAMS.cursor,
        description: "The previous page's next_cursor, verbatim. Omit for the newest page.",
      },
      {
        name: MESSAGE_PAGE_PARAMS.mailbox,
        description: "Only this mailbox's mail. Omit for every mailbox you may read.",
      },
      {
        name: MESSAGE_PAGE_PARAMS.q,
        description: "Words that must all appear in the subject or sender address. The last word matches as "
          + "a prefix, so a part-typed word narrows. Not a query language: operators are read as words.",
      },
    ],
    response: S.messageListResponse,
  },
  {
    authority: { scope: "mailbox", allOf: ["mailbox.content.read"] },
    method: "GET", path: "/api/messages/:receiptId/body",
    /*
     * **`:receiptId`, not `:messageId`, and the rename is a finding rather than a tidy-up.**
     *
     * `authorize` looks the segment up in `ingress_receipts`, so this route takes an `ir_` id. Passing the
     * obvious `msg_` one answers 404 *"No such message, or you do not have access to it"* — which reads as an
     * authorization problem and is a wrong-kind-of-id problem. `GET /api/messages` returns both: `id` is the
     * receipt and `message_id` is the message, which is easy to have backwards and impossible to notice.
     */
    summary: "One message's rendered body. Takes the receipt id that GET /api/messages returns as `id`",
    response: S.messageBodyResponse,
  },
  { method: "GET", path: "/api/messages/:receiptId/raw", summary: "One message's stored bytes, as message/rfc822. Takes the receipt id, as the body route does" , authority: { scope: "mailbox", allOf: ["mailbox.content.read", "message.export"] } },
  {
    /*
     * Two ways to be a recipient, and **a machine can only reach one of them**.
     *
     * `notificationsFor` returns a notice whose `user_id` is the caller, or a mailbox-wide notice on a mailbox
     * where the caller holds `mailbox.content.read` — intersected with the sponsor for an agent. Declared
     * `addressee` at first, which was true of the route and useless to a mint: `filtered` contributes no
     * required relation, so `notice.read` minted with no grants at all and returned an empty list for ever.
     *
     * Nothing addresses a notice to an `agt_` principal. Approval notices name the people eligible to decide
     * and supervised-read notices are mailbox-wide, so the direct branch is a human's. The relation branch is
     * what a machine can be provisioned for, and naming it is what makes the capability a promise rather than
     * an offer that answers 200 with nothing in it.
     */
    authority: { scope: "filtered", by: "relation", relations: ["mailbox.content.read"] },
    method: "GET", path: "/api/notifications",
    summary: "What has changed since the last poll",
    response: S.notificationListResponse,
  },

  // ---- cases and conversations (#42) -----------------------------------------------------------------
  /*
   * The mailbox is a **path segment**, and it was a query parameter this registry never declared — so the
   * generated client and the MCP tool had no way to supply it and always met the route's "name a mailbox"
   * refusal. `queue.read` was a capability an agent could hold and could not use.
   *
   * Line 66 of this file already said so: *"a parameter the route cannot answer without is a path segment
   * wearing a disguise"*. A queue belongs to one mailbox, so this one could never answer without it.
   */
  { method: "GET", path: "/api/mailboxes/readable", summary: "Mailboxes this caller may read, which is not the work-queue list", authority: { scope: "mailbox", anyOf: ["mailbox.metadata.read", "mailbox.content.read"] }, response: S.readableMailboxListResponse },
  { method: "GET", path: "/api/mailboxes/:mailboxId/cases", summary: "The case queue in one mailbox", authority: { scope: "mailbox", allOf: ["send.propose"] }, response: S.caseListResponse },
  {
    method: "POST",
    path: "/api/cases/:caseId/:action",
    /*
     * `send.propose`, found by `test/node/support/mailbox-gates.ts` rather than by anybody remembering:
     * `claim` and `steal` both gate on it two calls below this handler, and the route carried no declaration
     * at all. It was one of four families missing from the hand-written map the analyser replaced.
     */
    authority: { scope: "mailbox", allOf: ["send.propose"] },
    /*
     * One route, four acts, because the handler is one regex with an alternation — `claim|steal|release|close`
     * — rather than four guards. Registered as it is served rather than expanded into four entries that no
     * handler corresponds to one-for-one: this file's job is to describe what exists.
     */
    summary: "Claim, steal, release or close a case",
    response: S.caseActionResponse,
  },
  { method: "POST", path: "/api/conversations/merge", authority: { scope: "mailbox", allOf: ["mailbox.content.read"] }, summary: "Merge two conversations into one", response: S.conversationMergedResponse },

  // ---- drafting and sending (ADR 36, #61) ------------------------------------------------------------
  { method: "GET", path: "/api/drafts", summary: "Drafts this person is writing", authority: { scope: "mailbox", allOf: ["send.propose"] }, response: S.draftListResponse },
  { method: "PUT", path: "/api/drafts", summary: "Save a draft", authority: { scope: "mailbox", allOf: ["send.propose"] }, request: S.saveDraftRequest, response: S.draftSavedResponse },
  { method: "GET", path: "/api/drafts/:draftId", summary: "One draft", authority: { scope: "mailbox", allOf: ["send.propose"] }, response: S.draftDetailResponse },
  { method: "DELETE", path: "/api/drafts/:draftId", authority: { scope: "mailbox", allOf: ["send.propose"] }, summary: "Discard a draft", response: S.draftDeletedResponse },
  { method: "GET", path: "/api/sends", summary: "The outbox", authority: { scope: "mailbox", allOf: ["mailbox.content.read"] }, response: S.sendListResponse },
  { method: "POST", path: "/api/sends", summary: "Seal a manifest: the act that commits a send to policy", authority: { scope: "mailbox", allOf: ["send.propose"] }, response: S.sendSealedResponse },
  /*
   * Declared although it is `governed` and reaches no machine, because the declaration is what the parity
   * suite drives — and an undeclared route is one nothing compares to its handler.
   *
   * `mailboxesWithRelation(who, "send.propose")` bounds the sweep to mailboxes this caller may act in, which
   * is the fix for the incident recorded beside the call: forcing the sweep released other people's held
   * sends and ended their chance to cancel. Mutating that function to answer any relation for any relation
   * asked left 1,525 tests green, because nothing drove this route with a lesser relation.
   */
  { method: "POST", path: "/api/sends/dispatch", summary: "Hand every due send to the transport now", authority: { scope: "mailbox", allOf: ["send.propose"] }, response: S.dispatchResponse },
  { method: "POST", path: "/api/sends/:sendId/cancel", summary: "Cancel a send that has not left", authority: { scope: "mailbox", allOf: ["send.propose"] }, response: S.sendCancelledResponse },
  { method: "POST", path: "/api/sends/:sendId/retry", authority: { scope: "mailbox", allOf: ["send.propose"] }, summary: "Retry a send that failed", response: S.sendRetriedResponse },
  { method: "POST", path: "/api/sends/:sendId/release", authority: { scope: "mailbox", allOf: ["send.propose"] }, summary: "Release a send parked on a Butler's gate", response: S.sendReleasedResponse },
  { method: "POST", path: "/api/sends/:sendId/release-hold", authority: { scope: "mailbox", allOf: ["send.propose"] }, summary: "Release a send a policy put on hold", response: S.sendHoldReleasedResponse },
  {
    authority: { scope: "mailbox", allOf: ["mailbox.content.read", "message.export"] },
    method: "GET", path: "/api/sends/:sendId/submitted",
    /*
     * **Not JSON**, and it took driving it to find that out: it answers the submitted message itself, as
     * text. Which is the only answer that could be right — the whole point of storing the bytes is that they
     * are the bytes, and wrapping them in a JSON envelope would make the record a description of the message
     * rather than the message. It joins `NOT_JSON` for the same reason `/raw` is there.
     */
    summary: "The exact bytes handed to the transport, as the message itself",
  },

  // ---- governance: policy, approvals, holds, breakers (#60, #61, #63, #75) --------------------------
  { method: "GET", path: "/api/policies", summary: "Every policy, with the version that is live", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.policyListResponse },
  {
    authority: { scope: "organization", allOf: ["org.admin"] },
    method: "POST", path: "/api/policies",
    summary: "Create a policy",
    // Strict, and #93's `createPolicyRequest` argues why this route is not one of the ones that tolerate
    // an unknown field: every field of a policy body changes which sends the rule catches.
    request: S.createPolicyRequest, response: S.policyDraftResponse,
  },
  {
    authority: { scope: "organization", allOf: ["org.admin"] },
    method: "PUT",
    path: "/api/policies/:policyId/draft",
    /*
     * PUT since #85. The handler answered POST while the client sent PUT, so editing a policy draft from the
     * interface returned 404 `not_found` for as long as the route existed. Found by writing this registry.
     */
    summary: "Replace a policy's draft",
    request: S.editPolicyDraftRequest, response: S.policyDraftResponse,
  },
  { method: "POST", path: "/api/policies/:policyId/publish", summary: "Publish a policy's draft, which is the versioning event", response: S.policyPublishedResponse },
  { method: "GET", path: "/api/approvals", summary: "Approvals waiting on somebody", authority: { scope: "filtered", by: "relation", relations: ["approval.decide"] }, response: S.approvalListResponse },
  { method: "POST", path: "/api/approvals/:approvalId/decide", summary: "Approve or refuse a send", response: S.approvalDecidedResponse },
  { method: "POST", path: "/api/approvals/:approvalId/withdraw", summary: "Withdraw your own decision on a request", response: S.approvalWithdrawnResponse },
  { method: "GET", path: "/api/holds", summary: "Legal holds in force", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.holdListResponse },
  { method: "POST", path: "/api/holds", summary: "Place a legal hold", response: S.holdPlacedResponse },
  { method: "POST", path: "/api/holds/:holdId/lift", summary: "Lift a legal hold, which takes more than one person", response: S.holdLiftRequestedResponse },
  { method: "GET", path: "/api/matters", summary: "Matters a hold or an export can be scoped to", authority: { scope: "filtered", by: "ownership" }, response: S.matterListResponse },
  { method: "POST", path: "/api/matters", summary: "Open a matter", authority: { scope: "member" }, request: S.openMatterRequest, response: S.matterResponse },
  { method: "POST", path: "/api/matters/:matterId/close", summary: "Close a matter", response: S.matterResponse },
  {
    authority: { scope: "member" },
    method: "GET", path: "/api/breakers",
    summary: "The rate breakers, with the readings behind them",
    response: S.breakerListResponse,
  },
  { method: "GET", path: "/api/domain-pauses", summary: "Domains this Node has stopped sending to", authority: { scope: "member" }, response: S.domainPauseListResponse },
  { method: "POST", path: "/api/domain-pauses", summary: "Stop sending to a domain", response: S.domainPauseRequestedResponse },
  { method: "POST", path: "/api/domain-pauses/:pauseId/lift", summary: "Resume sending to a domain, which takes more than one person", response: S.domainPauseLiftedResponse },

  // ---- Butlers (#49, #50, #75, #77, #87) -------------------------------------------------------------
  { method: "GET", path: "/api/butlers", summary: "Every Butler, with the version that is live", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.butlerListResponse },
  {
    authority: { scope: "organization", allOf: ["org.admin"] },
    method: "POST", path: "/api/butlers", summary: "Create a Butler and its first draft",
    request: S.createButlerRequest, response: S.butlerDraftResponse,
  },
  { method: "GET", path: "/api/butlers/:butlerId", summary: "One Butler and its version history", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.butlerDetailResponse },
  {
    authority: { scope: "organization", allOf: ["org.admin"] },
    method: "PUT", path: "/api/butlers/:butlerId/draft", summary: "Replace a Butler's draft",
    request: S.editButlerDraftRequest, response: S.butlerDraftResponse,
  },
  {
    method: "POST", path: "/api/butlers/:butlerId/publish",
    summary: "Publish a Butler's draft, which is the versioning event",
    response: S.butlerPublishedResponse,
  },
  {
    authority: { scope: "organization", allOf: ["org.admin"] },
    method: "POST", path: "/api/butlers/:butlerId/simulate",
    summary: "Dry-run a Butler: walk it, cause nothing, report what a live run would do",
    request: S.simulateRequest, response: S.simulationResponse,
  },
  { method: "GET", path: "/api/butler-runs", summary: "What the Butlers have done", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.butlerRunListResponse },
  { method: "GET", path: "/api/butler-runs/:runId", summary: "One run", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.butlerRunDetailResponse },
  { method: "GET", path: "/api/butler-runs/:runId/inspect", summary: "One run's input, program and effects, with the replay modes it offers", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.butlerRunInspectionResponse },
  { method: "POST", path: "/api/butler-runs/:runId/replay", summary: "Replay a run in a named mode", response: S.butlerRunReplayedResponse },
  { method: "GET", path: "/api/butler-pauses", summary: "Butlers a machine has stopped", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.butlerPauseListResponse },
  { method: "POST", path: "/api/butler-pauses/:pauseId/resume", summary: "Restart a stopped Butler, with a reason", response: S.butlerPauseResumedResponse },

  // ---- the record: audit, logs, export (#28, #43) ----------------------------------------------------
  {
    method: "GET", path: "/api/audit", summary: "The audit trail",
    response: S.auditListResponse,
  },
  { method: "POST", path: "/api/audit/verify", summary: "Verify the audit chain", response: S.auditVerifyResponse },
  /**
   * Whether the evidence still hashes to what ingress recorded (#92).
   *
   * `org.admin`, for the same reason `/api/audit/verify` is: the answer is a fact about the whole
   * organization's evidence — how many messages are missing, and which — and that is not a mailbox grant. It
   * is also not delegable to a machine. The route opens every object in its batch, so an agent holding it
   * could read every message in the organization by asking for a verification and watching nothing;
   * `machineUseful` would be a lie here in the other direction, which is why no mint can confer it.
   */
  { method: "POST", path: "/api/evidence/verify", summary: "Check that stored evidence still matches the hashes recorded at ingress", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.evidenceVerifyResponse },
  /**
   * The bucket's inventory, for a backup that can be checked after it is restored (#92).
   *
   * `org.admin` and withheld from machines for the same reasons as the verifier beside it, plus one of its
   * own: an inventory is a complete list of every object this organization holds, with sizes and timestamps.
   * That is a map of the organization's mail traffic even without a single byte of content — who was busy,
   * when, and how much.
   */
  { method: "GET", path: "/api/evidence/inventory", summary: "Every stored object with the hash its plaintext should have, for a restorable backup", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.evidenceInventoryResponse },
  {
    method: "GET", path: "/api/logs", summary: "The operational log",
    response: S.logListResponse,
  },
  { method: "GET", path: "/api/exports", summary: "Export jobs", authority: { scope: "organization", allOf: ["org.admin"] }, response: S.exportListResponse },
  { method: "POST", path: "/api/exports", authority: { scope: "mailbox", allOf: ["ediscovery.export"] }, summary: "Start an e-discovery export", response: S.exportRequestedResponse },
  { method: "POST", path: "/api/exports/:exportId/run", authority: { scope: "mailbox", allOf: ["ediscovery.export"] }, summary: "Advance an export", response: S.exportRunResponse },
  { method: "GET", path: "/api/exports/:exportId/objects/:objectId", summary: "One object from a completed export" , authority: { scope: "export", allOf: ["ediscovery.export"], owner: "requester" } },

  // ---- the sending transport's credentials (#86, ADR 33) ------------------------------------------
  {
    authority: { scope: "organization", allOf: ["org.admin"] },
    method: "GET", path: "/api/transport",
    summary: "Which adapter carries this Node's mail, and what both can say about themselves",
    response: S.transportResponse,
  },
  {
    method: "PUT", path: "/api/transport",
    summary: "Supply the Cloudflare account id and Email Sending API token. The token is never returned",
    request: S.transportRequest, response: S.transportConfiguredResponse,
  },

  // ---- the MCP server (#89, ADR 12) ------------------------------------------------------------------
  {
    method: "POST", path: "/mcp",
    /*
     * The one route in this registry whose **shape this project did not choose**. MCP's Streamable HTTP
     * transport is one endpoint carrying JSON-RPC 2.0, and that is a specification somebody else wrote —
     * which is the cost #89 weighed against a second Worker or a separately-run bridge, and accepted.
     *
     * No response schema, and not for want of trying: a JSON-RPC reply is a union over every method the
     * server implements, and describing it here would be restating MCP's specification in a second place
     * that could disagree with it. `src/mcp.ts` and `test/mcp.test.ts` hold it instead.
     */
    summary: "MCP: tool discovery and invocation over JSON-RPC 2.0, exposing the curated capability list",
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
 * **Four**, and asserted as exactly four, so a fifth is a decision somebody makes rather than a route that
 * quietly opted out of being described. The fourth joined late: `/api/sends/:id/submitted` was assumed to
 * answer JSON until it was driven, and it answers the submitted message itself. Which is the only answer
 * that could be right — the point of storing the bytes is that they *are* the bytes, and a JSON envelope
 * would make the record a description of the message rather than the message.
 */
export const NOT_JSON: readonly string[] = [
  "GET /index.html",
  "GET /api/messages/:receiptId/raw",
  "GET /api/sends/:sendId/submitted",
  "GET /api/exports/:exportId/objects/:objectId",
];

/**
 * Routes whose response shape is **somebody else's specification**.
 *
 * Distinct from `NOT_JSON`, and the distinction is worth the second list: those routes do not answer JSON at
 * all, and this one does — but its body is a JSON-RPC reply, a union over every method MCP defines.
 * Describing it here would be restating that specification in a second place that could disagree with it,
 * which is the correspondence problem this whole package exists to remove rather than relocate.
 *
 * `src/mcp.ts` and `apps/node/worker/test/mcp.test.ts` hold it instead: the handler is the description, and
 * the test drives it as a client would.
 *
 * One, and asserted as one. A second would mean this Node had grown another protocol surface, which is a
 * decision (#89 weighed it once) rather than a thing that should arrive quietly.
 */
export const EXTERNALLY_SPECIFIED: readonly string[] = ["POST /mcp"];

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
  /*
   * `NOT_JSON` and `EXTERNALLY_SPECIFIED` are excluded from both sides. A route that answers
   * `message/rfc822` is not undescribed but undescribable this way; a route answering JSON-RPC is described
   * by MCP's specification rather than by this one. Counting either as a gap makes the target unreachable,
   * and a target nobody can hit is one nobody aims at.
   */
  const excluded = new Set([...NOT_JSON, ...EXTERNALLY_SPECIFIED]);
  const describable = all.filter((spec) => !excluded.has(`${spec.method} ${spec.path}`));
  const missing = describable.filter((spec) => spec.response === undefined)
    .map((spec) => `${spec.method} ${spec.path}`);
  return { described: describable.length - missing.length, total: describable.length, missing };
}

export function route<M extends HttpMethod>(method: M, template: PathFor<M>): RouteSpec {
  const found = ROUTES.find((spec) => spec.method === method && spec.path === template);
  if (found === undefined) throw new Error(`no route ${method} ${template} is registered`);
  return found;
}

/**
 * The templated routes as regexes, compiled once at module load rather than per request.
 *
 * `[^/]+` because a captured segment is one segment: the same shape `src/index.ts` matches with, and the same
 * shape `path()` emits, since it percent-encodes anything that would add a slash.
 */
const MATCHERS: ReadonlyArray<{ method: string; pattern: RegExp; spec: RouteSpec }> = (ROUTES as readonly RouteSpec[])
  .filter((spec) => spec.path.includes(":"))
  .map((spec) => ({
    method: spec.method,
    pattern: new RegExp(`^${spec.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+")}$`),
    spec,
  }));

/**
 * `path()` run backwards: which route is *this* request (#93).
 *
 * `path()` turns a spec and its parameters into a URL, which is what a client needs. A server needs the
 * other direction — a concrete `/api/policies/pol_01J…/draft` and a verb, back to the spec that describes
 * it — and until #93 nothing needed it, because nothing on the Node read the contract at request time.
 *
 * **Literals before templates**, and that ordering is the only judgement in here. `/api/policies` and
 * `/api/policies/:policyId/draft` cannot collide, but a future `/api/sends/summary` beside
 * `/api/sends/:sendId` could, and an exact path is never the ambiguous reading. Matching in registration
 * order instead would make correctness depend on where somebody happened to insert a line.
 *
 * The method is part of the answer, not a filter applied afterwards, for the reason `route()` types it that
 * way: `POST /api/policies` and `GET /api/policies` are two routes, and #85 shipped a defect that existed
 * only because a verb was assumed.
 *
 * Returns null for a path this Node does not serve rather than throwing: an unmatched `/api/…` path is the
 * handler's 404 to give, and a caller that threw here would turn every stray URL into a 500.
 */
export function specFor(method: string, pathname: string): RouteSpec | null {
  const all: readonly RouteSpec[] = ROUTES;
  const exact = all.find((spec) => spec.method === method && spec.path === pathname);
  if (exact !== undefined) return exact;
  return MATCHERS.find((m) => m.method === method && m.pattern.test(pathname))?.spec ?? null;
}
