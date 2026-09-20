import type { Ctx } from "@mailda/runtime";

import { BUDGETS } from "@mailda/budgets";
import type { AuditEvent, AuditGate } from "./audit.ts";
import { adminsOf, decidersOf, type TeamRoster } from "./deciders.ts";
import { noticesForApprovalRequest } from "./notifications.ts";

/**
 * The `send_manifests.state_reason` tokens an approval produces, with the **words** in
 * `src/client/delivery.client.js`.
 *
 * Not in `STATE_FOR`, and that is a boundary rather than an inconsistency. `STATE_FOR` maps a policy *outcome*
 * to the state a seal produces, and neither of these is produced by an outcome: `approval_denied` is what a
 * person decided afterwards, and `approval_unsatisfiable` is an override of the mapping's own answer — the
 * outcome really is `require_approval`, and what makes the send `withheld` is that nobody can clear it. Adding
 * them to a `Record<Outcome, …>` would need two fake outcomes to hang them on.
 *
 * The reason words live in `delivery.client.js` by design, for the reason its own header gives: one place owns
 * the prose, and it is the module a test can evaluate as the exact bytes a browser is served.
 */
export const APPROVAL_REASONS = ["approval_denied", "approval_unsatisfiable"] as const;

export type ApprovalState = "pending" | "approved" | "denied" | "unsatisfiable" | "cancelled";
export type Decision = "approve" | "deny";

/**
 * The subject kinds an approval may decide on.
 *
 * The declared set, and **the only place it is declared**. `approvals.subject_kind` carries no CHECK
 * constraint — SQLite cannot add one with `ALTER TABLE`, and a trigger cannot exist in this tree because
 * `src/migrate.ts` splits migrations on semicolons (`test/node/migrations.test.ts`). So this union is the
 * constraint, and `test/node/content-deletion-world.test.ts` is what makes it one rather than a convention:
 * it requires every subject-kind literal in `src/` to appear here and requires `approvals` to have exactly
 * one writer, because a kind that slipped past would be an approval nothing knows how to complete.
 *
 * `supervised_read` is the third (#63), and adding it was a **compile error until handled** in three places —
 * `ACTOR_DID`, `EXPIRES_AFTER_SECONDS` and `COMPLETING_EFFECT` are all `Record`s keyed on this union. That is
 * the design working rather than a coincidence: #63 needed dual approval and the alternative was a second
 * approval path, which would have been a second copy of the race logic **all three of #61's defects lived in**.
 * The hold lift proved the generalisation; this ticket spent it.
 *
 * `ediscovery_export` is the fourth (#65), and it was a compile error in **five** places — the three above
 * plus `HAS_AWAITING_MANIFEST` and the outcome field in `decideApproval`, both of which #63 added precisely
 * because a two-way test on `hold_lift` had silently sent a third kind down the send path. Nothing about the
 * fourth kind needed new race logic, which is the whole return: an export is requested, decided, withdrawn
 * and refused by the same code as a send.
 *
 * `domain_pause` is the fifth (#66), and it is the first kind that is **not about a mailbox**. It was a
 * compile error in six places — the five above plus `SCOPE_OF` below, which exists because of it — and that
 * is again the design working: pausing a domain needed dual control and a mandatory reason, and the
 * alternative was a second approval path, which would have been a second copy of the race logic all three of
 * #61's defects lived in.
 */
export const APPROVAL_SUBJECT_KINDS = [
  "send_manifest", "hold_lift", "supervised_read", "ediscovery_export", "domain_pause",
] as const;

export type ApprovalSubjectKind = (typeof APPROVAL_SUBJECT_KINDS)[number];

/** Which object an approval's eligible set is read from. Two today, and both are real `object_type`s. */
export type ApprovalScope = "mailbox" | "organization";

/**
 * Where each kind's approvers come from: the object type, and therefore the relation.
 *
 *   `mailbox`       `approval.decide` holders on `scope_id`, via `decidersOf`.
 *   `organization`  `org.admin` holders on `scope_id`, via `adminsOf`.
 *
 * A `Record` keyed on the union, like every other per-kind map in this file, so a sixth kind cannot inherit
 * whichever answer happened to be the default. That matters more here than anywhere else in the module: the
 * default would be `mailbox`, and a kind with no mailbox that inherited it would look up the holders of
 * `approval.decide` on an id that is not a mailbox, find none, and report the request **unsatisfiable** — a
 * governance act silently impossible to perform, which is #60's governing failure wearing a different hat.
 */
export const SCOPE_OF: Record<ApprovalSubjectKind, ApprovalScope> = {
  send_manifest: "mailbox",
  hold_lift: "mailbox",
  supervised_read: "mailbox",
  ediscovery_export: "mailbox",
  domain_pause: "organization",
};

/**
 * The eligible set for one approval, before the actor and the already-decided are taken out.
 *
 * One function so the four call sites — publication is the fifth and asks a narrower question — cannot each
 * decide for themselves which relation a kind reads. `decidersOf` was called directly at two of them until
 * #66, and a fifth kind reaching either of those lines would have been handed the mailbox answer.
 */
export async function approversOf(
  env: Env,
  orgId: string,
  kind: ApprovalSubjectKind,
  scopeId: string,
): Promise<Set<string>> {
  return SCOPE_OF[kind] === "organization" ? adminsOf(env, orgId) : decidersOf(env, orgId, scopeId);
}

/**
 * The word each kind uses for the act it gates, in the second person, for the refusal an actor reads when
 * they try to decide their own.
 *
 * A `Record` keyed on the type, so a new subject kind is a compile error here rather than a refusal that
 * says "you composed this send" to somebody who requested a hold lift.
 */
export const ACTOR_DID: Record<ApprovalSubjectKind, string> = {
  send_manifest: "you composed this send, so you cannot decide its approval",
  hold_lift: "you requested this hold lift, so you cannot be one of the two people who approve it",
  // The reader and the requester are the same principal by construction (`requestSupervisedRead`), so this
  // refusal is the one that stops somebody approving their own way into a mailbox.
  supervised_read:
    "you asked to read this mailbox, so you cannot be one of the two people who approve it",
  // The requester is the person the export is *for* — `exports.requested_by` is the caller, always — so this
  // is the refusal that stops an investigator approving their own bulk copy of somebody's mailbox.
  ediscovery_export:
    "you asked for this export, so you cannot be one of the two people who approve it",
  // The requester is always an administrator (`requestDomainPause` refuses anybody else), and every
  // approver is one too — so this is the refusal that stops a single administrator stopping a customer's
  // mail on their own authority, which is the whole ceremony #66 put in front of placing a pause.
  domain_pause:
    "you asked to pause this domain, so you cannot be one of the two people who approve it",
};

/**
 * What to do instead, per kind, in the same refusal.
 *
 * A second `Record` rather than a ternary on `ACTOR_DID`'s key, because the ternary is what this was: a
 * two-way test on `hold_lift` that handed `supervised_read` the send's advice — *"cancel the send if you want
 * to stop it"* — to somebody who asked to read a mailbox. `ACTOR_DID` was a compile error when the third kind
 * arrived and this was not, which is the whole argument for the shape: a refusal's `fix` is the part a person
 * acts on (AGENTS.md principle 3), and advice about a different act is worse than none.
 */
export const ACTOR_FIX: Record<ApprovalSubjectKind, string> = {
  send_manifest: "cancel the send if you want to stop it, or ask another approver to decide",
  hold_lift: "two other people holding approval.decide on the held mailbox have to approve it",
  supervised_read: "two other people holding approval.decide on that mailbox have to approve it — "
    + "GET /api/approvals shows them the request, its scope and its deadline",
  ediscovery_export: "two other people holding approval.decide on that mailbox have to approve it — "
    + "GET /api/approvals shows them the predicate, its hash and the maximum number of messages it may "
    + "export. If the bound is wrong, they can deny it and a fresh request can be made",
  domain_pause: "two other administrators have to approve it — GET /api/approvals shows them the domain "
    + "and the reason you gave. If the domain is wrong, they can deny it and a fresh request can be made. "
    + "A pause already in force is lifted by any one administrator, alone: POST /api/domain-pauses/:id/lift",
};

/**
 * How long each kind of approval is good for, in seconds, or `null` for a kind with no deadline (#62).
 *
 * A `Record` keyed on the type, like `ACTOR_DID` above, so a third subject kind is a compile error here rather
 * than a row that silently inherits a deadline nothing compares.
 *
 * `send_manifest` gets the constant; `hold_lift` gets `null` and stores NULL. The asymmetry is not a gap: the
 * only code that reads `expires_at` is the recheck in `dispatchOne`, which dispatches sends. A deadline on a
 * lift would be a limit written into a column with no reader, and this repository's most-repeated defect is a
 * bound field nothing populates — its mirror image is a populated field nothing reads.
 */
const EXPIRES_AFTER_SECONDS: Record<ApprovalSubjectKind, number | null> = {
  send_manifest: BUDGETS["approval.send_expiry_seconds"],
  hold_lift: null,
  /*
   * `null`, and this one is the interesting case: a supervised read **does** have a deadline, and it is not
   * this column.
   *
   * `supervised_grants.expires_at` is written at request time and is the hard stop the read path compares on
   * every request. Putting a second deadline on the approval would be a second answer to "is this still good",
   * and the one that counts would be whichever code path the reader opened — the drift this module already
   * refuses for the completion predicate. So the grant's own deadline is the single terminal check, exactly as
   * #62 chose one enforcement point for a lapsed send rather than two.
   *
   * The residual, stated because it follows and is not hidden: an approval decided after the grant's deadline
   * passes produces a grant that is already over, and the read path denies from that instant. What stops that
   * being a surprise is that the deadline travels on `GET /api/approvals` with the request, so the person being
   * asked sees it before they answer.
   */
  supervised_read: null,
  /*
   * `null`, and the reasoning is the mirror image of the supervised read's rather than a copy of it.
   *
   * A supervised read has a deadline that is not this column; an export has **no deadline at all**, and that
   * is deliberate. What bounds an export is `exports.max_messages` — a count the two approvers agreed to,
   * checked on every page — and a wall-clock deadline beside it would be a second bound with no measurement
   * behind it: an export is explicitly resumable across instances (blueprint:1276), so how long one takes is
   * a function of the Node's plan and the size of the mailbox, not of anything an approver could size. A
   * deadline here would refuse a legitimate large export on a Free Node for reasons nobody chose.
   *
   * The residual, stated because it follows: an approved export can be run months later. What stops that
   * being a standing authority is that the run rechecks the live approval and the live
   * `ediscovery.export` relation **per page**, so revoking either terminates it mid-file — which is §7's
   * *"revocation terminates export jobs"*, enforced rather than asserted.
   */
  ediscovery_export: null,
  /*
   * `null`, and this one is the case where a deadline would be actively harmful rather than merely unread.
   *
   * A pause request is asked for because somebody believes a domain is sending mail it must not send. An
   * expiry would **discard that request** while the condition it was raised about is still true, and the
   * discard would be silent — the request simply stops being decidable, and the domain keeps sending. Every
   * other kind's null is "nothing reads this column for me"; this one is "a deadline here fails in the
   * dangerous direction".
   *
   * What bounds an undecided request instead is that it is visible: `GET /api/approvals` shows it to every
   * other administrator, and `doctor` reports a pause requested and never decided beside the pauses in force.
   */
  domain_pause: null,
};

/**
 * The deadline an approval of this kind requested now would carry, or null when the kind has none.
 *
 * Exported so the recheck's own tests and `docs/receipts/dispatch-recheck-cost.md` can state the same
 * arithmetic this module writes, rather than a second copy of `requested_at + constant` that could disagree
 * with it. The deadline is **stored**, not derived at read time, for the reason 0022 gives: changing the
 * constant must not move the deadline of a request somebody is already deciding.
 */
export function expiryFor(kind: ApprovalSubjectKind, requestedAtMillis: number): string | null {
  const seconds = EXPIRES_AFTER_SECONDS[kind];
  return seconds === null ? null : new Date(requestedAtMillis + seconds * 1000).toISOString();
}

/* ---- stages, and the arithmetic of a shortfall ----------------------------------------------- */

/**
 * One stage: how many distinct decisions it takes, and the one team those deciders must belong to, or none.
 *
 * The position in the array **is** the ordinal — a separate field would be a second representation of the same
 * fact, and the failure mode is two stages numbered 2.
 *
 * `teamId` was `absent` until #73 and this was `readonly number[]`. It is an object now rather than a second
 * parallel array of teams, for the reason the ordinal is not a field: two arrays that must stay the same
 * length is a correspondence nothing enforces, and the failure mode is a count that gets a team belonging to
 * the stage next to it.
 */
export interface Stage {
  count: number;
  /**
   * The team a decider must be in, or **null for no constraint: the whole eligible set**.
   *
   * Null is what every stage written before migration 0032 means, so absence is a defined answer rather than a
   * missing one. A team id naming nothing resolves to the **empty** set, which is the restrictive answer for
   * the unclassified input — see `eligibleFor`.
   */
  teamId: string | null;
}

/**
 * A stage set, in review order. `[{2}]` is parallel dual control, `[{1}, {1}]` is sequential, and
 * `[{1, finance}, {1, legal}]` is §18's separation of *duty* rather than only of eyes.
 */
export type Stages = readonly Stage[];

/** One stage, spelled once, so no caller has to remember that an unconstrained stage carries a null team. */
export function stageOf(count: number, teamId: string | null = null): Stage {
  return { count, teamId };
}

/**
 * What one stage set means when a policy version names none: one decision, by somebody other than the author.
 *
 * The minimum the words *"requires approval"* can mean, and it is also what every `require_approval` version
 * published before migration 0020 means — so absence is a defined answer rather than a missing one.
 */
export const IMPLICIT_STAGES: Stages = [stageOf(1)];

/**
 * The stage sets that carry **no** team constraint, for a caller with fixed stages of its own.
 *
 * `LIFT_STAGES`, `SUPERVISED_STAGES`, `EXPORT_STAGES` and `PAUSE_STAGES` are all of this shape: a decision
 * this Node took rather than one a policy expresses, and none of them narrows to a team. Exported as a
 * constant so those four modules pass an empty roster map by name rather than each writing `new Map()`, which
 * would read as an omission rather than as a statement that there is nothing to resolve.
 */
export const NO_TEAM_ROSTERS: ReadonlyMap<string, TeamRoster> = new Map();

/** Every team a stage set names, de-duplicated. What `rostersOf` has to be asked for, and nothing more. */
export function teamsNamedBy(stages: Stages): string[] {
  return [...new Set(stages.map((stage) => stage.teamId).filter((id): id is string => id !== null))];
}

export interface Shortfall {
  /** The first stage that cannot be filled, 1-based. */
  ordinal: number;
  /** How many distinct decisions that stage asks for. */
  required: number;
  /** How many eligible people that stage could actually get, once the earlier stages have taken theirs. */
  available: number;
  /** `required - available`. Always at least 1 when this object exists. */
  short: number;
  /** Distinct eligible people in total, and what the whole chain would need. For the message. */
  eligible: number;
  needed: number;
  /**
   * The team the failing stage required, and its name, or null when it required none (#73).
   *
   * Carried on the shortfall rather than looked up by whoever renders it, because the sentence a person reads
   * is *"stage 2 needs 1 member of team Legal"* and a message that could only say `tm_01J…` sends them to a
   * second screen to find out what is short. The name comes free with the members — see `rostersOf`.
   */
  team: { id: string; name: string | null } | null;
}

const NOBODY: ReadonlySet<string> = new Set<string>();

/**
 * The people who could take one stage: the eligible set, narrowed by the stage's team if it names one.
 *
 * **Strictly narrowing, and that is load-bearing rather than incidental.** An intersection can only ever
 * reduce the set, so #61's may-narrow-never-widen rule survives whole: naming a team can make a stage harder
 * to fill and can never make somebody eligible who holds no relation. If a path ever appeared where naming a
 * team let somebody decide who could not before, it would not be this feature.
 *
 * A team the roster map has never heard of contributes `NOBODY`, so an unknown team is the **restrictive**
 * answer rather than the permissive one. That is the direction chosen deliberately: publication refuses a
 * stage naming a team that does not exist outright (`E_NO_SUCH_TEAM`), so reaching this with an unknown id
 * means a team disappeared under a live policy — which cannot happen, because nothing deletes a team — or a
 * caller forgot to resolve the rosters. Either way, "nobody is eligible" is the answer that fails closed.
 */
function eligibleFor(
  stage: Stage,
  eligible: ReadonlySet<string>,
  rosters: ReadonlyMap<string, TeamRoster>,
): ReadonlySet<string> {
  if (stage.teamId === null) return eligible;
  const members = rosters.get(stage.teamId)?.members ?? NOBODY;
  return new Set([...eligible].filter((userId) => members.has(userId)));
}

/**
 * Can this stage set be satisfied, and if not, where does it fail?
 *
 * ## Why this is a matching rather than the subtraction it used to be
 *
 * It was `available = eligible - taken`, which is exact while every stage draws from **one** set. A
 * team-scoped stage draws from a different set, and then the question stops being arithmetic: stage 1 taking
 * two people from Finance may or may not leave stage 2 a member of Legal, depending on who is in both.
 * Greedily assigning stage 1 first would blame stage 2 for stage 1's choice — an administrator told to grant
 * `approval.decide` to another lawyer when the real answer was that one person was double-counted.
 *
 * So each stage's demand is satisfied by **augmenting paths** (Kuhn's), which lets a later stage displace an
 * earlier one's assignment as long as that earlier one can be filled another way. The first stage that cannot
 * be saturated even after re-assignment is the first stage whose *prefix* is genuinely infeasible, and prefix
 * infeasibility is monotone — so it is also the honest place to put the blame.
 *
 * **With no teams anywhere this reduces exactly to the old subtraction**, because every supply is the same set
 * and no re-assignment can help: `test/approvals.test.ts` still walks the same table of cases it always did.
 *
 * Nobody decides twice in one approval (`apd_one_per_person`), which is why a person is a unit of capacity
 * here rather than a source of one decision per stage.
 *
 * Pure, and exhaustively testable: this is the whole of the satisfiability rule, and both checks —
 * publication and evaluation — go through it rather than each computing it.
 */
export function shortfallFor(
  stages: Stages,
  eligible: ReadonlySet<string>,
  rosters: ReadonlyMap<string, TeamRoster> = NO_TEAM_ROSTERS,
): Shortfall | null {
  const needed = stages.reduce((total, stage) => total + stage.count, 0);
  const supply = stages.map((stage) => eligibleFor(stage, eligible, rosters));
  const union = new Set<string>();
  for (const people of supply) for (const person of people) union.add(person);

  /** Which stage currently holds each person. One person, one slot — that is the distinctness rule. */
  const heldBy = new Map<string, number>();
  const take = (index: number, visited: Set<string>): boolean => {
    for (const person of supply[index] ?? NOBODY) {
      if (visited.has(person)) continue;
      visited.add(person);
      const holder = heldBy.get(person);
      // Free, or its current holder can find somebody else. The recursion is what stops an earlier stage's
      // arbitrary choice being reported as a later stage's shortage.
      if (holder === undefined || take(holder, visited)) {
        heldBy.set(person, index);
        return true;
      }
    }
    return false;
  };

  for (const [index, stage] of stages.entries()) {
    for (let filled = 0; filled < stage.count; filled += 1) {
      if (take(index, new Set<string>())) continue;
      const roster = stage.teamId === null ? null : rosters.get(stage.teamId);
      return {
        ordinal: index + 1,
        required: stage.count,
        available: filled,
        short: stage.count - filled,
        eligible: union.size,
        needed,
        team: stage.teamId === null ? null : { id: stage.teamId, name: roster?.name ?? null },
      };
    }
  }
  return null;
}

/**
 * The shortfall as a sentence, so publication, the seal and the audit detail all say it the same way.
 *
 * `scope` names **which relation on which object** was short, because #66's fifth subject kind reads a
 * different one: a send, a lift, a supervised read and an export are short of `approval.decide` holders on a
 * mailbox, and a domain pause is short of `org.admin` holders on the organization. Defaulted to the mailbox
 * form so the four existing callers say exactly what they said before — and taken as a parameter rather than
 * inferred from the id's prefix, because a sentence about authority decided by a string prefix is the kind of
 * claim that goes quietly wrong the first time an id space changes.
 *
 * A team-scoped stage adds one clause and never rewrites the sentence (#73), because the two facts are
 * independent: the relation is what somebody has to *hold*, and the team is who they have to *be*. A reader
 * who has seen this sentence before meets one extra clause rather than a different message.
 */
export function describeShortfall(
  shortfall: Shortfall,
  scopeId: string,
  scope: ApprovalScope = "mailbox",
): string {
  const holding = scope === "mailbox"
    ? `approval.decide on mailbox ${scopeId}`
    : `org.admin on organization ${scopeId}`;
  const inTeam = shortfall.team === null
    ? ""
    : ` and in team ${shortfall.team.name === null ? shortfall.team.id : `${shortfall.team.name} `
      + `(${shortfall.team.id})`}`;
  return `stage ${shortfall.ordinal} needs ${shortfall.required} distinct approver(s) holding `
    + `${holding}${inTeam}, and ${shortfall.available} remain after the earlier stages `
    + `take theirs — ${shortfall.short} short. The stages need ${shortfall.needed} distinct people in total; `
    + `${shortfall.eligible} are eligible.`;
}

/**
 * The stage set of one approval, in ordinal order.
 *
 * Ordered by the column rather than trusted to arrive in order, and read from the approval's own frozen copy
 * rather than from the policy: publishing a new version must not change what an approver already deciding was
 * asked for, which is the same reason #60 refused to re-evaluate in-flight sends on publication.
 *
 * `team_id` is part of that frozen copy for exactly the same reason the count is. What is **not** frozen is
 * who is in the team: membership is re-read at every decision, because §7 makes authority live and a team
 * somebody left must stop letting them decide on the next request rather than on the next send.
 */
export async function stagesOfApproval(env: Env, approvalId: string): Promise<Stage[]> {
  const { results } = await env.CATALOG.prepare(
    "SELECT required_count, team_id FROM approval_stages WHERE approval_id = ? ORDER BY ordinal",
  ).bind(approvalId).all<{ required_count: number; team_id: string | null }>();
  return results.map((row) => stageOf(row.required_count, row.team_id));
}

/* ---- who may decide -------------------------------------------------------------------------- */

/*
 * `decidersByMailbox` and `decidersOf` live in `src/deciders.ts`.
 *
 * They moved there rather than being re-exported from here, so there is one import path and not two. That
 * file's header carries the reason: `doctor` now asks the same question for `legal_hold_unliftable`, and its
 * cost meter's honesty guard pins a property over every file `doctor.ts` imports that this module cannot
 * satisfy — it prepares statements it binds to names, in functions `runDoctor` never calls.
 */
/* ---- requesting ------------------------------------------------------------------------------ */

export interface ApprovalRequestFacts {
  subjectKind: ApprovalSubjectKind;
  /** The row being decided on: a manifest id for a send, a `hold_lifts` id for a lift. */
  subjectId: string;
  /**
   * The object whose relation-holders are eligible: a mailbox for the four mailbox-scoped kinds, the
   * organization for a domain pause. `SCOPE_OF` says which, per kind.
   */
  scopeId: string;
  /** The person whose act this gates, and therefore the one person excluded from deciding it. */
  actorUserId: string;
  /**
   * How many distinct decisions, per stage, in order.
   *
   * For a send: the fold over every matching `require_approval` version — see `requiredStages` in
   * `src/policy.ts`. For a lift: `LIFT_STAGES`, which is #64's decision rather than a policy's.
   */
  stages: Stages;
  /** Extra fields for the `approval.requested` detail — a lift's reason is the first. */
  detail?: Record<string, unknown>;
}

export interface ApprovalPlan {
  approvalId: string;
  stages: Stages;
  /** Distinct people who could decide, the author already removed. */
  eligible: number;
  /** The rows to place in the caller's transaction, and the entry that records the request. */
  statements: D1PreparedStatement[];
  event: AuditEvent;
}

export type ApprovalPlanned =
  | { satisfiable: true; plan: ApprovalPlan }
  | { satisfiable: false; shortfall: Shortfall; eligible: number };

/**
 * Plans the approval a gated seal needs, or reports why it cannot be satisfied.
 *
 * Returns **statements rather than writing them**, because the approval and the manifest are one act: a gated
 * manifest with no request to decide would be a send waiting on something nobody can clear, which is precisely
 * the state #60 refused to let `deny` occupy. `sealManifest` places these in its own `batch()`, and
 * `auditedBatchMany` carries both audit entries in the same transaction.
 *
 * The actor is removed here rather than by the caller, because *"minus the person whose act this is"* is a rule
 * about approvals and not about sealing: §18 requires separation-of-duty policies to prevent self-approval, and
 * a caller that had to remember to subtract would be a caller that could forget. The lift gets that rule by
 * calling this rather than by restating it.
 *
 * ## The optional gate, and which caller needs it
 *
 * A send's subject is a manifest minted a moment ago in the same transaction, so its rows are unconditional.
 * A lift's subject is a **hold**, which somebody else may have lifted between this caller's read and its write
 * — so `requestHoldLift` passes a gate, and every statement built here becomes
 * `INSERT ... SELECT ... WHERE EXISTS (<gate>)`. That is the same compare-and-swap the rest of this module
 * runs on (#9, the conflict is the signal); without it the eligible-set read and the "no lift is pending yet"
 * read would be a check somebody could race past, and the loser would open a second question about one hold.
 */
export function planApproval(
  env: Env,
  ctx: Ctx,
  orgId: string,
  facts: ApprovalRequestFacts,
  deciders: ReadonlySet<string>,
  /**
   * The rosters of every team this stage set names (#73), resolved by the caller because it is I/O.
   *
   * `NO_TEAM_ROSTERS` for the four subject kinds whose stages are this Node's own decision rather than a
   * policy's — a lift, a supervised read, an export and a domain pause all carry `teamId: null` — and it is
   * passed **by name** rather than defaulted, so a fifth caller has to say what it means rather than inherit
   * an answer. An empty map with a team-naming stage is the restrictive answer, not the permissive one, which
   * is what makes getting this wrong loud instead of silent.
   */
  rosters: ReadonlyMap<string, TeamRoster>,
  gate?: AuditGate,
): ApprovalPlanned {
  const asked = [...deciders].filter((userId) => userId !== facts.actorUserId);
  const eligible = asked.length;
  const shortfall = shortfallFor(facts.stages, new Set(asked), rosters);
  if (shortfall !== null) return { satisfiable: false, shortfall, eligible };

  const approvalId = ctx.id("apr");
  const at = new Date(ctx.now()).toISOString();

  /**
   * One insert, gated or not, with the placeholders counted from the values so the two forms cannot drift.
   *
   * The `INSERT INTO <table>` head is passed in **written out** rather than assembled from a table name,
   * because `test/node/content-deletion-world.test.ts` scans this source for literal table names and states
   * that dynamically built SQL is its blind spot. A table name in a template hole would have made the one
   * `INSERT INTO approvals` in this product invisible to the test that requires there to be exactly one.
   */
  const gated = (head: string, values: unknown[]): D1PreparedStatement => {
    const holes = values.map(() => "?").join(",");
    return gate === undefined
      ? env.CATALOG.prepare(`${head} VALUES (${holes})`).bind(...values)
      : env.CATALOG.prepare(`${head} SELECT ${holes} WHERE EXISTS (${gate.sql})`)
        .bind(...values, ...gate.params);
  };

  const statements = [
    gated(
      `INSERT INTO approvals
         (id, org_id, subject_kind, subject_id, scope_id, actor_user_id, state, requested_at, resolved_at,
          expires_at)`,
      [approvalId, orgId, facts.subjectKind, facts.subjectId, facts.scopeId, facts.actorUserId,
        "pending", at, null,
        // Derived from `at` rather than from a second `ctx.now()`, so the deadline is exactly
        // `requested_at` plus the constant. A Worker's clock advances across I/O and `ctx.now()` is not
        // required to be stable, so two calls would put the deadline a few milliseconds off the request it
        // belongs to — the same defect `submitPerRecipient` records for `submission_state_at`, where it
        // silently counted a three-recipient send as one.
        expiryFor(facts.subjectKind, Date.parse(at))],
    ),
    // The stage set, frozen with its team constraints. `team_id` is written explicitly rather than left to
    // the column's NULL default, for 0021's reason about `subject_kind`: a writer that omits a column is a
    // writer whose meaning comes from the schema rather than from the act, and "unconstrained" is a decision
    // this stage set made rather than a value nobody supplied.
    ...facts.stages.map((stage, index) => gated(
      "INSERT INTO approval_stages (id, org_id, approval_id, ordinal, required_count, team_id)",
      [ctx.id("ast"), orgId, approvalId, index + 1, stage.count, stage.teamId],
    )),
    /*
     * #61's notification, wired into #63 part B's mechanism rather than invented beside it (#61's resolution
     * deferred it here explicitly, and asked for a row in the same table with `due_at` now, delivered by the
     * same scan).
     *
     * In this batch, so an approval that exists and nobody was told about is not representable — the same
     * property the §7 notice gets one function over, from the same table. One row per person **asked**, which
     * is `deciders` minus the actor: §18's separation of duty is applied once, here, so a notice can no more
     * reach the person whose act this gates than a decision can.
     *
     * The set is frozen rather than resolved at read time, and that is the difference from the §7 notice: who
     * *was asked* is a fact about an instant, and it is the same fact `approval.requested`'s `eligible` count
     * exists to record. Eligibility is live, so re-deriving it later would silently re-address a request that
     * had already been answered.
     */
    // The notice's `mailbox_id` is the **mailbox** this is about, or NULL when the subject is not about one.
    // An organization id in a column named mailbox_id would be read by `notificationsFor`'s second addressing
    // mode as a mailbox nobody holds anything on, which is a join that quietly returns nothing — and these
    // rows are addressed to a named person anyway, so the column is context rather than the address.
    ...noticesForApprovalRequest(
      env, ctx, orgId, approvalId,
      SCOPE_OF[facts.subjectKind] === "mailbox" ? facts.scopeId : null,
      asked, at, gate,
    ),
  ];

  return {
    satisfiable: true,
    plan: {
      approvalId,
      stages: facts.stages,
      eligible,
      statements,
      event: {
        action: "approval.requested",
        outcome: "ok",
        // The Node asked, not the actor: for a send a policy required it, and for a lift the request and the
        // asking are one act by one person, recorded below rather than as the entry's actor. `actorKind`
        // follows from a null actor.
        actorUserId: null,
        subject: approvalId,
        detail: {
          subjectKind: facts.subjectKind,
          subjectId: facts.subjectId,
          scope: SCOPE_OF[facts.subjectKind],
          scopeId: facts.scopeId,
          actorUserId: facts.actorUserId,
          stages: [...facts.stages],
          // How many people could have been asked, at the moment of asking. Recorded because the eligible set
          // is live — it is not reconstructable from the trail later, and "who could have decided this" is a
          // question an investigation asks about a decision that took a suspiciously long time to arrive.
          eligible,
          ...facts.detail,
        },
      },
    },
  };
}

/* ---- reading an approval --------------------------------------------------------------------- */
