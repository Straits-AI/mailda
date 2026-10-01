import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { BUDGETS } from "@mailda/budgets";

import { t } from "/app/locale.js";
import type { AppRoute } from "../../../app-routes.ts";
import { Nothing } from "../chrome.tsx";
import {
  type MessageRow, type Place, claimCase, labelsOf, patchReadInCache, releaseCase, setPlace, setRead, stealCase,
  useMailboxes, useMessages, useReadableMailboxes,
} from "../api.ts";
import { type PaletteCommand, useCompose, usePendingSearch, useRegisterCommands, useToast } from "../shell-context.tsx";
import * as format from "../format.ts";
import { Icon } from "../ui/icons.tsx";
import { Popover } from "../ui/popover.tsx";
import { shortcutsEnabled, useShortcuts } from "../ui/shortcuts.ts";
import { marked, sentence } from "../words.tsx";
import { type ComposerContext, forwardSubject, quoteLine, replySubject } from "./composer.tsx";
import { NextSteps, deterministicNextSteps } from "./next-steps.tsx";
import { ReadingPane, Thread, bodyQuery, subjectOf, type RenderedBody } from "./reader.tsx";

/**
 * The mail view: the list pane and the reading column, for the Inbox, Archive and Trash alike.
 *
 * `reader.tsx` renders one message. This file owns everything that spans messages — which page of which
 * listing is on screen, which row is selected, the claim that must come before a reply, moving a message
 * between places, and the keys that do all of those. The three places are one component with a `place` prop
 * because they are one listing with one filter (`place`, 0067): a second list component would be a second
 * copy of the #91 paging rules to keep honest.
 *
 * ## Every request here is governance, not only cost
 *
 * Each listing a supervised reader fetches writes one `supervised.query` audit entry, and each body fetch is a
 * recorded open (§7). So: one request per page, per tab switch, per applied filter and per submitted search;
 * nothing is prefetched — not the next page, not another tab, not the body of the row J would open next; and
 * opening a message patches the cached rows' read state rather than refetching the list. Opening a message that
 * belongs to a conversation also lists that conversation, once while it is fresh, for the thread under the
 * reader (`Thread`): one more listing, and one more `supervised.query`, per conversation opened. The default view's
 * query key is `messagesKey({ place: "inbox" })` exactly, which is the sidebar's count, so the two are one
 * request (`inbox-pages.test.tsx` holds this half; the sidebar's test the other).
 */

/**
 * A place's name is its route's (`route.*`, which the glossary binds), so the heading, the row's chip, the
 * single-pane Back and the navigation cannot call one place two things.
 */
const PLACE_ROUTE = { inbox: "/", archive: "/archive", trash: "/trash" } as const satisfies Record<Place, AppRoute>;
const placeName = (place: Place) => t(`route.${PLACE_ROUTE[place]}`);

/**
 * What a full page looks like, so "capped" can be distinguished from "that is all there was".
 *
 * From `BUDGETS` rather than written here: `messages.page_size` is a measured tripwire
 * (`docs/receipts/message-page-size.md`) and a client with its own copy would tell the reader a page was
 * capped at a number the Node had stopped using. The lookback's bound is not read here at all: the empty
 * state that names it takes the figure the answering Node sent (`max_lookback`), so a Node running another
 * budget is described by its own number.
 */
const PAGE_FULL = BUDGETS["messages.page_size"];

type Tab = "all" | "unread" | "mine";

/** The server-side filters of the memo's Filter control; each one is a `MESSAGE_PAGE_PARAMS` name. */
interface Filters { mailbox: string | null; from: string | null; since: string | null; until: string | null }
const NO_FILTERS: Filters = { mailbox: null, from: null, since: null, until: null };
const activeFilters = (filters: Filters) => Object.values(filters).filter((one) => one !== null).length;

/**
 * The one control the inbox needed, and deliberately not a redesign of it (#91).
 *
 * **A cursor stack, one page at a time**, rather than an infinite list that appends. Three reasons, in the
 * order they decided it:
 *
 * 1. Every page re-runs the whole authorization server-side, so an appending list of ten pages refetches ten
 *    pages on every window focus — ten authorizations, and for a supervised reader ten more `supervised.query`
 *    entries recording mail they are not currently looking at. One page is one request.
 * 2. Going back needs no reverse query. The stack holds the cursors already used, so *newer* is a `pop`.
 * 3. It is honest about what the Node answered. An appended list reads as *"this is the mail"*; a page reads
 *    as *"this is a page of the mail"*, which is the true claim — `next_cursor` says whether more is visible
 *    and nothing here knows a total, because nothing counted one.
 *
 * The stack is component state and is meant to be: it is a scroll position, not a fact about the mailbox, and
 * a reload landing on the newest page is the right behaviour rather than a lost one.
 *
 * **Every narrowing resets the position**, and that is a correctness requirement rather than a courtesy. A
 * cursor is a position in one ordering; change the tab, a filter, the label or the search and it is a position
 * in a different listing — the row it names may not be in it at all, so the page it produces is somewhere
 * arbitrary, or nowhere. The Node cannot catch this: the cursor is well-formed and the authorization re-runs,
 * so it answers correctly a question nobody asked.
 */
function usePages() {
  /** The cursors used to reach the current page. Empty means the newest one. */
  const [stack, setStack] = useState<string[]>([]);
  /** What has been searched for, or null for the unsearched listing (#107). */
  const [term, setTerm] = useState<string | null>(null);
  /** The label the listing is narrowed to (0061), or null for any. */
  const [label, setLabel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  return {
    cursor: stack[stack.length - 1] ?? null,
    term,
    label,
    tab,
    filters,
    /** 1-based, for the reader. Never presented as "of N": nothing here knows N and nothing counted it. */
    number: stack.length + 1,
    older: (next: string) => setStack((was) => [...was, next]),
    newer: () => setStack((was) => was.slice(0, -1)),
    newest: () => setStack([]),
    labelled: (next: string | null) => { setLabel(next); setStack([]); },
    searchFor: (next: string | null) => { setTerm(next); setStack([]); },
    show: (next: Tab) => { setTab(next); setStack([]); },
    filter: (next: Filters) => { setFilters(next); setStack([]); },
  };
}

/** Below 768px one pane shows at a time, and the reader carries a way back to the list. */
const SINGLE_PANE = "(max-width: 767.98px)";
function onSinglePaneChange(notify: () => void) {
  const query = matchMedia(SINGLE_PANE);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}
function useSinglePane(): boolean {
  return useSyncExternalStore(onSinglePaneChange, () => matchMedia(SINGLE_PANE).matches, () => false);
}

/**
 * The reply context. `Re:` is not doubled, and the quote line names when *this Node accepted* the message
 * rather than when the sender says they wrote it — a sender-supplied Date can be unreadable or absent, and
 * `accepted_at` is the one timestamp the Node observed itself.
 */
function replyContext(
  message: MessageRow, caseId: string,
  rendered: RenderedBody, all: boolean, ownAddresses: readonly string[],
): ComposerContext {
  const subject = message.subject ?? "";
  /*
   * Quoted from the body the pane already fetched — the same cache entry, so a reply costs no second read.
   * The plain text when there is one; the HTML's text otherwise, tags dropped, which is a rough quote and
   * says so by being one. A body with neither (one the Node could not parse) leaves an ellipsis.
   */
  const text = rendered.text
    ?? (rendered.html === null ? null
      : rendered.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  const quoted = text === null ? "> …" : text.trim().split("\n").slice(0, 200).map((line) => `> ${line}`).join("\n");
  /*
   * Who a reply goes to: Reply-To if the sender set one, else the From header, else the envelope sender.
   * The envelope sender was the only choice before, and on mail relayed through a bounce-handling path it is
   * `bounces@cf-bounce.…` — the return path, which is where bounces go, not where people are (seen on the
   * live Node, 17 September). The `From:` header is content the sender chose, which for a reply is right.
   *
   * Reply-all: the sender (or their Reply-To) in To, everybody else the sender addressed in Cc, minus this
   * mailbox's own addresses — a copy to ourselves is the loop `send-breakers.md` exists for. The seal
   * refuses a duplicate across To and Cc, so the sender is removed from Cc here.
   */
  const sender = rendered.recipients.replyTo ?? message.from_addr ?? message.envelope_from;
  const mine = new Set(ownAddresses.map((one) => one.toLowerCase()));
  const others = all
    ? [...rendered.recipients.to, ...rendered.recipients.cc]
      .filter((one, index, list) => list.indexOf(one) === index && !mine.has(one) && one !== sender.toLowerCase())
    : [];
  return {
    mailboxId: message.mailbox_id,
    // ADR 36 threads on the message's own id. Absent when the sender sent none, in which case this is a
    // new message that happens to be addressed back — which is the truth, so it is not faked.
    inReplyToMessageId: message.message_id ?? undefined,
    // The case `reply()` just claimed, so the composer claims it again at the seal (#42).
    caseId,
    to: sender,
    cc: others.join(", "),
    subject: replySubject(subject),
    originalSubject: subjectOf(message),
    body: `\n\n${quoteLine(message.accepted_at, message.from_addr ?? message.envelope_from)}\n${quoted}`,
  };
}

/**
 * The search field (#107).
 *
 * ## A form, submitted — not search-as-you-type
 *
 * Every keystroke reaching the Node would be one authorization and, for a supervised reader, one
 * `supervised.query` audit entry **per keystroke** — recording mail they never looked at, against
 * `audit.max_detail_bytes`, on the hot read path. §7 records acts and typing is not an act. So it submits,
 * and a form gets the Enter key, a labelled control and a real submit button for nothing.
 *
 * The submit button carries the magnifier as its face, not a picture beside the field: a glyph inside a
 * field that submits on Enter loses the button, so a keyboard has nothing to land on and a screen reader is
 * told there is no way to run the search. Its name is "Search", not "Search mail" — two controls in one form
 * sharing an accessible name cannot be told apart by ear. What a search covers (senders, subjects and text,
 * in every place) is said on the status line once there are results, where the reader is looking.
 *
 * ## The term is not interpreted here
 *
 * No trimming, no tokenizing, no "did you mean". The Node's `ftsQuery` decides what a search means, and a
 * client with its own opinion is how the shell and the SDK end up disagreeing about the same words.
 */
function SearchField({ term, onSearch }: { term: string | null; onSearch: (next: string | null) => void }) {
  // `term` is what has been *asked*; `draft` is what is being typed. Keeping them apart is what makes this a
  // form rather than a subscription to the keyboard.
  const [draft, setDraft] = useState(term ?? "");
  return (
    <form
      className="inbox-search"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(draft.trim() === "" ? null : draft);
      }}
    >
      <label htmlFor="inbox-q" className="visually-hidden">{t("inbox.search.label")}</label>
      <span className="search-pill">
        <input id="inbox-q" type="search" value={draft} placeholder={t("inbox.search.label")} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" className="search-go" aria-label={t("inbox.search.submit")}><Icon name="search" /></button>
      </span>
    </form>
  );
}

/** A date field's `YYYY-MM-DD` as "26 Sep" / "9月26日": the day as written, which is the UTC day the API reads it as. */
function day(value: string): string {
  const [year, month, date] = value.split("-").map(Number);
  return format.monthDay(new Date(year!, month! - 1, date));
}

/**
 * The memo's `[filter]`: mailbox, sender address and a received range, all applied by the Node on every plan.
 *
 * Applied, not live: "Apply" is one request, never one per keystroke, for the search field's reason. The dates
 * are named "on or after" and "on or before" because that is what the API does with a date — `since` is the
 * start of that UTC day and `until` its **end**, so `until=2026-09-01` includes 1 September
 * (`packages/contract/src/routes.ts`); "before" would have been a word the listing contradicts.
 *
 * The mailbox choice lists what this reader may **read** (`GET /api/mailboxes/readable`), not where they have
 * work: a supervised reader holds no `send.propose`, and their mailbox would otherwise be missing from the one
 * control that narrows to it. It defaults to every mailbox, unlike the compose chooser's "never inferred"
 * (#94): "all" is a true description of an unfiltered list, not a decision made on anybody's behalf.
 */
function FilterForm({ filters, mailboxes, onApply }: {
  filters: Filters;
  mailboxes: ReadonlyArray<{ id: string; name: string }>;
  onApply: (next: Filters) => void;
}) {
  const [mailbox, setMailbox] = useState(filters.mailbox ?? "");
  const [from, setFrom] = useState(filters.from ?? "");
  const [since, setSince] = useState(filters.since ?? "");
  const [until, setUntil] = useState(filters.until ?? "");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onApply({
          mailbox: mailbox === "" ? null : mailbox,
          from: from.trim() === "" ? null : from.trim(),
          since: since === "" ? null : since,
          until: until === "" ? null : until,
        });
      }}
    >
      {mailboxes.length < 2 ? null : (
        <>
          <label htmlFor="inbox-mailbox">{t("inbox.filter.mailbox")}</label>
          <select id="inbox-mailbox" value={mailbox} onChange={(event) => setMailbox(event.target.value)}>
            <option value="">{t("inbox.filter.allMailboxes")}</option>
            {mailboxes.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select>
        </>
      )}
      <label htmlFor="inbox-from">{t("inbox.filter.sender")}</label>
      <input id="inbox-from" type="email" value={from} onChange={(event) => setFrom(event.target.value)} aria-describedby="inbox-from-hint" />
      <p id="inbox-from-hint" className="hint">{t("inbox.filter.senderHint")}</p>
      <label htmlFor="inbox-since">{t("inbox.filter.since")}</label>
      <input id="inbox-since" type="date" value={since} onChange={(event) => setSince(event.target.value)} />
      <label htmlFor="inbox-until">{t("inbox.filter.until")}</label>
      <input id="inbox-until" type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
      <p className="row-actions">
        <button type="submit" className="primary">{t("inbox.filter.apply")}</button>{" "}
        <button type="button" className="btn" onClick={() => onApply(NO_FILTERS)}>{t("inbox.filter.clear")}</button>
      </p>
    </form>
  );
}

function FilterControl({ filters, mailboxes, onApply }: {
  filters: Filters;
  mailboxes: ReadonlyArray<{ id: string; name: string }>;
  onApply: (next: Filters) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const count = activeFilters(filters);
  return (
    <span className="popover-wrap">
      <button
        ref={anchor}
        type="button"
        className="btn btn-icon filter-button"
        // The count is part of the name: a number drawn on an icon is otherwise silent.
        aria-label={count === 0 ? t("inbox.filter.label") : t("inbox.filter.active", { n: count })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="filter" />
        {count === 0 ? null : <span className="filter-count">{count}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label={t("inbox.filter.label")} className="filter-popover popover-down popover-end" anchor={anchor}>
        <FilterForm
          filters={filters}
          mailboxes={mailboxes}
          onApply={(next) => {
            setOpen(false);
            onApply(next);
          }}
        />
      </Popover>
    </span>
  );
}

/** Each tab's name is `inbox.tab.<tab>`. "Mine" is the same word as the API's `mine` and the row chip: the case is held by you. */
const TABS: readonly Tab[] = ["all", "unread", "mine"];

/**
 * All, Unread and Mine: three server-side listings (`unread=1`, `mine=1`), never a filter over the rows of
 * another one, which would show a page of 50 as "the unread mail". No "Waiting" tab: nothing in today's
 * state defines it honestly and cheaply (ADR 45). Arrow keys move between tabs and Enter or Space opens one:
 * each opening is a listing request, so a key held down to look along the row does not issue three.
 */
function Tabs({ tab, onShow }: { tab: Tab; onShow: (next: Tab) => void }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="list-tabs" role="tablist" aria-label={t("inbox.tabs")}>
      {TABS.map((one, index) => (
        <button
          key={one}
          ref={(element) => { buttons.current[index] = element; }}
          id={`inbox-tab-${one}`}
          type="button"
          role="tab"
          className="list-tab"
          aria-selected={tab === one}
          aria-controls="inbox-panel"
          tabIndex={tab === one ? 0 : -1}
          title={one === "mine" ? t("inbox.tab.mineTitle") : undefined}
          onClick={() => onShow(one)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            buttons.current[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]?.focus();
          }}
        >
          {t(`inbox.tab.${one}`)}
        </button>
      ))}
    </div>
  );
}

/**
 * One row: who, when, what, a line of it, and the chips a person triages by. `stop` is whether it is the list's
 * one Tab stop (see the list below).
 */
function Row({ row, place, selected, stop, onSelect, onFocus }: {
  row: MessageRow;
  place: Place;
  selected: boolean;
  stop: boolean;
  onSelect: () => void;
  onFocus: () => void;
}) {
  const address = row.from_addr ?? row.envelope_from;
  const unread = row.read === 0;
  return (
    <li>
      <button
        type="button"
        data-id={row.id}
        className={`message-row${selected ? " current" : ""}${unread ? " unread" : ""}`}
        aria-current={selected ? "true" : undefined}
        tabIndex={stop ? 0 : -1}
        onClick={onSelect}
        onFocus={onFocus}
      >
        {unread ? <><span className="unread-dot" aria-hidden="true" /><span className="visually-hidden">{t("inbox.row.unread")}</span></> : null}
        {/* The name the sender chose, with the address one hover away; the reader shows both. */}
        <span className="row-sender" title={address}>{row.from_name ?? address}</span>
        {/* When this Node received it: `accepted_at`, the one time it observed itself. */}
        <time className="row-time" dateTime={row.accepted_at} title={format.fullTime(row.accepted_at)}>{format.shortTime(row.accepted_at)}</time>
        {/* An unmaterialised receipt (R1) has no subject and stays listed: accepted-but-absent is the worst failure. */}
        <span className="row-subject">{subjectOf(row)}</span>
        {row.preview === null ? null : <span className="row-preview">{row.preview}</span>}
        <Chips row={row} place={place} />
      </button>
    </li>
  );
}

function Chips({ row, place }: { row: MessageRow; place: Place }) {
  const labels = labelsOf(row);
  const chips = [
    // A spoof is visible where triage happens, not only after opening — which would also mark it read.
    row.auth_dmarc === "fail" ? <span key="auth" className="chip chip-auth-fail">{t("inbox.chip.dmarcFail")}</span> : null,
    ...labels.map((label) => <span key={`label:${label}`} className="chip chip-label">{label}</span>),
    row.case_mine === 1 ? <span key="mine" className="chip chip-mine">{t("inbox.tab.mine")}</span> : null,
    // Held by somebody else: never by whom here, which the Queue says to those who may work it.
    row.case_state === "claimed" && row.case_mine === 0 ? <span key="held" className="chip chip-held">{t("inbox.chip.held")}</span> : null,
    // Only a search crosses places, so this is where a row from elsewhere says where it is.
    row.place === place ? null : <span key="place" className="chip chip-place">{placeName(row.place)}</span>,
  ].filter((chip) => chip !== null);
  if (chips.length === 0) return null;
  return <span className="row-chips">{chips}</span>;
}

/** Where a claim or a forward could not go ahead, bound to the message it is about (R6). */
interface Blocked {
  messageId: string;
  /** The case a held claim lost, which "Take it anyway" steals; null when there is nothing to take. */
  caseId: string | null;
  /** The words, already `marked()` where they may be the Node's. */
  message: React.ReactNode;
  /** What the steal goes on to do: open the reply composer, or only hold the case. */
  then: { reply: boolean; all: boolean } | null;
}

export function Inbox({ place = "inbox" }: { place?: Place } = {}) {
  const pages = usePages();
  const searching = pages.term !== null;
  const tab: Tab = place === "inbox" && !searching ? pages.tab : "all";
  /*
   * With no tab, filter or search on `/`, this is `messagesKey({ place: "inbox" })`: the sidebar's count and
   * this list are one cache entry and one request. A search omits the per-person filters, which the Node
   * refuses beside `q`, so results span every place and each row says where it is.
   */
  const messages = useMessages({
    cursor: pages.cursor, mailbox: pages.filters.mailbox, q: pages.term, label: pages.label,
    from: pages.filters.from, since: pages.filters.since, until: pages.filters.until,
    place: searching ? null : place, unread: tab === "unread", mine: tab === "mine",
  });
  const mailboxes = useMailboxes();
  const readable = useReadableMailboxes();
  const compose = useCompose();
  const toast = useToast();
  const queryClient = useQueryClient();
  const single = useSinglePane();

  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The row as it was when selected, so the reader survives a list that drops it: opening a row in the Unread
   * tab patches it read, and the next natural refetch omits it. The reader stays; the list shows what the Node
   * returned. Overlaid with the read state this screen itself changed.
   */
  const [pinned, setPinned] = useState<MessageRow | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  /** J past the last row or K before the first: which row of the page that arrives gets selected. */
  const [landing, setLanding] = useState<"first" | "last" | null>(null);
  /** The row whose button takes focus after the next render (J/K, E, and the single-pane Back). */
  const focusRow = useRef<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  /** The row that last had focus, which keeps the list's one Tab stop while it is on this page. */
  const [rover, setRover] = useState<string | null>(null);

  const rows = useMemo(() => messages.data?.messages ?? [], [messages.data]);
  const current = rows.find((row) => row.id === selected) ?? (pinned !== null && pinned.id === selected ? pinned : null);
  const sendableRows = mailboxes.data?.mailboxes ?? [];
  const sendable = (message: MessageRow): boolean | null =>
    mailboxes.isSuccess ? sendableRows.some((box) => box.id === message.mailbox_id) : null;
  const mailboxName = (id: string) =>
    readable.data?.mailboxes?.find((box) => box.id === id)?.name ?? sendableRows.find((box) => box.id === id)?.name ?? t("inbox.thisMailbox");

  function select(row: MessageRow | null, focus = false) {
    setSelected(row?.id ?? null);
    setPinned(row);
    // A stale "held by" is worse than asking again: pressing Reply re-asks the Node.
    setBlocked(null);
    if (row !== null) setRover(row.id);
    if (focus) focusRow.current = row?.id ?? null;
  }

  // The page J or K asked for has arrived: select its nearest row, as `select(row, true)` would.
  useEffect(() => {
    if (landing === null || !messages.isSuccess) return;
    setLanding(null);
    const row = landing === "first" ? rows[0] : rows[rows.length - 1];
    if (row === undefined) return;
    setSelected(row.id);
    setPinned(row);
    setBlocked(null);
    focusRow.current = row.id;
  }, [landing, messages.isSuccess, rows]);

  /*
   * One attempt, on the render that follows the request: the row is on screen by then, or it has left the list
   * (an Unread row the refetch dropped) and focus stays where it is rather than jumping when it reappears. The
   * early return only saves a DOM query on every other render; `mutants` finds removing it equivalent.
   *
   * Below 768px an open message hides the list, and a hidden row cannot take focus: the reader takes it as it
   * opens (`ReadingPane`), so there is nothing to do here until Back empties the reader.
   */
  useEffect(() => {
    const id = focusRow.current;
    if (id === null) return;
    focusRow.current = null;
    if (single && current !== null) return;
    const button = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button.message-row") ?? [])
      .find((one) => one.dataset.id === id);
    button?.focus();
    button?.scrollIntoView({ block: "nearest" });
  });

  /** A request that never reached the Node is its own visible state, never a silent rejection (AGENTS §3). */
  function unreachable(error: unknown) {
    toast({ tone: "alert", text: sentence("inbox.unreachable", { problem: marked(error as Error) }) });
  }

  /**
   * Why a claim or a forward did not go ahead, in the message's article after its actions (R6) — and, while a
   * composer is open, as an alert toast too. The dock covers the whole reader column, so the notice in the
   * article is out of sight there, and R on a held message looked like R doing nothing. The toast names the
   * message, since the list's selection can move on while it is up, and carries the same "Take it anyway".
   * Only one of the two is an alert, so a screen reader hears the sentence once (`notice` below).
   */
  function block(notice: Blocked, message: MessageRow) {
    setBlocked(notice);
    if (compose.composing === null) return;
    toast({
      tone: "alert",
      text: sentence("inbox.blocked.toast", { subject: subjectOf(message), problem: notice.message }),
      ...(notice.caseId === null ? {} : {
        action: { label: t("inbox.takeAnyway"), run: () => void takeAnyway(notice, message).catch(unreachable) },
      }),
    });
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["messages"] });
    void queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
  }

  /**
   * Reply claims the case and opens the composer **in one act** (#42), and every path that replies comes
   * through here: the buttons, R, A and the palette.
   *
   * The guarantee lives in the compare-and-swap, not in a separate gesture, so this is what the reply button
   * does rather than a step before it. Losing the race means the composer does not open and the reader is
   * told who holds the case — with the option to take it, which is audited. The composer claims again at the
   * seal, because it outlives this screen and the case can change hands while somebody writes.
   *
   * `steal` is the case a held notice named: "Take it anyway" takes that one, never the row's by lookup.
   *
   * **The body comes first.** Who a reply goes to (Reply-To) and whom a reply-all copies are in the body's
   * answer, not the row. Reading whatever happened to be cached sent a reply pressed before the body arrived (J
   * then R) to the From address, with every Cc dropped and a quote of "> …", and the composer never corrected
   * it. `fetchQuery` on the reader's own key joins its request or returns its answer, so on an open message this
   * is no second read and no second recorded open. A body that cannot be read opens nothing and claims nothing:
   * a guessed addressee is the failure this exists to prevent.
   */
  async function reply(message: MessageRow, all: boolean, steal: string | null = null) {
    setBlocked(null);
    // Before the claim: a reply the sealing dock will not make room for must not hold a case nobody opened.
    if (compose.refuseWhileSealing()) return;
    const caseId = steal ?? message.case_id;
    if (caseId === null) {
      // Mail with no case cannot be claimed, so composing would produce a reply nobody holds.
      block({ messageId: message.id, caseId: null, message: t("inbox.reply.noCase"), then: null }, message);
      return;
    }
    let rendered: RenderedBody;
    try {
      rendered = await queryClient.fetchQuery(bodyQuery(message.id));
    } catch (error) {
      block({
        messageId: message.id, caseId: null, then: null,
        message: sentence("inbox.reply.noBody", { problem: marked(error as Error) }),
      }, message);
      return;
    }
    // Again once the body is in: a seal started while it was on its way would otherwise meet the claim below. Only
    // one started during the claim's own request still finds the case claimed, and `open` then says the dock is
    // sealing (R3C-REPLY-SEAL-WINDOW).
    if (compose.refuseWhileSealing()) return;
    const outcome = steal !== null ? await stealCase(caseId) : await claimCase(caseId);
    refresh();
    if (!outcome.ok) {
      block({ messageId: message.id, caseId: outcome.kind === "held" ? caseId : null, message: marked(outcome), then: { reply: true, all } }, message);
      return;
    }
    const own = sendableRows.find((box) => box.id === message.mailbox_id)?.addresses?.split(",") ?? [];
    compose.open(replyContext(message, caseId, rendered, all, own));
  }

  function forward(message: MessageRow) {
    setBlocked(null);
    if (message.message_id === null) {
      block({ messageId: message.id, caseId: null, message: t("inbox.forward.unfiled"), then: null }, message);
      return;
    }
    const subject = message.subject ?? "";
    compose.open({
      mailboxId: message.mailbox_id,
      forwardOfMessageId: message.message_id,
      subject: forwardSubject(subject),
      originalSubject: subjectOf(message),
      body: "",
    });
  }

  /** Next steps' Claim: take the case to work it later. A held answer is the same collision notice Reply shows. */
  async function claim(message: MessageRow) {
    // For the type: the step is offered only on an open case. Equivalent under `mutants`, and said so here.
    if (message.case_id === null) return;
    setBlocked(null);
    const caseId = message.case_id;
    const outcome = await claimCase(caseId);
    refresh();
    if (outcome.ok) toast({ text: t("inbox.claimed") });
    else if (outcome.kind === "held") block({ messageId: message.id, caseId, message: marked(outcome), then: { reply: false, all: false } }, message);
    else toast({ tone: "alert", text: marked(outcome) });
  }

  async function release(message: MessageRow) {
    // For the type: the step is offered only on a case this reader holds.
    if (message.case_id === null) return;
    const outcome = await releaseCase(message.case_id);
    refresh();
    toast(outcome.ok ? { text: t("inbox.released") } : { tone: "alert", text: marked(outcome) });
  }

  /**
   * "Take it anyway" steals **the case the notice names**, never the current row's by lookup: the notice is
   * bound to its message, and the case is the one whose claim was lost.
   */
  async function takeAnyway(notice: Blocked, message: MessageRow) {
    // For the type: the button exists only on a notice that names a case.
    if (notice.caseId === null) return;
    if (notice.then?.reply === true) {
      await reply(message, notice.then.all, notice.caseId);
      return;
    }
    const outcome = await stealCase(notice.caseId);
    refresh();
    if (outcome.ok) {
      setBlocked(null);
      toast({ text: t("inbox.claimed") });
    } else block({ ...notice, caseId: outcome.kind === "held" ? notice.caseId : null, message: marked(outcome) }, message);
  }

  /** Read state: patched into the cached rows on success, the Node's words on refusal. */
  async function markRead(message: MessageRow, read: boolean) {
    // For the type: every caller has already checked the id (and `standing_content`, which implies it).
    if (message.message_id === null) return;
    const id = message.message_id;
    const result = await setRead(id, read);
    if (!result.ok) {
      toast({ tone: "alert", text: marked(result) });
      return;
    }
    patchReadInCache(queryClient, id, read ? 1 : 0);
    setPinned((was) => (was !== null && was.message_id === id ? { ...was, read: read ? 1 : 0 } : was));
  }

  /**
   * Moves a message to another of the reader's places, with an Undo that puts it back where it was.
   *
   * No optimistic removal: the row leaves the view when the Node has said so, by one listing refetch — the
   * one request this act costs. The selection moves on to the next row of the list as it stood, which is
   * where a person working down a queue expects to be.
   */
  async function move(message: MessageRow, to: Place) {
    // For the type, as in `markRead`.
    if (message.message_id === null) return;
    const id = message.message_id;
    const from = message.place;
    const result = await setPlace(id, to);
    if (!result.ok) {
      toast({ tone: "alert", text: marked(result) });
      return;
    }
    if (!searching && to !== place && selected === message.id) {
      const at = rows.findIndex((row) => row.id === message.id);
      // With focus, as J would: the row that had it (or the menu that did it) is about to leave the screen.
      select(at === -1 ? null : rows[at + 1] ?? rows[at - 1] ?? null, true);
    }
    void queryClient.invalidateQueries({ queryKey: ["messages"] });
    toast({
      text: t(`inbox.moved.${to}`),
      action: {
        label: t("inbox.undo"),
        run: () => void (async () => {
          const back = await setPlace(id, from);
          if (!back.ok) {
            toast({ tone: "alert", text: marked(back) });
            return;
          }
          void queryClient.invalidateQueries({ queryKey: ["messages"] });
          toast({ text: t(`inbox.movedBack.${from}`) });
        })().catch(unreachable),
      },
    });
  }

  /** Why a key did nothing for this reader, said rather than swallowed. */
  function withheld(message: MessageRow, act: "reply" | "file"): boolean {
    if (act === "reply" && sendable(message) === false) {
      toast({ text: t("inbox.withheld.reply", { mailbox: mailboxName(message.mailbox_id) }) });
      return true;
    }
    if (act === "file" && message.message_id === null) {
      toast({ text: t("inbox.withheld.unfiled") });
      return true;
    }
    if (act === "file" && message.standing_content === 0) {
      toast({ text: t("inbox.withheld.content", { mailbox: mailboxName(message.mailbox_id) }) });
      return true;
    }
    // Not yet known: the mailbox list is still loading. Said rather than guessed either way, in the words the
    // shell's Compose uses for the same moment.
    if (act === "reply" && sendable(message) === null) {
      toast({ text: t("inbox.withheld.loading") });
      return true;
    }
    return false;
  }

  function archive(message: MessageRow) {
    if (withheld(message, "file")) return;
    if (message.place === "archive") {
      toast({ text: t("inbox.alreadyArchived") });
      return;
    }
    void move(message, "archive").catch(unreachable);
  }

  /**
   * J and K. Within a page they cost nothing (the rows are here) and one body each, which opening is. Past
   * either end they do exactly what Older and Newer do — one listing request, which the key press asked for —
   * and land on the nearest row of the page that arrives. Nothing is fetched ahead of the key.
   */
  function step(by: 1 | -1) {
    const at = current === null ? -1 : rows.findIndex((row) => row.id === current.id);
    // Nothing selected (or the selection left the list): J starts at the top, K does nothing — the redesign
    // names only J's first press. `mutants` finds this branch equivalent on page one, which is where it runs.
    if (at === -1) {
      if (by === 1 && rows[0] !== undefined) select(rows[0], true);
      return;
    }
    const next = rows[at + by];
    if (next !== undefined) {
      select(next, true);
      return;
    }
    const cursor = messages.data?.next_cursor ?? null;
    if (by === 1 && cursor !== null) {
      pages.older(cursor);
      setLanding("first");
    } else if (by === -1 && pages.number > 1) {
      pages.newer();
      setLanding("last");
    }
  }

  useShortcuts([
    { key: "r", description: t("inbox.act.reply"), run: () => { if (current !== null && !withheld(current, "reply")) void reply(current, false).catch(unreachable); } },
    { key: "a", description: t("inbox.act.replyAll"), run: () => { if (current !== null && !withheld(current, "reply")) void reply(current, true).catch(unreachable); } },
    { key: "f", description: t("inbox.act.forward"), run: () => { if (current !== null && !withheld(current, "reply")) forward(current); } },
    { key: "e", description: t("inbox.act.archive"), run: () => { if (current !== null) archive(current); } },
    { key: "j", description: t("inbox.act.next"), run: () => step(1) },
    { key: "k", description: t("inbox.act.previous"), run: () => step(-1) },
    { key: "i", shift: true, description: t("inbox.act.unread"), run: () => { if (current !== null && !withheld(current, "file")) void markRead(current, false).catch(unreachable); } },
  ]);

  /*
   * The palette's message commands, each gated exactly as its button is. Memoised on what decides which
   * commands exist, and run through a ref to the latest handlers, so registering them does not churn on every
   * render and a command never acts on a message selected before it.
   */
  const latest = useRef({ current, reply, forward, move, markRead });
  latest.current = { current, reply, forward, move, markRead };
  const canSend = current === null ? null : sendable(current);
  const commands = useMemo<readonly PaletteCommand[] | null>(() => {
    if (current === null) return null;
    const run = (act: (message: MessageRow) => unknown) => () => {
      const message = latest.current.current;
      if (message !== null) void Promise.resolve(act(message)).catch(unreachable);
    };
    const found: PaletteCommand[] = [];
    if (canSend === true) {
      found.push(
        { id: "message.reply", label: t("inbox.act.reply"), hint: "R", run: run((message) => latest.current.reply(message, false)) },
        { id: "message.reply-all", label: t("inbox.act.replyAll"), hint: "A", run: run((message) => latest.current.reply(message, true)) },
        { id: "message.forward", label: t("inbox.act.forward"), hint: "F", run: run((message) => latest.current.forward(message)) },
      );
    }
    if (current.standing_content === 1 && current.message_id !== null) {
      if (current.place !== "archive") found.push({ id: "message.archive", label: t("inbox.act.archive"), hint: "E", run: run((message) => latest.current.move(message, "archive")) });
      if (current.place !== "trash") found.push({ id: "message.trash", label: t("inbox.act.trash"), run: run((message) => latest.current.move(message, "trash")) });
      found.push(current.read === 1
        ? { id: "message.unread", label: t("inbox.act.unread"), hint: "Shift+I", run: run((message) => latest.current.markRead(message, false)) }
        : { id: "message.read", label: t("inbox.act.read"), run: run((message) => latest.current.markRead(message, true)) });
    }
    return found;
    // The handlers are read through `latest`; these are what decide which commands exist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.place, current?.read, current?.standing_content, current?.message_id, canSend]);
  useRegisterCommands(commands);

  // The palette's "Search mail for …", run here once and cleared, so a return to this screen does not re-run it.
  const pending = usePendingSearch();
  useEffect(() => {
    if (pending.pending === null) return;
    pages.searchFor(pending.pending);
    pending.clear();
    // `pages` and `pending` are new objects each render; the request itself is what this runs on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.pending]);

  const title = placeName(place);
  const data = messages.data;
  const narrowed = activeFilters(pages.filters) > 0 || pages.label !== null;
  const clearFilters = () => {
    pages.filter(NO_FILTERS);
    pages.labelled(null);
  };

  /*
   * The count (#91, R12), as the words the visible count and the spoken status below both use, so the two
   * cannot say different things. Never a total nothing counted: `n` only on page one when the Node says nothing
   * older is visible, `n+` when it says more is, "Page K" further on, and nothing at all while unknown, while
   * searching (the status line counts matches) or when the page is empty — including a page the lookback cut
   * short, which always carries a cursor and so is never "0".
   */
  const shown = data?.messages.length ?? 0;
  /** Whether the Node says more is visible past this page: the count is then `n+`, never `n`. */
  const more = data !== undefined && data.next_cursor !== null;
  const figure = data === undefined || shown === 0 || searching ? null
    : pages.number > 1 ? t("inbox.count.page", { page: pages.number })
      : more ? t("inbox.count.more", { n: shown }) : format.count(shown);
  const noun = more ? t("inbox.count.nounMore") : t("inbox.count.noun", { n: shown });
  const count = figure === null ? null
    : pages.number > 1 ? figure : <>{figure}<span className="visually-hidden"> {noun}</span></>;

  const chips: Array<{ key: keyof Filters; text: string; clear: () => void }> = [];
  if (pages.filters.mailbox !== null) chips.push({ key: "mailbox", text: t("inbox.chip.mailbox", { mailbox: mailboxName(pages.filters.mailbox) }), clear: () => pages.filter({ ...pages.filters, mailbox: null }) });
  if (pages.filters.from !== null) chips.push({ key: "from", text: t("inbox.chip.from", { address: pages.filters.from }), clear: () => pages.filter({ ...pages.filters, from: null }) });
  if (pages.filters.since !== null) chips.push({ key: "since", text: t("inbox.chip.since", { day: day(pages.filters.since) }), clear: () => pages.filter({ ...pages.filters, since: null }) });
  if (pages.filters.until !== null) chips.push({ key: "until", text: t("inbox.chip.until", { day: day(pages.filters.until) }), clear: () => pages.filter({ ...pages.filters, until: null }) });

  const found = searching && data !== undefined && data.messages.length > 0 ? data.messages.length : null;
  const status = (
    <>
      {found === null ? null : (
        /*
          **A full page of results says it is capped.** A search returns one page of the best matches by
          relevance and cannot page further — bm25 rank shifts as mail arrives, so a cursor into it would skip
          and repeat rows silently. A reader seeing exactly a page's worth must know that narrowing the words
          is how to see different mail, or "50" reads as "50 matches", which nothing counted.
        */
        <>
          {found < PAGE_FULL ? t("inbox.search.found", { n: found }) : t("inbox.search.capped", { n: found })}{" "}
          <button type="button" className="linkish" onClick={() => pages.searchFor(null)}>{t("inbox.search.clear")}</button>
        </>
      )}
      {pages.label === null ? null : (
        <>
          {sentence("inbox.label.showing", { label: <span className="mono">{pages.label}</span> })}{" "}
          <button type="button" className="linkish" onClick={() => pages.labelled(null)}>{t("inbox.label.showAll")}</button>
        </>
      )}
      {place === "trash" && !searching ? t("inbox.trash.note") : null}
      {chips.map((chip) => (
        <span key={chip.key} className="chip chip-filter">
          {chip.text}
          <button type="button" className="chip-remove" aria-label={t("inbox.chip.remove", { filter: chip.text })} onClick={chip.clear}>×</button>
        </span>
      ))}
    </>
  );
  const hasStatus = found !== null || pages.label !== null || (place === "trash" && !searching) || chips.length > 0;

  /*
   * What a submitted search or an applied filter came back with, in one sentence, for a screen reader: the
   * list and the status line change silently otherwise (WCAG 4.1.3). Its own element, always in the DOM (a
   * live region inserted with its text is often not read), rather than the status line, which mounts and
   * unmounts and holds buttons that would be read out with it. Empty while the answer is pending (a new key has
   * no data yet) and on an unnarrowed listing, so opening mail, J/K and paging the Inbox say nothing; a failure
   * is the failed notice's own alert.
   *
   * Built from the count's words and the empty state's sentence, never from the row count alone: page two of a
   * filtered list is "Page 2", not a total, and an empty page says what the screen says of it (a lookback that
   * stopped, nothing older), never a zero the screen is careful not to print (#91: a page is never a total).
   */
  let heard = "";
  if (data !== undefined && (searching || narrowed)) {
    const n = data.messages.length;
    if (searching) heard = n === 0 ? t("inbox.heard.none") : n >= PAGE_FULL ? t("inbox.heard.capped", { n }) : t("inbox.heard.found", { n });
    else if (figure === null) heard = emptyState().detail;
    else if (pages.number > 1) heard = t("inbox.heard.page", { page: pages.number });
    else heard = more ? t("inbox.heard.more", { n }) : t("inbox.heard.exact", { n });
  }

  let body: React.ReactNode;
  if (messages.isPending) body = <Nothing kind="loading" />;
  else if (messages.isError) body = <Nothing kind="failed" detail={marked(messages.error)} />;
  else if (rows.length === 0) {
    const empty = emptyState();
    body = (
      <div className="list-empty">
        <Nothing kind="empty" detail={empty.detail} action={empty.action} />
        {empty.actions === undefined ? null : <p className="row-actions">{empty.actions}</p>}
      </div>
    );
  }
  else {
    /*
      One Tab stop for the whole list, so Tab goes from the list to the reader in one press rather than past
      every row (fifty at `messages.page_size`), with shortcuts off as well as on. The stop is the row that last
      had focus if it is on this page, else the one being read, else the first; there is always exactly one, or
      the list could not be reached at all.
    */
    const stop = rows.some((row) => row.id === rover) ? rover
      : rows.some((row) => row.id === selected) ? selected : rows[0]!.id;
    body = (
      /*
        A plain list of buttons, with `aria-current` marking the one being read. Not a `listbox` of `option`s
        wrapping buttons: axe rejects that as `nested-interactive`. The arrow keys and Home/End move focus
        between rows and nothing else: opening is a recorded open for a supervised reader and marks the message
        read, so it stays on Enter, a click, and J and K, which move focus to the row they open.
      */
      <ul ref={list} className="message-list" aria-label={t("inbox.list")} onKeyDown={arrows}>
        {rows.map((row) => (
          <Row
            key={row.id} row={row} place={place} selected={row.id === selected} stop={row.id === stop}
            onSelect={() => select(row)} onFocus={() => setRover(row.id)}
          />
        ))}
      </ul>
    );
  }

  /** ArrowUp/Down and Home/End between the rows, focus only; no wrap. */
  function arrows(event: React.KeyboardEvent<HTMLUListElement>) {
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button.message-row") ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const to = event.key === "ArrowDown" ? Math.min(at + 1, buttons.length - 1)
      : event.key === "ArrowUp" ? Math.max(at - 1, 0)
        : event.key === "Home" ? 0
          : event.key === "End" ? buttons.length - 1 : null;
    if (to === null) return;
    // The list scrolls itself otherwise, which moves the page under the row instead of the row.
    event.preventDefault();
    buttons[to]!.focus();
    buttons[to]!.scrollIntoView({ block: "nearest" });
  }

  /**
   * What an empty page means, in the one sentence that is true of it, and the ways on from it. The sentence is
   * also what the status region says of an empty filtered page (`heard`).
   */
  function emptyState(): { detail: string; action?: { to: AppRoute; label: string }; actions?: React.ReactNode } {
    if (searching) {
      /*
        A statement about the words, not the Node: mail may well be sitting on page one unsearched, so
        offering the routing check here would send somebody to diagnose their DNS because they misspelled a
        supplier's name. Names what was searched, and the way out.
      */
      return {
        detail: pages.filters.mailbox === null ? t("inbox.search.none") : t("inbox.search.noneInMailbox"),
        actions: <button type="button" className="linkish" onClick={() => pages.searchFor(null)}>{t("inbox.search.clear")}</button>,
      };
    }
    if (data?.lookback_exhausted === true) {
      /*
        The lookback stopped with nothing found (§2.1.4 of the redesign): the Node looked at its bound of the
        messages this reader can see and none matched. Neither "empty" nor the routing sentence is known, so
        the words say what was looked at and what was not found, and offer to look further back — one request,
        exactly what Older runs with this page's cursor. The bound is the one the Node says it used.
      */
      const from: "newest" | "older" = pages.number === 1 ? "newest" : "older";
      const among: "any" | "filtered" = narrowed ? "filtered" : "any";
      return {
        detail: data.max_lookback === null
          ? t(`inbox.lookback.${from}.uncounted.${among}.${tab}`)
          : t(`inbox.lookback.${from}.counted.${among}.${tab}`, { n: data.max_lookback }),
        actions: (
          <>
            <button type="button" className="btn" onClick={() => { if (data.next_cursor !== null) pages.older(data.next_cursor); }}>
              {t("inbox.lookback.further")}
            </button>
            {pages.number === 1 ? null : <> <button type="button" className="linkish" onClick={pages.newest}>{t("inbox.page.newest")}</button></>}
            {narrowed ? <> <button type="button" className="linkish" onClick={clearFilters}>{t("inbox.filter.clearAll")}</button></> : null}
          </>
        ),
      };
    }
    if (pages.number > 1) {
      /*
        Page two or later: nothing is older than where the reader is standing, which is not "nothing has
        arrived" — the reader got here by pressing a control this screen rendered, so it offers the way back.
      */
      return {
        detail: t("inbox.empty.older"),
        actions: <button type="button" className="linkish" onClick={pages.newest}>{t("inbox.page.newest")}</button>,
      };
    }
    if (narrowed) {
      return {
        detail: t("inbox.empty.filtered"),
        actions: <button type="button" className="linkish" onClick={clearFilters}>{t("inbox.filter.clearAll")}</button>,
      };
    }
    if (tab === "unread") return { detail: t("inbox.empty.unread") };
    if (tab === "mine") return { detail: t("inbox.empty.mine") };
    if (place === "archive") return { detail: t("inbox.empty.archive") };
    if (place === "trash") return { detail: t("inbox.empty.trash") };
    /*
      What an empty Inbox means, and nothing further (#101). It used to say "routing is live", concluded from
      an empty result set, which establishes neither: routing never enabled, MX elsewhere, a catch-all aimed at
      another Worker all produce this screen. "Visible" because authorization happens inside the SQL, so an
      empty list routinely means "nothing you may see". Doctor's `inbound_routing` finding is what can answer
      the rest.
    */
    return {
      detail: t("inbox.empty.inbox"),
      action: { to: "/doctor", label: t("inbox.empty.routing") },
    };
  }

  const showTabs = place === "inbox" && !searching;
  const cursor = data?.next_cursor ?? null;
  const notice = current !== null && blocked !== null && blocked.messageId === current.id ? (
    // An alert only with no composer open: with one, `block` raised the same words as an alert toast.
    <p className="notice bad collision" role={compose.composing === null ? "alert" : undefined}>
      {blocked.message}
      {blocked.caseId === null ? null : (
        <>
          {" "}
          {/* Available to any colleague and audited — the escape hatch the absent timeout depends on. */}
          <button type="button" className="linkish" onClick={() => void takeAnyway(blocked, current).catch(unreachable)}>
            {t("inbox.takeAnyway")}
          </button>
        </>
      )}
    </p>
  ) : null;
  const steps = current === null ? null : deterministicNextSteps({
    message: current,
    canSend: sendable(current) === true,
    claim: () => void claim(current).catch(unreachable),
    release: () => void release(current).catch(unreachable),
    showFromSender: (address) => pages.filter({ ...pages.filters, from: address }),
  });

  return (
    <div className="mail-panes" data-view={current === null ? "list" : "reader"}>
      <section className="list-pane" aria-label={t("inbox.listPane")}>
        <header className="list-head">
          <h1 className="list-title">{title}</h1>
          {count === null ? null : <span className="list-count">{count}</span>}
        </header>
        <div className="list-tools">
          {/* Keyed by the term, so a search the palette started shows in the field. */}
          <SearchField key={pages.term ?? ""} term={pages.term} onSearch={pages.searchFor} />
          <FilterControl filters={pages.filters} mailboxes={readable.data?.mailboxes ?? []} onApply={pages.filter} />
        </div>
        {showTabs ? <Tabs tab={tab} onShow={pages.show} /> : null}
        {hasStatus ? <p className="list-status">{status}</p> : null}
        <p className="visually-hidden" role="status">{heard}</p>
        <div
          className="list-scroll"
          id={showTabs ? "inbox-panel" : undefined}
          role={showTabs ? "tabpanel" : undefined}
          aria-labelledby={showTabs ? `inbox-tab-${tab}` : undefined}
        >
          {body}
        </div>
        {/*
          The pager (#91), inside the list pane, each button only when it can do something. `Older` exists
          exactly when `next_cursor` is non-null — the Node saying at least one more row is visible to this reader
          now — so an absent button is the honest end of the list. A page the lookback cut short is an ordinary
          page with a cursor. An empty page carries its own way on, in the words above.
        */}
        {rows.length === 0 || (cursor === null && pages.number === 1) ? null : (
          <nav className="pager" aria-label={t("inbox.pages")}>
            {pages.number === 1 ? null : <button type="button" className="btn btn-ghost" onClick={pages.newer}>{t("inbox.page.newer")}</button>}
            {pages.number > 2 ? <button type="button" className="btn btn-ghost" onClick={pages.newest}>{t("inbox.page.newest")}</button> : null}
            {cursor === null ? null : <button type="button" className="btn btn-ghost" onClick={() => pages.older(cursor)}>{t("inbox.page.older")}</button>}
          </nav>
        )}
      </section>
      <section className="reader-column">
        {current === null ? (
          <div className="reader-empty">
            <p>{t("inbox.reader.none")}</p>
            {/* Only where there is a list to move through: an empty Trash or search has none. */}
            {shortcutsEnabled() && rows.length > 0 ? <p>{t("inbox.reader.keys")}</p> : null}
          </div>
        ) : (
          <>
            <ReadingPane
              key={current.id}
              message={current}
              sendable={sendable(current)}
              mailboxName={mailboxName(current.mailbox_id)}
              onReply={(all) => void reply(current, all).catch(unreachable)}
              onForward={() => forward(current)}
              onMove={(to) => void move(current, to).catch(unreachable)}
              onMarkRead={(read) => void markRead(current, read).catch(unreachable)}
              onFilterLabel={pages.labelled}
              notice={notice}
              nextSteps={steps === null ? null : <NextSteps steps={steps.steps} finding={steps.finding} />}
              back={single ? {
                label: title,
                run: () => {
                  focusRow.current = current.id;
                  select(null);
                },
              } : null}
            />
            <Thread conversationId={current.conversation_id} current={current.id} />
          </>
        )}
      </section>
    </div>
  );
}
