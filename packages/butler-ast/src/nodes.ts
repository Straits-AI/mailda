/**
 * The node set: one declaration, read by the schema and by the checker (#49).
 *
 * ## Why one declaration rather than two lists
 *
 * A schema that admits `llm.classify` and a checker that has never heard of it produce a Butler that
 * publishes and cannot run. A checker that refuses `draft` while the schema types it produces a Butler
 * nobody can publish. Both are the same defect — two lists that must agree — and this repository has paid
 * for that shape enough times to stop writing it down twice. So the *status* lives here, the schema builds
 * its union from `Object.keys` of this object, and the checker classifies by reading `status`. Neither can
 * hold an opinion the other does not.
 *
 * ## The dividing line, drawn by looking rather than by taste
 *
 * **Storage that exists today.** `cases` has no field column, no case types and no `case_fields` table;
 * there is no label, tag, quarantine, task or note concept anywhere in the schema; and — found late, by
 * the groundwork for #54 and corrected into #49 — **there is no template subsystem at all**, so
 * `template.render` is reserved rather than shipped despite §16's worked example rendering
 * `lead-acknowledgement@4`. That correction is the ticket catching itself making the exact mistake the
 * line was drawn to prevent. It is not quietly moved back.
 *
 * What the shipped set can still do, so the narrowing is honest rather than fatal: *when mail arrives
 * matching a condition, assign the case to somebody and draft a reply, awaiting release.* What it cannot
 * do is render a versioned, reusable template.
 *
 * ## Reserved means representable and refused, which is a deliberate distinction
 *
 * A Butler naming `llm.classify` **parses** — it is a member of the discriminated union, with an
 * envelope-only payload — and is then refused by the checker with a reason naming the node. It does not
 * fail to parse. An author who writes tomorrow's node gets *"reserved, and here is why"* rather than
 * *"invalid discriminator value"*, and the AST is a record of what the language will contain rather than
 * of what it contains this month.
 *
 * ## The family boundary, stated rather than discovered
 *
 * `llm.*` and `connector.*` are families in §16's prose and **enumerated** here, because a discriminated
 * union cannot be open. `llm.*` enumerates exactly the five §16 names. `connector.*` has no catalogue to
 * enumerate — §6's connector work does not exist — so it is represented by the single name
 * `connector.call`. The consequence, said plainly: `connector.salesforce.upsert` is not a member of the
 * union, so it fails at *parse* with "not a node type in mailda/v1" rather than at *check* with a reserved
 * reason. An open `type` field would fix that and would also let a typo (`mail.send.propse`) read as a
 * future feature, which is the worse of the two failures.
 */

export interface NodeDeclaration {
  /**
   * `ships` — the checker admits it and the engine will be expected to execute it.
   * `reserved` — representable in the AST, refused at publication with `because` as the reason.
   */
  status: "ships" | "reserved";
  /**
   * Why. For a reserved node this is the sentence an author reads in the refusal, so it says what is
   * missing rather than "not implemented" — an author who is told a template subsystem does not exist can
   * choose `draft`; an author told "unsupported" cannot choose anything.
   */
  because: string;
}

/**
 * Declared `as const satisfies Record<string, NodeDeclaration>` rather than annotated with it.
 *
 * The annotation would widen `keyof typeof NODE_KINDS` to `string`, which makes `NodeKind` accept
 * `"anything"` and makes every exhaustive map in this package vacuously satisfiable. `test/nodes.test.ts`
 * asserts the closure at the type level, because the difference is invisible at every call site and a type
 * that looks like it constrains and does not is worse than no type at all.
 */
export const NODE_KINDS = {
  /* ---- control flow (§16: guard, switch, bounded map/foreach, join, wait, stop) ---- */
  guard: {
    status: "ships",
    because: "A predicate over the run's own state; needs no storage that does not exist.",
  },
  switch: {
    status: "ships",
    because: "A multi-way guard. Same argument, one edge per case.",
  },
  map: {
    status: "ships",
    because:
      "A bounded loop that collects each iteration's result under `collectAs`. The bound is declared per "
      + "loop and a collection larger than it fails the step; see LOOP_KINDS.",
  },
  foreach: {
    status: "ships",
    because:
      "A bounded loop that collects nothing. Separate from `map` because the names have to be true: a "
      + "`map` that discarded its results, or a `foreach` that silently accumulated them, would be a name "
      + "overclaiming what the node does.",
  },
  join: {
    status: "ships",
    because: "Waits for named branches. Structure only; no storage and no external effect.",
  },
  wait: {
    status: "ships",
    because:
      "A duration. #50 maps it to step.sleep / step.sleepUntil, which reaches 365 days and costs no "
      + "concurrency while waiting.",
  },
  stop: {
    status: "ships",
    because: "Ends the run with a reason. Terminal, and the only node with no successor.",
  },

  /* ---- data (§16: typed transforms, schema validation and lookups) ---- */
  transform: {
    status: "ships",
    because: "Binds an expression's value to a name in the run's state. No I/O.",
  },
  validate: {
    status: "ships",
    because:
      "Checks a value against an inline JSON Schema. No I/O, and it is the node §16's taint rules will "
      + "need when they land — validating untrusted content against trusted state (#52 owns that half).",
  },
  lookup: {
    status: "ships",
    because:
      "Reads one row of storage that exists, by id, from a closed set of entities. **Its cost is "
      + "unmeasured**: docs/receipts/butler-step-cost.md prices the four effect nodes and puts the seven "
      + "pure-control nodes at zero, and `lookup`, `map` and `foreach` appear in neither column. That "
      + "receipt's own stale_when names the case — a node in the shipped set with no measurement here — "
      + "and #54 is what closes it. Nothing in this package needs the number, because nothing here prices "
      + "anything.",
  },

  /* ---- effects over storage that exists ---- */
  "case.assign": {
    status: "ships",
    because: "`cases.assignee` exists and `src/cases.ts` already performs the compare-and-swap.",
  },
  "case.close": {
    status: "ships",
    because: "`cases.state` exists; the cheapest effect in the set at one conditional UPDATE.",
  },
  draft: {
    status: "ships",
    because:
      "`drafts` exists and a draft's body is authored text, so a Butler can compose a reply without a "
      + "template subsystem.",
  },
  "mail.send.propose": {
    status: "ships",
    because:
      "Seals a composition manifest (ADR 35). The one external effect in the set, and therefore the "
      + "layer's whole proof line: compile, publish, run, replay.",
  },

  /* ---- reserved: representable, refused, each naming what is missing ---- */
  "llm.classify": {
    status: "reserved",
    because: "There is no LLM control plane and no approved profile to bind to (§17).",
  },
  "llm.extract": {
    status: "reserved",
    because: "There is no LLM control plane and no approved profile to bind to (§17).",
  },
  "llm.summarize": {
    status: "reserved",
    because: "There is no LLM control plane and no approved profile to bind to (§17).",
  },
  "llm.draft": {
    status: "reserved",
    because: "There is no LLM control plane and no approved profile to bind to (§17).",
  },
  "llm.evaluate": {
    status: "reserved",
    because: "There is no LLM control plane and no approved profile to bind to (§17).",
  },
  label: {
    status: "reserved",
    because: "There is no label or tag concept anywhere in the schema.",
  },
  route: {
    status: "reserved",
    because:
      "Routing a message between mailboxes has no storage: `mailbox_items` is written by ingress from the "
      + "addresses a message arrived on, and moving one is not an operation.",
  },
  archive: {
    status: "reserved",
    because: "There is no archived state on a mailbox item or a case.",
  },
  quarantine: {
    status: "reserved",
    because:
      "§21 gives quarantine a five-way access split plus a rule that a Butler may quarantine an item and "
      + "never release its own. That is a subsystem, not a node.",
  },
  "case.upsert": {
    status: "reserved",
    because:
      "Typed case fields do not exist and are deliberately still fog: they interact with Layer 5's proof "
      + "line — editing an approval-bound field invalidates the approval — so settling them inside an AST "
      + "ticket would decide Layer 5's shape as a side effect. Use case.assign and case.close.",
  },
  "case.task": {
    status: "reserved",
    because: "There is no task concept on a case.",
  },
  "case.note": {
    status: "reserved",
    because: "There is no note concept on a case.",
  },
  "connector.call": {
    status: "reserved",
    because:
      "There is no connector catalogue, no capability handle and no egress policy (§16's signed "
      + "extensions, Layer 6). Also the one node that would make an external subrequest, which a Free "
      + "Node budgets at 50 for a whole run rather than 1,000 (docs/receipts/butler-step-budget.md).",
  },
  "approval.request": {
    status: "reserved",
    because:
      "Approvals exist (#61) but are requested by the policy plane at seal, not by a Butler. A node that "
      + "requested one directly would be a second way to create an approval, which is the correspondence "
      + "problem ADR 35 rejected for the effect key.",
  },
  "template.render": {
    status: "reserved",
    because:
      "There is no template subsystem: no templates table, and every occurrence of the word in the "
      + "Worker's source is incidental. §16's example renders a versioned template object and nothing of "
      + "that kind exists. A template subsystem needs a versioned immutable object, a substitution "
      + "language, and a decision about whether substitution is a taint sink — which it is, making it "
      + "#52's business rather than this ticket's.",
  },
} as const satisfies Record<string, NodeDeclaration>;

/** Every node type the AST can represent. A literal union, not `string` — see the note on NODE_KINDS. */
export type NodeKind = keyof typeof NODE_KINDS;

/** The kinds the checker admits. Adding one without teaching the checker is a compile error. */
export type ShippedKind = {
  [K in NodeKind]: (typeof NODE_KINDS)[K]["status"] extends "ships" ? K : never;
}[NodeKind];

/** The kinds the checker refuses, with `because` as the reason. */
export type ReservedKind = Exclude<NodeKind, ShippedKind>;

export const NODE_KIND_NAMES = Object.keys(NODE_KINDS) as NodeKind[];

export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === "string" && Object.hasOwn(NODE_KINDS, value);
}

export function isShipped(kind: NodeKind): kind is ShippedKind {
  return NODE_KINDS[kind].status === "ships";
}

export const SHIPPED_KINDS = NODE_KIND_NAMES.filter(isShipped);
export const RESERVED_KINDS = NODE_KIND_NAMES.filter((kind): kind is ReservedKind => !isShipped(kind));

/**
 * The loops, named once.
 *
 * Both declare `maxItems`, and **a bound that is exceeded fails the step and processes nothing.** It never
 * truncates. Truncation was rejected on the grounds that made merge a refusal: *"replied to 100 of 340
 * customers and reported success"* is not lost work, it is a system reporting something untrue about work
 * owed to customers, and a `run.truncated` flag only helps somebody who reads it while every downstream
 * count stays false about the world.
 *
 * **What this package does not decide: whether a given `maxItems` is affordable.** That is #54's, and its
 * arithmetic moved twice in one week — #68 found the subrequest budget is plan-scoped (10,000 Paid, 1,000
 * Free) and #62 found the recheck runs in a separate invocation. The checker here verifies the bound is
 * *present and well-formed*; the affordability pass sums the fixed cost of every non-loop node, adds
 * `maxItems × per-item cost` for each loop, and compares against a whole-run budget. No number from that
 * arithmetic appears in this package, deliberately.
 */
export const LOOP_KINDS = ["map", "foreach"] as const satisfies readonly ShippedKind[];
export type LoopKind = (typeof LOOP_KINDS)[number];

export function isLoopKind(kind: string): kind is LoopKind {
  return (LOOP_KINDS as readonly string[]).includes(kind);
}
