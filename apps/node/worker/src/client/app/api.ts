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
