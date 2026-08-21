import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "../src/audit.ts";

/**
 * Makes audit coverage structural rather than remembered.
 *
 * The audit trail shipped with eight call sites, all placed by hand. That is the landmine AGENTS.md
 * describes precisely: it is correct today and there is nothing to notice when it stops being correct.
 * The failure is silent by construction — a new state-changing action simply produces no entry, and an
 * empty audit trail looks exactly like a quiet week. Verification cannot help, because a hash chain
 * proves that what *was* recorded is unaltered; it says nothing about what was never recorded at all.
 *
 * So the guard is placed where new state actually enters the system: the schema. Every table is
 * classified — either changes to it are auditable and the actions that record them are named, or it is
 * exempt for a stated reason. A migration that adds a table fails this test until somebody decides
 * which it is, at the moment they still have the context to decide well.
 *
 * This does not prove the audit call is in the right place, or that it fires on every branch. No cheap
 * test does. It proves that nobody added state to this Node without being asked the question.
 */
const CLASSIFIED: Record<string, { actions: readonly string[] } | { exempt: string }> = {
  /* ---- auditable: a person may be asked to account for these ---- */
  signing_keys: { actions: ["key.rotated"] },
  refresh_tokens: { actions: ["auth.signed_in", "auth.revoked_all_sessions"] },
  sessions: { actions: ["auth.signed_in", "auth.revoked_all_sessions"] },
  login_attempts: { actions: ["auth.sign_in_failed", "auth.locked_out"] },
  send_manifests: {
    actions: [
      "send.sealed", "send.cancelled", "send.held", "send.throttled", "send.refused",
      "send.suppressed", "send.handed_over", "send.outcome_unknown", "send.withheld",
      /*
       * #66's rate gate, and it is on this table for the same reason `message.exported` is on
       * `ingress_receipts`: the entry's subject is the manifest id, so "what happened to this send" stays one
       * filter.
       *
       * **It is not `send.suppressed`**, which is one row above it and was the tempting reuse. That action is
       * the entry for the `suppressed` *state*, which `dispatch.ts` defines as "on the suppression list —
       * will never arrive, and that is knowable now". A rate gate claims the opposite on both halves: the
       * mail **will** arrive, and nothing about the recipient is known to be wrong. Filing a delay under a
       * name that means permanent non-arrival is the overclaim AGENTS.md §4 forbids — and it would have made
       * "how much mail did this Node discard" unanswerable from the trail, because the two would be
       * indistinguishable.
       *
       * It also carries a weight the other nine do not: every other send state can be reconstructed from
       * `send_manifests` itself, while a rate breaker keeps **no state at all** — the rows it counted will
       * have aged out of the window before anybody reads this. Un-audited, the trip never happened.
       */
      "send.rate_limited",
      /*
       * #50's release act, and it is the first thing in this Node that clears a gate without settling an
       * approval: a Butler-proposed send is sealed `awaiting` with `butler_release_required`, and a person
       * holding `send.propose` on the mailbox puts it back to `held`.
       *
       * Audited because it is plainly answerable — a program wrote a message and a named human decided it
       * could go — and the entry's actor is the **person**, never the Butler. That asymmetry is the whole
       * value of the gate: `send.sealed` already records the Butler as actor with `actor_kind = butler`, and
       * this records who agreed.
       *
       * Not `approval.decided`, which means an eligible approver settled a stage of a request with a decision
       * row behind it and separation of duty evaluated live. Filing this under the stronger name would make
       * "how often is dual control being exercised" unanswerable from the trail.
       */
      "send.released",
      /*
       * #53's two send-scoped replay modes, and they are two actions for the reason `send.rate_limited` is not
       * `send.suppressed`: a name that means the wrong thing makes a question unanswerable from the trail.
       *
       * `send.retried` is an `UPDATE` on this table — a send whose non-acceptance is *recorded* going back to
       * `held` under its original key — and it appends no `send.sealed` because nothing was composed.
       * `send.resent` accompanies an INSERT: the unprovable case mints a new manifest and a new key on
       * purpose, so `send.sealed` is appended for the new row and this rides beside it naming the **person**
       * who accepted that a second copy may arrive. Folding the two into one action with a flag would put the
       * safe act and the duplicate-risking one behind one filter, which is precisely the blur the two names
       * exist to prevent.
       */
      "send.retried",
      "send.resent",
    ],
  },

  /* ---- exempt, each for a reason that has to survive being read aloud ---- */
  /*
   * **Was exempt for "no mutation path exists yet. Becomes auditable the moment §28's user admin lands."**
   * This is that moment (#83), and the exemption's own sentence is what named it — the same way
   * `team_members`' exemption named #73.
   *
   * A Node had exactly one account, written once by `claimNode`, so there was nothing to audit. Now an
   * invitation can create one, and **an account is authority**: it is the subject every relation is granted
   * to, so a row appearing here without a trail would make "who let this person in" unanswerable from the
   * chain even though every grant to them is recorded.
   *
   * `access.joined` rather than `access.invited`, and the distinction is the point: the actor of this row's
   * creation is the **invited person**, redeeming a secret. `access.invited` is the administrator's separate
   * act, on `invitations` below. Filing both under one action would collapse "who let them in" and "when did
   * they arrive" into one fact, and the gap between the two is exactly the window a leaked invitation lives in.
   *
   * `claimNode`'s first user is still unaudited and deliberately so: `node_claim`'s exemption below covers
   * it, because that row's existence *is* the record and there is no chain yet to append to.
   */
  users: { actions: ["access.joined"] },
  /*
   * The administrator's half. Audited on both the mint and the withdrawal implied by a re-mint, because an
   * invitation is a **bearer credential for membership** — the only artefact in this product that lets
   * somebody become a principal — and one that was minted, handed somewhere and never redeemed is exactly
   * the thing an investigator needs to be able to ask about.
   */
  invitations: { actions: ["access.invited", "access.joined"] },
  addresses: { exempt: "Set at claim time and never since; claim itself is audited by node_claim." },
  node_claim: { exempt: "One-time and self-evidencing: the row's existence is the record." },
  node_capabilities: { exempt: "A cache of what the platform allows, not a decision the Node made." },
  /*
   * Audited rather than exempt, and the neighbour above is why the distinction matters.
   * `node_capabilities` caches what the platform allows; this row **hands this Node the ability to send as a
   * Cloudflare account**, which is authority somebody granted rather than a fact somebody observed.
   *
   * The entry names the account and the person and never the token — an audit trail that recorded a
   * credential would be a second place it lives, in the one table designed to be read widely and kept for
   * ever.
   */
  sending_transport: { actions: ["transport.configured"] },
  /*
   * A passkey is a **way into an account**, so both ends of its life are audited: `access.granted` is the
   * shape, not `auth.signed_in`. Using an existing credential is an operational event and stays in the log;
   * adding or removing one changes what somebody can do afterwards, which is what this table is for.
   */
  credentials: { actions: ["auth.passkey_registered", "auth.passkey_revoked"] },
  /*
   * Exempt, and the reason is the row's whole purpose. A challenge exists for seconds, is spent once and
   * deleted in the statement that spends it — so there is no state for an entry to describe by the time one
   * could be written, and auditing every ceremony would put one row in the permanent record for every
   * *attempt* to sign in, which the log already carries.
   */
  webauthn_challenges: { exempt: "Minted and deleted within one ceremony; nothing survives to be audited." },
  /*
   * **Was exempt for "no mutation path exists yet. Auditable when membership admin lands (§28)."** This is
   * that moment (#73), and the exemption's own sentence is what named it.
   *
   * Audited because **membership is authority**, which is the whole argument and is not the same argument the
   * table above it makes. `readableSubjects` resolves a principal to `[userId, ...teamIds]`, so a relation
   * held by a team is held by every member of it — which means adding somebody to a team can hand them a
   * mailbox's contents and a vote on somebody else's send **with no `access.granted` entry anywhere**.
   * Un-audited, an administrator grants a team once, in the trail, and then changes who that grant reaches for
   * ever, in silence. That is the question `relationship_tuples` is audited for, reached through a second door.
   *
   * The boundary is the one `case.claim_taken` drew — frequency and answerability — and membership is at the
   * far end of both: bounded by headcount and organizational change rather than by mail volume, and plainly
   * something somebody could be asked about. Nothing like an entry per claim.
   *
   * Both entries key their **subject** on the person rather than on the team, so "what authority did this
   * person get, and when" is one filter across `access.granted` and this. `team.member_removed` carries
   * `remaining`, because removing the last member is what makes a live team-scoped policy unsatisfiable and
   * that consequence is not otherwise attributable to an act.
   */
  team_members: { actions: ["team.member_added", "team.member_removed"] },
  /*
   * The team itself (#73). Two actions, and this is the harder classification of the pair.
   *
   * Creating a team confers **nothing** — an empty team with no tuples is a name — so the authority argument
   * that audits `team_members` does not reach here, and the frequency argument alone would exempt it. What
   * earns the entry is that there is no other entry riding in that transaction to answer for it: `policies` is
   * exempt two entries down *because* `policy.drafted` records the same act in the same batch, and a `teams`
   * row has no such neighbour. Exempting it would leave "where did this team come from" unanswerable.
   *
   * A rename earns its own action for a sharper reason: a team is granted to by **id** and chosen by a human
   * reading a **name**, so renaming "Interns" to "Finance" changes what the next administrator believes they
   * are granting `approval.decide` to. The entry carries both names, which is why there is no `renamed_at`
   * column — a column could say when and never from what.
   *
   * There is deliberately no `team.deleted` and no `team.archived`: migration 0032 refuses both acts, because
   * a team is a tuple subject and deleting the row would leave grants conferring nothing while still reading
   * as grants. A declared action nothing emits is a category of one, which the last assertion in this file
   * fails on.
   */
  teams: { actions: ["team.created", "team.renamed"] },
  mailboxes: {
    // Was exempt for "no mutation path exists yet". A mailbox's first-response target is now settable, and
    // it is the one thing about a mailbox anybody can change — because it is a **promise to customers**
    // rather than a preference, and a breach recorded against it is a fact somebody may be asked about.
    // Creating and archiving mailboxes are still unbuilt; when they land they join this list rather than
    // moving the table back.
    actions: ["mailbox.response_target_set"],
  },
  messages: { exempt: "Written by ingress from mail that arrived; the mail is its own evidence (§13)." },
  mailbox_items: { exempt: "Derived placement of an already-evidenced message, not an independent act." },
  ingress_receipts: {
    // **Was exempt, and the exemption was about the wrong direction.** "The receipt *is* the audit record for
    // arrival" is still true — nothing writes this table except mail arriving, and §13 hashes it — but #65
    // added an act *about* a receipt that leaves no row anywhere: downloading the original `.eml`, which is a
    // complete RFC822 copy going off the Node. Arrival is self-evidencing; departure is not, and it was
    // unrecorded until now.
    //
    // Classified here because this is the table the act is about — `message.exported`'s subject is the
    // receipt id, which is what makes "who has taken a copy of this message" one filter. The `hold.blocked`
    // and `supervised.query` shape: no write, and the table it belongs to is the one it names.
    actions: ["message.exported"],
  },
  outbox: { exempt: "Internal work queue. Its effects are audited where they land, not on enqueue." },
  send_counters: { exempt: "Aggregate counters derived from send_manifests, which is audited." },
  send_recipients: {
    exempt:
      "Derived from the manifest and from provider events, not from anything a person did. The acts are " +
      "already audited on send_manifests (send.sealed through send.handed_over), and one audit entry per " +
      "recipient would put up to email.max_recipients_per_message entries behind one human action — " +
      "falsifying audit-and-log-retention.md's 'a handful per message' sizing as a side effect of a UI " +
      "improvement.",
  },
  send_recipient_events: {
    exempt:
      "A verbatim log of what the provider told this Node. Auditing an observation would be recording " +
      "that we heard something, which the row already is; and the events arrive from a queue with no " +
      "actor to attribute them to.",
  },
  /*
   * #66's latched breaker, and the pair of actions is the asymmetry rather than a lifecycle.
   *
   * `domain.pause_placed` rides beside the one `UPDATE domain_pauses` that sets `placed_at`, inside
   * `approveStatements` — so a domain whose mail stopped with nothing in the trail is not representable, the
   * property `hold.lifted` and `supervised.granted` get from the same placement. `domain.pause_lifted` rides
   * beside the single conditional UPDATE that clears it.
   *
   * There is deliberately **no** `domain.pause_requested`, for `hold.lift_requested`'s reason: requesting a
   * pause **is** requesting an approval, and `approval.requested` records it in the same transaction as the
   * row, with the domain, the reason, the stages and the eligible count in its detail. A second action for
   * one transaction would make "who asked to stop this domain" answerable from two places that can disagree.
   */
  domain_pauses: { actions: ["domain.pause_placed", "domain.pause_lifted"] },

  /* ---- Layer 4: the Butler object (#49) ---- */
  butlers: {
    // The name and its creation. Both acts on this table happen in the same transaction as a version row,
    // so both are already named by the version's own classification below — but the table is classified
    // here rather than exempted, because "created by whom" is a question about the Butler and not about a
    // version of it, and `butler.drafted`'s subject is the Butler id for exactly that reason.
    actions: ["butler.drafted"],
  },
  /* ---- Layer 4: the Butler engine (#50) ---- */
  butler_runs: {
    /*
     * **Audited in exactly one direction, and the exemption that used to stand here is the argument for it.**
     *
     * This table was exempt because a run is caused by a *delivery*: nobody decided it, every act inside it
     * that somebody could be asked about is audited where it happens (`send.sealed` with the Butler as actor,
     * `send.released` naming the person), and what the row adds is execution state — started, parked,
     * finished, refused, what it spent — which is nobody's act. A `butler.ran` action would have put one
     * untrimmable entry per delivery per published Butler behind a fact the row already carries, falsifying
     * audit-and-log-retention.md's "a handful per message" sizing exactly as an entry per claim or per export
     * page would.
     *
     * Every word of that still holds for a run a delivery caused, and none of it holds for a **replay** (#53).
     * A named person decided to run a program again that proposes mail — the first act in this product that
     * deliberately repeats an effect on the outside world — and it happens as often as a human clicks. So
     * `butler.replayed` is written for a replay's INSERT and nothing is written for an ordinary run's, which
     * is the same frequency-and-answerability boundary `cases` draws between a claim and a claim *taken*.
     *
     * The entry rides in `auditedBatch` with that INSERT rather than beside the `create()` that follows it,
     * because `auditedBatch`'s contract is the one this act needs: if the Node cannot record it, it does not
     * happen. Faults and refusals still go to `log_entries`.
     */
    actions: ["butler.replayed"],
  },
  butler_run_effects: {
    exempt:
      "One row per effect a run performed, and per refusal. Same reasoning as `send_recipients`, reached "
      + "from the automation side: these rows are **derived from** acts that are audited elsewhere — the "
      + "manifest, the draft, the case — and an audit entry per row would put up to butler.fanout worth of "
      + "entries behind one delivery. The unaudited effects here are `case.assign` and `case.close`, and "
      + "they are unaudited for people too: `cases` names only `case.claim_taken`, because claiming is "
      + "frequent and only taking work off a *named colleague* is answerable. A Butler's claim is an "
      + "ordinary claim by a non-human principal, and this table is where it is answerable.",
  },
  /*
   * #75's latched breaker, and its pair of actions is a **third** asymmetry rather than a copy of either
   * earlier one.
   *
   * `butler.paused` rides beside the one INSERT that creates the row, inside `auditedBatch` with the same
   * predicate as the insert — so a Butler that stopped with nothing in the trail is not representable. Its
   * actor is `null`, which `kindOfActor` renders as `node`: the machine placed it, in the sweeper's
   * invocation, and neither the Butler (which did not stop itself) nor its publisher (who is not present)
   * decided anything. `butler.resumed` rides beside the single conditional UPDATE that clears it.
   *
   * There is deliberately **no** `butler.pause_requested` — nobody requests one, because no human placement
   * path exists (migration 0029 says so and says what a person can do instead) — and no action for *"a paused
   * Butler was passed over"*, which is the absence of an act and happens once per delivery per paused Butler.
   * `TriggerOutcome.paused` names those for the caller and `doctor`'s `butler_paused` puts them in front of a
   * person.
   */
  butler_pauses: { actions: ["butler.paused", "butler.resumed"] },

  butler_versions: {
    // Auditable for a reason the other frozen-history table shares: a published version is the program a
    // run binds, so "who published this, and when" is a fact somebody could be asked about. There is
    // deliberately no `butler.edited` — an edit *is* a draft — and no run action: a run is not an act, and
    // every act inside one that somebody could be asked about is audited where it happens. That second half
    // used to read "because nothing runs a Butler yet", which stopped being true when #50 landed; the
    // conclusion survived the premise, and it is restated here rather than left resting on a dead one.
    actions: ["butler.drafted", "butler.published"],
  },

  /* ---- Layer 3 ---- */
  cases: {
    // The only audited case act is having one taken from you. Claiming and releasing are deliberately
    // absent: people do them all day, audit entries are never trimmed, and this receipt sizes the table at
    // a handful per message — so an entry per claim grows it without bound. Claim history lives on the row.
    // The boundary is frequency and answerability, not importance.
    actions: ["case.claim_taken"],
  },
  conversations: {
    // The exemption anticipated exactly this and named it: automatic grouping is arithmetic and stays
    // unaudited, while **merging** is a person deciding two threads are one thing. That act now exists, so
    // the table moves from exempt to audited — and the boundary is unchanged, which is the point. A row
    // created by the root-match rule produces no entry; a row a person merged away produces one.
    actions: ["conversation.merged"],
  },
  relationship_tuples: {
    // Was exempt for "no mutation path exists yet". This is that path (#39).
    actions: ["access.granted", "access.revoked"],
  },
  drafts: {
    exempt:
      "Unfinished work, and the only write path in this Node a person triggers by *typing* rather than by " +
      "deciding. The composer autosaves on a pause, so auditing it would put dozens of entries behind one " +
      "human action and falsify audit-and-log-retention.md's 'a handful per message' sizing — the same " +
      "reasoning that exempts send_recipients, reached from the opposite direction. A draft also has no " +
      "effect anybody outside this Node can observe: the act that does is send.sealed, which is audited, " +
      "and the draft is deleted at that moment precisely so it cannot become a second account of the same " +
      "message. What would change this is a draft becoming shareable — Layer 3's question — because then " +
      "reading somebody else's unfinished writing is an act a person could be asked about.",
  },
  /* ---- Layer 5 ---- */
  holds: {
    // `hold.placed` is a write to this table. `hold.blocked` is **not** — nothing is written when a deletion
    // is refused — and it is classified here anyway, because this is the table the act is *about*: the entry's
    // subject is the hold id, and the hold is what refused. The alternative was to hang it off `drafts` and
    // `cases`, which would make an exempt table audited for an act that never touches it and would have to be
    // repeated on every table a future call site protects.
    //
    // `hold.lifted` is the third, and it is a write to this table: the `UPDATE holds` that sets `lifted_at`,
    // `lifted_reason` and `lift_id`, in the same transaction as the entry. It was absent while nothing could
    // emit it — a declared action nothing emits is a category of one, which the last assertion in this file
    // fails on — and it arrived with the act rather than before it.
    actions: ["hold.placed", "hold.blocked", "hold.lifted"],
  },
  hold_lifts: {
    // A request to lift a hold, and **the act that writes it is already audited**: `requestHoldLift` inserts
    // this row in the same transaction as the `approval.requested` entry, whose detail names the hold, the
    // request and the reason. A `hold.lift_requested` action beside it would make "who asked to lift this
    // hold" answerable from two places that can disagree — the reasoning that gives `cancelSend` one entry
    // for the manifest and the approval it settles, reached from the other direction.
    //
    // Not exempt, because the act plainly is answerable: somebody asked for destruction to be re-permitted.
    // The entry that records it just belongs to the approval, which is what the request *is*.
    actions: ["approval.requested"],
  },
  policies: {
    exempt:
      "A name and its owner, written once when the policy is first drafted and never again. Every "
      + "consequential act is on its versions: `policy.drafted` records the write that created this row in "
      + "the same transaction, and `policy.published` records what became live. Auditing the shell as well "
      + "would put two entries behind one act and make 'who created policy X' answerable from two places "
      + "that could disagree.",
  },
  policy_versions: {
    // Both a draft write and a publication are writes to this table, and both are audited. The boundary is
    // the same one that exempts `drafts` and it argues the opposite way here: a composer draft is somebody
    // typing, autosaved on a pause; a policy draft is an administrator writing a rule that will decide
    // whether other people's mail may leave. Rare, and answerable.
    //
    // Separation of duty (§18) is what makes the draft entry load-bearing rather than tidy: the person who
    // drafted and the person who published may deliberately differ, so a trail carrying only the
    // publication cannot answer who wrote what was published.
    //
    // There is no `policy.unpublished` or `policy.retired`, and that is a decision rather than an omission:
    // #60 builds draft and publish and nothing else, and a declared action nothing emits is a category of
    // one — which the last assertion in this file fails on.
    actions: ["policy.drafted", "policy.published"],
  },
  policy_stages: {
    exempt:
      "The stages of a policy version, written and replaced only by the same two transactions that write the "
      + "version itself — `policy.drafted` and `policy.published` already record those acts, and the stages are "
      + "part of the version's frozen content rather than an object with its own lifecycle. A third entry "
      + "saying the same edit happened would make \"who changed the review chain\" answerable from two places "
      + "that could disagree, which is the reasoning that exempts `policies` one table up.",
  },
  approvals: {
    // Every act on this table is audited, and the boundary is the one `case.claim_taken` established:
    // frequency and answerability. An approval decision is at the far end of that scale — rare, consequential,
    // and about somebody else's judgement.
    //
    // `approval.requested` is here even though the seal that causes it is already audited, because its subject
    // is the approval and its detail is the stage set: it records that *people are being asked*, which
    // `send.sealed` cannot say without becoming an entry about two things. See src/audit.ts.
    //
    // There is no `approval.expired` and no `approval.revoked` — #62 owns both reasons and neither act exists,
    // and a declared action nothing emits is a category of one, which the last assertion in this file fails on.
    //
    // `send.cancelled` is here because `cancelSend` settles a pending approval in the same transaction as the
    // manifest it cancels. No fourth action: cancelling is one act with one record, and a second entry saying
    // the request went with the send would make "why is this request closed" answerable from two places.
    //
    // These four cover **every subject kind**, which is the whole return on generalising this table from a
    // manifest to a subject (0021): a hold lift is requested, decided and withdrawn by the same three acts,
    // so the trail grew one action for the lift's *effect* (`hold.lifted`, on `holds`) and none for its
    // lifecycle.
    actions: ["approval.requested", "approval.decided", "approval.withdrawn", "send.cancelled"],
  },
  approval_stages: {
    exempt:
      "The stage set frozen at request time, written in the same transaction as the `approvals` row it belongs "
      + "to and never touched again. `approval.requested` records the act and names the counts in its detail, "
      + "so auditing these rows separately would put one entry per stage behind one request — the same "
      + "per-row-versus-per-act reasoning that exempts `send_recipients`.",
  },
  approval_decisions: {
    // Both writes to this table are acts by a person: taking a decision, and taking one back. Deciding is
    // audited as `approval.decided` and withdrawing as `approval.withdrawn`, each in the same transaction as
    // the row.
    actions: ["approval.decided", "approval.withdrawn"],
  },
  matters: {
    // Both writes are acts by a person and both are audited in the same transaction as the row. The close
    // earns its own action rather than being folded into the open, because §7 makes the notice to the people
    // whose mail was read due **after** the close — so "when did this matter end, and who ended it" is the
    // question the obligation is computed from. `closeMatter` deliberately lets an `org.admin` close somebody
    // else's matter, precisely because the investigator is the party with a reason to leave it open, which
    // means the closer and the opener can differ and one entry could not answer for both.
    actions: ["matter.opened", "matter.closed"],
  },
  supervised_grants: {
    // The `INSERT` rides with `approval.requested` — asking for a supervised read **is** asking for an
    // approval, and that entry's detail names the mailbox, the scope, the matter and the deadline. The one
    // `UPDATE` that sets `granted_at` rides with `supervised.granted`, which is where §7's question is
    // answered: who was let into whose mailbox, how much of it, under what matter, until when, and which two
    // people agreed. Exactly the split `hold_lifts` and `holds` already use, one table apart.
    //
    // There is no `supervised.denied` and no `supervised.expired`: a denial is `approval.decided` with
    // `outcome: "refused"`, and an expiry is not an act anybody took — the read path simply stops matching.
    // A declared action nothing emits is a category of one, which the last assertion in this file fails on.
    // The three supervised **acts** are here too, and they are the `hold.blocked` shape: they write nothing.
    // They are classified against this table because it is the table they are *about* — each entry's subject
    // is the grant id, which is what makes "everything done under grant G" one filter — and hanging them off
    // `ingress_receipts` or `messages` instead would make two exempt tables audited for acts that never touch
    // them, and would have to be repeated on every table a future read path discloses from.
    //
    // Unlike `hold.blocked` they are **not** `standalone`: a refusal that cannot be recorded still refuses,
    // and that is the safe direction; a *disclosure* that cannot be recorded must not happen at all. See the
    // `disclosure` classification in src/audit.ts and the assertion below.
    actions: [
      "approval.requested", "supervised.granted",
      "supervised.query", "supervised.opened", "supervised.attachment",
    ],
  },
  notifications: {
    // The obligation to tell somebody something (#63 part B, #61). Both writes ride with an act that is
    // already audited and cannot be separated from it: the §7 notice is inserted in the same transaction as
    // the `UPDATE supervised_grants` that `supervised.granted` records, and #61's approval-request notices in
    // the same transaction as `approval.requested`. **That is the point of the table**, not an economy — a
    // grant without its notice, or a request nobody was told about, is not a state this Node can reach.
    //
    // A `notification.delivered` action would be the one thing that could be added and is deliberately not:
    // the cron delivers, so the actor is the Node, and `delivered_at` on the row already says when. An entry
    // per delivery would put one audit row behind every notice for a fact the row itself carries — the
    // per-row-versus-per-act reasoning that exempts `send_recipients`, and it would be an entry with no
    // person to answer for it.
    actions: ["supervised.granted", "approval.requested"],
  },
  exports: {
    // #65. Four actions, and the split is the same one `supervised_grants` uses one table over: the `INSERT`
    // rides with `approval.requested`, because asking for an export **is** asking for an approval and that
    // entry's detail already names the mailbox, the matter, the predicate hash and the bound. The terminal
    // writes each get their own action, because each answers a different question an investigation asks —
    // what two people authorized, what actually left, and what was refused.
    //
    // The **page** writes are deliberately unaudited, and that is the interesting classification here: an
    // export advances `cursor_after`, `pages_done` and `messages_emitted` once per page with no entry. One
    // entry per page would put hundreds of rows behind one act and falsify `audit-and-log-retention.md`'s "a
    // handful per message" sizing — the same per-row-versus-per-act reasoning that exempts `send_recipients`
    // and `approval_stages`. What makes it safe rather than a gap is that progress is not an act somebody
    // could be asked about: `supervised.export_completed` names the manifest hash and the emitted count, so
    // the trail says exactly what was copied without narrating how many invocations it took.
    //
    // There is no `supervised.export_downloaded`: the manifest is the list of what was staged and the
    // completion entry names its hash, so an entry per object retrieved would be the same per-row mistake at
    // the other end of the pipe. `docs/ediscovery-export.md` names it under "Still not built".
    actions: [
      "approval.requested", "supervised.export_requested", "supervised.export_completed",
      "supervised.export_aborted",
    ],
  },
  log_entries: { exempt: "The operational log. Auditing it would recurse and it is trimmed by design." },
  audit_entries: { exempt: "The trail itself. Self-reference is what the hash chain is for." },
  d1_migrations: { exempt: "Written by the platform's migration runner, not by this Node." },
};

async function liveTables(): Promise<string[]> {
  const rows = await env.CATALOG.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
      ORDER BY name`,
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

describe("audit coverage", () => {
  it("classifies every table that exists, so new state cannot arrive unclassified", async () => {
    const live = await liveTables();
    const unclassified = live.filter((table) => CLASSIFIED[table] === undefined);

    // If this fails, a migration added a table. Decide, in test/audit-coverage.test.ts: do changes to
    // it need to be accountable to a person? Name the actions that record them, or write the reason
    // they are exempt. Do not delete the table from the list to make this pass.
    expect(unclassified).toEqual([]);
  });

  it("has no classification for a table that no longer exists", async () => {
    const live = new Set(await liveTables());
    // A stale entry is the same landmine pointing the other way: it reads as coverage of something
    // that is not there, and hides the fact that its replacement was never classified.
    expect(Object.keys(CLASSIFIED).filter((table) => !live.has(table))).toEqual([]);
  });

  it("names only actions that the catalogue declares", () => {
    const declared = new Set(Object.keys(AUDIT_ACTIONS));
    const named = Object.entries(CLASSIFIED).flatMap(([table, entry]) =>
      "actions" in entry ? entry.actions.map((action) => `${table} -> ${action}`) : [],
    );
    expect(named.filter((pair) => !declared.has(pair.split(" -> ")[1]!))).toEqual([]);
  });

  it("leaves no declared action unclaimed by any table", () => {
    const claimed = new Set(
      Object.values(CLASSIFIED).flatMap((entry) => ("actions" in entry ? entry.actions : [])),
    );
    // An action nothing claims is either dead, or evidence that the table it covers was never
    // classified. Both are worth a failure.
    expect(Object.keys(AUDIT_ACTIONS).filter((action) => !claimed.has(action))).toEqual([]);
  });

  it("keeps the set of non-transactional actions to the ones deliberately chosen", () => {
    // `standalone: true` is the one remaining way to record an action outside the transaction that
    // carries out the act, which is the shape the atomicity work exists to remove. The compiler stops
    // it being reached by accident (`audit` takes only StandaloneAction); this stops it being *added*
    // without anyone noticing.
    //
    // A lockout earns it by changing nothing: it is a refusal, and by the time it is recorded the
    // decision is already made. If a new action appears below, the question to answer is whether it
    // really has no accompanying write — and if it has one, it belongs in `auditedBatch` instead.
    //
    // `hold.blocked` earns it the same way and by the same test: a deletion refused by a legal hold writes
    // **nothing**, so there is no transaction for the entry to ride in, and demanding one would mean
    // inventing the state change this refusal exists to prevent. The asymmetry that makes it safe is
    // `audit`'s never-throwing contract: a Node that cannot record the refusal still refuses, which for a
    // preserving act is the correct direction to fail in.
    const standalone = Object.entries(AUDIT_ACTIONS)
      .filter(([, meta]) => "standalone" in meta && meta.standalone)
      .map(([action]) => action)
      .sort();

    expect(standalone).toEqual(["auth.locked_out", "hold.blocked"]);
  });

  it("keeps the set of disclosure actions to the ones deliberately chosen", () => {
    /*
     * The third classification (#63 part B), pinned for the same reason `standalone` is.
     *
     * `disclosure: true` means *this act writes nothing and must not happen unless it is recorded* — the
     * opposite failure direction from `standalone`, and the one a read needs. `recordDisclosure` throws where
     * `audit` swallows, so a Node that cannot append does not hand over the bytes.
     *
     * If a new action appears below, the question to answer is whether it really is a disclosure with no
     * accompanying write. If it has a write, it belongs in `auditedBatch`; if it is a refusal that changes
     * nothing, it belongs in `standalone`, where a Node that cannot record still refuses.
     */
    const disclosure = Object.entries(AUDIT_ACTIONS)
      .filter(([, meta]) => "disclosure" in meta && meta.disclosure)
      .map(([action]) => action)
      .sort();

    // `message.exported` is the fourth (#65), and it earns the classification the same way: taking a copy of
    // a message off this Node writes nothing, and a copy that could not be recorded must not be handed over.
    // It is the one disclosure action emitted for an **ordinary** reader as well as a supervised one, which
    // is the point — the three above only ever fire under a grant, so the question "who has a copy of this
    // message" was unanswerable for everybody who held the plain relation.
    expect(disclosure).toEqual([
      "message.exported", "supervised.attachment", "supervised.opened", "supervised.query",
    ]);
  });

  it("gives every exemption a reason long enough to have needed thought", () => {
    const thin = Object.entries(CLASSIFIED)
      .filter(([, entry]) => "exempt" in entry && entry.exempt.trim().length < 25)
      .map(([table]) => table);
    // "n/a" is not a reason. This does not check that the reason is *good* — a reader does that —
    // only that somebody was made to write one.
    expect(thin).toEqual([]);
  });
});
