# Teams and membership

A team is a **subject** in this Node's authorization: a relation granted to a team is held by every member of
it. Until [#73][73] that was the whole of what a team was — an id appearing in `team_members` rows, with no
name, no row of its own, and **no writer anywhere in the product**. This document is what it became, and why
each part of it is shaped the way it is.

Related: [`docs/approvals.md`](approvals.md) for the stage constraint this exists for,
[`migrations/0032_teams.sql`](../apps/node/worker/migrations/0032_teams.sql) for the schema argument,
[`src/teams.ts`](../apps/node/worker/src/teams.ts) for the acts.

## The gap this closed, from the code rather than from memory

- `team_members` (`0001_init.sql`) is `id, org_id, team_id, user_id, created_at`. Three `SELECT`s in
  `src/authz-read.ts`, two joins in `src/deciders.ts`, **nothing writing it**.
- There was **no `teams` table at all**. A team had no name and no existence of its own.
- `test/audit-coverage.test.ts` recorded the consequence in as many words: *"No mutation path exists yet.
  Auditable when membership admin lands (§28)."*

So a policy stage that said *"a member of team T"* would have been **expressible and unusable**: nobody could
create the team it named, and publication could not verify that a named team exists — only that it currently
has members, which is a different question. That is this repository's most-repeated failure, *a condition
backed by no data is a policy that silently never fires*, which reads as governance and is not.

**The substrate and its consumer shipped together**, because a subsystem with no consumer and a constraint with
no subsystem are the two halves of the same mistake.

## The object

```
teams(id, org_id, name, created_by, created_at)
tea_name  UNIQUE (org_id, name)
```

**No column is nullable, and that is worth saying because two were considered and refused.** `renamed_at` would
have been a second, poorer account of a fact `team.renamed` already carries — it could say *when* and never
*from what* or *by whom*. `archived_at` is the lifecycle decision below.

**The name is unique in the organization.** A team is granted to by **id** and picked out of a list by a
**human reading a name**, so two teams called Finance is exactly how `approval.decide` reaches the wrong one,
with nothing anywhere to notice. `policies.name` is unique per organization for the same reason and the
argument transfers whole. What it costs: an organization that genuinely wants two teams under one name has to
distinguish them, and the refusal names the existing team's id so a rename or a reuse is one step.

`tea_name` is the only index, and it does two jobs: it enforces the uniqueness, and its `(org_id, name)` prefix
is exactly what `GET /api/teams` reads — every team in one organization, in name order, out of a covering
index. Lookup by id goes through the primary key.

## `team_members` needed a writer and nothing else — checked, not assumed

[#73][73] asked whether the table needed anything to stop the same person joining twice. **It already had it**:
`tm_unique` is `UNIQUE (org_id, user_id, team_id)` and has been since the first migration. So an add is
`INSERT OR IGNORE` behind an audit gate — a replayed add is a no-op that records nothing rather than an error or
a second entry claiming a second act, which is `grant`'s shape one table over.

No `added_by` column either, for `renamed_at`'s reason: the entry names the administrator.

No new index. The reverse direction — *"who is in this team"* — is a range inside `tm_unique`, whose `org_id`
prefix is usable even though the query constrains `team_id` rather than `user_id`; migration 0020 found this
for the neighbouring query by printing the plan after writing the "obvious" index and discovering it changed
only which covering index the planner named. The plan for **this** query is printed in `test/teams.test.ts`
rather than inherited from that finding.

## There is no delete and no archive

A team is a **subject** in `relationship_tuples`. `grant` does not verify that a subject is a person — it
cannot, since the same call grants to teams — so deleting a team row would leave tuples conferring
`approval.decide` and `mailbox.content.read` on an id nothing identifies. `decidersByMailbox` requires a row in
`users`, so those tuples would confer **nothing** while still appearing in `GET /api/access`: a grant that
silently does nothing, which is the defect this whole ticket exists to close, arriving through the back door.

What replaces deletion already exists and is louder:

- **Empty the team.** Reversible, audited per person, and visible — a live policy naming an emptied team becomes
  unsatisfiable at evaluation with the shortfall named.
- **Revoke its tuples.** The existing act for taking a subject's authority away, already audited as
  `access.revoked`.

So [#73][73]'s question — *"what happens to grants held by a deleted team?"* — is answered by there being no
deletion, rather than by a cascade nobody would have measured.

## The four acts, and the authority each takes

| Act | Endpoint | Authority | Audited as |
|:--|:--|:--|:--|
| create | `POST /api/teams` | `org.admin` | `team.created` |
| rename | `POST /api/teams/:id/rename` | `org.admin` | `team.renamed` |
| add a member | `POST /api/teams/:id/members` | `org.admin` | `team.member_added` |
| remove a member | `DELETE /api/teams/:id/members` | `org.admin` | `team.member_removed` |
| list, with sizes | `GET /api/teams` | any member | — |
| read one, with its roster | `GET /api/teams/:id` | `org.admin` | — |

`org.admin` for all four was the obvious answer and it was checked rather than assumed. Adding and removing is
authority, so it is not close. Renaming changes what the next administrator believes they are granting to.

**Creating is the one that could plausibly have been opened up**, because a team with no tuples confers nothing
— the argument that lets any member open a matter (`src/matters.ts`). It is `org.admin` anyway, and the reason
is about the *name* rather than the authority: names are unique in an organization, so creating a team takes a
name out of a shared space other people's grants will be chosen from, and `createPolicyDraft` already requires
`org.admin` for exactly that. A team anybody could create is a team an administrator might later grant
`mailbox.content.read` to, believing it to be the one their colleague described.

**Granting to a team is still `POST /api/access`** with the team id as the subject. There is deliberately no
endpoint here that does it: a team is a subject like any other, and a second door into `relationship_tuples`
would be a second place for *"who can reach this mailbox"* to be answered.

**The two reads take different authority, and the line between them is the roster.**

*The listing* is open to any member, and that is a decision. A team there is a name and a headcount — the
organizational chart rather than the ACL. What it buys is that an author whose send is waiting on *"a member of
team Legal"* can find out that such a team exists and how big it is, rather than reading a shortfall naming an
id they cannot resolve.

*The roster* takes `org.admin`, because a team's members are exactly the people every tuple that team holds
reaches: answering *"who is in Legal"* answers *"who can decide an approval on that mailbox"*. That is the map
`GET /api/access?subject=tm_…` already refuses a non-administrator, read from the subject's end rather than a
different map — so the two agree instead of one being a way round the other.

It refuses with **403** rather than the §5C **404** that `GET /api/supervised` and `GET /api/exports` give,
and the difference is that their oracle is still closed while this one is not: the listing has already handed
the same caller this team's id, name and size, so a 404 would misstate a fact they hold. An error that lies is
worse than one that names what is missing. `test/policy-routes.test.ts` asserts both halves in one test,
because the claim is the line and not either side of it.

## A Butler is not a team member, and it is enforced rather than documented

[#51][51] recorded why: a Butler's effective authority is

```
effective(step) = pinned ceiling ∩ live tuples of the Butler ∩ live tuples of the sponsor
```

and a ceiling whose second term moves whenever a third party edits a team is not a ceiling. So `addTeamMember`
requires the subject to be a row in **`users`** — a join that has to succeed, not a test on the shape of an id,
because a prefix check is the guard that quietly stops matching the day an id space changes. `decidersByMailbox`
requires the same row for the same class of reason.

`test/butler-capability.test.ts` already proved the other half: a `btl_` written straight into `team_members`
by hand gains nothing, because every read path resolves membership to people. This closes the door that would
have let it be written in the first place.

## What is audited, and why membership is not `case.claimed`

`AUDIT_ACTIONS` deliberately has no `case.claimed` — *"people claim all day"*, and an entry per claim grows an
untrimmable table without bound. The boundary that decision drew is **frequency and answerability**, and
membership sits at the far end of both.

**Membership is authority.** `readableSubjects` resolves a principal to `[userId, ...teamIds]`, so a relation
held by a team is held by every member. Adding somebody to a team can hand them a mailbox's contents and a vote
on somebody else's send with **no `access.granted` entry anywhere**. Un-audited, an administrator grants a team
once — in the trail — and then changes who that grant reaches for ever, in silence. That is the question
`relationship_tuples` is audited for, reached through a second door. And the frequency is bounded by headcount
and organizational change, not by mail volume.

Both membership entries key their **subject** on the person rather than the team, so *"what authority did this
person get, and when"* is one filter across `access.granted` and these. `team.member_removed` carries
`remaining`, because removing the last member is what makes a live team-scoped policy unsatisfiable and that
consequence is not otherwise attributable to an act.

**`team.created` and `team.renamed` are the harder call and are audited on their own merits.** Creating confers
nothing, so the authority argument does not reach them and frequency alone would exempt them. What earns the
entry is that **no other entry rides in that transaction to answer for it**: `policies` is exempt in
`audit-coverage.test.ts` precisely *because* `policy.drafted` records the same act in the same batch, and a
`teams` row has no such neighbour — exempting it would leave *"where did this team come from"* unanswerable.
A rename earns its own for a sharper reason: renaming "Interns" to "Finance" changes what the next
administrator believes they are granting `approval.decide` to, and the entry carries **both** names.

There is no `team.deleted` and no `team.archived`, because neither act exists — and a declared action nothing
emits is a category of one, which `audit-coverage.test.ts` fails on.

## What a team costs

| Path | Cost |
|:--|:--|
| an authorization check (`mayRead`, `maySend`, …) | **nothing**. `teams` is joined by nothing on that path |
| a seal gated by a team-less policy | **nothing**. The resolver short-circuits an empty request |
| a seal gated by a team-scoped stage | **+1** D1 execution (`rostersOf`) |
| a decision on a team-scoped stage | **+1**, and only when the *open* stage names a team |
| publishing a team-scoped version | one `readTeam` per named team, plus one `rostersOf` |

Both figures are measured with `src/cost-meter.ts` in real `workerd`, not counted by reading — see
`docs/receipts/approval-decision-cost.md`, whose own staleness clause named this change in advance and reserved
the headroom it spent, and `docs/receipts/authz-check-rows-read.md`, where the authorization figures are
asserted as **equalities** before and after every team in the benchmark corpus becomes a real object. An
equality is used there deliberately: the claim is that the number *did not move*, and a bound cannot say that.

## Still not built

- **A `doctor` finding for a live policy naming an empty team.** `legal_hold_unliftable` is the analogous check.
  This one is a pass over live policy versions crossed with team rosters, which is cron-shaped rather than
  request-shaped, and a second mechanism invented for it here would be the thing to undo later. The two checks
  that do exist — publication and evaluation — are the two [#61][61] established.
- **Nested teams.** A team whose member is a team would turn *"who can reach this mailbox"* from a list into a
  traversal, which is the delegation `src/access.ts` refused for the same reason.
- **A UI.** The shell is Layer 1–3's surface; the policy, approval and supervised planes have none either.

[51]: https://github.com/Straits-AI/mailda/issues/51
[61]: https://github.com/Straits-AI/mailda/issues/61
[73]: https://github.com/Straits-AI/mailda/issues/73
