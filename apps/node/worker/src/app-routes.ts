/**
 * The application's routes, in one place because two places would drift.
 *
 * The shell routes on the client, so the Worker has to return the page for a deep link or a refresh on
 * `/outbox` — otherwise the first thing anybody does with a URL they bookmarked is get a 404. This list is
 * imported by **both** `index.ts` and `src/client/app/main.tsx`, so a route can only be added once.
 *
 * ## Why not a catch-all
 *
 * The usual shape is "anything that is not /api or /app serves the app". That makes every mistyped URL
 * answer 200 with an interface on it, which is a page claiming to exist when it does not — the same class
 * of dishonesty as an empty ledger that might be an unreadable one. A 404 is a real answer and this Node
 * keeps giving it.
 *
 * ## Why every old path is still here
 *
 * The redesign regrouped the navigation (Rules and Butlers under Automations, the diagnostics under Admin)
 * without renaming or removing a route: a bookmark is a promise, and a redirect would be a second list of
 * routes to keep true. The four added are places of their own: `/drafts`, `/archive` and `/trash` (the Inbox
 * with a place, ADR 45), and `/settings`.
 */
export const APP_ROUTES = [
  "/", "/queue", "/approvals", "/rules", "/people", "/matters", "/butlers", "/agents", "/limits", "/outbox", "/audit",
  "/log", "/doctor", "/setup", "/drafts", "/archive", "/trash", "/settings",
] as const;

export type AppRoute = (typeof APP_ROUTES)[number];

export function isAppRoute(pathname: string): boolean {
  return (APP_ROUTES as readonly string[]).includes(pathname);
}
