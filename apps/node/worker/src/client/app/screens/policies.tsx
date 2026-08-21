import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import {
  createPolicy, publishPolicyVersion, savePolicyDraft, useMailboxes, usePolicies,
  type PolicyConditions, type PolicyVersionRow,
} from "../api.ts";

/**
 * The rules that decide what happens to a message before it leaves (#60, #81).
 *
 * ## Why this screen reads as sentences rather than as a form
 *
 * A policy is a rule somebody will be held to. `outcome: require_approval, when_recipient_external: 1`
 * is accurate and tells a reader nothing about what their organization does; *"mail to anyone outside needs
 * an approval before it goes"* is the same fact in the form a person can check against their intent. So the
 * list renders each rule as a sentence and the editor builds one as you change it. The words are assembled
 * from the same five columns the evaluator reads, so a sentence cannot describe a condition that is not
 * there.
 *
 * ## Five conditions, and the screen cannot offer a sixth
 *
 * #60 stored the conditions as **typed columns** rather than a JSON blob, precisely because a blob would
 * admit a sixth condition nothing evaluates. That decision is what lets this screen be honest: it offers
 * exactly the five that exist, and the blueprint's other eight dimensions are absent here for the same
 * reason they are absent from the table — nothing would read them.
 *
 * ## What is deliberately not offered
 *
 * **No delete.** A policy version is evidence about why a message was gated, and publication is the
 * versioning event. Superseding is how a rule stops applying; removing the record of one that once did
 * would make an old send's `policy_versions` cite a rule nobody can read.
 *
 * **No preview against real mail.** "Which of my messages would this have denied" is a genuinely useful
 * question and answering it here would mean a second implementation of `evaluate`, in the browser, against
 * data the browser would have to be given. The evaluator runs at seal and its decision is recorded on the
 * manifest; that is the answer, and it is one the outbox already shows.
 */

const OUTCOMES = ["allow", "hold", "require_approval", "deny"] as const;

const OUTCOME_WORDS: Record<PolicyVersionRow["outcome"], string> = {
  allow: "goes as normal",
  hold: "is held for a person to release",
  require_approval: "needs an approval before it goes",
  deny: "is refused",
};

/** The rule as a sentence, built from the same columns the evaluator reads. */
function sentence(row: PolicyVersionRow, mailboxName: (id: string) => string): string {
  const when: string[] = [];
  if (row.when_mailbox_id !== null) when.push(`from ${mailboxName(row.when_mailbox_id)}`);
  if (row.when_actor_user_id !== null) when.push(`written by ${row.when_actor_user_id}`);
  if (row.when_recipient_external !== null) {
    when.push(row.when_recipient_external === 1 ? "to anyone outside" : "to colleagues only");
  }
  if (row.when_is_reply !== null) when.push(row.when_is_reply === 1 ? "as a reply" : "as a new message");
  if (row.when_org_daily_volume_min !== null) {
    when.push(`once this Node has sent ${row.when_org_daily_volume_min} today`);
  }
  // No conditions is a rule that matches everything, and saying so plainly is the point: it is the most
  // consequential shape a policy can have and the easiest to write by accident.
  const clause = when.length === 0 ? "Every message" : `Mail ${when.join(", ")}`;
  return `${clause} ${OUTCOME_WORDS[row.outcome]}.`;
}

function when(at: string | null): string {
  return at === null ? "—" : new Date(at).toLocaleString();
}

/** The editor. One draft per policy, so this is *the* draft rather than one of several. */
function Editing({
  policyId, name, draft, onDone,
}: {
  policyId: string | null;
  name: string;
  draft: PolicyVersionRow | null;
  onDone: () => Promise<void>;
}) {
  const [outcome, setOutcome] = useState<string>(draft?.outcome ?? "require_approval");
  const [title, setTitle] = useState(name);
  const [conditions, setConditions] = useState<PolicyConditions>({
    mailboxId: draft?.when_mailbox_id ?? null,
    recipientExternal: draft?.when_recipient_external === null || draft === null
      ? null
      : draft.when_recipient_external === 1,
    isReply: draft?.when_is_reply === null || draft === null ? null : draft.when_is_reply === 1,
  });
  const [approvals, setApprovals] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mailboxes = useMailboxes();

  async function save() {
    setBusy(true);
    setProblem(null);
    // Stages travel only for `require_approval`. Sending them with `deny` would be describing a review of a
    // decision nothing reviews, and the Node refuses it — better not to ask.
    const stages = outcome === "require_approval" ? [approvals] : [];
    const outcomeOf = policyId === null
      ? await createPolicy(title, outcome, conditions, stages)
      : await savePolicyDraft(policyId, outcome, conditions, stages);
    setBusy(false);
    if (!outcomeOf.ok) { setProblem(outcomeOf.message); return; }
    await onDone();
  }

  return (
    <section className="policy-editor" aria-label={policyId === null ? "New rule" : `Rule ${name}`}>
      <h2>{policyId === null ? "New rule" : name}</h2>
      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{problem}</pre>}

      {policyId === null ? (
        <label className="field-row" htmlFor="policy-name">
          <span>What is this rule called?</span>
          <input id="policy-name" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
      ) : null}

      <label className="field-row" htmlFor="policy-mailbox">
        <span>Which mailbox?</span>
        <select
          id="policy-mailbox"
          value={conditions.mailboxId ?? ""}
          onChange={(event) => setConditions((c) => ({
            ...c, mailboxId: event.target.value === "" ? null : event.target.value,
          }))}
        >
          <option value="">any mailbox</option>
          {(mailboxes.data?.mailboxes ?? []).map((box) => (
            <option key={box.id} value={box.id}>{box.name}</option>
          ))}
        </select>
      </label>

      {/*
        Three states per condition, not two. "Not part of this rule" is different from "must be false", and a
        checkbox cannot say both — `when_recipient_external` is nullable for exactly that reason, and a
        two-state control would silently turn every unticked box into a condition the evaluator now reads.
      */}
      <label className="field-row" htmlFor="policy-external">
        <span>Who is it going to?</span>
        <select
          id="policy-external"
          value={conditions.recipientExternal === null ? "" : String(conditions.recipientExternal)}
          onChange={(event) => setConditions((c) => ({
            ...c, recipientExternal: event.target.value === "" ? null : event.target.value === "true",
          }))}
        >
          <option value="">anyone — not part of this rule</option>
          <option value="true">anyone outside this organization</option>
          <option value="false">colleagues only</option>
        </select>
      </label>

      <label className="field-row" htmlFor="policy-reply">
        <span>Is it a reply?</span>
        <select
          id="policy-reply"
          value={conditions.isReply === null ? "" : String(conditions.isReply)}
          onChange={(event) => setConditions((c) => ({
            ...c, isReply: event.target.value === "" ? null : event.target.value === "true",
          }))}
        >
          <option value="">either — not part of this rule</option>
          <option value="true">only replies</option>
          <option value="false">only new messages</option>
        </select>
      </label>

      <label className="field-row" htmlFor="policy-outcome">
        <span>Then the message…</span>
        <select id="policy-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)}>
          {OUTCOMES.map((value) => (
            <option key={value} value={value}>{OUTCOME_WORDS[value]}</option>
          ))}
        </select>
      </label>

      {outcome === "require_approval" ? (
        <label className="field-row" htmlFor="policy-approvals">
          <span>How many people must approve?</span>
          <input
            id="policy-approvals"
            type="number"
            min={1}
            value={approvals}
            onChange={(event) => setApprovals(Math.max(1, Number(event.target.value) || 1))}
          />
        </label>
      ) : null}

      <p className="policy-actions">
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
          save draft
        </button>
        {" "}
        <button type="button" onClick={() => void onDone()} disabled={busy}>cancel</button>
        {/*
          Publishing is refused unless somebody holds `approval.decide` on a mailbox the rule applies to
          (#61) — a `require_approval` rule nobody can satisfy is a rule that stops mail for ever. The
          refusal explains that better than a disabled button would, so the button is not disabled.
        */}
      </p>
    </section>
  );
}

export function Policies() {
  const policies = usePolicies();
  const mailboxes = useMailboxes();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ policyId: string | null; name: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const nameOf = (id: string) =>
    mailboxes.data?.mailboxes.find((box) => box.id === id)?.name ?? id;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["policies"] });
    setEditing(null);
  }

  async function publish(policyId: string) {
    setProblem(null);
    const outcome = await publishPolicyVersion(policyId);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await refresh();
  }

  const heading = (
    <header className="ledger-head">
      <h1>Rules</h1>
      <p className="new-message">
        <button
          type="button"
          className="primary"
          onClick={() => setEditing({ policyId: null, name: "new rule" })}
        >
          new rule
        </button>
      </p>
    </header>
  );

  if (policies.isPending) return <>{heading}<Nothing kind="loading" /></>;
  if (policies.isError) {
    // 404 here means "not an administrator", by §5C — and the read deliberately cannot distinguish that from
    // an organization with no rules, so this says both and asserts neither.
    return (
      <>
        {heading}
        <Nothing
          kind="empty"
          detail="No rules here, or you do not hold org.admin. Writing one is an administrator's act."
        />
      </>
    );
  }

  const rows = policies.data.policies;
  const live = rows.filter((row) => row.state === "published");
  const drafts = rows.filter((row) => row.state === "draft");

  return (
    <>
      {heading}
      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{problem}</pre>}

      {rows.length === 0 ? (
        /*
         * An organization with no rules is not an organization with no governance: every send is still
         * bounded by relations, breakers and the hold window. Saying "nothing is gated" would be a claim
         * about the whole outbound path made from one table.
         */
        <Nothing kind="empty" detail="No rules yet. Every message goes as the mailbox and its relations allow." />
      ) : (
        <div className="scroller">
          <table>
            <caption className="dim">
              What each rule does, in the order a reader meets it. A message is decided by the strictest rule
              that matches it, not the first.
            </caption>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">What it does</th>
                <th scope="col">Version</th>
                <th scope="col">Since</th>
                <th scope="col">Edit</th>
              </tr>
            </thead>
            <tbody>
              {live.map((row) => (
                <tr key={row.version_id}>
                  <td>{row.name}</td>
                  <td>{sentence(row, nameOf)}</td>
                  <td className="mono">v{row.version}</td>
                  <td className="mono">{when(row.published_at)}</td>
                  <td>
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => setEditing({ policyId: row.policy_id, name: row.name })}
                    >
                      open
                    </button>
                  </td>
                </tr>
              ))}
              {drafts.map((row) => (
                <tr key={row.version_id}>
                  <td>{row.name}</td>
                  <td>
                    {sentence(row, nameOf)}
                    {" "}
                    <span className="dim">(unpublished — it decides nothing yet)</span>
                  </td>
                  <td className="dim">draft</td>
                  <td className="mono">{when(row.created_at)}</td>
                  <td>
                    <button type="button" className="primary" onClick={() => void publish(row.policy_id)}>
                      publish
                    </button>
                    {" "}
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => setEditing({ policyId: row.policy_id, name: row.name })}
                    >
                      open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing === null ? null : (
        <Editing
          policyId={editing.policyId}
          name={editing.name}
          draft={drafts.find((row) => row.policy_id === editing.policyId) ?? null}
          onDone={refresh}
        />
      )}
    </>
  );
}
