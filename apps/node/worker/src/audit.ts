import { ID_PREFIXES, idPattern, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { unavailable } from "./errors.ts";

/**
 * Hash-linked audit (§23, Layer 5's shape).
 *
 * Built before Layer 5 because an audit log added later has a hole exactly where the past should be.
 * Everything already shipped produces events an administrator would need — sign-in, lockout, key
 * rotation, sealing, dispatch, cancellation, re-sealing, reconciliation — and none of them were
 * recorded anywhere a person could read.
 *
 * ## Why hash-linked rather than timestamped
 *
 * A timestamped log is a claim. A hash-linked one is a claim that can be **checked**: each entry
 * carries the hash of its predecessor, so deleting an entry, reordering two, or editing a field all
 * break verification at a nameable point.
 *
 * This does **not** stop a determined operator with database access from rewriting the whole chain, and
 * nothing in a self-hosted system can — the customer owns the database, which is the entire premise
 * (ADR 2). What it stops is a *quiet* edit, which is the realistic case: the chain turns "trust this
 * log" into "verify this log", and `verifyChain` reports the first entry where it breaks rather than a
 * bare pass/fail, because an investigation needs the bad link, not the news that one exists.
 *
 * ## Appending is a race, and the database settles it
 *
 * `UNIQUE(org_id, seq)` means two concurrent writers cannot both take a slot: one loses at the database
 * and retries against the new tip. That is #9's shape — the conflict *is* the signal — and it avoids a
 * Durable Object on a path that every state change touches.
 */

const MAX_DETAIL = BUDGETS["audit.max_detail_bytes"];
const VERIFY_BATCH = BUDGETS["audit.verify_batch"];

/** The genesis predecessor. A chain has to start somewhere, and it starts somewhere stated. */
const GENESIS = "0".repeat(64);

/**
 * Who acted. Four kinds, and `butler` is #50's.
 *
 * `actor_user_id` holds a `btl_<ulid>` on a Butler's entries, and the column's name is one migration 0008
 * cannot change — so this is the field that stops that being an overclaim. The pair says *"the actor is a
 * Butler, and here is which one"*, which is the axis the column was added for: `node` already means *"an
 * alarm, a sweeper"*, with no program behind it and nothing to name. A Butler is a specific published
 * program somebody wrote, so collapsing it into `node` would make *"which Butler did this"* unanswerable —
 * the exact question §23 exists to answer. The argument in full is in `src/butler/principal.ts`.
 */
export type ActorKind = "user" | "node" | "installer" | "butler" | "agent";
export type Outcome = "ok" | "refused" | "failed";

/**
 * Every action this Node may record, declared in one place.
 *
 * Declared rather than free-form for a reason that only shows up months later: an audit trail is read
 * by someone filtering for an action name, and `auth.signed_in` in one file with `auth.sign_in` in
 * another produces a filter that quietly returns half the truth. A free-form string cannot be
 * misspelled *detectably* — it just becomes a category of one.
 *
 * Adding an entry here is deliberately the easy half. The half that matters is the tripwire in
 * `test/audit-coverage.test.ts`, which fails when state can change without any of these being emitted.
 */
export const AUDIT_ACTIONS = {
  "auth.signed_in": { says: "A person exchanged a password for a session." },
  "auth.sign_in_failed": { says: "A password was presented and refused." },
  "auth.revoked_all_sessions": { says: "Every session for one person was ended at once (§28)." },
  "key.rotated": { says: "The signing key changed; tokens minted before and after differ in kid." },
  /*
   * ADR 29's recovery codes (#92). Both entries earn their place on the same ground and it is not
   * frequency — minting happens at claim and re-minting is rare — it is that **restoring is an
   * unauthenticated act on this Node's most sensitive material**.
   *
   * `POST /api/recovery/redeem` takes no session, deliberately: the state it exists for is one where the
   * credential key is unopenable, so session keys cannot be verified and requiring a session would make the
   * recovery path reachable only from the state that does not need it. An unauthenticated route that
   * installs keys and leaves no trace is exactly what §7 exists to forbid, so the trail is what makes the
   * exposure acceptable rather than merely bounded.
   *
   * `recovery.vault_restored` cannot name a person, and that is recorded rather than hidden: the actor is the
   * code, and whoever holds a code is who this Node believes them to be. The subject is the code's row id —
   * never the code, never its hash — so "which of the ten was spent, and when" is answerable without the
   * trail carrying anything that opens the escrow.
   *
   * Minting and confirming **can** name a person and now do. Minting recorded `actorKind: "node"` on the
   * argument that the claim path has no session, which had stopped being true — `claim.ts` issues one on the
   * line above — and never applied to `POST /api/recovery-codes/rotate` at all. Rotating the artifact that
   * decrypts an organization's mail was the least attributable act in the product and the least attributed.
   */
  "recovery.codes_minted": {
    says: "A set of ten recovery codes was minted and the key vault escrowed under them. Names the set. Any "
      + "previous set that nobody had confirmed holding stopped working; a confirmed one keeps working until "
      + "this set is confirmed in its turn.",
  },
  "recovery.codes_confirmed": {
    says: "Somebody proved they hold a set of recovery codes, without spending one — and every other set was "
      + "retired, which deletes the copies of the key vault sealed under those codes. Names both sets.",
  },
  "recovery.vault_restored": {
    says: "A recovery code was spent to restore key material into the vault. Names the generations put back "
      + "and the ones that collided with a live key and were not.",
  },

  /*
   * Layer 3. Note what is *absent*: there is no `case.claimed` or `case.released`.
   *
   * People claim all day, audit entries are never trimmed, and `audit-and-log-retention.md` sizes the table
   * at a handful per message — so one entry per claim grows an untrimmable table without bound. Claim
   * history lives on the case. What earns an entry is taking work off a *named colleague*, which is an act
   * somebody could be asked about. Frequency and answerability, not importance.
   */
  "case.claim_taken": { says: "One person took a claimed case from another; both are named." },
  "mailbox.response_target_set": {
    says: "An administrator set or cleared a mailbox's first-response target, which is a promise to customers.",
  },
  "conversation.merged": {
    says: "A person decided two conversations were one thing; both ids and every mailbox are named.",
  },
  "access.granted": { says: "A relation was granted to somebody, by an administrator." },
  "access.revoked": { says: "A relation was withdrawn; §7 makes it effective on the next request." },
  /*
   * Two entries rather than one, because they are answerable by different people (#83).
   *
   * `access.invited` is an administrator's act: they minted a bearer credential for membership and handed it
   * somewhere. `access.joined` is the invited person's: they redeemed it and an account now exists. Folding
   * them into one entry would make the trail unable to answer "who let them in" separately from "when did
   * they actually arrive" — and the gap between the two is exactly the window a leaked invitation lives in.
   */
  "access.invited": { says: "An administrator invited an address to join the organization." },
  "access.joined": { says: "Somebody redeemed an invitation, and an account now exists for them." },

  /*
   * §28's membership administration (#73). Four actions, and the argument for each is *where it sits between
   * `access.granted` and the `case.claimed` that deliberately does not exist*.
   *
   * That boundary is frequency and answerability, and membership is at the far end of both. A claim happens
   * all day and is a person picking up work; **adding somebody to a team is authority**. `readableSubjects`
   * expands a principal into `[userId, ...teamIds]`, so a team holding `mailbox.content.read` or
   * `approval.decide` confers it on every member — which means adding a person to a team can hand them a
   * mailbox's contents and a vote on somebody else's send with **no `access.granted` entry anywhere**. Without
   * these two actions, an administrator grants a team once, in the trail, and then quietly changes who that
   * grant reaches, forever, in silence. That is the same question `access.granted` is audited for, reached
   * through a second door, and it is the whole reason this pair exists.
   *
   * `team.member_removed` carries `remaining` — how many members the team has left — because removing the last
   * one is the act that makes a live policy naming that team unsatisfiable, and *"which act emptied this
   * team"* is exactly what somebody asks a week later when sends start being withheld.
   *
   * **`team.created` and `team.renamed` are the harder call, and they are audited on their own merits rather
   * than because the pair above is.** Creating a team confers nothing — an empty team with no tuples is a name
   * — so the frequency argument alone would exempt it. What earns it is that there is no other entry riding in
   * that transaction to answer for it: `policies` is exempt in `audit-coverage.test.ts` precisely *because*
   * `policy.drafted` records the same act, and a `teams` row has no such neighbour. Once per team is rarer
   * than once per policy, so the untrimmable-table objection does not bite.
   *
   * A rename is answerable for a sharper reason: a team is granted to by **id** and chosen by a human reading
   * a **name**, so renaming "Interns" to "Finance" changes what the next administrator believes they are
   * granting `approval.decide` to. The entry carries both names, which a `renamed_at` column could not.
   *
   * All four ride in `auditedBatch` beside the write they record, so none is `standalone`. There is
   * deliberately no `team.deleted` and no `team.archived`: migration 0032 refuses both acts, and a declared
   * action nothing emits is a category of one — which the last assertion in `audit-coverage.test.ts` fails on.
   */
  "team.created": { says: "An administrator created a team; a team with no tuples confers nothing yet." },
  "team.renamed": {
    says: "An administrator renamed a team; both names are recorded, because a team is granted to by id and "
      + "chosen by a human reading its name.",
  },
  "team.member_added": {
    says: "An administrator put somebody in a team, which confers every relation that team holds — the same "
      + "authority access.granted records, reached through membership.",
  },
  "team.member_removed": {
    says: "An administrator took somebody out of a team, withdrawing every relation that team holds from "
      + "them; how many members remain is recorded, because emptying a team can make a live policy "
      + "unsatisfiable.",
  },
  "send.sealed": { says: "A composition became immutable bytes and entered the hold window." },
  "send.cancelled": { says: "A held send was stopped by a person before dispatch." },
  "send.withheld": {
    says: "A held send was stopped by the Node because the author's send authority was withdrawn.",
  },
  /*
   * #50's release act, and it is the **first** act in this Node that clears a gate without settling an
   * approval.
   *
   * A Butler-proposed send is sealed `awaiting` with `butler_release_required`, which `movableNow` refuses
   * to move, and a person holding `send.propose` on the mailbox puts it back to `held`. That is an act
   * somebody could plainly be asked about — a program wrote a message and a named human decided it could go
   * — so it is audited, and the entry's actor is the *person*, never the Butler: the whole value of the gate
   * is that the trail names who agreed.
   *
   * It is not `approval.decided`. That action means an eligible approver settled a stage of a request, with
   * a decision row behind it and separation of duty evaluated live; this is one person clearing a default
   * that exists because nobody had looked. Filing it under the stronger name would make "how often is dual
   * control being exercised" unanswerable from the trail.
   *
   * Deliberately named for the act rather than for the Butler, because the other gate with no release act
   * is `policy_hold` — #60 gave it to any `send.propose` holder and nobody built it. When it is built it
   * emits this, with a different reason in the detail, rather than a second action saying the same thing.
   */
  "send.released": {
    says: "A person released a send that was waiting for one; the reason it was waiting is recorded with it.",
  },
  // The terminal states of dispatch. Each is recorded, including the successful one — see `audit`.
  "send.held": { says: "A send is waiting out its hold window." },
  "send.throttled": { says: "The transport declined for rate reasons; the system may retry." },
  "send.refused": { says: "The transport refused; only a person may retry." },
  "send.suppressed": { says: "The Node declined to hand over, by its own rule." },
  "send.handed_over": { says: "The transport accepted the bytes." },
  "send.outcome_unknown": { says: "Hand-over neither succeeded nor failed observably." },

  /*
   * Layer 4: the Butler object (#49). Two actions, and the pair is the lifecycle rather than an asymmetry.
   *
   * `butler.drafted` rides beside the draft insert, and `butler.published` beside the promotion — both
   * inside `auditedBatch`, so a published version with nothing in the trail is not representable. Neither
   * is standalone.
   *
   * There is deliberately **no** `butler.edited`: an edit *is* a draft, delete-then-insert in one
   * transaction, and a second action for one transaction would make "who changed this Butler" answerable
   * from two places that can disagree. `detail.replacedDraft` distinguishes the two cases inside one action,
   * which is the shape `cancelSend` set.
   *
   * And **still** no `butler.ran`, now that #50 runs one — which is a decision rather than an omission and
   * needed re-arguing when the engine landed rather than inheriting the old reason. Every act inside a run
   * that somebody could be asked about is audited where it happens: a Butler's send appends `send.sealed`
   * with the Butler as actor and `actor_kind = butler`, and a person releasing one appends `send.released`
   * naming them. What a run action would add is *execution state* — started, parked, finished, what it
   * spent — which is nobody's act, and it would put one untrimmable entry per delivery per published Butler
   * behind a fact `butler_runs` already carries. That is the same per-row-versus-per-act reasoning that
   * exempts `send_recipients` and an export's pages. Faults and refusals go to `log_entries`, which is
   * bounded and trimmed and is where "why did this behave oddly" belongs.
   */
  "butler.drafted": {
    says: "An administrator wrote or replaced a Butler's draft; the AST digest and node count are recorded.",
  },
  "butler.published": {
    // Amended with #50: this said *"Nothing executes it yet; detail.runnable says so"*, which was true when
    // 0027 shipped the store with no engine and became false the day the engine landed — in the one table
    // that must not hold a false statement. `detail.runnable` no longer exists either; what the entry carries
    // is the **trigger**, which is what a reader of the trail wants next.
    says: "A Butler draft became an immutable version, and it is live: the entry names the trigger that "
      + "will fire it.",
  },

  /*
   * Layer 5 over Layer 4's substrate: the Butler pause (#75, §18). Two actions, and the asymmetry between
   * them is #66's asymmetry pointing a third way.
   *
   * `butler.paused` is placed by the **machine**, so its `actorUserId` is `null` and `kindOfActor` renders
   * `node` — *"an alarm, a sweeper"*, which is literally where it happens: `triggerButlers` runs inside the
   * outbox sweeper's invocation. Not the Butler, which did not stop itself; not the administrator who
   * published it, who is not present and decided nothing. It is this Node's own act and the trail says so.
   *
   * It carries the **sentence** as well as the token, in `detail.said`, and that is the same reasoning
   * `send.rate_limited` records for itself: the reading behind a pause is a windowed count, so by the time
   * anybody reads the entry the rows that produced the number have aged out of the window and nothing can
   * reproduce it. Unusually, the fact is *also* a column (`butler_pauses.detail`) — because the person
   * deciding whether to resume is reading the pause, not the trail, and neither reader should have to find
   * the other's copy.
   *
   * `butler.resumed` is the human half, and it is the **only** human judgement anywhere in this breaker's
   * lifecycle. So its reason is mandatory, which inverts `domain.pause_lifted`'s optional one: that pause was
   * placed by two people who wrote down why, and this one was placed by nothing that can be asked. The
   * argument in full is in `src/butler/pause-acts.ts`.
   *
   * There is deliberately **no** `butler.pause_requested`: nobody requests one. And no third action for
   * *"a paused Butler was passed over"* — that is the absence of an act rather than an act, and it happens
   * once per delivery per paused Butler, which is exactly the per-row frequency
   * `audit-and-log-retention.md`'s "a handful per message" sizing forbids. What records it is the latched
   * row itself and `doctor`'s `butler_paused` finding; `TriggerOutcome.paused` names them for the caller.
   *
   * Both ride in `auditedBatch` beside the write they record, so neither is `standalone`.
   */
  "butler.paused": {
    says: "This Node stopped a Butler by its own rule; the reason, the delivery that tripped it and the "
      + "figure behind it are recorded with it. Republishing the Butler does not clear it.",
  },
  "butler.resumed": {
    says: "One administrator restarted a paused Butler, alone and with a mandatory reason — the only human "
      + "judgement anywhere in a machine-placed pause.",
  },

  /*
   * Layer 4's replay modes (#53). One action, and it is the first Butler *run* action in this catalogue —
   * which needed the argument against `butler.ran` to be re-read rather than assumed to still apply.
   *
   * It does not. `butler.ran` is refused because a run is caused by a **delivery**: nobody decided it, and one
   * untrimmable entry per delivery per published Butler is exactly the per-row frequency
   * `audit-and-log-retention.md`'s sizing forbids. A **replay** is the opposite on both counts. A named person
   * decided to run a program again that proposes mail — the first thing in this product that deliberately
   * repeats an act with external effects — and it happens as often as a human clicks, not as often as mail
   * arrives.
   *
   * It rides in `auditedBatch` with the `butler_runs` INSERT rather than being appended beside a `create()`,
   * because `auditedBatch`'s contract is the one this needs: if the Node cannot record the act, it does not
   * perform the act. `audit` never throws, so appending with it would start the run anyway — an unrecorded act
   * with external effects, which is the wrong failure direction. `standalone` is for refusals.
   *
   * `detail.mode` carries which mode ran, so the two send-scoped modes below and this one are one filter over
   * "what has been replayed here". There is deliberately no `butler.inspected`: `inspect` executes nothing and
   * performs no effect, and an entry per glance at a screen is the frequency this catalogue keeps out.
   *
   * **That is not the same as writing nothing, and the difference is one entry that already exists.** A run's
   * recorded input carries the triggering message's subject and sender, so `inspectRun` gates those fields per
   * mailbox — and where a **supervised grant** is what answers, §7 owes a `supervised.opened` before the
   * fields are returned. So the read that is worth recording already is, under the action #63 declared for
   * exactly that disclosure; what `butler.inspected` would add is a row for the ordinary relation holder,
   * which is the per-glance frequency, and for the reader who holds nothing, who now sees no content at all.
   */
  "butler.replayed": {
    says: "A person re-ran a recorded Butler run: the new run's id is the subject, and the run it repeats, "
      + "the version, the delivery and what the original did are recorded with it.",
  },

  /*
   * The two send-scoped replay modes (#53, §16), and **two actions because two epistemic states**. §5C's
   * discipline applied to an action rather than to a readout: one of these cannot duplicate and the other
   * might, and a single action with a flag in its detail would make "how often has this Node knowingly risked
   * a second delivery" answerable only by reading every entry's detail.
   *
   * `send.retried` is the safe one. It is offered **iff** a recorded outcome proves non-acceptance —
   * `refused`, `throttled`, `suppressed`, or an authored manifest whose `submitted_key` is NULL, because the
   * bytes and that column are written before the first submit. It reuses the original manifest and therefore
   * the original idempotency key, so it appends no `send.sealed`: nothing new was composed.
   *
   * `send.resent` is the unprovable sibling. It mints a **new** manifest and therefore a new key on purpose,
   * so a `send.sealed` is appended beside it in the same transaction — and this entry exists because that one
   * cannot carry what matters here. `send.sealed`'s actor is the *author*, which on a Butler's message is the
   * `btl_`; this one's actor is the **person** who accepted that the recipient may receive two copies, and its
   * detail carries their reason and `duplicatePossible: true`.
   *
   * Neither is `send.handed_over` or any other dispatch action: those record what the transport did, and these
   * record a person deciding to ask it again.
   */
  "send.retried": {
    says: "A person handed a send to dispatch again under its original key, because a recorded outcome proves "
      + "it never left; the proof is named in the entry.",
  },
  "send.resent": {
    says: "A person sealed a send again under a new idempotency key, having been told the first attempt's "
      + "outcome is unknown and the recipient may receive two copies; their reason is recorded.",
  },

  /*
   * Layer 5: legal hold (#64). Two actions, and the asymmetry between them is the decision: placing is one
   * administrator alone because it only ever preserves, and lifting is dual control with a mandatory reason
   * because it re-permits destruction.
   *
   * `hold.lifted` arrived **with** the act rather than before it. It was absent while there was no lift path,
   * because a declared action nothing emits is a category of one — what this catalogue exists to prevent, and
   * what `audit-coverage.test.ts` fails on. What made it emittable is #61's approval machinery generalising
   * from a manifest to a subject (migration 0021), so a lift is an approval like any other.
   *
   * There is deliberately **no** `hold.lift_requested`: requesting a lift *is* requesting an approval, and
   * `approval.requested` records it in the same transaction as the request row, with the stages, the eligible
   * count and the reason in its detail. A second action for one transaction would make "who asked to lift
   * this hold" answerable from two places that can disagree — the reasoning that gives `cancelSend` one
   * entry rather than two.
   */
  "hold.placed": {
    says: "An administrator placed a legal hold over a mailbox and a date window; placing only preserves.",
  },
  "hold.lifted": {
    says: "Two distinct approvers released a legal hold; the reason it was requested for is recorded with it.",
  },

  /*
   * Layer 5: matters and supervised reading (#63, §7). Three actions, and what is **absent** is the half of
   * #63 this part does not build.
   *
   * `matter.opened` / `matter.closed` are the lifecycle of the purpose a supervised read is for. Both ride in
   * `auditedBatch` beside the `matters` row, so neither is `standalone`. Closing earns an entry of its own
   * rather than being folded into the open: §7 hangs the notice to the person whose mail was read on the
   * *close*, so "when did this matter end, and who ended it" is the question the obligation is computed from —
   * and the closer may deliberately not be the opener (`closeMatter` lets an `org.admin` close somebody
   * else's, precisely because the investigator is the party with a reason to leave it open).
   *
   * `supervised.granted` is the **effect** of a completed dual approval, recorded beside the one
   * `UPDATE supervised_grants` that sets `granted_at`. It exists for exactly the reason `hold.lifted` does:
   * `approval.decided` says two people agreed, and cannot say *what they agreed to*. Somebody reading the
   * trail to answer §7's question — who was allowed into whose mailbox, how much of it, under what matter,
   * until when — must not have to join `approvals` to `supervised_grants` to learn it. There is no
   * `supervised.requested`, for the reason `hold.lift_requested` does not exist: requesting **is** requesting
   * an approval, and `approval.requested` records it in the same transaction as the grant row.
   *
   * The three below are #63 part B's, and they are the acts themselves rather than the authority: §7 requires
   * a record of every supervised *query*, *result opened*, *preview* and *attachment read*. **Per act, not per
   * row** — a search matching 5,000 messages is one entry, which is what keeps `audit-and-log-retention.md`'s
   * sizing ("a handful per message") true of a real investigation: tens of entries in a session, not thousands.
   *
   * Each is keyed on the **grant**, like `supervised.granted`, because §7's question is about the access and
   * the grant is the id every act under it cites. An act spanning two live grants is recorded against each,
   * which is a second entry for one query and deliberate: the trail is filtered by grant, and one entry naming
   * two would answer that filter from neither.
   *
   * `supervised.query` carries **the ids it returned**, not just how many. A result list renders subject and
   * sender — that *is* content exposure, and "a query matched 40 things" understates what a person saw by
   * forty subjects. The list is bounded by `audit.max_detail_bytes` at about 59 typed-prefix ULIDs, so an
   * oversized page is split into continuation entries rather than handed to `boundedDetail`, which would
   * record a *prefix* of the ids and understate the exposure — the exact failure per-act recording was chosen
   * to avoid. `buildSupervisedQuery` in `src/supervised.ts` does the splitting, measured with this file's own
   * `detailFits` so the two cannot disagree about the cap.
   *
   * `supervised.attachment` is named for §7's *attachment read* and is emitted by the raw-evidence reads —
   * `GET /api/messages/:id/raw` and the submitted-bytes endpoint. This Node has no per-attachment endpoint to
   * hang a finer entry on, and the raw `.eml` **is** every attachment, so recording it under the weaker name
   * would understate what left. Said here rather than left for a reader to notice the absence.
   */
  "matter.opened": {
    says: "Somebody opened a matter: the purpose a supervised read can later cite, with its type and description.",
  },
  "matter.closed": {
    says: "A matter was closed. §7 makes the notice to the people whose mail was read due after this instant.",
  },
  "supervised.granted": {
    says: "Two distinct approvers granted somebody a time-boxed read over a mailbox; the scope, the matter and "
      + "the expiry are recorded with it.",
  },
  "supervised.query": {
    says: "A supervised reader ran a query; the entry names the ids it returned, not only how many.",
    disclosure: true,
  },
  "supervised.opened": {
    says: "A supervised reader opened one result's content.",
    disclosure: true,
  },
  "supervised.attachment": {
    says: "A supervised reader read raw evidence — the original .eml, which carries every attachment.",
    disclosure: true,
  },

  /*
   * Layer 5: export (#65, §7, §22). Four actions across two acts of different grain, and the grain is the
   * whole reason there are two permissions rather than one.
   *
   * `message.exported` is the **single-message** `.eml` download, and it is the entry this ticket exists to
   * add: until #65 that route produced a complete RFC822 copy with `content-disposition: attachment` and
   * recorded **nothing**, so *"has anybody taken a copy of this message off the Node"* — the exact question
   * §7 exists to make answerable — had no answer. It is a `disclosure`, like the three supervised acts above
   * and for the same reason: nothing is written, and an export that cannot be recorded must not happen.
   *
   * It is emitted for **every** download, not only for supervised ones. `supervised.attachment` already
   * covers the case where a time-boxed grant authorized the read, and it is keyed on the grant; this is
   * keyed on the receipt and is emitted whichever authority answered, because the question is about the
   * message rather than about the access. A holder of the ordinary standing relation produces exactly one
   * entry, a supervised reader produces two, and neither is redundant — one says *who was let in*, the other
   * says *what left*.
   *
   * The other three are the **bulk** act, and the count is deliberate: **not one entry per page**. A page is
   * progress, and progress lives in the `exports` row (migration 0025). One entry per page would put
   * hundreds of rows behind one act and falsify `audit-and-log-retention.md`'s "a handful per message"
   * sizing, which is the reasoning that already exempts `send_recipients`.
   *
   *   supervised.export_requested   what two approvers agreed to, recorded beside the `UPDATE exports` that
   *                                 makes the export runnable. Named for the request rather than for the
   *                                 approval because what it carries is **what was asked for** — the
   *                                 predicate hash, the bound, the matter, the destination — and
   *                                 `approval.decided` structurally cannot say what was agreed to. It is the
   *                                 slot `supervised.granted` and `hold.lifted` occupy for their subjects.
   *                                 There is no separate entry at request time, for `hold.lift_requested`'s
   *                                 reason: requesting **is** requesting an approval, and
   *                                 `approval.requested` records it in the same transaction as the row.
   *   supervised.export_completed   the manifest exists. Carries the export id, the manifest's SHA-256, the
   *                                 emitted count, the destination and the matter — five short fields, which
   *                                 keeps it far inside `audit.max_detail_bytes` even at the tight bound #69
   *                                 measured. It carries **no message ids**: the manifest is the list, its
   *                                 hash is in this entry, and putting the ids here as well would be the
   *                                 unbounded detail `buildSupervisedQuery` has to split around.
   *   supervised.export_aborted     the run stopped at `max_messages` with no manifest. A third action
   *                                 rather than `export_completed` with `outcome: "refused"`, because
   *                                 "completed" is not true of it and a name that overclaims is the defect
   *                                 AGENTS.md §4 names — #65's resolution enumerated the two entries a
   *                                 *successful* export produces and did not rule on the refusal, so this is
   *                                 the case it left rather than a decision reopened.
   *
   * All three ride in `auditedBatch` beside the `UPDATE exports` they record, so none is `standalone`: an
   * export whose state moved with nothing in the trail is not representable.
   */
  "message.exported": {
    says: "Somebody downloaded one message's original .eml — a complete RFC822 copy, off this Node.",
    disclosure: true,
  },
  "supervised.export_requested": {
    says: "Two distinct approvers authorized an eDiscovery export; the predicate hash, the message bound, "
      + "the matter and the destination are recorded with it.",
  },
  "supervised.export_completed": {
    says: "An eDiscovery export finished; the manifest's SHA-256 and the number of messages emitted are "
      + "recorded with it.",
  },
  "supervised.export_aborted": {
    says: "An eDiscovery export stopped without a manifest because it would have exceeded the message "
      + "bound its approvers agreed to.",
  },

  /*
   * Layer 5: the policy object (#60). §18 lists policy publication among the acts an approval binds, which
   * settles whether it is answerable — it plainly is: a published policy decides whether other people's mail
   * may leave, and "who made this rule live" is the question an audit exists to answer.
   *
   * `policy.drafted` is audited too, and the boundary that exempts `drafts` is what argues for it rather than
   * against it. A composer draft is somebody *typing*, autosaved on a pause, dozens of entries behind one
   * human action. A policy draft is an administrator writing a rule — rare, and separation of duty (§18)
   * means the person who drafted and the person who published may deliberately differ, so a trail carrying
   * only the publication cannot answer who wrote what was published.
   *
   * Both ride in `auditedBatch`: each accompanies rows in `policy_versions`, so neither is `standalone`, and
   * the compiler enforces that rather than a reviewer.
   */
  "policy.drafted": {
    says: "An administrator wrote or replaced a policy's draft; a draft is never consulted by evaluation.",
  },
  "policy.published": {
    says: "An administrator made a policy version live; the previous version froze and was superseded.",
  },

  /*
   * Layer 5: approvals (#61). Three actions, one per act, and none of them is `standalone` — every one
   * accompanies rows in `approvals` or `approval_decisions`, so the compiler routes all three through
   * `auditedBatch` rather than trusting anybody to pick the atomic form.
   *
   * `approval.requested` is audited even though the seal that causes it is already audited, and the boundary
   * that exempts an ordinary claim is what argues for it. `send.sealed` records a fact about a *send*: which
   * rules matched and what state it landed in. This records a fact about a **person**: that they are being
   * asked to decide, at which stage, and how many of them the request needs. Its subject is the approval id
   * rather than the manifest id, and an approver later asking "when was I asked, and what was asked of me"
   * cannot answer it from `send.sealed`. An object whose two mutations are audited and whose creation is not
   * has a trail that starts mid-story.
   *
   * There is no `approval.unsatisfiable`, and that is a decision rather than an omission. A stage set that
   * cannot be filled is not an act somebody took: at seal it is recorded in `send.sealed`'s detail with the
   * shortfall, and after a withdrawal it is the consequence of `approval.withdrawn`, whose detail names it. An
   * action for it would be an entry with no actor, and `send.withheld` already exists for the send's half.
   */
  "approval.requested": {
    says: "A policy required approval, so this Node asked for one; the stages and counts asked for are named.",
  },
  "approval.decided": {
    says: "An eligible person approved or denied a send; a denial is terminal and a completed approval releases it.",
  },
  "approval.withdrawn": {
    says: "An approver took back their own approval while the request was still incomplete.",
  },

  /*
   * Layer 5: send circuit breakers (#66, §18). Three actions, and each of the three exists for a reason the
   * other two do not have — which is why they are not one action with a kind in its detail.
   *
   * `send.rate_limited` is the entry #66's own resolution said the design owes: a rate breaker keeps **no
   * state at all** — it is a windowed `COUNT(*)` re-asked per send — so *"the trip leaves no row"*, and a
   * trip that is not audited explicitly never happened. Every other send state can be reconstructed from
   * `send_manifests`; this one names a threshold that was crossed by rows which will have aged out of the
   * window by the time anybody looks.
   *
   * **It is not `send.suppressed`, and reusing that one was the tempting wrong answer.** `send.suppressed`
   * says *"the Node declined to hand over, by its own rule"*, which is nearly right — but it is the entry for
   * the `suppressed` **state**, which `dispatch.ts` documents as *"on the suppression list — will never
   * arrive, and that is knowable now"*. A rate gate is the opposite claim on both halves: the mail **will**
   * arrive, and nothing about this recipient is known to be wrong. Filing a delay under a name that means
   * permanent non-arrival is the overclaim AGENTS.md §4 forbids, and it would have made *"how many sends did
   * this Node discard"* unanswerable from the trail.
   *
   * **It is emitted on the transition, never on every sweep**, and that is enforced rather than intended: the
   * entry and the state change share one `auditedBatch` whose gate excludes a manifest already `awaiting`
   * with this same reason, so a send re-visited by the sweeper while the window is still over writes nothing
   * at all. One entry per gate, not one per minute — without it, a send held for an hour behind a one-minute
   * sweep would file sixty entries and falsify `audit-and-log-retention.md`'s "a handful per message".
   *
   * `domain.pause_placed` and `domain.pause_lifted` are the latched breaker's two acts, and their asymmetry
   * **is** #66's decision rather than an artefact of what got built. Placing stops a customer's mail, so it
   * takes two administrators and a mandatory reason and rides in `approveStatements` beside the one
   * `UPDATE domain_pauses` that sets `placed_at`. Lifting re-permits sending, and the harm of a wrongly
   * paused domain grows every minute it stands, so **one** administrator lifts it alone. That is #64's
   * asymmetry pointing the other way, for the same reason it pointed the way it did there.
   *
   * `domain.pause_placed` exists beside `approval.decided` for the reason `hold.lifted` and
   * `supervised.granted` do: `approval.decided` says two people agreed and structurally cannot say *what they
   * agreed to*. Somebody reading the trail to answer "why did this domain's mail stop" must not have to join
   * `approvals` to `domain_pauses` to learn the domain or the reason.
   *
   * There is deliberately **no** `domain.pause_requested`, for `hold.lift_requested`'s reason: requesting a
   * pause **is** requesting an approval, and `approval.requested` records it in the same transaction as the
   * row, with the stages, the eligible count and the reason in its detail.
   *
   * All three ride in a `batch()` beside the write they record, so none is `standalone`.
   */
  "send.rate_limited": {
    says: "A windowed rate breaker gated a send: it has not left, it is not lost, and it goes when the "
      + "window clears. Nothing else records this, because the breaker keeps no state.",
  },
  "domain.pause_placed": {
    says: "Two distinct administrators stopped every send from a domain; the domain and the reason they "
      + "were given are recorded with it.",
  },
  "domain.pause_lifted": {
    says: "One administrator released a domain pause, alone — the harm of a wrongly paused domain grows "
      + "every minute it stands.",
  },

  /**
   * `standalone` means there is no accompanying write, so the bare `audit` append is correct and
   * `auditedBatch` has nothing to be atomic with. A lockout is a *refusal*: it changes nothing, and by
   * the time it is recorded the decision is already made.
   *
   * Absence is the safe default — omit the flag and the action can only be recorded through
   * `auditedBatch`, enforced by the compiler rather than by review. Adding `standalone: true` to a new
   * action is the one way to reintroduce the non-atomic shape, and it also trips the tripwire in
   * `test/audit-coverage.test.ts`, so it cannot be done quietly.
   */
  "auth.locked_out": {
    says: "Sign-in was refused because the failure count was already spent.",
    standalone: true,
  },

  /**
   * Standalone for the same reason, reached from the other direction: a deletion refused by a legal hold
   * **writes nothing**, so there is no transaction for the entry to ride in, and the decision is already
   * made by the time this records it. Using `auditedBatch` here would demand a state change that must not
   * happen.
   *
   * The asymmetry that makes this safe: `audit` never throws, so a Node that cannot record the refusal
   * still refuses. For a preserving act that is the correct failure direction, and it is the opposite of
   * `hold.placed`, where nothing has happened yet and a Node that cannot record the act must not perform it.
   */
  "hold.blocked": {
    says: "A content-destroying act was refused because a legal hold covered it; the attempt is the evidence.",
    standalone: true,
  },

  /**
   * Supplying the sending API token (#86).
   *
   * Recorded because it hands this Node the ability to send as a Cloudflare account, which is authority
   * rather than configuration — the same reason `access.granted` is here.
   *
   * **The entry names the account and the person and never the token**, not even its length. An audit trail
   * that recorded a credential would be a second place the credential lives, in the one table designed to be
   * read widely and kept for ever.
   */
  "transport.configured": {
    says: "An administrator supplied the credentials this Node sends mail with.",
  },

  /**
   * Registering a passkey (#84).
   *
   * Audited rather than logged, unlike a sign-in, and the difference is the one this table is for: signing
   * in exercises an existing way into an account, while registering **adds one**. It is the same shape as
   * `access.granted` — an act that changes what somebody can do afterwards — and the question an investigator
   * has about a compromised account is *when did a credential appear that I do not recognise*.
   *
   * The entry names the credential id and the label and never the public key: it discloses nothing, and an
   * audit entry carrying material nobody reads is material somebody eventually parses.
   */
  "auth.passkey_registered": {
    says: "Somebody added a passkey to their account — a new way in, not a use of an existing one.",
  },

  /** Revoking one. The other half, and the half somebody checks after losing a device. */
  "auth.passkey_revoked": {
    says: "Somebody removed a passkey from their account.",
  },

  /**
   * Creating a delegated agent principal (#109 L2).
   *
   * A machine identity that acts on mail, so its creation is a governance event rather than configuration —
   * and the entry names the sponsor, because the interesting question later is not *who made this* but
   * *whose authority does it borrow*. The token is never in the detail and must never be.
   */
  "agent.minted": {
    says: "An administrator created an agent: a machine identity acting under a named person's authority.",
  },

  /** Withdrawing one. Immediate, and the half somebody reaches for when a credential has leaked. */
  "agent.revoked": {
    says: "An administrator withdrew an agent's credential. It stops working on the next request.",
  },
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/**
 * The actions that may be appended on their own.
 *
 * This is the type that closes the last hole in the atomicity work. Every other action accompanies a
 * state change, and passing one to `audit` — the append that is *not* in the caller's transaction —
 * is a compile error. Nothing rests on remembering which function to reach for.
 */
export type StandaloneAction = {
  [K in AuditAction]: (typeof AUDIT_ACTIONS)[K] extends { standalone: true } ? K : never;
}[AuditAction];

/**
 * The actions that record a **disclosure**: an act that writes nothing and must not happen unless it is
 * recorded.
 *
 * The third classification, and it exists because the two that came before it answer opposite questions and
 * neither answer fits a read. `standalone` means *there is no accompanying write, so record it and never fail
 * the request* — right for a lockout and a hold-blocked deletion, both of which are **refusals**, where a Node
 * that cannot record still refuses and the failure direction is safe. `auditedBatch`'s contract is the
 * opposite — *if the Node cannot record the act, it does not perform the act* — and that is the contract a
 * supervised read needs, because a read is a **disclosure**: unrecorded, it is the one thing §7 exists to
 * prevent. What a read does not have is a state change to be atomic with.
 *
 * So this type is `auditedBatch`'s failure direction without `auditedBatch`'s premise, and `recordDisclosure`
 * below is the only way to append one. `audit` refuses these at compile time (it takes `StandaloneAction`),
 * which is what stops the never-throwing append being reached for on a read path by habit.
 *
 * `test/audit-coverage.test.ts` pins both sets exactly, so a fourth member of either cannot arrive quietly.
 */
export type DisclosureAction = {
  [K in AuditAction]: (typeof AUDIT_ACTIONS)[K] extends { disclosure: true } ? K : never;
}[AuditAction];

export interface AuditEvent<A extends AuditAction = AuditAction> {
  /** Constrained to the catalogue above: an undeclared action is a type error, not a silent category. */
  action: A;
  outcome: Outcome;
  actorUserId?: string | null;
  actorKind?: ActorKind;
  /**
   * The human accountable for an act a machine performed (#109 L1).
   *
   * **Not the actor.** `actorUserId` is the machine — a `btl_` or an `agt_` — and this is the person whose
   * authority it borrowed. A person acting for themselves leaves it absent, which is the common case and why
   * it is optional rather than nullable-with-a-default.
   *
   * It exists because the trail could not answer *"who was accountable for this"* about a Butler's act. The
   * sponsor was recoverable only by reading the Butler version's **current** `sponsor_user_id`, so the answer
   * changed when somebody reassigned the Butler months later — an audit trail whose answers move, outside the
   * chain that exists to stop exactly that.
   */
  delegatorUserId?: string | null;
  subject?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * What kind of thing an actor id names, when the caller did not say.
 *
 * **Derived from the id's own typed prefix**, which is the argument `0001_init.sql` makes for having no
 * `subject_type` column at all: identifiers are typed-prefix ULIDs, so a `btl_` already carries its type and
 * a second field can only disagree with it. `actor_kind` exists anyway because `node` and `installer` have
 * **no id** — nothing to derive a kind from — and that is the only reason it is a column.
 *
 * This is what makes a Butler's attribution structural rather than remembered (#50). Every audit entry a
 * Butler causes goes through a Layer 5 function that takes an `actorUserId` and knows nothing about
 * Butlers — `sealManifest` is the one that matters — so a design where each call site had to pass
 * `actorKind: "butler"` would be correct on the day it was written and wrong the first time a new effect
 * node called a fifth function. `test/butler-run.test.ts` asserts a real seal comes back `butler`.
 *
 * An explicit `actorKind` still wins, because two cases need one: a refusal recorded against no actor at
 * all, and the installer.
 */
function kindOfActor(actorUserId: string | null): ActorKind {
  if (actorUserId === null) return "node";
  /*
   * Derived from the prefix, which is why adding a principal kind is three lines rather than a mechanism.
   * The reasoning above generalises without change: a call site that had to pass the kind would be correct
   * the day it was written and wrong the first time a new caller appeared.
   */
  if (idPattern(ID_PREFIXES.butler).test(actorUserId)) return "butler";
  if (idPattern(ID_PREFIXES.agent).test(actorUserId)) return "agent";
  return "user";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The bytes that are hashed.
 *
 * Field order is fixed and explicit rather than derived from object iteration, because a hash whose
 * input depends on property order is a hash that changes when someone reorders an interface — and a
 * chain that breaks on a refactor teaches everyone to ignore it.
 */
function canonical(entry: {
  seq: number; at: string; actorUserId: string | null; actorKind: string;
  action: string; subject: string | null; outcome: string; detail: string | null;
  delegatorUserId?: string | null;
}): string {
  /*
   * The delegator is **appended, and only when there is one** (#109 L1).
   *
   * Appended rather than placed with the other actor fields, because the chain runs over rows already
   * written. A field inserted anywhere earlier changes the canonical string of every historical entry, so
   * recomputing their hashes would no longer match what is stored and `verify` would report the entire trail
   * tampered with — which is the one output this mechanism must never produce falsely. An entry with no
   * delegator appends nothing and hashes exactly as it did before the column existed.
   *
   * It carries its own separator for the same reason the join has one: `\x1f` cannot occur in a typed ULID
   * or in JSON detail, so appending it keeps the boundary unambiguous rather than trusting that no detail
   * string ever ends the way a delegator begins.
   */
  return [
    entry.seq, entry.at, entry.actorUserId ?? "", entry.actorKind,
    entry.action, entry.subject ?? "", entry.outcome, entry.detail ?? "",
  ].join("\x1f") + (entry.delegatorUserId == null ? "" : `\x1f${entry.delegatorUserId}`);
}

const UTF8 = new TextEncoder();

/** What the budget key says: UTF-8 bytes, not JavaScript string length. */
function utf8Bytes(text: string): number {
  return UTF8.encode(text).length;
}

/**
 * The longest prefix of `text` that costs at most `budget` bytes *once escaped into a JSON string*,
 * cut only between code points.
 *
 * Two ways to get this wrong, both of which were in the version this replaces:
 *
 * - `slice` counts UTF-16 code units, so it can cut between the halves of a surrogate pair and leave
 *   a head ending in a lone surrogate. Iterating with `for...of` yields whole code points, so the cut
 *   can only land between characters.
 * - a prefix measured raw does not stay within `budget` once it is escaped, because the head is
 *   re-escaped when the truncation record is stringified — a quote costs two bytes there, a control
 *   character six. So each code point is priced at what it will actually cost inside the record, and
 *   the price comes from `JSON.stringify` itself rather than from a table of escape rules restated
 *   here: a restated table is a claim that drifts away from the runtime that decides.
 */
function jsonHeadWithinBytes(text: string, budget: number): string {
  let spent = 0;
  let end = 0;
  for (const codePoint of text) {
    const cost = utf8Bytes(JSON.stringify(codePoint)) - 2; // minus the two quotes stringify adds.
    if (spent + cost > budget) break;
    spent += cost;
    end += codePoint.length; // 2 for an astral code point, so the pair moves as one unit.
  }
  return text.slice(0, end);
}

/**
 * Bounded, and bounded for a disclosure reason rather than a storage one: this table is read by whoever
 * may audit, which is a wider set than whoever may read the mail. An unbounded detail invites a subject
 * line or a token into a table with different access rules than the content it came from.
 *
 * Measured in **bytes**, which is what `audit.max_detail_bytes` claims and what the disclosure argument
 * needs. `text.length` counts UTF-16 code units, so a 2,048-unit Chinese subject or a run of emoji is up
 * to ~6 KiB of UTF-8 and used to pass a 2 KiB cap — a disclosure bound that a non-Latin script defeats by
 * 3x is not a bound. The truncation record is sized against the same unit, envelope included, so the
 * substitute cannot itself exceed the cap it is announcing. `test/audit.test.ts` holds both to the byte
 * count rather than to `String.length`, which is why the two units can no longer be confused here.
 */
function boundedDetail(detail: Record<string, unknown> | undefined): string | null {
  if (detail === undefined) return null;
  return boundedJson(JSON.stringify(detail), MAX_DETAIL);
}

/**
 * Would this detail be stored whole, or would `boundedDetail` replace it with a truncation record?
 *
 * Exported for exactly one caller — `buildSupervisedQuery` in `src/supervised.ts`, which splits a list of
 * returned ids across continuation entries so that none of them is ever truncated. Truncation there would
 * record a **prefix** of what a supervised reader saw and understate the exposure, which is the failure §7's
 * per-act recording exists to prevent (#63's correction worked the bound out at about 59 typed-prefix ULIDs).
 *
 * A predicate rather than the number, and that is the whole point of it being here: the splitter must not
 * restate the cap or the arithmetic. `34n + overhead <= 2048` is a computed figure in
 * `audit-and-log-retention.md` and it is right, but a second copy of it in a second file is a second thing to
 * drift when a sibling field is added to the detail. This asks the function that actually decides.
 */
export function detailFits(detail: Record<string, unknown>): boolean {
  return utf8Bytes(JSON.stringify(detail)) <= MAX_DETAIL;
}

/**
 * `text` if it fits `maxBytes` of UTF-8, otherwise a truncation record that also fits **when `maxBytes` is
 * at least the envelope**, which the two callers' budgets are by three orders of magnitude.
 *
 * The qualifier is not pedantry. Below ~41 bytes the `Math.max(0, …)` below clamps and this returns a record
 * *larger* than the cap it was asked to respect — a silent overrun, and the one degradation path this
 * function has. `MAX_DETAIL` and `LOG_MAX_DETAIL` are both 2,048, so it is unreachable today; it is stated
 * because an unconditional "also fits" would be a false claim with nothing checking it, and this file's
 * defect history is exactly that.
 *
 * Shared by the audit detail and the log detail because they are the same bound for the same reason and
 * both budget keys end in `_bytes`; one of them silently drifting to a different unit is exactly how this
 * defect arrived. Not exported: the tests go through `audit` and `log` and read the stored row, so what
 * they hold to the cap is what a reader of the table would actually get.
 */
function boundedJson(text: string, maxBytes: number): string {
  const bytes = utf8Bytes(text);
  if (bytes <= maxBytes) return text;

  // `bytes` is the real UTF-8 length of what was dropped, which is the only reason this record exists. A
  // code-unit count under a key spelled `bytes` is a wrong number ending the question a blank would have
  // prompted, so the test asserts this field against an encoder rather than against `String.length`.
  const record = { truncated: true, bytes, head: "" };
  const envelope = utf8Bytes(JSON.stringify(record));
  record.head = jsonHeadWithinBytes(text, Math.max(0, maxBytes - envelope));
  return JSON.stringify(record);
}

export interface AppendedEntry {
  id: string;
  seq: number;
  hash: string;
}

/** How many times to re-read the tip when another writer takes the slot first. */
const APPEND_ATTEMPTS = 5;

/** Whether a failure is another writer taking this org's next sequence number, rather than a real fault. */
function isSequenceRace(error: unknown): boolean {
  const message = (error as Error).message ?? "";
  // Named to `audit_entries` on purpose. A UNIQUE violation raised by the *caller's* statements is not
  // a race for the audit slot, and retrying it would silently repeat somebody else's failed write.
  return /UNIQUE constraint failed:\s*audit_entries/i.test(message);
}

/**
 * A condition the recorded act depends on.
 *
 * Some state changes are conditional — cancelling a send only does anything while it is still held —
 * and an entry recording an act that did not happen is worse than no entry, because it is a false
 * statement in the one place that is supposed to be checkable. Given a gate, the insert becomes
 * `INSERT ... SELECT ... WHERE EXISTS (<gate>)`, so the record and the change share one predicate
 * inside one transaction: either both happen or neither does.
 *
 * **The gated entry must be placed before the statements that change what it tests.** The batch runs
 * in order, so an update that clears the predicate first would leave the act done and unrecorded —
 * the exact failure this exists to prevent.
 *
 * A skipped insert consumes no sequence number, so the chain stays contiguous and verification is
 * unaffected. Callers read `meta.changes` to learn whether anything happened.
 */
export interface AuditGate {
  /** The body of an `EXISTS (...)`, e.g. `SELECT 1 FROM send_manifests WHERE id = ? AND state = 'held'`. */
  sql: string;
  params: unknown[];
}

/**
 * Builds the rows and the statements that insert them, against the chain as it stands right now.
 *
 * Separated from execution because the statements have to be handed to a caller's `batch()` — see
 * `auditedBatch`. The hashes are computed here, so they are bound to the tip that was read here; if another
 * writer wins the slot in between, the first insert fails on `UNIQUE(org_id, seq)` rather than producing a
 * second entry claiming the same position.
 *
 * **Several events chain to each other, not each to the tip.** Two acts that must not disagree land in one
 * `batch()` (a seal that requests an approval is the first — #61), and each entry takes the next sequence
 * number with the previous entry's hash as its predecessor. Reading the tip once and giving both entries
 * `seq = tip + 1` would be a UNIQUE violation against itself; giving the second one the tip's hash would break
 * verification at the second link. The whole batch is one transaction, so the chain stays contiguous whether
 * it commits or not.
 */
async function buildEntries(
  env: Env,
  ctx: Ctx,
  orgId: string,
  events: readonly AuditEvent[],
  gate?: AuditGate,
): Promise<{ statements: D1PreparedStatement[]; entries: AppendedEntry[] }> {
  const tip = await env.CATALOG.prepare(
    "SELECT seq, hash FROM audit_entries WHERE org_id = ? ORDER BY seq DESC LIMIT 1",
  )
    .bind(orgId)
    .first<{ seq: number; hash: string }>();

  const at = new Date(ctx.now()).toISOString();
  const columns =
    "(id, org_id, seq, at, actor_user_id, actor_kind, delegator_user_id, action, subject, outcome, "
    + "detail, prev_hash, hash)";

  const statements: D1PreparedStatement[] = [];
  const entries: AppendedEntry[] = [];
  let seq = tip?.seq ?? 0;
  let prevHash = tip?.hash ?? GENESIS;

  for (const event of events) {
    seq += 1;
    const actorKind: ActorKind = event.actorKind ?? kindOfActor(event.actorUserId ?? null);
    const detail = boundedDetail(event.detail);

    const fields = {
      seq, at,
      actorUserId: event.actorUserId ?? null,
      actorKind,
      delegatorUserId: event.delegatorUserId ?? null,
      action: event.action,
      subject: event.subject ?? null,
      outcome: event.outcome,
      detail,
    };
    const hash = await sha256Hex(prevHash + canonical(fields));
    const id = ctx.id("aud");

    const values = [id, orgId, seq, at, fields.actorUserId, actorKind, fields.delegatorUserId,
      event.action, fields.subject, event.outcome, detail, prevHash, hash];

    statements.push(gate === undefined
      ? env.CATALOG.prepare(`INSERT INTO audit_entries ${columns} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(...values)
      : env.CATALOG.prepare(
          `INSERT INTO audit_entries ${columns}
           SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (${gate.sql})`,
        ).bind(...values, ...gate.params));
    entries.push({ id, seq, hash });
    prevHash = hash;
  }

  return { statements, entries };
}

/**
 * Commits a state change and the entry that records it **in one transaction**.
 *
 * This is the shape every auditable state change should use, and the reason is that the alternative
 * has a hole verification cannot see. Writing the change and then appending the entry — which is what
 * this code did first — leaves a window where the isolate can die with the change committed and
 * nothing recording it. The hash chain does not help: it proves that what *was* written is unaltered
 * and says nothing about what was never written at all. Sequence numbers stay contiguous, verification
 * still reports `intact: true`, and the missing act is undetectable by construction.
 *
 * So the entry travels with the change. D1 runs a `batch()` as a single transaction, so either both
 * land or neither does.
 *
 * **This throws, and that inversion is deliberate.** `audit` below never throws, because a record of
 * something that already happened must not fail the request that happened. Here nothing has happened
 * yet, so the honest failure is the whole operation: if the Node cannot record the act, it does not
 * perform the act. Callers should let it propagate rather than catching it to proceed.
 *
 * The cost is real and worth stating: appends serialise on one sequence per organisation, so two
 * concurrent auditable changes contend, and the loser re-reads the tip and retries the whole batch.
 * That is inherent to hash-linking rather than a defect of this implementation — a chain is an order,
 * and an order is a serialisation. Mail volumes make it a fair trade.
 */
export async function auditedBatch<T = unknown>(
  env: Env,
  ctx: Ctx,
  orgId: string,
  event: AuditEvent,
  /** Receives the audit insert; returns the full batch, with that statement placed wherever it belongs. */
  build: (auditEntry: D1PreparedStatement) => D1PreparedStatement[],
  /** Makes the entry conditional. See `AuditGate` — the entry must precede what changes the predicate. */
  gate?: AuditGate,
): Promise<{ entry: AppendedEntry; results: D1Result<T>[] }> {
  const { entries, results } = await auditedBatchMany<T>(
    env, ctx, orgId, [event], (statements) => build(statements[0]!), gate,
  );
  return { entry: entries[0]!, results };
}

/**
 * The same contract for **two or more** acts that must not disagree, in one transaction.
 *
 * The case that needed it: a policy requiring approval means sealing a manifest and requesting an approval are
 * one indivisible act, and both are answerable — `send.sealed` says what the send is, `approval.requested` says
 * who is being asked what. Splitting them across two transactions would admit a gated send with no request to
 * decide, which is the state #60 refused to let `deny` occupy: waiting on something nobody can clear.
 *
 * The entries chain to each other (see `buildEntries`), take consecutive sequence numbers, and share one gate
 * if there is one — all of them insert or none does, which is what "one act" has to mean in the trail as well
 * as in the tables.
 *
 * `auditedBatch` is the one-event case and delegates here, so there is a single append-and-retry path rather
 * than two that could drift.
 */
export async function auditedBatchMany<T = unknown>(
  env: Env,
  ctx: Ctx,
  orgId: string,
  events: readonly AuditEvent[],
  /** Receives the audit inserts in order; returns the full batch with them placed where they belong. */
  build: (auditEntries: D1PreparedStatement[]) => D1PreparedStatement[],
  gate?: AuditGate,
): Promise<{ entries: AppendedEntry[]; results: D1Result<T>[] }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    const { statements, entries } = await buildEntries(env, ctx, orgId, events, gate);
    try {
      const results = await env.CATALOG.batch<T>(build(statements));
      return { entries, results };
    } catch (error) {
      lastError = error;
      // Somebody else took this sequence number. Nothing committed — that is what the transaction is
      // for — so re-reading the tip and rebuilding is safe rather than a partial repeat.
      if (!isSequenceRace(error)) throw error;
    }
  }
  throw lastError;
}

/**
 * Appends one entry on its own, for acts with no state change of their own to travel with.
 *
 * A refused sign-in and a lockout are decisions, not writes — there is nothing to be atomic *with*,
 * and the thing being recorded has already happened by the time this is called.
 *
 * Never throws, and that is the opposite contract from `auditedBatch` for a reason that only matters
 * under pressure: a record of a completed act that can fail its own request would make the log the most
 * dangerous component in the system, and the fix everyone reaches for is deleting the call rather than
 * repairing the cause. A failure to record is itself recorded, in the operational log, one level down,
 * where a `doctor` check can see it.
 *
 * Prefer `auditedBatch` whenever there *is* an accompanying write. This one cannot close the window it
 * is named for.
 */
export async function audit(
  env: Env,
  ctx: Ctx,
  orgId: string,
  /** Only a `standalone` action. Anything with an accompanying write must use `auditedBatch`. */
  event: AuditEvent<StandaloneAction>,
): Promise<AppendedEntry | null> {
  try {
    const { entry } = await auditedBatch(env, ctx, orgId, event, (statement) => [statement]);
    return entry;
  } catch (error) {
    await log(env, ctx, {
      level: "error",
      event: "audit.append_failed",
      message: `Could not record ${event.action}: ${(error as Error).message.split("\n")[0]}`,
      orgId,
      detail: { action: event.action, subject: event.subject ?? null },
    });
    return null;
  }
}

/**
 * Appends the entries that record a **disclosure**, and refuses the disclosure if it cannot.
 *
 * The whole of the contract is in what happens when the append fails: this throws, so the caller does not
 * return the mail. `audit` would have swallowed it and returned the bytes with nothing in the trail, which is
 * a supervised read that happened and cannot be shown to have happened — the defect #63 exists to prevent.
 *
 * The refusal is a `CallerError` rather than a bare throw so that it reaches the person as the four-part shape
 * AGENTS.md requires instead of an opaque 500. 503, because it is a statement about the Node rather than about
 * the request: the same request will work once the trail is writable.
 *
 * Several events land in **one** `batch()` and chain to each other, because a query whose id list needed
 * splitting is one act in several entries and a half-recorded act is worse than none — `auditedBatchMany`
 * already makes that all-or-nothing.
 */
export async function recordDisclosure(
  env: Env,
  ctx: Ctx,
  orgId: string,
  events: ReadonlyArray<AuditEvent<DisclosureAction>>,
): Promise<AppendedEntry[]> {
  if (events.length === 0) return [];
  try {
    const { entries } = await auditedBatchMany(env, ctx, orgId, events, (statements) => statements);
    return entries;
  } catch (error) {
    // Not a swallow: the operational log gets the cause, and the caller gets a refusal that names the act it
    // was refused for. Both halves are needed — one for the operator, one for the person holding the grant.
    await log(env, ctx, {
      level: "error",
      event: "supervised.record_failed",
      message: `Could not record ${events[0]!.action}: ${(error as Error).message.split("\n")[0]}`,
      orgId,
      detail: { action: events[0]!.action, subject: events[0]!.subject ?? null, entries: events.length },
    });
    throw unavailable("E_SUPERVISED_UNRECORDABLE", {
      what: `this Node could not record the ${events[0]!.action} entry for supervised grant `
        + `${events[0]!.subject ?? "(unnamed)"}, so it did not perform the read`,
      why: "§7 requires every supervised query, result opened and attachment read to be recorded. A read that "
        + "is not recorded is the one outcome supervised access exists to prevent, so the read fails with the "
        + "record rather than proceeding without it",
      fix: "read the log for supervised.record_failed — GET /api/log — and check the migrations_applied and "
        + "self_granted_access findings in GET /api/doctor. A Node that cannot append to audit_entries cannot "
        + "record any act, not only this one",
    });
  }
}

export interface ChainVerdict {
  checked: number;
  from: number;
  intact: boolean;
  /** The first entry whose hash does not follow. An investigation needs the link, not the verdict. */
  brokenAt: { seq: number; id: string; reason: string } | null;
  /** Where a caller should resume. Verification is batched because re-hashing is linear. */
  resumeFrom: number | null;
}

export async function verifyChain(env: Env, orgId: string, from = 1): Promise<ChainVerdict> {
  const rows = await env.CATALOG.prepare(
    `SELECT id, seq, at, actor_user_id, actor_kind, delegator_user_id, action, subject, outcome, detail,
            prev_hash, hash
       FROM audit_entries WHERE org_id = ? AND seq >= ? ORDER BY seq LIMIT ?`,
  )
    .bind(orgId, from, VERIFY_BATCH)
    .all<Record<string, string | number | null>>();

  if (rows.results.length === 0) {
    return { checked: 0, from, intact: true, brokenAt: null, resumeFrom: null };
  }

  // The predecessor of the first row in this batch, so batching does not create a false break.
  const before = from <= 1
    ? null
    : await env.CATALOG.prepare("SELECT hash FROM audit_entries WHERE org_id = ? AND seq = ?")
        .bind(orgId, from - 1)
        .first<{ hash: string }>();

  let expectedPrev = from <= 1 ? GENESIS : (before?.hash ?? null);
  let expectedSeq = from;

  for (const row of rows.results) {
    const seq = Number(row.seq);
    const id = String(row.id);

    if (expectedPrev === null) {
      return {
        checked: 0, from, intact: false, resumeFrom: null,
        brokenAt: { seq, id, reason: `entry ${from - 1} is missing, so this batch has no predecessor` },
      };
    }
    if (seq !== expectedSeq) {
      // A gap is what a deletion looks like. Named as such, because "missing" is the finding.
      return {
        checked: seq - from, from, intact: false, resumeFrom: null,
        brokenAt: { seq, id, reason: `sequence jumped from ${expectedSeq} to ${seq}: ${seq - expectedSeq} entr(ies) missing` },
      };
    }
    if (String(row.prev_hash) !== expectedPrev) {
      return {
        checked: seq - from, from, intact: false, resumeFrom: null,
        brokenAt: { seq, id, reason: "recorded predecessor hash does not match the previous entry" },
      };
    }

    const recomputed = await sha256Hex(expectedPrev + canonical({
      seq, at: String(row.at),
      actorUserId: row.actor_user_id === null ? null : String(row.actor_user_id),
      actorKind: String(row.actor_kind),
      action: String(row.action),
      subject: row.subject === null ? null : String(row.subject),
      outcome: String(row.outcome),
      detail: row.detail === null ? null : String(row.detail),
      /*
       * Read and re-hashed, which is the point of putting it in `canonical` at all: a delegator the chain
       * did not cover would be a field an operator with database access could rewrite without detection —
       * and "who was accountable" is precisely the answer somebody would want to change.
       *
       * Historical entries have null here and `canonical` appends nothing for null, so every hash written
       * before migration 0045 still recomputes to itself. That is the property that let this column be added
       * to a live chain at all.
       */
      delegatorUserId: row.delegator_user_id === null ? null : String(row.delegator_user_id),
    }));
    if (recomputed !== String(row.hash)) {
      return {
        checked: seq - from, from, intact: false, resumeFrom: null,
        brokenAt: { seq, id, reason: "entry was altered after it was written: its contents do not produce its hash" },
      };
    }

    expectedPrev = String(row.hash);
    expectedSeq = seq + 1;
  }

  return {
    checked: rows.results.length,
    from,
    intact: true,
    brokenAt: null,
    resumeFrom: rows.results.length === VERIFY_BATCH ? expectedSeq : null,
  };
}

/* ------------------------------------------------------------------ operational logging --------- */

const LOG_MAX_DETAIL = BUDGETS["log.max_detail_bytes"];
const LOG_RETAINED = BUDGETS["log.retained_entries"];
const LOG_TRIM_BATCH = BUDGETS["log.trim_batch"];

export interface LogEvent {
  level: "error" | "warn" | "info";
  event: string;
  message: string;
  orgId?: string | null;
  requestId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Records an operational event where the Node itself can read it.
 *
 * Before this, the only logging was `console.error` into Cloudflare's dashboard — so an operator had to
 * leave the product to find out why it misbehaved, and `doctor` could not see the Node's own failures
 * at all. §23 wants a trace; `requestId` is the smallest thing that is one.
 *
 * Never throws, for the same reason `audit` does not: logging that can fail a request is logging that
 * gets removed. A console line remains as the last resort, because a log write that fails still has to
 * go somewhere.
 */
export async function log(env: Env, ctx: Ctx, entry: LogEvent): Promise<void> {
  try {
    // Bytes, and truncated on a code-point boundary, for the same reasons as `boundedDetail` above:
    // `log.max_detail_bytes` says bytes, and a log line is where a non-ASCII subject or error string
    // lands. Sized with the record's own envelope counted, so the substitute fits the cap too.
    const text = entry.detail === undefined ? null : JSON.stringify(entry.detail);
    const detail = text === null ? null : boundedJson(text, LOG_MAX_DETAIL);

    await env.CATALOG.prepare(
      `INSERT INTO log_entries (id, org_id, at, level, event, message, detail, request_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
      .bind(ctx.id("log"), entry.orgId ?? null, new Date(ctx.now()).toISOString(),
        entry.level, entry.event, entry.message.slice(0, 2000), detail, entry.requestId ?? null)
      .run();
  } catch (error) {
    // The last resort. A failure to write the log cannot itself be written to the log.
    console.error("E_LOG_WRITE_FAILED", entry.event, (error as Error).message);
  }
}

/**
 * Trims to the retained bound, opportunistically.
 *
 * Called from a path that is already writing rather than on a schedule: a scheduled job is a second
 * thing that can fail silently, and a bounded trim on an existing path cannot drift out of step with
 * the thing it trims. Audit entries are **never** trimmed — a chain with a hole is not a chain.
 */
export async function trimLogs(env: Env): Promise<number> {
  // Never throws, for the same reason `log` does not — and found the hard way. On a Node with no
  // schema this table does not exist, so the trim rejected; it runs inside the unhandled-error
  // handler's own `waitUntil`, which turned "the request failed" into "the request failed and so did
  // the thing reporting it". A trim is housekeeping and must never be the loudest failure in the stack.
  const total = await env.CATALOG.prepare("SELECT COUNT(*) AS n FROM log_entries")
    .first<{ n: number }>()
    .catch(() => null);
  if (total === null) return 0;
  if ((total.n ?? 0) <= LOG_RETAINED) return 0;

  const result = await env.CATALOG.prepare(
    `DELETE FROM log_entries WHERE id IN (
       SELECT id FROM log_entries ORDER BY at ASC LIMIT ?
     )`,
  )
    .bind(LOG_TRIM_BATCH)
    .run()
    .catch(() => null);
  return result?.meta.changes ?? 0;
}
