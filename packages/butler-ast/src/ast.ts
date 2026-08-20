import * as z from "zod";

import { ID_PREFIXES, idPattern } from "@mailda/runtime";

import { NODE_KIND_NAMES, NODE_KINDS, type NodeKind } from "./nodes.ts";

/**
 * The AST schema: Zod 4 in a package, emitting JSON Schema draft-2020-12 (#49, ADR 3).
 *
 * ## Why Zod and not a second schema technology
 *
 * ADR 3 settled this for the command catalogue and `packages/contract` already proves the toolchain — Zod
 * 4.1.13 with ajv and ajv-formats, and an equivalence test that pins the one place the two disagree. A
 * second schema technology would be a second thing to keep in step. The constraint inherited from #3 comes
 * with it: **no `z.date()`**, because it is unrepresentable in JSON Schema, so any timestamp is an ISO
 * string with a `format`.
 *
 * ## What is deliberately not in the schema, and where each guarantee actually lives
 *
 * | Guarantee | Where | Why not here |
 * |:--|:--|:--|
 * | acyclicity | `check.ts` | JSON Schema cannot express it. Pretending otherwise puts the guarantee where it does not hold. |
 * | reserved-node rejection | `check.ts` | A reserved node must **parse** and then be refused with a reason. |
 * | `maxItems` affordability | #54 | Its arithmetic depends on the whole graph's cost and on a plan-scoped budget. No number from it appears here. |
 * | the expression language | #52 / #50 | An `Expr` is an opaque non-empty string. This package does not parse `${event.message_id}`, and inventing a grammar to look thorough would be inventing a language nothing executes. |
 * | stored size | `apps/node/worker/src/butlers.ts` | A row limit is a storage fact, not an AST fact. |
 *
 * ## No `.max()` anywhere, on purpose
 *
 * A `maxLength` or a node-count ceiling would be a number, and AGENTS.md's rule is that you cannot write
 * the number, only the receipt. There is no measurement behind "a Butler may have 500 nodes", so the one
 * real bound is the one that already has a receipt: `d1.max_row_bytes`, enforced where the row is written.
 * Stated here so the next reader does not read the absence as an oversight.
 */

/**
 * A node's name inside its Butler. Lowercase snake, matching §16's own example (`security_guard`).
 *
 * No length cap — see the header. `min(1)` is implied by the leading-letter requirement in the pattern.
 */
export const nodeId = z.string().regex(/^[a-z][a-z0-9_]*$/, "a node id is lowercase letters, digits and underscores, starting with a letter");

/** A name a node binds into the run's state, read back by a later node's expression. */
export const bindingName = nodeId;

/**
 * An expression, **unparsed**.
 *
 * §16's DSL writes `"${steps.extract.output.name}"`. This package treats that as an opaque non-empty
 * string and says so rather than half-implementing a grammar: the taint checker (#52) is what has to
 * understand the inside of one, and the engine (#50) is what has to evaluate it. A grammar invented here
 * would be a third opinion about the same syntax, and the first two do not exist yet.
 */
export const expr = z.string().min(1, "an expression cannot be empty");

/**
 * A successor edge. `null` and absent both mean "the run ends here", and they canonicalize identically —
 * the same rule #60's `canonicalConditions` applies to an unconstrained condition, for the same reason: a
 * publish that changed `undefined` to `null` changed nothing and must be refused.
 */
export const ref = nodeId.nullish();

/**
 * The bound on a loop: present, an integer, at least one.
 *
 * `1` needs no receipt — it means "one". There is deliberately **no upper bound**: whether a given
 * `maxItems` is affordable is #54's question, it depends on the cost of the rest of the graph, and the
 * budget it divides is plan-scoped. A ceiling written here would be a number with no measurement behind
 * it, in the permissive-looking direction that gets raised by whoever hits it.
 */
export const maxItems = z.int().min(1, "a loop's maxItems must be at least 1");

/**
 * What a `lookup` may read: entities with a table, drawn by looking at the schema.
 *
 * Closed rather than a string, for `mailbox-policy`'s reason — an open entity name is a lookup that
 * publishes and returns nothing at runtime.
 */
export const LOOKUP_ENTITIES = ["message", "conversation", "case", "mailbox", "draft"] as const;
export const lookupEntity = z.enum(LOOKUP_ENTITIES);

/** A JSON Schema, carried inline by `validate`. Not interpreted here; the engine hands it to a validator. */
const inlineJsonSchema = z.record(z.string(), z.unknown());

function shipped<K extends NodeKind, S extends z.ZodRawShape>(kind: K, shape: S) {
  return z.object({ id: nodeId, type: z.literal(kind), ...shape });
}

/**
 * A reserved node: the envelope, and every other field carried through untouched.
 *
 * `looseObject` rather than `object` so a reserved node is genuinely *representable* — an author's
 * `profile: "sales-intake@3"` survives parsing and is there in the refusal's context, rather than being
 * silently stripped by the schema that was supposed to be recording it.
 */
function reserved<K extends NodeKind>(kind: K) {
  return z.looseObject({ id: nodeId, type: z.literal(kind) });
}

/**
 * One schema per declared kind, exhaustive over `NodeKind`.
 *
 * The mapped type is what makes "adding a node without teaching the checker is a compile error" true of
 * the schema half: a new key in `NODE_KINDS` with no entry here does not compile.
 */
const NODE_SCHEMAS = {
  /* ---- control flow ---- */
  guard: shipped("guard", { when: expr, then: ref, otherwise: ref }),
  switch: shipped("switch", {
    on: expr,
    cases: z.array(z.object({ equals: z.string(), next: ref })).min(1),
    default: ref,
  }),
  map: shipped("map", { over: expr, as: bindingName, maxItems, body: nodeId, collectAs: bindingName, next: ref }),
  foreach: shipped("foreach", { over: expr, as: bindingName, maxItems, body: nodeId, next: ref }),
  /**
   * A named convergence point.
   *
   * No `of` list, deliberately. Which branches converge here is already written in the graph — it is every
   * node whose edge points at this one — and a second declaration of the same fact is the correspondence
   * problem ADR 35 rejected for the effect key: two places that must agree, where the one nobody updates
   * becomes a field that lies. So `join` carries only its own successor, and the name is justified by where
   * the edges land rather than by a list beside them.
   *
   * It is a **merge, not a barrier.** No fan-out node ships — `parallel_bounded` is fog on #50 — so at most
   * one branch is ever live, and claiming this waits for several would be a name overclaiming what runs.
   */
  join: shipped("join", { next: ref }),
  wait: shipped("wait", { seconds: z.int().min(1), next: ref }),
  stop: shipped("stop", { reason: z.string().min(1) }),

  /* ---- data ---- */
  transform: shipped("transform", { as: bindingName, value: expr, next: ref }),
  validate: shipped("validate", { value: expr, schema: inlineJsonSchema, next: ref }),
  lookup: shipped("lookup", { entity: lookupEntity, id: expr, as: bindingName, next: ref }),

  /* ---- effects ---- */
  "case.assign": shipped("case.assign", { caseId: expr, assignee: expr, next: ref }),
  "case.close": shipped("case.close", { caseId: expr, next: ref }),
  draft: shipped("draft", {
    mailboxId: expr,
    to: z.array(expr).min(1),
    subject: expr,
    body: expr,
    inReplyTo: expr.optional(),
    as: bindingName,
    next: ref,
  }),
  "mail.send.propose": shipped("mail.send.propose", { draft: expr, next: ref }),

  /* ---- reserved: representable, refused by the checker ---- */
  "llm.classify": reserved("llm.classify"),
  "llm.extract": reserved("llm.extract"),
  "llm.summarize": reserved("llm.summarize"),
  "llm.draft": reserved("llm.draft"),
  "llm.evaluate": reserved("llm.evaluate"),
  label: reserved("label"),
  route: reserved("route"),
  archive: reserved("archive"),
  quarantine: reserved("quarantine"),
  "case.upsert": reserved("case.upsert"),
  "case.task": reserved("case.task"),
  "case.note": reserved("case.note"),
  "connector.call": reserved("connector.call"),
  "approval.request": reserved("approval.request"),
  "template.render": reserved("template.render"),
} satisfies { [K in NodeKind]: z.ZodType };

/**
 * The generated discriminated union.
 *
 * Built from `NODE_SCHEMAS` rather than from a second hand-written list, which is the whole point of
 * `nodes.ts`: the union's membership and the checker's classification read the same object, so they cannot
 * disagree about what `llm.classify` is.
 *
 * `Object.values` rather than a hand-written array of the same fourteen-plus-fifteen members, and rather
 * than `NODE_KIND_NAMES.map(...)` — mapping over the names loses the per-key types and collapses the
 * inferred union to `unknown`, which would make `ButlerNode` a type that constrains nothing. Iterating the
 * values keeps them.
 *
 * The one cast is from array to non-empty tuple, which is what `z.discriminatedUnion` asks for. It changes
 * no element type — `Member` is the union of the map's own values — so the inferred `ButlerNode` is still
 * the real discriminated union rather than `unknown`, and a member missing from the map would be a missing
 * key rather than a silently narrower union.
 */
type Member = (typeof NODE_SCHEMAS)[NodeKind];
export const butlerNode = z.discriminatedUnion(
  "type",
  Object.values(NODE_SCHEMAS) as [Member, ...Member[]],
);

export type ButlerNode = z.infer<typeof butlerNode>;

/**
 * The only trigger that exists.
 *
 * §16 lists nine trigger families. One is representable: a message arrived, which is what `ingress.ts`
 * already produces. The rest are fog — #50 left "the trigger catalog beyond `mail.received`" open by name
 * — and a trigger enum admitting `mail.bounced` today would be a Butler that publishes and never fires,
 * which is the same failure `policy.ts` refuses for a condition backed by no data.
 */
export const butlerTrigger = z.object({
  event: z.literal("mail.received"),
  /** The mailbox address the trigger listens on. */
  mailbox: z.string().min(1),
});

export const butlerMetadata = z.object({
  name: z.string().min(1),
  /**
   * Who owns the Butler, as an opaque string.
   *
   * §16's ownership table has six kinds (personal, mailbox, team, organization, agent, system) and three
   * of them name objects that do not exist — there is no `teams` table, no agent delegation and no service
   * identity. So this is not an enum yet, and calling it one would make five of six values publishable and
   * inert. `apps/node/worker/src/butlers.ts` gates authorship on `org.admin` and records the string.
   */
  owner: z.string().min(1),
});

/**
 * A Butler, as the AST.
 *
 * `apiVersion` and `kind` are §16's own envelope, kept verbatim so the text a person writes and the object
 * a machine reads are the same document.
 */
export const butler = z.object({
  apiVersion: z.literal("mailda/v1"),
  kind: z.literal("Butler"),
  metadata: butlerMetadata,
  trigger: butlerTrigger,
  /** Where the run starts. Must name one of `nodes`; `check.ts` enforces that. */
  entry: nodeId,
  nodes: z.array(butlerNode).min(1),
});

export type Butler = z.infer<typeof butler>;

/**
 * The envelope, with nodes left as raw objects.
 *
 * Parsed first so the checker can classify a node's `type` *before* anything tries to validate its
 * payload. Without this stage a reserved node's diagnostic would be Zod's `invalid_union_discriminator`,
 * which names the seventy-nine alternatives it is not and none of the reasons anybody cares about.
 */
export const butlerEnvelope = z.object({
  apiVersion: z.literal("mailda/v1"),
  kind: z.literal("Butler"),
  metadata: butlerMetadata,
  trigger: butlerTrigger,
  entry: nodeId,
  nodes: z.array(z.looseObject({ id: nodeId, type: z.string().min(1) })).min(1),
});

export type ButlerEnvelope = z.infer<typeof butlerEnvelope>;

/** The payload schema for one declared kind. Exported for the checker; not a second source of truth. */
export function schemaFor(kind: NodeKind): z.ZodType {
  return NODE_SCHEMAS[kind];
}

/**
 * The emitted contract. OpenAPI 3.1 uses JSON Schema draft-2020-12, so there is no lossy conversion (#3).
 *
 * `io: "input"` for `packages/contract`'s reason: what a client sends is what needs describing.
 */
export const butlerJsonSchema = z.toJSONSchema(butler, { target: "draft-2020-12", io: "input" });

/**
 * The id patterns a Butler's own identifiers match, taken from the registry rather than written here.
 *
 * `btl_` and `btv_` are typed-prefix ULIDs per #6 — which is what let `subject_type` be dropped from the
 * authz index, so a Butler runtime identity being a tuple subject works with no schema change.
 */
export const butlerId = z.string().regex(idPattern(ID_PREFIXES.butler));
export const butlerVersionId = z.string().regex(idPattern(ID_PREFIXES.butlerVersion));

/** Every declared kind and its status, for anything that wants to render the catalogue. */
export const NODE_CATALOGUE = NODE_KIND_NAMES.map((kind) => ({
  type: kind,
  status: NODE_KINDS[kind].status,
  because: NODE_KINDS[kind].because,
}));
