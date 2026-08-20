import * as z from "zod";

import { ID_PREFIXES, idPattern } from "@mailda/runtime";

import { NODE_KIND_NAMES, NODE_KINDS, SHIPPED_KINDS, type NodeKind, type ShippedKind } from "./nodes.ts";

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
 * ## No shipped node has a recipient parameter (#52)
 *
 * §16 says untrusted content may not select or construct *"policy, sender identity, To/CC/BCC or forwarding
 * destination, attachment, integration/egress URL, connector operation/target record, financial/account
 * identifier, secret reference, model profile or permission"*. Ten of those eleven land on no parameter of
 * any shipped node — they belong to reserved nodes, or to storage and routes no node reaches. The eleventh
 * did: `draft` took `to: z.array(expr).min(1)`, an `Expr` reaches `event.*`, and `event.*` is the inbound
 * message. So a published Butler could send to an address the message it was replying to had chosen.
 *
 * That parameter is **gone**, and #52's reason for removing it rather than checking it is that a check has to
 * be right for ever while an absent parameter has nowhere for a value to arrive. The Node derives a Butler's
 * recipients from the delivery that triggered the run — `apps/node/worker/src/butler/parent.ts`. The cost is
 * stated where a reader meets it, on `draft` below: **a Butler cannot CC a colleague, add a supervisor, or
 * forward anything.**
 *
 * Two things keep it gone. **A shipped node's shape is strict** (see `shipped()`), so an author who writes
 * `to:`, `recipients:` or `escalateTo:` on any node is refused at publication by
 * `E_BUTLER_NODE_UNKNOWN_PARAMETER`, which names §16 — one refusal covering every spelling rather than a list
 * of forbidden words. And `shippedParameterSurface()` below exposes the whole parameter surface so
 * `test/sinks.test.ts` can pin it: the day somebody adds a recipient back to a node schema, that test fails
 * and names the rule.
 *
 * ## What is deliberately not in the schema, and where each guarantee actually lives
 *
 * | Guarantee | Where | Why not here |
 * |:--|:--|:--|
 * | acyclicity | `check.ts` | JSON Schema cannot express it. Pretending otherwise puts the guarantee where it does not hold. |
 * | reserved-node rejection | `check.ts` | A reserved node must **parse** and then be refused with a reason. |
 * | `maxItems` affordability | `cost.ts` | Its arithmetic depends on the whole graph's cost, not on one node's shape, so it cannot be a field constraint. No number from it appears here. |
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
 * An expression a node may leave out. One instance, so `optionalExpr` is a *registered field kind* rather
 * than a fresh anonymous wrapper — see `FIELD_KINDS`.
 */
export const optionalExpr = expr.optional();

/**
 * A successor edge. `null` and absent both mean "the run ends here", and they canonicalize identically —
 * the same rule #60's `canonicalConditions` applies to an unconstrained condition, for the same reason: a
 * publish that changed `undefined` to `null` changed nothing and must be refused.
 */
export const ref = nodeId.nullish();

/**
 * The bound on a loop: present, an integer, at least one.
 *
 * `1` needs no receipt — it means "one". There is deliberately **no upper bound here**, and #54 did not add
 * one: whether a given `maxItems` is affordable depends on the cost of the rest of the graph, so the same
 * bound is fine in one Butler and refused in another. A ceiling written in this field would be a single
 * number standing in for that arithmetic, which is how 500 — what a sending loop costs *alone* — would have
 * been written down when the real answer next to a five-node Butler is 498.
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
export const inlineJsonSchema = z.record(z.string(), z.unknown());

/**
 * The branches of a `switch`, named rather than written inline.
 *
 * Named for `FIELD_KINDS`' sake: an anonymous `z.array(z.object({…}))` inside a node's shape is a fresh
 * schema instance that no registry can recognise, which is exactly the shape `to: z.array(expr).min(1)` had.
 * Requiring every composite to be *named here* is what makes "every shipped parameter is built from a
 * registered field kind" a check rather than a hope.
 */
export const switchCases = z.array(z.object({ equals: z.string(), next: ref })).min(1);

/** How long a `wait` waits. `1` needs no receipt — it means "one second". */
export const waitSeconds = z.int().min(1);

/** Why a `stop` stopped. Free text an operator reads in the run record. */
export const stopReason = z.string().min(1);

/**
 * A shipped node: the envelope every node carries, plus its own fields. **Strict.**
 *
 * ## Why strict, which is the author-facing half of #52
 *
 * `z.object` *strips* a key it does not declare. So removing `to` from `draft` without this would have made
 * a Butler naming `to` publish successfully and silently drop the field — the recipient list gone, no
 * refusal, and an author convinced they had chosen who the mail goes to. Silently discarding the one thing
 * §16 says untrusted content must not select is a worse outcome than the parameter we removed.
 *
 * Strict makes it a refusal instead, and the refusal is **spelling-blind**: `to`, `cc`, `bcc`, `recipients`,
 * `escalateTo` and `notify` are all simply keys no shipped node declares, so all six are refused by one rule
 * that knows none of their names. A list of forbidden words would be a guard against whichever spellings its
 * author thought of, which is how the hole this closes was shipped in the first place.
 *
 * Reserved nodes stay `looseObject` — see below. They are a *record of what an author asked for* and must
 * carry their own fields into the refusal.
 *
 * **The shape may not declare `id` or `type`, and that is a compile error rather than a convention.** The
 * spread puts a node's own fields *after* the envelope's, so a shape declaring `id` silently replaces the
 * node's identifier with its own field. `lookup` did exactly that — `{ entity, id: expr, as, next }` — and
 * the result was a node with **four** fields instead of five, where one `id` had to serve both as the node's
 * name in the graph and as the expression naming the row to read. Two consequences, neither of which any
 * test could see: a `lookup` could not both be pointed at by an edge and say what to look up, and its
 * identifier escaped the `nodeId` pattern entirely, so `id: "${event.case_id}"` was an accepted node id.
 *
 * Found by #54, which needed a `lookup` fixture in order to price one. The field is `entityId` now, and the
 * `guard` parameter is why the next shape cannot repeat it.
 *
 * **Why a phantom rest parameter and not `S extends ZodRawShape & { id?: never }`.** That was tried first and
 * it compiles — while collapsing `ButlerNode` to `never`, because constraining `S` puts `id?: never` into the
 * inferred shape and the spread below then infers nothing useful. A type that silently destroys the
 * discriminated union to enforce a naming rule is a worse landmine than the rule it enforces. This form
 * leaves `S` untouched: with no forbidden key `guard` is `[]` and every call site is unchanged; with one, the
 * call fails to compile because it is missing an argument whose label names the offending key.
 */
type EnvelopeKeysIn<S> = Extract<keyof S, "id" | "type">;

function shipped<K extends NodeKind, S extends z.ZodRawShape>(
  kind: K,
  shape: S,
  ...guard: EnvelopeKeysIn<S> extends never
    ? []
    : [aNodeShapeMayNotDeclare: EnvelopeKeysIn<S>]
) {
  void guard;
  return z.strictObject({ id: nodeId, type: z.literal(kind), ...shape });
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
  switch: shipped("switch", { on: expr, cases: switchCases, default: ref }),
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
  wait: shipped("wait", { seconds: waitSeconds, next: ref }),
  stop: shipped("stop", { reason: stopReason }),

  /* ---- data ---- */
  transform: shipped("transform", { as: bindingName, value: expr, next: ref }),
  validate: shipped("validate", { value: expr, schema: inlineJsonSchema, next: ref }),
  /**
   * `entityId`, not `id` — see `shipped()`. The row to read is a different thing from the node reading it,
   * and one field cannot be both.
   */
  lookup: shipped("lookup", { entity: lookupEntity, entityId: expr, as: bindingName, next: ref }),

  /* ---- effects ---- */
  "case.assign": shipped("case.assign", { caseId: expr, assignee: expr, next: ref }),
  "case.close": shipped("case.close", { caseId: expr, next: ref }),
  /**
   * A reply, composed by the program and addressed by the Node.
   *
   * **There is no `to`, and no `cc` or `bcc` either (#52).** A Butler says what to write; it does not say
   * who receives it. The recipient is derived from the delivery that triggered the run — the envelope
   * sender of the message being replied to — by `apps/node/worker/src/butler/parent.ts`, and a delivery with
   * no return path is refused rather than defaulted. §16's sink sentence forbids untrusted content selecting
   * To/CC/BCC, and this parameter was the one place in the shipped node set where such content could land:
   * an `Expr` reads `event.*`, and `event.*` is the inbound message.
   *
   * **The cost, stated here because this is where a reader meets it:** a Butler cannot CC a colleague,
   * cannot add a supervisor, and cannot forward. Each of those needs a *trusted* recipient — an allowlist,
   * a contacts table, a suppression list — and no such store exists anywhere in the schema. They arrive with
   * that store, not with a parameter that would accept whatever an expression produced.
   *
   * `inReplyTo` **stays** an author's expression, and that is a decision rather than an oversight. Threading
   * is not one of §16's eleven sinks, and it is already bounded by authority: `sealManifest` refuses a parent
   * the author cannot read (`E_NO_SUCH_PARENT`), which is the check the reply-parent hole was closed with. So
   * a Butler may thread a reply onto any message in a mailbox it may read — exactly what a person may do —
   * while the *addressing* still comes from the trigger. Where the two disagree, the addressing wins, because
   * the trigger is the delivery this run is provably about.
   */
  draft: shipped("draft", {
    mailboxId: expr,
    subject: expr,
    body: expr,
    inReplyTo: optionalExpr,
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

/* ------------------------------------------------------- the parameter surface (#52) ---------------- */

/**
 * Every schema a shipped node's parameter may be built from, by **identity**.
 *
 * This is the developer-facing half of #52, and the reason it is identity rather than structure is the
 * defect it exists to catch. `to: z.array(expr).min(1)` and `cases: z.array(z.object({…})).min(1)` are the
 * same *kind* of construction; what distinguishes them is that one of them was thought about and named here
 * and the other was written inline at a call site. So a parameter counts as registered only when its schema
 * is one of these exact objects — a fresh `z.array(...)`, `z.string()` or `.optional()` anywhere in
 * `NODE_SCHEMAS` resolves to `null` and `test/sinks.test.ts` fails.
 *
 * There is deliberately **no field kind here that could carry an address, a URL, a secret reference or a
 * model profile.** That is the whole content of the rule: a future parameter that wanted one would have
 * nothing to be typed as, so adding it means adding an entry here, which is a diff in the one file whose
 * header states §16's sink sentence.
 *
 * `bindingName` is absent because it *is* `nodeId` — one schema, two readings — so a `map`'s `as` resolves
 * to `nodeId`. Recorded rather than papered over with a duplicate regex, which would be two spellings of one
 * rule and therefore the correspondence problem this package keeps refusing.
 */
const FIELD_KINDS = {
  nodeId,
  expr,
  optionalExpr,
  ref,
  maxItems,
  lookupEntity,
  inlineJsonSchema,
  switchCases,
  waitSeconds,
  stopReason,
} as const satisfies Record<string, z.ZodType>;

export type FieldKindName = keyof typeof FIELD_KINDS;

/** The registered field kinds, for anything that wants to assert the registry itself has not grown. */
export const FIELD_KIND_NAMES = Object.keys(FIELD_KINDS) as FieldKindName[];

/** One parameter of one shipped node. */
export interface ShippedParameter {
  readonly type: ShippedKind;
  readonly field: string;
  /** The registered field kind it is built from, or `null` when it is built from something unregistered. */
  readonly kind: FieldKindName | null;
}

/**
 * The complete parameter surface of the shipped node set, sorted, derived from the schemas themselves.
 *
 * `id` and `type` are excluded: they are the envelope every node carries, `shipped()` already refuses a node
 * that redeclares either, and including them would put two rows in front of a reviewer that can never be the
 * thing they are looking for.
 *
 * Sorted rather than left in declaration order so that reordering fields in this file does not fail the
 * tripwire — a tripwire a good change touches is a tripwire somebody mutes.
 */
export function shippedParameterSurface(): ShippedParameter[] {
  const surface = SHIPPED_KINDS.flatMap((type): ShippedParameter[] => {
    const { shape } = NODE_SCHEMAS[type] as unknown as { shape: Record<string, z.ZodType> };
    return Object.keys(shape)
      .filter((field) => field !== "id" && field !== "type")
      .map((field) => ({
        type,
        field,
        kind: FIELD_KIND_NAMES.find((name) => FIELD_KINDS[name] === shape[field]) ?? null,
      }));
  });
  return surface.sort((left, right) =>
    left.type === right.type
      ? left.field.localeCompare(right.field)
      : left.type.localeCompare(right.type));
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
