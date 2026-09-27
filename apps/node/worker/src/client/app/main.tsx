import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { createRoot, type Root } from "react-dom/client";

import { APP_ROUTES, type AppRoute } from "../../app-routes.ts";
import { Shell, tabsOf } from "./chrome.tsx";
import { ShellProvider } from "./shell-context.tsx";
import { SectionTabs } from "./ui/section-tabs.tsx";
import { Drafts } from "./screens/drafts.tsx";
import { Settings } from "./screens/settings.tsx";
import { Inbox } from "./screens/inbox.tsx";
import { Queue } from "./screens/queue.tsx";
import { Agents } from "./screens/agents.tsx";
import { Butlers } from "./screens/butlers.tsx";
import { Approvals } from "./screens/approvals.tsx";
import { Policies } from "./screens/policies.tsx";
import { People } from "./screens/people.tsx";
import { Limits } from "./screens/limits.tsx";
import { Matters } from "./screens/matters.tsx";
import { Audit, Doctor, Log, Outbox } from "./screens/ledgers.tsx";
import { Setup } from "./screens/setup.tsx";
import { Gate } from "./screens/first-run.tsx";

/**
 * The authenticated application (ADR 30).
 *
 * ## What this file is not
 *
 * It is not the whole interface. Sign-in, first-run claim and a locked-out `doctor` are rendered by the
 * **framework-free** script (`src/client/app.client.js`), because they are the screens an operator sees when
 * the Node is broken. Nothing here is reachable until somebody is signed in, and that script imports React
 * dynamically at that moment — so an operator staring at a 500 never downloads a hundred kilobytes of it to
 * find out why. That part works and is the point.
 *
 * ## What this comment used to claim, and did not deliver
 *
 * It said those three screens *"stay **server-rendered** … and must work before any bundle loads"*. They are
 * not server-rendered. `ui.ts` exports `page()`, which ships `<main id="app"></main>` and a script tag; the
 * only thing rendered without JavaScript was the wordmark. Measured by fetching the claim page: 2.4 KB, one
 * word of visible text, no form.
 *
 * So the stated *reason* was sound and the stated *mechanism* was false, on the one screen where the reason
 * matters most — the claim page is the first thing a Node ever shows. There is a `<noscript>` in `page()` now
 * saying so, which is the honest minimum. Actually server-rendering these three is a larger change and a
 * decision, not an omission to fix quietly.
 *
 * ## Routing is code-based on purpose
 *
 * TanStack Router's file-based routing generates a route tree and needs a watcher and a generated file in
 * the tree. Eighteen routes do not earn that, and a generated file nobody reads is the shape this repository
 * has twice been bitten by. The routes are below, where a reader can count them.
 *
 * There is no route-level data loading. Every read is authorization-filtered per request (ADR 11), so a
 * loader that resolved before render would be holding a decision about visibility — which is the same
 * reason ADR 30 ruled out SSR for the shell.
 */

const rootRoute = createRootRoute({
  component: () => (
    /* The provider is outside the gate so the one composer and the toasts exist on every screen, the
       first-run screen included. Until the Node has a routed address, an administrator sees the first-run
       screen and nothing else; the one-line notice in the shell remains for a member, and for an
       administrator who opened the app anyway. */
    <ShellProvider>
      <Gate>
        <Shell />
      </Gate>
    </ShellProvider>
  ),
});

/**
 * Butlers and Rules are one sidebar row, "Automations", and two routes: a tab each, so a bookmark to either
 * still lands on it. The tabs come from the sidebar's own record (`SIDEBAR_HOME`, where Rules is a tab of
 * Butlers), so the two cannot disagree.
 */
const AUTOMATIONS = tabsOf("/butlers");

/**
 * One component per path in `APP_ROUTES`, which the Worker also reads so a deep link returns the page.
 *
 * The mapping is exhaustive by type: `Record<AppRoute, ...>` means adding a route to the shared list and
 * forgetting the screen is a compile error, rather than a route that serves HTML and renders nothing.
 */
const SCREENS: Record<AppRoute, () => React.JSX.Element> = {
  "/": () => <Inbox />,
  "/queue": Queue,
  "/approvals": Approvals,
  "/rules": () => <><SectionTabs label="Automations" tabs={AUTOMATIONS} /><Policies /></>,
  "/people": People,
  "/matters": Matters,
  "/butlers": () => <><SectionTabs label="Automations" tabs={AUTOMATIONS} /><Butlers /></>,
  "/agents": Agents,
  "/limits": Limits,
  "/outbox": Outbox,
  "/audit": Audit,
  "/log": Log,
  "/doctor": Doctor,
  "/setup": Setup,
  "/drafts": Drafts,
  // Archive and Trash are the Inbox with a place: the same list and reader over the caller's own filing (ADR 45).
  "/archive": () => <Inbox place="archive" />,
  "/trash": () => <Inbox place="trash" />,
  "/settings": Settings,
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
