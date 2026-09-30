import { useQuery, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch } from "/app/session.js";
import { t } from "/app/locale.js";
import type { AddressRemoval, AddressRouting, ProviderVerifiedDestinations } from "@mailda/contract/schemas";
export type { AddressRemoval, AddressRouting };
import {
  EXPORTS_LIST, EXPORT_RUN, MESSAGE_PAGE_PARAMS, PLACES, path as routePath, route,
  type HttpMethod, type PathFor,
} from "@mailda/contract/routes";

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
 * handled once rather than per screen: `session.client.js` emits `signed-out`, and the `onSessionChange`
 * listener in `app.client.js` unmounts the shell and renders sign-in. Everything else becomes a rendered failure with
 * the Node's own words, because §5C's rule about not claiming an unobserved outcome applies to the
 * interface too: "could not be read" is a different statement from "empty".
 */

/**
 * A failure's words, and who wrote them (ADR 46). `fromNode` words are the Node's own English, kept English for
 * the agents that parse them, and a screen shows them inside `<NodeWords>` (`marked()` in `words.tsx`); otherwise
 * they are this interface's sentence ("this Node answered 503"), in the viewer's language, and marking them
 * `lang="en"` would tell a screen reader to read Chinese with an English voice.
 */
export interface Said {
  readonly message: string;
  readonly fromNode: boolean;
}

/** A refusal, with its words and who wrote them. */
export type Refused = { readonly ok: false } & Said;

/** The Node's words when it sent some (`said` is a string), else this interface's `fallback`. */
export function saidBy(said: unknown, fallback: string): Said {
  return typeof said === "string" ? { message: said, fromNode: true } : { message: fallback, fromNode: false };
}

/** A refusal in the Node's words when its body carried any, else this interface's sentence naming the status. */
function refused(said: unknown, status: number): Refused {
  return { ok: false, ...saidBy(said, answered(status)) };
}

/** A read that failed, carrying what the Node said rather than a generic apology, and whether the Node said it. */
export class ReadFailure extends Error implements Said {
  readonly status: number;
  readonly fromNode: boolean;
  constructor(status: number, said: Said) {
    super(said.message);
    this.name = "ReadFailure";
    this.status = status;
    this.fromNode = said.fromNode;
  }
}

/**
 * Every path this client asks for, built from the shared contract (#85, ADR 12).
 *
 * ADR 12 locks *"UI, CLI, SDK, Skill and MCP parity is generated from shared contracts"*, and this file used
 * to be the counter-example: forty-nine path strings written by hand, none of which anything compared to the
 * Worker that serves them. A route renamed on one side and not the other produced a request that **succeeds**
 * — an unmatched `/api/…` path is answered with the interface shell and a 200 — so the screen renders empty
 * and nothing anywhere reports an error.
 *
 * Now the template is checked against `ROUTES` at **compile time**: `PathFor<M>` is the union of templates
 * registered for that method, so a typo, a removed route or the right path under the wrong verb stops the
 * build. `packages/contract/src/routes.ts` is that registry and
 * `apps/node/worker/test/node/route-registry.test.ts` holds it to `src/index.ts` in both directions — so the
 * chain runs from this call site to the handler with no hand-maintained link in it.
 */
function at<M extends HttpMethod>(
  method: M,
  template: PathFor<M>,
  params?: Readonly<Record<string, string>>,
): string {
  return routePath(route(method, template), params);
}

/** `at("GET", …)`, which is most of this file. The method is still named, in the registry lookup. */
function GET(template: PathFor<"GET">, params?: Readonly<Record<string, string>>): string {
  return at("GET", template, params);
}

async function read<T>(path: string): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) {
    // The Node's error bodies carry `message`; anything else is a genuine surprise and says so.
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new ReadFailure(response.status, saidBy(body?.message, t("api.no_reason", { status: String(response.status) })));
  }
  return (await response.json()) as T;
}

/**
 * A mutation, and its refusal **verbatim**. The Node's error body is `{ error, message }` where `message`
 * already carries the four-part what/why/fix — `E_APPROVER_IS_ACTOR` explains §18, `supervised.read` explains
 * the whole §7 ceremony — and a paraphrase drops the half that says what to do next.
 */
async function act<T = Record<string, unknown>>(
  path: string,
  method: "POST" | "PUT" | "DELETE" = "POST",
  body?: unknown,
): Promise<{ ok: true; value: T } | Refused> {
  const response = await apiFetch(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return { ok: true, value: (parsed ?? {}) as T };
  return refusalOf(parsed, response.status);
}

/**
 * A refusal body, as one string. Most carry `message` with the four parts already joined; a few handlers
 * (`POST /api/search/repair`) send `{ error, what, why, fix }` bare, and reading only `error` from those
 * showed a screen the word "unprocessable" and nothing else — the code without the why or the fix. That block
 * is the Node's: its what, why and fix, under labels that stay Latin in every locale (`api.refusal`).
 */
function refusalOf(parsed: Record<string, unknown> | null, status: number): Refused {
  if (typeof parsed?.what === "string" && typeof parsed.message !== "string") {
    return {
      ok: false,
      fromNode: true,
      message: t("api.refusal", {
        code: String(parsed.error ?? t("api.refusal.code")), what: parsed.what, why: String(parsed.why ?? ""), fix: String(parsed.fix ?? ""),
      }),
    };
  }
  return refused(parsed?.message ?? parsed?.error, status);
}

/**
 * The fallback when a failure's body carries no words. The status is passed as text: it is a code, not a
 * quantity, so it is never grouped or given another script's digits.
 */
function answered(status: number): string {
  return t("api.answered", { status: String(status) });
}

/** Short, because a revocation must not be hidden by a cache. See the header. */
const AUTHORIZATION_SENSITIVE = { staleTime: 5_000, refetchOnWindowFocus: true } as const;

/**
 * Who this credential is acting as.
 *
 * `userId` is **nullable** now: the route describes a principal, and an agent holding `identity.read` is not a
 * person. `principalId` is always there; `userId` is the person when there is one.
 */
export interface Me {
  signedIn: boolean;
  principalId: string;
  principalKind: "user" | "agent";
  userId: string | null;
  delegatorUserId: string | null;
  organizationId: string;
  email: string | null;
}

export type AuthenticationResult =
  | "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | "absent";

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
  /** RFC 8601's own words for what the receiving server established; null on a message from before 0055. */
  auth_spf: AuthenticationResult | null;
  auth_dkim: AuthenticationResult | null;
  auth_dmarc: AuthenticationResult | null;
  auth_dmarc_policy: string | null;
  auth_from_domain: string | null;
  /** Attached parts, and how many a mailbox may refuse to queue (0057); null before this Node looked. */
  attachments: number | null;
  attachments_dangerous: number | null;
  /** The words on this message (0061), as SQLite built the JSON array: lower-cased, sorted. */
  labels_json: string;
  /** Whether *you* have opened it (0062). */
  read: 0 | 1;
  /**
   * The case for this delivery's own mailbox, so replying can claim in one act.
   *
   * Null for mail that predates a conversation, or if the backfill has not run — in which case the reply
   * button has nothing to claim and says so rather than composing a reply nobody holds.
   */
  case_id: string | null;
  /** Where *you* keep it (0067). "inbox" for a receipt not yet materialised. */
  place: Place;
  /** The From header's display name (0068); null when there was none, it looked like an address or domain, or it
   *  is not yet projected. Shown WITH the address in the reader, because a display name is whatever the sender typed. */
  from_name: string | null;
  /** One line of the body (0068), opened only where you hold standing content read; null otherwise, and always
   *  null under a supervised grant (opening the message is the recorded act). */
  preview: string | null;
  /** 1 when you hold standing content read on this delivery's mailbox: you may mark it read, label it and place it. */
  standing_content: 0 | 1;
  /** 1 when this delivery's case is claimed by you. */
  case_mine: 0 | 1;
  /** The case's state, or null when there is none. */
  case_state: "open" | "claimed" | "closed" | null;
}

export type Place = (typeof PLACES)[number]; // "inbox" | "archive" | "trash"

export interface RecipientRow {
  manifest_id: string;
  kind: string;
  address: string;
  submission_state: string;
  delivery_state: string | null;
  /** Why no outcome is expected (`verified_destination`), or null; always null while `delivery_state` is set. */
  delivery_reason: string | null;
  bounce_type: string | null;
  last_error: string | null;
}

/**
 * One conversation, both halves: every message in it this reader may see, and every send that replied into
 * it. Two listings with one more predicate each, so the thread is authorized exactly as the inbox and the
 * outbox are — a message or a send the reader may not see is simply not in the thread.
 */
export function useThread(conversationId: string | null) {
  return useQuery({
    queryKey: ["thread", conversationId],
    queryFn: async () => {
      const [messages, sends] = await Promise.all([
        read<MessagesPage>(`${GET("/api/messages")}?${MESSAGE_PAGE_PARAMS.conversation}=${encodeURIComponent(conversationId!)}`),
        read<SendsResponse>(`${GET("/api/sends")}?conversation=${encodeURIComponent(conversationId!)}`),
      ]);
      return { messages: messages.messages, sends: sends.sends };
    },
    enabled: conversationId !== null,
    ...AUTHORIZATION_SENSITIVE,
  });
}

export interface SendRow {
  /** Which retry the Node offers this send, and why (ADR 40). `mode` null means none. */
  retry: { mode: string | null; why: string };
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
  /**
   * The person accountable for an act a machine performed. Null when the actor is a person acting for
   * themselves, which is nearly every entry.
   *
   * The column had been written and hashed into the chain since #109 L1 and was exposed by no surface, so the
   * trail knew which human stood behind an `agt_` and no reader could ask it (audit P1-1). A field inside the
   * hash that nothing shows is worse than a missing one — it reads as a question already answered.
   */
  delegator_user_id: string | null;
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
export function useNotifications(): UseQueryResult<{ notifications: NotificationRow[]; truncated: boolean }, Error> {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => read<{ notifications: NotificationRow[]; truncated: boolean }>(GET("/api/notifications")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useMe(): UseQueryResult<Me, Error> {
  return useQuery({ queryKey: ["me"], queryFn: () => read<Me>(GET("/api/me")), ...AUTHORIZATION_SENSITIVE });
}

export interface MessagesPage {
  messages: MessageRow[];
  /**
   * Where the next page resumes, or null for *"nothing older is visible to you"* (#91).
   *
   * Opaque to this client on purpose. It is a position the Node computed, and a client that took it apart to
   * decide anything would be holding a fact about the ordering that only the Node's query can be right about.
   * It goes back exactly as it arrived.
   */
  next_cursor: string | null;
  /** True when the Node looked back through `messages.max_lookback` messages you can see and stopped before
   *  filling the page (Inbox, Unread, Mine only); `next_cursor` then looks further back. A page it cut short is
   *  never a total (#91): the count shows `n+`, or nothing when the page is empty. */
  lookback_exhausted: boolean;
  /** How many of the messages you can see this request looked back through at most, or null when the page
   *  needed no lookback. The Node's own bound, which is what an empty lookback page names. */
  max_lookback: number | null;
}

export interface MessagePageQuery {
  cursor?: string | null;
  mailbox?: string | null;
  q?: string | null;
  label?: string | null;
  /** The envelope sender, exact (MESSAGE_PAGE_PARAMS.from). */
  from?: string | null;
  /** YYYY-MM-DD or an instant (MESSAGE_PAGE_PARAMS.since / until). */
  since?: string | null;
  until?: string | null;
  /** Omitted or null = every place (search, thread). */
  place?: Place | null;
  /** true sends unread=1. */
  unread?: boolean;
  /** true sends mine=1. */
  mine?: boolean;
}

/**
 * The one query key for a listing. Exported so the sidebar and its test can prove they share the Inbox's entry
 * (a second key is a second request and, for a supervised reader, a second audit entry).
 *
 * The search term goes to the Node **as typed** (#107): no trimming, no tokenizing and no validation here.
 * `ftsQuery` on the Node turns typing into an FTS5 expression, and a client that pre-processed it would be a
 * second opinion about what a search means — which is how the SDK and the shell end up searching differently
 * for the same words. A blank term is normalised to null only so it does not become a query-key variant that
 * fetches the same page twice.
 */
export function messagesKey(page?: MessagePageQuery): readonly [
  "messages", string | null, string | null, string | null, string | null, string | null, string | null,
  string | null, Place | null, boolean, boolean,
] {
  const q = page?.q === undefined || page.q === null || page.q.trim() === "" ? null : page.q;
  return [
    "messages", page?.cursor ?? null, page?.mailbox ?? null, q, page?.label ?? null, page?.from ?? null,
    page?.since ?? null, page?.until ?? null, page?.place ?? null, page?.unread === true, page?.mine === true,
  ] as const;
}

/**
 * One page of the inbox.
 *
 * **The cursor is part of the query key**, so each page is its own cache entry and going back to a page
 * already read is instant while still being re-authorized on the way — `AUTHORIZATION_SENSITIVE` applies per
 * page, so a revocation takes effect on the next fetch of *any* page rather than only the newest one. That is
 * the client half of what #91's cursor design is for: the Node re-runs the authorization for every page, and
 * this must not hold a page long enough to make that pointless.
 */
export function useMessages(
  page?: MessagePageQuery,
  options?: { staleTime?: number },
): UseQueryResult<MessagesPage, Error> {
  // The request is built from the key, so what is sent and what is cached cannot disagree.
  const key = messagesKey(page);
  const [, cursor, mailbox, q, label, from, since, until, place, unread, mine] = key;
  const search = new URLSearchParams();
  if (cursor !== null) search.set(MESSAGE_PAGE_PARAMS.cursor, cursor);
  if (mailbox !== null) search.set(MESSAGE_PAGE_PARAMS.mailbox, mailbox);
  if (q !== null) search.set(MESSAGE_PAGE_PARAMS.q, q);
  if (label !== null) search.set(MESSAGE_PAGE_PARAMS.label, label);
  if (from !== null) search.set(MESSAGE_PAGE_PARAMS.from, from);
  if (since !== null) search.set(MESSAGE_PAGE_PARAMS.since, since);
  if (until !== null) search.set(MESSAGE_PAGE_PARAMS.until, until);
  if (place !== null) search.set(MESSAGE_PAGE_PARAMS.place, place);
  if (unread) search.set(MESSAGE_PAGE_PARAMS.unread, "1");
  if (mine) search.set(MESSAGE_PAGE_PARAMS.mine, "1");
  const query = search.toString();

  return useQuery({
    queryKey: key,
    queryFn: () => read<MessagesPage>(`${GET("/api/messages")}${query === "" ? "" : `?${query}`}`),
    ...AUTHORIZATION_SENSITIVE,
    ...(options?.staleTime === undefined ? {} : { staleTime: options.staleTime }),
  });
}

/**
 * Sets `read` on every cached listing row carrying this msg_ id, without a refetch (a refetch after every open
 * is one more listing and, for a supervised reader, one more audit entry). Thread entries hold rows too.
 */
export function patchReadInCache(queryClient: QueryClient, messageId: string, read: 0 | 1): void {
  const patch = (rows: MessageRow[]): MessageRow[] =>
    rows.some((row) => row.message_id === messageId && row.read !== read)
      ? rows.map((row) => (row.message_id === messageId ? { ...row, read } : row))
      : rows;
  queryClient.setQueriesData<MessagesPage>({ queryKey: ["messages"] }, (page) =>
    page === undefined ? page : { ...page, messages: patch(page.messages) });
  queryClient.setQueriesData<{ messages: MessageRow[]; sends: SendRow[] }>({ queryKey: ["thread"] }, (thread) =>
    thread === undefined ? thread : { ...thread, messages: patch(thread.messages) });
}

/** PUT /api/messages/:messageId/place. The Node's refusal verbatim on failure. Callers invalidate ["messages"]. */
export async function setPlace(
  messageId: string, place: Place,
): Promise<{ ok: true; place: Place } | Refused> {
  const result = await act<{ place: Place }>(at("PUT", "/api/messages/:messageId/place", { messageId }), "PUT", { place });
  return result.ok ? { ok: true, place: result.value.place } : result;
}

/**
 * GET /api/messages/:receiptId/headers, on demand only (enabled when receiptId !== null). The header block is
 * content: under a supervised grant each fetch is a recorded open, so it is never prefetched and, once read,
 * never refetched (the evidence it comes from is immutable).
 */
export function useMessageHeaders(
  receiptId: string | null,
): UseQueryResult<{ headers: string; truncated: boolean; limit_bytes: number }, Error> {
  return useQuery({
    queryKey: ["headers", receiptId],
    queryFn: () => read<{ headers: string; truncated: boolean; limit_bytes: number }>(
      GET("/api/messages/:receiptId/headers", { receiptId: receiptId! }),
    ),
    enabled: receiptId !== null,
    staleTime: Infinity,
  });
}

export interface SendsResponse {
  sends: SendRow[];
  /** The outbox shows the newest fifty; true says older ones exist and are not in `sends`. */
  truncated: boolean;
  daily: DailySendState;
  capability: SendCapability;
}

/**
 * How long after a held send's `release_at` the Outbox asks again, and how often while one is still held past
 * it. A presentation cadence, not a measurement: the Node's alarm wakes at `release_at` and hands the send over
 * within a moment, and 5 s matches the staleness `AUTHORIZATION_SENSITIVE` already accepts.
 */
const HELD_RECHECK_MS = 5_000;
/** The longest delay a browser timer holds (a signed 32-bit count of ms); past it the delay wraps to ~0. */
const LONGEST_TIMER_MS = 2_147_483_647;

/**
 * When `["sends"]` next reads itself, or `false` for never on its own.
 *
 * `held` is the one state a send leaves by itself, on its own clock, so while one is listed the Outbox row, its
 * sidebar badge and the health popover would otherwise say "held" for as long as nobody reloaded. The read waits
 * for the earliest `release_at` rather than polling through the hold window, which can be an hour: the Node's
 * own sweep sleeps until then for the same reason. `awaiting` and `withheld` wait on a person, whose act
 * invalidates this query, so they schedule nothing.
 */
export function nextSendsRead(data: SendsResponse | undefined, now: number): number | false {
  const due = (data?.sends ?? []).filter((send) => send.state === "held").map((send) => Date.parse(send.release_at));
  if (due.length === 0) return false;
  const earliest = Math.min(...due);
  if (!Number.isFinite(earliest)) return HELD_RECHECK_MS;
  return Math.min(Math.max(earliest - now, 0) + HELD_RECHECK_MS, LONGEST_TIMER_MS);
}

export function useSends(): UseQueryResult<SendsResponse, Error> {
  return useQuery({
    queryKey: ["sends"],
    queryFn: () => read<SendsResponse>(GET("/api/sends")),
    ...AUTHORIZATION_SENSITIVE,
    refetchInterval: (query) => nextSendsRead(query.state.data, Date.now()),
  });
}

export function useAudit(): UseQueryResult<{ entries: AuditRow[]; truncated: boolean }, Error> {
  return useQuery({
    queryKey: ["audit"],
    queryFn: () => read<{ entries: AuditRow[]; truncated: boolean }>(GET("/api/audit")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/** One withdrawn relation's person and object, as `withdrawals` keys it. */
export const withdrawalKey = (subjectId: string, objectId: string): string => `${subjectId} ${objectId}`;

/**
 * The person and object of every relation an administrator withdrew, from the newest `access.revoked` entries
 * (`GET /api/audit?action=access.revoked`, 29 September 2026), so People does not offer back what somebody took
 * away. `truncated` when older entries exist that this read did not see. An entry without its subject or object is
 * this Node's own fault and fails the read, which the screen shows, rather than being passed over.
 */
export function useWithdrawals(enabled: boolean): UseQueryResult<{ withdrawn: Set<string>; truncated: boolean }, Error> {
  return useQuery({
    queryKey: ["audit", "access.revoked"],
    queryFn: async () => {
      const { entries, truncated } = await read<{ entries: AuditRow[]; truncated: boolean }>(`${GET("/api/audit")}?action=access.revoked`);
      const withdrawn = entries.map((entry) => {
        const objectId = (JSON.parse(entry.detail) as { objectId?: unknown }).objectId;
        if (entry.subject === null || typeof objectId !== "string") {
          throw new Error(t("api.withdrawal.malformed", { id: entry.id, detail: entry.detail }));
        }
        return withdrawalKey(entry.subject, objectId);
      });
      return { withdrawn: new Set(withdrawn), truncated };
    },
    enabled,
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useLogs(): UseQueryResult<{ entries: LogRow[]; truncated: boolean; counts: Array<{ level: string; n: number }> }, Error> {
  return useQuery({
    queryKey: ["logs"],
    queryFn: () => read<{ entries: LogRow[]; truncated: boolean; counts: Array<{ level: string; n: number }> }>(GET("/api/logs")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/**
 * The Node's own verdict on itself, for the status bar and its health popover.
 *
 * Polled rather than fetched once: `doctor` is the thing that tells an operator the Node stopped being
 * able to do its job, and a verdict from the moment the tab opened is the least useful version of that.
 * Slow enough not to be a load — the report costs real queries — and it is the same endpoint the CLI uses.
 */
export function useDoctor(): UseQueryResult<DoctorReport, Error> {
  return useQuery({
    queryKey: ["doctor"],
    queryFn: () => read<DoctorReport>(GET("/api/doctor")),
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
  /** 1 when the mailbox holds back deliveries whose From domain failed DMARC and asks receivers to act. */
  quarantine_dmarc_fail: 0 | 1;
  /** 1 when it holds back a delivery carrying an executable, a script, or a program under a document's name. */
  quarantine_dangerous_attachments: 0 | 1;
  /** The attachment size bound and allowed-type list (0065), as stored; null is unbounded. */
  attachment_max_bytes: number | null;
  attachment_allowed_types: string | null;
  /** Held back and not yet released. */
  quarantined: number;
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
    queryFn: () => read<{ mailboxes: MailboxQueue[] }>(GET("/api/mailboxes")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/**
 * The mailboxes this person may **read**, which is the other question. `useMailboxes` is where they have
 * work (`send.propose`); this is what they may look at, and a supervised reader is in the second set and
 * not the first. The inbox's filter offers this one, because it narrows what is being looked at.
 */
export function useReadableMailboxes(): UseQueryResult<{ mailboxes: Array<{ id: string; name: string }> }, Error> {
  return useQuery({
    queryKey: ["mailboxes", "readable"],
    queryFn: () => read<{ mailboxes: Array<{ id: string; name: string }> }>(GET("/api/mailboxes/readable")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useCases(mailboxId: string | null): UseQueryResult<{ cases: CaseRow[] }, Error> {
  return useQuery({
    queryKey: ["cases", mailboxId],
    queryFn: () => read<{ cases: CaseRow[] }>(GET("/api/mailboxes/:mailboxId/cases", { mailboxId: mailboxId! })),
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
  | ({ ok: false; kind: "held"; heldBy: string; heldSince: string } & Said)
  | ({ ok: false; kind: "closed" | "not_found" | "failed" } & Said);

async function caseAct(caseId: string, action: "claim" | "steal" | "release" | "close"): Promise<ClaimResult> {
  return claimResultOf(await apiFetch(at("POST", "/api/cases/:caseId/:action", { caseId, action }), { method: "POST" }));
}

/** One reading of a case answer, so a hand-over refused as held names the holder exactly as a lost claim does. */
async function claimResultOf(response: Response): Promise<ClaimResult> {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    return { ok: true, case: (body?.case ?? null) as CaseRow };
  }
  if (body?.error === "held") {
    return {
      ok: false,
      kind: "held",
      heldBy: String(body.heldBy ?? t("api.held.somebody")),
      heldSince: String(body.heldSince ?? ""),
      ...saidBy(body.message, t("api.held.message")),
    };
  }
  const kind: "closed" | "not_found" | "failed" = body?.error === "closed" ? "closed" : body?.error === "not_found" ? "not_found" : "failed";
  return { kind, ...refused(body?.message ?? body?.reason, response.status) };
}

/**
 * Hands a case to a colleague by the address they sign in with. The Node refuses one who cannot send from the
 * mailbox. `holder` is the holder the giver saw (user id, or null for unclaimed); sent when given, so a case taken
 * in between is refused as held, naming who holds it now, rather than handed over from under them.
 */
export async function assignCase(caseId: string, email: string, holder?: string | null): Promise<ClaimResult> {
  return claimResultOf(await apiFetch(at("PUT", "/api/cases/:caseId/assignee", { caseId }), {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify(holder === undefined ? { email } : { email, holder }),
  }));
}

export const claimCase = (id: string) => caseAct(id, "claim");
export const stealCase = (id: string) => caseAct(id, "steal");
export const releaseCase = (id: string) => caseAct(id, "release");
export const closeCase = (id: string) => caseAct(id, "close");

/** Sets or clears a mailbox's first-response target. Administrator only, and audited. */
export async function setResponseTarget(
  mailboxId: string,
  minutes: number | null,
): Promise<{ ok: true } | Refused> {
  const response = await apiFetch(at("PATCH", "/api/mailboxes/:mailboxId", { mailboxId }), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstResponseMinutes: minutes }),
  });
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  // The Node's four-part message verbatim: it names the remedy, and paraphrasing drops that half.
  return refused(body?.message, response.status);
}

/**
 * An address on a mailbox, and whether mail for it reaches this Node (`POST /api/addresses`).
 *
 * `routing` is the half a screen must not drop: an address the Node knows and Cloudflare does not route is
 * silent, and `not_written` carries the reason and the command that finishes it. Its type is the contract's.
 */
export const addAddress = (address: string, mailboxId?: string) =>
  act<{ address: { id: string; address: string; mailboxId: string }; routing: AddressRouting }>(
    at("POST", "/api/addresses"), "POST", { address, ...(mailboxId === undefined ? {} : { mailboxId }) },
  );

/**
 * The mirror of `addAddress`: the row gone, and the rule that routed it deleted when it still delivered to
 * this Node. `routing` is again the half not to drop, because `not_removed` names what still routes here.
 */
export const removeAddress = (address: string) =>
  act<{ address: { id: string; address: string; mailboxId: string }; routing: AddressRemoval }>(
    at("DELETE", "/api/addresses"), "DELETE", { address },
  );

/** Renames a mailbox. Administrator only, audited with both names; the rail and the queue show the new one. */
export async function renameMailbox(mailboxId: string, name: string): Promise<{ ok: true } | Refused> {
  const response = await apiFetch(at("PATCH", "/api/mailboxes/:mailboxId", { mailboxId }), {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return refused(body?.message, response.status);
}

/** Creates a mailbox, named. Administrator only, audited; the creator may read and send from it. */
export async function createMailbox(name: string): Promise<{ ok: true; mailboxId: string } | Refused> {
  const response = await apiFetch(at("POST", "/api/mailboxes"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  const body = (await response.json().catch(() => null)) as { mailboxId?: string; message?: string } | null;
  if (response.ok) return { ok: true, mailboxId: body?.mailboxId ?? "" };
  return refused(body?.message, response.status);
}

/** Turns one of a mailbox's quarantine switches on or off. Administrator only, and audited. */
export async function setQuarantineSwitch(
  mailboxId: string,
  which: "dmarc" | "attachments",
  on: boolean,
): Promise<{ ok: true } | Refused> {
  const response = await apiFetch(at("PATCH", "/api/mailboxes/:mailboxId", { mailboxId }), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(which === "dmarc" ? { quarantineDmarcFail: on } : { quarantineDangerousAttachments: on }),
  });
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return refused(body?.message, response.status);
}

/** Sets a mailbox's attachment limits (0065). Administrator only, and audited. */
export async function setAttachmentLimits(
  mailboxId: string,
  limits: { attachmentMaxBytes?: number | null; attachmentAllowedTypes?: string[] | null },
): Promise<{ ok: true } | Refused> {
  const response = await apiFetch(at("PATCH", "/api/mailboxes/:mailboxId", { mailboxId }), {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(limits),
  });
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return refused(body?.message, response.status);
}

export interface QuarantinedDelivery {
  messageId: string;
  receiptId: string;
  mailboxId: string;
  mailboxAddress: string;
  subject: string | null;
  fromAddr: string | null;
  fromDomain: string | null;
  dmarcPolicy: string | null;
  acceptedAt: string;
  quarantinedAt: string;
  reason: "dmarc_fail_reject" | "dmarc_fail_quarantine" | "attachment_dangerous" | "attachment_too_large"
    | "attachment_type_refused" | "held";
  note: string | null;
}

/** Every delivery held back on this Node. Administrators only; anyone else is refused, and the hook says so. */
export function useQuarantine(enabled: boolean) {
  return useQuery({
    queryKey: ["quarantine"],
    queryFn: () => read<{ quarantined: QuarantinedDelivery[]; truncated: boolean }>(GET("/api/quarantine")),
    enabled,
  });
}

/** Lets one held delivery into its mailbox's queue. */
export async function releaseQuarantined(messageId: string): Promise<{ ok: true } | Refused> {
  const response = await apiFetch(at("POST", "/api/quarantine/:messageId/release", { messageId }), { method: "POST" });
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return refused(body?.message, response.status);
}

export interface DraftListRow {
  id: string;
  mailboxId: string;
  inReplyToMessageId: string | null;
  to: string[];
  subject: string;
  updatedAt: string;
  /** The case of the message this draft replies to, in the draft's mailbox; null for a new message or a message
   *  with no case. The composer claims it before sealing. */
  caseId: string | null;
}

/** Every draft of this person's, newest first. What the inbox's Drafts strip lists. */
export function useDrafts(): UseQueryResult<{ drafts: DraftListRow[]; truncated: boolean }, Error> {
  return useQuery({ queryKey: ["drafts"], queryFn: () => read<{ drafts: DraftListRow[]; truncated: boolean }>(GET("/api/drafts")), ...AUTHORIZATION_SENSITIVE });
}

/** Marks a message read or unread, for the caller (0062), carrying the Node's refusal verbatim when it refuses. */
export async function setRead(
  messageId: string, read: boolean,
): Promise<{ ok: true } | Refused> {
  const result = await act(at("PUT", "/api/messages/:messageId/read", { messageId }), "PUT", { read });
  return result.ok ? { ok: true } : result;
}

/** Puts words on a message or takes them off (0061). Answers the whole set afterwards. */
export async function setLabels(
  messageId: string, change: { add?: string[]; remove?: string[] },
): Promise<{ ok: true; labels: string[] } | Refused> {
  const response = await apiFetch(at("PUT", "/api/messages/:messageId/labels", { messageId }), {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(change),
  });
  const body = (await response.json().catch(() => null)) as { labels?: string[]; message?: string } | null;
  if (response.ok) return { ok: true, labels: body?.labels ?? [] };
  return refused(body?.message, response.status);
}

/** The labels on a listed row, parsed once. */
export function labelsOf(row: { labels_json: string }): string[] {
  try {
    return JSON.parse(row.labels_json) as string[];
  } catch {
    return [];
  }
}

/** Merges one conversation into another. Refuses more often than it succeeds, by design (#43). */
export async function mergeConversations(
  from: string,
  into: string,
): Promise<{ ok: true; messagesMoved: number } | Refused> {
  const response = await apiFetch(at("POST", "/api/conversations/merge"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, into }),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok && body?.merged === true) {
    return { ok: true, messagesMoved: Number(body.messagesMoved ?? 0) };
  }
  // The refusal reason *is* the deliverable here — it names the case pair to resolve first.
  return refused(body?.reason ?? body?.message, response.status);
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
    queryFn: () => read<{ butlers: ButlerRow[] }>(GET("/api/butlers")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useButler(id: string | null): UseQueryResult<
  { butler: { id: string; name: string }; versions: ButlerVersionRow[] }, Error
> {
  return useQuery({
    queryKey: ["butler", id],
    queryFn: () => read<{ butler: { id: string; name: string }; versions: ButlerVersionRow[] }>(
      GET("/api/butlers/:butlerId", { butlerId: id! }),
    ),
    enabled: id !== null,
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useButlerRuns(): UseQueryResult<{ runs: ButlerRunRow[] }, Error> {
  return useQuery({
    queryKey: ["butler-runs"],
    queryFn: () => read<{ runs: ButlerRunRow[] }>(GET("/api/butler-runs")),
    ...AUTHORIZATION_SENSITIVE,
  });
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
  act<{ simulation: Simulation }>(
    at("POST", "/api/butlers/:butlerId/simulate", { butlerId: id }), "POST", { facts },
  );

/** A recorded run's own input, which is what a dry run is given. */
export const runFacts = (runId: string) =>
  read<{ facts: Record<string, unknown> | null }>(
    GET("/api/butler-runs/:runId/inspect", { runId }),
  );

export interface TransportReport {
  adapter: string;
  capability: { canSend: boolean; arbitraryRecipients: boolean; verifiedAt: string | null; detail: string };
  available: {
    binding: boolean;
    /** `null` when no REST credentials exist. **Never carries the token** — see migration 0036. */
    rest: { accountId: string; configuredAt: string } | null;
  };
}

export function useTransport(): UseQueryResult<{ transport: TransportReport }, Error> {
  return useQuery({
    queryKey: ["transport"],
    queryFn: () => read<{ transport: TransportReport }>(GET("/api/transport")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/**
 * Supplies the account id and the sending API token (#86).
 *
 * The token goes **to** the Node and never comes back: it is wrapped under the credential KEK on arrival and
 * no route returns it. This is also why there is no CLI verb for it — wrapping needs the KeyVault Durable
 * Object, which only the Worker can reach, so a credential this Node encrypts can only be supplied through
 * this Node.
 */
export const configureTransport = (accountId: string, apiToken: string) =>
  act<{ configured: { accountId: string; configuredAt: string } }>(
    at("PUT", "/api/transport"), "PUT", { accountId, apiToken },
  );

/* ------------------------------------------------------------------ doctor's remedies ---------------- */

/**
 * The acts `doctor` names in its `fix` text, callable from the screen that shows the finding.
 *
 * Each existed as a route and a CLI verb; the browser had the report and none of the remedies, so an
 * administrator read "POST /api/maintenance/reseal" on a screen and went to find a terminal. Every one is
 * `org.admin` on the Node, and the screen does not check first — it renders the Node's refusal, verbatim,
 * the way `people.tsx` does.
 */

/** Ten fresh codes, in plaintext, once. Nothing stores them; see `recoveryCodesMintedResponse`. */
export interface RecoveryCodesMinted {
  codes: string[];
  escrowed: { content: number; credential: number };
  set: string;
  notice: string;
}

export const rotateRecoveryCodes = () =>
  act<RecoveryCodesMinted>(at("POST", "/api/recovery-codes/rotate"));

export const confirmRecoveryCode = (code: string) =>
  act<{ confirmed: number; alreadyConfirmed: boolean; message: string }>(
    at("POST", "/api/recovery-codes/confirm"), "POST", { code },
  );

export interface ResealOutcome {
  resealed: number;
  alreadyCurrent: number;
  failed: unknown[];
  remaining: number;
  targetGeneration: number;
  /** Row previews re-queued for the backfill because their old seal would not open (0068). */
  previewsRequeued: number;
}

export const resealEvidence = () => act<ResealOutcome>(at("POST", "/api/maintenance/reseal"));

export interface ReconcileOutcome {
  orphans: unknown[];
  orphansDeleted: number;
  draftBodiesDeleted: number;
  exportObjectsDeleted: number;
}

/** `collect=1` is the only call in the product that destroys content bytes; the screen asks twice. */
export const reconcileEvidence = (collect: boolean) =>
  act<ReconcileOutcome>(at("POST", "/api/maintenance/reconcile") + (collect ? "?collect=1" : ""));

export const applyMigrations = () =>
  act<{ applied: string[]; raced: string[]; alreadyCurrent: boolean; message: string }>(at("POST", "/api/prepare"));

export const acknowledgeConflict = (restoreId: string, scope: string, conclusion: string) =>
  act<{ acknowledged: { restoreId: string; generations: string; acknowledgedAt: string } }>(
    at("POST", "/api/recovery/conflicts/:restoreId/acknowledge", { restoreId }), "POST", { scope, conclusion },
  );

export interface FailedIndexRow {
  messageId: string;
  state: "unindexable" | "retryable";
  attempts: number;
  error: string | null;
}

export function useSearchFailed(): UseQueryResult<{ failed: FailedIndexRow[] }, Error> {
  return useQuery({
    queryKey: ["search-failed"],
    queryFn: () => read<{ failed: FailedIndexRow[] }>(GET("/api/search/failed")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export const repairSearch = (messageIds: string[]) =>
  act<{ requeued: number; message: string }>(at("POST", "/api/search/repair"), "POST", { messageIds });

/** Every row preview the backfill gave up on, back in its queue: a sweep, as the route explains (0068). */
export const requeuePreviews = () =>
  act<{ requeued: number; message: string }>(at("POST", "/api/maintenance/requeue-previews"));

export interface EvidenceFault {
  rowId: string;
  table: string;
  column: string;
  blobKey: string;
  kind: "missing" | "unreadable" | "altered";
  detail: string;
}

export interface EvidenceVerdict {
  checked: number;
  table: string | null;
  intact: boolean;
  faults: EvidenceFault[];
  resumeAfter: string | null;
  bytesRead: number;
}

/** One bounded batch; `after` continues from the previous verdict's `resumeAfter`. */
export const verifyEvidence = (after: string | null) =>
  act<EvidenceVerdict>(at("POST", "/api/evidence/verify") + (after === null ? "" : `?after=${encodeURIComponent(after)}`));

export interface PasskeyRow {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  transports: string[] | null;
}

export function usePasskeys(): UseQueryResult<{ passkeys: PasskeyRow[] }, Error> {
  return useQuery({
    queryKey: ["passkeys"],
    queryFn: () => read<{ passkeys: PasskeyRow[] }>(GET("/api/auth/passkeys")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/**
 * Registering a passkey from inside the application (#84).
 *
 * The ceremony is the browser's, so this is three steps and not one: ask this Node for a challenge, hand it
 * to the authenticator, hand what comes back to this Node. The binary conversions happen here because
 * `navigator.credentials` speaks `ArrayBuffer` and the routes speak base64url — the same boundary
 * `app.client.js` crosses for sign-in, and the code is deliberately the same shape in both.
 */
export async function registerPasskey(
  label: string,
): Promise<{ ok: true; value: { id: string } } | Refused> {
  if (typeof PublicKeyCredential === "undefined") {
    return { ok: false, message: t("api.passkey.unsupported"), fromNode: false };
  }

  const challenged = await act<{ publicKey: Record<string, unknown> }>(
    at("POST", "/api/auth/passkeys/challenge"), "POST", { purpose: "register" },
  );
  if (!challenged.ok) return challenged;
  const options = challenged.value.publicKey;

  let credential: PublicKeyCredential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        ...(options as unknown as PublicKeyCredentialCreationOptions),
        challenge: fromB64url(String(options.challenge)),
        user: {
          ...(options.user as { id: string; name: string; displayName: string }),
          id: new TextEncoder().encode(String((options.user as { id: string }).id)),
        },
        excludeCredentials: ((options.excludeCredentials ?? []) as Array<{ id: string; type: string }>)
          .map((entry) => ({ ...entry, id: fromB64url(entry.id) })) as PublicKeyCredentialDescriptor[],
      },
    }) as PublicKeyCredential | null;
  } catch {
    // A cancelled prompt is a decision, not a failure. Reported as one so the screen says nothing alarming.
    return { ok: false, message: t("api.passkey.none"), fromNode: false };
  }
  if (credential === null) return { ok: false, message: t("api.passkey.none"), fromNode: false };

  return await act<{ registered: { id: string } }>(
    at("POST", "/api/auth/passkeys"), "POST",
    { credential: serialiseCredential(credential), label },
  ).then((outcome) => outcome.ok
    ? { ok: true as const, value: { id: outcome.value.registered.id } }
    : outcome);
}

export const forgetPasskey = (credentialId: string) =>
  act<{ forgotten: true }>(at("DELETE", "/api/auth/passkeys"), "DELETE", { credentialId });

/**
 * Base64url to bytes, for the fields WebAuthn wants as buffers.
 *
 * **The return type is `Uint8Array<ArrayBuffer>` deliberately, not the bare `Uint8Array` it used to be.**
 * Bare `Uint8Array` means `Uint8Array<ArrayBufferLike>`, which admits `SharedArrayBuffer` and therefore is
 * not assignable to `BufferSource` — so `challenge:` and `excludeCredentials[].id` did not typecheck. The
 * value was always right; the annotation was wider than what the function actually returns, and widening a
 * return type is how a correct value becomes a type error at its call site.
 */
function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function toB64url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A `PublicKeyCredential` in the JSON form the routes accept. */
function serialiseCredential(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(response.clientDataJSON),
      attestationObject: toB64url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
  };
}

export const createButler = (name: string, source: string, sourceFormat: ButlerSourceFormat) =>
  act<{ butler: { butlerId: string } }>(
    at("POST", "/api/butlers"), "POST", { name, source, sourceFormat },
  );

export const saveButlerDraft = (id: string, source: string, sourceFormat: ButlerSourceFormat) =>
  act<{ butler: { versionId: string } }>(
    at("PUT", "/api/butlers/:butlerId/draft", { butlerId: id }), "PUT", { source, sourceFormat },
  );

export const publishButlerVersion = (id: string) =>
  act<{ published: { version: number } }>(
    at("POST", "/api/butlers/:butlerId/publish", { butlerId: id }), "POST",
  );

/** Takes the **pause** id, not the Butler's: one Butler can have been paused more than once over time. */
export const resumeButler = (pauseId: string, reason: string) =>
  act<{ resumed: unknown }>(
    at("POST", "/api/butler-pauses/:pauseId/resume", { pauseId }), "POST", { reason },
  );

/**
 * Runs a recorded run again (#53's `re-run`). **Not a simulation**: a new run of the same published version
 * over the same recorded input, whose writes are real and whose judgement is re-asked under today's policy,
 * approvals and pauses. What keeps it provider-free is the gate, not this call: a send a Butler proposes is
 * sealed `awaiting` with `butler_release_required`, so nothing leaves this Node until a person releases it
 * from the outbox. The Node's refusals (input not recorded, version gone, Butler paused) arrive verbatim.
 */
export const replayButlerRun = (runId: string) =>
  act<{ mode: "re-run"; runId: string; replayOf: string }>(
    at("POST", "/api/butler-runs/:runId/replay", { runId }), "POST", { mode: "re-run" },
  );

/**
 * Ends every session this person holds, on every device, including this one.
 *
 * The route answers 200 with the same `signedOutResponse` every expired-session path uses, so `ok` here means
 * the revocation happened; the caller then signs this page out through the session module so the timers stop.
 */
export const signOutEverywhere = () =>
  act<{ message: string }>(at("POST", "/api/auth/logout-everywhere"));

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
    queryFn: () => read<{ approvals: ApprovalRow[] }>(GET("/api/approvals")),
    ...AUTHORIZATION_SENSITIVE,
  });
}


export const decide = (id: string, decision: "approve" | "deny") =>
  act(at("POST", "/api/approvals/:approvalId/decide", { approvalId: id }), "POST", { decision });

export const withdrawDecision = (id: string) =>
  act(at("POST", "/api/approvals/:approvalId/withdraw", { approvalId: id }));

/* ------------------------------------------------------------------ Layer 4: policies (#81) -------- */

/**
 * One policy **version**, as the list returns it — the endpoint returns every version of every policy, so a
 * row is a version and the policy it belongs to is `policy_id` / `name`.
 *
 * The six conditions arrive as typed columns rather than a blob, which is #60's decision and matters here:
 * a screen can render exactly the six that exist, and a seventh cannot appear without the column that would
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
  when_reply_to_dmarc_fail: number | null;
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
  replyToDmarcFail?: boolean | null;
}

export function usePolicies(): UseQueryResult<{ policies: PolicyVersionRow[] }, Error> {
  return useQuery({
    queryKey: ["policies"],
    queryFn: () => read<{ policies: PolicyVersionRow[] }>(GET("/api/policies")),
    ...AUTHORIZATION_SENSITIVE,
  });
}


export const createPolicy = (
  name: string, outcome: string, conditions: PolicyConditions, stages: number[],
) => act<{ policy: { policyId: string } }>(at("POST", "/api/policies"), "POST", {
  name, outcome, conditions, stages,
});

export const savePolicyDraft = (
  id: string, outcome: string, conditions: PolicyConditions, stages: number[],
) => act<{ policy: { versionId: string } }>(
  at("PUT", "/api/policies/:policyId/draft", { policyId: id }), "PUT", { outcome, conditions, stages },
);

export const publishPolicyVersion = (id: string) =>
  act<{ published: { version: number } }>(
    at("POST", "/api/policies/:policyId/publish", { policyId: id }), "POST",
  );

/* ------------------------------------------------------------------ Layer 2/3: people (#39, #81) --- */

type GrantableRelation =
  | "mailbox.metadata.read" | "mailbox.content.read" | "send.propose" | "approval.decide"
  | "message.export" | "ediscovery.export" | "org.admin";

/**
 * The relations an administrator may grant, and what each one lets somebody do.
 *
 * Mirrors `GRANTABLE` in `src/access.ts` minus `supervised.read`, which is **not** granted this way: it is a
 * time-boxed grant needing two approvals and a matter (§7), and the Node refuses it here with a message
 * saying so. Listing it as an option would be offering a door that answers with a lecture.
 *
 * `what` is a getter over the catalog (`api.grant.<relation>`), so the words are read in the viewer's language
 * when a screen shows them and never held as data (ADR 46); a relation with no words there does not compile.
 */
export const GRANTABLE_RELATIONS = [
  grantable("mailbox.metadata.read", "mailbox"),
  grantable("mailbox.content.read", "mailbox"),
  grantable("send.propose", "mailbox"),
  grantable("approval.decide", "mailbox"),
  grantable("message.export", "mailbox"),
  grantable("ediscovery.export", "mailbox"),
  grantable("org.admin", "organization"),
] as const;

function grantable(relation: GrantableRelation, object: "mailbox" | "organization") {
  return { relation, object, get what(): string { return t(`api.grant.${relation}`); } };
}

export interface PersonRow {
  id: string;
  email: string;
  created_at: string;
  relations: Array<{ relation: string; objectType: string; objectId: string }>;
}

export function usePeople(): UseQueryResult<{ people: PersonRow[] }, Error> {
  return useQuery({
    queryKey: ["people"],
    queryFn: () => read<{ people: PersonRow[] }>(GET("/api/people")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export interface TeamRow { id: string; name: string; createdAt: string; memberCount: number }

export function useTeams(): UseQueryResult<{ teams: TeamRow[] }, Error> {
  return useQuery({
    queryKey: ["teams"],
    queryFn: () => read<{ teams: TeamRow[] }>(GET("/api/teams")),
    ...AUTHORIZATION_SENSITIVE,
  });
}


export const grant = (subjectId: string, relation: string, objectId: string) =>
  act(at("POST", "/api/access"), "POST", { subjectId, relation, objectId });

export const revokeAccess = (subjectId: string, relation: string, objectId: string) =>
  act(at("POST", "/api/access"), "DELETE", { subjectId, relation, objectId });

/** Renames a team. Administrator only, audited with both names, since a stage cites the id and a person reads the name. */
export async function renameTeam(teamId: string, name: string): Promise<{ ok: true } | Refused> {
  const response = await apiFetch(at("POST", "/api/teams/:teamId/rename", { teamId }), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  if (response.ok) return { ok: true };
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return refused(parsed?.message, response.status);
}

export async function createTeam(name: string): Promise<{ ok: true } | Refused> {
  const response = await apiFetch(at("POST", "/api/teams"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (response.ok) return { ok: true };
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return refused(parsed?.message, response.status);
}

export async function setTeamMember(
  teamId: string, userId: string, member: boolean,
): Promise<{ ok: true } | Refused> {
  const response = await apiFetch(at("POST", "/api/teams/:teamId/members", { teamId }), {
    method: member ? "POST" : "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (response.ok) return { ok: true };
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return refused(parsed?.message, response.status);
}

/** A team's roster. Per team rather than folded into the listing, which returns a count by design. */
export function useTeamMembers(teamId: string): UseQueryResult<{ members: string[] }, Error> {
  return useQuery({
    queryKey: ["team-members", teamId],
    queryFn: () => read<{ members: string[] }>(GET("/api/teams/:teamId/members", { teamId })),
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
    queryFn: () => read<{ breakers: BreakerReading[] }>(GET("/api/breakers")),
    // Faster than the authorization reads: this is a live instrument, and a stale one is misleading in the
    // one situation somebody opens it for.
    staleTime: 5_000,
    refetchInterval: 30_000,
  });
}

export function useDomainPauses(): UseQueryResult<{ pauses: DomainPauseRow[] }, Error> {
  return useQuery({
    queryKey: ["domain-pauses"],
    queryFn: () => read<{ pauses: DomainPauseRow[] }>(GET("/api/domain-pauses")),
    ...AUTHORIZATION_SENSITIVE,
  });
}


/** Asks for a domain to be stopped. Two **other** administrators have to agree before it takes effect. */
export const requestDomainPause = (domain: string, reason: string) =>
  act(at("POST", "/api/domain-pauses"), "POST", { domain, reason });

/** Restarts a domain's mail. One administrator, alone — the asymmetry is deliberate (#66). */
export const liftDomainPause = (id: string) =>
  act(at("POST", "/api/domain-pauses/:pauseId/lift", { pauseId: id }));

export interface SuppressionRow {
  address: string;
  cause: "hard_bounce" | "complaint";
  detail: string | null;
  observedAt: string;
  eventId: string;
}

/** Recipients this Node will not send to (0058). Administrators only; derived from the provider's events. */
export function useSuppressions(): UseQueryResult<{ suppressed: SuppressionRow[]; truncated: boolean }, Error> {
  return useQuery({
    queryKey: ["suppressions"],
    queryFn: () => read<{ suppressed: SuppressionRow[]; truncated: boolean }>(GET("/api/suppressions")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/** Vouches for a suppressed address, with a reason. One administrator, audited. */
export const liftSuppression = (address: string, reason: string) =>
  act(at("POST", "/api/suppressions/lift"), "POST", { address, reason });

/* ------------------------------------------------------------------ §7: matters and holds (#81) ---- */

/** `MATTER_TYPES` in `src/matters.ts`, which the Node refuses anything outside of. */
type MatterType = "legal_hold" | "security_incident" | "departure_handover" | "regulatory_request";

/** Each matter type and why one is opened; `what` is read from the catalog when shown, as `GRANTABLE_RELATIONS` does. */
export const MATTER_TYPES = [
  matter("legal_hold"), matter("security_incident"), matter("departure_handover"), matter("regulatory_request"),
] as const;

function matter(type: MatterType) {
  return { type, get what(): string { return t(`api.matter.${type}`); } };
}

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
    queryFn: () => read<{ matters: MatterRow[] }>(GET("/api/matters")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useHolds(): UseQueryResult<{ holds: HoldRow[] }, Error> {
  return useQuery({
    queryKey: ["holds"],
    queryFn: () => read<{ holds: HoldRow[] }>(GET("/api/holds")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useSupervised(): UseQueryResult<{ supervised: SupervisedGrantRow[] }, Error> {
  return useQuery({
    queryKey: ["supervised"],
    queryFn: () => read<{ supervised: SupervisedGrantRow[] }>(GET("/api/supervised")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/*
 * The export routes arrive **named** from the contract rather than spelled here, and the comment this
 * replaces is why: `matter-and-scope-world.test.ts` scans this file for the literal `/exports/`, guarding
 * the R2 key rather than an HTTP path — and it said, correctly, that the answer is to *stop needing the
 * exception rather than widen the guard*. #85 kept that: the one spelling moved into
 * `packages/contract/src/routes.ts`, which is the file whose job is to hold each route exactly once.
 */

export function useExports(): UseQueryResult<{ exports: ExportRow[] }, Error> {
  return useQuery({
    queryKey: ["exports"],
    queryFn: () => read<{ exports: ExportRow[] }>(routePath(EXPORTS_LIST)),
    ...AUTHORIZATION_SENSITIVE,
  });
}


export const openMatter = (type: string, description: string) =>
  act(at("POST", "/api/matters"), "POST", { type, description });

/** Closing a matter is what makes §7's notice to the people who were read about fall due. */
export const closeMatter = (id: string) =>
  act(at("POST", "/api/matters/:matterId/close", { matterId: id }));

export const placeHold = (mailboxId: string, matterId: string | null) =>
  act(at("POST", "/api/holds"), "POST", { mailboxId, matterId });

/** Asks for a hold to be lifted. Two other people have to agree; a hold is not lifted by one. */
export const askToLiftHold = (id: string, reason: string) =>
  act(at("POST", "/api/holds/:holdId/lift", { holdId: id }), "POST", { reason });

export const askToRead = (mailboxId: string, scope: string, durationSeconds: number, matterId: string | null) =>
  act(at("POST", "/api/supervised"), "POST", { mailboxId, scope, durationSeconds, matterId });

/** Asks for an export: a copy of a mailbox's mail, under a matter, bounded. Approved before it runs. */
export const requestExport = (input: { mailboxId: string; matterId: string; maxMessages: number; fromDate?: string; toDate?: string; subjectContains?: string }) =>
  act(at("POST", "/api/exports"), "POST", input);

export const runExport = (id: string) =>
  act(routePath(EXPORT_RUN, { exportId: id }));

/**
 * What a completed export staged, read off its own manifest.
 *
 * The listing carries no object names on purpose: the manifest is the sealed, hashed account of what left,
 * and a second list of the same names in the row would be a copy that can disagree with it. So the screen
 * reads the manifest through the object route — the same grant check every download passes — and links each
 * `object` it names. Only the requester may read it; anybody else is answered 404 by §5C.
 */
export interface ExportManifest {
  count: number;
  messages: Array<{ receiptId: string; object: string; bytes: number; sha256: string }>;
}

/** Where one staged object is fetched from; the route answers the bytes, not JSON. */
export const exportObjectHref = (exportId: string, objectId: string) =>
  GET("/api/exports/:exportId/objects/:objectId", { exportId, objectId });

export const readExportManifest = (exportId: string) =>
  read<ExportManifest>(exportObjectHref(exportId, "manifest.json"));

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
    queryFn: () => read<{ invitations: InvitationRow[] }>(GET("/api/invitations")),
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
/** Withdraws an outstanding invitation: the link dies. Administrator only, audited. */
export const revokeInvitation = (id: string) =>
  act(at("DELETE", "/api/invitations/:invitationId", { invitationId: id }), "DELETE");

export async function invite(
  email: string,
): Promise<{ ok: true; secret: string; email: string; expiresAt: string } | Refused> {
  const response = await apiFetch(at("POST", "/api/invitations"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    const minted = parsed?.invitation as { secret: string; email: string; expiresAt: string };
    return { ok: true, ...minted };
  }
  return refused(parsed?.message ?? parsed?.error, response.status);
}

/** One capability an agent may be granted, as this Node's own vocabulary describes it. */
export interface CapabilityRow {
  id: string;
  says: string;
  /** Whether exercising it reaches the **content** of mail rather than only its metadata. */
  reachesContent: boolean;
  /**
   * The mailbox relations this capability's routes check.
   *
   * Published so the mint form does not carry its own copy: a hand-written list of "which capabilities need a
   * mailbox" is a second correspondence table, and it drifted from the vocabulary the moment it existed.
   */
  requires: string[];
  routes: string[];
}

export interface AgentRow {
  id: string;
  name: string;
  sponsorUserId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** The pinned ceiling as it is enforced: route strings. */
  actions: string[];
  /**
   * The same ceiling in capability terms, with `held` against `total`.
   *
   * Held-of-total rather than a name, because a stored capability resolved later would silently widen every
   * agent that held it the day somebody added a route — so the routes are what is pinned, and an agent minted
   * before a capability grew genuinely holds part of it. `4 of 5` is the truth; `mail.read` would imply a
   * fifth route the agent does not have and, the ceiling being pinned, never will.
   */
  held: { id: string; says: string; reachesContent: boolean; held: number; total: number }[];
  /** Pinned routes belonging to no current capability — a rename, normally empty. Shown, never dropped. */
  unnamed: string[];
  /**
   * Which mailboxes this agent may reach, and whether each relation is live **right now**.
   *
   * Two facts rather than one: a sponsor who loses a relation silently narrows every agent that borrowed it,
   * so a review reading only what was granted gets an answer that was true on the day of the mint.
   */
  grants: { mailboxId: string; mailboxName: string | null; relation: string; effective: boolean }[];
}

export function useAgentCapabilities(): UseQueryResult<{ capabilities: CapabilityRow[] }, Error> {
  return useQuery({
    queryKey: ["agent-capabilities"],
    queryFn: () => read<{ capabilities: CapabilityRow[] }>(GET("/api/agent-capabilities")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useAgents(): UseQueryResult<{ agents: AgentRow[] }, Error> {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => read<{ agents: AgentRow[] }>(GET("/api/agents")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/**
 * Mints an agent and returns the token **once**.
 *
 * Only its hash is stored and there is no refresh, so a caller that discards this value has to re-mint. The
 * screen therefore shows it immediately with the sentence that it will not be shown again — the same shape as
 * `invite`, and for the same reason.
 */
/** A mailbox relation an agent may be granted at mint. Matches the contract's enum. */
export type AgentRelation =
  "mailbox.metadata.read" | "mailbox.content.read" | "send.propose" | "message.export";

/**
 * What each relation lets an agent do, in the words somebody choosing needs rather than the tuple's name.
 * `says` is read from the catalog (`api.agent.<relation>`) when shown, as `GRANTABLE_RELATIONS` does.
 */
export const AGENT_RELATIONS = [
  agentRelation("mailbox.metadata.read", false),
  agentRelation("mailbox.content.read", true),
  agentRelation("send.propose", false),
  agentRelation("message.export", true),
] as const;

function agentRelation(relation: AgentRelation, reachesContent: boolean) {
  return { relation, reachesContent, get says(): string { return t(`api.agent.${relation}`); } };
}

export async function mintAgent(input: {
  name: string;
  sponsorUserId: string;
  capabilities: string[];
  grants: { mailboxId: string; relation: AgentRelation }[];
  lifetimeDays?: number;
}): Promise<{ ok: true; token: string; agent: AgentRow; notice: string } | Refused> {
  const response = await apiFetch(at("POST", "/api/agents"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    return {
      ok: true,
      token: String(parsed?.token),
      agent: parsed?.agent as AgentRow,
      notice: String(parsed?.notice ?? ""),
    };
  }
  return refused(parsed?.message ?? parsed?.error, response.status);
}

export async function revokeAgent(agentId: string): Promise<{ ok: boolean } & Said> {
  const response = await apiFetch(at("DELETE", "/api/agents/:agentId", { agentId }), { method: "DELETE" });
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return {
    ok: response.ok,
    ...saidBy(parsed?.message ?? parsed?.error, response.ok ? t("api.revoked") : t("api.answered.short", { status: String(response.status) })),
  };
}

/** One mailbox on the mint surface, with what the named sponsor holds on it. */
export interface SponsorMailbox {
  mailboxId: string;
  mailboxName: string;
  /** Empty when the sponsor holds nothing here — the mailbox is still listed, and is not selectable. */
  relations: string[];
}

/**
 * Every mailbox, with what one person holds on each.
 *
 * The mint form's catalogue. It used `useMailboxes()`, which is the **work queue** — mailboxes the *caller*
 * sends from — so a read-only sponsor's mailboxes were unselectable and an administrator could not provision
 * an agent for a mailbox they administer without working in.
 */
export function useSponsorMailboxes(userId: string | null): UseQueryResult<
  { mailboxes: SponsorMailbox[] }, Error
> {
  return useQuery({
    queryKey: ["sponsor-mailboxes", userId],
    enabled: userId !== null,
    queryFn: () => read<{ mailboxes: SponsorMailbox[] }>(
      GET("/api/people/:userId/mailboxes", { userId: userId! }),
    ),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/* ------------------------------------------------ the Node's own Cloudflare grant (ADR 42, #162) ---- */

/**
 * Nineteen routes existed for this and no screen did.
 *
 * Every one of them was reachable only by `mailda provider …` — which is to say, by somebody who can open a
 * terminal, install a CLI and hold an API token. The person these routes exist *for* is the operator who owns
 * the Cloudflare account, and asking them to do that is asking them to be a different person.
 *
 * So this is the read and write layer for a screen. It adds no endpoint: `/setup` sends exactly what
 * `mailda provider connect`, `… receiving` and `… sending` send, and gets the same refusals back in the same
 * words. That is the parity ADR 12 asks for, and the CLI stays the surface for anyone who prefers it.
 */

export type ProviderState = "no_token" | "token_held";

/**
 * The credential this Node holds toward Cloudflare (26 September 2026): one API token, or none. The token
 * itself never comes back; what does is which account it was verified against and when.
 */
export interface ProviderBinding {
  state: ProviderState;
  accountId: string | null;
  accountName: string | null;
  registeredAt: string | null;
  verifiedAt: string | null;
}

/** One permission to tick on Cloudflare's token form, and what this Node does with it. */
export interface Permission {
  name: string;
  scope: "account" | "zone";
  why: string;
  optional: boolean;
}

/**
 * One provisioning act as the audit trail recorded it (25 September 2026): the domain, when, and which
 * credential acted. "operator" is the installer with wrangler's login. A dated record of an act, not a
 * live read, and every surface that shows it says so.
 */
export interface ProvisionedAct {
  domain: string;
  at: string;
  authority: "token" | "grant" | "operator" | "unknown";
  address: string | null;
  /** A sighting, not an act: Cloudflare had it in place before this Node asked, and the entry says so. */
  observed: boolean;
  /** Receiving only: how its address was routed when the act ended; null before 28 September 2026 and for the others. */
  routing: AddressRouting | null;
}
export interface Provisioned {
  receiving: ProvisionedAct | null;
  sending: ProvisionedAct | null;
  deliveryEvents: ProvisionedAct | null;
}

export interface ProviderRead {
  provider: ProviderBinding;
  provisioned: Provisioned;
  permissions: Permission[];
  /** What in the permission list this repository has not measured. Required by the contract, shown as is. */
  note: string;
}

export function useProvider(): UseQueryResult<ProviderRead, Error> {
  return useQuery({
    queryKey: ["provider"],
    queryFn: () => read<ProviderRead>(GET("/api/provider")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

export interface RoutingRow {
  domain: string;
  /** Usually not the domain. A Node routing `inbox@mail.example.com` is configured on `example.com`. */
  zone: string | null;
  zoneId: string | null;
  enabled: boolean | null;
  status: string | null;
  required: Array<{ type: string; name: string; content: string; priority: number | null }>;
  /**
   * Why this domain could not be answered for.
   *
   * A zone needing no records and a record list that could not be read are both an empty `required`, and
   * this is the only thing that tells them apart — so the screen renders it rather than an empty row.
   */
  error: string | null;
}

/**
 * Whether a delivery outcome would ever be seen, per domain this Node sends from (`GET /api/provider/
 * delivery-events`). Four objects per row, each nullable so absence names which one is missing; the contract
 * is `providerDeliveryEventsResponse`.
 */
export interface DeliveryRow {
  domain: string;
  zone: string | null;
  sending: {
    name: string;
    enabled: boolean | null;
    returnPath: string | null;
    dkimSelector: string | null;
    required: Array<{ type: string; name: string; content: string; priority: number | null }>;
    error: string | null;
  } | null;
  subscription: string | null;
  subscriptionId: string | null;
  enabled: boolean | null;
  events: string[];
  queueId: string | null;
  queueName: string | null;
  consumers: string[];
  error: string | null;
}

/** Spends the grant, like `useRouting`: read on the Setup screen and nowhere that is merely glanced at. */
export function useDeliveryEvents(enabled = true): UseQueryResult<{ delivery: DeliveryRow[] }, Error> {
  return useQuery({
    queryKey: ["provider-delivery-events"],
    queryFn: () => read<{ delivery: DeliveryRow[] }>(GET("/api/provider/delivery-events")),
    enabled,
    ...AUTHORIZATION_SENSITIVE,
  });
}

export function useRouting(): UseQueryResult<{ routing: RoutingRow[] }, Error> {
  return useQuery({
    queryKey: ["provider-routing"],
    queryFn: () => read<{ routing: RoutingRow[] }>(GET("/api/provider/email-routing")),
    ...AUTHORIZATION_SENSITIVE,
  });
}

/**
 * What this Node would do to make a subdomain receive mail, before it does any of it.
 *
 * `digest` is the whole point: confirming carries it back, and the Node refuses unless the proposal it would
 * act on *now* hashes to the same thing. A screen that showed a plan and then posted a bare "yes" would let
 * an hour-old plan apply to a zone somebody has since changed.
 */
export interface ReceivingProposal {
  domain: string;
  zone: string | null;
  zoneId: string | null;
  zoneRouting: string | null;
  /**
   * The zone this would also turn into a mail zone, or null when it already is one.
   *
   * The larger half, and separate for that reason: enabling Email Routing writes MX and SPF at the **apex**,
   * which decides where the whole domain's mail goes rather than one subdomain's. When it is set, `creates`
   * is empty — a zone that is not routing lists no MX yet — and the screen must not read that as "nothing
   * will change".
   */
  enablesZone: string | null;
  creates: Array<{ type: string; name: string; content: string; priority: number | null }>;
  present: string[];
  rule: string | null;
  digest: string;
  refusal: string | null;
  /** Whether the domain is the zone's apex. Cloudflare's catch-all exists for apex zones only. */
  apex: boolean;
  /** The zone's current catch-all rule, when apex; null otherwise. Shown so a take-over names what it replaces. */
  catchAll: CatchAllRule | null;
  /**
   * Every address on `domain` with a routing rule of its own, and where it goes. A literal rule outranks the
   * catch-all, so a take-over does not reach these. `error` when the rules could not be read: the list is then
   * unknown, never empty.
   */
  ownRules: {
    addresses: Array<{ address: string; state: "rule_written" | "routed_elsewhere" | "rule_disabled"; where: string }>;
    error: string | null;
  };
}

export interface CatchAllRule { action: string; destinations: string[]; enabled: boolean }

export interface ReceivingOutcome {
  domain: string;
  written: string[];
  /** Read back from Cloudflare. A write that answered 200 is not yet a record in DNS. */
  confirmed: string[];
  /**
   * What the act wrote or kept: "catch-all" when it took the zone's catch-all over, the literal rule's name when
   * one routing the address here was written or kept, null when neither.
   */
  rule: string | null;
  /** Whether the address itself reaches this Node: a rule of its own outranks the catch-all. */
  routing: AddressRouting;
  note: string | null;
  /** What the catch-all was and is now, when it was taken over; null otherwise. */
  catchAll: { before: CatchAllRule; after: CatchAllRule } | null;
}

export interface SendingProposal {
  domain: string;
  zone: string | null;
  zoneId: string | null;
  onboarded: boolean;
  /** An apex already onboarded that covers this name. Not the same as this name being done. */
  coveredBy: string | null;
  creates: string[];
  leavesBehind: string[];
  digest: string;
  error: string | null;
}


/** Stores one API token, verified against Cloudflare first; `accountId` only when the token sees several. */
export const registerProviderToken = (token: string, accountId?: string) =>
  act<{ provider: ProviderBinding }>(at("PUT", "/api/provider/token"), "PUT", {
    token, ...(accountId === undefined ? {} : { accountId }),
  });

/** Forgets the held token here. The token itself stays valid in Cloudflare until revoked there. */
export const forgetProviderToken = () =>
  act<{ provider: ProviderBinding }>(at("DELETE", "/api/provider/token"), "DELETE");

async function proposalFor<T>(
  path: string,
  domain: string,
): Promise<{ ok: true; value: T } | Refused> {
  try {
    return { ok: true, value: await read<T>(`${path}?domain=${encodeURIComponent(domain)}`) };
  } catch (failure) {
    // A read that never reached the Node (the browser's "Failed to fetch") is not the Node's English.
    return { ok: false, message: failure instanceof Error ? failure.message : String(failure), fromNode: failure instanceof ReadFailure && failure.fromNode };
  }
}

export const receivingProposal = (domain: string) =>
  proposalFor<{ proposal: ReceivingProposal }>(GET("/api/provider/receiving"), domain);

/** `catchAll` is sent only when asked for: the Node refuses it off an apex, and an absent key is the plain rule. */
export const onboardReceiving = (domain: string, digest: string, address: string, mailboxId?: string, catchAll?: boolean) =>
  act<{ outcome: ReceivingOutcome }>(at("POST", "/api/provider/receiving"), "POST", {
    domain, digest, address, ...(mailboxId === undefined ? {} : { mailboxId }), ...(catchAll ? { catchAll: true } : {}),
  });

/** A routing rule already on a zone (#258). `digest` is what a take-over quotes. */
export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  to: string;
  action: string;
  destinations: string[];
  catchAll: boolean;
  ours: boolean;
  digest: string;
  /** What the Node would do with the rule if asked; null with `refusal` when the act would refuse. */
  offer: "take_over" | "put_back" | null;
  refusal: { code: string; what: string; why: string; fix: string } | null;
}

export interface RoutingRules {
  domain: string;
  zone: string | null;
  zoneId: string | null;
  rules: RoutingRule[];
  error: string | null;
}

export interface RoutingRuleOutcome {
  ruleId: string;
  to: string;
  before: { action: string; destinations: string[] };
  after: { action: string; destinations: string[] };
  /** The mailbox a take-over's address files into; null on a put-back. */
  mailbox: { id: string; name: string } | null;
}

export const routingRulesOn = (domain: string) =>
  proposalFor<{ routing: RoutingRules }>(GET("/api/provider/routing-rules"), domain);

export const takeOverRule = (domain: string, ruleId: string, digest: string, mailboxId?: string) =>
  act<{ outcome: RoutingRuleOutcome }>(at("POST", "/api/provider/routing-rules/take-over"), "POST", {
    domain, ruleId, digest, ...(mailboxId === undefined ? {} : { mailboxId }),
  });

export const putBackRule = (domain: string, ruleId: string) =>
  act<{ outcome: RoutingRuleOutcome }>(at("POST", "/api/provider/routing-rules/put-back"), "POST", {
    domain, ruleId,
  });

export const sendingProposal = (domain: string) =>
  proposalFor<{ proposal: SendingProposal }>(GET("/api/provider/sending"), domain);

export const onboardSending = (domain: string, digest: string) =>
  act<{ proposal: SendingProposal }>(at("POST", "/api/provider/sending"), "POST", { domain, digest });

/** The subscription that makes a sending domain's delivery outcomes reach this Node (#222). */
export interface SubscriptionProposal {
  domain: string;
  zone: string | null;
  zoneId: string | null;
  /** The onboarded sending domain that would carry it: the name itself, or the apex covering it. */
  sendingDomain: string | null;
  /** A subscription already covering this domain, by name. */
  subscribed: string | null;
  queueId: string | null;
  queueName: string | null;
  /** Whether this Worker already consumes the queue; the confirm attaches it when not. */
  consumerAttached: boolean | null;
  events: string[];
  digest: string;
  error: string | null;
}

export const subscriptionProposal = (domain: string) =>
  proposalFor<{ proposal: SubscriptionProposal }>(GET("/api/provider/subscription"), domain);

export const subscribeDeliveryEvents = (domain: string, digest: string) =>
  act<{ proposal: SubscriptionProposal }>(at("POST", "/api/provider/subscription"), "POST", { domain, digest });

/**
 * What the latest read of the account's verified destinations found, typed from the contract's schema rather
 * than restated. Counts only, never an address. `readAt` null with `error` set means could not read, not none
 * verified.
 */
export type VerifiedDestinationsState = ProviderVerifiedDestinations;

/** Reads the account's list with this Node's token and records which of its recipients are on it. */
export const recordVerifiedDestinations = () =>
  act<{ destinations: VerifiedDestinationsState }>(at("POST", "/api/provider/verified-destinations"), "POST");
