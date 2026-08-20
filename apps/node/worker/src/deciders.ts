/**
 * Who may decide an approval: the eligible-set query, on its own, with nothing else in the file.
 *
 * ## Why this is not in `src/approvals.ts`
 *
 * It was, and it has five callers — policy publication, the seal, a decision, a withdrawal, and a hold lift —
 * so its home was never really that module. What moved it is `doctor`: the `legal_hold_unliftable` finding asks
 * *"could anybody lift this hold?"*, which is this question and no other, and `doctor`'s cost meter counts
 * `prepare` rather than execution. `test/node/doctor-meter-honesty.test.ts` therefore pins a property over
 * every file `doctor.ts` imports — no `batch()`, and no prepared statement bound to a name — and `approvals.ts`
 * has both, in functions `runDoctor` never calls.
 *
 * The two dishonest ways out were: duplicate the SQL for `doctor` (a second definition of who may decide, which
 * is the copy migration 0021 refused to make of the whole approval mechanism), or widen the guard until it no
 * longer says anything (a guard that cries wolf gets deleted). Moving one leaf query into a leaf module makes
 * the guard's claim true rather than convenient: **this file writes nothing and prepares exactly one
 * statement**, which is the property the meter's figure rests on.
 *
 * `authz-read.ts` was the other candidate home. It answers *"what may this principal reach"*; this answers
 * *"who holds this relation on this object"*, which is the many-subjects direction and a different query with a
 * different cost — `approval-decision-cost.md` records that distinction rather than folding the two.
 */

/**
 * Every person holding `approval.decide` on a mailbox, resolved through teams and de-duplicated.
 *
 * One query for the whole organization, or for one mailbox when `mailboxId` is given — publication needs the
 * first (a policy with no mailbox condition applies to every mailbox) and a decision needs the second.
 *
 * ## Three things this SQL does deliberately
 *
 * **It resolves teams.** A tuple's subject may be a user or a team, because `readableSubjects` authorizes as
 * both. The second branch expands a team-held tuple into its members, which is what makes a team grant work at
 * all.
 *
 * **It de-duplicates on the person.** `UNION` (not `UNION ALL`) collapses `(mailbox, user)` pairs, so somebody
 * who holds the relation directly *and* through two teams is one decider. This is the property dual control
 * rests on — for a send and for a hold lift alike — and it is asserted in `test/approvals.test.ts` by
 * constructing exactly that person.
 *
 * **It requires a row in `users`.** `grant` does not verify that a subject is a person — it cannot, since the
 * same call grants to teams — so a tuple whose subject is a team id would otherwise be counted as one
 * "decider" *and* expanded into its members. Counting a subject nothing identifies as a person is how a stale
 * team id would satisfy dual control on its own.
 */
export async function decidersByMailbox(
  env: Env,
  orgId: string,
  mailboxId?: string,
): Promise<Map<string, Set<string>>> {
  const only = mailboxId === undefined ? "" : " AND t.object_id = ?";
  const params = mailboxId === undefined ? [orgId] : [orgId, mailboxId];
  const { results } = await env.CATALOG.prepare(
    `SELECT t.object_id AS mailbox_id, t.subject_id AS user_id
       FROM relationship_tuples t
       JOIN users u ON u.org_id = t.org_id AND u.id = t.subject_id
      WHERE t.org_id = ? AND t.object_type = 'mailbox' AND t.relation = 'approval.decide'${only}
     UNION
     SELECT t.object_id AS mailbox_id, m.user_id AS user_id
       FROM relationship_tuples t
       JOIN team_members m ON m.org_id = t.org_id AND m.team_id = t.subject_id
       JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id
      WHERE t.org_id = ? AND t.object_type = 'mailbox' AND t.relation = 'approval.decide'${only}`,
  ).bind(...params, ...params).all<{ mailbox_id: string; user_id: string }>();

  const byMailbox = new Map<string, Set<string>>();
  for (const row of results) {
    const people = byMailbox.get(row.mailbox_id) ?? new Set<string>();
    people.add(row.user_id);
    byMailbox.set(row.mailbox_id, people);
  }
  return byMailbox;
}

/**
 * The people who could decide on one mailbox, before the actor and the already-decided are taken out.
 *
 * The subtraction is `planApproval`'s and `decideApproval`'s, not this function's, for the reason those two
 * record: *"minus the person whose act this is"* is a rule about approvals, and a caller that had to remember
 * it is a caller that could forget.
 */
export async function decidersOf(env: Env, orgId: string, mailboxId: string): Promise<Set<string>> {
  return (await decidersByMailbox(env, orgId, mailboxId)).get(mailboxId) ?? new Set<string>();
}
