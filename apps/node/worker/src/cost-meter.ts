/**
 * Counts what an operation actually spends against the platform's per-invocation budget.
 *
 * ## Why this exists rather than reusing doctor's meter
 *
 * `doctor.ts` grew a cost meter first, and it counts **`prepare`** rather than execution. That is right for
 * `doctor` by coincidence — every statement it prepares is chained into exactly one execution — and wrong for
 * anything else:
 *
 * | Written as | doctor's meter says | It actually costs |
 * |:--|--:|--:|
 * | one statement, executed 25 times | 1 | 25 |
 * | `batch` of 8 statements | 8 | 1 |
 * | 200 inserts inside one `batch` | 200 | 1 |
 * | a Durable Object RPC | 0 | 1 |
 *
 * Butler step costing was going to reuse it and would have priced `mail.send.propose` at 6 subrequests
 * against a **measured 10** — a 40% undercount, in the permissive direction. Of that real 10, two are
 * `KEY_VAULT` RPCs the old meter cannot see at all (`butler-step-cost.md`). So this meter counts
 * **executions**, treats a `batch()` as the one round trip it is, and proxies the vault.
 *
 * ## What a subrequest is here, and where the soft edge is
 *
 * `butler-step-budget.md` measured the ceiling at **10,000 subrequests per Workflow instance** — per
 * instance, shared across every step, not per step. Against that budget a D1 query, an R2 operation and a
 * Durable Object RPC each count one. Cloudflare's own definition names R2, KV and D1 and does **not** name
 * Durable Objects, so the DO term is the one place this could over-count. That direction is deliberate: an
 * over-count makes a derived bound conservative, never optimistic, and `AGENTS.md` prefers a bound that is
 * too small to one that fails under load.
 *
 * ## What it still cannot see
 *
 * `env.EMAIL.send` and the queue producer are **not proxied**, because neither is reachable from anything
 * this meter is used to price today — `sealManifest` stops at the manifest and the transport is a separate
 * act. Stated rather than left implicit: pricing a node that hands bytes to the transport, or that publishes
 * to the queue, needs this widened first, and nothing here will notice if it is not. That is a known gap in
 * the instrument, not a claim about the instrument being complete.
 */

export interface Cost {
  /** Statements actually executed, counting a `batch()` as one. */
  d1Executions: number;
  /** `batch()` calls, separately, because a batch's statement count is not its cost. */
  d1Batches: number;
  r2Operations: number;
  /** Durable Object RPCs — the term doctor's meter is blind to. */
  doRpcs: number;
  /** The sum, which is what the platform budget is spent in. */
  subrequests: number;
}

export function emptyCost(): Cost {
  return { d1Executions: 0, d1Batches: 0, r2Operations: 0, doRpcs: 0, subrequests: 0 };
}

/** The three methods that make a prepared statement actually cost something. */
const EXECUTIONS = new Set(["first", "all", "run", "raw"]);
const R2_OPERATIONS = new Set(["head", "get", "put", "delete", "list"]);

/**
 * Bound to the target, never returned bare.
 *
 * `Reflect.get` hands back an unbound method, which then runs with `this` set to the proxy and fails with
 * "Illegal invocation" — a native binding rejects a `this` that is not itself. `doctor.ts` records finding
 * this on `R2Bucket.list()`, where it presented as "Reconciliation failed" rather than as a proxy bug.
 */
function passthrough<T extends object>(target: T, property: string | symbol): unknown {
  const value = Reflect.get(target, property) as unknown;
  return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
}

/** Wraps one prepared statement so its execution is counted, and `bind()` keeps returning a wrapped one. */
function meteredStatement(statement: D1PreparedStatement, cost: Cost): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        // `bind` returns a new statement; it costs nothing and its result must stay metered.
        return (...args: unknown[]) =>
          meteredStatement((target.bind as (...a: unknown[]) => D1PreparedStatement)(...args), cost);
      }
      if (typeof property === "string" && EXECUTIONS.has(property)) {
        return (...args: unknown[]) => {
          cost.d1Executions += 1;
          cost.subrequests += 1;
          return (Reflect.get(target, property) as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return passthrough(target, property);
    },
  });
}

/**
 * An env whose D1, R2 and vault access is counted.
 *
 * The returned `cost` object is live: read it after the operation under measurement has finished.
 */
export function metering(env: Env): { env: Env; cost: Cost } {
  const cost = emptyCost();

  const catalog = new Proxy(env.CATALOG, {
    get(target, property) {
      if (property === "prepare") {
        // Preparing is free. Only executing spends.
        return (query: string) => meteredStatement(target.prepare(query), cost);
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          // **One** round trip regardless of how many statements it carries. This is the term doctor's meter
          // gets backwards, and it is the difference between pricing a fifty-recipient send at 50 and at 1.
          cost.d1Batches += 1;
          cost.d1Executions += 1;
          cost.subrequests += 1;
          return target.batch(statements);
        };
      }
      return passthrough(target, property);
    },
  });

  const evidence = new Proxy(env.EVIDENCE, {
    get(target, property) {
      if (typeof property === "string" && R2_OPERATIONS.has(property)) {
        return (...args: unknown[]) => {
          cost.r2Operations += 1;
          cost.subrequests += 1;
          return (Reflect.get(target, property) as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return passthrough(target, property);
    },
  });

  /**
   * The vault, which is a Durable Object namespace rather than a store.
   *
   * `getByName` costs nothing — it resolves a stub. Every method called *on* that stub is an RPC and spends
   * one subrequest. Both key fetches are **uncached** by design (`openingKey` on every read, `sealingKey` on
   * every write), which is why a send spends two of these and a reply three — measured, and invisible to the
   * old meter.
   */
  const keyVault = new Proxy(env.KEY_VAULT, {
    get(target, property) {
      if (property === "getByName" || property === "get") {
        return (...args: unknown[]) => {
          const stub = (Reflect.get(target, property) as (...a: unknown[]) => object).apply(target, args);
          return new Proxy(stub, {
            get(stubTarget, stubProperty) {
              const value = Reflect.get(stubTarget, stubProperty) as unknown;
              if (typeof value !== "function") return value;
              // Invoked **through the stub** rather than with `.apply`. A Durable Object stub's methods are
              // RPC proxies: `typeof` reports "function" but they do not implement `apply`, so the usual
              // `fn.apply(target, args)` fails with "The RPC receiver does not implement the method apply".
              // Calling `stub[name](...)` keeps the RPC machinery in charge of dispatch. This is the same
              // class of hazard `doctor.ts` records for `R2Bucket.list()`, one layer further in.
              return (...callArgs: unknown[]) => {
                cost.doRpcs += 1;
                cost.subrequests += 1;
                const methods = stubTarget as unknown as Record<string, (...a: unknown[]) => unknown>;
                return methods[stubProperty as string]!(...callArgs);
              };
            },
          });
        };
      }
      return passthrough(target, property);
    },
  });

  return {
    env: { ...env, CATALOG: catalog, EVIDENCE: evidence, KEY_VAULT: keyVault } as unknown as Env,
    cost,
  };
}
