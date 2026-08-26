import { ROUTES, type RouteSpec } from "@mailda/contract/routes";

/**
 * Every closed set the contract declares on a request body, read out of the schemas themselves (#93).
 *
 * ## Why this is reflection rather than a list
 *
 * The failure #93 is about is a route that **has** a schema and never applies it, which reads exactly like a
 * route that is covered. A hand-written list of "the strict objects" would have the same property: it would
 * look like a closed world and stop being one the moment somebody added the seventh. So the sets are found by
 * walking the schemas, and the tests over this walk are what make "every closed set is enforced" a fact.
 *
 * Two files need it — `test/node/request-shape-world.test.ts` proves the boundary function refuses each set,
 * `test/request-shape.test.ts` proves a real Node does — so it lives here rather than twice.
 *
 * ## The one thing it does not do
 *
 * It reads Zod's internal `def`, which is not a public API. That is deliberate for a tripwire: reading the
 * schema the way the boundary reads it is the point, and if Zod's internals move, both fail together and
 * loudly rather than one of them quietly agreeing with nothing.
 */

/** One position in a request body where an unrecognised key is refused. */
export interface ClosedSet {
  /** The route it belongs to. */
  readonly spec: RouteSpec;
  /** Where in the body the object sits: `["conditions"]`, `["stages", 0]`, `[]` for the body itself. */
  readonly path: readonly PropertyKey[];
  /** The fields it does have, in declaration order. */
  readonly known: readonly string[];
  /** The `E_` code its refusal should carry, from `.meta({ refusal })`, or undefined if it declares none. */
  readonly refusal: string | undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Zod's `def` is untyped; every read below is tagged. */
type Node = { readonly def: any; meta: () => Record<string, unknown> | undefined };

const TRANSPARENT = new Set(["optional", "nullable", "nonoptional", "default", "prefault", "readonly", "catch"]);

function unwrap(node: Node): Node {
  let at = node;
  while (TRANSPARENT.has(at.def?.type as string)) at = at.def.innerType as Node;
  return at;
}

/*
 * No cycle guard, and that is a property of the walk rather than an omission: every branch below descends
 * into a *child* schema, and the one Zod node that can point back at itself — `lazy` — matches no branch
 * and ends the walk. A `seen` set would also be wrong here: it would silently drop a shared schema's second
 * position, which is the same absence-shaped failure this file exists to catch.
 */
function walk(spec: RouteSpec, node: Node, path: readonly PropertyKey[]): ClosedSet[] {
  const at = unwrap(node);
  const def = at.def;
  const found: ClosedSet[] = [];

  if (def?.type === "object") {
    // `catchall` is `never` exactly when `.strict()` was called: an unknown key has nowhere to go.
    if (def.catchall?.def?.type === "never") {
      const meta = at.meta()?.["refusal"];
      found.push({
        spec, path,
        known: Object.keys(def.shape as Record<string, unknown>),
        refusal: typeof meta === "string" ? meta : undefined,
      });
    }
    for (const [key, child] of Object.entries(def.shape as Record<string, Node>)) {
      found.push(...walk(spec, child, [...path, key]));
    }
  } else if (def?.type === "array") {
    // Index 0, because the position is what a probe body has to reproduce and one element is enough to
    // reach the element schema.
    found.push(...walk(spec, def.element as Node, [...path, 0]));
  } else if (def?.type === "record") {
    found.push(...walk(spec, def.valueType as Node, [...path, "any"]));
  } else if (def?.type === "union") {
    for (const option of def.options as Node[]) found.push(...walk(spec, option, path));
  }
  return found;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Every route that describes what it accepts. */
export function routesWithRequestSchema(): readonly RouteSpec[] {
  return (ROUTES as readonly RouteSpec[]).filter((spec) => spec.request !== undefined);
}

/** Every closed set on every route that declares one. */
export function closedSets(): readonly ClosedSet[] {
  return routesWithRequestSchema()
    .flatMap((spec) => walk(spec, spec.request as unknown as Node, []));
}

/** The key a probe puts where it does not belong. Spelled so no schema could ever legitimately have it. */
export const PROBE_FIELD = "mailda_probe_field";

/**
 * A body carrying exactly one unrecognised key, at the position a closed set occupies.
 *
 * A number in the path builds an array and a string builds an object, which is the same correspondence the
 * boundary walks in the other direction. Nothing else is filled in: a missing required field is not this
 * check's business, and the boundary deliberately leaves those to the handler's own refusal.
 */
export function probeBody(path: readonly PropertyKey[]): unknown {
  let value: unknown = { [PROBE_FIELD]: "x" };
  for (const key of [...path].reverse()) {
    value = typeof key === "number" ? [value] : { [String(key)]: value };
  }
  return value;
}
