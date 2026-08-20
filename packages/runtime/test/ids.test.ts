import { describe, expect, it } from "vitest";

import { createFrozenCtx, createSystemCtx } from "../src/ctx.ts";
import { ID_PREFIXES, idPattern, idPatternSource, type IdEntity } from "../src/ids.ts";

/**
 * The registry validates what the minter mints (#49).
 *
 * This is the whole point of the file it tests: `packages/contract` required `case_` while the Node minted
 * `cas_`, and nothing in the repository could have noticed, because the two spellings lived in two
 * packages and neither had ever been compared. So the comparison is done here, by minting a real id per
 * registered entity and matching it against the pattern the same registry hands to a schema.
 */

const ENTITIES = Object.keys(ID_PREFIXES) as IdEntity[];

describe("the id prefix registry", () => {
  it("has entities to check, so nothing below passes by having nothing to do", () => {
    expect(ENTITIES.length).toBeGreaterThanOrEqual(5);
    expect(ENTITIES).toContain("case");
    expect(ENTITIES).toContain("butler");
    expect(ENTITIES).toContain("butlerVersion");
  });

  it("matches an id the runtime actually mints, for every registered entity", () => {
    const ctx = createSystemCtx();
    for (const entity of ENTITIES) {
      const prefix = ID_PREFIXES[entity];
      const minted = ctx.id(prefix);
      expect(idPattern(prefix).test(minted), `${entity}: ${minted}`).toBe(true);
    }
  });

  it("matches the deterministic minter too, whose random bytes are a counter", () => {
    // The frozen ctx is what §27 replay and every test fixture uses. Its ULID body is mostly zeroes, which
    // is exactly the shape a character class written slightly wrong would still accept — so it is checked
    // separately from the entropy-backed one rather than instead of it.
    const ctx = createFrozenCtx();
    for (const entity of ENTITIES) {
      expect(idPattern(ID_PREFIXES[entity]).test(ctx.id(ID_PREFIXES[entity]))).toBe(true);
    }
  });

  it("is the Crockford alphabet, and refuses the four letters it excludes", () => {
    // I, L, O and U are absent from the encoder on purpose. A pattern that admitted them would accept an
    // id nothing can mint, which is the permissive half of the same divergence.
    const body = "0".repeat(26);
    for (const letter of ["I", "L", "O", "U"]) {
      const wrong = `cas_${letter}${body.slice(1)}`;
      expect(idPattern("cas").test(wrong), letter).toBe(false);
    }
  });

  it("rejects the wrong prefix, the wrong length and any surrounding text", () => {
    const good = createSystemCtx().id("cas");
    expect(idPattern("cas").test(good)).toBe(true);
    // The divergence itself, asserted as a refusal: `case_` is not a case id.
    expect(idPattern("cas").test(good.replace("cas_", "case_"))).toBe(false);
    expect(idPattern("cas").test(good.slice(0, -1))).toBe(false);
    expect(idPattern("cas").test(`${good}X`)).toBe(false);
    expect(idPattern("cas").test(` ${good}`)).toBe(false);
    expect(idPattern("cas").test(`${good}\n${good}`)).toBe(false);
  });

  it("emits the same pattern as source text, for schema emitters that want a string", () => {
    for (const entity of ENTITIES) {
      expect(idPatternSource(ID_PREFIXES[entity])).toBe(idPattern(ID_PREFIXES[entity]).source);
    }
  });
});
