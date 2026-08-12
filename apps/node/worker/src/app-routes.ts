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
 */
export const APP_ROUTES = ["/", "/queue", "/outbox", "/audit", "/log", "/doctor"] as const;

export type AppRoute = (typeof APP_ROUTES)[number];

export function isAppRoute(pathname: string): boolean {
  return (APP_ROUTES as readonly string[]).includes(pathname);
}
