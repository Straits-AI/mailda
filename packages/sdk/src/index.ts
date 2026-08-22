import { GeneratedClient } from "./generated.ts";
import type { ClientOptions } from "./transport.ts";

/**
 * The Mailda SDK (#85 step 3, ADR 12).
 *
 * ## Generated, and that is the whole claim
 *
 * Every method on this client is emitted from `packages/contract/src/routes.ts` by
 * `packages/sdk/src/generate.ts`. Nothing about a route is written twice: its path, its verb, its parameters
 * and the shape of what it answers all come from the registry that `route-registry.test.ts` holds to
 * `src/index.ts` in both directions.
 *
 * So the chain runs end to end with no hand-maintained link:
 *
 * | link | held by | failure |
 * |:--|:--|:--|
 * | SDK → contract | the generator | `pnpm sdk:check` fails on a diff |
 * | contract → handler, paths and verbs | `test/node/route-registry.test.ts` | test failure, both directions |
 * | contract → handler, bodies | `test/contract-responses.test.ts` | test failure, against a real Node |
 *
 * ADR 12 asked for parity *generated from shared contracts*, and the reason the SDK came last is #85's own:
 * *"Building an SDK by hand would add a sixth thing to keep in step and satisfy the letter of the decision
 * while defeating it."*
 *
 * ## Responses are validated by default
 *
 * That is the difference between this and a wrapper around `fetch`. A Node that has drifted is caught at the
 * boundary, in the caller's process, with the offending field named. `ClientOptions.validate` says when to
 * turn it off and why that is a narrow case.
 */
export function createClient(options: ClientOptions): GeneratedClient {
  return new GeneratedClient(options);
}

export { GeneratedClient } from "./generated.ts";
export { ContractViolation, MaildaError, type ClientOptions } from "./transport.ts";
