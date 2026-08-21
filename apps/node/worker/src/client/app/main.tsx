import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { createRoot, type Root } from "react-dom/client";

import { APP_ROUTES } from "../../app-routes.ts";
import { InstrumentBar, Notices, Rail } from "./chrome.tsx";
import { Inbox } from "./screens/inbox.tsx";
import { Queue } from "./screens/queue.tsx";
import { Butlers } from "./screens/butlers.tsx";
import { Audit, Doctor, Log, Outbox } from "./screens/ledgers.tsx";

/**
 * The authenticated application (ADR 30).
 *
 * ## What this file is not
 *
 * It is not the whole interface. Sign-in, first-run claim and a locked-out `doctor` stay server-rendered
 * with no framework, because they are the screens an operator sees when the Node is broken and they must
 * work before any bundle loads or any binding resolves. Nothing here is reachable until somebody is
 * signed in, and the framework-free script imports it dynamically at that moment — so an operator staring
 * at a 500 never downloads a hundred kilobytes of React to find out why.
 *
 * ## Routing is code-based on purpose
 *
 * TanStack Router's file-based routing generates a route tree and needs a watcher and a generated file in
 * the tree. Five routes do not earn that, and a generated file nobody reads is the shape this repository
 * has twice been bitten by. The routes are below, where a reader can count them.
 *
 * There is no route-level data loading. Every read is authorization-filtered per request (ADR 11), so a
 * loader that resolved before render would be holding a decision about visibility — which is the same
 * reason ADR 30 ruled out SSR for the shell.
 */

const rootRoute = createRootRoute({
  component: () => (
    <div className="app-shell">
      <Rail />
      {/* A div, not a `main`. The mount point is `<main id="app">`, and a second `main` landmark inside
          it is exactly the structural defect axe exists to catch — found by reading the tree of the
          running shell, not by thinking about it. */}
      <div className="app-main">
        {/* Above whatever screen a person came for, because §7's notice is one they must actually meet —
            and on every route rather than one, because there is no route somebody must visit to be told. */}
        <Notices />
        <Outlet />
      </div>
      <InstrumentBar />
    </div>
  ),
});

/**
 * One component per path in `APP_ROUTES`, which the Worker also reads so a deep link returns the page.
 *
 * The mapping is exhaustive by type: `Record<AppRoute, ...>` means adding a route to the shared list and
 * forgetting the screen is a compile error, rather than a route that serves HTML and renders nothing.
 */
const SCREENS: Record<(typeof APP_ROUTES)[number], () => React.JSX.Element> = {
  "/": Inbox,
  "/queue": Queue,
  "/butlers": Butlers,
  "/outbox": Outbox,
  "/audit": Audit,
  "/log": Log,
  "/doctor": Doctor,
};

const routes = APP_ROUTES.map((path) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: SCREENS[path] }));

const router = createRouter({ routeTree: rootRoute.addChildren(routes) });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // One retry, not the default three. A failed read here is usually a real answer — revoked access, a
      // binding that is gone — and retrying it three times turns a clear failure into a slow one.
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

let root: Root | null = null;

/**
 * Mounts the application into an element the framework-free script already owns.
 *
 * Idempotent, because the script may call it on load *and* on a later sign-in, and two roots over one
 * element would render the shell twice.
 */
export function mount(element: HTMLElement): void {
  if (root !== null) return;
  root = createRoot(element);
  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/**
 * Unmounts, so signing out returns the page to the framework-free surface rather than leaving a shell
 * whose every request now 401s. The caller owns what replaces it.
 */
export function unmount(): void {
  root?.unmount();
  root = null;
  queryClient.clear();
}
