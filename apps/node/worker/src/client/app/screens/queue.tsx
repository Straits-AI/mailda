import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { t } from "/app/locale.js";
import type { Text } from "../../../i18n/format.ts";
import { Nothing, Scroller, Truncated } from "../chrome.tsx";
import { fullTime } from "../format.ts";
import {
  type CaseRow, type ClaimResult, type QuarantinedDelivery, type Said, assignCase, claimCase, closeCase, mergeConversations, releaseCase, releaseQuarantined,
  setAttachmentLimits, setQuarantineSwitch, setResponseTarget, stealCase, useCases, useMailboxes, useMe, useQuarantine,
} from "../api.ts";
import { isComposingKey } from "../ui/ime.ts";
import { marked } from "../words.tsx";

/**
 * The shared queue: what two people work without colliding.
 *
 * ## Three states, and colour is not what distinguishes them
 *
 * Unclaimed, mine, and somebody else's. Each carries a word and a position as well as a colour. Since
 * 26 September 2026 `contrast-tokens.md` measures every text and indicator token on every ground in both
 * themes, but a colour that passes contrast still tells nobody who cannot tell two hues apart which state a
 * row is in, so nothing here may rely on colour alone (Blueprint §5C/§5D). That is why every row states its
 * state in text.
 *
 * ## The age is shown and never enforced
 *
 * There is no timeout: an expiry is a policy guess, a claim's age is a fact. So the queue displays how long
 * a claim has been held and a person judges whether that is stale for this queue. Stealing is the remedy and
 * it is audited — which makes this screen the place where "claim-before-composing prevents accidents, not
 * takeover" becomes visible rather than a sentence in a commit message.
 *
 * ## Losing a race is a real answer
 *
 * `changes = 0` from the compare-and-swap comes back with **who** holds the case and since when, and this
 * renders that. A spinner that stops, or a generic failure, would leave somebody guessing whether to wait,
 * steal, or move on.
 */

/**
 * Handing a case to a colleague, by the address they sign in with. A field that appears on "hand to" rather
 * than a picker: the directory is an administrator's read, and the person doing this knows the address.
 */
export function HandTo({ onAssign }: { onAssign: (email: string) => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  if (!open) return <button type="button" className="linkish" onClick={() => setOpen(true)}>{t("queue.handTo.open")}</button>;
  return (
    <span className="hand-to">
      <input
        className="mono" placeholder={t("queue.handTo.placeholder")} aria-label={t("queue.handTo.label")} value={email}
        onChange={(event) => setEmail(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !isComposingKey(event.nativeEvent) && email.trim() !== "") { event.preventDefault(); onAssign(email.trim()); } }}
      />
      <button type="button" className="linkish" disabled={email.trim() === ""} onClick={() => onAssign(email.trim())}>{t("queue.handTo.submit")}</button>
    </span>
  );
}

/** Minutes and hours, not a library. Read at a glance, so rounded is fine. */
function duration(ms: number): Text {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t("queue.duration.underMinute");
  if (minutes < 60) return t("queue.duration.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("queue.duration.hours", { n: hours, m: minutes % 60 });
  return t("queue.duration.days", { n: Math.floor(hours / 24), h: hours % 24 });
}

/**
 * How long ago something happened, or `null` for under a minute (and for a moment not yet come, or unreadable),
 * which each sentence words for itself: "just now" is not a duration a sentence can hold.
 */
function ageOf(since: string): Text | null {
  const ms = Date.now() - Date.parse(since);
  return ms >= 60_000 ? duration(ms) : null; // NaN, from an unreadable instant, compares false: null too
}

/**
 * How long until something is due.
 *
 * Its own function rather than `ageOf` applied to a fabricated past instant, which is what the first version
 * did: `ageOf(new Date(Date.now() - remaining).toISOString())`. That produced the *same* number — the two
 * expressions are arithmetically identical — so this split is for the reader, not a bug fix, and the record
 * says so because it was first committed as one. A rendering of "in 26438d 20h" was read as evidence of a
 * defect here; the defect was a dev fixture with a deadline in 2099, and nothing in this file was wrong.
 *
 * The lesson kept: a suspicious rendering is a claim about the input as much as about the code, and the input
 * is the cheaper half to check. (Numbers are grouped for the locale since the catalog, so that fixture now reads
 * "in 26,438d 20h".) Called only for a deadline still ahead: `ClockCell` says "due now" for one that is not.
 */
function untilOf(due: string): Text {
  return duration(Date.parse(due) - Date.now());
}

type Held = Extract<ClaimResult, { kind: "held" }>;
type CaseState = "unclaimed" | "mine" | "held";

/**
 * The clock, as a word plus a duration.
 *
 * A word, because colour cannot be the only channel — `--signal` and `--alarm` are still unmeasured, and this
 * is the third feature to be shaped by that. Absent entirely when the mailbox promises nothing, which is not
 * the same as "on time" and must not look like it.
 */
function ClockCell({ row }: { row: CaseRow }) {
  if (row.response_due_at === null) {
    // No promise, so no verdict. §5C's distinction between "fine" and "nobody said".
    return <span className="dim">—</span>;
  }
  if (row.first_response_at !== null) {
    return <span className="state clock-answered">{t("queue.clock.answered")}</span>;
  }
  if (row.response_breached_at !== null) {
    // Recorded by the sweep. Shown here, which until now it was not.
    const age = ageOf(row.response_due_at);
    return (
      <span className="state clock-breached" title={t("queue.clock.targetPassed", { at: fullTime(row.response_due_at) })}>
        {age === null ? t("queue.clock.overdueJustNow") : t("queue.clock.overdue", { age })}
      </span>
    );
  }
  // Between the deadline passing and the next sweep noticing: up to a minute, plus cron's unmeasured skew.
  // Saying "due now" rather than "on time" is the honest reading of that gap. Negated, so an unreadable deadline
  // (NaN compares false both ways) lands here too rather than counting down from nothing.
  if (!(Date.parse(row.response_due_at) > Date.now())) {
    return <span className="state clock-due">{t("queue.clock.dueNow")}</span>;
  }
  return <span className="dim mono">{t("queue.clock.dueIn", { until: untilOf(row.response_due_at) })}</span>;
}

/** Why a delivery was held back, as one sentence per reason. */
function whyHeld(one: QuarantinedDelivery): Text {
  switch (one.reason) {
    case "held":
      return one.note === null ? t("queue.held.noReason") : t("queue.held.reason.held", { note: one.note });
    case "dmarc_fail_reject":
    case "dmarc_fail_quarantine":
      return t(`queue.held.reason.${one.reason}`, { domain: one.fromDomain ?? t("queue.held.fromDomain") });
    default:
      return t(`queue.held.reason.${one.reason}`);
  }
}

/**
 * §7's restricted-content placeholder, rendered rather than paraphrased.
 *
 * It says *why*, because "restricted" on its own reads as a fault. The person holding this view can still
 * claim and reply — `send.propose` is what put the case in front of them — so the message names the relation
 * an administrator would grant, in the same idiom as the empty-queue notice.
 */
function Restricted({ what }: { what: "subject" | "sender" }) {
  return (
    <span
      className="restricted"
      title={t(`queue.restricted.${what}`)}
    >
      {t("queue.restricted")}
    </span>
  );
}

function CaseRowView({
  row, mine, picked, onPick, onAct, onAssign,
}: {
  row: CaseRow;
  mine: boolean;
  picked: boolean;
  onPick: (id: string) => void;
  onAct: (action: "claim" | "steal" | "release" | "close", id: string) => void;
  onAssign: (id: string, email: string) => void;
}) {
  const unclaimed = row.assignee === null;
  // The state word, which is the channel that does not depend on colour being measured.
  const state: CaseState = unclaimed ? "unclaimed" : mine ? "mine" : "held";

  return (
    <tr className={mine ? "case-row mine" : unclaimed ? "case-row" : "case-row theirs"}>
      <td>
        <label className="case-pick">
          {/* Picking two cases is how a merge is proposed. A checkbox rather than a drag or a menu, because
              the operation is "these two are one thing" and that is a selection, not a gesture. */}
          <input
            type="checkbox"
            checked={picked}
            onChange={() => onPick(row.id)}
            aria-label={row.subject === null ? t("queue.pick.noSubject") : t("queue.pick", { subject: row.subject })}
          />
          <span className={`state case-${state}`}>{t(`queue.state.${state}`)}</span>
        </label>
      </td>
      <td>
        {/*
          Three states, not two. "(no subject)" is a message that had none; "restricted" is one this person
          may not see — §5C's rule that absent and forbidden must not render alike, which is exactly what a
          bare null here would have done.
        */}
        <span className="case-subject">
          {row.content_restricted ? <Restricted what="subject" />
            : row.subject ?? <span className="dim">{t("queue.noSubject")}</span>}
        </span>
        {row.message_count > 1 ? (
          <span className="dim mono case-count"> · {t("queue.case.messages", { n: row.message_count })}</span>
        ) : null}
      </td>
      <td className="dim mono">
        {row.content_restricted ? <Restricted what="sender" /> : row.from_addr ?? "—"}
      </td>
      <td className="mono dim case-holder">
        {/* Who and how long, in the same cell, because they are one fact a person acts on — but in two spans,
            so the cell may wrap between them. One nowrap string made this the widest column in the table and
            pushed the clock and the actions off the right edge of a 1200px window. */}
        {/* A name, not an id. Falls back to the identifier only if the user row has gone, which would be a
            real inconsistency worth seeing rather than hiding behind "somebody". */}
        {unclaimed ? "—" : (
          <>
            <span>{mine ? t("queue.holder.you") : row.assignee_email ?? row.assignee}</span>{" "}
            <span>· {ageOf(row.claimed_at ?? row.state_at) ?? t("queue.age.justNow")}</span>
          </>
        )}
      </td>
      <td><ClockCell row={row} /></td>
      <td className="num case-actions">
        {unclaimed ? (
          <button type="button" className="linkish" onClick={() => onAct("claim", row.id)}>
            {t("queue.act.claim")}
          </button>
        ) : mine ? (
          <>
            <button type="button" className="linkish" onClick={() => onAct("release", row.id)}>
              {t("queue.act.release")}
            </button>
            <button type="button" className="linkish" onClick={() => onAct("close", row.id)}>
              {t("queue.act.close")}
            </button>
            <HandTo onAssign={(email) => onAssign(row.id, email)} />
          </>
        ) : (
          // Available to any colleague, deliberately. Restricting it to administrators recreates the
          // blocked queue the absent timeout would otherwise have prevented, and there is no third answer.
          <button type="button" className="linkish" onClick={() => onAct("steal", row.id)}>
            {t("queue.act.take")}
          </button>
        )}
      </td>
    </tr>
  );
}

export function Queue() {
  const mailboxes = useMailboxes();
  const me = useMe();
  const [selected, setSelected] = useState<string | null>(null);
  const [lost, setLost] = useState<Held | null>(null);
  /** The Node's refusal, or this interface's fallback when it said nothing (`Said`), shown through `marked()`. */
  const [problem, setProblem] = useState<Said | null>(null);
  const [notice, setNotice] = useState<Text | null>(null);
  /** Cases picked for a merge. Exactly two, because merging is a statement about a pair. */
  const [picked, setPicked] = useState<string[]>([]);
  const queryClient = useQueryClient();

  // The first mailbox this person may work, until they pick another. Not persisted: which queue somebody is
  // looking at is not a decision worth remembering wrongly across sessions.
  const mailboxId = selected ?? mailboxes.data?.mailboxes[0]?.id ?? null;
  const cases = useCases(mailboxId);
  const current = mailboxes.data?.mailboxes.find((box) => box.id === mailboxId);
  // Fetched only when the count says there is something to list: the route is administrators-only, and a
  // person who is not one would otherwise be shown a refusal for a list they had no reason to want.
  const quarantine = useQuarantine((current?.quarantined ?? 0) > 0);
  const held = quarantine.data?.quarantined.filter((one) => one.mailboxId === mailboxId) ?? [];

  /**
   * Merges the two picked cases' conversations.
   *
   * Most attempts refuse, and the refusal is the deliverable — it names the case pair to resolve first, so it
   * is rendered as prominently as a success rather than swallowed.
   */
  async function onMerge() {
    setNotice(null);
    setProblem(null);
    const [a, b] = picked;
    const rows = cases.data?.cases ?? [];
    const from = rows.find((row) => row.id === a);
    const into = rows.find((row) => row.id === b);
    if (from === undefined || into === undefined) return;

    const outcome = await mergeConversations(from.conversation_id, into.conversation_id);
    await queryClient.invalidateQueries({ queryKey: ["cases", mailboxId] });
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    setPicked([]);
    if (outcome.ok) setNotice(t("queue.merged", { n: outcome.messagesMoved }));
    else setProblem(outcome);
  }

  async function onSetTarget(minutes: number | null) {
    setNotice(null);
    setProblem(null);
    if (mailboxId === null) return;
    const outcome = await setResponseTarget(mailboxId, minutes);
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    if (outcome.ok) {
      setNotice(minutes === null ? t("queue.target.cleared") : t("queue.target.set", { n: minutes }));
    } else setProblem(outcome);
  }

  async function onSetQuarantine(which: "dmarc" | "attachments", on: boolean) {
    setNotice(null);
    setProblem(null);
    if (mailboxId === null) return;
    const outcome = await setQuarantineSwitch(mailboxId, which, on);
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    if (outcome.ok) {
      setNotice(on ? t(`queue.quarantine.${which}.on`) : t("queue.quarantine.off"));
    } else setProblem(outcome);
  }

  async function onSetLimits(limits: { attachmentMaxBytes?: number | null; attachmentAllowedTypes?: string[] | null }) {
    setNotice(null);
    setProblem(null);
    if (mailboxId === null) return;
    const outcome = await setAttachmentLimits(mailboxId, limits);
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    if (outcome.ok) setNotice(t("queue.limits.saved"));
    else setProblem(outcome);
  }

  async function onRelease(messageId: string) {
    setNotice(null);
    setProblem(null);
    const outcome = await releaseQuarantined(messageId);
    await queryClient.invalidateQueries({ queryKey: ["quarantine"] });
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    await queryClient.invalidateQueries({ queryKey: ["cases", mailboxId] });
    if (outcome.ok) setNotice(t("queue.released"));
    else setProblem(outcome);
  }

  async function onAssign(id: string, email: string) {
    setLost(null);
    setProblem(null);
    const outcome = await assignCase(id, email);
    await queryClient.invalidateQueries({ queryKey: ["cases", mailboxId] });
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    if (outcome.ok) setNotice(t("queue.handedTo", { email }));
    else setProblem(outcome);
  }

  async function onAct(action: "claim" | "steal" | "release" | "close", id: string) {
    setLost(null);
    setProblem(null);
    const outcome: ClaimResult =
      action === "claim" ? await claimCase(id)
        : action === "steal" ? await stealCase(id)
          : action === "release" ? await releaseCase(id)
            : await closeCase(id);

    // Refetched rather than patched locally. Who holds a case is a server fact, and guessing the new state
    // here is how an interface ends up disagreeing with the ledger it is displaying.
    await queryClient.invalidateQueries({ queryKey: ["cases", mailboxId] });
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });

    if (outcome.ok) return;
    if (outcome.kind === "held") setLost(outcome);
    else setProblem(outcome);
  }

  const heading = (
    <header className="ledger-head">
      <h1>{t("route./queue")}</h1>
      {mailboxes.isSuccess && mailboxes.data.mailboxes.length > 1 ? (
        <label className="queue-picker">
          <span className="dim mono">{t("queue.mailbox")}</span>
          <select
            value={mailboxId ?? ""}
            onChange={(event) => setSelected(event.target.value)}
          >
            {mailboxes.data.mailboxes.map((box) => (
              <option key={box.id} value={box.id}>
                {t("queue.mailbox.option", { name: box.name, n: box.unclaimed })}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </header>
  );

  if (mailboxes.isPending) return <section className="ledger">{heading}<Nothing kind="loading" /></section>;
  if (mailboxes.isError) {
    return <section className="ledger">{heading}<Nothing kind="failed" detail={marked(mailboxes.error)} /></section>;
  }
  if (mailboxes.data.mailboxes.length === 0) {
    return (
      <section className="ledger" aria-label={t("route./queue")}>
        {heading}
        {/* Not "no mailboxes exist": this person may work none of them, and §5C keeps those alike. The fix
            is a grant, so the message names it rather than leaving somebody to guess. */}
        <Nothing
          kind="empty"
          detail={t("queue.noMailbox")}
        />
      </section>
    );
  }

  return (
    <section className="ledger" aria-label={t("route./queue")}>
      {heading}

      {/*
        The mailbox's settings fold under one line (design audit, 7 October 2026): they sat above the queue and pushed
        the work below the fold, and they change rarely. What the queue needs at a glance, how many cases are overdue
        and how many deliveries are held, stays on that line.
      */}
      <details className="queue-settings">
        <summary>
          <span>{t("queue.settings")}</span>
          {current !== undefined && current.breached > 0 ? (
            <span className="state clock-breached queue-breached">{t("queue.overdue", { n: current.breached })}</span>
          ) : null}
          {current !== undefined && current.quarantined > 0 ? (
            <span className="state clock-due">{t("queue.held.count", { n: current.quarantined })}</span>
          ) : null}
        </summary>
      {/*
        The target. Rendered here rather than on a settings screen because it is the number every clock in
        this table derives from, and a promise nobody can see the source of is one nobody trusts. Refused
        for non-administrators by the Node, whose message says so.
      */}
      <p className="notice dim queue-target">
        {current === undefined || current.first_response_minutes === null
          ? t("queue.target.none")
          : t("queue.target.promised", { n: current.first_response_minutes })}
        {" "}
        {/*
          An inline field, not window.prompt. A prompt blocks the page — it stops the accessibility harness
          dead and cannot be styled, labelled or read by a screen reader as part of the form it belongs to.
          Empty means "promise nothing", which is the same request as null.
        */}
        <label className="target-edit">
          <span className="dim mono">{t("queue.target.minutes")}</span>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            defaultValue={current?.first_response_minutes ?? ""}
            aria-label={t("queue.target.label")}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || isComposingKey(event.nativeEvent)) return;
              const raw = (event.target as HTMLInputElement).value.trim();
              void onSetTarget(raw === "" ? null : Number(raw));
            }}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              const next = raw === "" ? null : Number(raw);
              if (next !== (current?.first_response_minutes ?? null)) void onSetTarget(next);
            }}
          />
        </label>
      </p>

      {/*
        The one policy this Node acts on the receiving server's verdict with (0056). A checkbox and not a
        policy editor: the condition is fixed — the sender's own domain said the message is not theirs and
        asked receivers to act — and the only decision a mailbox makes is whether to listen.
      */}
      <div className="notice dim queue-switches">
        <label className="case-pick">
          <input
            type="checkbox"
            checked={current?.quarantine_dmarc_fail === 1}
            onChange={(event) => void onSetQuarantine("dmarc", event.target.checked)}
            aria-label={t("queue.quarantine.dmarc.label")}
          />
          <span>{t("queue.quarantine.dmarc.text")}</span>
        </label>
        <label className="case-pick">
          <input
            type="checkbox"
            checked={current?.quarantine_dangerous_attachments === 1}
            onChange={(event) => void onSetQuarantine("attachments", event.target.checked)}
            aria-label={t("queue.quarantine.attachments.label")}
          />
          <span>{t("queue.quarantine.attachments.text")}</span>
        </label>
        {/*
          The mailbox's own limits (0065). A bound and a list, both empty by default; either one holds a
          delivery that breaks it and refuses a send that would. Extensions, not media types: the name is
          what a person reads, and the judge already goes by it.
        */}
        <label className="field-row" htmlFor="queue-attachment-max">
          <span>{t("queue.limits.maxSize")}</span>
          <input
            id="queue-attachment-max" className="mono" type="number" min={1} inputMode="numeric"
            placeholder={t("queue.limits.noLimit")}
            key={`max-${current?.attachment_max_bytes ?? "none"}`}
            defaultValue={current?.attachment_max_bytes == null ? "" : String(Math.round(current.attachment_max_bytes / 1024))}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              const next = raw === "" ? null : Math.round(Number(raw) * 1024);
              if (next !== (current?.attachment_max_bytes ?? null)) void onSetLimits({ attachmentMaxBytes: next });
            }}
          />
        </label>
        <label className="field-row" htmlFor="queue-attachment-types">
          <span>{t("queue.limits.types")}</span>
          <input
            id="queue-attachment-types" className="mono" type="text" placeholder={t("queue.limits.typesPlaceholder")}
            key={`types-${current?.attachment_allowed_types ?? "none"}`}
            defaultValue={current?.attachment_allowed_types == null ? "" : (JSON.parse(current.attachment_allowed_types) as string[]).join(", ")}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              const next = raw === "" ? null : raw.split(/[,\s]+/).filter((one) => one !== "");
              const was = current?.attachment_allowed_types == null ? null : (JSON.parse(current.attachment_allowed_types) as string[]).join(",");
              if ((next === null ? null : next.join(",")) !== was) void onSetLimits({ attachmentAllowedTypes: next });
            }}
          />
        </label>
      </div>
      </details>

      {current !== undefined && current.quarantined > 0 ? (
        quarantine.isError ? (
          <p className="notice bad" role="alert">{marked(quarantine.error)}</p>
        ) : held.length === 0 ? null : (
          <>
          {/* The cap is on the Node's whole list, and `held` is this mailbox's share of it, so the noun says so. */}
          <Truncated
            when={quarantine.data?.truncated === true} shown={quarantine.data?.quarantined.length ?? 0}
            noun={t("queue.held.noun")}
          />
          <table className="queue-table" aria-label={t("queue.held.table")}>
            <thead>
              <tr>
                <th scope="col">{t("queue.held.col.at")}</th>
                <th scope="col">{t("queue.col.subject")}</th>
                <th scope="col">{t("queue.col.from")}</th>
                <th scope="col">{t("queue.held.col.why")}</th>
                <th scope="col" className="num">{t("queue.col.action")}</th>
              </tr>
            </thead>
            <tbody>
              {held.map((one) => (
                <tr key={one.messageId}>
                  <td className="mono dim"><time dateTime={one.quarantinedAt}>{fullTime(one.quarantinedAt)}</time></td>
                  <td>{one.subject ?? <span className="dim">{t("queue.noSubject")}</span>}</td>
                  <td className="mono">{one.fromAddr ?? <span className="dim">—</span>}</td>
                  <td>{whyHeld(one)}</td>
                  <td className="num">
                    <button type="button" className="linkish" onClick={() => void onRelease(one.messageId)}>
                      {t("queue.held.release")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )
      ) : null}

      {picked.length === 2 ? (
        <p className="notice">
          {t("queue.merge.picked")} <button type="button" className="linkish" onClick={() => void onMerge()}>
            {t("queue.merge.do")}
          </button>{" "}
          <span className="dim">
            {t("queue.merge.hint")}
          </span>{" "}
          <button type="button" className="linkish" onClick={() => setPicked([])}>{t("queue.merge.clear")}</button>
        </p>
      ) : null}

      {notice === null ? null : <p className="notice" role="status">{notice}</p>}
      {lost === null ? null : (
        <p className="notice bad" role="alert">
          {/* Names who won. This is the compare-and-swap's `changes = 0`, rendered — the whole reason the
              server re-reads the row instead of reporting a bare failure. */}
          {marked(lost)}
        </p>
      )}
      {problem === null ? null : (
        <p className="notice bad" role="alert">{marked(problem)}</p>
      )}

      {cases.isPending ? <Nothing kind="loading" /> : cases.isError ? (
        <Nothing kind="failed" detail={marked(cases.error)} />
      ) : cases.data.cases.length === 0 ? (
        <Nothing kind="empty" detail={t("queue.empty")} />
      ) : (
        <Scroller label={t("queue.cases")}>
        <table className="queue-table">
          <thead>
            <tr>
              <th scope="col">{t("queue.col.state")}</th>
              <th scope="col">{t("queue.col.subject")}</th>
              <th scope="col">{t("queue.col.from")}</th>
              <th scope="col">{t("queue.col.holder")}</th>
              <th scope="col">{t("queue.col.response")}</th>
              <th scope="col" className="num">{t("queue.col.action")}</th>
            </tr>
          </thead>
          <tbody>
            {cases.data.cases.map((row) => (
              <CaseRowView
                key={row.id}
                row={row}
                mine={row.assignee !== null && row.assignee === me.data?.userId}
                onAssign={onAssign}
                picked={picked.includes(row.id)}
                onPick={(id) => setPicked((current) =>
                  current.includes(id)
                    ? current.filter((each) => each !== id)
                    // Two, and picking a third replaces the older — so the control cannot get stuck.
                    : [...current, id].slice(-2))}
                onAct={(action, id) => void onAct(action, id)}
              />
            ))}
          </tbody>
        </table>
        </Scroller>
      )}
    </section>
  );
}
