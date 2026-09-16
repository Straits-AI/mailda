import type { Ctx } from "@mailda/runtime";
import type { Authority } from "@mailda/contract/authority";
import { METHOD_UNCHECKED, ROUTES, type Registered } from "@mailda/contract/routes";

import type { Principal } from "./authz-read.ts";

/**
 * The registry is the router.
 *
 * `index.ts` used to decide every route in one function of a hundred and twenty-four sequential `if`s, each
 * naming a path the registry in `packages/contract` also named — and a test (`route-registry.test.ts`) read
 * the source with regular expressions to check that the two lists agreed. Here the agreement is a type:
 * `Handlers` is `Record<RouteKey, Handler>` over every `"METHOD /path"` the registry declares, so a route
 * with no handler is a compile error and a handler for an unregistered route is one too. Nothing reads
 * source text to know what the Node serves.
 *
 * Path parameters are **named**, from the registry's own `:name` segments, rather than captured positionally
 * by a regular expression beside each handler. `path()` in the registry builds a URL from the same names, so
 * the client, the SDK and the handler now agree on what a segment is called by construction.
 *
 * **The principal is the router's, too.** Every registered route declares an `authority`, and for any scope
 * but `public` and `recovery` the router looks the principal up once and answers `401` if there is none —
 * so a handler is handed `who` rather than beginning with the same two lines a hundred and ten others
 * began with, and a route nobody classified cannot be served. What a principal may *do* is still the
 * handler's question, asked of `assertAdmin`, `maySend` and their kind; `route-authority-parity.test.ts`
 * drives every declared authority live to hold the declaration to the code.
 */

export type RouteKey = Registered extends infer R
  ? R extends { method: string; path: string } ? `${R["method"]} ${R["path"]}` : never
  : never;

/**
 * The parameters one route's path declares, as a type: `"GET /api/drafts/:draftId"` yields `{ draftId: string }`.
 * So a handler reading `params.draftid` is a compile error, and one reading a segment its route does not
 * have is too — the positional `match[1]!` this replaced could be wrong in both ways and compile in both.
 */
export type ParamsOf<K extends string> =
  K extends `${string}:${infer Name}/${infer Rest}` ? { readonly [N in Name]: string } & ParamsOf<`/${Rest}`>
  : K extends `${string}:${infer Name}` ? { readonly [N in Name]: string }
  : Record<never, never>;

/** The authority one route declares, as a type, so `who` can be typed by whether the route needs one. */
type AuthorityOf<K extends string> = Registered extends infer R
  ? R extends { method: string; path: string; authority: Authority }
    ? K extends `${R["method"]} ${R["path"]}` ? R["authority"] : never
    : never
  : never;

/**
 * Who is calling: a `Principal` on every route that requires one, established by the router before the
 * handler runs. `null` only where the registry says the route is open — `public`, and `recovery`, whose one
 * route (`/api/doctor`) decides for itself whether a locked-out operator may read a reduced report.
 */
export type WhoOf<K extends string> = AuthorityOf<K> extends { scope: "public" | "recovery" }
  ? Principal | null
  : Principal;

/** Everything a handler is handed. `params` are the registry's `:name` segments, raw (not decoded). */
export interface Call<K extends RouteKey = RouteKey> {
  readonly request: Request;
  readonly env: Env;
  readonly ctx: ExecutionContext;
  readonly clock: Ctx;
  readonly url: URL;
  readonly params: ParamsOf<K>;
  readonly who: WhoOf<K>;
  /** The whole Worker again, for `/mcp`, whose tool calls are requests to this Node's own routes. */
  readonly reenter: (inner: Request) => Promise<Response>;
}

export type Handler<K extends RouteKey = RouteKey> = (call: Call<K>) => Promise<Response>;
export type Handlers = { readonly [K in RouteKey]: Handler<K> };

/**
 * The same shape one domain file contributes. `satisfies Partial<Handlers>` at each site is what refuses a
 * key the registry does not know; `Handlers` at the assembly is what refuses a key nobody provided.
 */
export type Some = Readonly<Partial<Handlers>>;

interface Compiled {
  readonly key: RouteKey;
  readonly open: boolean;
  readonly method: string;
  readonly anyMethod: boolean;
  readonly exact: string | null;
  readonly pattern: RegExp | null;
  readonly names: readonly string[];
}

const COMPILED: readonly Compiled[] = ROUTES.map((spec) => {
  const names = [...spec.path.matchAll(/:(\w+)/g)].map((match) => match[1]!);
  const pattern = names.length === 0 ? null : new RegExp(
    `^${spec.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "([^/]+)")}$`,
  );
  return {
    key: `${spec.method} ${spec.path}` as RouteKey,
    open: spec.authority.scope === "public" || spec.authority.scope === "recovery",
    method: spec.method,
    // Five paths answer regardless of verb (`METHOD_UNCHECKED`): a `HEAD /health` from a load balancer and
    // a `GET /api/me` from a browser must not be told the route does not exist.
    anyMethod: METHOD_UNCHECKED.includes(spec.path),
    exact: names.length === 0 ? spec.path : null,
    pattern,
    names,
  };
});

/**
 * Finds the registered route for a request, exact paths before parameterised ones.
 *
 * Exact-first is the one precedence rule, and it is the rule `specFor` in the registry already applies:
 * `/api/mailboxes/readable` is served by its own handler and never captured as `:mailboxId`. Two
 * parameterised templates that could both match one path would be a registry defect, and
 * `test/node/route-table.test.ts` refuses that shape rather than leaving it to declaration order.
 */
export interface Resolved {
  readonly key: RouteKey;
  readonly params: Record<string, string>;
  /** Whether the route is served without a principal (`public` or `recovery`). */
  readonly open: boolean;
}

export function resolve(method: string, pathname: string): Resolved | null {
  for (const one of COMPILED) {
    if (one.exact === pathname && (one.anyMethod || one.method === method)) {
      return { key: one.key, params: {}, open: one.open };
    }
  }
  for (const one of COMPILED) {
    if (one.pattern === null || !(one.anyMethod || one.method === method)) continue;
    const match = one.pattern.exec(pathname);
    if (match === null) continue;
    const params: Record<string, string> = {};
    one.names.forEach((name, index) => { params[name] = match[index + 1]!; });
    return { key: one.key, params, open: one.open };
  }
  return null;
}

/** The registry's parameterised templates, for the test that checks no two can match one path. */
export const TEMPLATES: readonly { key: RouteKey; pattern: RegExp | null }[] =
  COMPILED.map((one) => ({ key: one.key, pattern: one.pattern }));
