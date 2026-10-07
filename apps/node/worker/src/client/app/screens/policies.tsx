import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { t } from "/app/locale.js";
import { Nothing, Scroller } from "../chrome.tsx";
import {
  answeredNotFound, createPolicy, publishPolicyVersion, savePolicyDraft, useMailboxes, usePolicies,
  type PolicyConditions, type PolicyVersionRow, type Said,
} from "../api.ts";
import { dateTime } from "../format.ts";
import { marked } from "../words.tsx";

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
 * ## Six conditions, and the screen cannot offer a seventh
 *
 * #60 stored the conditions as **typed columns** rather than a JSON blob, precisely because a blob would
 * admit a condition nothing evaluates. That decision is what lets this screen be honest: it offers exactly
 * the six that exist, and the blueprint's other seven dimensions are absent here for the same reason they
 * are absent from the table — nothing would read them.
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

type Outcome = PolicyVersionRow["outcome"];

const OUTCOMES = ["allow", "hold", "require_approval", "deny"] as const satisfies readonly Outcome[];

/** What a rule does to the message it matches, as the end of a sentence: `policies.outcome.<token>`. */
const outcomeWords = (outcome: Outcome) => t(`policies.outcome.${outcome}`);

/** The rule as a sentence, built from the same columns the evaluator reads. */
function ruleSentence(row: PolicyVersionRow, mailboxName: (id: string) => string): string {
  const when: string[] = [];
  if (row.when_mailbox_id !== null) when.push(t("policies.when.mailbox", { mailbox: mailboxName(row.when_mailbox_id) }));
  if (row.when_actor_user_id !== null) when.push(t("policies.when.actor", { user: row.when_actor_user_id }));
  if (row.when_recipient_external !== null) {
    when.push(row.when_recipient_external === 1 ? t("policies.when.external") : t("policies.when.internal"));
  }
  if (row.when_is_reply !== null) {
    when.push(row.when_is_reply === 1 ? t("policies.when.reply") : t("policies.when.newMessage"));
  }
  if (row.when_reply_to_dmarc_fail !== null) {
    when.push(row.when_reply_to_dmarc_fail === 1 ? t("policies.when.dmarcFail") : t("policies.when.notDmarcFail"));
  }
  if (row.when_org_daily_volume_min !== null) {
    when.push(t("policies.when.volume", { count: row.when_org_daily_volume_min }));
  }
  // No conditions is a rule that matches everything, and saying so plainly is the point: it is the most
  // consequential shape a policy can have and the easiest to write by accident.
  const outcome = outcomeWords(row.outcome);
  return when.length === 0
    ? t("policies.rule.every", { outcome })
    : t("policies.rule.when", { conditions: when.join(t("policies.when.join")), outcome });
}

function when(at: string | null): string {
  return at === null ? "—" : dateTime(at);
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
  const [outcome, setOutcome] = useState<Outcome>(draft?.outcome ?? "require_approval");
  const [title, setTitle] = useState(name);
  const [conditions, setConditions] = useState<PolicyConditions>({
    mailboxId: draft?.when_mailbox_id ?? null,
    recipientExternal: draft?.when_recipient_external === null || draft === null
      ? null
      : draft.when_recipient_external === 1,
    isReply: draft?.when_is_reply === null || draft === null ? null : draft.when_is_reply === 1,
    replyToDmarcFail: draft?.when_reply_to_dmarc_fail === null || draft === null
      ? null
      : draft.when_reply_to_dmarc_fail === 1,
  });
  const [approvals, setApprovals] = useState(1);
  const [problem, setProblem] = useState<Said | null>(null);
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
    if (!outcomeOf.ok) { setProblem(outcomeOf); return; }
    await onDone();
  }

  return (
    <section
      className="policy-editor"
      aria-label={policyId === null ? t("policies.new") : t("policies.editor.label", { name })}
    >
      <h2>{policyId === null ? t("policies.new") : name}</h2>
      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{marked(problem)}</pre>}

      {policyId === null ? (
        <label className="field-row" htmlFor="policy-name">
          <span>{t("policies.editor.name")}</span>
          <input id="policy-name" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
      ) : null}

      <label className="field-row" htmlFor="policy-mailbox">
        <span>{t("policies.editor.mailbox")}</span>
        <select
          id="policy-mailbox"
          value={conditions.mailboxId ?? ""}
          onChange={(event) => setConditions((c) => ({
            ...c, mailboxId: event.target.value === "" ? null : event.target.value,
          }))}
        >
          <option value="">{t("policies.editor.mailbox.any")}</option>
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
        <span>{t("policies.editor.to")}</span>
        <select
          id="policy-external"
          value={conditions.recipientExternal === null ? "" : String(conditions.recipientExternal)}
          onChange={(event) => setConditions((c) => ({
            ...c, recipientExternal: event.target.value === "" ? null : event.target.value === "true",
          }))}
        >
          <option value="">{t("policies.editor.to.any")}</option>
          <option value="true">{t("policies.editor.to.external")}</option>
          <option value="false">{t("policies.editor.to.internal")}</option>
        </select>
      </label>

      <label className="field-row" htmlFor="policy-reply">
        <span>{t("policies.editor.reply")}</span>
        <select
          id="policy-reply"
          value={conditions.isReply === null ? "" : String(conditions.isReply)}
          onChange={(event) => setConditions((c) => ({
            ...c, isReply: event.target.value === "" ? null : event.target.value === "true",
          }))}
        >
          <option value="">{t("policies.editor.either")}</option>
          <option value="true">{t("policies.editor.reply.only")}</option>
          <option value="false">{t("policies.editor.reply.new")}</option>
        </select>
      </label>

      <label className="field-row" htmlFor="policy-reply-dmarc">
        <span>{t("policies.editor.dmarc")}</span>
        <select
          id="policy-reply-dmarc"
          value={conditions.replyToDmarcFail === null ? "" : String(conditions.replyToDmarcFail)}
          onChange={(event) => setConditions((c) => ({
            ...c, replyToDmarcFail: event.target.value === "" ? null : event.target.value === "true",
          }))}
        >
          <option value="">{t("policies.editor.either")}</option>
          <option value="true">{t("policies.editor.dmarc.only")}</option>
          <option value="false">{t("policies.editor.dmarc.else")}</option>
        </select>
      </label>

      <label className="field-row" htmlFor="policy-outcome">
        <span>{t("policies.editor.then")}</span>
        <select
          id="policy-outcome"
          value={outcome}
          onChange={(event) => setOutcome(OUTCOMES.find((value) => value === event.target.value) ?? outcome)}
        >
          {OUTCOMES.map((value) => (
            <option key={value} value={value}>{outcomeWords(value)}</option>
          ))}
        </select>
      </label>

      {outcome === "require_approval" ? (
        <label className="field-row" htmlFor="policy-approvals">
          <span>{t("policies.editor.approvals")}</span>
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
          {t("policies.editor.save")}
        </button>
        {" "}
        <button className="quiet" type="button" onClick={() => void onDone()} disabled={busy}>
          {t("shell.cancel")}
        </button>
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
  const [problem, setProblem] = useState<Said | null>(null);

  const nameOf = (id: string) =>
    mailboxes.data?.mailboxes.find((box) => box.id === id)?.name ?? id;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["policies"] });
    setEditing(null);
  }

  async function publish(policyId: string) {
    setProblem(null);
    const outcome = await publishPolicyVersion(policyId);
    if (!outcome.ok) { setProblem(outcome); return; }
    await refresh();
  }

  const heading = (
    <header className="ledger-head">
      <h1>{t("route./rules")}</h1>
      <p className="new-message">
        <button
          type="button"
          className="primary"
          onClick={() => setEditing({ policyId: null, name: "new rule" })}
        >
          {t("policies.new")}
        </button>
      </p>
    </header>
  );

  if (policies.isPending) return <>{heading}<Nothing kind="loading" /></>;
  if (policies.isError) {
    // 404 here means "not an administrator", by §5C — and the read deliberately cannot distinguish that from
    // an organization with no rules, so this says both and asserts neither. Any other failure is a failed read.
    return (
      <>
        {heading}
        {answeredNotFound(policies.error)
          ? <Nothing kind="empty" detail={t("policies.notAdmin")} />
          : <Nothing kind="failed" detail={marked(policies.error)} />}
      </>
    );
  }

  const rows = policies.data.policies;
  const live = rows.filter((row) => row.state === "published");
  const drafts = rows.filter((row) => row.state === "draft");

  return (
    <>
      {heading}
      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{marked(problem)}</pre>}

      {rows.length === 0 ? (
        /*
         * An organization with no rules is not an organization with no governance: every send is still
         * bounded by relations, breakers and the hold window. Saying "nothing is gated" would be a claim
         * about the whole outbound path made from one table.
         */
        <Nothing kind="empty" detail={t("policies.empty")} />
      ) : (
        <Scroller label={t("route./rules")}>
          <table>
            <caption className="dim">{t("policies.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("policies.col.rule")}</th>
                <th scope="col">{t("policies.col.does")}</th>
                <th scope="col">{t("policies.col.version")}</th>
                <th scope="col">{t("policies.col.since")}</th>
                <th scope="col">{t("policies.col.edit")}</th>
              </tr>
            </thead>
            <tbody>
              {live.map((row) => (
                <tr key={row.version_id}>
                  <td>{row.name}</td>
                  <td>{ruleSentence(row, nameOf)}</td>
                  <td className="mono">{t("policies.version", { version: String(row.version ?? "") })}</td>
                  <td className="mono">{when(row.published_at)}</td>
                  <td>
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => setEditing({ policyId: row.policy_id, name: row.name })}
                    >
                      {t("policies.open")}
                    </button>
                  </td>
                </tr>
              ))}
              {drafts.map((row) => (
                <tr key={row.version_id}>
                  <td>{row.name}</td>
                  <td>
                    {ruleSentence(row, nameOf)}
                    {" "}
                    <span className="dim">{t("policies.unpublished")}</span>
                  </td>
                  <td className="dim">{t("policies.draft")}</td>
                  <td className="mono">{when(row.created_at)}</td>
                  <td>
                    <span className="inline-actions">
                      <button type="button" className="primary" onClick={() => void publish(row.policy_id)}>
                        {t("policies.publish")}
                      </button>
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => setEditing({ policyId: row.policy_id, name: row.name })}
                      >
                        {t("policies.open")}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
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
