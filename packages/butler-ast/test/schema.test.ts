import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { butlerJsonSchema } from "../src/ast.ts";
import { checkButler } from "../src/check.ts";
import { NODE_KIND_NAMES } from "../src/nodes.ts";
import { leadIntake, withLoop } from "./fixture.ts";

/**
 * The emitted JSON Schema, checked against the Zod it came from.
 *
 * `packages/contract`'s equivalence test established why this matters: an emitted contract that is *more
 * permissive* than the server is a client that is told yes and then refused. The one divergence that test
 * found — `maxLength` counting code points while Zod counts UTF-16 units — cannot occur here, because this
 * package writes no `.max()` at all (see `ast.ts`'s header). So the check is the other half: does the
 * emitted schema accept and reject the same documents the runtime does?
 *
 * Emission itself is worth asserting. `z.toJSONSchema` throws on constructs it cannot represent — that is
 * how #3's "no `z.date()`" constraint is enforced rather than remembered — so a schema that emits at all is
 * a schema every field of which is expressible in draft-2020-12.
 */

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validate = ajv.compile(butlerJsonSchema);

describe("the emitted JSON Schema (draft 2020-12)", () => {
  it("compiles, which is what proves every construct is representable", () => {
    expect(typeof validate).toBe("function");
  });

  it("declares every node type in the union, reserved ones included", () => {
    const text = JSON.stringify(butlerJsonSchema);
    for (const kind of NODE_KIND_NAMES) {
      expect(text, kind).toContain(JSON.stringify(kind));
    }
  });

  it("accepts what the checker accepts", () => {
    for (const fixture of [leadIntake(), withLoop(200)]) {
      expect(checkButler(fixture).ok).toBe(true);
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("accepts a reserved node, because reserving is not omitting", () => {
    const ast = leadIntake();
    (ast["nodes"] as unknown[]).push({ id: "classify", type: "llm.classify", profile: "p@1" });
    // The schema is the *language*; the refusal is the checker's. A client validating against this schema
    // learns its document is well-formed and learns from the Node that it will not be published.
    expect(validate(ast), JSON.stringify(validate.errors)).toBe(true);
    expect(checkButler(ast).ok).toBe(false);
  });

  it("rejects what the schema can see is wrong", () => {
    expect(validate({ apiVersion: "mailda/v2", kind: "Butler" })).toBe(false);
    expect(validate({ ...leadIntake(), nodes: [] })).toBe(false);
    // A loop with no bound: the one thing the schema and the checker both refuse, from different angles.
    const unbounded = withLoop(200);
    delete ((unbounded["nodes"] as Array<Record<string, unknown>>)
      .find((node) => node["id"] === "fan_out")!)["maxItems"];
    expect(validate(unbounded)).toBe(false);
    expect(checkButler(unbounded).ok).toBe(false);
  });

  it("cannot express acyclicity, which is why the checker owns it", () => {
    // Stated as a check rather than a comment: a cyclic Butler is *valid* against the schema and refused by
    // the checker. If a future emitter claimed to express this, that claim would be a guarantee living
    // where it does not hold.
    const cyclic = leadIntake();
    (cyclic["nodes"] as unknown[]).push({ id: "spin", type: "transform", as: "n", value: "1", next: "spin" });
    expect(validate(cyclic), JSON.stringify(validate.errors)).toBe(true);
    expect(checkButler(cyclic).ok).toBe(false);
  });
});
