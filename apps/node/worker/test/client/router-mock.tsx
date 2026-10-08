/**
 * The router, as the shell's tests need it: `vi.mock("@tanstack/react-router", () => routerMock(route))`.
 *
 * ## Why a shared mock rather than `Link: ({ children }) => children`
 *
 * That shape renders a link as its text, with no element, no `href`, no class and no `aria-current`, so a
 * test of the sidebar could not see which row is current or whether a row links anywhere, and a mistake in
 * either passed. This one renders what TanStack's `Link` renders for the same props: an `<a href>`, the
 * `className` joined with `activeProps.className` when active, and `data-status="active"` and
 * `aria-current="page"` spread **last**, exactly as the router's own `STATIC_ACTIVE_PROPS` are,
 * so a caller cannot override them there either.
 *
 * Active is the router's default (not `exact`): the path itself, or any path below it, except that `/` is
 * active only on `/`.
 *
 * The state is an object the test owns and may change between renders (use `vi.hoisted` so the factory can
 * see it). `useNavigate` returns `state.navigate`; a click on a link calls it with `{ to }`, as the real link
 * navigates instead of letting the browser load the page. `Outlet` renders `state.outlet`, nothing by default.
 */

export interface RouteState {
  pathname: string;
  /** The address's query, as the router parses it (`?mailbox=…`); none by default. */
  search?: Record<string, string>;
  navigate?: (to: unknown) => void;
  /** What `Outlet` renders: nothing unless a test needs to see where the screen sits in the layout. */
  outlet?: React.ReactNode;
}

function isActive(to: string, pathname: string): boolean {
  return to === pathname || (to !== "/" && pathname.startsWith(`${to}/`));
}

interface LinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
  search?: Record<string, string>;
  activeProps?: React.AnchorHTMLAttributes<HTMLAnchorElement>;
  children?: React.ReactNode;
}

export function routerMock(state: RouteState) {
  function Link({ to, search, activeProps, className, onClick, ...rest }: LinkProps) {
    const active = isActive(to, state.pathname);
    const extra = active ? activeProps ?? { className: "active" } : {};
    const joined = [className, extra.className].filter(Boolean).join(" ");
    return (
      <a
        {...rest}
        {...extra}
        href={search === undefined ? to : `${to}?${new URLSearchParams(search)}`}
        {...(joined === "" ? {} : { className: joined })}
        onClick={(event) => {
          onClick?.(event);
          event.preventDefault();
          state.navigate?.(search === undefined ? { to } : { to, search });
        }}
        {...(active ? { "data-status": "active", "aria-current": "page" as const } : {})}
      />
    );
  }

  const routerState = () => ({ location: { pathname: state.pathname, search: state.search ?? {} } });

  return {
    Link,
    Outlet: () => state.outlet ?? null,
    useNavigate: () => state.navigate ?? (() => {}),
    useRouterState: (options?: { select?: (routerState: { location: { pathname: string; search: Record<string, string> } }) => unknown }) =>
      options?.select === undefined ? routerState() : options.select(routerState()),
  };
}
