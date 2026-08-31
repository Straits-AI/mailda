import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

import {
  BINDING_BLOCKS, bindingBlocksIn, blocksWithUnreadableShape, CONFIG_PATH, readWranglerConfig,
  unclassifiedKeys, WORKER_DIR, type ConfigScope,
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
  name?: string;
  /** #50's Butler engine. Typed so the guards below read the real shape rather than `any`. */
  workflows?: { binding?: string; name?: string; class_name?: string; schedules?: unknown }[];
  env?: Record<string, WranglerConfig>;
};

const config = readWranglerConfig() as WranglerConfig;

/**
 * How a customer comes to have each binding block this config declares.
 *
 * Deliberately keyed by *declared* block rather than by every block `wrangler-world.ts` recognises. Each
 * entry is a measured claim about somebody's first five minutes, and a block nothing declares has no
 * measurement behind it.
 *
 * The `workflows` entry was written **before** the block was declared, which is unusual here and was the
 * right call: #55 measured the question that would otherwise have been asked at the worst moment, and #50
 * then declared the block. Both halves are now real.
 */
const BINDING_KINDS = {
  /*
   * Declared since #50: one `ButlerRun` workflow for every Butler on the Node.
   *
   * #55 measured the question that would otherwise have been asked at the worst moment: whether a
   * customer's install can provision one. It can. The measurement is in `workflow-provisioning.md` and the
   * value below is `workflow.provisioned_by_button`, so this entry moves if that figure ever does.
   *
   * The finding behind it is worth carrying: the Workers Builds token has **no Workflows scope at all**, and
   * creating a workflow rides on `Workers Scripts:Edit`. So the scope list cannot be used to predict this —
   * an absent scope is not an absent capability when the capability belongs to another scope.
   */
  workflows: {
    provisionedByButton: Boolean(BUDGETS["workflow.provisioned_by_button"]),
    how:
      "Created by the deploy itself, like D1 and R2 and unlike Secrets Store: the binding declares name, " +
      "binding and class_name with no resource id. Measured twice — through an interactive OAuth token " +
      "(#47) and through the Deploy button's own Workers Builds token (#55), which is the harder case " +
      "§11A's one-click equivalence claim actually rests on.",
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
  version_metadata: {
    provisionedByButton: true,
    how:
      "Not a resource at all: Cloudflare populates it from the version being run, so there is nothing an " +
      "install can fail to create and nothing account-specific to write into a fork (ADR 24). It exists " +
      "because `mailda deploy` checks a canary through a version override and Cloudflare falls back to the " +
      "traffic percentages when an override cannot be applied — so the gate compares the responder's " +
      "version id with the uploaded one, and the Worker has to be able to name itself " +
      "(preview-urls-and-durable-objects.md). A Node installed before this binding existed reports " +
      "`version: null`, which the CLI treats as a refusal rather than a pass.",
  },
  queues: {
    /*
     * The **queue** is provisioned by the deploy. The **consumer** is not, and since #72 cannot be.
     *
     * This entry used to say the deploy created the queue and attached the consumer in one go, which was
     * measured and true and is no longer what this config asks for. A queue name is account-scoped, so the
     * name that made that work made the *second* Node in one account unusable: its consumer registration
     * failed with "already has a consumer" and its producer binding attached to the **first** Node's queue,
     * so one Node's sending events were drained by another Node's consumer across two D1 catalogs.
     *
     * So the producer binding now names no queue and the consumers block is gone. `provisionedByButton`
     * still reads `queues.producer_binding_provisions`, and that value is still the right one to lean on —
     * it is what makes a *producer* binding a provisioning lever at all. What it does **not** cover is the
     * nameless case: it was measured with a named queue, so *that provisioning fires without a name at all*
     * and *what the derived name is* are both Cloudflare's documentation and unmeasured here. Nor does it
     * cover the consumer — which is why the `how` below sends the reader to a script rather than the deploy,
     * and why that script discovers the queue and refuses when a deploy provisioned none.
     */
    provisionedByButton: Boolean(BUDGETS["queues.producer_binding_provisions"]),
    how:
      "The queue is created by the deploy itself, like D1 and R2: the producer binding names a binding and " +
      "no queue. Measured with a *named* queue — a producer binding provisions it, a bare consumer block " +
      "fails the deploy outright (queue-provisioning.md). That a **nameless** producer binding provisions " +
      "a per-Worker queue is Cloudflare's documentation and is unmeasured here, which is why the attach " +
      "step discovers the queue and refuses when it finds none. The **consumer** is not " +
      "provisioned by any install path and cannot be declared here — a consumers block is refused without " +
      "a string queue field, and the derived name is not knowable in this file — so it is attached out of " +
      "band by `pnpm --filter @mailda/worker run queue:attach-consumer`, which discovers the queue from the " +
      "deployed binding. The event *subscription* that feeds the queue is a second account-level object, " +
      "API-only, and equally absent. So a button-only install observes no delivery outcomes until both are " +
      "done: doctor's sending_events_consumer names the gap and delivery_visibility names its consequence.",
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

/**
 * Keys that name a resource whose name must be **unique within the account**.
 *
 * A different property from the list above and it took #72 to separate them. A queue name is not an id, so
 * `mailda-sending-events` passed the id check for weeks — and it was as install-breaking as an id, in a
 * worse way. Queues are account-scoped: the second Node in one account failed its consumer registration
 * with "already has a consumer" *and* had its producer binding attach to the **first** Node's queue, so one
 * Node's sending events were drained by another Node's consumer across two D1 catalogs. Nothing looked
 * broken on either Node.
 *
 * The shape that works is the one D1 and R2 already use: declare the binding, let the deploy derive the
 * name from the Worker's name, which is per-install by construction.
 *
 * `dead_letter_queue` is listed although nothing declares one, because it is the same kind of name and the
 * point is to catch it before it arrives rather than after.
 */
const ACCOUNT_SCOPED_NAME_KEYS = ["queue", "queue_name", "dead_letter_queue"];

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

  it("commits no name that has to be unique within the account (#72)", () => {
    const offenders = keyPaths(config)
      .filter((entry) => ACCOUNT_SCOPED_NAME_KEYS.includes(entry.key))
      .map((entry) => entry.path);

    // The property the id check above misses, and the reason #72 got past it: a queue name is not an id, so
    // committing one passed every check here while making the *second* install into an account bind its
    // producer to the *first* Node's queue. Let the deploy derive the name from the Worker's name instead,
    // which is what D1 and R2 already do.
    expect(
      offenders.length === 0 ? null
        : `${offenders.join(", ")} name(s) an account-scoped resource in committed config. A name that must `
          + "be unique within an account is as install-breaking as a committed id: the second Node in one "
          + "account collides with the first, and a queue producer silently attaches to the queue that is "
          + "already there (#72). Declare the binding and let the deploy derive the name",
    ).toBeNull();
  });

  /**
   * A workflow's `name` is an account-level resource name, and it is **required** — so #72's rule cannot be
   * applied to it the way it was applied to the queue.
   *
   * That fix was *declare the binding and let the deploy derive the name*, which worked because a queue
   * producer's `queue` field is omissible (`queues.producer_queue_name_omissible`, measured). A
   * `[[workflows]]` entry without `name` is refused by the config parser outright — it is in `required`
   * alongside `binding` and `class_name` — and wrangler substitutes nothing into config *values*, so
   * `--var` and `--define` are no route either. The name has to be committed.
   *
   * What is enforced instead is the next best property: the workflow's name is the **Worker's own name**
   * plus a suffix. That makes renaming the Worker rename the workflow in the same edit, so this file can
   * never commit an account-scoped name that has drifted away from the one it already commits.
   *
   * **The residual is real and is stated rather than hidden.** Workers Builds pins its own Worker name and
   * overrides this file, so a second install into one account gets a different *Worker* name and the same
   * *workflow* name. What happens then is **unmeasured**: the queue case collided silently (#72), and this
   * one is not known to. It is the first thing to check when a second Node goes into an account, and the
   * comment in `wrangler.jsonc` says so where an installer reads it.
   */
  it("names every workflow after the Worker, since a workflow name is account-scoped and required", () => {
    const scopes: Array<[string, WranglerConfig]> = [
      ["wrangler.jsonc", config],
      ...Object.entries(config.env ?? {}).map(([name, scope]) => [`env.${name}`, scope] as [string, WranglerConfig]),
    ];
    const worker = config.name;
    expect(worker, "the Worker has no name to derive from").toBeTypeOf("string");

    const offenders = scopes.flatMap(([where, scope]) =>
      (scope.workflows ?? []).flatMap((entry) => {
        const name = entry.name;
        return typeof name === "string" && name.startsWith(`${String(worker)}-`)
          ? []
          : [`${where}: ${JSON.stringify(name)}`];
      }));

    expect(
      offenders.length === 0 ? null
        : `${offenders.join(", ")} — a workflow's name is an account-level resource name and cannot be `
          + `omitted, so it must be derived by hand from the Worker's own name (${String(worker)}) and `
          + "checked here. See the comment above and wrangler.jsonc's [[workflows]] block",
    ).toBeNull();

    // Non-vacuity: the rule fires on a name that does not derive from the Worker's, without editing config.
    const strangers = [{ binding: "X", name: "butler-runs", class_name: "X" }]
      .filter((entry) => !entry.name.startsWith(`${String(worker)}-`));
    expect(strangers, "the derivation rule accepted a name unrelated to the Worker's").toHaveLength(1);
  });

  it("declares a workflow whose block the shared world can read, and no schedules on it", () => {
    // Both halves in one place because they are one question about the same block. #48 established that
    // this Node declares no `schedules` — they are deploy-time config while Butlers are published at
    // runtime, so scheduling multiplexes through `triggers.crons` — and the guard at the bottom of this
    // file is therefore correct while never firing. Asserted here so "never fires" is a fact about the
    // config rather than an assumption about it.
    expect(bindingBlocksIn(config)).toContain("workflows");
    expect(blocksWithUnreadableShape(config)).toEqual([]);
    const withSchedules = (config.workflows ?? []).filter((entry) => "schedules" in entry);
    expect(
      withSchedules.length === 0 ? null
        : "wrangler.jsonc declares workflows[].schedules. #48 decided this Node never does — schedules are "
          + "deploy-time config and a Butler is published at runtime — so scheduling goes through "
          + "triggers.crons. If that decision has been reopened, the wrangler floor below now binds",
    ).toBeNull();
  });

  it("declares no queue consumer, because a consumer cannot name a derived queue", () => {
    // Both halves of this are measured (queue-provisioning.md, 19 August 2026) and both are read from the
    // receipt rather than restated here, so that if either measurement flips this test says the rule has
    // changed instead of going on enforcing an obsolete one.
    expect(
      BUDGETS["queues.consumer_queue_name_required"] === 1
        ? null
        : "a consumers block no longer needs a queue field, so the consumer may be declarable here after "
          + "all — re-read docs/receipts/queue-provisioning.md before trusting this test",
    ).toBeNull();
    expect(
      BUDGETS["queues.producer_queue_name_omissible"] === 1
        ? null
        : "a producer binding can no longer omit its queue name, so a per-Worker derived queue is not "
          + "available and #72 needs a different answer — re-read docs/receipts/queue-provisioning.md",
    ).toBeNull();

    // So the consumer is attached out of band, and a consumers block reappearing here means somebody has
    // re-introduced either a hardcoded account-scoped name or a config the parser rejects.
    const blocks = keyPaths(config)
      .filter((entry) => entry.key === "consumers" && /(^|\.)queues\.consumers$/.test(entry.path))
      .map((entry) => entry.path);
    expect(
      blocks.length === 0 ? null
        : `${blocks.join(", ")} declared. A consumers block needs a string queue field (wrangler refuses `
          + "without one) and the queue's name is derived per Node, so it cannot be declared here at all. "
          + "The consumer is attached by scripts/attach-queue-consumer.mjs",
    ).toBeNull();
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

/**
 * The one thing about this Worker that **no install path provisions**: its queue consumer.
 *
 * Everything in the describe above asks whether a customer's deploy can create what the config declares.
 * This asks the opposite question, which #72 forced into existence: the consumer *cannot* be declared, so it
 * is attached by a script, and a script nothing checks is a step that quietly stops existing. Three ways
 * that goes wrong and all three are cheap to catch here — the script disappearing, the script losing the
 * binding it discovers by, and the script being chained into `deploy` after somebody decides it should not
 * be.
 *
 * What the script *does* when it runs is a different question and is answered in
 * `test/node/attach-queue-consumer.test.ts`, which runs it against a stub wrangler: whether it discovers
 * the queue rather than composing a name, whether a second run succeeds, and what it refuses.
 */
describe("the queue consumer, which no install path attaches", () => {
  const scriptPath = join(WORKER_DIR, "scripts", "attach-queue-consumer.mjs");
  const workerPackage = JSON.parse(readFileSync(join(WORKER_DIR, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = workerPackage.scripts ?? {};

  it("has a script wired into package.json under a name that says what it does", () => {
    expect(existsSync(scriptPath), `${relative(repoRoot, scriptPath)} is missing`).toBe(true);
    const entry = scripts["queue:attach-consumer"];
    expect(
      entry === undefined
        ? "no queue:attach-consumer script in apps/node/worker/package.json — the consumer is attached by "
          + "nothing, and a Node with no consumer observes no delivery outcomes at all"
        : null,
    ).toBeNull();
    expect(entry).toContain("attach-queue-consumer.mjs");
  });

  it("discovers the binding by the name the config declares, rather than repeating it", () => {
    // A rename of SENDING_EVENTS would otherwise leave the script looking for a binding that no longer
    // exists — and it would fail at the worst moment, on an operator's machine, after a deploy.
    const producers = (config.queues as { producers?: Record<string, unknown>[] } | undefined)?.producers
      ?? [];
    const declared = producers.map((producer) => producer.binding).filter((name) => typeof name === "string");
    expect(declared.length, "wrangler.jsonc declares no queue producer binding").toBeGreaterThan(0);

    const source = readFileSync(scriptPath, "utf8");
    // The script reads `queues.producers[].binding` out of wrangler.jsonc. That is the property under test:
    // the name must come *from* the config, so the config's own path into it has to appear in the source.
    expect(source).toContain("config.queues?.producers");
    for (const name of declared) {
      // And the binding is named in the script's prose too, so a reader knows which one it means. That is
      // documentation rather than behaviour — hence a separate expectation with its own reason.
      expect(source, `${String(name)} is not mentioned anywhere in the attach script`).toContain(String(name));
    }
  });

  it("is deliberately not chained into deploy, and that decision is enforced rather than remembered", () => {
    /*
     * Three reasons, and they are here because a future reader will otherwise "fix" this by adding it.
     *
     * 1. The button's install path never runs this script anyway. Cloudflare runs `npx wrangler deploy`
     *    directly and never sees `package.json` scripts (measured: deploy-button-install.md), so chaining
     *    would serve only the CLI path while leaving the case that matters most untouched.
     * 2. Discovery needs the Worker to already exist and to be the *live* deployment. Ordering after
     *    `wrangler deploy` satisfies that, but a failure — a token without Queues edit, a gradual
     *    deployment in flight, a deploy that provisioned no queue — would turn a working install red, and
     *    an installed Node with no consumer is fully functional except that it observes no delivery
     *    outcomes. AGENTS.md §6: never trade a working product for unfinished complexity.
     * 3. Attaching a consumer is a one-time account-level act, and `deploy` runs on every redeploy. Two
     *    extra API round trips and a new hard-failure surface on every deploy, for a state that does not
     *    change, is a bad trade.
     *
     * The cost is accepted and made visible instead: doctor's `sending_events_consumer` says the step
     * exists and cannot be checked from inside a Worker, `delivery_visibility` fails from evidence when the
     * silence it causes is real, and the README says so where an installer reads it.
     */
    // The property, not the exact command: pinning the whole string would fail on any legitimate change to
    // `deploy` with a message that explains nothing. Asserted as a string first, because `undefined` would
    // satisfy the rule below by containing nothing at all.
    expect(scripts.deploy, "no deploy script to check").toBeTypeOf("string");
    expect(
      /attach/.test(scripts.deploy ?? "")
        ? `deploy now runs the consumer attach: "${scripts.deploy}". If that is deliberate, the argument in `
          + "this test is what has to change first — a discovery failure inside deploy turns a working "
          + "install red, and the button's install path does not run deploy at all"
        : null,
    ).toBeNull();
  });
});
