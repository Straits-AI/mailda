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
 * longer says anything (a guard that cries wolf gets deleted). Moving the leaf queries into a leaf module makes
 * the guard's claim true rather than convenient: **this file writes nothing, and every statement it prepares
 * it executes exactly once**, which is the property the meter's figure rests on.
 *
 * `authz-read.ts` was the other candidate home. It answers *"what may this principal reach"*; this answers
 * *"who holds this relation on this object"*, which is the many-subjects direction and a different query with a
 * different cost — `approval-decision-cost.md` records that distinction rather than folding the two.
 *
 * ## What the guard actually requires, now that this file holds three questions
 *
 * This file used to say it *"writes nothing and prepares exactly one statement"*. #66 added `adminsOf` and
 * that sentence stopped being true, so it is corrected rather than left standing: the property
 * `test/node/doctor-meter-honesty.test.ts` enforces is **no `batch()`, and every `prepare` chained straight
 * into one execution**, which is what keeps prepare-count equal to execution-count on `doctor`'s path. Every
 * function below satisfies it and none of them writes anything. A count of statements was never the property;
 * it was a convenient way of stating it, and a convenient statement that stops being true is the defect this
 * repository keeps finding.
 *
 * #73 added the third question, `rostersOf` — *"who is in this team"* — which is the narrowing term a
 * team-scoped approval stage intersects with. It belongs here for the same reason the other two do: it is a
 * leaf read on the eligibility path with no writer anywhere near it. `runDoctor` does not call it today, and
 * it satisfies the guard regardless, which is the point of the guard being a property of the file rather than
 * of the call graph.
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

/**
 * One team, as an eligibility check needs it: its identity, the name a refusal will print, and its members.
 *
 * The **name** travels with the members because the refusal an administrator reads is *"stage 2 needs a member
 * of team Legal"*, and a sentence that could only say `tm_01J…` would send them to a second screen to find out
 * what was short. It costs nothing: the join that reads the members reads the row that carries the name.
 */
export interface TeamRoster {
  id: string;
  name: string;
  /** Every user id in the team. Empty is a real answer — an emptied team is not a missing one. */
  members: Set<string>;
}

/**
 * The rosters of the named teams, in one query. A team that does not exist is **absent from the map**.
 *
 * ## Absent and empty are different answers, and both callers need the difference
 *
 * `LEFT JOIN`, so a team with no members comes back as a key with an empty set while a team id naming nothing
 * comes back not at all. Publication uses that to say two different things — *"there is no such team"*
 * (`E_NO_SUCH_TEAM`, the check #73 says was impossible before a `teams` row existed) and *"that team is
 * empty"* (`E_APPROVAL_UNSATISFIABLE`, with the shortfall named) — and collapsing them would make the first
 * refusal, which is a typo, read as the second, which is an organizational fact.
 *
 * ## Both cases are restrictive, which is what makes the map safe to consume
 *
 * Every caller intersects a stage's eligible set with `rosters.get(teamId)?.members ?? EMPTY`. An unknown team
 * therefore contributes the **empty** set and the stage is unsatisfiable — the restrictive answer for the
 * unclassified input, rather than the permissive one a missing key would give if absence meant "unconstrained".
 *
 * ## One query, and no new index — measured rather than assumed
 *
 * `teams` is sought by primary key and `team_members` is ranged inside `tm_unique`, whose `org_id` prefix is
 * usable even though the query constrains `team_id` rather than `user_id`. That is 0020's finding, and it is
 * re-printed for *this* statement in `test/teams.test.ts` rather than inherited: the range is over one
 * organization's membership, bounded by headcount and not by mail volume.
 *
 * `IN (…)` over the requested ids rather than every team in the organization, so a stage set naming one team
 * reads one team's members. An empty request short-circuits with no query at all, which is what keeps a send
 * gated by a team-less policy exactly as expensive as it was before this existed.
 */
export async function rostersOf(
  env: Env,
  orgId: string,
  teamIds: readonly string[],
): Promise<Map<string, TeamRoster>> {
  const wanted = [...new Set(teamIds)];
  if (wanted.length === 0) return new Map();
  const placeholders = wanted.map(() => "?").join(", ");
  const { results } = await env.CATALOG.prepare(
    `SELECT t.id AS team_id, t.name AS team_name, m.user_id AS user_id
       FROM teams t
       LEFT JOIN team_members m ON m.org_id = t.org_id AND m.team_id = t.id
      WHERE t.org_id = ? AND t.id IN (${placeholders})`,
  ).bind(orgId, ...wanted).all<{ team_id: string; team_name: string; user_id: string | null }>();

  const rosters = new Map<string, TeamRoster>();
  for (const row of results) {
    const roster = rosters.get(row.team_id)
      ?? { id: row.team_id, name: row.team_name, members: new Set<string>() };
    // Null on the outer join's unmatched side, which is a team with no members rather than a member with no id.
    if (row.user_id !== null) roster.members.add(row.user_id);
    rosters.set(row.team_id, roster);
  }
  return rosters;
}

/**
 * Every person holding `org.admin` on the organization, resolved through teams and de-duplicated.
 *
 * The **second source for an eligible set** that migration 0021 said a subject kind with no mailbox would have
 * to bring, and #66's domain pause is that kind: a pause stops every mailbox sending from a domain, so no
 * single mailbox's `approval.decide` holders have authority over it and naming one would be picking an
 * arbitrary mailbox to decide something about all of them.
 *
 * `org.admin` is the relation this Node already requires for every act that decides whether other people's
 * mail may leave — publishing a policy, placing a legal hold — so this widens no authority: it asks the
 * existing administrators, two of them, for an act one of them could not take alone.
 *
 * The SQL is `decidersByMailbox`'s shape with two literals changed, and the three properties it turns on are
 * the same three: it resolves teams, it de-duplicates on the **person** with `UNION` rather than `UNION ALL`
 * (which is what dual control rests on — one person in two admin teams is one administrator), and it requires
 * a row in `users` so a stale team id cannot satisfy dual control on its own. Written out rather than
 * parameterised on relation and object type, because a query built from a relation name is a query
 * `test/node/content-deletion-world.test.ts` cannot read table names out of, and because the two callers want
 * different return shapes — a map per mailbox, and one set.
 */
export async function adminsOf(env: Env, orgId: string): Promise<Set<string>> {
  const { results } = await env.CATALOG.prepare(
    `SELECT t.subject_id AS user_id
       FROM relationship_tuples t
       JOIN users u ON u.org_id = t.org_id AND u.id = t.subject_id
      WHERE t.org_id = ? AND t.object_type = 'organization' AND t.relation = 'org.admin'
        AND t.object_id = ?
     UNION
     SELECT m.user_id AS user_id
       FROM relationship_tuples t
       JOIN team_members m ON m.org_id = t.org_id AND m.team_id = t.subject_id
       JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id
      WHERE t.org_id = ? AND t.object_type = 'organization' AND t.relation = 'org.admin'
        AND t.object_id = ?`,
  ).bind(orgId, orgId, orgId, orgId).all<{ user_id: string }>();
  return new Set(results.map((row) => row.user_id));
}
