import { LOOKUP_ENTITIES, type ButlerNode } from "./ast.ts";
import { isShipped, type NodeKind, type ShippedKind } from "./nodes.ts";

/**
 * The capability ceiling: what a published Butler declares it may ever do (#51, §16, §7, blueprint:702).
 *
 * ## What a ceiling *is*, and why it is not the same thing as a grant
 *
 * §7's sentence is an intersection: *"effective authority is the intersection of the authenticated
 * principal, sponsoring grant, immutable Butler/version capability manifest, … live relationship"*. A tuple
 * **confers**; a ceiling only ever **removes**. So declaring `send.propose` here grants nothing at all — an
 * administrator still has to write a tuple naming the `btl_` — and *not* declaring it makes every later
 * tuple inert, which is the whole of the blueprint's promise that *"new grants do not silently expand a
 * published Butler"*.
 *
 * That promise is the reason the ceiling names a **resource** as well as an action. An action-only ceiling
 * would let an administrator grant the Butler `mailbox.content.read` on payroll next month and thereby widen
 * a program published in June without republishing it, which is the exact sentence blueprint:2769 forbids.
 *
 * ## Where it lives: **inside the AST**, which is what makes "frozen with the version" free
 *
 * §16 writes `capabilities:` as a top-level key of the Butler document, beside `metadata` and `trigger`, and
 * that is where it stays. A column on `butler_versions` was the obvious alternative and it is strictly worse
 * in three ways, each of which #49 already paid for once:
 *
 * - **It would need its own freeze.** `btv_frozen` guards `ast_json` and `source_text`; a fourth content
 *   column would be a fourth thing to remember in a trigger whose first draft was already found to have a
 *   two-statement bypass. Inside the AST the ceiling is frozen by the clause that was already there.
 * - **It would fall outside `ast_sha256`.** The digest is *"a fingerprint of the program"*, and a program's
 *   authority bound is part of what it is: two versions differing only in their ceiling would otherwise
 *   fingerprint identically and the no-op-publish refusal would refuse a real change.
 * - **It would be a second document the source text does not describe.** `butlers.ts` derives the AST from
 *   the source precisely so that *"storing the author's record beside a program it does not describe"* is
 *   unrepresentable. A ceiling arriving next to the source rather than inside it reopens that.
 *
 * ## What publication checks, said exactly, because a ceiling nothing checks is decoration
 *
 * Two refusals, and between them the ceiling's **action set is exactly the action set the graph needs**:
 *
 * | refusal | when |
 * |:--|:--|
 * | `E_BUTLER_CAPABILITY_NOT_DECLARED` | a node needs an action the ceiling does not declare |
 * | `E_BUTLER_CAPABILITY_UNUSED` | the ceiling declares an action no node needs |
 *
 * The second is the one worth arguing for. A ceiling padded *just in case* is a ceiling that does not bind,
 * and an author who declares `mailbox.content.read` for a Butler that reads nothing has written a
 * pre-authorisation for a node they have not added yet — which is precisely the shape republication exists
 * to make deliberate.
 *
 * **The action half is therefore derivable and the resource half is not, and that is why one is declared and
 * the other is checked.** Two places holding one fact is the correspondence problem this package keeps
 * refusing (`join`'s absent `of` list, ADR 35's effect key), and the answer here is not to drop the
 * declaration but to **prove the two agree at publication** — which is the remedy `join` could not have,
 * because nothing there could check. What the author supplies that nothing can derive is *which mailbox*.
 *
 * ## What publication cannot check, and what stands in for it
 *
 * A node's mailbox is an `Expr`, and this package deliberately does not parse expressions —
 * `"${event.mailbox_id}"` and `"mbx_01J…"` are both opaque non-empty strings here. So the resource half of
 * the ceiling is unverifiable at publication **by construction**, and it is enforced at runtime instead:
 * `apps/node/worker/src/butler/authority.ts` bounds every read and every effect to the mailboxes this
 * ceiling names, in the same statement that asks about tuples. Said here rather than left as an absence,
 * because the next reader will look for the resource check in this file.
 */

/**
 * The actions a ceiling may name.
 *
 * Exactly the relations a **shipped node can require**, and no others. `approval.decide`, `message.export`,
 * `ediscovery.export`, `supervised.read` and `org.admin` are real relations in `access.ts` that no node in
 * the shipped set ever checks, so a ceiling naming one would be a declaration nothing reads — the mirror of
 * the `mailbox.metadata.read` hole, where a relation was checked by nothing and therefore conferred nothing.
 *
 * Closed for `lookupEntity`'s reason: an open action string is a ceiling that publishes and bounds nothing.
 */
export const CAPABILITY_ACTIONS = [
  "mailbox.metadata.read",
  "mailbox.content.read",
  "send.propose",
] as const;

export type CapabilityAction = (typeof CAPABILITY_ACTIONS)[number];

/**
 * The one resource grain that exists.
 *
 * §16's example wrote `sender:enquiries@example.com`, and #51 settled that **the resource is the mailbox**:
 * `addresses` is unique on `(org_id, address)` and not on `mailbox_id`, `send_manifests` carries a
 * `mailbox_id`, and ADR 36 makes `From` the mailbox. The finer `sender:` grain moves `maySend`'s signature
 * and every call site and is deferred knowingly rather than diverged from silently. §16 and §29 are amended
 * in the same change as this file, per AGENTS.md's rule about divergence.
 *
 * The value after the prefix is an **address**, not a `mbx_` id. An author writes a document; they know
 * `enquiries@example.com` and they do not know the ULID it routes to — and `trigger.mailbox` is already an
 * address, so a ceiling in `mbx_` ids would make one document speak two languages about one mailbox.
 */
export const CAPABILITY_RESOURCE_PREFIX = "mailbox:";

/** One declared capability, as it appears in the AST. */
export interface Capability {
  readonly action: CapabilityAction;
  /** `mailbox:<address>`. See `CAPABILITY_RESOURCE_PREFIX`. */
  readonly resource: string;
}

/**
 * What one node needs: satisfied by **any one** of the actions named.
 *
 * A non-empty tuple rather than an array, so "a requirement nothing can satisfy" is not representable.
 */
export type Requirement = readonly [CapabilityAction, ...CapabilityAction[]];

/**
 * Metadata **or** content, which is the pair the queue's own reads accept and the pair
 * `src/butler/authority.ts` already folds into a `relation IN (…)`.
 *
 * Not relation implication: nothing here says content confers metadata. One requirement names both actions
 * it accepts, exactly as `mayReadMetadata` does.
 */
const READABLE = ["mailbox.metadata.read", "mailbox.content.read"] as const;
const SEND: Requirement = ["send.propose"];
const CONTENT: Requirement = ["mailbox.content.read"];

/**
 * What a `lookup` needs, per entity. A **total map** over `LOOKUP_ENTITIES` rather than a switch, for the
 * reason a switch got this wrong the first time it was written: a `switch` with no default returns
 * `undefined` for an entity outside the enum, and `undefined` requirements read as *"needs nothing"* — the
 * permissive answer for the one input that should get the restrictive one.
 *
 * The map cannot be missing a member (it does not compile), and the `??` below covers the case the map
 * cannot: a stored AST hand-edited to name an entity this build does not know. That falls to
 * `mailbox.content.read`, the strongest single requirement in the set, so an unclassified read demands the
 * strongest authority rather than none.
 */
const LOOKUP_NEEDS: {
  [K in (typeof LOOKUP_ENTITIES)[number]]: readonly Requirement[];
} = {
  /** A message's subject and sender *are* content. */
  message: [CONTENT],
  /** Queue metadata: content is the stronger authority on both sides, so either satisfies. */
  conversation: [READABLE],
  case: [READABLE],
  mailbox: [READABLE],
  /**
   * Nothing. `drafts.author_user_id` is the only reader a draft has (0012), and the Butler's read is bound
   * to its own authorship — so this is not a hole, it is a read that no mailbox relation governs.
   */
  draft: [],
};

/**
 * What each shipped node needs, **declared per node type rather than inherited from whatever the
 * implementing function happens to check** (#51).
 *
 * That distinction is the lesson from `mailbox.metadata.read`: a surface gated on `send.propose` returned
 * message metadata anyway, and every test passed because each granted what its own mechanism needed. A map
 * derived from *"whatever `saveDraft` asserts"* would have the same failure available to it the day
 * `saveDraft` grows a second read.
 *
 * Exhaustive over `ShippedKind` by construction — the same enforcement `cost.ts` uses for the cost table and
 * `graph.ts` for the successor map — so a node moving from reserved to shipped with no entry here does not
 * compile, and the compiler asks the one question that matters: *what authority does this node take?*
 *
 * Two entries carry an argument:
 *
 * - **`lookup` depends on its `entity`**, because the entities are different disclosures: a message's
 *   subject and sender *are* content, a case or a conversation is queue metadata, and a `draft` is bounded by
 *   authorship rather than by any mailbox relation (`drafts.author_user_id` is the only reader a draft has,
 *   0012) so it needs **no** capability at all. That last one is a hole only if a Butler could read somebody
 *   else's draft, and it cannot: the read is bound to `author_user_id = <this Butler>`.
 * - **`mail.send.propose` needs `send.propose` and not also `mailbox.content.read`.** #51 notes that since
 *   the reply-parent fix it also reads the parent's mailbox when the send is a reply — but *which* mailbox
 *   the parent is in is not knowable here (`inReplyTo` is an `Expr`) and is very often not the mailbox the
 *   send is from. That read is bounded by the Butler's own tuples inside `sealManifest`
 *   (`E_NO_SUCH_PARENT`), and it is **outside this ceiling**. Named rather than claimed: see
 *   `docs/butler-capability-ceiling.md`, "What the ceiling does not reach".
 */
const NEEDS: {
  [K in ShippedKind]: (node: Extract<ButlerNode, { type: K }>) => readonly Requirement[];
} = {
  /* ---- control flow: the run's own state, no storage, no authority ---- */
  guard: () => [],
  switch: () => [],
  map: () => [],
  foreach: () => [],
  join: () => [],
  wait: () => [],
  stop: () => [],

  /* ---- data ---- */
  transform: () => [],
  validate: () => [],
  lookup: (node) => LOOKUP_NEEDS[node.entity] ?? [CONTENT],

  /* ---- effects ---- */
  "case.assign": () => [SEND],
  "case.close": () => [SEND],
  draft: () => [SEND],
  "mail.send.propose": () => [SEND],
};

/** What one checked node needs. A reserved node needs nothing, because it is refused before it can run. */
export function requirementsOf(node: ButlerNode): readonly Requirement[] {
  const kind = node.type as NodeKind;
  if (!isShipped(kind)) return [];
  const needs = NEEDS[kind] as (n: ButlerNode) => readonly Requirement[];
  return needs(node);
}

/** Whether a string is one of the three declarable actions. */
export function isCapabilityAction(value: unknown): value is CapabilityAction {
  return typeof value === "string" && (CAPABILITY_ACTIONS as readonly string[]).includes(value);
}

/**
 * The address a resource names, or `null` when the grain is not `mailbox:`.
 *
 * `null` for `case_type:sales_lead` and `llm_profile:sales-intake@3` — §16's other two grains, which #51
 * records as *"still fog: both name objects that do not exist"*. Refusing them by name at publication is
 * better than admitting them and bounding nothing, which is the failure a blob invites and the reason
 * `lookupEntity` is an enum.
 */
export function mailboxAddressOf(resource: string): string | null {
  if (!resource.startsWith(CAPABILITY_RESOURCE_PREFIX)) return null;
  const address = resource.slice(CAPABILITY_RESOURCE_PREFIX.length).trim().toLowerCase();
  return address.length === 0 ? null : address;
}

/**
 * The ceiling as the runtime wants it: one address set per action, lowercased, deduplicated.
 *
 * An action absent from the map means **no mailbox at all**, which is the restrictive reading and the only
 * safe one — an empty ceiling denies rather than admits. `src/butler/authority.ts` short-circuits on it
 * without issuing a query, which is what lets a refusal say *"you never declared it"* rather than the
 * indistinguishable *"nothing was granted"*.
 */
export function ceilingByAction(
  capabilities: readonly Capability[],
): Map<CapabilityAction, string[]> {
  const byAction = new Map<CapabilityAction, string[]>();
  for (const capability of capabilities) {
    const address = mailboxAddressOf(capability.resource);
    // Unreachable after `checkButler`, which refuses an unknown grain. Skipped rather than defaulted,
    // because the restrictive reading of "a resource this Node cannot interpret" is that it names nothing.
    if (address === null) continue;
    const known = byAction.get(capability.action) ?? [];
    if (!known.includes(address)) known.push(address);
    byAction.set(capability.action, known);
  }
  return byAction;
}
