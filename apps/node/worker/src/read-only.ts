/**
 * The catalog capability, as a type (#87, §5's fifth charted answer).
 *
 * ## Why this is a type and not a wrapper that throws
 *
 * A `CATALOG` proxy that threw on `run`/`batch` would be a *runtime* check — the effect-suppressing flag the
 * wayfinder map rejected. It fails at the moment of the write, in a branch a test has to reach, and code
 * added next year gets no warning at all. `ReadOnlyEnv` is not assignable to `Env`, so inside any function
 * whose parameter is `ReadOnlyEnv` an expression that needs a writable environment **does not compile** —
 * for every write that exists and every write anybody adds.
 *
 * `test/butler-world.test.ts` proves both directions with `@ts-expect-error`, which is the only kind of
 * assertion that can witness a compile error.
 *
 * ## Here rather than in `src/butler/`, and what that buys
 *
 * The first draft put this beside the Butler effect handle it was written for. It moved out on the first
 * read that needed it: `authz-read.ts` and `src/butler/authority.ts` contain **no writes at all**, so their
 * signatures can say so — and once they do, a dry run can reuse the real authority check rather than
 * approximating one.
 *
 * That is the property worth naming, because it is what makes the whole approach cheap: **narrowing a
 * read-only function's parameter to `ReadOnlyEnv` is a non-breaking change**, since `Env` is assignable to
 * it. Every live caller is unaffected, the function gains a true statement about itself in its own type, and
 * simulation gains the ability to call it. Narrowings happen because a caller needs one, not as a sweep.
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
