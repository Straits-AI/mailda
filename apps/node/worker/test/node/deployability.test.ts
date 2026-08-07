import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

/**
 * Holds the Worker's configuration to what a customer's deploy can actually do.
 *
 * `docs/receipts/deploy-button-behaviour.md` measured a real Deploy to Cloudflare click against a paid
 * account and found things that constrain this file — one Worker per Workers Builds project, no R2
 * provisioning, resource ids written into the customer's clone. Those findings sat in a receipt
 * constraining nothing. A receipt that cannot fail is a document, not a check.
 *
 * The Deploy button is not built yet and this does not pretend otherwise. What it prevents is the
 * config drifting away from the measured facts *before* it is built, which is the cheap moment: adding
 * a binding the button cannot provision is a decision about somebody's first five minutes, and it should
 * be made deliberately rather than discovered by the first customer who clicks.
 */

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "../..");
const repoRoot = resolve(workerDir, "../../..");
const configPath = join(workerDir, "wrangler.jsonc");

interface WranglerConfig {
  name?: string;
  main?: string;
  d1_databases?: Record<string, unknown>[];
  r2_buckets?: Record<string, unknown>[];
  send_email?: Record<string, unknown>[];
  queues?: Record<string, unknown>;
  kv_namespaces?: Record<string, unknown>[];
  durable_objects?: { bindings?: Record<string, unknown>[] };
  secrets_store_secrets?: Record<string, unknown>[];
  env?: Record<string, WranglerConfig>;
}

const config = parseJsonc(readFileSync(configPath, "utf8")) as WranglerConfig;

/** The binding blocks a Worker config may declare, and how a customer comes to have each one. */
const BINDING_KINDS = {
  d1_databases: {
    provisionedByButton: Boolean(BUDGETS["builds.provisions_d1"]),
    how: "The button provisions D1 before the build, independently of the build token (measured).",
  },
  r2_buckets: {
    // Measured directly rather than inferred from the button probe, which could not see this: the
    // deploy that would have created the bucket died first. r2-auto-provisioning.md tested both shapes.
    provisionedByButton: Boolean(BUDGETS["provisioning.r2_created_without_bucket_name"]),
    how:
      "Created by the deploy itself. wrangler provisions R2 in every shape tested — with an explicit " +
      "bucket_name or without one, interactive or not — so no install path leaves it missing " +
      "(measured). The 3 August button probe recorded it absent; that was an artifact of a chained " +
      "multi-Worker deploy failing first, which ADR 18 removed. doctor's evidence_bucket_reachable " +
      "stays regardless, because one HEAD is cheap and a bucket can be deleted after install.",
  },
  send_email: {
    provisionedByButton: true,
    how: "A binding on the Worker itself, not an account resource. Nothing to create (ADR 33).",
  },
  durable_objects: {
    provisionedByButton: true,
    how: "Created by the migrations block on first deploy. No account-level resource to provision.",
  },
  queues: {
    // Measured, and the asymmetry is why the config carries a producer binding it never publishes to:
    // a producer binding provisions the queue, a bare consumer block fails the deploy outright.
    provisionedByButton: Boolean(BUDGETS["queues.producer_binding_provisions"]),
    how:
      "Provisioned by the deploy itself, but only because a producer binding names it — a consumer block " +
      "alone fails with 'Queue does not exist' and would break every one-click install (measured: " +
      "queue-provisioning.md). The event *subscription* that feeds the queue is an account-level object " +
      "outside this config, created through the API by `mailda deploy`; doctor reports its absence, " +
      "because a Node receiving no events is indistinguishable from one where nothing bounced.",
  },
} as const;

type BindingKind = keyof typeof BINDING_KINDS;

/**
 * Keys that name an account-specific resource.
 *
 * Their absence is what lets a customer's fork stay byte-identical to upstream, so `git pull` is a
 * fast-forward by construction (ADR 24). The button writes these into the *customer's* clone, which
 * already strains that premise; upstream committing them would end it.
 */
const ACCOUNT_SPECIFIC_KEYS = [
  "account_id", "database_id", "database_name", "bucket_name", "preview_bucket_name",
  "store_id", "secret_name", "namespace_id", "id", "queue_id", "dataset",
];

function bindingKindsIn(scope: WranglerConfig): BindingKind[] {
  return (Object.keys(BINDING_KINDS) as BindingKind[]).filter((kind) => scope[kind] !== undefined);
}

/** Every key path in the config, so a resource id cannot hide in a block nobody thought to check. */
function keyPaths(value: unknown, trail: string[] = []): Array<{ path: string; key: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => keyPaths(item, [...trail, String(index)]));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [
      { path: [...trail, key].join("."), key },
      ...keyPaths(child, [...trail, key]),
    ]);
  }
  return [];
}

describe("what a customer's deploy can provision", () => {
  it("declares exactly one deployable Worker", () => {
    // The receipt's headline finding: Workers Builds pins one Worker name per project and overrides
    // whatever the config says, so a chained multi-Worker deploy command deploys the wrong code under
    // the wrong name and then fails. A second Worker config in this repo would resurrect that shape.
    const configs = [relative(repoRoot, configPath)];
    expect(configs).toHaveLength(BUDGETS["builds.workers_deployable_per_project"]);
    expect(config.main).toBeTypeOf("string");
  });

  it("classifies every binding block it declares", () => {
    // A new binding block is a question about the customer's first five minutes: does the button create
    // this, and if not, who does? Failing here is that question being asked at the moment somebody still
    // has the context to answer it.
    const declared = Object.keys(config).filter(
      (key) => key.endsWith("_databases") || key.endsWith("_buckets") || key.endsWith("_namespaces")
        || key === "send_email" || key === "durable_objects" || key === "queues"
        || key === "secrets_store_secrets" || key === "vectorize" || key === "hyperdrive",
    );
    const unclassified = declared.filter((key) => !(key in BINDING_KINDS));
    expect(unclassified).toEqual([]);
  });

  it("says how anything the button cannot provision is provisioned instead", () => {
    const gaps = bindingKindsIn(config)
      .filter((kind) => !BINDING_KINDS[kind].provisionedByButton)
      .map((kind) => ({ kind, how: BINDING_KINDS[kind].how }));

    // Empty as of 6 August 2026: R2 was the last entry and direct measurement removed it. The
    // assertion stays because a *new* binding the customer's install cannot satisfy is the thing worth
    // failing on, and an empty list is the claim being made — not the absence of a claim.
    expect(gaps.map((gap) => gap.kind)).toEqual([]);
  });

  it("gives every binding a route to existing, whether or not it is a gap", () => {
    // Every kind still has to say how a customer comes to have it. Dropping R2 from the gap list must
    // not mean dropping the explanation, which is the part a reader needs.
    for (const kind of bindingKindsIn(config)) {
      expect(BINDING_KINDS[kind].how.length).toBeGreaterThan(60);
    }
  });

  it("commits no account-specific resource id", () => {
    const offenders = keyPaths(config)
      .filter((entry) => ACCOUNT_SPECIFIC_KEYS.includes(entry.key))
      .map((entry) => entry.path);

    // If this fails, somebody pasted an id from a deployed account — probably after a real deploy, and
    // probably to make something work. It does work, for them. It also ends ADR 24's guarantee that a
    // customer's fork is a fast-forward from upstream, for everybody.
    expect(offenders).toEqual([]);
  });

  it("keeps the test environment's bindings in step with the top level", () => {
    // The config comments claim this duplication is "drift-checked rather than silently divergent".
    // Nothing checked it. Wrangler warns at deploy time, which is after the tests have gone green.
    const testEnv = config.env?.test;
    expect(testEnv).toBeDefined();
    expect(bindingKindsIn(testEnv!)).toEqual(bindingKindsIn(config));
  });
});
