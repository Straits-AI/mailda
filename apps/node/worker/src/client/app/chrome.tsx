import { onlineManager, useQueryClient, type QueryCacheNotifyEvent, type QueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { t } from "/app/locale.js";
import { MARK_IS_AUTHORED } from "../../brand.ts";
import type { Text } from "../../i18n/format.ts";
import { Mark } from "./mark.tsx";

import {
  useApprovals, useDoctor, useDrafts, useMailboxes, useMessages, useNotifications, useSends,
  type DoctorReport, type NotificationRow, type SendsResponse,
} from "./api.ts";
import { isAppRoute, type AppRoute } from "../../app-routes.ts";
import { ago, clock } from "./format.ts";
import { healthRows } from "./health.ts";
import { SetupUnfinished } from "./onboarding.tsx";
import { useCompose, useToast, useToastAction } from "./shell-context.tsx";
import { Icon, type IconName } from "./ui/icons.tsx";
import { CommandPalette } from "./ui/palette.tsx";
import { Modal, Popover } from "./ui/popover.tsx";
import { shortcutsEnabled, useShortcuts, type Shortcut } from "./ui/shortcuts.ts";
import { marked, sentence } from "./words.tsx";

/**
 * The chrome: a grouped sidebar, the main column, and a status bar along the bottom.
 *
 * ## Why a sidebar, and why grouped
 *
 * Layer 3 is *share* (shared mailboxes, assignment, reply-collision, cases with SLA clocks) and it needs a
 * persistent list of mailboxes carrying per-item counts and claim state (#32). That is what a sidebar is,
 * and it is why the per-mailbox rows survive the regrouping, under Workspace. The rows are
 * `GET /api/mailboxes`, read on every load: which mailboxes this person may work is a decision about
 * visibility, which ADR 11 puts on the server on every request, never in a client-side list.
 *
 * The groups (Mail, Workspace, Automate, Admin, and Settings at the foot) render from `SIDEBAR_HOME`, a
 * `Record<AppRoute, …>`: a route added without a home is a compile error, and a route with one appears. No
 * link is hidden by role. The screens behind Butlers, Agents and People are refused to anybody without
 * `org.admin`, and the screen says so; hiding the link would be a second, weaker copy of the Node's decision,
 * in the navigation, where it cannot be enforced.
 *
 * ## What replaced the instrument bar
 *
 * The bottom bar held a session countdown, the hostname, the outbound counts, the doctor verdict and both
 * sign-outs. It now holds two derived facts, whether the Node is answering and what the doctor says, and
 * everything else moved where it is used: the countdown and both sign-outs to Settings, the hostname to
 * Settings and the health popover, the outbound counts to the Outbox row and the popover.
 */

/**
 * Where each route lives in the sidebar, in the order the rows render. `{ tabOf }` is a route reached by a
 * section tab on another route's screen rather than by a row of its own: Rules is a tab beside Butlers,
 * under "Automations".
 *
 * Rules are send policies, not automations in the Butler sense, and they sit here anyway because both answer
 * "what does this Node do with mail without a person deciding each time"; the tab and the screen still say
 * "Rules".
 */
export const SIDEBAR_HOME: Record<AppRoute, "mail" | "workspace" | "automate" | "admin" | "foot" | { tabOf: AppRoute }> = {
  "/": "mail", "/queue": "mail", "/drafts": "mail", "/outbox": "mail", "/archive": "mail", "/trash": "mail",
  "/people": "workspace", "/matters": "workspace", "/approvals": "workspace",
  "/butlers": "automate", "/rules": { tabOf: "/butlers" }, "/agents": "automate",
  "/doctor": "admin", "/limits": "admin", "/audit": "admin", "/log": "admin", "/setup": "admin",
  "/settings": "foot",
};

/**
 * The section tabs over a route's screen: the route itself, then every route whose home is `{ tabOf: it }`.
 * Derived, so a route given a `tabOf` home gets its tab without a second list to remember.
 */
export function tabsOf(parent: AppRoute): Array<{ to: AppRoute; label: Text }> {
  const children = (Object.keys(SIDEBAR_HOME) as AppRoute[]).filter((route) => {
    const home = SIDEBAR_HOME[route];
    return typeof home === "object" && home.tabOf === parent;
  });
  return [parent, ...children].map((to) => ({ to, label: t(`route.${to}`) }));
}

/**
 * A route's name in the sidebar: the route's own (`route.*`), except the one row whose name differs, the group's
 * word over Butlers and Rules (D2: "Automations", which Chinese keeps apart from the group's "Automate").
 */
const sidebarName = (route: AppRoute): Text => (route === "/butlers" ? t("chrome.row.automations") : t(`route.${route}`));

const ROUTE_ICONS: Record<AppRoute, IconName> = {
  "/": "inbox", "/queue": "queue", "/approvals": "approvals", "/rules": "automations", "/people": "people",
  "/matters": "matters", "/butlers": "automations", "/agents": "agents", "/limits": "limits", "/outbox": "outbox",
  "/audit": "audit", "/log": "log", "/doctor": "health", "/setup": "setup", "/drafts": "drafts",
  "/archive": "archive", "/trash": "trash", "/settings": "settings",
};

type Group = "mail" | "workspace" | "automate" | "admin" | "foot";

function routesIn(group: Group): AppRoute[] {
  return (Object.keys(SIDEBAR_HOME) as AppRoute[]).filter((route) => SIDEBAR_HOME[route] === group);
}

/** The views that are the mail layout (list and reader) rather than a ledger screen. */
const MAIL_ROUTES: ReadonlySet<AppRoute> = new Set<AppRoute>(["/", "/archive", "/trash"]);

/**
 * Below 1120px the sidebar becomes a drawer. The same breakpoint as the stylesheet's `data-layout` rules,
 * which read the attribute this sets rather than a media query of their own, so the two cannot disagree.
 */
const NARROW = "(max-width: 1119.98px)";

function subscribeNarrow(onChange: () => void): () => void {
  const query = matchMedia(NARROW);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => matchMedia(NARROW).matches);
}

/**
 * Starting a new message, from Compose, C and the palette alike (#94: the mailbox is chosen, never inferred).
 *
 * While the mailbox list is still being read, or could not be read, C says that rather than "you hold it on
 * none": an empty list that is only unanswered is not an answer (§5C).
 */
export function useStartCompose(): () => void {
  const mailboxes = useMailboxes();
  const compose = useCompose();
  const toast = useToast();
  return () => {
    if (mailboxes.isSuccess) compose.start(mailboxes.data.mailboxes);
    else if (mailboxes.isError) toast({ tone: "alert", text: marked(mailboxes.error) });
    else toast({ text: t("chrome.compose.reading") });
  };
}

/**
 * Compose: the one way a new message starts.
 *
 * Absent when this person may send from no mailbox (`useMailboxes` returns exactly the mailboxes they hold
 * `send.propose` on): a button that can only fail is worse than none, and C says why instead. `compact` is
 * the narrow layout's icon-only button; at any width exactly one Compose exists.
 */
export function ComposeButton({ compact = false }: { compact?: boolean }) {
  const mailboxes = useMailboxes();
  const compose = useCompose();
  const rows = mailboxes.data?.mailboxes ?? [];
  if (rows.length === 0) return null;
  return (
    <button
      type="button"
      className={compact ? "primary compose-button compact" : "primary compose-button"}
      // The key is named only while it works: with single-key shortcuts off, "(C)" names a key that does nothing.
      // Read at render, like every hint that names a key; the switch applies from the next render.
      title={shortcutsEnabled() ? t("chrome.compose.key") : t("chrome.compose")}
      aria-label={compact ? t("chrome.compose") : undefined}
      aria-haspopup={rows.length > 1 ? "dialog" : undefined}
      onClick={() => compose.start(rows)}
    >
      <Icon name="compose" />
      {compact ? null : <span>{t("chrome.compose")}</span>}
    </button>
  );
}

/** One sidebar link: icon, name and, when known, a count. */
function Row({ to, name, count = null, onNavigate, className = "rail-row", current = false, title }: {
  to: AppRoute;
  name: string;
  count?: React.ReactNode;
  onNavigate?: () => void;
  className?: string;
  /** Marked current by the caller, for a row whose link is not the current page (Automations on /rules). */
  current?: boolean;
  title?: string;
}) {
  return (
    <Link
      to={to}
      className={current ? `${className} current` : className}
      activeProps={{ className: `${className} current` }}
      aria-current={current ? "true" : undefined}
      title={title}
      onClick={() => onNavigate?.()}
    >
      <Icon name={ROUTE_ICONS[to]} />
      <span className="rail-name">{name}</span>
      {count === null ? null : <span className="num">{count}</span>}
    </Link>
  );
}

/**
 * The sidebar.
 *
 * Every count here is a figure only once it is known (a zero while loading is a claim about an unread list,
 * §5C), and a page is never printed as a total (#91): `+` whenever the Node said more exist.
 */
export function Rail({ onNavigate }: { onNavigate?: () => void } = {}) {
  const path = useRouterState({ select: (state) => state.location.pathname });
  /*
   * The same query key as the Inbox's default view (`messagesKey({ place: "inbox" })`), so on `/` with no tab,
   * filter or search the count and the list are **one** request. That matters beyond cost: each listing a
   * supervised reader fetches writes one `supervised.query`, so a second key would be a second audit entry
   * for the same page. Elsewhere it refreshes at most once a minute on focus, or when an act invalidates it.
   */
  const inbox = useMessages({ place: "inbox" }, { staleTime: 60_000 });
  const mailboxes = useMailboxes();
  const sends = useSends();
  const drafts = useDrafts();
  const approvals = useApprovals();
  const inAdmin = SIDEBAR_HOME[path as AppRoute] === "admin";
  // Starts open on an Admin route so the first paint already shows the current row. The effect below would
  // open it one frame later anyway, which is why a mutation of this initialiser survives the sidebar test:
  // the difference is a flash, not a state a test can hold after `render` has flushed the effects.
  const [adminOpen, setAdminOpen] = useState(inAdmin);

  // Entering an Admin route opens its group, so the current row is never folded away.
  useEffect(() => {
    if (inAdmin) setAdminOpen(true);
  }, [inAdmin]);

  const unparsed = inbox.isSuccess
    ? inbox.data.messages.filter((message) => message.parse_error !== null).length
    : 0;

  function count(route: AppRoute): React.ReactNode {
    switch (route) {
      case "/": {
        if (!inbox.isSuccess) return null;
        const { messages, next_cursor: next, lookback_exhausted: exhausted } = inbox.data;
        // An empty page the lookback cut short is not "0" and not "0+": nothing is known about the Inbox
        // beyond the newest messages it looked through, so no figure is the honest one.
        if (messages.length === 0 && exhausted) return null;
        return `${messages.length}${next === null ? "" : "+"}`;
      }
      case "/queue": {
        // The depth of work nobody has taken: unclaimed, not total, or a busy queue reads as a backlog.
        if (!mailboxes.isSuccess || mailboxes.data.mailboxes.length === 0) return null;
        return mailboxes.data.mailboxes.reduce((total, box) => total + box.unclaimed, 0);
      }
      case "/drafts": {
        if (!drafts.isSuccess || drafts.data.drafts.length === 0) return null;
        return `${drafts.data.drafts.length}${drafts.data.truncated ? "+" : ""}`;
      }
      case "/outbox": {
        // What is waiting on somebody: held (the hold window) and awaiting (a policy gate). Counted among the
        // newest the Outbox lists, so `+` when that page is truncated. Handed-over sends are not work.
        if (!sends.isSuccess) return null;
        const waiting = sends.data.sends.filter((send) => send.state === "held" || send.state === "awaiting").length;
        return waiting === 0 ? null : `${waiting}${sends.data.truncated ? "+" : ""}`;
      }
      case "/approvals": {
        // The only Workspace row that is work: somebody is waiting on a decision.
        if (!approvals.isSuccess || approvals.data.approvals.length === 0) return null;
        return approvals.data.approvals.length;
      }
      default:
        return null;
    }
  }

  const row = (route: AppRoute) => (
    <li key={route}>
      <Row to={route} name={sidebarName(route)} count={count(route)} onNavigate={onNavigate} />
    </li>
  );

  return (
    <nav className="rail" aria-label={t("chrome.nav")}>
      {/*
        * The brand's primary lockup: symbol then word (#128). The word is real text, not a path: selectable,
        * translatable, and read aloud as a name. The symbol is gated on `MARK_IS_AUTHORED`, which has been
        * true since 18 September 2026 (the trace `brand.ts` describes, checked by render); the gate stays so
        * a placeholder could never again stand in for the symbol.
        */}
      <p className="wordmark">
        {MARK_IS_AUTHORED ? <Mark size={20} /> : null}
        <span>{t("brand.name")}</span>
      </p>
      {/* In the drawer the narrow layout's bar holds the one Compose, so the drawer's rail has none. */}
      {onNavigate === undefined ? <ComposeButton /> : null}

      <p className="rail-heading" id="rail-mail">{t("chrome.group.mail")}</p>
      <ul className="rail-list" aria-labelledby="rail-mail">
        {routesIn("mail").flatMap((route) => route === "/" && unparsed > 0
          ? [
            row(route),
            // Accepted but not parsed: listed, and counted here, so "accepted but absent" never happens
            // quietly (Blueprint §24).
            <li key="unparsed" className="rail-note">
              <span className="state state-outcome_unknown">{t("chrome.rail.unparsed", { n: unparsed })}</span>
            </li>,
          ]
          : [row(route)])}
      </ul>

      <p className="rail-heading" id="rail-workspace">{t("chrome.group.workspace")}</p>
      <ul className="rail-list" aria-labelledby="rail-workspace">
        {/*
          The queues, one row per mailbox, with the count of **unclaimed** work: what the sidebar was chosen
          over route tabs for (#32). They link to the Queue without selecting the mailbox (its picker is the
          screen's own state), and never carry the current fill: the Queue row does.
        */}
        {(mailboxes.data?.mailboxes ?? []).map((box) => (
          <li key={box.id}>
            <Link
              to="/queue"
              className="rail-row rail-mailbox"
              activeProps={{ className: "rail-row rail-mailbox" }}
              title={t("chrome.rail.mailbox", { unclaimed: box.unclaimed, claimed: box.claimed, mine: box.mine })}
              onClick={() => onNavigate?.()}
            >
              <Icon name="mailbox" />
              <span className="rail-name">{box.name}</span>
              <span className="num">
                {box.unclaimed}
                {/* Hair spaces about the dot: with ordinary ones a ten-letter name gave up three pixels to "· 1 mine"
                    at the rail's width and lost its last letters (measured in Chromium: 10px against 6px). */}
                {box.mine > 0 ? <span className="rail-mine">{"\u200A·\u200A"}{t("chrome.rail.mine", { n: box.mine })}</span> : null}
              </span>
            </Link>
          </li>
        ))}
        {routesIn("workspace").map(row)}
      </ul>

      <p className="rail-heading" id="rail-automate">{t("chrome.group.automate")}</p>
      <ul className="rail-list" aria-labelledby="rail-automate">
        {routesIn("automate").map((route) => {
          // On a route that is a tab of this row's screen (Rules under Automations), the row is the current
          // item in the set without being a link to this page: `aria-current="true"`, not "page".
          const tabHere = (Object.keys(SIDEBAR_HOME) as AppRoute[]).some((other) => {
            const home = SIDEBAR_HOME[other];
            return other === path && typeof home === "object" && home.tabOf === route;
          });
          return (
            <li key={route}>
              <Row
                to={route}
                name={sidebarName(route)}
                current={tabHere}
                onNavigate={onNavigate}
              />
            </li>
          );
        })}
      </ul>

      {/* Collapsible, never hidden: Admin is where somebody goes when the Node is not working. */}
      <button
        type="button"
        className="rail-group-toggle"
        aria-expanded={adminOpen}
        aria-controls="rail-admin"
        onClick={() => setAdminOpen((open) => !open)}
      >
        <span>{t("chrome.group.admin")}</span>
        <Icon name={adminOpen ? "chevron-down" : "chevron-right"} />
      </button>
      {adminOpen ? (
        <ul className="rail-list" id="rail-admin">
          {routesIn("admin").map(row)}
        </ul>
      ) : null}

      <ul className="rail-list rail-foot">
        {routesIn("foot").map(row)}
      </ul>
    </nav>
  );
}

/* ------------------------------------------------------------------ the status bar ------------------ */

/**
 * Whether the Node is answering, from **every** query rather than the doctor poll alone.
 *
 * The newest query outcome decides. A success, or an error that is an HTTP answer (a `ReadFailure`: the Node
 * answered, even if with a refusal), is "answered"; an error that is a `TypeError` is fetch rejecting, which
 * is no answer at all; any other error (a non-JSON 200's `SyntaxError`) still came from something that
 * answered. "listening" used to be a literal here, printed whatever the Node was doing.
 */
type Reach = "answered" | "unreachable";

function reachOf(action: { type: string; error?: unknown }): Reach | null {
  if (action.type === "success") return "answered";
  if (action.type === "error") return action.error instanceof TypeError ? "unreachable" : "answered";
  return null;
}

/** The outcome already in the cache when the bar mounts: the most recently settled query's. */
function settledReach(client: QueryClient): Reach | null {
  let newest: { at: number; reach: Reach } | null = null;
  for (const query of client.getQueryCache().getAll()) {
    const { dataUpdatedAt, errorUpdatedAt, error } = query.state;
    const at = Math.max(dataUpdatedAt, errorUpdatedAt);
    if (at === 0 || (newest !== null && at <= newest.at)) continue;
    // `>` against `>=` differs only when a success and a TypeError land in the same millisecond on one query,
    // which a mutation run reports as a survivor; either reading of that instant is defensible.
    const reach: Reach = errorUpdatedAt > dataUpdatedAt && error instanceof TypeError ? "unreachable" : "answered";
    newest = { at, reach };
  }
  return newest?.reach ?? null;
}

function subscribeOnline(onChange: () => void): () => void {
  return onlineManager.subscribe(onChange);
}

type Connection = "connected" | "offline" | "unreachable" | "checking";

export function useConnection(): { state: Connection; word: Text } {
  const client = useQueryClient();
  const [reach, setReach] = useState<Reach | null>(() => settledReach(client));
  const online = useSyncExternalStore(subscribeOnline, () => onlineManager.isOnline());

  useEffect(() => client.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    if (event.type !== "updated") return;
    const next = reachOf(event.action);
    if (next !== null) setReach(next);
  }), [client]);

  const state: Connection = !online ? "offline" : reach === null ? "checking" : reach === "unreachable" ? "unreachable" : "connected";
  return { state, word: t(`chrome.connection.${state}`) };
}

/**
 * What the doctor said, by area (D9). The report arrives as a prop from the status bar's own `useDoctor`.
 *
 * **This must not call `useDoctor` itself.** A second observer mounting while the report is more than a
 * minute old refetches it, and a doctor run costs up to ~220 subrequests
 * (`docs/receipts/doctor-check-cost.md`). For the same reason there is no "check now" here: Open Doctor is
 * the way to a fresh run. The outbound counts come from the sidebar's cached `["sends"]`, never a new fetch.
 */
export function HealthPopover({ open, onClose, anchor, report, error }: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  report: DoctorReport | undefined;
  error: Error | null;
}) {
  const queryClient = useQueryClient();
  const sends = open ? queryClient.getQueryData<SendsResponse>(["sends"]) : undefined;
  const health = report === undefined ? null : healthRows(report);

  return (
    <Popover open={open} onClose={onClose} label={t("chrome.health.title")} className="health-popover popover-up popover-end" anchor={anchor}>
      <h2 className="health-title">
        {report === undefined ? t("chrome.health.title") : sentence("chrome.health.heading", {
          verdict: <span className={`state verdict-${report.verdict}`}>{t(`health.status.${report.verdict}`)}</span>,
        })}
      </h2>
      {error !== null ? <p className="bad" role="alert">{marked(error)}</p> : null}
      {health === null ? (error === null ? <Nothing kind="loading" /> : null) : (
        <>
          <ul className="health-rows">
            {health.rows.map((row) => (
              <li key={row.area} className="health-row">
                <span className="health-area">{t(`health.area.${row.area}`)}</span>
                {row.status === "absent" || row.status === "none"
                  ? <span className="health-absent">{t(`health.status.${row.status}`)}</span>
                  : (
                    <span className={`state verdict-${row.status === "ok-visible" ? "ok" : row.status}`}>
                      {row.failing > 0
                        ? t("health.failing", { status: t(`health.status.${row.status}`), n: row.failing })
                        : t(`health.status.${row.status}`)}
                    </span>
                  )}
              </li>
            ))}
          </ul>
          {sends === undefined ? null : <OutboundCounts sends={sends} />}
          {health.reduced ? (
            <p className="health-note">{t("health.reduced")}</p>
          ) : null}
          <p className="health-meta">
            {t("health.checked", { at: clock(report!.at), ago: ago(report!.at) })}
            <br />
            {t("health.node", { host: location.host })}
          </p>
        </>
      )}
      <Link to="/doctor" className="health-open" onClick={onClose}>{t("health.open")}</Link>
    </Popover>
  );
}

/**
 * Held and awaiting are counted separately: a policy-gated send is pending mail somebody is waiting on, and
 * folding it into `held` would say waiting releases it, which is what `awaiting` does not mean. Both are
 * counted among the newest sends the Outbox lists, so `+` when that page is truncated (#91).
 */
function OutboundCounts({ sends }: { sends: SendsResponse }) {
  const plus = sends.truncated ? "+" : "";
  const held = sends.sends.filter((send) => send.state === "held").length;
  const awaiting = sends.sends.filter((send) => send.state === "awaiting").length;
  return (
    <p className="health-meta">
      {t("health.outbound", { handedOver: sends.daily.handedOver, held, awaiting, plus })}
    </p>
  );
}

/**
 * The bottom bar: whether the Node is answering, and what the doctor says. Nothing else: no hostname, no
 * countdown, no counts, no sign-out (each moved where it is used; see the top of this file).
 *
 * It owns the only `useDoctor` observer the chrome needs, which is why the popover takes the report as a prop.
 */
export function StatusBar() {
  const doctor = useDoctor();
  const connection = useConnection();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  return (
    <footer className="status-bar" aria-label={t("chrome.status")}>
      {/* A polite live region, always mounted: the word changes rarely, and a change is news (WCAG 4.1.3). */}
      <span className="connection" role="status">
        <span className={`dot dot-${connection.state}`} />
        {connection.word}
      </span>
      <span className="popover-wrap">
        <button
          ref={button}
          type="button"
          className="health-button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          {doctor.isSuccess
            ? sentence("chrome.health.bar", {
              verdict: <span className={`state verdict-${doctor.data.verdict}`}>{t(`health.status.${doctor.data.verdict}`)}</span>,
            })
            : doctor.isError ? t("chrome.health.bar.failed") : t("chrome.health.bar.checking")}
        </button>
        <HealthPopover
          open={open}
          onClose={() => setOpen(false)}
          anchor={button}
          report={doctor.data}
          error={doctor.error}
        />
      </span>
    </footer>
  );
}

/* ------------------------------------------------------------------ the layout ---------------------- */

/**
 * The authenticated layout, below the gate.
 *
 * Wide (≥ 1120px): sidebar, main column, status bar. Narrow: one column with a bar holding the menu button,
 * the screen's name and a compact Compose; the sidebar is a modal `<dialog>` drawer that exists **only while
 * open**, so no off-screen link sits in the tab order and `showModal()` makes the rest inert.
 *
 * The bands (setup unfinished, §7 notices) precede the outlet on every route: §7's notice is one a person
 * must meet, and there is no route somebody must visit to be told.
 */
export function Shell() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const narrow = useNarrow();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const startCompose = useStartCompose();
  const undo = useToastAction();

  // A navigation, or the window widening past the breakpoint, closes the drawer.
  useEffect(() => {
    setDrawerOpen(false);
  }, [path, narrow]);

  const shortcuts: Shortcut[] = [{ key: "c", description: t("chrome.compose"), run: startCompose }];
  if (undo !== null) shortcuts.push({ key: "z", description: t("shortcuts.undo"), run: undo });
  useShortcuts(shortcuts);

  const closeDrawer = () => setDrawerOpen(false);

  return (
    <div className="app-shell" data-layout={narrow ? "narrow" : "wide"}>
      {narrow ? null : <Rail />}
      {/* A div, not a `main`: the mount point is `<main id="app">`, and a second `main` landmark inside it is
          the structural defect axe exists to catch. */}
      <div className={isAppRoute(path) && MAIL_ROUTES.has(path) ? "app-main mail" : "app-main"}>
        {narrow ? (
          <header className="mobile-bar">
            <button
              ref={menuButton}
              type="button"
              className="btn btn-icon menu-button"
              aria-label={t("chrome.drawer.open")}
              aria-haspopup="dialog"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <span className="mobile-title">{isAppRoute(path) ? t(`route.${path}`) : t("brand.name")}</span>
            <ComposeButton compact />
          </header>
        ) : null}
        <SetupUnfinished />
        <Notices />
        <Outlet />
      </div>
      <StatusBar />
      {narrow && drawerOpen ? (
        <Modal
          className="drawer"
          label={t("chrome.nav")}
          onClose={closeDrawer}
          returnTo={menuButton}
          // A click on the backdrop lands on the dialog itself; one on the rail lands inside it.
          onClick={(event) => { if (event.target === event.currentTarget) closeDrawer(); }}
        >
          <Rail onNavigate={closeDrawer} />
          {/* After the rail, so focus opens on its first link; a way out that a touch screen reader can find,
              where Escape and the backdrop are not. */}
          <button type="button" className="btn btn-icon drawer-close" aria-label={t("chrome.drawer.close")} onClick={closeDrawer}>
            <Icon name="close" />
          </button>
        </Modal>
      ) : null}
      <CommandPalette />
    </div>
  );
}

/* ------------------------------------------------------------------ shared pieces ------------------- */

/**
 * The four empty states §5C requires kept distinct, as one component so they cannot drift apart.
 *
 * "Could not be read" is not "empty", and "you are not entitled to know" is neither. A single "nothing
 * here" for all three is how a mail client tells its first lie.
 */
/**
 * The three states a list can be in, said in words that do not claim more than is known.
 *
 * ## `unfiltered` is opt-in now, and used to be unconditional (#101)
 *
 * This appended *"An empty ledger. Not a filtered one: nothing has been hidden from you"* to **every** empty
 * state. On most of them that is false. Authorization on this Node happens **inside the SQL** (ADR 11, §5),
 * so an empty list routinely means "nothing you may see" rather than "nothing" — and telling a reader
 * nothing has been hidden from them is exactly the claim the architecture forbids the interface from making.
 *
 * The screens knew. `matters.tsx` writes *"No matters, or you do not hold org.admin"* in its own detail,
 * which is honest, and then this sentence contradicted it two words later on the same line.
 *
 * So a caller now has to **assert** it, and the assertion is only correct where the query is genuinely not
 * scoped by a relation. The default says nothing extra, because a blank prompts a question and a wrong
 * reassurance ends one.
 */
/**
 * A capped list says where it stopped. The Node returns `truncated` on every listing it caps (AGENTS.md §3:
 * a limit you can hit is a limit you must see), and this is the sentence that makes the flag visible.
 */
/** Copies to the clipboard and says so, because a button that silently succeeds looks broken. */
export function Copyable({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="setup-copy">
      <code className="mono">{text}</code>
      <button
        type="button"
        className="linkish"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            // A clipboard that refuses is not a failure worth a banner — the text is on screen and
            // selectable, which is what it was always the fallback for.
            () => setCopied(false),
          );
        }}
      >
        {copied ? t("chrome.copied") : t("chrome.copy", { what: label })}
      </button>
    </span>
  );
}

/**
 * What a table sits in: when it is wider than the screen, this scrolls sideways, and a keyboard must be able to
 * reach it to scroll it (WCAG 2.1.1; axe's `scrollable-region-focusable`). So it is a named region in the Tab
 * order, as the notices band is. Always, not only while it overflows: whether it does depends on the Node's
 * words and the window, and following that would take a resize observer on every table. At 390 the breakers on
 * /limits overflowed with nothing in them to focus (R2AXE-4).
 */
export function Scroller({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="scroller" tabIndex={0} role="region" aria-label={label}>{children}</div>;
}

export function Truncated({ when, shown, noun }: { when: boolean; shown: number; noun: string }) {
  if (!when) return null;
  return <p className="notice dim">{t("chrome.truncated", { shown, noun })}</p>;
}

export function Nothing(
  { kind, detail, unfiltered = false, action }: {
    kind: "empty" | "failed" | "loading";
    /** The failure's words, already `marked()` when they may be the Node's. */
    detail?: React.ReactNode;
    /** Only pass this when the underlying query is not narrowed by authorization. It rarely is. */
    unfiltered?: boolean;
    /**
     * Where to go to answer the question this screen cannot.
     *
     * `AppRoute`, not `string`. The first version took a string and cast it at the `<Link>`, which bought
     * an `any` and gave up the one thing worth having here: a destination that does not exist becomes a
     * compile error rather than a dead link on an empty screen somebody only reaches when something is
     * already wrong. `app-routes.ts` is the same list `index.ts` serves deep links from, so the two cannot
     * disagree about which routes exist.
     */
    action?: { to: AppRoute; label: string };
  },
) {
  if (kind === "loading") return <p className="notice dim">{t("chrome.nothing.loading")}</p>;
  if (kind === "failed") {
    return (
      <p className="notice bad" role="alert">
        {detail ?? t("chrome.nothing.failed")}
      </p>
    );
  }
  return (
    <p className="notice">
      {detail ?? t("chrome.nothing.empty")}
      {unfiltered
        ? <> <span className="dim">{t("chrome.nothing.unfiltered")}</span></>
        : null}
      {action === undefined
        ? null
        : <> <Link to={action.to} className="linkish">{action.label}</Link></>}
    </p>
  );
}

/**
 * The notices this person has been delivered (#63 part B, §7).
 *
 * ## Why this is a band above the stage rather than a screen
 *
 * §7 requires that the person whose mail was read be told, and this project's argument is that an unusable
 * record is not a record. A notice behind a route is one nobody opens; a notice above whatever they came here
 * to do is one they read. It is also why there is **no dismiss control**: §7 requires the notification not be
 * disableable by the investigator, and the cheapest way to hold that is for the interface to have no way to
 * clear one — there is no endpoint behind a button that does not exist.
 *
 * ## Why the text is assembled here and the facts are not
 *
 * The Node freezes the *facts* at delivery — who read, how much, for how long, under what matter, and what
 * they actually did — and this turns them into a sentence. The split matters: the record must say the same
 * thing for ever, and the wording is allowed to improve. What this must not do is add a fact the Node did not
 * record, which is why every value below comes out of `body` and nothing is inferred.
 *
 * Absent fields render as absent rather than as a guess. A notice delivered by an older Node carries an older
 * shape, and "an unrecorded instant" is a truthful thing to print where a fabricated one is not.
 */
/** The facts a notice may carry, each one possibly absent or of another shape on an older Node's notice. */
interface NoticeBody {
  readonly subjectKind?: unknown; readonly approvalId?: unknown; readonly requestedBy?: unknown; readonly requestedAt?: unknown;
  readonly readerEmail?: unknown; readonly readerId?: unknown; readonly mailboxName?: unknown; readonly mailboxId?: unknown;
  readonly scope?: unknown; readonly grantedAt?: unknown; readonly expiresAt?: unknown; readonly matterId?: unknown;
  readonly matterType?: unknown; readonly grantId?: unknown;
  readonly acts?: { readonly queries?: unknown; readonly listed?: unknown; readonly opened?: unknown; readonly attachments?: unknown };
}

const fact = (value: unknown): string | null => typeof value === "string" ? value : null;
const tally = (value: unknown): number => typeof value === "number" ? value : 0;

/**
 * A notice as a headline sentence and a line of facts. The line is a list, each item its own message, joined by
 * a middle dot; a fact the Node did not record is passed as the words that say so, never left out or guessed.
 */
function noticeText(notice: NotificationRow): { headline: string; meta: string } {
  const body = (notice.body ?? {}) as NoticeBody;
  const unrecorded = t("chrome.notice.unrecorded");

  if (notice.kind === "approval_request") {
    return {
      headline: t("chrome.notice.approval", { kind: fact(body.subjectKind) ?? t("chrome.notice.an_act") }),
      meta: [
        t("chrome.notice.request", { id: fact(body.approvalId) ?? notice.subjectId }),
        t("chrome.notice.asked_by", { who: fact(body.requestedBy) ?? t("chrome.notice.somebody") }),
        fact(body.requestedAt) ?? unrecorded,
      ].join(" · "),
    };
  }

  const acts = body.acts ?? {};
  const matter = fact(body.matterId) ?? t("chrome.notice.none_cited");
  const type = fact(body.matterType);
  return {
    headline: t("chrome.notice.supervised", {
      reader: fact(body.readerEmail) ?? fact(body.readerId) ?? t("chrome.notice.somebody"),
      scope: fact(body.scope) ?? t("chrome.notice.read"),
      mailbox: fact(body.mailboxName) ?? fact(body.mailboxId) ?? t("chrome.notice.a_mailbox"),
      from: fact(body.grantedAt) ?? t("chrome.notice.unrecorded_at"),
      to: fact(body.expiresAt) ?? unrecorded,
    }),
    // The counts are the part that makes this actionable rather than ceremonial: the difference between a
    // grant nobody used and one under which everything was opened.
    meta: [
      t("chrome.notice.queries", { n: tally(acts.queries), listed: tally(acts.listed) }),
      t("chrome.notice.opened", { n: tally(acts.opened) }),
      t("chrome.notice.raw", { n: tally(acts.attachments) }),
      type === null ? t("chrome.notice.matter", { matter }) : t("chrome.notice.matter.typed", { matter, type }),
      t("chrome.notice.grant", { grant: fact(body.grantId) ?? notice.subjectId }),
    ].join(" · "),
  };
}

export function Notices() {
  const notices = useNotifications();
  // Nothing while it is loading and nothing on a failure: this band is an addition to whatever screen a
  // person is on, and a failure banner above every screen would be the loudest thing in the product for a
  // read that is not the one they asked for. The failure is visible where notices are the subject.
  if (!notices.isSuccess || notices.data.notifications.length === 0) return null;

  return (
    // Focusable, so a keyboard can scroll it: the stylesheet bounds its height, and fifty non-dismissible
    // notices must never squeeze the screen below them to nothing.
    <section className="notices" aria-label={t("chrome.notices")} tabIndex={0}>
      <Truncated when={notices.data.truncated} shown={notices.data.notifications.length} noun={t("chrome.notices.noun")} />
      {notices.data.notifications.map((notice) => {
        const { headline, meta } = noticeText(notice);
        return (
          <p key={notice.id} className="notice told">
            {headline}
            {" "}
            <span className="told-meta mono">{meta}</span>
          </p>
        );
      })}
    </section>
  );
}
