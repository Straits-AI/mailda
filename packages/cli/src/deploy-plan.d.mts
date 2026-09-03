/**
 * Types for `deploy-plan.mjs`, so a TypeScript test can import it.
 *
 * `deploy-parse.d.mts`'s argument, unchanged and with the same bounded drift: the CLI is plain JavaScript
 * with no build step, which is what keeps `mailda` a file an operator can read, so this hand-written
 * declaration is the one thing here that can disagree with its implementation. It stays honest because
 * `test/node/deploy-plan.test.ts` calls every function below with real values and compares real answers — a
 * declaration nobody calls is the dangerous kind.
 */

/** What a deploy would do to one resource. See `DISPOSITION_SAYS` for what each costs when misreported. */
export type Disposition = "create" | "linked" | "cannot_adopt" | "orphaned" | "stolen" | "unknown";

export type ResourceKind = "d1" | "r2" | "queue" | "workflow";

export interface Resource {
  kind: ResourceKind;
  binding: string;
  name: string;
  /**
   * Whether wrangler derives the name from the Worker's.
   *
   * `false` for every Workflow, which is the whole of #99: a Workflow entry requires a name, so a renamed
   * Node keeps pointing at the original's Workflow — and a Workflow is owned by exactly one script.
   */
  derived: boolean;
}

export interface PlannedResource extends Resource {
  /** `null` when the list could not be read, which is **not** the same as absent. */
  present: boolean | null;
  /** The owning script, for a Workflow. `null` must never be read as *nobody owns it*. */
  owner: string | null;
  disposition: Disposition;
}

export interface UnwindStep {
  step: string;
  why: string;
  kind: string;
  /** The resource to name in the command, or `null` for the Worker itself. */
  target: string | null;
  /** Only on `queue-consumer`, whose command needs both the queue and the Worker. */
  consumer?: string;
}

export interface Inventory {
  /** `null` when the Worker's own existence could not be established, which blocks the plan. */
  worker: boolean | null;
  /** Raw `wrangler … list` text per kind; `null` for a call that failed. */
  lists: Record<ResourceKind, string | null>;
}

export interface Plan {
  worker: string;
  verdict: "install" | "redeploy" | "blocked" | "unknown";
  installed: boolean | null;
  items: PlannedResource[];
  /** The resources whose list could not be read, named rather than assumed empty. */
  unread: PlannedResource[];
  unwind: UnwindStep[];
}

/** Every resource a deploy of this config would touch, with wrangler's own naming rule applied. */
export function resourcesFrom(configText: string): { worker: string; resources: Resource[] };

/** Whether a name appears in a list's text. `null` for an unread list. */
export function presenceIn(listText: string | null | undefined, name: string): boolean | null;

/** Which script owns a Workflow, from `wrangler workflows list`. `null` when it cannot be established. */
export function workflowOwnerIn(listText: string | null | undefined, name: string): string | null;

export function dispositionOf(args: {
  resource: Resource;
  installed: boolean | null;
  present: boolean | null;
  owner: string | null;
  workerName: string;
}): Disposition;

/** The teardown order, declared as data so a plan can filter it to the steps that apply. */
export const UNWIND_ORDER: readonly { step: string; why: string }[];

export function planFor(args: { configText: string; inventory: Inventory }): Plan;

export function unwindFor(args: {
  items: Array<{ kind: string; name: string; disposition: string }>;
  installed: boolean | null;
  worker: string;
}): UnwindStep[];

/** What each disposition means, in an operator's words rather than the enum's. */
export const DISPOSITION_SAYS: Record<Disposition, string>;

/** The exact command per unwind step, so an operator copies rather than reconstructs. */
export const COMMAND_FOR: Record<string, (step: UnwindStep) => string>;

/**
 * The plan as text.
 *
 * Returned rather than printed, and living here rather than in `mailda.mjs` — that file dispatches on
 * `process.argv` at the top level, so importing it runs it. The words are the deliverable of `--plan`, and a
 * plan whose dispositions are right and whose sentences say the opposite is one an operator acts wrongly on.
 */
export function renderPlan(plan: Plan): string;
