import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";

/**
 * What a key in `wrangler.jsonc` is: a binding block, or a field that binds nothing. Closed, so an
 * unrecognised key fails.
 *
 * ## Why this is one module and not a list in each test
 *
 * Two tripwires needed the same answer and each hand-maintained its own, differently and incompletely
 * (#71). `cost-meter-coverage.test.ts` iterated five block names it listed itself — under a doc comment
 * claiming it read them from the config, which was the exact "claim nothing enforces" pattern that test
 * was written to close. `deployability.test.ts` matched `_databases` / `_buckets` / `_namespaces`
 * suffixes plus six exact names, in a file that already knew `workflows` was a binding block (it types
 * the field and reads it for the schedules guard) and still left it out of its own coverage check.
 *
 * Neither would have noticed a `[[workflows]]` block. Layer 4 chose Workflows as the Butler engine, so
 * that is very likely the next block this config gains: a Workflow step touching an unclassified binding
 * would have been priced as free, and its provisioning question never asked. Two guards over one property
 * with two different incomplete rules is how both come to be trusted and neither is sufficient.
 *
 * They remain two files because they ask different questions of the same world:
 *
 * | file | question it answers |
 * |---|---|
 * | `cost-meter-coverage.test.ts` | is every binding **name** classified in `src/cost-meter.ts`? |
 * | `deployability.test.ts` | can a customer's install **provision** every binding **block**? |
 *
 * This module answers only what is underneath both: which keys are binding blocks, which are not, and
 * what the bindings in a block are called.
 *
 * ## The world is closed, in the shape `src/cost-meter.ts` already uses
 *
 * The meter classifies every binding *name* as metered or free and **throws** on anything else. The same
 * inversion applies one level up: every key in the file is a declared binding block or a declared
 * non-binding field, and anything else fails. An allowlist of block types can only catch bindings
 * somebody already thought of, which excludes the only one that matters — the next one.
 *
 * `env` is not a leaf in that world: `unclassifiedKeys` descends into **every** named environment by
 * iteration, never by reaching for `env.test` by name, because a second environment declaring a binding
 * block was the same hole one level down.
 *
 * Counted on 19 August 2026 by parsing the file with `jsonc-parser` and grouping its keys against
 * `BINDING_BLOCKS` below: **15** top-level keys, 5 binding blocks and 10 non-binding fields; `env.test`
 * declares 5 keys, all 5 of them binding blocks. Those totals are **not enforced anywhere and should not
 * be** — the tests read the file, and a hardcoded total would fail on a legitimate new non-binding field
 * without telling anyone anything the closed world does not already say. They are here so a reader can
 * tell at a glance whether this module has fallen behind the config.
 */

/** The top level of `wrangler.jsonc`, or one named environment under `env`. Both are classified. */
export type ConfigScope = Record<string, unknown>;

export const WORKER_DIR = resolve(import.meta.dirname, "..", "..");
export const CONFIG_PATH = join(WORKER_DIR, "wrangler.jsonc");

export function readWranglerConfig(): ConfigScope {
  return parseJsonc(readFileSync(CONFIG_PATH, "utf8")) as ConfigScope;
}

/**
 * `null` rather than `[]` when the block is not the shape this reader understands.
 *
 * The distinction is the whole value of the reader: a block whose shape changed under us would otherwise
 * yield no binding names and read as "nothing to classify", which is the silent, permissive direction.
 */
type ReadEntries = (block: unknown) => unknown[] | null;

const arrayOfEntries: ReadEntries = (block) => (Array.isArray(block) ? block : null);

/** `durable_objects.bindings`, `queues.producers` — an object wrapping the list that names bindings. */
const entriesUnder = (key: string): ReadEntries => (block) => {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return null;
  const inner = (block as Record<string, unknown>)[key];
  // Absent is legitimate, and the queues block is why: a consumer binds nothing, so a block could once
  // declare consumers only. Since #72 this config declares producers only and no consumers at all — the
  // consumer cannot name a queue whose name the deploy derives — so the tolerance is now for the shape this
  // reader might meet rather than the one it does. Left in place deliberately: it returns "no bindings
  // here", never "unreadable", and the difference is what `blocksWithUnreadableShape` exists to preserve.
  if (inner === undefined) return [];
  return Array.isArray(inner) ? inner : null;
};

interface BindingBlock {
  /** The entries in the block that each declare one binding. */
  entries: ReadEntries;
  /** The property on an entry carrying the name the Worker sees on `env`. */
  nameKey: "binding" | "name";
  /** Why this key is in the world, for the reader deciding whether a new key belongs beside it. */
  note: string;
}

/**
 * Every key that puts something on `env`, and how to read the names out of it.
 *
 * Blocks this config does not declare are listed too, because the point is to recognise the block before
 * it arrives rather than after. Their entry shapes are unverified against a real deploy until something
 * declares one — which is why `blocksWithUnreadableShape` exists: the moment a block appears, its shape
 * claim here is checked instead of assumed.
 */
export const BINDING_BLOCKS: Record<string, BindingBlock> = {
  d1_databases: { entries: arrayOfEntries, nameKey: "binding", note: "declared: CATALOG (ADR 18)" },
  r2_buckets: { entries: arrayOfEntries, nameKey: "binding", note: "declared: EVIDENCE (ADR 18)" },
  send_email: {
    entries: arrayOfEntries,
    nameKey: "name",
    // The one block that names its binding `name` rather than `binding`; the old readers special-cased it.
    note: "declared: EMAIL (ADR 23, ADR 33)",
  },
  durable_objects: {
    entries: entriesUnder("bindings"),
    nameKey: "name",
    note: "declared: OUTBOX_SWEEPER, KEY_VAULT (ADR 28)",
  },
  queues: {
    entries: entriesUnder("producers"),
    nameKey: "binding",
    // Read off `producers` and nothing else, which is what let #72's fix land here without a change: the
    // consumers block is gone (a consumer cannot name a queue whose name the deploy derives) and consumers
    // never contributed a binding name anyway. The producer entry now carries `binding` and **no** `queue`,
    // and `binding` is the only property this reader wants, so removing the name did not blind it either.
    note: "declared: SENDING_EVENTS, with no queue name. The producer is the provisioning lever; the "
      + "consumer is attached out of band by scripts/attach-queue-consumer.mjs and is not in this config.",
  },
  workflows: {
    entries: arrayOfEntries,
    nameKey: "binding",
    // An entry carries `binding`, `name` and `class_name` and no resource id
    // (docs/receipts/workflow-provisioning.md); `binding` is the one that lands on `env`.
    note: "not declared yet. Layer 4's Butler engine, so the next block this config is likely to gain.",
  },
  kv_namespaces: { entries: arrayOfEntries, nameKey: "binding", note: "not declared. Nothing needs it yet." },
  secrets_store_secrets: {
    entries: arrayOfEntries,
    nameKey: "binding",
    note: "not declared: it needs an account-specific store_id in committed config (ADR 24, ADR 28).",
  },
  vectorize: { entries: arrayOfEntries, nameKey: "binding", note: "not declared. Search is D1 today." },
  hyperdrive: { entries: arrayOfEntries, nameKey: "binding", note: "not declared. A Node owns its own D1." },
};

/**
 * Every key that binds nothing, with the reason it binds nothing.
 *
 * Enumerated from the file rather than guessed: the ten entries below were, on 19 August 2026, exactly the
 * ten non-binding keys `wrangler.jsonc` declares — counted by parsing it. That correspondence is
 * **deliberately unenforced**, and the asymmetry is the reason: an entry left behind after a field is
 * removed from the config widens only what is *permitted*, and every key here puts nothing on `env`, so it
 * cannot hide a binding. A key *missing* from here is the direction that hides one, and that fails.
 *
 * A new key fails on purpose — classifying it takes a line, and the alternative is a permissive default
 * that hides the binding block nobody has thought of, which is the entire reason this world is closed.
 */
export const NON_BINDING_FIELDS: Record<string, { why: string; topLevelOnly?: true }> = {
  $schema: { why: "editor completion for this file" },
  name: { why: "the Worker's name" },
  main: { why: "the entry module" },
  compatibility_date: { why: "the runtime version pin" },
  observability: { why: "the Workers Logs toggle" },
  migrations: { why: "Durable Object class migrations: they name classes, they bind nothing" },
  rules: { why: "module rules for non-JS imports (.client.js served as Text)" },
  build: { why: "the client build wrangler runs before upload (ADR 30)" },
  triggers: { why: "cron schedules; they arrive as a scheduled event, never as a property of env" },
  // Not a leaf: `unclassifiedKeys` descends into every value under it, so the reason given here is a
  // behaviour of this module rather than a promise about one. Naming only `env.test` would have left a
  // second environment unclassified — #71's hole one level down.
  env: { why: "named environments, each value a scope classified in its own right", topLevelOnly: true },
};

/** The binding blocks a scope declares. */
export function bindingBlocksIn(scope: ConfigScope): string[] {
  return Object.keys(BINDING_BLOCKS).filter((key) => scope[key] !== undefined);
}

/** Every binding name a scope declares — the names that appear on `env` and must be priced. */
export function bindingNamesIn(scope: ConfigScope): string[] {
  const names = bindingBlocksIn(scope).flatMap((key) => {
    const block = BINDING_BLOCKS[key]!;
    return (block.entries(scope[key]) ?? []).flatMap((entry) => {
      const name = entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>)[block.nameKey]
        : undefined;
      return typeof name === "string" ? [name] : [];
    });
  });
  return [...new Set(names)];
}

/**
 * Blocks whose shape this module does not understand, so their bindings would go unseen.
 *
 * This is what keeps the entry shapes above from being unenforced claims about blocks nothing declares:
 * a `workflows` block that is an object, or an entry without the property that names the binding, fails
 * here instead of contributing nothing and looking clean.
 */
export function blocksWithUnreadableShape(scope: ConfigScope): string[] {
  return bindingBlocksIn(scope).filter((key) => {
    const block = BINDING_BLOCKS[key]!;
    const entries = block.entries(scope[key]);
    if (entries === null) return true;
    return entries.some(
      (entry) => entry === null || typeof entry !== "object"
        || typeof (entry as Record<string, unknown>)[block.nameKey] !== "string",
    );
  });
}

/** Where a scope sits, since `env` is a field the top level may have and a named environment may not. */
export interface Scope {
  /** What to call this scope in a failure message. */
  label: string;
  /** The top level of the file, or one entry under `env`. */
  kind: "top level" | "environment";
}

export const TOP_LEVEL: Scope = { label: "wrangler.jsonc", kind: "top level" };

/** Why the keys of one scope are not closed over, each line already naming where the key sits. */
function reasonsIn(scope: ConfigScope, at: Scope, path: string): string[] {
  const problems = Object.keys(scope).flatMap((key) => {
    if (key in BINDING_BLOCKS) return [];
    const field = NON_BINDING_FIELDS[key];
    if (field === undefined) {
      return [`  ${path}${key}  is neither a binding block nor a non-binding field`];
    }
    if (field.topLevelOnly === true && at.kind !== "top level") {
      return [`  ${path}${key}  is a top-level-only field (${field.why}) and cannot appear in ${at.label}`];
    }
    return [];
  });

  const misshapen = blocksWithUnreadableShape(scope).map(
    (key) => `  ${path}${key}  is a known binding block whose shape wrangler-world.ts cannot read, so its`
      + ` bindings would go unseen. Every entry must be an object carrying a string`
      + ` ${BINDING_BLOCKS[key]!.nameKey}.`,
  );

  return [...problems, ...misshapen];
}

/**
 * Every named environment under `env`, classified in its own right — which is what makes the reason given
 * for `env` in NON_BINDING_FIELDS a behaviour rather than a claim.
 *
 * Descends by iteration, never by name. Both tripwires used to reach for `env.test` specifically, so a
 * second environment declaring a binding block was unclassified by both: #71's hole one level down.
 */
function reasonsUnderEnv(scope: ConfigScope, at: Scope): string[] {
  const environments = scope.env;
  if (environments === undefined) return [];
  if (environments === null || typeof environments !== "object" || Array.isArray(environments)) {
    return [`  env  is not a map of named environments, so the scopes under it cannot be classified`];
  }
  return Object.entries(environments as Record<string, unknown>).flatMap(([name, child]) => {
    if (child === null || typeof child !== "object" || Array.isArray(child)) {
      return [`  env.${name}  is not a configuration scope, so its keys cannot be classified`];
    }
    return reasonsIn(
      child as ConfigScope,
      { label: `${at.label} env.${name}`, kind: "environment" },
      `env.${name}.`,
    );
  });
}

/**
 * The closed-world check itself: `null` when every key in the scope is classified, else why not.
 *
 * At the top level this covers every named environment too, so one call closes the whole file. The message
 * names the key, both ways to classify it, and the files that then have to agree — a developer meeting this
 * failure is part-way through adding a binding, and the useful thing is the next action rather than the
 * rule (AGENTS.md §3).
 */
export function unclassifiedKeys(scope: ConfigScope, at: Scope = TOP_LEVEL): string | null {
  const reasons = [
    ...reasonsIn(scope, at, ""),
    ...(at.kind === "top level" ? reasonsUnderEnv(scope, at) : []),
  ];

  if (reasons.length === 0) return null;
  return [
    `E_CONFIG_KEY_UNCLASSIFIED  ${at.label} (${at.kind}) has ${reasons.length} `
      + "key(s) this world does not close over",
    ...reasons,
    "  fix  a binding block goes in BINDING_BLOCKS in test/node/wrangler-world.ts, with the property that",
    "       names its bindings; those names then have to be classified in src/cost-meter.ts, and the block",
    "       needs an entry in BINDING_KINDS in test/node/deployability.test.ts saying how a customer comes",
    "       to have it. A key that binds nothing goes in NON_BINDING_FIELDS, with the reason it binds",
    "       nothing.",
  ].join("\n");
}
