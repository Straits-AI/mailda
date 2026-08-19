import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { isAdmin } from "./access.ts";
import { CallerError, conflict, notFound, unprocessable } from "./errors.ts";

/**
 * The policy object: five conditions, four totally-ordered outcomes, and a draft/publish lifecycle (#60,
 * §18, Layer 5).
 *
 * ## Five conditions, and everything else named absent
 *
 * §18 lists thirteen policy dimensions. Five ship, and they are exactly the ones answerable from a column
 * that exists or from one derivation over storage that exists:
 *
 * | Condition | Answered from |
 * |:--|:--|
 * | `mailbox` | `send_manifests.mailbox_id` |
 * | `actor` | `send_manifests.author_user_id` |
 * | `recipient_external` | the recipient's domain is not among the domains in `addresses` |
 * | `is_reply` | `in_reply_to_message_id IS NOT NULL` |
 * | `org_daily_volume` | `send_counters.handed_over`, which is org-wide and daily |
 *
 * **Named absent with the reason rather than stubbed:** data class, contact trust, DLP, device, geography,
 * velocity, budget, reputation, Butler autonomy, LLM profile, attachment/link state, delegator — and
 * **per-mailbox, per-user, per-Butler and per-domain volume**, because `send_counters` is
 * `(org_id, day, handed_over, first_throttled_at, throttled_at_count)` and nothing finer exists.
 *
 * The principle, which is the whole reason the list above is a list rather than a stub: **a condition backed
 * by no data is a policy that silently never fires**, which is worse than a policy that does not exist,
 * because it reads as governance. Widening the counters is #66's subject — an aggregate over time is a
 * circuit breaker, and the write-contention question belongs in that ticket.
 *
 * ## `recipient_external` is exact, and it is exact for a platform reason
 *
 * There is no domains table. But **Email Routing only accepts addresses on domains in the customer's own
 * Cloudflare account**, so every domain appearing in `addresses` is a domain the customer controls, and the
 * internal set can be derived from those domains with no new storage. That is a correctness argument resting
 * on a property of Cloudflare rather than on this schema, which is why it is a `stale_when` clause in
 * `docs/receipts/policy-evaluation-cost.md` and not only a comment here.
 *
 * ## Four outcomes, totally ordered, so conflict resolution is one comparison
 *
 *     allow  <  hold  <  require_approval  <  deny
 *     outcome = max(every matching policy)
 *
 * No priority field. A priority lets a narrow `allow` beat a broad `deny`, which is precisely how a policy
 * system fails open, and it makes *"why was this allowed"* unanswerable from one row.
 *
 * The order between `hold` and `require_approval` **follows from who may clear it**: any `send.propose`
 * holder releases a hold, only an `approval.decide` holder approves. So a hold is the *less* restrictive
 * gate. That is not the intuitive reading and it is the correct one, which is why it is written down beside
 * the ranks rather than left to be inferred from them.
 *
 * ## Where this runs, and the seam #62 owns
 *
 * Evaluation happens at **seal** (`sealManifest`), because the outcome determines the state and the state
 * has to exist when the manifest does. §18 places the policy decision between authorization and the effect
 * intent, which is exactly where sealing sits.
 *
 * Re-evaluation happens at **dispatch**, and it is **not built here**. An in-flight send *binds* the version
 * it was evaluated under — the record — while the *decision* at dispatch uses the **current** policy, which
 * is what honours §18's "stricter policy fails closed". Stricter is computable rather than a judgement
 * because the outcomes are totally ordered: `max(current) > max(bound)`. That comparison belongs to
 * [#62's recheck](https://github.com/Straits-AI/mailda/issues/62), inside `dispatchOne`, beside ADR 39's
 * existing authority re-check. `evaluate()` below is the whole of what that recheck needs; nothing here
 * should be duplicated there.
 */

/* ---- the total order ------------------------------------------------------------------------- */

export const OUTCOMES = ["allow", "hold", "require_approval", "deny"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * The rank, which is the entire conflict-resolution mechanism.
 *
 * Declared as one map and consumed by one comparison. The alternative — a precedence table with a row per
 * pair — is sixteen rows for four outcomes and has a wrong cell nobody notices; this has four numbers and
 * `test/policy.test.ts` walks all sixteen ordered pairs against them.
 */
const RANK: Record<Outcome, number> = { allow: 0, hold: 1, require_approval: 2, deny: 3 };

/** The stricter of two outcomes. One comparison, and `max` over a list is a fold of it. */
export function stricter(a: Outcome, b: Outcome): Outcome {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Is `current` strictly stricter than `bound`? #62's `policy_stricter` predicate, defined where the order is. */
export function isStricter(current: Outcome, bound: Outcome): boolean {
  return RANK[current] > RANK[bound];
}

function isOutcome(value: string): value is Outcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

/* ---- the state a send lands in --------------------------------------------------------------- */

/**
 * The outcome-to-state mapping, and the argument for the one line of it that #60's resolution left loose.
 *
 * `allow` → `held`, `hold` and `require_approval` → `awaiting` with distinct reasons, `deny` → `withheld`.
 *
 * #60's resolution says *"held if `allow`, `awaiting` otherwise"* in one sentence and names only `hold` and
 * `require_approval` as `awaiting` in another. **The loose sentence is the one to distrust.** A denied send
 * sitting in `awaiting` is a send **nobody can ever clear**: there is no act that resolves a denial — a hold
 * is released, an approval is decided, but a deny has no counterpart — so denied sends would accumulate
 * forever in a state that reads as pending. `withheld` already means exactly the right thing (*"this Node
 * declined to hand it over; nobody cancelled it and the mail service was never asked"*), #62 splits on it and
 * #66 splits on it, and `send.withheld` is already in `AUDIT_ACTIONS`.
 *
 * The reasons are machine tokens, not prose. #62 established that gates are `awaiting` plus a reason and
 * refusals are `withheld` plus a reason, so distinctness lives in the reason column rather than in five new
 * states — two conventions in one state machine is what later reads as an accident.
 */
export const STATE_FOR: Record<Outcome, { state: "held" | "awaiting" | "withheld"; reason: string | null }> = {
  allow: { state: "held", reason: null },
  hold: { state: "awaiting", reason: "policy_hold" },
  require_approval: { state: "awaiting", reason: "policy_approval_required" },
  deny: { state: "withheld", reason: "policy_denied" },
};

/**
 * The reasons #60 writes. The **words** for them live in `src/client/delivery.client.js`, not here.
 *
 * That placement is not an accident and not laziness. `delivery.client.js` already owns every send-state
 * sentence, for the reason stated in its own header: the rule deciding what a reader is shown belongs
 * somewhere a test can reach, and the outbox's last honesty defect lived in the one module with no coverage.
 * Repeating the sentences here would create a second definition of the same claim, and the one that reads as
 * authoritative would be whichever file the reader opened. So this module owns the **token** — which is what
 * #62's vocabulary is built from — and one module owns the prose.
 *
 * **Derived from `STATE_FOR` rather than written out**, because a second literal list of the same three
 * tokens is the correspondence problem this split exists to avoid, one level down: the mapping is what
 * actually writes a reason into `send_manifests.state_reason`, so anything else claiming to be the list of
 * reasons has to be computed from it or it is a claim nothing keeps true. `test/policy.test.ts` reads this
 * against the exact bytes `ui.ts` serves, which is what makes "one module owns the prose" an enforced
 * statement rather than a note about where the sentences happen to live today.
 */
export const POLICY_REASONS: readonly string[] =
  Object.values(STATE_FOR).map((mapped) => mapped.reason).filter((reason): reason is string => reason !== null);

/* ---- conditions ----------------------------------------------------------------------------- */

/**
 * A policy's conditions. `undefined`/absent means unconstrained, which is stored as NULL.
 *
 * Five fields, closed. A sixth would be a type error at the moment somebody tries to express it, which is
 * the property the five-column schema exists to give — a JSON bag would have accepted `dataClass` and
 * published a rule that never fires.
 */
export interface PolicyConditions {
  mailboxId?: string | null;
  actorUserId?: string | null;
  recipientExternal?: boolean | null;
  isReply?: boolean | null;
  /** Matches when today's org-wide `handed_over` is at or above this. */
  orgDailyVolumeMin?: number | null;
}

/** What a send is, as far as the five conditions are concerned. Supplied by the caller at seal. */
export interface SendFacts {
  mailboxId: string;
  actorUserId: string;
  /** Every envelope recipient, To plus Cc plus Bcc, already normalized. */
  recipients: readonly string[];
  isReply: boolean;
}

export interface MatchedPolicy {
  policyId: string;
  policyName: string;
  versionId: string;
  version: number;
  outcome: Outcome;
}

export interface PolicyDecision {
  /** `max` over every match. `allow` when nothing matched, which is why no policies means no gate. */
  outcome: Outcome;
  matched: MatchedPolicy[];
  /** Which derived inputs this evaluation had to fetch. The cost story, readable rather than inferred. */
  fetched: { domains: boolean; dailyVolume: boolean };
}

interface VersionRow {
  id: string;
  policy_id: string;
  name: string;
  version: number;
  outcome: string;
  when_mailbox_id: string | null;
  when_actor_user_id: string | null;
  when_recipient_external: number | null;
  when_is_reply: number | null;
  when_org_daily_volume_min: number | null;
}

/**
 * The domain part of an address, lowercased.
 *
 * Everything after the **last** `@`, which is what a mail server does: `"a@b"@example.net` is a legal local
 * part, and splitting on the first `@` would call the domain `b"@example.net`. Addresses reaching here have
 * been through `normalizeAddress`, so this is a parse of a validated value rather than a guard.
 */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).trim().toLowerCase();
}

/**
 * Evaluates the current policy against one send.
 *
 * ## Why the published rows are read before the conditions are tested
 *
 * Every condition is a column, so the whole predicate could be SQL. It deliberately is not, and the reason
 * is cost. Two of the five conditions are *derived* — `recipient_external` needs the organization's domain
 * set, `org_daily_volume` needs today's counter — so a pushed-down predicate would have to bind both inputs
 * on every evaluation, spending two queries whether or not any live policy asks for them. Reading the
 * candidate rows first lets each derived input be fetched **only when some published policy constrains it**,
 * which is the difference between one query and three per seal (receipt: `policy-evaluation-cost.md`,
 * measured, not counted).
 *
 * The rows have to be read anyway: the decision must name *which* policy matched, so the audit trail can
 * answer "which rule applied".
 *
 * The cost this accepts, stated rather than glossed: every published policy in the organization is read on
 * every seal. That is bounded by what a human writes, and it is the figure the receipt says to watch.
 *
 * ## Drafts are not consulted, and that is a property of the index rather than a filter
 *
 * `pv_live` is partial on `state = 'published'`, so a draft is not merely skipped — it is not in the index
 * the query reads. Publication being the versioning event means an unpublished edit must have no effect
 * whatsoever, and `test/policy.test.ts` proves a draft whose conditions match a send changes nothing.
 */
export async function evaluate(env: Env, ctx: Ctx, orgId: string, facts: SendFacts): Promise<PolicyDecision> {
  const { results } = await env.CATALOG.prepare(
    `SELECT v.id, v.policy_id, p.name, v.version, v.outcome,
            v.when_mailbox_id, v.when_actor_user_id, v.when_recipient_external, v.when_is_reply,
            v.when_org_daily_volume_min
       FROM policy_versions v
       JOIN policies p ON p.id = v.policy_id AND p.org_id = v.org_id
      WHERE v.org_id = ? AND v.state = 'published'
      ORDER BY v.published_at, v.id`,
  ).bind(orgId).all<VersionRow>();

  const live = results;
  const needsDomains = live.some((row) => row.when_recipient_external !== null);
  const needsVolume = live.some((row) => row.when_org_daily_volume_min !== null);

  // The two derived inputs, fetched only when something asks. `false`/`0` are the honest defaults for the
  // unasked case because they are never read: a policy that does not constrain a condition never compares it.
  const recipientExternal = needsDomains
    ? await anyRecipientExternal(env, orgId, facts.recipients)
    : false;
  const dailyVolume = needsVolume ? await orgDailyVolume(env, ctx, orgId) : 0;

  const matched: MatchedPolicy[] = [];
  let outcome: Outcome = "allow";

  for (const row of live) {
    if (row.when_mailbox_id !== null && row.when_mailbox_id !== facts.mailboxId) continue;
    if (row.when_actor_user_id !== null && row.when_actor_user_id !== facts.actorUserId) continue;
    if (row.when_recipient_external !== null && (row.when_recipient_external === 1) !== recipientExternal) continue;
    if (row.when_is_reply !== null && (row.when_is_reply === 1) !== facts.isReply) continue;
    if (row.when_org_daily_volume_min !== null && dailyVolume < row.when_org_daily_volume_min) continue;

    // A stored outcome outside the four is a schema violation, not an input to tolerate. Skipping it would
    // silently weaken the decision — the failure direction #60's rejection of a priority field is about — so
    // it raises. There is no CHECK constraint on the column, so this is the enforcement.
    if (!isOutcome(row.outcome)) {
      throw new CallerError("E_POLICY_OUTCOME_UNKNOWN", 500, {
        what: `policy version ${row.id} carries outcome ${JSON.stringify(row.outcome)}`,
        why: "the four outcomes are totally ordered and an unknown fifth cannot be ranked, so no decision "
          + "about this send would be trustworthy",
        fix: `correct or unpublish policy ${row.policy_id}; the outcomes are ${OUTCOMES.join(", ")}`,
      });
    }

    matched.push({
      policyId: row.policy_id,
      policyName: row.name,
      versionId: row.id,
      version: row.version,
      outcome: row.outcome,
    });
    outcome = stricter(outcome, row.outcome);
  }

  return { outcome, matched, fetched: { domains: needsDomains, dailyVolume: needsVolume } };
}

/**
 * Is **any** recipient outside the organization's own domains?
 *
 * Any rather than all, deliberately: a send to one colleague and one stranger is a send that leaves the
 * organization, and treating it as internal because most of it is would be the permissive direction. The
 * condition is on the manifest, and the manifest is one envelope.
 *
 * A send with no recipients is not external. It also cannot be sealed — `HeaderBlock` refuses an empty To —
 * so this is a total function rather than a reachable case.
 */
async function anyRecipientExternal(
  env: Env,
  orgId: string,
  recipients: readonly string[],
): Promise<boolean> {
  const { results } = await env.CATALOG.prepare(
    "SELECT DISTINCT address FROM addresses WHERE org_id = ?",
  ).bind(orgId).all<{ address: string }>();

  const internal = new Set(results.map((row) => domainOf(row.address)));
  return recipients.some((address) => !internal.has(domainOf(address)));
}

/** Today's org-wide hand-over count. The one counter that exists, read the way `dailySendState` reads it. */
async function orgDailyVolume(env: Env, ctx: Ctx, orgId: string): Promise<number> {
  const day = new Date(ctx.now()).toISOString().slice(0, 10);
  const row = await env.CATALOG.prepare(
    "SELECT handed_over FROM send_counters WHERE org_id = ? AND day = ?",
  ).bind(orgId, day).first<{ handed_over: number }>();
  return row?.handed_over ?? 0;
}

/* ---- the draft and publish lifecycle -------------------------------------------------------- */

/**
 * The canonical serialization the no-op-publish refusal compares.
 *
 * Field order is fixed and explicit rather than derived from object iteration, for the reason `audit.ts`'s
 * `canonical` gives: a hash whose input depends on property order changes when somebody reorders an
 * interface, and a check that breaks on a refactor teaches everyone to ignore it. Same discipline ADR 35
 * already applies to the send manifest, reused rather than re-derived (#49).
 *
 * `null` and absent serialize identically, because they mean the same thing — unconstrained — and a publish
 * that changed `undefined` to `null` changing nothing must therefore be refused.
 */
export function canonicalConditions(outcome: Outcome, conditions: PolicyConditions): string {
  const bit = (value: boolean | null | undefined): string =>
    value === null || value === undefined ? "" : value ? "1" : "0";
  const text = (value: string | null | undefined): string => value ?? "";
  const num = (value: number | null | undefined): string =>
    value === null || value === undefined ? "" : String(value);
  return [
    outcome,
    text(conditions.mailboxId),
    text(conditions.actorUserId),
    bit(conditions.recipientExternal),
    bit(conditions.isReply),
    num(conditions.orgDailyVolumeMin),
  ].join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface DraftRecord {
  policyId: string;
  versionId: string;
  outcome: Outcome;
  conditions: PolicyConditions;
}

function requireAdminOrThrow(actorUserId: string): CallerError {
  return new CallerError("E_NOT_AN_ADMINISTRATOR", 403, {
    what: `${actorUserId} is not an administrator of this organization`,
    why: "a policy decides whether other people's mail may leave, so writing one takes the same authority "
      + "as granting access (#39)",
    fix: "ask somebody who holds org.admin",
  });
}

function validate(outcome: string, conditions: PolicyConditions): Outcome {
  if (!isOutcome(outcome)) {
    throw unprocessable("E_BAD_POLICY_OUTCOME", {
      what: `${JSON.stringify(outcome)} is not a policy outcome`,
      why: "the four outcomes are totally ordered and conflict resolution is a maximum over them, so a "
        + "fifth could not be ranked",
      fix: `use one of: ${OUTCOMES.join(", ")}`,
    });
  }
  const floor = conditions.orgDailyVolumeMin;
  if (floor !== null && floor !== undefined && (!Number.isInteger(floor) || floor < 1)) {
    // Zero is refused rather than accepted as "always": a volume floor of 0 matches every send from the
    // first one of the day, which is not a volume condition at all — it is an unconditional policy written
    // in a way that reads as conditional. Omit the field for that.
    throw unprocessable("E_BAD_POLICY_VOLUME", {
      what: `${floor} is not a usable daily-volume floor`,
      why: "a floor of 0 or below matches every send, so it is an unconditional policy dressed as a "
        + "conditional one",
      fix: "use a whole number of sends at or above 1, or omit the condition entirely",
    });
  }
  return outcome;
}

/**
 * Creates a policy with its first draft. Nothing is in force until it is published.
 *
 * Two rows in one transaction with the audit entry: a policy with no draft is a name nothing can act on,
 * and a draft with no policy has nowhere to hang.
 */
export async function createPolicyDraft(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  input: { name: string; outcome: string; conditions?: PolicyConditions },
): Promise<DraftRecord> {
  if (!(await isAdmin(env, orgId, actorUserId))) throw requireAdminOrThrow(actorUserId);

  const conditions = input.conditions ?? {};
  const outcome = validate(input.outcome, conditions);
  const name = input.name.trim();
  if (name.length === 0) {
    throw unprocessable("E_POLICY_NEEDS_A_NAME", {
      what: "a policy was submitted with no name",
      why: "the name is what an administrator reads when a send is gated, and 'policy pol_01J…' answers "
        + "nothing",
      fix: "give the policy a short name saying what it governs",
    });
  }

  // Checked here for the message, enforced by `pol_name` in the schema. Two concurrent creations of the same
  // name lose at the UNIQUE index rather than here, and that surfaces as a constraint violation rather than
  // this refusal — worse wording, correct outcome, and the outcome is the part that must not be left to a
  // check-then-act window.
  const existing = await env.CATALOG.prepare(
    "SELECT id FROM policies WHERE org_id = ? AND name = ? LIMIT 1",
  ).bind(orgId, name).first<{ id: string }>();
  if (existing !== null) {
    throw conflict("E_POLICY_NAME_TAKEN", {
      what: `a policy called ${JSON.stringify(name)} already exists`,
      why: "two rules under one name is either a duplicate somebody forgot or an edit meant for the first",
      fix: `edit ${existing.id}, or choose a different name`,
    });
  }

  const policyId = ctx.id("pol");
  const versionId = ctx.id("plv");
  const at = new Date(ctx.now()).toISOString();
  const hash = await sha256Hex(canonicalConditions(outcome, conditions));

  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "policy.drafted", outcome: "ok", actorUserId, subject: policyId,
      detail: { name, policyOutcome: outcome, versionId },
    },
    (entry) => [
      env.CATALOG.prepare(
        "INSERT INTO policies (id, org_id, name, created_by, created_at) VALUES (?,?,?,?,?)",
      ).bind(policyId, orgId, name, actorUserId, at),
      draftInsert(env, orgId, policyId, versionId, outcome, conditions, hash, actorUserId, at),
      entry,
    ],
  );

  return { policyId, versionId, outcome, conditions };
}

function draftInsert(
  env: Env,
  orgId: string,
  policyId: string,
  versionId: string,
  outcome: Outcome,
  conditions: PolicyConditions,
  hash: string,
  actorUserId: string,
  at: string,
): D1PreparedStatement {
  const bit = (value: boolean | null | undefined): number | null =>
    value === null || value === undefined ? null : value ? 1 : 0;
  return env.CATALOG.prepare(
    `INSERT INTO policy_versions
       (id, org_id, policy_id, version, state, outcome,
        when_mailbox_id, when_actor_user_id, when_recipient_external, when_is_reply,
        when_org_daily_volume_min, canonical_sha256, created_by, created_at,
        published_by, published_at, superseded_at)
     VALUES (?,?,?,NULL,'draft',?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)`,
  ).bind(
    versionId, orgId, policyId, outcome,
    conditions.mailboxId ?? null,
    conditions.actorUserId ?? null,
    bit(conditions.recipientExternal),
    bit(conditions.isReply),
    conditions.orgDailyVolumeMin ?? null,
    hash, actorUserId, at,
  );
}

/**
 * Edits a policy: replaces its draft, or creates one if the policy is currently all-published.
 *
 * A published version is never edited. That is #49's answer inherited whole, and it dissolves rather than
 * answers the question of what a trivial edit does: there is no such thing as editing a published policy, so
 * the question is only ever about a draft, and publishing is a deliberate second act.
 */
export async function editPolicyDraft(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  policyId: string,
  input: { outcome: string; conditions?: PolicyConditions },
): Promise<DraftRecord> {
  if (!(await isAdmin(env, orgId, actorUserId))) throw requireAdminOrThrow(actorUserId);

  const conditions = input.conditions ?? {};
  const outcome = validate(input.outcome, conditions);

  const policy = await env.CATALOG.prepare(
    "SELECT id FROM policies WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, policyId).first<{ id: string }>();
  if (policy === null) {
    throw notFound("E_NO_SUCH_POLICY", {
      what: `${policyId} is not a policy in this organization`,
      why: "an edit needs something to edit",
      fix: "create the policy first",
    });
  }

  const versionId = ctx.id("plv");
  const at = new Date(ctx.now()).toISOString();
  const hash = await sha256Hex(canonicalConditions(outcome, conditions));

  // The old draft goes and the new one arrives in one transaction, because `pv_one_draft` permits exactly
  // one — so a delete that committed without its insert would leave a policy that is published-only and an
  // edit that vanished.
  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "policy.drafted", outcome: "ok", actorUserId, subject: policyId,
      detail: { policyOutcome: outcome, versionId, replacedDraft: true },
    },
    (entry) => [
      env.CATALOG.prepare(
        "DELETE FROM policy_versions WHERE org_id = ? AND policy_id = ? AND state = 'draft'",
      ).bind(orgId, policyId),
      draftInsert(env, orgId, policyId, versionId, outcome, conditions, hash, actorUserId, at),
      entry,
    ],
  );

  return { policyId, versionId, outcome, conditions };
}

export interface PublishedVersion {
  policyId: string;
  versionId: string;
  version: number;
  outcome: Outcome;
  supersededVersionId: string | null;
}

/**
 * Publishes a policy's draft, which is the versioning event.
 *
 * **A publish that changes nothing is refused.** Byte-identical conditions and outcome to the currently
 * published version means there is nothing to publish, in the same idiom as refusing to merge a conversation
 * into itself. Comparing `canonical_sha256` rather than column-by-column is what makes the refusal reliable:
 * a field order fixed in one function cannot drift the way six comparisons can.
 *
 * The refusal matters beyond tidiness. A version is what a send binds, so a no-op publish would mint a
 * version whose only distinguishing property is its id, and #62's `max(current) > max(bound)` comparison
 * would then be answering questions about an object that represents no decision anybody made.
 */
export async function publishPolicy(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  policyId: string,
): Promise<PublishedVersion> {
  if (!(await isAdmin(env, orgId, actorUserId))) throw requireAdminOrThrow(actorUserId);

  const draft = await env.CATALOG.prepare(
    `SELECT id, outcome, canonical_sha256 FROM policy_versions
      WHERE org_id = ? AND policy_id = ? AND state = 'draft' LIMIT 1`,
  ).bind(orgId, policyId).first<{ id: string; outcome: string; canonical_sha256: string }>();

  if (draft === null) {
    throw conflict("E_NO_POLICY_DRAFT", {
      what: `policy ${policyId} has no draft to publish`,
      why: "publication is the versioning event (#49), so it needs something unpublished to publish",
      fix: "edit the policy first; an edit produces a draft",
    });
  }

  const current = await env.CATALOG.prepare(
    `SELECT id, version, canonical_sha256 FROM policy_versions
      WHERE org_id = ? AND policy_id = ? AND state = 'published' LIMIT 1`,
  ).bind(orgId, policyId).first<{ id: string; version: number; canonical_sha256: string }>();

  if (current !== null && current.canonical_sha256 === draft.canonical_sha256) {
    throw conflict("E_POLICY_UNCHANGED", {
      what: `policy ${policyId} draft is identical to published version ${current.version}`,
      why: "publication is the versioning event, and a version that represents no decision is a version a "
        + "send could bind and an approver could be asked about for no reason",
      fix: "change the outcome or a condition, or discard the draft",
    });
  }

  const version = (current?.version ?? 0) + 1;
  const at = new Date(ctx.now()).toISOString();
  if (!isOutcome(draft.outcome)) {
    throw new CallerError("E_POLICY_OUTCOME_UNKNOWN", 500, {
      what: `draft ${draft.id} carries outcome ${JSON.stringify(draft.outcome)}`,
      why: "the stored value is outside the four outcomes, so it cannot be ranked",
      fix: "re-create the draft with a valid outcome",
    });
  }

  // Supersede first, then promote. `pv_version` is UNIQUE on (policy_id, version), so two concurrent
  // publishes cannot both take this number: one loses at the database and nothing commits (#9 — the
  // conflict is the signal). The audit entry is gated on the draft still being a draft and placed first,
  // because the promotion below clears that predicate.
  //
  // **The supersede carries the same gate as the promotion, and it has to.** Without it, a publish that lost
  // the race would still supersede the live version and then promote nothing — leaving the policy with *no*
  // published version at all, which is a policy plane failing **open** as a side effect of a conflict. The
  // two statements are one act, so they share one predicate. Both are inside a single `batch()`, so the
  // alternative of checking afterwards would be checking after the damage committed.
  const draftStillDraft =
    "EXISTS (SELECT 1 FROM policy_versions WHERE org_id = ? AND id = ? AND state = 'draft')";
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "policy.published", outcome: "ok", actorUserId, subject: policyId,
      detail: {
        versionId: draft.id, version, policyOutcome: draft.outcome,
        supersededVersionId: current?.id ?? null,
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `UPDATE policy_versions SET state = 'superseded', superseded_at = ?
          WHERE org_id = ? AND policy_id = ? AND state = 'published' AND ${draftStillDraft}`,
      ).bind(at, orgId, policyId, orgId, draft.id),
      env.CATALOG.prepare(
        `UPDATE policy_versions SET state = 'published', version = ?, published_by = ?, published_at = ?
          WHERE org_id = ? AND id = ? AND state = 'draft'`,
      ).bind(version, actorUserId, at, orgId, draft.id),
    ],
    {
      sql: "SELECT 1 FROM policy_versions WHERE org_id = ? AND id = ? AND state = 'draft'",
      params: [orgId, draft.id],
    },
  );

  if ((results[2]?.meta.changes ?? 0) === 0) {
    throw conflict("E_POLICY_PUBLISH_RACED", {
      what: `draft ${draft.id} was no longer a draft when this publish committed`,
      why: "another publish of the same policy won; nothing committed, because the promotion and the audit "
        + "entry share one transaction",
      fix: "re-read the policy and publish again if the change is still wanted",
    });
  }

  return {
    policyId, versionId: draft.id, version, outcome: draft.outcome,
    supersededVersionId: current?.id ?? null,
  };
}
