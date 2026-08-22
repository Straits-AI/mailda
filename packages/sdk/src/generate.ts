import { NOT_JSON, ROUTES, type RouteSpec } from "@mailda/contract/routes";
import * as schemas from "@mailda/contract/schemas";

/**
 * Emits the SDK from the contract (#85 step 3, ADR 12).
 *
 * ## Why a generator and not a hand-written client
 *
 * ADR 12's sentence is *"parity is **generated from shared contracts**"*, and the interesting half has
 * always been the last three words. A hand-written SDK would be a sixth surface to keep in step — the exact
 * thing #85's own ticket warns against: *"Building an SDK by hand would add a sixth thing to keep in step
 * and satisfy the letter of the decision while defeating it."*
 *
 * So this reads `ROUTES` and writes `src/generated.ts`, and `pnpm sdk:check` fails on any diff — the same
 * shape `pnpm receipts` and `packages/budgets/src/generated.ts` have used since Layer 1. A generated file
 * that can drift from its generator is a landmine; one a gate re-derives is not.
 *
 * ## Names are derived, never written down
 *
 * The tempting alternative was a `name` field on each `RouteSpec` — readable, and ninety more hand-kept
 * values that can disagree with the path beside them. Instead a name is `<verb><StaticSegments>` with
 * `By<Param>` for each captured one:
 *
 * | route | method |
 * |:--|:--|
 * | `GET /api/butlers` | `getButlers` |
 * | `GET /api/butlers/:butlerId` | `getButlersByButlerId` |
 * | `POST /api/butlers/:butlerId/publish` | `postButlersByButlerIdPublish` |
 *
 * **Verbose, and that is the trade taken deliberately.** `postButlersByButlerIdPublish` is uglier than
 * `butlers.publish`, and it is derived rather than chosen — so it cannot drift, cannot collide silently, and
 * needs no review. The generator **fails** on a collision rather than emitting one, which is the check that
 * makes the scheme trustworthy rather than merely tidy.
 *
 * ## Response types come from the schemas by identity
 *
 * A `RouteSpec` carries the schema *object*, not its name, and a type cannot be looked up by a value. So the
 * generator scans `@mailda/contract/schemas` for the export whose value **is** that object. No new field, no
 * second registry, and a schema that is inlined rather than exported fails here — which is the right
 * pressure: a shape worth putting on a route is a shape worth naming.
 *
 * ## This module writes nothing, and that is a correction
 *
 * It used to end with a top-level `writeFileSync`, so **importing it regenerated the file**. That made the
 * drift test vacuous in a way that took a deliberate hand edit to notice: the test read the file, ran the
 * generator, and compared — but importing `methodNameFor` at the top of the test had already regenerated it,
 * so `before` was never the edited content and the comparison could not fail.
 *
 * Emitting is now pure and `src/write.ts` is the only thing that touches the disk. A module with a top-level
 * side effect is a module that cannot be imported by the thing that checks it.
 */

/**
 * Read through `RouteSpec` rather than off the literal tuple.
 *
 * `ROUTES` is `as const`, so each entry has exactly the fields it carries — the ones without a `response`
 * have no such property to read at all. The same widening `schemaCoverage` needs, and for the same reason.
 */
const ALL: readonly RouteSpec[] = ROUTES;

/** Every exported schema, by the name it is exported under. Used to turn a schema object back into a type. */
const SCHEMA_NAMES = new Map<unknown, string>();
for (const [name, value] of Object.entries(schemas)) {
  if (typeof value === "object" && value !== null) SCHEMA_NAMES.set(value, name);
}

function camel(segment: string): string {
  return segment
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

/** `<verb><StaticSegments>` with `By<Param>` for each captured segment, in path order. */
export function methodNameFor(spec: RouteSpec): string {
  const verb = spec.method.toLowerCase();
  const parts = spec.path.split("/").filter((part) => part.length > 0 && part !== "api");
  const name = parts.map((part) => (part.startsWith(":") ? `By${camel(part.slice(1))}` : camel(part)));
  return verb + name.join("");
}

function parametersOf(spec: RouteSpec): string[] {
  return [...spec.path.matchAll(/:(\w+)/g)].map((match) => match[1]!);
}

function typeOf(schema: unknown): string | null {
  const name = SCHEMA_NAMES.get(schema);
  return name === undefined ? null : `z.infer<typeof S.${name}>`;
}

function emitMethod(spec: RouteSpec): string {
  const name = methodNameFor(spec);
  const params = parametersOf(spec);
  const notJson = NOT_JSON.includes(`${spec.method} ${spec.path}`);

  const requestType = spec.request === undefined ? null : typeOf(spec.request);
  const responseType = notJson ? "Response" : (spec.response === undefined ? "unknown" : typeOf(spec.response));

  const args: string[] = [];
  if (params.length > 0) {
    args.push(`params: { ${params.map((p) => `${p}: string`).join("; ")} }`);
  }
  if (requestType !== null) args.push(`body: ${requestType}`);
  else if (spec.method !== "GET") args.push("body?: unknown");

  const paramsArg = params.length > 0 ? "params" : "{}";
  const bodyArg = args.some((a) => a.startsWith("body")) ? "body" : "undefined";

  /*
   * `Response` for the four `NOT_JSON` routes rather than a parsed shape: they answer the interface shell,
   * stored bytes, submitted bytes and an export object. Handing back the raw `Response` is the only honest
   * signature — a caller wants the body, not a description of it.
   */
  const call = notJson
    ? `return await this.raw("${spec.method}", "${spec.path}", ${paramsArg}, ${bodyArg});`
    : `return await this.json("${spec.method}", "${spec.path}", ${paramsArg}, ${bodyArg}) as ${responseType};`;

  return [
    "  /**",
    `   * ${spec.summary}`,
    "   *",
    `   * \`${spec.method} ${spec.path}\``,
    "   */",
    `  async ${name}(${args.join(", ")}): Promise<${responseType}> {`,
    `    ${call}`,
    "  }",
  ].join("\n");
}

export function emit(): string {
  const seen = new Map<string, string>();
  for (const spec of ALL) {
    const name = methodNameFor(spec);
    const already = seen.get(name);
    if (already !== undefined) {
      /*
       * Fails rather than emitting. Two routes under one method name would silently make one of them
       * unreachable from the SDK — an absence, which is the hardest failure to notice, and the same shape
       * `route-registry.test.ts` guards one level up.
       */
      throw new Error(
        `two routes derive the same SDK method name '${name}': ${already} and `
        + `${spec.method} ${spec.path}. The naming scheme is <verb><StaticSegments>By<Param>, in `
        + "src/generate.ts — extend it rather than renaming a route to dodge the clash.",
      );
    }
    seen.set(name, `${spec.method} ${spec.path}`);
  }

  const missing = ALL
    .filter((spec) => spec.response !== undefined && typeOf(spec.response) === null)
    .map((spec) => `${spec.method} ${spec.path}`);
  if (missing.length > 0) {
    throw new Error(
      `these routes carry a response schema that is not an export of @mailda/contract/schemas, so no type `
      + `can be named for it: ${missing.join(", ")}. Export the schema — a shape worth putting on a route is `
      + "a shape worth naming.",
    );
  }

  return [
    "// GENERATED by @mailda/sdk from packages/contract/src/routes.ts — do not edit.",
    "// One method per route, named <verb><StaticSegments>By<Param>. To change one, change the route and",
    "// re-run `pnpm sdk`. `pnpm sdk:check` fails on any diff. See packages/sdk/src/generate.ts.",
    "",
    'import type * as z from "zod";',
    "",
    'import * as S from "@mailda/contract/schemas";',
    "",
    'import { Transport } from "./transport.ts";',
    "",
    "/**",
    " * Every route this Node serves, as a method.",
    " *",
    " * Generated, so the surface is the contract's and drifts from it only by failing `pnpm sdk:check`.",
    " */",
    "export class GeneratedClient extends Transport {",
    ALL.map(emitMethod).join("\n\n"),
    "}",
    "",
  ].join("\n");
}
