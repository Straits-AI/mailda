import type { Area } from "../areas.ts";

/**
 * The chrome (`src/client/app/chrome.tsx`): the sidebar, the status bar and its health popover
 * (`src/client/app/health.ts`), the narrow layout, the notices band and the shared empty states.
 *
 * The notices are sentences assembled from the facts a notice froze at delivery. Each fact the Node did not
 * record has its own words (`chrome.notice.somebody`, `chrome.notice.unrecorded`), passed into the sentence as
 * a parameter, so a translation keeps the sentence whole whichever facts are present.
 *
 * `health.area.*` and `health.status.*` are keyed by `HealthArea` and `HealthStatus`: the call sites build the
 * key from the union (``t(`health.status.${status}`)``), so a member added without words does not compile there.
 */
export const chrome = {
  "chrome.nav": "Navigation",
  "chrome.compose": "Compose",
  "chrome.compose.key": "Compose (C)",
  "chrome.compose.reading": "Still reading which mailboxes you can send from.",
  "chrome.group.mail": "Mail",
  "chrome.group.workspace": "Workspace",
  "chrome.group.automate": "Automate",
  "chrome.group.admin": "Admin",
  /** The sidebar row over Butlers and Rules, and their tabs' name (D2: not the group's word). */
  "chrome.row.automations": "Automations",
  /** Accepted by this Node and not parsed (glossary: accepted, sense b). */
  "chrome.rail.unparsed": "{n} unparsed",
  "chrome.rail.mailbox": "{unclaimed} unclaimed, {claimed} in progress, {mine} mine",
  "chrome.rail.mine": "{n} mine",
  "chrome.drawer.open": "Open navigation",
  "chrome.drawer.close": "Close navigation",

  "chrome.connection.connected": "Connected",
  "chrome.connection.offline": "Offline",
  "chrome.connection.unreachable": "Unreachable",
  "chrome.connection.checking": "Checking…",
  "chrome.status": "Node status",
  "chrome.health.title": "Health",
  "chrome.health.heading": "Health {verdict}",
  "chrome.health.bar": "Health: {verdict}",
  "chrome.health.bar.failed": "Health: could not be read",
  "chrome.health.bar.checking": "Health: checking…",

  "chrome.copied": "Copied",
  /** `{what}` is the caller's noun (`Copyable`'s `label`). */
  "chrome.copy": "Copy {what}",
  /** `{noun}` is the caller's plural noun (`Truncated`'s `noun`); a sentence per noun waits for the callers. */
  "chrome.truncated": "Showing the newest {shown} {noun}. Older ones exist and are not listed.",
  "chrome.nothing.loading": "Reading…",
  "chrome.nothing.failed": "This could not be read. That is different from it being empty.",
  "chrome.nothing.empty": "Nothing here yet.",
  "chrome.nothing.unfiltered": "An empty ledger. Not a filtered one: nothing has been hidden from you.",

  "chrome.notices": "Notifications",
  /** The notices band's noun in `chrome.truncated`. */
  "chrome.notices.noun": "notices",
  "chrome.notice.approval": "You were asked to decide an approval ({kind}).",
  "chrome.notice.an_act": "an act",
  "chrome.notice.request": "request {id}",
  "chrome.notice.asked_by": "asked by {who}",
  "chrome.notice.somebody": "somebody",
  "chrome.notice.a_mailbox": "a mailbox",
  "chrome.notice.unrecorded": "an unrecorded instant",
  "chrome.notice.unrecorded_at": "at an unrecorded instant",
  /** `{scope}` is the grant's scope as the Node recorded it, or `chrome.notice.read`. */
  "chrome.notice.supervised": "{reader} was granted a supervised {scope} of {mailbox}, {from} to {to}.",
  "chrome.notice.read": "read",
  "chrome.notice.queries": { one: "{n} query listing {listed} message(s)", other: "{n} queries listing {listed} message(s)" },
  "chrome.notice.opened": "{n} opened",
  "chrome.notice.raw": "{n} raw message(s) read",
  "chrome.notice.matter": "matter {matter}",
  "chrome.notice.matter.typed": "matter {matter} ({type})",
  "chrome.notice.none_cited": "none cited",
  "chrome.notice.grant": "grant {grant}",

  "health.area.inbound": "Inbound routing",
  "health.area.outbound": "Outbound mail",
  "health.area.worker": "Worker and keys",
  "health.area.storage": "Database and storage",
  "health.area.automation": "Automation",
  "health.area.access": "Access and recovery",
  "health.area.other": "Other checks",
  /** A row's state, and the doctor's verdict (`ok`, `degraded`, `refuse` are both). `refuse`: the deploy gate refuses. */
  "health.status.ok": "ok",
  "health.status.ok-visible": "ok in your checks",
  "health.status.degraded": "degraded",
  "health.status.refuse": "refuse",
  "health.status.report": "report",
  "health.status.absent": "not in your report",
  "health.status.none": "no checks",
  "health.failing": "{status} · {n} failing",
  "health.reduced": "Some checks describe this organisation's mail and are for administrators. The verdict counts them too.",
  "health.checked": "Last health check {at} · {ago}",
  "health.node": "This Node {host}",
  "health.open": "Open Doctor",
  /** `{plus}` is `+` when the Outbox's page is truncated (#91), and empty otherwise. */
  "health.outbound": "Outbound: handed over today {handedOver} · held {held}{plus} · awaiting {awaiting}{plus}",
} as const satisfies Area<"chrome">;
