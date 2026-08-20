import { ceilingByAction, isCapabilityAction, type Butler, type CapabilityAction } from "@mailda/butler-ast";

import type { MailboxRelation } from "../access.ts";

/**
 * The pinned ceiling and its sponsor, as one run reads them (#51, §7, blueprint:702).
 *
 * ## The intersection this file supplies two of the three terms for
 *
 *     effective(step) = pinned ceiling ∩ live tuples of the Butler ∩ live tuples of the sponsor
 *
 * The **ceiling** is the frozen `capabilities:` of the version being run, which `interpret` already has in
 * hand because it loaded the AST to walk it — so that term costs **no query at all**. The **sponsor** is one
 * id off the same row. `authority.ts` does the two tuple terms; this file is what those terms are bounded by.
 *
 * ## Who the sponsor is: `butler_versions.published_by`, and how that was established
 *
 * The blueprint uses two words for two things and this Node has to name both. §7's own sentence is
 * *"the intersection of the authenticated principal, **sponsoring grant**, immutable Butler/version
 * capability manifest, … live relationship"* (blueprint:702), so principal and sponsor are separate terms of
 * one product. §16's delegation flow says what a sponsor does: *"Sponsor selects mailbox, readable data,
 * actions, senders, recipient constraints, budget, expiry and approval requirements"* (blueprint:485) — the
 * sponsor is **whoever declares the bound**. In this Node the bound is `capabilities:` in the source text,
 * and the act that makes it live is publication, which `butlers.ts` gates on `org.admin`. So the sponsor is
 * the publisher, and `published_by` is the column that already records them.
 *
 * ### This does not undo #50's decision, and the reason is one sentence
 *
 * #50 decided a Butler's **principal** is the Butler and explicitly rejected the publisher, on four counts.
 * All four are about *identity*; none is about *capping*, and an intersection is monotone downward — adding
 * the sponsor term can only ever remove authority, never add it. Taken one at a time:
 *
 * 1. *"It grants everything that person can do, for ever."* As a cap it grants **nothing**: the Butler still
 *    needs its own tuple, and a mailbox the publisher can reach and the Butler cannot stays unreachable.
 *    What the term does is the converse — a mailbox the *Butler* was granted and the publisher cannot reach
 *    becomes unreachable, which is the direction §7 wants.
 * 2. *"It puts a person's name on mail they never composed."* The actor is still the `btl_`.
 *    `published_by` appears in no audit entry's `actor_user_id` and in no `From` header.
 * 3. *"It excludes a real human from a gate they never asked for."* `approversOf` excludes the **actor**,
 *    which is still the Butler, so the publisher remains eligible to approve and to release. Named because
 *    it is the one place a reader might expect this term to bite and it does not: capping somebody's
 *    authority is not the same act as making them the requester.
 * 4. *"A policy could not tell a Butler's send from that person's own."* Unchanged — #60's `actor` condition
 *    still compares the `btl_`.
 *
 * So capping is safe exactly where identifying was not: identity is a claim about who did something, and a
 * ceiling is a claim about what cannot be done. One can only be true or false; the other can only subtract.
 *
 * ### What happens when the sponsor's authority is revoked, or the sponsor leaves
 *
 * **Revocation stops the Butler on the next node**, because nothing about the sponsor term is cached: it is
 * two live queries per check, exactly like every human check in this Node (§7, §28). The stop is *visible*
 * rather than silent — the effect row records `sponsor_lacks_it` and `interpret` writes the sentence naming
 * the sponsor into the operational log, which is where `doctor` reads. That is deliberate: a ceiling that
 * quietly empties and a Butler that quietly does nothing look identical from the outside, and #51 settled
 * that the three reasons must stay distinguishable *because they have three different remedies*.
 *
 * **Departure is revocation, and that is a statement about this Node rather than about people.** There is no
 * deactivation flag and no `DELETE FROM users` anywhere in this Worker — checked, not assumed — so the only
 * way somebody stops holding authority is that an administrator revokes it, and this term follows on the
 * next node. If a `users` row is removed by some future lifecycle path, the sponsor's tuples go with the
 * person or they do not: if they go, the Butler stops; if they stay, the Butler keeps running on a departed
 * person's authority, which is the failure this term exists to prevent and which **this term alone does not
 * close**. It is named in `docs/butler-capability-ceiling.md` under "What the ceiling does not reach", where
 * it belongs — as an argument for the user-lifecycle work rather than as a claim made here.
 */

/** The ceiling of one published version, resolved once per run from the frozen AST. */
export interface ButlerCeiling {
  /**
   * The version's publisher — `butler_versions.published_by`, frozen by `btv_frozen` since 0031.
   *
   * A `usr_` id. Whether they still hold anything is asked live, per check; nothing here is a claim that
   * they do.
   */
  readonly sponsorUserId: string;
  /**
   * The mailbox **addresses** this ceiling names, per action. Lowercased.
   *
   * Addresses rather than `mbx_` ids, and the reason is a subrequest: the ids are not knowable when the AST
   * is read, because the AST is what names the addresses. Resolving them would be a query that has to happen
   * *after* the load, so it could not ride in the load's `batch()` and would raise
   * `butler.run_cost_engine_fixed` from 3 to 4 for every run. Instead the resolution is a sub-select inside
   * the statement each check was already issuing (`authority.ts`), where it costs nothing — `addresses` is
   * UNIQUE on `(org_id, address)`, so it is one index seek per declared address.
   *
   * An action **absent** from this map names no mailbox at all. That is the restrictive reading and the only
   * safe one, and it is also what lets a refusal be specific: `authority.ts` short-circuits on it with
   * `capability_not_declared` and issues no query.
   */
  readonly byAction: ReadonlyMap<CapabilityAction, readonly string[]>;
}

/** The ceiling of a checked AST, bound to the person who published it. */
export function ceilingOf(ast: Butler, sponsorUserId: string): ButlerCeiling {
  return { sponsorUserId, byAction: ceilingByAction(ast.capabilities) };
}

/**
 * The addresses this ceiling admits for a check that accepts any one of `relations`.
 *
 * A **union** over the relations, and the imprecision that hides is worth naming because it is bounded. A
 * check naming two relations names `mailbox.metadata.read` and `mailbox.content.read` — the queue's own pair
 * — and the union admits a mailbox declared under either. So a ceiling declaring only `metadata.read` on a
 * mailbox where the Butler happens to hold `content.read` passes a two-relation check. That is correct
 * rather than tolerated: every read that names the pair returns metadata-grade columns, both actions
 * authorize metadata, and holding the stronger one is not a widening of what the read discloses. The
 * one-relation checks — `mailbox.content.read` for a message, `send.propose` for every effect — are exact,
 * and they are the checks that guard content and the wire.
 *
 * Relations outside the three declarable actions contribute nothing, which is not a gap: no shipped node
 * checks one, and `capability.ts` refuses a ceiling that names one.
 */
export function ceilingAddresses(
  ceiling: ButlerCeiling,
  relations: readonly MailboxRelation[],
): string[] {
  const addresses: string[] = [];
  for (const relation of relations) {
    if (!isCapabilityAction(relation)) continue;
    for (const address of ceiling.byAction.get(relation) ?? []) {
      if (!addresses.includes(address)) addresses.push(address);
    }
  }
  return addresses;
}
