import { describe, expect, it } from "vitest";

import { astSha256, canonicalButlerJson, canonicalJson } from "../src/canonical.ts";
import { checkButler } from "../src/check.ts";
import type { Butler } from "../src/ast.ts";
import { leadIntake, withReversedKeys } from "./fixture.ts";

/**
 * Canonical serialization, proved in both directions (#49, ADR 35, #60).
 *
 * The refusal it exists for is "a publish that changes nothing is refused", and that refusal is wrong in
 * two different ways if this function is wrong in two different ways:
 *
 *   too loose  — key order changes the bytes, so a reformatted AST mints a version representing no decision.
 *   too tight  — a field is dropped, so a real change does **not** change the bytes and a frozen version's
 *                content moved underneath its own fingerprint.
 *
 * A test for the first is easy and is the one everybody writes. The second is the dangerous one, and the
 * only way to test it without hand-listing every field — which would be the same omission risk one level
 * up — is to walk the fixture and mutate every leaf. That is what `everyLeafPath` does.
 */

function checked(input: unknown): Butler {
  const result = checkButler(input);
  if (!result.ok) throw new Error(`fixture does not check: ${JSON.stringify(result.findings)}`);
  return result.ast;
}

/** Every path to a scalar in a JSON value, as an array of keys and indices. */
function everyLeafPath(value: unknown, prefix: Array<string | number> = []): Array<Array<string | number>> {
  if (Array.isArray(value)) return value.flatMap((item, index) => everyLeafPath(item, [...prefix, index]));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, item]) => everyLeafPath(item, [...prefix, key]));
  }
  return [prefix];
}

function at(root: unknown, path: Array<string | number>): unknown {
  return path.reduce<unknown>((node, step) => (node as Record<string | number, unknown>)[step], root);
}

function withMutation(root: unknown, path: Array<string | number>, replacement: unknown): unknown {
  const clone = structuredClone(root) as Record<string | number, unknown>;
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1]!;
  const parent = parentPath.reduce<unknown>(
    (node, step) => (node as Record<string | number, unknown>)[step],
    clone,
  ) as Record<string | number, unknown>;
  parent[last] = replacement;
  return clone;
}

describe("canonical serialization (#49)", () => {
  it("is identical for two objects differing only in key order", () => {
    // Asserted on the function directly, and the reason is a finding rather than a preference: Zod's object
    // parse rebuilds its output in *schema* order, so two ASTs that went through `checkButler` already
    // agree on the order of every declared field. Testing key-order independence only through Zod would
    // therefore pass with this function deleted — a vacuous green, and the check would be measuring the
    // library rather than the code. Relying on that normalisation is also exactly the landmine this
    // function exists to remove: it is an implementation detail of somebody else's parser, load-bearing on
    // whether a frozen version is comparable to itself.
    const forward = { apiVersion: "mailda/v1", kind: "Butler", entry: "a" };
    const reversed = withReversedKeys(forward);
    expect(Object.keys(reversed)).toEqual(["entry", "kind", "apiVersion"]);
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(forward));

    expect(canonicalJson(reversed)).toBe(canonicalJson(forward));
  });

  it("is identical for two checked ASTs whose one order-preserving field differs in order", async () => {
    // The load-bearing case inside a real AST. `validate.schema` is a record of unknown, so its keys are
    // whatever the author wrote in whatever order they wrote them — Zod passes them through untouched, and
    // `JSON.stringify` of the parsed result differs. This is the one place a reformatted document would
    // otherwise mint a version representing no decision.
    const withSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
      const ast = leadIntake();
      const nodes = ast["nodes"] as Array<Record<string, unknown>>;
      nodes.push({ id: "shape", type: "validate", value: "${event.body}", schema, next: null });
      (nodes.find((node) => node["id"] === "propose")!)["next"] = "shape";
      return ast;
    };
    const forward = checked(withSchema({ type: "object", required: ["name"] }));
    const reversed = checked(withSchema({ required: ["name"], type: "object" }));

    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(forward));
    expect(canonicalButlerJson(reversed)).toBe(canonicalButlerJson(forward));
    expect(await astSha256(reversed)).toBe(await astSha256(forward));
  });

  it("gives a reordered document the same digest, which is what the publish refusal compares", async () => {
    expect(await astSha256(checked(withReversedKeys(leadIntake()))))
      .toBe(await astSha256(checked(leadIntake())));
  });

  it("treats null and absent identically, because they mean the same thing", () => {
    const withNull = leadIntake();
    const withAbsent = leadIntake();
    const nodes = withAbsent["nodes"] as Array<Record<string, unknown>>;
    const propose = nodes.find((node) => node["id"] === "propose")!;
    expect(propose["next"]).toBeNull();
    delete propose["next"];

    expect(canonicalButlerJson(checked(withAbsent))).toBe(canonicalButlerJson(checked(withNull)));
  });

  it("changes for every single leaf in the document, so nothing is silently dropped", () => {
    const ast = checked(leadIntake());
    const baseline = canonicalButlerJson(ast);
    const paths = everyLeafPath(ast);

    // Anti-vacuity: an extractor that found nothing would make this loop pass by not running.
    expect(paths.length).toBeGreaterThan(30);

    const unmoved: string[] = [];
    for (const path of paths) {
      const current = at(ast, path);
      // A replacement of a different type is enough — the question is whether the byte stream depends on
      // this position at all, not whether it depends on it correctly.
      const replacement = typeof current === "number" ? (current as number) + 1
        : typeof current === "boolean" ? !current
        : current === null ? "not_null_any_more"
        : `${String(current)}!`;
      if (canonicalJson(withMutation(ast, path, replacement)) === baseline) unmoved.push(path.join("."));
    }
    expect(unmoved, "a leaf the canonical bytes do not depend on is a field that can change under a frozen version")
      .toEqual([]);
  });

  it("keeps array order, because an array in this AST is a sequence with meaning", () => {
    const forward = canonicalJson({ to: ["a@example.net", "b@example.net"] });
    const swapped = canonicalJson({ to: ["b@example.net", "a@example.net"] });
    expect(swapped).not.toBe(forward);
  });

  it("refuses a non-integer rather than picking a spelling for it", () => {
    expect(() => canonicalJson({ n: 0.1 })).toThrow(/E_CANONICAL_NON_INTEGER/);
    expect(() => canonicalJson({ n: -0 })).toThrow(/E_CANONICAL_NON_INTEGER/);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/E_CANONICAL_NON_INTEGER/);
    // And an integer is fine, so the guard is not simply refusing every number.
    expect(canonicalJson({ n: 200 })).toBe('{"n":200}');
  });

  it("refuses a value JSON cannot carry", () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/E_CANONICAL_UNSUPPORTED/);
  });

  it("emits no whitespace, so the bytes are the bytes", () => {
    expect(canonicalButlerJson(checked(leadIntake()))).not.toMatch(/[\n\t]| {2}/);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
