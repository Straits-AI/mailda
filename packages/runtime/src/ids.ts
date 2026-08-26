import { ULID_ALPHABET, ULID_BODY_CHARS } from "./ctx.ts";

/**
 * The one place an identifier prefix is spelled, for the entities whose ids are validated somewhere
 * other than where they are minted (#49, #6).
 *
 * ## The defect that earned this file
 *
 * `packages/contract/src/send-mail.ts` required `/^case_[0-9A-HJKMNP-TV-Z]{26}$/` while `src/cases.ts`
 * minted `ctx.id("cas")`. **A case id this Node mints could not pass its own contract's validation.** It
 * was latent only because `caseId` is optional on `mail.send` and nothing populates it yet; #49 recorded
 * the divergence and said the prefix is chosen once, in the contract and the runtime together. `case.assign`
 * and `case.close` are shipping Butler nodes that name case ids, which is where latent stops.
 *
 * **The runtime won and the contract moved**, for a reason that is about live data rather than taste: the
 * runtime prefix is on every `cases.id` in every installed Node, so changing it is a rename under live data
 * — a migration over a primary key, its two indexes and every `case_id` a client already holds. The
 * contract's spelling had never matched anything, because the field it guards is unpopulated. One side had
 * a cost and the other had none. So `cas` it is, and `packages/contract` reads it from here.
 *
 * ## What this registry does and does not cover, stated because a partial registry that reads as total is
 * the failure it exists to prevent
 *
 * `ctx.id()` mints **35** distinct prefixes today and this registry names five. That is deliberate, not a
 * backlog. A prefix spelled in exactly one place cannot diverge from anything — there is no second
 * spelling to disagree with. The divergence class only exists when a prefix is *validated* somewhere:
 * a contract schema, an AST, a route parameter. Those are the five, and the rule that keeps the set
 * complete is enforced rather than remembered: `test/node/id-prefix-world.test.ts` fails on any
 * hand-written prefixed-ULID pattern anywhere under `packages` or the Worker's `src`, so a sixth
 * validated prefix has to arrive through here.
 *
 * `ctx.id(prefix: string)` stays open on purpose. Narrowing it to this union would reject the thirty
 * unregistered prefixes and force every one of them into a registry that buys them nothing.
 *
 * ## A second divergence, found by the check rather than by reading
 *
 * The tripwire that enforces the rule above found one more the moment it existed:
 * `packages/contract`'s `senderIdentityId` required `snd_`, and `snd_` is the **send manifest** —
 * `0007_outbound.sql` says so on the column itself, *"snd_<ulid>; this IS the effect key"*. A sender
 * identity is a real product concept (§5, §18) with **no table**, so that field was validating one object's
 * id space against another's. Registering it as `senderIdentity` would have written the collision down as
 * though it were a decision; two objects sharing one prefix is precisely what typed prefixes exist to
 * prevent. So the entity registered here is `sendManifest`, which is what the runtime mints, and the
 * contract's field lost a constraint it was never entitled to. Recorded rather than quietly fixed, because
 * a reader who trusted that regex deserves to find out here.
 */
export const ID_PREFIXES = {
  mailbox: "mbx",
  /** The composition manifest, and the effect key (ADR 35). Not a sender identity — see the header. */
  sendManifest: "snd",
  /** #49's divergence, resolved here. See the header. */
  case: "cas",
  butler: "btl",
  butlerVersion: "btv",
  /**
   * The account. Minted by `claimNode` and `redeemInvitation` as `ctx.id("usr")` since the first layer, and
   * registered here in #85 — the first time anything needed to **validate** one.
   *
   * That is the rule this registry actually follows, said plainly because the count of entries invites the
   * wrong reading: it is not every prefix this Node mints. `ctx.id` takes a string, so `rt`, `fam`, `msg`,
   * `thr` and a dozen others are minted without appearing here. A prefix arrives when something has to
   * *check* it, because `id-prefix-world.test.ts` forbids writing the pattern by hand — which is exactly how
   * `case_` and `cas_` came to disagree, and why the door has to be the only one.
   */
  user: "usr",
  /**
   * The inbound receipt. Minted as `ctx.id("rcpt")` by `ingress.ts` since Layer 1, and registered in #91 —
   * the first time anything had to **check** one, which is the rule stated above.
   *
   * What needed it: a page cursor is an `accepted_at` instant and a receipt id, and the first version
   * validated the id half not at all and the instant half with `Date.parse` — which accepts `"2027"`. A
   * cursor is compared as a string against `accepted_at`, so a truncated one silently asks for a position it
   * was never given. Validating the shape means the id half comes from here rather than from a regex written
   * beside it, which is what `case_`/`cas_` taught this registry.
   */
  ingressReceipt: "rcpt",
} as const;

/**
 * Declared with `satisfies` rather than annotated `: Record<string, …>`.
 *
 * An annotation would widen `keyof` to `string`, and a type that looks like it constrains and does not is
 * worse than no type: every `IdEntity` would silently accept `"typo"`. Asserted in the world test, because
 * the difference is invisible at the call site.
 */
const _registryIsClosed = ID_PREFIXES satisfies Record<string, string>;
void _registryIsClosed;

export type IdEntity = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdEntity];

/**
 * The pattern one of these ids matches, **derived from the encoder** rather than written beside it.
 *
 * `[0-9A-HJKMNP-TV-Z]` is the hand-written spelling of Crockford base32 that appeared in the contract, and
 * it is correct — but it is a second copy of `ULID_ALPHABET`, which is the shape this whole file exists to
 * remove. Building the character class from the alphabet itself means a change to what `ctx.id` emits
 * changes what validates it, in one edit. Every character in that alphabet is literal inside a character
 * class (digits and capitals only), so no escaping is needed; `test/node/id-prefix-world.test.ts` mints a
 * real id per entity and matches it, which is what makes that sentence a check rather than a claim.
 */
export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_[${ULID_ALPHABET}]{${ULID_BODY_CHARS}}$`);
}

/** The pattern as source text, for schema emitters that want a string rather than a `RegExp`. */
export function idPatternSource(prefix: IdPrefix): string {
  return `^${prefix}_[${ULID_ALPHABET}]{${ULID_BODY_CHARS}}$`;
}
