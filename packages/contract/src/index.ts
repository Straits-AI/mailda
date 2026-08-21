/**
 * The shared contract's entry point (#85, ADR 12).
 *
 * This file did not exist. `package.json` declared `"main": "./src/index.ts"` and pointed at nothing, and
 * **no file in the repository imported `@mailda/contract` at all** — so the package ADR 12 names as the
 * source of truth for five surfaces was one command's schemas, unreachable through its own entry point,
 * consumed by nobody.
 *
 * Nothing broke, which is the whole problem with the shape: a package with no importers has no way to be
 * wrong. It is exported here so that the first consumer — `apps/node/worker/test/node/route-registry.test.ts`
 * — is a real one.
 */
export * from "./routes.ts";
export * from "./send-mail.ts";
