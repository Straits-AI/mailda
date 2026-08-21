import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch } from "/app/session.js";

/**
 * Every read the application performs, and the one rule they all share.
 *
 * ## Why there is no client-side authorization cache
 *
 * ADR 11 re-checks who may read what **on every request**, inside the SQL rather than as a filter applied
 * afterwards. So the client must never hold a decision about visibility — not a list of readable
 * mailboxes, not a cached count. `staleTime` is therefore short and refetch-on-focus stays on: a
 * revocation that took effect server-side must not be papered over by a cache that still remembers the
 * answer. This is the reason ADR 30 also ruled out SSR for the shell.
 *
 * ## Why errors are values here
 *
 * `apiFetch` already performs the one automatic refresh-and-retry on a refreshable 401, so a 401 that
 * reaches this layer means the refresh token is gone and the honest next step is the sign-in form —
 * handled once, in `main.tsx`, rather than per screen. Everything else becomes a rendered failure with
 * the Node's own words, because §5C's rule about not claiming an unobserved outcome applies to the
 * interface too: "could not be read" is a different statement from "empty".
 */

/** A read that failed, carrying what the Node said rather than a generic apology. */
export class ReadFailure extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ReadFailure";
    this.status = status;
  }
}

async function read<T>(path: string): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) {
    // The Node's error bodies carry `message`; anything else is a genuine surprise and says so.
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new ReadFailure(
      response.status,
      body?.message ?? `This Node answered ${response.status} and gave no reason.`,
    );
  }
  return (await response.json()) as T;
}

/** Short, because a revocation must not be hidden by a cache. See the header. */
const AUTHORIZATION_SENSITIVE = { staleTime: 5_000, refetchOnWindowFocus: true } as const;

export interface Me { signedIn: boolean; userId: string; organizationId: string; email: string | null }

export interface MessageRow {
  id: string;
  message_id: string | null;
  subject: string | null;
  from_addr: string | null;
  envelope_from: string;
  envelope_to: string;
  mailbox_id: string;
  raw_bytes: number;
  accepted_at: string;
  parse_error: string | null;
  conversation_id: string | null;
  /**
   * The case for this delivery's own mailbox, so replying can claim in one act.
   *
   * Null for mail that predates a conversation, or if the backfill has not run — in which case the reply
   * button has nothing to claim and says so rather than composing a reply nobody holds.
   */
  case_id: string | null;
}

export interface RecipientRow {
  manifest_id: string;
  kind: string;
  address: string;
  submission_state: string;
  delivery_state: string | null;
  bounce_type: string | null;
  last_error: string | null;
}

export interface SendRow {
  id: string;
  subject: string;
  envelope_to: string;
  state: string;
  state_at: string;
  release_at: string;
  attempts: number;
  last_error: string | null;
  transport_message_id: string | null;
  fidelity: string;
  /**
   * Whether the submitted bytes exist, as 1 or 0 — SQLite's boolean.
   *
   * Not inferable from `state`: an authored send that was claimed and then failed before submitting sits in
   * `outcome_unknown` with nothing stored, and one still `held` has nothing either. Offering the link
   * anyway produced a 409 with a clear explanation that a person should never have been shown.
   */
  has_submitted: number;
  /**
   * The machine token behind a gated or refused state, or null when the state needs no reason (#60).
   *
   * Shipped alongside `state` rather than folded into it, because #62's vocabulary is state-plus-reason on
   * purpose: `awaiting` a hold and `awaiting` an approval are the same state with different answers to
   * "who can clear this", and collapsing them into two states is the shape that later reads as an accident.
   */
  state_reason: string | null;
  /** What policy decided at seal: allow | hold | require_approval | deny, or null for a pre-#60 send. */
  policy_outcome: string | null;
  recipients: RecipientRow[];
}

export interface DailySendState {
  day: string;
  handedOver: number;
  throttledAtCount: number | null;
  firstThrottledAt: string | null;
}

export interface SendCapability {
  canSend: boolean;
  arbitraryRecipients: boolean;
  verifiedAt: string | null;
  detail: string;
}

export interface AuditRow {
  id: string;
  seq: number;
  at: string;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  subject: string | null;
  outcome: string;
  detail: string;
  /** The chain link. Shown, because a hash nobody can see is a hash nobody can check. */
  hash: string;
}

export interface LogRow {
  id: string;
  at: string;
  level: string;
  event: string;
  message: string;
  detail: string | null;
  request_id: string | null;
}

/** One check's answer. `ok: false` with severity `degraded` is a real state, not a soft failure. */
export interface DoctorFinding {
  check: string;
  // Mirrors `Severity` in `src/doctor.ts`. `report` rather than `advisory`: a reconciler finding that a
  // receipt has no blob is *reported* and never acted on automatically (ADR 32), and the word carries that.
  severity: "refuse" | "degraded" | "report";
  ok: boolean;
  detail: string;
  fix?: string;
  receipt?: string;
}

export interface DoctorReport {
  verdict: "ok" | "degraded" | "refuse";
  claimed: boolean;
  at: string;
  findings: DoctorFinding[];
}

/**
 * One delivered notice (#63 part B, §7).
 *
 * `body` is `unknown` on purpose. It is written by the Node at delivery and **frozen**, so a notice
 * delivered by an older version of this Node carries an older shape — and a client that declared the shape
 * as a type would render a field that is not there rather than saying it cannot read it. The component
 * narrows what it needs and shows the rest as absent.
 */
export interface NotificationRow {
  id: string;
  kind: "supervised_read" | "approval_request";
  subjectId: string;
  mailboxId: string | null;
  matterId: string | null;
  dueAt: string | null;
  deliveredAt: string | null;
  body: unknown;
}

/**
 * The signed-in person's notices.
 *
 * Authorization-sensitive like everything else here: the audience for a §7 notice is resolved live from
 * the standing relations on the mailbox, so a cache would be a decision about visibility held on the client
 * — which ADR 11 puts on the server on every request.
 */
export function useNotifications(): UseQueryResult<{ notifications: NotificationRow[] }, Error> {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => read<{ notifications: NotificationRow[] }>("/api/notifications"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useMe(): UseQueryResult<Me, Error> {
  return useQuery({ queryKey: ["me"], queryFn: () => read<Me>("/api/me"), ...AUTHORIZATION_SENSITIVE });
}

export function useMessages(): UseQueryResult<{ messages: MessageRow[] }, Error> {
  return useQuery({
    queryKey: ["messages"],
    queryFn: () => read<{ messages: MessageRow[] }>("/api/messages"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export interface SendsResponse {
  sends: SendRow[];
  daily: DailySendState;
  capability: SendCapability;
}

export function useSends(): UseQueryResult<SendsResponse, Error> {
  return useQuery({
    queryKey: ["sends"],
    queryFn: () => read<SendsResponse>("/api/sends"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useAudit(): UseQueryResult<{ entries: AuditRow[] }, Error> {
  return useQuery({
    queryKey: ["audit"],
    queryFn: () => read<{ entries: AuditRow[] }>("/api/audit"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useLogs(): UseQueryResult<{ entries: LogRow[]; counts: Array<{ level: string; n: number }> }, Error> {
  return useQuery({
    queryKey: ["logs"],
    queryFn: () => read<{ entries: LogRow[]; counts: Array<{ level: string; n: number }> }>("/api/logs"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/**
 * The Node's own verdict on itself, for the instrument bar.
 *
 * Polled rather than fetched once: `doctor` is the thing that tells an operator the Node stopped being
 * able to do its job, and a verdict from the moment the tab opened is the least useful version of that.
 * Slow enough not to be a load — the report costs real queries — and it is the same endpoint the CLI uses.
 */
export function useDoctor(): UseQueryResult<DoctorReport, Error> {
  return useQuery({
    queryKey: ["doctor"],
    queryFn: () => read<DoctorReport>("/api/doctor"),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

/* ------------------------------------------------------------------ Layer 3: queues and cases ------ */

export interface MailboxQueue {
  id: string;
  name: string;
  unclaimed: number;
  claimed: number;
  mine: number;
  /** NULL means the mailbox promises nothing — the shipped default, and not a missing value. */
  first_response_minutes: number | null;
  breached: number;
  /**
   * Every address routed to this mailbox, oldest first, comma-separated — NULL when it has none.
   *
   * Present so the composer can *offer* the From choice. A mailbox may have several addresses, and
   * `sealManifest` refuses an unnamed sender when it does — a refusal a person cannot comply with is a dead
   * end, and this is the way to comply.
   */
  addresses: string | null;
}

export interface CaseRow {
  id: string;
  conversation_id: string;
  mailbox_id: string;
  state: "open" | "claimed" | "closed";
  state_at: string;
  assignee: string | null;
  claimed_at: string | null;
  created_at: string;
  subject: string | null;
  from_addr: string | null;
  /**
   * True when `subject` and `from_addr` were **withheld** rather than absent — the caller holds
   * `send.propose` but neither read relation on the mailbox. Rendered as §7's restricted-content
   * placeholder, which is not the same thing as "(no subject)" and must not look like it.
   */
  content_restricted: boolean;
  message_count: number;
  assignee_email: string | null;
  response_due_at: string | null;
  first_response_at: string | null;
  response_breached_at: string | null;
}

/** The rail's rows. Only mailboxes this person may work, with their depths. */
export function useMailboxes(): UseQueryResult<{ mailboxes: MailboxQueue[] }, Error> {
  return useQuery({
    queryKey: ["mailboxes"],
    queryFn: () => read<{ mailboxes: MailboxQueue[] }>("/api/mailboxes"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useCases(mailboxId: string | null): UseQueryResult<{ cases: CaseRow[] }, Error> {
  return useQuery({
    queryKey: ["cases", mailboxId],
    queryFn: () => read<{ cases: CaseRow[] }>(`/api/cases?mailbox=${encodeURIComponent(mailboxId!)}`),
    enabled: mailboxId !== null,
    ...AUTHORIZATION_SENSITIVE,
  });
}

/**
 * What happened when somebody tried to take a case.
 *
 * `held` is not a failure to report generically — it carries **who** holds it and since when, because a
 * person who lost a compare-and-swap is owed the name of whoever won it rather than a spinner that stops.
 * The server reads the row back for exactly this.
 */
export type ClaimResult =
  | { ok: true; case: CaseRow }
  | { ok: false; kind: "held"; heldBy: string; heldSince: string; message: string }
  | { ok: false; kind: "closed" | "not_found" | "failed"; message: string };

async function act(caseId: string, action: "claim" | "steal" | "release" | "close"): Promise<ClaimResult> {
  const response = await apiFetch(`/api/cases/${encodeURIComponent(caseId)}/${action}`, { method: "POST" });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    return { ok: true, case: (body?.case ?? null) as CaseRow };
  }
  if (body?.error === "held") {
    return {
      ok: false,
      kind: "held",
      heldBy: String(body.heldBy ?? "somebody"),
      heldSince: String(body.heldSince ?? ""),
      message: String(body.message ?? "Somebody else is holding this."),
    };
  }
  const kind = body?.error === "closed" ? "closed" : body?.error === "not_found" ? "not_found" : "failed";
  return {
    ok: false,
    kind,
    message: String(body?.message ?? body?.reason ?? `This Node answered ${response.status}.`),
  };
}

export const claimCase = (id: string) => act(id, "claim");
export const stealCase = (id: string) => act(id, "steal");
export const releaseCase = (id: string) => act(id, "release");
export const closeCase = (id: string) => act(id, "close");

/** Sets or clears a mailbox's first-response target. Administrator only, and audited. */
export async function setResponseTarget(
  mailboxId: string,
  minutes: number | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const response = await apiFetch(`/api/mailboxes/${encodeURIComponent(mailboxId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstResponseMinutes: minutes }),
  });
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  // The Node's four-part message verbatim: it names the remedy, and paraphrasing drops that half.
  return { ok: false, message: body?.message ?? `This Node answered ${response.status}.` };
}

/** Merges one conversation into another. Refuses more often than it succeeds, by design (#43). */
export async function mergeConversations(
  from: string,
  into: string,
): Promise<{ ok: true; messagesMoved: number } | { ok: false; message: string }> {
  const response = await apiFetch("/api/conversations/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, into }),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok && body?.merged === true) {
    return { ok: true, messagesMoved: Number(body.messagesMoved ?? 0) };
  }
  // The refusal reason *is* the deliverable here — it names the case pair to resolve first.
  return {
    ok: false,
    message: String(body?.reason ?? body?.message ?? `This Node answered ${response.status}.`),
  };
}

/* ------------------------------------------------------------------ Layer 5: Butlers (#78) --------- */

/**
 * A Butler, as the list reports it.
 *
 * `live_version` and `pause` are separate fields because they are separate facts, and the pair is the whole
 * reason this row is shaped this way: a Butler can be **published and stopped**. Reporting only the first
 * would be the enablement pointer #66 rejected, which conflates *not deployed* with *stopped by a breaker*.
 */
export interface ButlerRow {
  id: string;
  name: string;
  created_at: string;
  live_version_id: string | null;
  live_version: number | null;
  published_at: string | null;
  /** The unpublished working copy, if there is one. At most one per Butler, by partial unique index. */
  draft_version_id: string | null;
  /**
   * The pause in force, exactly as `pausesInForce` returns it.
   *
   * Spelled out field by field rather than approximated, because approximating it shipped two defects at
   * once: `at` did not exist (the field is `placedAt`, so the panel rendered an invalid date), and the
   * resume act was handed `butler.id` when the route takes `pauseId` — so the button answered 404 every
   * time. Neither was visible in a screenshot; both were found by clicking it.
   */
  pause: {
    pauseId: string;
    butlerId: string;
    butlerName: string;
    reason: string;
    detail: string;
    trippedBy: string;
    placedAt: string;
  } | null;
}

export interface ButlerVersionRow {
  id: string;
  version: number | null;
  state: string;
  ast_sha256: string;
  source_sha256: string;
  created_by: string;
  created_at: string;
  published_by: string | null;
  published_at: string | null;
  superseded_at: string | null;
  /** Present for the draft alone — a published version's body is immutable and named by its digest. */
  source_text: string | null;
  /*
   * Travels for *every* version, including the superseded ones whose `source_text` is withheld. The format
   * is metadata about how a version was written rather than the writing itself, and the history view's
   * question — "when did this Butler move to YAML?" — is unanswerable without it.
   */
  source_format: ButlerSourceFormat;
}

/**
 * The two grammars a Butler may be authored in (#87).
 *
 * Declared here rather than imported from `src/butlers.ts` because this file is the browser bundle's edge
 * and the worker module reaches D1 — pulling it in would drag the store into the client. The pair is held
 * together by `test/node/route-coverage`, which reads both sides of every route this file names.
 */
export type ButlerSourceFormat = "json" | "yaml";

export interface ButlerRunRow {
  id: string;
  butler_id: string;
  version_id: string;
  trigger_event: string;
  trigger_key: string;
  state: string;
  outcome_reason: string | null;
  started_at: string;
  finished_at: string | null;
  nodes_executed: number;
  effects: number;
  refusals: number;
  subrequests_spent: number;
  replay_of: string | null;
  replayed_by: string | null;
}

export function useButlers(): UseQueryResult<{ butlers: ButlerRow[] }, Error> {
  return useQuery({
    queryKey: ["butlers"],
    queryFn: () => read<{ butlers: ButlerRow[] }>("/api/butlers"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useButler(id: string | null): UseQueryResult<
  { butler: { id: string; name: string }; versions: ButlerVersionRow[] }, Error
> {
  return useQuery({
    queryKey: ["butler", id],
    queryFn: () => read<{ butler: { id: string; name: string }; versions: ButlerVersionRow[] }>(
      `/api/butlers/${encodeURIComponent(id!)}`,
    ),
    enabled: id !== null,
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useButlerRuns(): UseQueryResult<{ runs: ButlerRunRow[] }, Error> {
  return useQuery({
    queryKey: ["butler-runs"],
    queryFn: () => read<{ runs: ButlerRunRow[] }>("/api/butler-runs"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/**
 * The four acts, sharing one refusal shape.
 *
 * Every one of them can be refused for a reason the caller needs to read verbatim: the checker's findings,
 * `E_NOT_AN_ADMINISTRATOR`, a publish with nothing to publish. `describeFindings` writes those sentences and
 * paraphrasing them here would drop the half that says what to do — the same rule `setResponseTarget` follows.
 */
async function butlerAct<T>(
  path: string,
  method: "POST" | "PUT",
  body?: unknown,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const response = await apiFetch(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return { ok: true, value: parsed as T };
  return {
    ok: false,
    message: String(parsed?.message ?? parsed?.error ?? `This Node answered ${response.status}.`),
  };
}


/** One node's effect in a dry run (#87). See `src/butler/simulate.ts` on the three outcomes. */
export interface SimulatedEffectRow {
  seq: number;
  nodeId: string;
  nodeType: string;
  /** `would` is a write this Node declined to make; `ok`/`refused`/`failed` are real answers from real reads. */
  outcome: "ok" | "refused" | "failed" | "would";
  reason: string | null;
  subject: string | null;
  detail?: Record<string, unknown>;
}

export interface Simulation {
  butlerId: string;
  butlerName: string;
  versionId: string;
  version: number | null;
  state: string;
  reason: string | null;
  nodesExecuted: number;
  effects: SimulatedEffectRow[];
  wouldSpend: number;
  bindings: Record<string, unknown>;
  /** What the dry run could not evaluate, in words. Rendered verbatim — a paraphrase drops the reason. */
  limits: string[];
}

/**
 * A dry run of the Butler's current program over facts from a real delivery.
 *
 * The facts come from a recorded run rather than being typed, because a delivery's facts are not something a
 * person can write by hand — `parentDelivery` refuses a malformed one, and a dry run over facts that were
 * never real would answer a question about nothing.
 */
export const simulateButler = (id: string, facts: Record<string, unknown>) =>
  butlerAct<{ simulation: Simulation }>(
    `/api/butlers/${encodeURIComponent(id)}/simulate`, "POST", { facts },
  );

/** A recorded run's own input, which is what a dry run is given. */
export const runFacts = (runId: string) =>
  read<{ facts: Record<string, unknown> | null }>(
    `/api/butler-runs/${encodeURIComponent(runId)}/inspect`,
  );

export const createButler = (name: string, source: string, sourceFormat: ButlerSourceFormat) =>
  butlerAct<{ butler: { butlerId: string } }>(
    "/api/butlers", "POST", { name, source, sourceFormat },
  );

export const saveButlerDraft = (id: string, source: string, sourceFormat: ButlerSourceFormat) =>
  butlerAct<{ butler: { versionId: string } }>(
    `/api/butlers/${encodeURIComponent(id)}/draft`, "PUT", { source, sourceFormat },
  );

export const publishButlerVersion = (id: string) =>
  butlerAct<{ published: { version: number } }>(
    `/api/butlers/${encodeURIComponent(id)}/publish`, "POST",
  );

/** Takes the **pause** id, not the Butler's: one Butler can have been paused more than once over time. */
export const resumeButler = (pauseId: string, reason: string) =>
  butlerAct<{ resumed: unknown }>(
    `/api/butler-pauses/${encodeURIComponent(pauseId)}/resume`, "POST", { reason },
  );

/* ------------------------------------------------------------------ Layer 4: approvals (#81) ------- */

export interface ApprovalStage { count: number; teamId: string | null }

/**
 * One approval waiting on the signed-in person, exactly as `pendingApprovals` returns it.
 *
 * The list is already bounded by the caller: it computes the eligible set per subject kind and excludes the
 * actor, so this screen shows what somebody may decide and never has to work that out for itself. Deciding
 * who may approve in the browser would be a second opinion about separation of duty (§18).
 */
export interface ApprovalRow {
  id: string;
  subjectKind: "send_manifest" | "hold_lift" | "supervised_read" | "ediscovery_export" | "domain_pause";
  subjectId: string;
  scopeId: string;
  /** The person whose act this gates. Never eligible to decide it. */
  actorUserId: string;
  state: string;
  requestedAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
  stages: ApprovalStage[];
  openStage: number | null;
  /** True when the caller has already decided, so the row is theirs to **withdraw** rather than to decide. */
  decidedByMe: boolean;
  /** The requester's own words, where the subject kind carries any. NULL for a send. */
  reason: string | null;
  supervised?: { grantId: string; subjectId: string; scope: string; matterId: string | null } | null;
  pause?: { pauseId: string; domain: string; reason: string } | null;
}

export function useApprovals(): UseQueryResult<{ approvals: ApprovalRow[] }, Error> {
  return useQuery({
    queryKey: ["approvals"],
    queryFn: () => read<{ approvals: ApprovalRow[] }>("/api/approvals"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

async function approvalAct(
  path: string,
  body?: unknown,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string }> {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return { ok: true, value: parsed ?? {} };
  // Verbatim, as everywhere else: `E_APPROVER_IS_ACTOR` explains §18 in a sentence a paraphrase would lose.
  return {
    ok: false,
    message: String(parsed?.message ?? parsed?.error ?? `This Node answered ${response.status}.`),
  };
}

export const decide = (id: string, decision: "approve" | "deny") =>
  approvalAct(`/api/approvals/${encodeURIComponent(id)}/decide`, { decision });

export const withdrawDecision = (id: string) =>
  approvalAct(`/api/approvals/${encodeURIComponent(id)}/withdraw`);

/* ------------------------------------------------------------------ Layer 4: policies (#81) -------- */

/**
 * One policy **version**, as the list returns it — the endpoint returns every version of every policy, so a
 * row is a version and the policy it belongs to is `policy_id` / `name`.
 *
 * The five conditions arrive as typed columns rather than a blob, which is #60's decision and matters here:
 * a screen can render exactly the five that exist, and a sixth cannot appear without the column that would
 * make something evaluate it.
 */
export interface PolicyVersionRow {
  policy_id: string;
  name: string;
  version_id: string;
  version: number | null;
  state: string;
  outcome: "allow" | "hold" | "require_approval" | "deny";
  when_mailbox_id: string | null;
  when_actor_user_id: string | null;
  /** SQLite booleans: 1, 0 or NULL, where NULL means the condition is not part of this rule. */
  when_recipient_external: number | null;
  when_is_reply: number | null;
  when_org_daily_volume_min: number | null;
  created_at: string;
  published_at: string | null;
  superseded_at: string | null;
}

export interface PolicyConditions {
  mailboxId?: string | null;
  actorUserId?: string | null;
  recipientExternal?: boolean | null;
  isReply?: boolean | null;
  orgDailyVolumeMin?: number | null;
}

export function usePolicies(): UseQueryResult<{ policies: PolicyVersionRow[] }, Error> {
  return useQuery({
    queryKey: ["policies"],
    queryFn: () => read<{ policies: PolicyVersionRow[] }>("/api/policies"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

async function policyAct<T>(
  path: string,
  method: "POST" | "PUT",
  body?: unknown,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const response = await apiFetch(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return { ok: true, value: parsed as T };
  return {
    ok: false,
    message: String(parsed?.message ?? parsed?.error ?? `This Node answered ${response.status}.`),
  };
}

export const createPolicy = (
  name: string, outcome: string, conditions: PolicyConditions, stages: number[],
) => policyAct<{ policy: { policyId: string } }>("/api/policies", "POST", {
  name, outcome, conditions, stages,
});

export const savePolicyDraft = (
  id: string, outcome: string, conditions: PolicyConditions, stages: number[],
) => policyAct<{ policy: { versionId: string } }>(
  `/api/policies/${encodeURIComponent(id)}/draft`, "PUT", { outcome, conditions, stages },
);

export const publishPolicyVersion = (id: string) =>
  policyAct<{ published: { version: number } }>(
    `/api/policies/${encodeURIComponent(id)}/publish`, "POST",
  );

/* ------------------------------------------------------------------ Layer 2/3: people (#39, #81) --- */

/**
 * The relations an administrator may grant, and what each one lets somebody do.
 *
 * Mirrors `GRANTABLE` in `src/access.ts` minus `supervised.read`, which is **not** granted this way: it is a
 * time-boxed grant needing two approvals and a matter (§7), and the Node refuses it here with a message
 * saying so. Listing it as an option would be offering a door that answers with a lecture.
 */
export const GRANTABLE_RELATIONS = [
  { relation: "mailbox.metadata.read", object: "mailbox", what: "See that mail exists — senders, subjects, when. Not the message itself." },
  { relation: "mailbox.content.read", object: "mailbox", what: "Read the messages." },
  { relation: "send.propose", object: "mailbox", what: "Write and send from this mailbox, and claim its cases." },
  { relation: "approval.decide", object: "mailbox", what: "Decide approvals for its mail. Never their own." },
  { relation: "message.export", object: "mailbox", what: "Take a copy of a message out of the Node." },
  { relation: "ediscovery.export", object: "mailbox", what: "Run a bulk export against a matter." },
  { relation: "org.admin", object: "organization", what: "Administer the organization: rules, Butlers, access, holds." },
] as const;

export interface PersonRow {
  id: string;
  email: string;
  created_at: string;
  relations: Array<{ relation: string; objectType: string; objectId: string }>;
}

export function usePeople(): UseQueryResult<{ people: PersonRow[] }, Error> {
  return useQuery({
    queryKey: ["people"],
    queryFn: () => read<{ people: PersonRow[] }>("/api/people"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export interface TeamRow { id: string; name: string; createdAt: string; memberCount: number }

export function useTeams(): UseQueryResult<{ teams: TeamRow[] }, Error> {
  return useQuery({
    queryKey: ["teams"],
    queryFn: () => read<{ teams: TeamRow[] }>("/api/teams"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

async function accessAct(
  method: "POST" | "DELETE",
  body: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const response = await apiFetch("/api/access", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return { ok: true };
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  // Verbatim: the refusal for `supervised.read` explains the whole §7 ceremony, and a paraphrase loses it.
  return {
    ok: false,
    message: String(parsed?.message ?? parsed?.error ?? `This Node answered ${response.status}.`),
  };
}

export const grant = (subjectId: string, relation: string, objectId: string) =>
  accessAct("POST", { subjectId, relation, objectId });

export const revokeAccess = (subjectId: string, relation: string, objectId: string) =>
  accessAct("DELETE", { subjectId, relation, objectId });

export async function createTeam(name: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const response = await apiFetch("/api/teams", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (response.ok) return { ok: true };
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: false, message: String(parsed?.message ?? `This Node answered ${response.status}.`) };
}

export async function setTeamMember(
  teamId: string, userId: string, member: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const response = await apiFetch(`/api/teams/${encodeURIComponent(teamId)}/members`, {
    method: member ? "POST" : "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (response.ok) return { ok: true };
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: false, message: String(parsed?.message ?? `This Node answered ${response.status}.`) };
}

/** A team's roster. Per team rather than folded into the listing, which returns a count by design. */
export function useTeamMembers(teamId: string): UseQueryResult<{ members: string[] }, Error> {
  return useQuery({
    queryKey: ["team-members", teamId],
    queryFn: () => read<{ members: string[] }>(`/api/teams/${encodeURIComponent(teamId)}/members`),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/* ------------------------------------------------------------------ Layer 5: sending limits (#66) -- */

/**
 * One rate breaker, as the Node reads it right now.
 *
 * `sentence` comes from the Node rather than from a table here: `RATE_BREAKERS` carries one plain sentence
 * per breaker, written where the breaker is defined and used by the refusal on a gated send. A second copy
 * in the client would drift from the words a person is shown when their message is actually stopped.
 */
export interface BreakerReading {
  breaker: string;
  sentence: string;
  observations: number;
  observed: number;
  percent: number | null;
  limit: number;
  windowSeconds: number;
  /** False when there is too little traffic to judge — which is a real answer, not a zero. */
  armed: boolean;
  unarmedReason: "no_observations" | null;
  tripped: boolean;
}

export interface DomainPauseRow {
  id: string;
  domain: string;
  placedAt: string;
  reason: string;
}

export function useBreakers(): UseQueryResult<{ breakers: BreakerReading[] }, Error> {
  return useQuery({
    queryKey: ["breakers"],
    queryFn: () => read<{ breakers: BreakerReading[] }>("/api/breakers"),
    // Faster than the authorization reads: this is a live instrument, and a stale one is misleading in the
    // one situation somebody opens it for.
    staleTime: 5_000,
    refetchInterval: 30_000,
  });
}

export function useDomainPauses(): UseQueryResult<{ pauses: DomainPauseRow[] }, Error> {
  return useQuery({
    queryKey: ["domain-pauses"],
    queryFn: () => read<{ pauses: DomainPauseRow[] }>("/api/domain-pauses"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

async function pauseAct(path: string, body?: unknown) {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return { ok: true as const, value: parsed ?? {} };
  return {
    ok: false as const,
    message: String(parsed?.message ?? parsed?.error ?? `This Node answered ${response.status}.`),
  };
}

/** Asks for a domain to be stopped. Two **other** administrators have to agree before it takes effect. */
export const requestDomainPause = (domain: string, reason: string) =>
  pauseAct("/api/domain-pauses", { domain, reason });

/** Restarts a domain's mail. One administrator, alone — the asymmetry is deliberate (#66). */
export const liftDomainPause = (id: string) =>
  pauseAct(`/api/domain-pauses/${encodeURIComponent(id)}/lift`);

/* ------------------------------------------------------------------ §7: matters and holds (#81) ---- */

export const MATTER_TYPES = [
  { type: "legal_hold", what: "Preserving mail for a legal obligation." },
  { type: "security_incident", what: "Investigating a compromise or a misuse of an account." },
  { type: "departure_handover", what: "Passing on the work of somebody who has left." },
  { type: "regulatory_request", what: "Answering a regulator." },
] as const;

export interface MatterRow {
  id: string;
  type: string;
  description: string;
  openedBy: string;
  openedAt: string;
  /** Null means **open** — and §7's notice to the person read about falls due when this stops being null. */
  closedAt: string | null;
  closedBy: string | null;
}

export interface HoldRow {
  id: string;
  matterId: string | null;
  mailboxId: string;
  fromDate: string | null;
  toDate: string | null;
  placedBy: string;
  placedAt: string;
  mailboxExists: boolean;
  pendingLift: { liftId: string; approvalId: string; requestedBy: string; reason: string } | null;
}

export interface SupervisedGrantRow {
  id: string;
  subjectId: string;
  mailboxId: string;
  scope: string;
  matterId: string | null;
  requestedAt: string;
  expiresAt: string;
  /** Null until the dual approval completes. **A requested grant grants nothing.** */
  grantedAt: string | null;
  live: boolean;
}

export interface ExportRow {
  id: string;
  matterId: string;
  mailboxId: string;
  requestedBy: string;
  maxMessages: number;
  state: string;
  stateReason: string | null;
  messagesEmitted: number;
  requestedAt: string;
  completedAt: string | null;
}

export function useMatters(): UseQueryResult<{ matters: MatterRow[] }, Error> {
  return useQuery({
    queryKey: ["matters"],
    queryFn: () => read<{ matters: MatterRow[] }>("/api/matters"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useHolds(): UseQueryResult<{ holds: HoldRow[] }, Error> {
  return useQuery({
    queryKey: ["holds"],
    queryFn: () => read<{ holds: HoldRow[] }>("/api/holds"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useSupervised(): UseQueryResult<{ supervised: SupervisedGrantRow[] }, Error> {
  return useQuery({
    queryKey: ["supervised"],
    queryFn: () => read<{ supervised: SupervisedGrantRow[] }>("/api/supervised"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/**
 * One spelling of the export route, for the reason `matter-and-scope-world.test.ts` gives about the storage
 * prefix: a path written twice is two things that can disagree.
 *
 * It also keeps this file clear of the literal that tripwire scans for. That guard is about the **R2 key**
 * `${orgId}/exports/${exportId}/` and an HTTP path is a different thing, but it cannot tell them apart —
 * and the right response to a blunt guard is to stop needing the exception, not to widen the guard.
 */
const EXPORTS = "/api/exports";

export function useExports(): UseQueryResult<{ exports: ExportRow[] }, Error> {
  return useQuery({
    queryKey: ["exports"],
    queryFn: () => read<{ exports: ExportRow[] }>(EXPORTS),
    ...AUTHORIZATION_SENSITIVE,
  });
}

async function matterAct(path: string, body?: unknown) {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return { ok: true as const, value: parsed ?? {} };
  return {
    ok: false as const,
    message: String(parsed?.message ?? parsed?.error ?? `This Node answered ${response.status}.`),
  };
}

export const openMatter = (type: string, description: string) =>
  matterAct("/api/matters", { type, description });

/** Closing a matter is what makes §7's notice to the people who were read about fall due. */
export const closeMatter = (id: string) =>
  matterAct(`/api/matters/${encodeURIComponent(id)}/close`);

export const placeHold = (mailboxId: string, matterId: string | null) =>
  matterAct("/api/holds", { mailboxId, matterId });

/** Asks for a hold to be lifted. Two other people have to agree; a hold is not lifted by one. */
export const askToLiftHold = (id: string, reason: string) =>
  matterAct(`/api/holds/${encodeURIComponent(id)}/lift`, { reason });

export const askToRead = (mailboxId: string, scope: string, durationSeconds: number, matterId: string | null) =>
  matterAct("/api/supervised", { mailboxId, scope, durationSeconds, matterId });

export const runExport = (id: string) =>
  matterAct(`${EXPORTS}/${encodeURIComponent(id)}/run`);

/* ------------------------------------------------------------------ inviting somebody (#83) -------- */

export interface InvitationRow {
  id: string;
  email: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  /** True once the clock has passed it. The row survives so an administrator can see what went stale. */
  expired: boolean;
}

export function useInvitations(): UseQueryResult<{ invitations: InvitationRow[] }, Error> {
  return useQuery({
    queryKey: ["invitations"],
    queryFn: () => read<{ invitations: InvitationRow[] }>("/api/invitations"),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/**
 * Mints an invitation and returns the secret **once**.
 *
 * There is no endpoint that can produce it again — the row holds only its hash — so a caller that discards
 * this value has to re-mint, which withdraws the old link. That is why the screen shows it immediately and
 * says so rather than tucking it behind a copy button that might not have been pressed.
 */
export async function invite(
  email: string,
): Promise<{ ok: true; secret: string; email: string; expiresAt: string } | { ok: false; message: string }> {
  const response = await apiFetch("/api/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    const minted = parsed?.invitation as { secret: string; email: string; expiresAt: string };
    return { ok: true, ...minted };
  }
  return {
    ok: false,
    message: String(parsed?.message ?? parsed?.error ?? `This Node answered ${response.status}.`),
  };
}
