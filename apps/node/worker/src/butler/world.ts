import type { Ctx } from "@mailda/runtime";
import type { ButlerNode } from "@mailda/butler-ast";

import { assignCase, closeCase, lookupRow, proposeSend, writeDraft, type EffectResult } from "./effects.ts";
import type { ButlerPrincipal } from "./principal.ts";
import type { ReplayIncumbents } from "../outbound/manifest.ts";
import type { RunState } from "./expr.ts";

/**
 * The capability a run is constructed with, and the reason it is a *type* rather than a flag (#87, §5).
 *
 * ## The charted answer, and where it was aimed
 *
 * Layer 4's fifth charted answer — settled on the wayfinder map by grilling, before any Layer 4 ticket was
 * cut — reads:
 *
 * > A step reaches an external effect only through a handle the run context carries; a simulated or replayed
 * > run is constructed with **no** transport capability, so `mail.send.propose` is a type error at compile
 * > time and an absent handle at runtime.
 *
 * The **first clause is the design and it is what this file implements.** The second names the wrong
 * capability, and checking that before building it is the reason this header exists rather than a smaller one.
 *
 * **A Butler run holds no transport capability to withhold.** `grep -rn "SEND_EMAIL\|EmailMessage"
 * src/butler/` finds nothing: the binding is `send_email: [{ name: "EMAIL" }]`, the only code that touches
 * `env.EMAIL.send` is `src/outbound/transport.ts`, and it is reached from `src/outbound/dispatch.ts` — the
 * sweeper's alarm or the cron backstop, a **separate later invocation**. `mail.send.propose` is
 * `sealManifest`: it writes a sealed manifest and stops.
 *
 * So the answer was written for an architecture where a Butler step hands mail to the platform, and what
 * shipped instead is #61's approval gate over Layer 5's dispatcher. In that architecture the property the
 * answer wanted is already true, for a **stronger** reason than it proposed: the handle is absent from the
 * whole engine rather than from one kind of run, so it is not a defence anybody can forget to construct.
 *
 * ## What a simulated run must actually not be able to do
 *
 * Writes. A simulated run reaching the live effects would seal a manifest, assign a case, write a draft,
 * append audit rows and spend a real budget — none of it transport, all of it production state. Ranked by
 * danger the chart's own example comes **last**: a proposed send is parked behind #61's approval, while
 * `case.assign` and `draft` are gated by nothing at all.
 *
 * The chart's mechanism therefore has the right shape aimed at the wrong capability, and the faithful
 * translation is the one below: **the capability a simulated run is not constructed with is the catalog
 * write.**
 *
 * ## Why a type and not a wrapper that throws
 *
 * A `CATALOG` proxy that threw on `run`/`batch` would be a *runtime* check, which is the effect-suppressing
 * flag the map rejected — it fails at the moment of the write, in a branch a test has to reach, and a new
 * effect node added next year gets no warning at all. `ReadOnlyEnv` is not assignable to `Env`, so inside any
 * function whose parameter is `ReadOnlyEnv` the expression `liveEffects(env, …)` **does not compile**, for
 * every effect that exists and every effect anybody adds. `test/butler-world.test.ts` proves both directions
 * with `@ts-expect-error`, which is the only kind of assertion that can witness a compile error.
 *
 * The map also rejected a second Worker with no `send_email` binding, because a per-install variant would
 * contradict ADR 24's byte-identical fork. Nothing here needs one: the distinction is a parameter type inside
 * one Worker.
 */

/**
 * A prepared statement that can be read and not run.
 *
 * `bind` returns this same narrow type, so no chain of `.bind().bind()` widens back into a writable
 * statement — which is the hole a single-level narrowing would leave.
 *
 * `D1PreparedStatement` **is** assignable to this (it has all three members and more), which is the direction
 * that has to work: a live run hands its real statement wherever a read is wanted. The reverse fails, which
 * is the direction that has to be impossible.
 */
export interface ReadOnlyStatement {
  bind(...values: unknown[]): ReadOnlyStatement;
  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

/** A catalog that can be asked questions and told nothing. No `batch`, and no statement that can `run`. */
export interface ReadOnlyCatalog {
  prepare(query: string): ReadOnlyStatement;
}

/**
 * The environment a simulated run is constructed with: one handle, and it reads.
 *
 * Deliberately **not** `Omit<Env, …>` or `Env & {…}`. Both would keep this assignable to or from `Env` in one
 * direction by accident, and the whole property is that the assignability goes one way. This is a separate
 * interface naming exactly what a simulation may touch, so adding a binding to `Env` — a second queue, a
 * vectorize index — does not silently hand it to simulated runs.
 *
 * `EVIDENCE` is absent and that is a decision, not an omission: reading a stored message means decrypting
 * evidence, and a dry run that decrypted mail to tell somebody what a draft would say would be a
 * confidentiality surface with no audit entry behind it. A simulation reasons over the trigger facts it was
 * given and the catalog rows it can read.
 */
export interface ReadOnlyEnv {
  readonly CATALOG: ReadOnlyCatalog;
}

/**
 * The one place a writable environment becomes a read-only one.
 *
 * A function, not a cast at each call site, so the crossing is grep-able and there is exactly one line to
 * read when asking *how could a simulation ever write?* It is the same shape as `metering(rawEnv)` in
 * `src/cost-meter.ts`, which already establishes that this engine narrows its environment at a boundary
 * rather than passing the raw one down.
 *
 * No proxy and no wrapper object: the returned value **is** `env`, and the narrowing is entirely in the type.
 * A wrapper would be a second object that could drift from the first, and it would buy nothing — the
 * guarantee is that the *caller* cannot name a write, not that the object cannot perform one. The runtime
 * value being the real catalog is what makes reads inside a simulation real reads.
 */
export function readOnly(env: Env): ReadOnlyEnv {
  return env;
}

/**
 * The effect handle a run context carries — the charted answer's first clause, literally.
 *
 * One object per run, closing over the environment, the clock and the principal, so a node case in the walk
 * names *what it wants done* and never *what it is entitled to*. That is what makes the walk shareable
 * between a live run and a simulated one: the switch is identical, and the difference is which handle was
 * constructed for it.
 *
 * `lookup` is here beside the four writes even though it only reads, because the walk should reach every
 * effect node through one seam. A read that bypassed the handle would be a second way for a node to reach
 * storage, and the next reader would have to check both.
 */
export interface EffectHandle {
  lookup(node: Extract<ButlerNode, { type: "lookup" }>, state: RunState): Promise<EffectResult>;
  assignCase(node: Extract<ButlerNode, { type: "case.assign" }>, state: RunState): Promise<EffectResult>;
  closeCase(node: Extract<ButlerNode, { type: "case.close" }>, state: RunState): Promise<EffectResult>;
  writeDraft(
    node: Extract<ButlerNode, { type: "draft" }>,
    state: RunState,
    trigger: { readonly event: string; readonly key: string; readonly facts: Readonly<Record<string, unknown>> },
    replaying: boolean,
  ): Promise<EffectResult>;
  proposeSend(
    node: Extract<ButlerNode, { type: "mail.send.propose" }>,
    state: RunState,
    incumbents: ReplayIncumbents | null,
  ): Promise<EffectResult>;
}

/**
 * The live handle: the five functions in `effects.ts`, bound to a real environment.
 *
 * **Requiring `Env` is the enforcement.** It is not a convenience of the signature — it is the only line that
 * has to be right for a simulated run to be unable to cause an effect, because `ReadOnlyEnv` is not
 * assignable to `Env` and so this call cannot be written inside a function that only has one.
 *
 * Nothing is re-implemented here and nothing may be. Every one of these is the same function a person's
 * request reaches, which is the property `effects.ts` was built for: a Butler is an author of sends, not an
 * exception to the rules about them. This is a binding, not a layer.
 */
export function liveEffects(env: Env, ctx: Ctx, butler: ButlerPrincipal): EffectHandle {
  return {
    lookup: async (node, state) => await lookupRow(env, butler, node, state),
    assignCase: async (node, state) => await assignCase(env, ctx, butler, node, state),
    closeCase: async (node, state) => await closeCase(env, ctx, butler, node, state),
    writeDraft: async (node, state, trigger, replaying) =>
      await writeDraft(env, ctx, butler, node, state, trigger, replaying),
    proposeSend: async (node, state, incumbents) =>
      await proposeSend(env, ctx, butler, node, state, incumbents),
  };
}
