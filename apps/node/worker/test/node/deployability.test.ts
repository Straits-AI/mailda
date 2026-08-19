import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

import {
  BINDING_BLOCKS, bindingBlocksIn, CONFIG_PATH, readWranglerConfig, unclassifiedKeys, WORKER_DIR,
  type ConfigScope,
} from "./wrangler-world";

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
 *
 * ## Which half of the question this file owns
 *
 * What counts as a binding block lives in `test/node/wrangler-world.ts` and is shared with
 * `test/node/cost-meter-coverage.test.ts`. Before #71 each file kept its own rule — this one matched
 * `_databases` / `_buckets` / `_namespaces` suffixes plus six exact names, and omitted `workflows` while
 * the type below and the schedules guard at the bottom both already knew `workflows` was a binding block.
 * Two incomplete rules over one property is how both came to be trusted and neither was sufficient.
 *
 * The two files still ask different questions, which is why they are still two files: coverage asks
 * whether the cost meter classifies every binding **name**; this file asks whether a customer's install
 * can **provision** every binding **block**, and says how when it cannot.
 */

const repoRoot = resolve(WORKER_DIR, "../../..");

/**
 * Only the fields this file reads. Every binding block is classified by the shared world instead.
 *
 * A type alias rather than an interface so it is still assignable to that module's `ConfigScope`.
 */
type WranglerConfig = ConfigScope & {
  main?: string;
  /** Not declared yet. Typed so the schedules guard below reads the real shape rather than `any`. */
  workflows?: Record<string, unknown>[];
  env?: Record<string, WranglerConfig>;
};

const config = readWranglerConfig() as WranglerConfig;

/**
 * How a customer comes to have each binding block this config declares.
 *
 * Deliberately keyed by *declared* block rather than by every block `wrangler-world.ts` recognises. Each
 * entry is a measured claim about somebody's first five minutes, and a block nothing declares has no
 * measurement behind it: `workflow-provisioning.md` provisioned a Workflow with a Super Administrator
 * OAuth token and says in as many words that this must not be read as "provisioned by the button", since
 * whether a Workers Builds auto-generated token has the scope is untested. Writing an entry now would
 * make that unmeasured claim. The test below fails the moment `[[workflows]]` is declared, which is when
 * somebody has the context to measure it.
 */
const BINDING_KINDS = {
  /*
   * #55 ONLY, and this entry is the one place in the repository where the honest value of `how` is
   * *"nobody knows yet"*.
   *
   * That is the whole point of the measurement. #47 established that `wrangler deploy` creates a workflow
   * with no resource id — through an interactive OAuth token with Super Administrator privileges. Whether
   * the token **Workers Builds mints for itself** can do the same is unmeasured, and
   * `queue-provisioning.md` already recorded the button behaving differently from the CLI for Queues, so
   * the CLI result is not evidence about the button.
   *
   * `provisionedByButton: false` is therefore the *conservative* placeholder, not a finding: it says this
   * install path is unproven, which is the direction that cannot mislead. When #55 answers, this entry
   * either gains a measured `true` and a receipt, or the binding is deleted along with `butler-probe.ts`.
   */
  workflows: {
    provisionedByButton: false,
    how:
      "UNMEASURED — this is what #55 exists to find out. The interactive CLI path creates a workflow " +
      "with no resource id (#47, measured); the Workers Builds token has never been tested against a " +
      "workflow binding, and queue-provisioning.md records the button diverging from the CLI for Queues. " +
      "Recorded as not-provisioned until somebody clicks Deploy, because an unproven install path must " +
      "not read as a working one.",
  },
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
 * Bindings declared **in order to be measured**, each naming the issue that removes it.
 *
 * Not a suppression list. A binding here is one nobody has established the button can provision, declared
 * on purpose so that clicking Deploy answers the question — and the entry is a promise that the answer is
 * coming, which is why the test below fails if the issue has been closed while the exemption remains.
 *
 * Empty on `main`. If this is ever non-empty there, something has been forgotten.
 */
const UNDER_MEASUREMENT: Record<string, { issue: number; question: string }> = {
  workflows: {
    issue: 55,
    question: "can a Workers Builds token provision a Workflow, as an interactive OAuth token can (#47)?",
  },
};

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
  return bindingBlocksIn(scope).filter((key): key is BindingKind => key in BINDING_KINDS);
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
    const configs = [relative(repoRoot, CONFIG_PATH)];
    expect(configs).toHaveLength(BUDGETS["builds.workers_deployable_per_project"]);
    expect(config.main).toBeTypeOf("string");
  });

  it("classifies every key in the config as a binding block or a field that binds nothing", () => {
    // The closed world #71 asked for, replacing a suffix-and-exact-name filter that skipped any key it
    // had not been told about — `workflows` among them. An unknown key now fails here, which is the only
    // version that catches the binding block nobody has thought of. One call covers the whole file: the
    // top level and every named environment under `env`.
    expect(unclassifiedKeys(config)).toBeNull();
  });

  it("fails on a key it does not know, so the closed world is not vacuously closed", () => {
    // Proves the guard above fires without editing wrangler.jsonc: the same config, one stranger richer.
    const complaint = unclassifiedKeys({ ...config, mailda_unheard_of_block: [{ binding: "SURPRISE" }] });
    expect(complaint, "the closed world accepted a top-level key nothing classifies").not.toBeNull();
    expect(complaint).toContain("mailda_unheard_of_block");
    expect(complaint).toContain("BINDING_KINDS");
  });

  it("says how a customer comes to have every binding block it declares", () => {
    // A new binding block is a question about the customer's first five minutes: does the button create
    // this, and if not, who does? Failing here is that question being asked at the moment somebody still
    // has the context to answer it. Declared blocks only — see BINDING_KINDS on why an undeclared block
    // gets no entry until something declares it.
    const unclassified = bindingBlocksIn(config).filter((key) => !(key in BINDING_KINDS));
    expect(
      unclassified.length === 0 ? null
        : `${unclassified.join(", ")} declared in wrangler.jsonc with no entry in BINDING_KINDS — say `
          + "whether a customer's install provisions it, and if not, what does",
    ).toBeNull();
  });

  it("keeps BINDING_KINDS inside the shared world, so the two cannot drift apart", () => {
    // A kind here that wrangler-world.ts does not know as a binding block would be a provisioning claim
    // about a key the coverage tripwire never reads — the divergence #71 is about, in the other direction.
    const strangers = Object.keys(BINDING_KINDS).filter((kind) => !(kind in BINDING_BLOCKS));
    expect(strangers).toEqual([]);
  });

  it("says how anything the button cannot provision is provisioned instead", () => {
    const gaps = bindingKindsIn(config)
      .filter((kind) => !BINDING_KINDS[kind].provisionedByButton)
      .map((kind) => ({ kind, how: BINDING_KINDS[kind].how }));

    // Empty as of 6 August 2026: R2 was the last entry and direct measurement removed it. The
    // assertion stays because a *new* binding the customer's install cannot satisfy is the thing worth
    // failing on, and an empty list is the claim being made — not the absence of a claim.
    //
    // One exemption, and it exists because the guard fired correctly on a case it could not express.
    // A binding may be *under measurement*: declared precisely so somebody can find out whether the
    // button provisions it, which is a different state from having shipped one that it cannot. Without
    // this the only ways past a true assertion were to claim `provisionedByButton: true` unmeasured — the
    // overclaim the entry's own comment forbids — or to weaken the assertion for everything.
    //
    // Each exemption names the issue that will remove it, and the test below requires that issue to be
    // **open**, so an exemption cannot outlive its measurement. `workflows` is here for #55: the answer
    // is either a measured `true` with a receipt, or the binding is deleted. This list must never be a
    // place where an unprovisionable binding comes to rest.
    expect(gaps.map((gap) => gap.kind).filter((kind) => !(kind in UNDER_MEASUREMENT))).toEqual([]);
  });

  it("keeps every measurement exemption tied to a binding that is actually declared", () => {
    // The direction that lets an exemption rot: the binding goes, the entry stays, and the next binding
    // to reuse that key inherits a pass nobody granted it. Same closed-world discipline as
    // `wrangler-world.ts` — both directions, or the registry drifts.
    const declared = bindingKindsIn(config) as string[];
    const stale = Object.keys(UNDER_MEASUREMENT).filter((kind) => !declared.includes(kind));
    expect(
      stale.length === 0 ? null
        : `${stale.join(", ")} is exempt as under-measurement but is not declared in wrangler.jsonc — `
          + "delete the exemption, which is what closing the measurement looks like",
    ).toBeNull();

    // And an exemption may not be silent about what it is waiting for.
    for (const [kind, entry] of Object.entries(UNDER_MEASUREMENT)) {
      expect(entry.issue, `${kind} must name the issue that removes it`).toBeGreaterThan(0);
      expect(entry.question.length, `${kind} must state the open question`).toBeGreaterThan(30);
    }
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
    // Compared over the whole shared world rather than over BINDING_KINDS, so a block declared in one
    // scope and not the other is caught even before it has a provisioning entry. Whether env.test's own
    // keys are classified is not asked here — the guard above already covers every environment.
    expect(bindingBlocksIn(testEnv!)).toEqual(bindingBlocksIn(config));
  });

  it("classifies every named environment, not only the one called test", () => {
    // The reason `env` may be a non-binding field is that its values are classified in their own right.
    // Both tripwires used to reach for `env.test` by name, so a second environment was classified by
    // neither — #71's hole one level down, and the same permissive direction. `unclassifiedKeys`
    // iterates, so this fails without either test file knowing an environment's name.
    const complaint = unclassifiedKeys({
      ...config,
      env: { ...config.env, staging: { mailda_unheard_of_block: [{ binding: "SURPRISE" }] } },
    });
    expect(complaint, "a binding block hid in an environment nothing looks up by name").not.toBeNull();
    expect(complaint).toContain("env.staging.mailda_unheard_of_block");
  });

  it("refuses an env block inside a named environment, since environments do not nest", () => {
    // The one rule in the shared world that the real config cannot exercise, so it is exercised here
    // rather than left as an untested branch: `env` is a top-level field, and an `env` under `env.test`
    // would be silently ignored by wrangler while reading as configuration that does something.
    const complaint = unclassifiedKeys(
      { env: { staging: {} } }, { label: "wrangler.jsonc env.test", kind: "environment" },
    );
    expect(complaint, "a nested env was accepted as configuration").not.toBeNull();
    expect(complaint).toContain("top-level-only");
  });

  /**
   * A workflow schedule needs a wrangler floor this repo does not currently declare.
   *
   * `workflow-provisioning.md` measured it: `schedules` shipped in **4.97.0**, and wrangler **4.68.0** —
   * the bottom of this repo's `^4.68.0` range — discards the field with a warning and **exit code 0**.
   * The deploy succeeds, the binding table still reports the workflow, and the schedule does not exist.
   * A customer resolving the bottom of the range would install a Butler that never fires.
   *
   * Conditional on purpose. Nothing declares `schedules` today, so raising the dependency now would be
   * a change with no reason attached — and a comment saying "remember to raise the floor" is exactly the
   * kind of thing this file exists instead of. The moment somebody adds the field, this fails and says
   * why. There is no `doctor` check that could substitute: the Worker cannot see whether a schedule it
   * declared was registered, because Workflows exposes no schedule-inspection API.
   */
  it("requires a wrangler floor that understands schedules, if it declares any", () => {
    const withSchedules = (config.workflows ?? []).filter((entry) => "schedules" in entry);
    if (withSchedules.length === 0) return;  // nothing declares one yet; the guard is for when it does

    const workerPackage = JSON.parse(
      readFileSync(join(WORKER_DIR, "package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const range = workerPackage.devDependencies?.wrangler ?? "";
    const floor = /(\d+)\.(\d+)\./.exec(range);
    expect(floor, `could not read a wrangler floor from ${range}`).not.toBeNull();

    // The floor comes from the receipt rather than being written here twice.
    const required = BUDGETS["workflow.schedules_min_wrangler"];
    const requiredMajor = Math.floor(required);
    const requiredMinor = Math.round((required - requiredMajor) * 100);
    const [major, minor] = [Number(floor![1]), Number(floor![2])];
    const ok = major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
    expect(
      ok ? null : `wrangler ${range} permits ${major}.${minor}, which is below ${required} and `
        + "drops workflows[].schedules silently with exit code 0 — see docs/receipts/workflow-provisioning.md",
    ).toBeNull();
  });
});
