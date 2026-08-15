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
 * ## Every binding is classified, and an unclassified one throws
 *
 * The first version proxied `CATALOG`, `EVIDENCE` and `KEY_VAULT` and said so — which left the same gap for
 * the next binding: pricing a node that hands bytes to the transport would have under-reported silently, and
 * nothing here would have noticed. A known gap stated in a comment is the shape this codebase keeps finding
 * defects in.
 *
 * So the world is closed. Every binding the Worker declares is named below as **metered** or **free**, and
 * reading anything else off a metered env **throws**, naming what to do. A binding added to `wrangler.jsonc`
 * therefore cannot be silently un-metered: it fails the first time a priced operation touches it, and
 * `test/node/cost-meter-coverage.test.ts` fails earlier still, at test time, by comparing this list against
 * the config.
 *
 * `OUTBOX_SWEEPER` is metered rather than excluded even though nothing priced reaches it today, because
 * "nothing reaches it today" is exactly the assumption that expired for the transport.
 */

export interface Cost {
  /** Statements actually executed, counting a `batch()` as one. */
  d1Executions: number;
  /** `batch()` calls, separately, because a batch's statement count is not its cost. */
  d1Batches: number;
  r2Operations: number;
  /** Durable Object RPCs — the term doctor's meter is blind to. */
  doRpcs: number;
  /** Messages handed to the transport. Zero for everything priced today, and metered anyway. */
  transportSends: number;
  /** Queue publishes. `sendBatch` is one, like `batch()`, because it is one round trip. */
  queuePublishes: number;
  /** The sum, which is what the platform budget is spent in. */
  subrequests: number;
}

export function emptyCost(): Cost {
  return {
    d1Executions: 0, d1Batches: 0, r2Operations: 0, doRpcs: 0, transportSends: 0,
    queuePublishes: 0, subrequests: 0,
  };
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
   * A Durable Object namespace, which is a resolver rather than a store.
   *
   * `getByName` costs nothing — it resolves a stub. Every method called *on* that stub is an RPC and spends
   * one subrequest. Both vault key fetches are uncached by design (`openingKey` on every read, `sealingKey`
   * on every write), which is why a send spends two of these and a reply three — measured, and invisible to
   * doctor's meter.
   */
  const durableNamespace = <T extends object>(namespace: T): T => new Proxy(namespace, {
    get(target, property) {
      if (property === "getByName" || property === "get" || property === "idFromName") {
        return (...args: unknown[]) => {
          const resolved = (Reflect.get(target, property) as (...a: unknown[]) => unknown).apply(target, args);
          // `idFromName` returns an id, not a stub — nothing to meter, and wrapping it would break `get`.
          if (property === "idFromName" || typeof resolved !== "object" || resolved === null) return resolved;
          return new Proxy(resolved as object, {
            get(stubTarget, stubProperty) {
              const value = Reflect.get(stubTarget, stubProperty) as unknown;
              if (typeof value !== "function") return value;
              // Invoked **through the stub** rather than with `.apply`. A Durable Object stub's methods are
              // RPC proxies: `typeof` reports "function" but they do not implement `apply`, so the usual
              // `fn.apply(target, args)` fails with "The RPC receiver does not implement the method apply".
              // Same class of hazard as the `R2Bucket.list()` illegal-invocation note in `doctor.ts`.
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

  /** The transport. Nothing priced today reaches it; metered so that when something does, it is counted. */
  const email = env.EMAIL === undefined ? undefined : new Proxy(env.EMAIL as object, {
    get(target, property) {
      if (property === "send") {
        return (...args: unknown[]) => {
          cost.transportSends += 1;
          cost.subrequests += 1;
          return (Reflect.get(target, property) as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return passthrough(target, property);
    },
  });

  /** The queue producer. `sendBatch` counts one, like `batch()`, because it is one round trip. */
  const sendingEvents = env.SENDING_EVENTS === undefined ? undefined
    : new Proxy(env.SENDING_EVENTS as object, {
      get(target, property) {
        if (property === "send" || property === "sendBatch") {
          return (...args: unknown[]) => {
            cost.queuePublishes += 1;
            cost.subrequests += 1;
            return (Reflect.get(target, property) as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return passthrough(target, property);
      },
    });

  /**
   * Every binding, classified — and reading an unclassified one **throws**.
   *
   * This is what makes the instrument's coverage a property rather than a claim. A binding added to
   * `wrangler.jsonc` and touched by a priced operation fails here, loudly, instead of being counted as free.
   * `TEST_MIGRATIONS` is a value rather than a binding, so it passes through untouched.
   */
  const metered: Record<string, unknown> = {
    CATALOG: catalog,
    EVIDENCE: evidence,
    KEY_VAULT: durableNamespace(env.KEY_VAULT),
    OUTBOX_SWEEPER: durableNamespace(env.OUTBOX_SWEEPER),
    ...(email === undefined ? {} : { EMAIL: email }),
    ...(sendingEvents === undefined ? {} : { SENDING_EVENTS: sendingEvents }),
  };

  /** Not bindings, so nothing to meter: values passed through by the test harness or by config. */
  const FREE = new Set(["TEST_MIGRATIONS"]);

  const wrapped = new Proxy(env as unknown as Record<string, unknown>, {
    get(target, property) {
      if (typeof property !== "string") return Reflect.get(target, property);
      if (property in metered) return metered[property];
      if (FREE.has(property)) return Reflect.get(target, property);
      // Absent from the env entirely is not a coverage gap — `EMAIL` and `SENDING_EVENTS` are optional by
      // design, and `transport.ts` reports absence rather than throwing. Only a *present* binding this
      // meter does not classify is the problem.
      const value = Reflect.get(target, property);
      if (value === undefined) return undefined;
      throw new Error(
        `cost-meter: env.${property} is not classified, so a priced operation touching it would be counted `
        + "as free. Add it to `metered` in src/cost-meter.ts (with the cost of its operations) or to `FREE` "
        + "if it is not a binding. See test/node/cost-meter-coverage.test.ts.",
      );
    },
  });

  return { env: wrapped as unknown as Env, cost };
}
