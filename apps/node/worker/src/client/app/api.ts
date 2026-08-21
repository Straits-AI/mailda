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
  pause: { reason: string; detail: string; trippedBy: string; at: string } | null;
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
}

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

export const createButler = (name: string, source: string) =>
  butlerAct<{ butler: { butlerId: string } }>("/api/butlers", "POST", { name, source });

export const saveButlerDraft = (id: string, source: string) =>
  butlerAct<{ butler: { versionId: string } }>(
    `/api/butlers/${encodeURIComponent(id)}/draft`, "PUT", { source },
  );

export const publishButlerVersion = (id: string) =>
  butlerAct<{ published: { version: number } }>(
    `/api/butlers/${encodeURIComponent(id)}/publish`, "POST",
  );

export const resumeButler = (butlerId: string, reason: string) =>
  butlerAct<{ resumed: unknown }>(
    `/api/butler-pauses/${encodeURIComponent(butlerId)}/resume`, "POST", { reason },
  );
