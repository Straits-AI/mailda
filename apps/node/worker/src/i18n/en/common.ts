import type { AppRoute } from "../../app-routes.ts";
import type { Area } from "../areas.ts";

/** Every route's name, one per `AppRoute`: a route added without one is a compile error here. */
type RouteWords = { readonly [R in AppRoute as `route.${R}`]: string };

/**
 * Words more than one screen uses. `route.*` are the navigation's names for each route, which the per-route
 * `<title>` (WCAG 2.4.2), the sidebar, the palette and the narrow layout's bar read.
 */
export const common = {
  "route./": "Inbox",
  "route./queue": "Queue",
  "route./approvals": "Approvals",
  "route./rules": "Rules",
  "route./people": "People",
  "route./matters": "Matters",
  "route./butlers": "Butlers",
  "route./agents": "Agents",
  "route./limits": "Limits",
  "route./outbox": "Outbox",
  "route./audit": "Audit",
  "route./log": "Log",
  "route./doctor": "Doctor",
  "route./setup": "Setup",
  "route./drafts": "Drafts",
  "route./archive": "Archive",
  "route./trash": "Trash",
  "route./settings": "Settings",
  /** The document title on every signed-in screen: the screen, then the product. */
  "title.route": "{screen} · {brand}",
} as const satisfies RouteWords & Area<"common">;
