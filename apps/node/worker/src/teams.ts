import type { Ctx } from "@mailda/runtime";

import { assertAdmin } from "./access.ts";
import { auditedBatch } from "./audit.ts";
import { conflict, notFound, unprocessable } from "./errors.ts";

/**
 * Teams: membership administration, and the writer `team_members` never had (#73, §28, Layer 3/5).
 *
 * ## What was here before this file, said plainly
 *
 * `team_members` has existed since `0001_init.sql` and was **read-only in the product**: three SELECTs in
 * `src/authz-read.ts`, two joins in `src/deciders.ts`, and nothing anywhere that wrote it. There was no
 * `teams` table at all, so a team had no name and no existence of its own — it was an id that happened to
 * appear in membership rows nobody could create. `test/audit-coverage.test.ts` recorded the consequence in as
 * many words: *"No mutation path exists yet. Auditable when membership admin lands (§28)."* This is that
 * moment, and that classification moves in the same change.
 *
 * ## Membership is authority, which is the fact everything below is shaped by
 *
 * `readableSubjects` resolves a principal to `[userId, ...teamIds]`, so **a relation held by a team is held by
 * every member of it**. Putting somebody in a team can therefore hand them the contents of a mailbox and a
 * vote on somebody else's send, with no `access.granted` entry anywhere — the same authority `src/access.ts`
 * guards, reached through a second door. Three consequences follow, and none of them is a preference:
 *
 *   * every act here requires `org.admin`, checked live, exactly as `grant` and `revoke` do;
 *   * every act here is audited in the same transaction as the row it writes;
 *   * a **Butler may not be a member of a team** (#51). `addTeamMember` requires a row in `users`, and a
 *     Butler is a `btl_` in `butlers` — so the refusal is a join that has to succeed rather than a test on the
 *     shape of a string. A Butler that inherited a team's grants would have an effective authority that moved
 *     whenever somebody edited a team, and a capability ceiling intersected with a set like that is not a
 *     ceiling. Enforced here, and asserted in `test/teams.test.ts`, rather than written down and hoped for.
 *
 * ## `org.admin` for all four acts, and the one that was worth arguing
 *
 * Adding and removing a member is authority, so it is not a close call. Renaming is not much closer: a team is
 * granted to by **id** and chosen by a human reading a **name**, so a rename changes what the next
 * administrator believes they are granting `approval.decide` to.
 *
 * **Creating** is the one that could plausibly have been opened up, because a team with no tuples confers
 * nothing at all — the same argument that lets any member open a matter (`src/matters.ts`). It is still
 * `org.admin`, for a reason that is about the *name* rather than about the authority: team names are UNIQUE
 * within an organization (`tea_name`), so creating one takes a name out of a shared space that other people's
 * grants will be chosen from, and `createPolicyDraft` already requires `org.admin` for exactly that. A team
 * anybody could create is a team an administrator might later grant `mailbox.content.read` to, believing it to
 * be the one their colleague described.
 *
 * ## There is no delete and no archive, and that is the lifecycle decision
 *
 * A team is a **subject** in `relationship_tuples`. `grant` does not verify that a subject is a person — it
 * cannot, because the same call grants to teams — so deleting a team row would leave tuples conferring
 * `approval.decide` on an id nothing identifies. `decidersByMailbox` requires a row in `users`, so those
 * tuples would confer nothing while still appearing in `GET /api/access`: a grant that silently does nothing,
 * which is the defect this whole ticket exists to close, arriving through the back door.
 *
 * What replaces deletion already exists and is louder. **Empty the team**, which is reversible, audited per
 * person, and visible — a live policy naming an emptied team becomes unsatisfiable at *evaluation* with the
 * shortfall named, exactly as revoking `approval.decide` from the last holder does (#61 chose that answer, and
 * this reaches the same one). And **revoke its tuples**, which is the existing act for taking a subject's
 * authority away. So #73's question *"what happens to grants held by a deleted team"* is answered by there
 * being no deletion, rather than by a cascade nobody would have measured.
 *
 * ## Removing the last member is permitted, and that is deliberate
 *
 * It is the same shape as revoking the last `approval.decide` holder, and #61 settled that: the removal is
 * allowed, and the send that can no longer be approved is **withheld** with `approval_unsatisfiable` naming
 * which stage and how many short. Refusing the removal instead would put a policy in charge of who may leave a
 * team, which is a governance rule nobody wrote — and it would fail in the direction that leaves somebody in a
 * team they should not be in. What makes it safe is that the consequence is loud at both ends: publication
 * refuses a policy naming an already-empty team, and evaluation withholds rather than parking in `awaiting`.
 *
 * The `team.member_removed` entry carries `remaining`, so *"which act emptied this team"* is one filter rather
 * than an inference from timestamps.
 *
 * ## Still not built, named rather than implied
 *
 * **No `doctor` finding for a live policy naming an empty team.** `legal_hold_unliftable` is the analogous
 * check one table over, and the reason this does not have one yet is the same reason #61's header gives for
 * the uncovered `awaiting` sweep: it is a pass over live policy versions crossed with team rosters, which is
 * cron-shaped work rather than a request-shaped read, and inventing a second mechanism for it here would be
 * the thing to undo later. The two checks that do exist — publication and evaluation — are the two #61
 * established, and this constraint reaches exactly the same answer as the ones already in place.
 */

export interface Team {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

interface Row {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
}

const COLUMNS = "id, name, created_by, created_at";

function teamOf(row: Row): Team {
  return { id: row.id, name: row.name, createdBy: row.created_by, createdAt: row.created_at };
}

/** One team, or null. The existence check publication needs before it will let a stage name one. */
export async function readTeam(env: Env, orgId: string, teamId: string): Promise<Team | null> {
  const row = await env.CATALOG.prepare(
    `SELECT ${COLUMNS} FROM teams WHERE org_id = ? AND id = ? LIMIT 1`,
  ).bind(orgId, teamId).first<Row>();
  return row === null ? null : teamOf(row);
}

export interface TeamListing extends Team {
  /**
   * How many people are in it. **On the listing rather than discoverable**, because the number that decides
   * whether a team-scoped policy can be satisfied is this one, and an administrator writing that policy is
   * looking at exactly this screen. A team of zero is the state that makes a rule unsatisfiable, so it is the
   * one thing a list of teams must not make somebody click through to find.
   */
  memberCount: number;
}

/**
 * Every team in the organization, in name order, with its size. One query.
 *
 * A `LEFT JOIN` and a `COUNT`, so a team with no members is a row reading `0` rather than a row that is not
 * there — which is the same absent-versus-empty distinction `rostersOf` draws, for the same reason: an empty
 * team is a real and consequential answer.
 *
 * Ordered by name because that is what `tea_name` is ordered by and what a person reads.
 */
export async function listTeams(env: Env, orgId: string): Promise<TeamListing[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT t.id, t.name, t.created_by, t.created_at, COUNT(m.user_id) AS member_count
       FROM teams t
       LEFT JOIN team_members m ON m.org_id = t.org_id AND m.team_id = t.id
      WHERE t.org_id = ?
      GROUP BY t.id, t.name, t.created_by, t.created_at
      ORDER BY t.name`,
  ).bind(orgId).all<Row & { member_count: number }>();
  return results.map((row) => ({ ...teamOf(row), memberCount: row.member_count }));
}

/** The members of one team, so an administrator can see who a grant to it reaches. */
export async function membersOf(env: Env, orgId: string, teamId: string): Promise<string[]> {
  const { results } = await env.CATALOG.prepare(
    "SELECT user_id FROM team_members WHERE org_id = ? AND team_id = ? ORDER BY user_id",
  ).bind(orgId, teamId).all<{ user_id: string }>();
  return results.map((row) => row.user_id);
}

/**
 * A team name, trimmed and refused when empty.
 *
 * Mandatory means non-empty, for `openMatter`'s reason one table over: the column can hold the `NOT NULL` half
 * of that guarantee and not the second, and a team called `""` is a team an administrator cannot pick out of a
 * list — which turns a grant into a guess.
 */
function nameOrThrow(raw: string): string {
  const name = raw.trim();
  if (name !== "") return name;
  throw unprocessable("E_TEAM_NEEDS_A_NAME", {
    what: "a team was submitted with no name",
    why: "a team is granted to by id and chosen by a human reading its name, so a nameless team is a grant "
      + "nobody can aim",
    fix: "give the team a short name saying who is in it — Finance, Legal, Duty managers",
  });
}

async function assertNameFree(env: Env, orgId: string, name: string, exceptTeamId?: string): Promise<void> {
  // Checked here for the message, enforced by `tea_name` in the schema. Two concurrent creations of one name
  // lose at the UNIQUE index rather than here, which surfaces as a constraint violation instead of this
  // refusal — worse wording, correct outcome, and the outcome is the part that must not be left to a
  // check-then-act window. Same split `createPolicyDraft` records.
  const existing = await env.CATALOG.prepare(
    "SELECT id FROM teams WHERE org_id = ? AND name = ? LIMIT 1",
  ).bind(orgId, name).first<{ id: string }>();
  if (existing === null || existing.id === exceptTeamId) return;
  throw conflict("E_TEAM_NAME_TAKEN", {
    what: `a team called ${JSON.stringify(name)} already exists`,
    why: "team names are unique within an organization, because a team is picked by a person reading a name "
      + "and stored as an id — two teams under one name is how approval.decide is granted to the wrong one",
    fix: `use ${existing.id}, or choose a different name`,
  });
}

/**
 * Creates a team. Audited in the same transaction as the row.
 *
 * It confers nothing on its own: an empty team with no tuples is a name. What makes it useful is granting a
 * relation to it (`POST /api/access` with the team id as the subject) and putting people in it, and both of
 * those are separate, separately audited acts.
 */
export async function createTeam(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  rawName: string,
): Promise<Team> {
  await assertAdmin(env, orgId, actorUserId);
  const name = nameOrThrow(rawName);
  await assertNameFree(env, orgId, name);

  const team: Team = {
    // `tm` is the prefix `team_members.team_id` has always carried — `0001_init.sql` names `tm_01J…` as the
    // example of a typed-prefix id that makes a `subject_type` column redundant. Minting a different one would
    // have made every tuple written against a hand-seeded team id unreachable from the new table.
    id: ctx.id("tm"),
    name,
    createdBy: actorUserId,
    createdAt: new Date(ctx.now()).toISOString(),
  };

  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "team.created",
      outcome: "ok",
      actorUserId,
      subject: team.id,
      detail: { name: team.name },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        "INSERT INTO teams (id, org_id, name, created_by, created_at) VALUES (?,?,?,?,?)",
      ).bind(team.id, orgId, team.name, team.createdBy, team.createdAt),
    ],
  );

  return team;
}

/**
 * Renames a team. Conditional on the name it had when this call read it, audited with **both** names.
 *
 * The old name is in the entry rather than in a column, because that is the half a `renamed_at` could not
 * carry and the half somebody actually asks about: *"what was this team called when I granted to it?"*
 *
 * The predicate pins the old name as well as the id, so two renames landing together do not both record an
 * entry claiming to have changed it from the same thing. #9's shape: the conflict is the signal.
 */
export async function renameTeam(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  teamId: string,
  rawName: string,
): Promise<Team> {
  await assertAdmin(env, orgId, actorUserId);
  const name = nameOrThrow(rawName);

  const team = await readTeam(env, orgId, teamId);
  if (team === null) throw noSuchTeam(teamId, "renaming names the team it renames");
  if (team.name === name) {
    throw conflict("E_TEAM_NAME_UNCHANGED", {
      what: `team ${teamId} is already called ${JSON.stringify(name)}`,
      why: "a rename that changes nothing would put an entry in the trail claiming an act nobody took",
      fix: "send a different name, or leave it as it is",
    });
  }
  await assertNameFree(env, orgId, name, teamId);

  const gate = {
    sql: "SELECT 1 FROM teams WHERE id = ? AND org_id = ? AND name = ?",
    params: [teamId, orgId, team.name] as unknown[],
  };
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "team.renamed",
      outcome: "ok",
      actorUserId,
      subject: teamId,
      detail: { from: team.name, to: name },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare("UPDATE teams SET name = ? WHERE id = ? AND org_id = ? AND name = ?")
        .bind(name, teamId, orgId, team.name),
    ],
    gate,
  );

  if ((results[1]?.meta.changes ?? 0) === 0) {
    throw conflict("E_TEAM_RENAME_RACED", {
      what: `team ${teamId} was renamed by somebody else while this rename was being prepared`,
      why: "the entry names the name this team was changed *from*, so it is refused rather than written "
        + "against a name that had already moved — an audit entry that misstates the old name is worse than "
        + "an absent one",
      fix: "GET /api/teams and rename again if the change is still wanted",
    });
  }
  return { ...team, name };
}

function noSuchTeam(teamId: string, why: string): Error {
  return notFound("E_NO_SUCH_TEAM", {
    what: `${teamId} is not a team in this organization`,
    why,
    fix: "GET /api/teams lists every team with its id, its name and how many people are in it",
  });
}

export interface MembershipOutcome {
  teamId: string;
  userId: string;
  /** False when the row already existed, or already did not — the derived key made it a no-op (#9). */
  changed: boolean;
  /** How many people are in the team after this call. What makes an emptying visible at the moment it happens. */
  members: number;
}

/**
 * Puts somebody in a team, which confers every relation that team holds. Idempotent, and audited.
 *
 * ## The subject must be a row in `users`, and that is the Butler refusal
 *
 * #51 recorded why a Butler must not inherit a team's grants: its effective authority is
 * `pinned ceiling ∩ live tuples of the Butler ∩ live tuples of the sponsor`, and a ceiling whose second term
 * moves when a third party edits a team is not pinned. So the enforcement is a join that has to succeed — the
 * person must exist in `users` — rather than a test on the shape of an id, which is the check that quietly
 * stops matching the day a prefix changes. `decidersByMailbox` requires the same row for the same class of
 * reason, and `test/butler-capability.test.ts` already proves the other half: a `btl_` written straight into
 * `team_members` by hand gains nothing, because every read path resolves membership to people.
 *
 * ## Idempotent through the index, not through a read
 *
 * `tm_unique` is `UNIQUE (org_id, user_id, team_id)` and has been since 0001, so `INSERT OR IGNORE` makes a
 * replayed add a no-op without a check-then-act window. The audit entry is **gated on the insert actually
 * happening**, so replaying does not append a second `team.member_added` claiming a second act — the shape
 * `grant` uses one table over.
 */
export async function addTeamMember(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  teamId: string,
  userId: string,
): Promise<MembershipOutcome> {
  await assertAdmin(env, orgId, actorUserId);
  if ((await readTeam(env, orgId, teamId)) === null) {
    throw noSuchTeam(teamId, "a membership row naming a team that does not exist would confer nothing, and "
      + "would look like access that silently does not work");
  }

  const person = await env.CATALOG.prepare(
    "SELECT 1 FROM users WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, userId).first();
  if (person === null) {
    throw unprocessable("E_NOT_A_PERSON", {
      what: `${userId === "" ? "(none)" : userId} is not a person in this organization`,
      why: "a team's members inherit every relation the team holds, so membership is only meaningful for a "
        + "principal whose authority is meant to be a person's. A Butler is deliberately not one (#51): its "
        + "capability ceiling is intersected with its own tuples, and a ceiling that moved when somebody "
        + "edited a team would not be a ceiling",
      fix: "add a user. A Butler is granted relations directly — POST /api/access with the btl_ id as the "
        + "subject — so its authority is a list somebody wrote rather than a side effect of a team edit",
    });
  }

  const at = new Date(ctx.now()).toISOString();
  const gate = {
    sql: `SELECT 1 WHERE NOT EXISTS (
            SELECT 1 FROM team_members WHERE org_id = ? AND user_id = ? AND team_id = ?)`,
    params: [orgId, userId, teamId] as unknown[],
  };
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "team.member_added",
      outcome: "ok",
      actorUserId,
      // The **person**, not the team: `access.granted` keys on the subject for the same reason, so "what
      // authority did this person get, and when" stays one filter across both doors into it.
      subject: userId,
      detail: { teamId, userId },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        "INSERT OR IGNORE INTO team_members (id, org_id, team_id, user_id, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("tmm"), orgId, teamId, userId, at),
    ],
    gate,
  );

  return {
    teamId,
    userId,
    changed: (results[1]?.meta.changes ?? 0) > 0,
    members: (await membersOf(env, orgId, teamId)).length,
  };
}

/**
 * Takes somebody out of a team, withdrawing every relation that team holds from them.
 *
 * Effective on the next request, because nothing caches a relation: `readableSubjects` re-reads `team_members`
 * on every check, which is what §7 and §28 require of withdrawn authority and what `revoke` already gives for
 * a tuple.
 *
 * **Removing the last member is permitted.** See this module's header: it is the same act as revoking the last
 * `approval.decide` holder, and #61 settled that a live policy is allowed to become unsatisfiable — loudly, at
 * evaluation, with the shortfall named — rather than a membership change being refused because a rule
 * somewhere depends on it. `remaining` is in the entry so the act that emptied a team is one filter away.
 */
export async function removeTeamMember(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  teamId: string,
  userId: string,
): Promise<MembershipOutcome> {
  await assertAdmin(env, orgId, actorUserId);

  const gate = {
    sql: "SELECT 1 FROM team_members WHERE org_id = ? AND user_id = ? AND team_id = ?",
    params: [orgId, userId, teamId] as unknown[],
  };
  // Read before the write, so the entry can say what the team is *left with* rather than what it had. The
  // count is taken from the same transaction's own effect below: this is the size before, minus this row.
  const before = (await membersOf(env, orgId, teamId)).length;
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "team.member_removed",
      outcome: "ok",
      actorUserId,
      subject: userId,
      detail: {
        teamId,
        userId,
        // How many are left. Zero is the interesting value: it is the state in which a live policy naming this
        // team stops being satisfiable, and this entry is the only thing that attributes that to an act.
        remaining: Math.max(0, before - 1),
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        "DELETE FROM team_members WHERE org_id = ? AND user_id = ? AND team_id = ?",
      ).bind(orgId, userId, teamId),
    ],
    gate,
  );

  const changed = (results[1]?.meta.changes ?? 0) > 0;
  return { teamId, userId, changed, members: changed ? Math.max(0, before - 1) : before };
}
