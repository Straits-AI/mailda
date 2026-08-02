import { describe, expect, it } from "vitest";

import { createFrozenCtx, createSystemCtx } from "../src/index.ts";

describe("ctx.id", () => {
  it("mints a typed-prefix ULID of the documented shape", () => {
    const ctx = createSystemCtx();
    const id = ctx.id("msg");
    expect(id).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts lexicographically by mint time, so B-tree inserts stay local (#6)", () => {
    const ctx = createFrozenCtx();
    const first = ctx.id("msg");
    ctx.advance(1);
    const second = ctx.id("msg");
    ctx.advance(1000);
    const third = ctx.id("msg");
    expect([third, first, second].sort()).toEqual([first, second, third]);
  });

  it("is deterministic under a frozen ctx, which is what §27 replay needs", () => {
    expect(createFrozenCtx().id("run")).toBe(createFrozenCtx().id("run"));
  });

  it("rejects a prefix that would be unreadable in an error string", () => {
    const ctx = createFrozenCtx();
    for (const bad of ["", "MSG", "9x", "with_underscore", "waytoolongprefix"]) {
      expect(() => ctx.id(bad)).toThrow(/E_BAD_ID_PREFIX/);
    }
  });

  it("names the prefix and the expectation when it rejects", () => {
    expect(() => createFrozenCtx().id("MSG")).toThrow(/expected {2}1-10 chars, lowercase/);
  });
});

describe("createFrozenCtx", () => {
  it("does not collide over a long run", () => {
    // Regression: an earlier version folded the counter into each byte with
    // (counter + index) & 0xff, giving a period of 256. Seeding 1,200 rows hit it.
    const ctx = createFrozenCtx();
    const seen = new Set<string>();
    for (let index = 0; index < 5000; index++) seen.add(ctx.id("rt"));
    expect(seen.size).toBe(5000);
  });
});
