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
    ],
  },

  /* ---- exempt, each for a reason that has to survive being read aloud ---- */
  users: { exempt: "No mutation path exists yet. Becomes auditable the moment §28's user admin lands." },
  addresses: { exempt: "Set at claim time and never since; claim itself is audited by node_claim." },
  node_claim: { exempt: "One-time and self-evidencing: the row's existence is the record." },
  node_capabilities: { exempt: "A cache of what the platform allows, not a decision the Node made." },
  team_members: { exempt: "No mutation path exists yet. Auditable when membership admin lands (§28)." },
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
  ingress_receipts: { exempt: "The receipt *is* the audit record for arrival, and is hashed (§13)." },
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

    expect(disclosure).toEqual(["supervised.attachment", "supervised.opened", "supervised.query"]);
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
