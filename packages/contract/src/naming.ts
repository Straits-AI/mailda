import type { RouteSpec } from "./routes.ts";

/**
 * One name per route, derived — the vocabulary every generated surface speaks (#85, #88, #89).
 *
 * ## Why this is in the contract and not in the SDK
 *
 * It started in `packages/sdk/src/generate.ts`, which is where the first consumer needed it. Then the Skill
 * needed the same names, and then the MCP server did — and an MCP tool called `GET_api_messages` beside a
 * Skill that says `getMessages` would have an agent reading two spellings of one thing and inferring they
 * were different surfaces.
 *
 * So it moved here. A name is part of what a route *is*, not part of how one client happens to render it.
 *
 * ## The scheme
 *
 * `<verb><StaticSegments>` with `By<Param>` for each captured segment, in path order:
 *
 * | route | name |
 * |:--|:--|
 * | `GET /api/butlers` | `getButlers` |
 * | `GET /api/butlers/:butlerId` | `getButlersByButlerId` |
 * | `POST /api/butlers/:butlerId/publish` | `postButlersByButlerIdPublish` |
 *
 * **Verbose, and the trade is deliberate.** `postButlersByButlerIdPublish` is uglier than `butlers.publish`
 * and it is *derived* rather than chosen — so it cannot drift from the path beside it, cannot collide
 * silently, and needs no review. The alternative was a `name` field per route: ninety more hand-kept values
 * that can disagree with the route they sit on.
 *
 * `/api` is dropped because every route but five carries it, and a prefix on every name is a prefix that
 * distinguishes nothing.
 */

function camel(segment: string): string {
  return segment
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

export function methodNameFor(spec: RouteSpec): string {
  const verb = spec.method.toLowerCase();
  const parts = spec.path.split("/").filter((part) => part.length > 0 && part !== "api");
  return verb + parts
    .map((part) => (part.startsWith(":") ? `By${camel(part.slice(1))}` : camel(part)))
    .join("");
}
