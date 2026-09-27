/**
 * The interface's icons: local SVG, drawn here, no dependency (the CSP allows no CDN, and an icon package
 * would be the bundle's largest dependency after React for thirty-five glyphs).
 *
 * One size, 16px, and one stroke, so every icon sits on the same grid beside 14px text. An icon is
 * decoration unless it is the only thing naming its control: `aria-hidden` by default, and `role="img"` with
 * a `<title>` only when `label` is given. A button that shows an icon alone takes its name from its own
 * `aria-label` instead, which is what most callers want.
 */

export type IconName =
  | "compose" | "inbox" | "queue" | "drafts" | "outbox" | "archive" | "trash" | "mailbox"
  | "people" | "matters" | "approvals" | "automations" | "agents" | "admin" | "settings"
  | "search" | "filter" | "reply" | "reply-all" | "forward" | "assign" | "more" | "chevron-down" | "chevron-right"
  | "back" | "menu" | "close" | "health" | "headers" | "download" | "undo"
  | "limits" | "audit" | "log" | "setup";

/** A `Record`, so an icon named in `IconName` without a drawing is a compile error rather than a blank. */
const PATHS: Record<IconName, React.JSX.Element> = {
  compose: <><path d="M9.5 3.5h-6v9h9v-6" /><path d="M7 9l.5-2 5-5 1.5 1.5-5 5z" /></>,
  inbox: <><path d="M2.5 9.5l1.5-6h8l1.5 6v3h-11z" /><path d="M2.5 9.5h3.5l.5 1.5h3l.5-1.5h3.5" /></>,
  queue: <><path d="M3 4.5h10M3 8h10M3 11.5h6" /></>,
  drafts: <><path d="M4 2.5h5.5l3 3v8h-8.5z" /><path d="M9.5 2.5v3h3M6 9h4.5M6 11.5h3" /></>,
  outbox: <><path d="M2.5 9.5v3h11v-3" /><path d="M8 10V2.5M5 5.5l3-3 3 3" /></>,
  archive: <><path d="M2.5 3h11v3h-11z" /><path d="M3.5 6v7h9V6M6.5 8.5h3" /></>,
  trash: <><path d="M2.5 4.5h11M6 4.5V3h4v1.5" /><path d="M4 4.5l.6 9h6.8l.6-9M6.8 7v4.5M9.2 7v4.5" /></>,
  mailbox: <><path d="M2.5 4h11v8.5h-11z" /><path d="M2.5 4.5L8 8.5l5.5-4" /></>,
  people: <><circle cx="6" cy="5.5" r="2.5" /><path d="M1.5 13.5c.5-2.5 2.2-3.5 4.5-3.5s4 1 4.5 3.5" /><path d="M10.5 3.2a2.4 2.4 0 010 4.6M12 10.3c1.3.5 2.1 1.5 2.5 3.2" /></>,
  matters: <><path d="M2.5 4.5h4l1.5 1.5h5.5v7h-11z" /></>,
  approvals: <><path d="M3 8.5l3 3 7-7" /></>,
  automations: <><path d="M8.5 1.5l-5 7.5h4l-.5 5.5 5-7.5h-4z" /></>,
  agents: <><rect x="3" y="5" width="10" height="8" rx="2" /><path d="M8 5V2.5M6 9h.01M10 9h.01" /></>,
  admin: <><path d="M8 1.5l5.5 2v4c0 3.3-2.3 5.8-5.5 7-3.2-1.2-5.5-3.7-5.5-7v-4z" /></>,
  settings: <><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5l3 3" /></>,
  filter: <><path d="M2 3.5h12M4.5 8h7M7 12.5h2" /></>,
  reply: <><path d="M6.5 3.5L2.5 7.5l4 4" /><path d="M2.5 7.5h6.5c2.5 0 4.5 2 4.5 4.5v1" /></>,
  "reply-all": <><path d="M5.5 3.5l-4 4 4 4" /><path d="M8.5 3.5l-4 4 4 4" /><path d="M4.5 7.5h5c2.2 0 4 1.8 4 4v1.5" /></>,
  forward: <><path d="M9.5 3.5l4 4-4 4" /><path d="M13.5 7.5H7c-2.5 0-4.5 2-4.5 4.5v1" /></>,
  assign: <><circle cx="6" cy="5.5" r="2.5" /><path d="M1.5 13.5c.5-2.5 2.2-3.5 4.5-3.5 1.1 0 2 .2 2.8.7M10 11.5h4.5M12.5 9.5l2 2-2 2" /></>,
  more: <><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.5} /></>,
  "chevron-down": <><path d="M4 6l4 4 4-4" /></>,
  "chevron-right": <><path d="M6 4l4 4-4 4" /></>,
  back: <><path d="M13 8H3M7 4L3 8l4 4" /></>,
  menu: <><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></>,
  close: <><path d="M4 4l8 8M12 4l-8 8" /></>,
  health: <><path d="M1.5 8.5h3l1.5-4 3 8 1.5-4h4" /></>,
  headers: <><path d="M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5" /></>,
  download: <><path d="M8 2.5v8M5 7.5l3 3 3-3" /><path d="M2.5 11v2.5h11V11" /></>,
  undo: <><path d="M5.5 3.5L2.5 6.5l3 3" /><path d="M2.5 6.5h7a4 4 0 010 8H7" /></>,
  limits: <><path d="M2.5 11.5a5.5 5.5 0 0111 0" /><path d="M8 11.5l2.5-3.5" /></>,
  audit: <><path d="M8 1.5l5.5 2v4c0 3.3-2.3 5.8-5.5 7-3.2-1.2-5.5-3.7-5.5-7v-4z" /><path d="M5.5 8l2 2 3-3.5" /></>,
  log: <><path d="M3 3.5h.01M3 8h.01M3 12.5h.01M6 3.5h7M6 8h7M6 12.5h7" /></>,
  setup: <><path d="M10 2.5a3.5 3.5 0 00-3.3 4.6L2.5 11.3v2.2h2.2l4.2-4.2A3.5 3.5 0 1010 2.5z" /></>,
};

export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      {label === undefined ? null : <title>{label}</title>}
      {PATHS[name]}
    </svg>
  );
}
