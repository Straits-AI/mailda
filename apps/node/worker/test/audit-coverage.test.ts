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
      "send.suppressed", "send.handed_over", "send.outcome_unknown",
    ],
  },

  /* ---- exempt, each for a reason that has to survive being read aloud ---- */
  users: { exempt: "No mutation path exists yet. Becomes auditable the moment §28's user admin lands." },
  addresses: { exempt: "Set at claim time and never since; claim itself is audited by node_claim." },
  node_claim: { exempt: "One-time and self-evidencing: the row's existence is the record." },
  node_capabilities: { exempt: "A cache of what the platform allows, not a decision the Node made." },
  team_members: { exempt: "No mutation path exists yet. Auditable when membership admin lands (§28)." },
  relationship_tuples: { exempt: "No mutation path exists yet. Permission changes are audit-critical when they land." },
  mailboxes: { exempt: "No mutation path exists yet." },
  messages: { exempt: "Written by ingress from mail that arrived; the mail is its own evidence (§13)." },
  mailbox_items: { exempt: "Derived placement of an already-evidenced message, not an independent act." },
  ingress_receipts: { exempt: "The receipt *is* the audit record for arrival, and is hashed (§13)." },
  outbox: { exempt: "Internal work queue. Its effects are audited where they land, not on enqueue." },
  send_counters: { exempt: "Aggregate counters derived from send_manifests, which is audited." },
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
    const standalone = Object.entries(AUDIT_ACTIONS)
      .filter(([, meta]) => "standalone" in meta && meta.standalone)
      .map(([action]) => action)
      .sort();

    expect(standalone).toEqual(["auth.locked_out"]);
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
