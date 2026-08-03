import type { Ctx } from "@mailda/runtime";

/**
 * The single Worker's bindings (ADR 18).
 *
 * Note what is absent: no plaintext credential. Anything that authorizes an external
 * effect is a Secrets Store binding read via `await env.NAME.get()` at the point of use,
 * so serializing `env` discloses nothing (ADR 22).
 */
export interface Env {
  CATALOG: D1Database;
  EVIDENCE: R2Bucket;
  /** Root key for content DEKs. Secrets Store, so it is an accessor and not a value. */
  CONTENT_KEK?: { get(): Promise<string> };
}

/**
 * Everything a request needs, assembled once at the boundary.
 *
 * `ctx` carries time, randomness and id minting (#6). It is threaded explicitly rather
 * than reached for globally, because a module-level clock leaks across requests under
 * isolate reuse — and because §27's frozen-clock replay is then just an injection.
 */
export interface RequestContext {
  env: Env;
  ctx: Ctx;
  orgId: string;
}
