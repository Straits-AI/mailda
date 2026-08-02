import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import * as z from "zod";

/**
 * Guards the correctness finding in docs/receipts/runtime-validator.md.
 *
 * `z.string().max(n)` counts UTF-16 code units; JSON Schema `maxLength: n` counts
 * Unicode code points. They are different constraints, so the emitted contract is more
 * permissive than the server for any string containing astral characters.
 *
 * This test asserts the divergence still exists rather than pretending it does not. When
 * the catalog's emitter is fixed (tracked on #3), this test should start failing — and
 * that failure is the signal to update it, not to delete it.
 */
describe("maxLength semantics (receipt: runtime-validator)", () => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);

  it("JSON Schema counts code points; Zod counts UTF-16 units", () => {
    const tenEmoji = "🙂".repeat(10);
    expect([...tenEmoji].length).toBe(10);
    expect(tenEmoji.length).toBe(20);

    expect(ajv.compile({ type: "string", maxLength: 15 })(tenEmoji)).toBe(true);
    expect(z.string().max(15).safeParse(tenEmoji).success).toBe(false);
  });

  it("agrees for BMP-only strings, which is why this is easy to miss", () => {
    const plain = "x".repeat(15);
    expect(ajv.compile({ type: "string", maxLength: 15 })(plain)).toBe(true);
    expect(z.string().max(15).safeParse(plain).success).toBe(true);
  });
});
