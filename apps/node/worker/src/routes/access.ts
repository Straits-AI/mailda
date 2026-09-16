import { assertAdmin, conferredBySupervision, grant, isAdmin, isGrantable, relationsOf, revoke } from "../access.ts";
import { addTeamMember, createTeam, listTeams, membersOf, readTeam, removeTeamMember, renameTeam } from "../teams.ts";
import type { Call, Some } from "../router.ts";

const teamMembership = async (
  { request, env, clock, params, who }: Call<"POST /api/teams/:teamId/members" | "DELETE /api/teams/:teamId/members">,
): Promise<Response> => {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const act = request.method === "POST" ? addTeamMember : removeTeamMember;
  return Response.json({
    membership: await act(
      env, clock, who.orgId, who.userId, params.teamId, String(body.userId ?? ""),
    ),
  });
};

export const access = {
  "POST /api/access": async ({ request, env, clock, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const relation = String(body.relation ?? "");
    if (!isGrantable(relation)) {
      /*
       * A relation this Node *knows* but will not grant here gets told which door works, because "not
       * grantable" is exactly the answer that sends an administrator round the back. `supervised.read` is
       * conferred by a time-boxed grant with two approvers, not by a tuple, and an administrator who is
       * told only "no" grants themselves `mailbox.content.read` instead — which still works, and which
       * doctor now reports as `self_granted_access` (#63).
       */
      const supervised = conferredBySupervision(relation);
      return Response.json(
        {
          error: "not_grantable",
          message: supervised === null
            ? `${relation || "(none)"} is not a grantable relation.`
            : `${supervised} is not granted this way. It is a time-boxed supervised read: POST /api/supervised `
              + `with {"mailboxId","scope","durationSeconds"} and an optional matter, and two people holding `
              + `approval.decide on that mailbox — neither of them you — have to approve it (§7).`,
        },
        { status: 422 },
      );
    }
    const outcome = await grant(env, clock, who.orgId, who.userId, {
      subjectId: String(body.subjectId ?? ""),
      relation,
      objectId: String(body.objectId ?? ""),
    });
    return Response.json(outcome);
  },

  "DELETE /api/access": async ({ request, env, clock, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const relation = String(body.relation ?? "");
    if (!isGrantable(relation)) {
      return Response.json(
        { error: "not_grantable", message: `${relation || "(none)"} is not a grantable relation.` },
        { status: 422 },
      );
    }
    return Response.json(await revoke(env, clock, who.orgId, who.userId, {
      subjectId: String(body.subjectId ?? ""),
      relation,
      objectId: String(body.objectId ?? ""),
    }));
  },

  /**
   * Everybody in the organization, with what each of them may do (#39, #81).
   *
   * `GET /api/access` answers for **one** subject and defaults to the caller, which is the right shape for
   * "what may I do" and useless for "who may read this mailbox" — the question an administrator actually
   * has, and the one they had no way to ask. Without it there was no list of colleagues anywhere in the
   * product, so granting somebody access meant knowing a user id they could only get from the database.
   *
   * One read rather than a list plus a relations call per person: the tuples are the same rows either way,
   * and N+1 across a directory is how a screen becomes slow at the size where it starts to matter.
   *
   * **`org.admin` only, answering 404.** §5C, and the same answer `/api/policies` gives: who works here
   * and what they can reach is exactly the shape a 403 would confirm the existence of.
   */
  "GET /api/people": async ({ env, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json(
        { error: "not_found", message: "No directory, or you do not have access to it." },
        { status: 404 },
      );
    }
    const people = await env.CATALOG.prepare(
      "SELECT id, email, created_at FROM users WHERE org_id = ? ORDER BY email",
    ).bind(who.orgId).all<{ id: string; email: string; created_at: string }>();
    const tuples = await env.CATALOG.prepare(
      `SELECT subject_id, relation, object_type, object_id FROM relationship_tuples
        WHERE org_id = ? ORDER BY relation`,
    ).bind(who.orgId).all<{
      subject_id: string; relation: string; object_type: string; object_id: string;
    }>();
    const held = new Map<string, Array<{ relation: string; objectType: string; objectId: string }>>();
    for (const row of tuples.results) {
      const list = held.get(row.subject_id) ?? [];
      list.push({ relation: row.relation, objectType: row.object_type, objectId: row.object_id });
      held.set(row.subject_id, list);
    }
    return Response.json({
      people: people.results.map((person) => ({ ...person, relations: held.get(person.id) ?? [] })),
    });
  },

  "GET /api/access": async ({ env, url, who }) => {
    // Own relations need no admin — knowing what you hold is not privileged. Somebody else's does.
    const subjectId = url.searchParams.get("subject") ?? who.userId;
    if (subjectId !== who.userId && !(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json(
        { error: "not_found", message: "No such subject, or you do not have access to it." },
        { status: 404 },
      );
    }
    return Response.json({ subjectId, relations: await relationsOf(env, who.orgId, subjectId) });
  },

  /**
   * Teams and membership (#73, §28, Layer 3/5).
   *
   * `POST   /api/teams`              create a team. A team with no tuples confers nothing
   * `GET    /api/teams`              every team, with its size — the number a team-scoped policy turns on
   * `GET    /api/teams/:id`          one team and who is in it
   * `POST   /api/teams/:id/rename`   change the name a person picks it out of a list by
   * `POST   /api/teams/:id/members`  put somebody in it, which confers every relation the team holds
   * `DELETE /api/teams/:id/members`  take somebody out, effective on their next request
   *
   * **Five of the six take `org.admin`; `GET /api/teams` is the one exception**, and the line between them
   * is *name and headcount* against *who is in it*. The listing is the organizational chart — a member who
   * reads a shortfall saying "a member of team Legal" has to be able to resolve that name — and the roster
   * is the access map read from the other end, because a team's members are exactly the people every tuple
   * that team holds reaches. `GET /api/access?subject=tm_…` is admin-only for that reason and this is the
   * same question turned round, so it is admin-only too. Each handler carries its own half of the argument;
   * `test/policy-routes.test.ts` asserts both, so the split is enforced rather than described.
   *
   * Among the five, the one worth arguing is `POST /api/teams`: creating a team confers nothing, so the
   * *authority* argument alone would open it up the way `POST /api/matters` is open. It is closed because of
   * the **name** — team names are unique in an organization, so creating one takes a name out of a shared
   * space other people's grants will be chosen from. `src/teams.ts` carries the argument.
   *
   * **Granting to a team is still `POST /api/access`** with the team id as the subject, and there is
   * deliberately no endpoint here that does it. A team is a subject like any other; a second door into
   * `relationship_tuples` would be a second place for *"who can reach this mailbox"* to be answered.
   *
   * **There is no team deletion**, and that is not a gap: a team is a tuple subject, so removing the row
   * would leave grants pointing at an id nothing identifies — conferring nothing while still reading as a
   * grant. Emptying the team and revoking its tuples are the two acts that take its authority away, and both
   * are here. Migration 0032 carries it in full.
   */
  "POST /api/teams": async ({ request, env, clock, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // An absent name reaches `createTeam` as the empty string and is refused there with the four-part
    // message, rather than defaulted — a team this Node named for somebody would be a label nobody chose.
    return Response.json({ team: await createTeam(env, clock, who.orgId, who.userId, String(body.name ?? "")) });
  },

  "GET /api/teams": async ({ env, who }) => {
    /*
     * Readable by any member, and that is a decision rather than an oversight.
     *
     * A team is a name and a headcount. It is **not** the access map: which relations a team holds is
     * `GET /api/access?subject=tm_…` and who is in it is `GET /api/teams/:id`, and **both of those are
     * admin-only**. §5C's concern is a listing that hands out what somebody may not see, and "this
     * organization has a team called Finance with four people in it" is the organizational chart rather
     * than the ACL.
     *
     * What it buys is that an author whose send is waiting on *"a member of team Legal"* can find out that
     * such a team exists and how big it is, rather than reading a shortfall naming an id they cannot resolve.
     */
    return Response.json({ teams: await listTeams(env, who.orgId) });
  },

  /**
   * Who is in a team (#73, #81).
   *
   * `membersOf` was written with the sentence *"so an administrator can see who a grant to it reaches"*
   * and had no route, so the only readable fact about a team was its member **count**. A screen given a
   * count and a list of people can render a checkbox, and the checkbox cannot be right: it shows unchecked
   * for a member, because nothing told it otherwise. A control that never reflects state is worse than no
   * control, so the roster is readable now.
   */
  "GET /api/teams/:teamId/members": async ({ env, params, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ members: await membersOf(env, who.orgId, params.teamId) });
  },

  "POST /api/teams/:teamId/members": teamMembership,
  "DELETE /api/teams/:teamId/members": teamMembership,

  "POST /api/teams/:teamId/rename": async ({ request, env, clock, params, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json({
      team: await renameTeam(env, clock, who.orgId, who.userId, params.teamId, String(body.name ?? "")),
    });
  },

  "GET /api/teams/:teamId": async ({ env, params, who }) => {
    /*
     * `org.admin`, unlike the listing above, because this is where the roster is.
     *
     * A team's members are exactly the people every tuple that team holds reaches, so answering *"who is in
     * Finance"* answers *"who can decide an approval on that mailbox"* for anybody who can also read
     * `GET /api/teams`. `GET /api/access?subject=…` refuses somebody else's relations to a non-administrator
     * for that reason, and this is the same map read from the subject's end rather than a different one.
     *
     * **403 rather than the §5C 404** the supervised and export listings give, and the difference is that
     * their oracle is still closed: those routes hide *whether there is anything to see*. This team's id,
     * name and size were handed to this same caller by the listing one handler up, so a 404 would be a
     * refusal that misstates a fact the caller already holds — and an error that lies is worse than one that
     * says what is missing. `assertAdmin`'s message names the relation and how to get it.
     */
    await assertAdmin(env, who.orgId, who.userId);
    const team = await readTeam(env, who.orgId, params.teamId);
    if (team === null) {
      return Response.json(
        { error: "not_found", message: "No such team." },
        { status: 404 },
      );
    }
    return Response.json({ team, members: await membersOf(env, who.orgId, team.id) });
  },
} satisfies Some;
