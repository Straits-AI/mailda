import { ID_PREFIXES, idPattern } from "@mailda/runtime";

/**
 * The **third term** of a delegated principal's authority, in one place (#109).
 *
 * `agents.ts` states the rule:
 *
 * ```
 * effective(agent) = pinned action ceiling ∩ live tuples of the agent ∩ live tuples of the sponsor
 * ```
 *
 * The ceiling is checked once, at `principalFor`. The agent's own tuples are what every authorization query in
 * this Node already reads. This file is the third term, and it exists because the third term was **stated and
 * not enforced**: the sponsor appeared in the audit trail and constrained nothing, so an agent kept reading a
 * mailbox after its sponsor's relation was revoked, after the sponsor left the team that granted it, and where
 * the sponsor had never held it at all.
 *
 * ## Derived from the identifier, not threaded through the call
 *
 * The first fix read `who.delegatorUserId`, the field `principalFor` sets. That works exactly as far as a
 * `Principal` travels — and it does not travel far enough:
 *
 * - `isAdmin` takes a bare identifier, and thirty call sites pass `who.userId` into it.
 * - `mailboxQueues` takes `(orgId, userId)`.
 * - `outbound/manifest.ts` re-checks the author's authority at seal time from `composition.authorUserId`,
 *   which is a column. There is no `Principal` within reach, and there was never going to be one.
 *
 * A threaded field cannot reach those, and widening six signatures is six chances to pass the wrong thing plus
 * every future caller's chance to pass nothing. So the sponsor is **derived from the subject**, the way
 * `kindOfActor` derives an actor's kind from its prefix — the decision this repository already credits with
 * making attribution structural rather than something each call site remembers.
 *
 * `principalFor` still sets `delegatorUserId`, because the audit trail needs the sponsor **recorded** rather
 * than re-derived at read time: a derived trail's answers move when somebody reassigns an agent, and an audit
 * trail whose answers move is what the hash chain exists to prevent. So these are two mechanisms that must
 * agree, and `test/agents.test.ts` asserts they do rather than leaving it to inspection.
 *
 * ## The cost, for the caller who does not delegate
 *
 * One regular-expression test. A `usr_…` subject returns before any statement is prepared, so the human path
 * — which is nearly every request — reaches the p95 budget in `docs/receipts/authz-check-rows-read.md`
 * unchanged.
 */

/** The narrow surface these helpers need. Keeps this file out of `Env`'s import graph. */
type CatalogOnly = { CATALOG: D1Database };

/**
 * The third term, resolved: SQL to append to a predicate over `relationship_tuples`, and its parameters.
 *
 * Both halves from one call, which is the idiom `authorizedBy` and `liveGrantsBySubject` already use here. A
 * function returning only the SQL leaves the caller to remember the binds, and a forgotten bind in this
 * codebase is not an error — `messagePageQuery` records what one looks like from outside: zero rows for every
 * input, and nothing raised.
 */
export type SponsorTerm = { readonly sql: string; readonly params: readonly string[] };

/** No term: the subject is a human and holds what it holds. The empty string is the identity for `AND`. */
const NO_TERM: SponsorTerm = { sql: "", params: [] };

/**
 * A term nothing satisfies, for an `agt_` subject with no row in `agents`.
 *
 * **Fail closed, and explicitly.** `NO_TERM` here would read as *"no sponsor term applies"* — the human
 * answer, given on the one input where the wrong answer is a machine acting unsupervised. An earlier draft
 * expressed this as a subject id of `""` in the `IN` list, reasoning that no tuple would match it; that is a
 * claim about the data rather than about the predicate, and one empty `subject_id` row anywhere would have
 * quietly turned it back into a licence.
 */
const REFUSE: SponsorTerm = { sql: "\n        AND 1 = 0", params: [] };

/**
 * The human accountable for this subject: `null` when the subject **is** a human, `undefined` when it is an
 * agent whose sponsor cannot be established.
 *
 * Three outcomes rather than two, because they need three different answers and a boolean would have merged
 * the two that matter. A revoked or expired agent is not one of them — `agentFor` refuses the token, so no
 * principal exists to ask. That is why this reads `sponsor_user_id` without re-checking liveness: `agents.ts`
 * owns liveness, and checking it in two places is how two answers drift.
 */
export async function sponsorOf(
  env: CatalogOnly,
  orgId: string,
  subjectId: string,
): Promise<string | null | undefined> {
  if (!idPattern(ID_PREFIXES.agent).test(subjectId)) return null;
  const row = await env.CATALOG.prepare(
    "SELECT sponsor_user_id FROM agents WHERE id = ? AND org_id = ?",
  )
    .bind(subjectId, orgId)
    .first<{ sponsor_user_id: string }>();
  return row?.sponsor_user_id;
}

/**
 * The third term for this subject, over tuples aliased as `alias`.
 *
 * For an agent, the subjects are the sponsor and every team they belong to. The **team arm is here and not in
 * `sponsorOf`**, because `org.admin` needs the sponsor alone — a team subject holding `org.admin` is not a
 * shape `access.ts` produces — while a mailbox relation is routinely conferred on a team.
 * `butler/authority.ts` records the same asymmetry for a Butler and reaches it from the other side:
 * `team_members.user_id` holds users, so a `btl_` subject returns nothing there by construction.
 */
export async function sponsorTerm(
  env: CatalogOnly,
  orgId: string,
  subjectId: string,
  alias: string,
): Promise<SponsorTerm> {
  const sponsor = await sponsorOf(env, orgId, subjectId);
  if (sponsor === null) return NO_TERM;
  if (sponsor === undefined) return REFUSE;
  const teams = await env.CATALOG.prepare(
    "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
  )
    .bind(orgId, sponsor)
    .all<{ team_id: string }>();
  const subjects = [sponsor, ...teams.results.map((row) => row.team_id)];
  return { sql: sponsorClause(alias, subjects), params: subjects };
}

/**
 * The term as SQL: a **correlated `EXISTS` on the same relation and the same object**, appended to a predicate
 * over `relationship_tuples` aliased as `alias`.
 *
 * One function rather than the clause written out at each site, and the reason is that a first draft *did*
 * write it out — twice — with a comment beside the second copy claiming a tripwire guarded the two against
 * drifting apart. There was no such tripwire. Inventing a guard for duplication is the signal that the
 * duplication is the defect; sites reading one string cannot disagree, so nothing needs guarding.
 *
 * Every part of the shape is load-bearing, and each of the three was a live hole found by mutating it:
 *
 * - **`AND EXISTS`, not another entry in `subject_id IN (…)`.** That list is a disjunction, so the sponsor's
 *   own row satisfies it alone and the agent holds whatever the sponsor holds — the opposite of the rule.
 *   `butler/authority.ts` reached the same conclusion by a different route for the same three-term
 *   intersection, converting the OR into an AND with `DISTINCT subject_id`.
 * - **`s.relation = <alias>.relation`, not `s.relation IN (…)`.** A caller passing
 *   `[metadata.read, content.read]` means either satisfies *it*; it does not mean an agent holding
 *   `content.read` may ride on a sponsor holding only `metadata.read`. The looser form permits exactly that,
 *   and the agent reads bytes its sponsor cannot. The cost is a conservative refusal in the mirror case —
 *   accepted, because the alternative is the relation-implication graph `access.ts` deliberately refused, and
 *   refusing something safe is the direction to be wrong in.
 * - **`s.object_id = <alias>.object_id`.** Without it, a sponsor holding a relation on any one mailbox
 *   satisfies the check for *every* mailbox the agent has a tuple on — so a sponsor with a single mailbox of
 *   their own licenses an agent across the whole organization. Every assertion written before this term
 *   existed still passed without it, because they all used a single mailbox.
 *
 * Exported for the tests that mutate it, and for `test/node/delegated-authority-world.test.ts`, which requires
 * every tuple predicate evaluating a principal's own authority to carry a term from here.
 */
export function sponsorClause(alias: string, sponsorSubjects: readonly string[]): string {
  if (sponsorSubjects.length === 0) return "";
  return `
        AND EXISTS (SELECT 1 FROM relationship_tuples s
                     WHERE s.org_id = ${alias}.org_id
                       AND s.subject_id IN (${sponsorSubjects.map(() => "?").join(", ")})
                       AND s.object_type = ${alias}.object_type
                       AND s.relation = ${alias}.relation
                       AND s.object_id = ${alias}.object_id)`;
}
