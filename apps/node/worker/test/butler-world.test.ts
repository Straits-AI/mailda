import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { liveEffects, readOnly, type ReadOnlyEnv, type ReadOnlyStatement } from "../src/butler/world.ts";
import type { ButlerPrincipal } from "../src/butler/principal.ts";

/**
 * The capability a simulated run is not constructed with (#87, §5's fifth charted answer).
 *
 * ## Why most of this file is `@ts-expect-error`
 *
 * The claim is that certain code **does not compile**. No runtime assertion can witness that: a test that
 * calls a write and catches a throw is testing a wrapper that throws, which is the effect-suppressing flag
 * the map rejected — it fails at the write, in a branch somebody has to reach, and an effect node added next
 * year gets no warning at all.
 *
 * `@ts-expect-error` is the only assertion that can. It fails the typecheck **both** ways: if the line
 * compiles, TypeScript reports the directive as unused. So each one below is a two-sided claim — *this is an
 * error today, and it will still be an error tomorrow* — checked by `tsc --noEmit`, which is a gate in this
 * repository rather than an optional step.
 *
 * The runtime half at the bottom exists because the type half can pass over a boundary that reads nothing.
 * `readOnly` narrows in the type and returns the value unchanged, so a simulation's reads have to be *real*
 * reads against the real catalog, and that is asserted by performing one.
 */

const testEnv = env as unknown as Env;

const PRINCIPAL: ButlerPrincipal = {
  orgId: "org_world",
  butlerId: "btl_world",
  versionId: "btv_world",
  name: "world",
  // A ceiling naming nothing: this file never performs an effect, it asserts that certain code refuses to
  // compile. An empty map is the restrictive reading `ceiling.ts` documents, so if a line here ever did
  // reach an effect it would be refused rather than permitted.
  ceiling: { sponsorUserId: "usr_world", byAction: new Map() },
};

describe("a writable environment narrows to a read-only one, and never back", () => {
  it("accepts the real Env wherever a read handle is wanted", () => {
    /*
     * The direction that has to work, and it is not the trivial one. A live run hands its own catalog to code
     * that only reads, so `D1Database` must satisfy `ReadOnlyCatalog` and `D1PreparedStatement` must satisfy
     * `ReadOnlyStatement` — including `bind` returning something that still satisfies it, recursively. If
     * that ever stopped holding, every read a simulation shares with a live run would need a second spelling.
     */
    const narrowed: ReadOnlyEnv = readOnly(testEnv);
    expect(typeof narrowed.CATALOG.prepare).toBe("function");
  });

  it("refuses a read handle where a writable environment is required", () => {
    const narrowed = readOnly(testEnv);
    // @ts-expect-error — ReadOnlyEnv is not an Env. This is the assignability the whole design rests on.
    const widened: Env = narrowed;
    expect(widened).toBeDefined();
  });

  it("does not let a simulated context construct the live effect handle", () => {
    /*
     * The assertion the charted answer actually asked for, translated to the capability that matters here.
     *
     * `liveEffects` requires an `Env`. A function holding only a `ReadOnlyEnv` therefore cannot build it —
     * not for `mail.send.propose` specifically, which is what the chart named, but for all five at once and
     * for the sixth somebody adds later. That generality is the difference between a type and a check.
     */
    const narrowed = readOnly(testEnv);
    // @ts-expect-error — a read handle cannot be used to bind effects that write.
    const handle = liveEffects(narrowed, createSystemCtx(), PRINCIPAL);
    expect(handle).toBeDefined();
  });

  it("offers no way to run a statement, at any depth of bind", () => {
    const statement: ReadOnlyStatement = readOnly(testEnv).CATALOG.prepare("SELECT 1");

    // @ts-expect-error — no `run`. The narrowing is what a simulation is missing, not a runtime guard.
    void statement.run;
    // @ts-expect-error — nor `raw`.
    void statement.raw;
    /*
     * And the hole a single-level narrowing would have left. `bind` returns `ReadOnlyStatement` rather than
     * the statement's own type, so no chain of binds widens back into something that can be run — which is
     * exactly how a caller would have reached a write without meaning to.
     */
    // @ts-expect-error — still narrow after binding.
    void statement.bind(1).bind(2).run;
    expect(typeof statement.first).toBe("function");
  });

  it("has no batch, which is the write path this engine actually uses", () => {
    /*
     * Named separately from `run` because it is the one that matters most here: every write in `effects.ts`
     * and in `perform` is a `batch()`, because a record that disagrees with itself has to be
     * unrepresentable. A narrowing that removed `run` and left `batch` would have removed nothing.
     */
    const catalog = readOnly(testEnv).CATALOG;
    // @ts-expect-error — no `batch`.
    void catalog.batch;
    expect(typeof catalog.prepare).toBe("function");
  });
});

describe("the narrowing is in the type, so the reads behind it are real", () => {
  it("returns the environment itself rather than a wrapper", () => {
    /*
     * Asserted because the alternative is tempting and worse. A proxy or a copy would be a second object
     * that could drift from the first, and it would buy nothing: the guarantee is that a *caller* cannot
     * name a write, not that the object cannot perform one. Identity is also what makes the line below a
     * real query rather than a mock.
     */
    expect(readOnly(testEnv)).toBe(testEnv);
  });

  it("reads through the narrow handle, against the real catalog", async () => {
    const narrowed = readOnly(testEnv);
    const row = await narrowed.CATALOG.prepare("SELECT COUNT(*) AS n FROM butlers").first<{ n: number }>();
    // The number is not the point; that a simulation can ask a question at all is.
    expect(typeof row?.n).toBe("number");
  });
});
