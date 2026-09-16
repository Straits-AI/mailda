import type { Ctx } from "@mailda/runtime";
import { METHOD_UNCHECKED, ROUTES, type Registered } from "@mailda/contract/routes";

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
 * What the router does *not* do is decide authority. Each handler still establishes its own principal and
 * consults its own gates, and `route-authority-parity.test.ts` drives every declared authority live. Moving
 * that into the table is the next cut, and it needs the fifty-one routes with no `authority` classified
 * first — which is a set of decisions, not a refactor.
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

/** Everything a handler is handed. `params` are the registry's `:name` segments, raw (not decoded). */
export interface Call<K extends RouteKey = RouteKey> {
  readonly request: Request;
  readonly env: Env;
  readonly ctx: ExecutionContext;
  readonly clock: Ctx;
  readonly url: URL;
  readonly params: ParamsOf<K>;
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
export function resolve(method: string, pathname: string): { key: RouteKey; params: Record<string, string> } | null {
  for (const one of COMPILED) {
    if (one.exact === pathname && (one.anyMethod || one.method === method)) return { key: one.key, params: {} };
  }
  for (const one of COMPILED) {
    if (one.pattern === null || !(one.anyMethod || one.method === method)) continue;
    const match = one.pattern.exec(pathname);
    if (match === null) continue;
    const params: Record<string, string> = {};
    one.names.forEach((name, index) => { params[name] = match[index + 1]!; });
    return { key: one.key, params };
  }
  return null;
}

/** The registry's parameterised templates, for the test that checks no two can match one path. */
export const TEMPLATES: readonly { key: RouteKey; pattern: RegExp | null }[] =
  COMPILED.map((one) => ({ key: one.key, pattern: one.pattern }));
