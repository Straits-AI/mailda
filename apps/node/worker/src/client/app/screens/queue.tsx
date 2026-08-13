import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import {
  type CaseRow, type ClaimResult, claimCase, closeCase, mergeConversations, releaseCase,
  setResponseTarget, stealCase, useCases, useMailboxes, useMe,
} from "../api.ts";

/**
 * The shared queue: what two people work without colliding.
 *
 * ## Three states, and colour is not what distinguishes them
 *
 * Unclaimed, mine, and somebody else's. Each carries a word and a position as well as a colour, because
 * `contrast-tokens.md` proves exactly **one** token — `--dim`. `--signal`, `--alarm` and `--live` have never
 * been measured, so nothing here may rely on colour alone (Blueprint §5C/§5D). That is a live constraint, not
 * a stylistic preference, and it is why every row states its state in text.
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

/** Minutes and hours, not a library. Read at a glance, so rounded is fine. */
function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** How long ago something happened. */
function ageOf(since: string): string {
  const ms = Date.now() - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  return duration(ms) === "under a minute" ? "just now" : duration(ms);
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
 * is the cheaper half to check.
 */
function untilOf(due: string): string {
  const ms = Date.parse(due) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  return duration(ms);
}

type Held = { kind: "held"; heldBy: string; heldSince: string; message: string };

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
    return <span className="state clock-answered">answered</span>;
  }
  if (row.response_breached_at !== null) {
    // Recorded by the sweep. Shown here, which until now it was not.
    return (
      <span className="state clock-breached" title={`Target passed at ${row.response_due_at}`}>
        overdue {ageOf(row.response_due_at)}
      </span>
    );
  }
  // Between the deadline passing and the next sweep noticing: up to a minute, plus cron's unmeasured skew.
  // Saying "due now" rather than "on time" is the honest reading of that gap.
  if (Date.parse(row.response_due_at) <= Date.now()) {
    return <span className="state clock-due">due now</span>;
  }
  return <span className="dim mono">in {untilOf(row.response_due_at)}</span>;
}

function CaseRowView({
  row, mine, picked, onPick, onAct,
}: {
  row: CaseRow;
  mine: boolean;
  picked: boolean;
  onPick: (id: string) => void;
  onAct: (action: "claim" | "steal" | "release" | "close", id: string) => void;
}) {
  const unclaimed = row.assignee === null;
  // The state word, which is the channel that does not depend on colour being measured.
  const state = unclaimed ? "unclaimed" : mine ? "yours" : "held";

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
            aria-label={`Pick ${row.subject ?? "this case"} for merging`}
          />
          <span className={`state case-${state}`}>{state}</span>
        </label>
      </td>
      <td>
        <span className="case-subject">{row.subject ?? <span className="dim">(no subject)</span>}</span>
        {row.message_count > 1 ? (
          <span className="dim mono case-count"> · {row.message_count} messages</span>
        ) : null}
      </td>
      <td className="dim mono">{row.from_addr ?? "—"}</td>
      <td className="mono dim case-holder">
        {/* Who and how long, in the same cell, because they are one fact a person acts on — but in two spans,
            so the cell may wrap between them. One nowrap string made this the widest column in the table and
            pushed the clock and the actions off the right edge of a 1200px window. */}
        {/* A name, not an id. Falls back to the identifier only if the user row has gone, which would be a
            real inconsistency worth seeing rather than hiding behind "somebody". */}
        {unclaimed ? "—" : (
          <>
            <span>{mine ? "you" : row.assignee_email ?? row.assignee}</span>{" "}
            <span>· {ageOf(row.claimed_at ?? row.state_at)}</span>
          </>
        )}
      </td>
      <td><ClockCell row={row} /></td>
      <td className="num case-actions">
        {unclaimed ? (
          <button type="button" className="linkish" onClick={() => onAct("claim", row.id)}>
            claim
          </button>
        ) : mine ? (
          <>
            <button type="button" className="linkish" onClick={() => onAct("release", row.id)}>
              release
            </button>
            <button type="button" className="linkish" onClick={() => onAct("close", row.id)}>
              close
            </button>
          </>
        ) : (
          // Available to any colleague, deliberately. Restricting it to administrators recreates the
          // blocked queue the absent timeout would otherwise have prevented, and there is no third answer.
          <button type="button" className="linkish" onClick={() => onAct("steal", row.id)}>
            take
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
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Cases picked for a merge. Exactly two, because merging is a statement about a pair. */
  const [picked, setPicked] = useState<string[]>([]);
  const queryClient = useQueryClient();

  // The first mailbox this person may work, until they pick another. Not persisted: which queue somebody is
  // looking at is not a decision worth remembering wrongly across sessions.
  const mailboxId = selected ?? mailboxes.data?.mailboxes[0]?.id ?? null;
  const cases = useCases(mailboxId);
  const current = mailboxes.data?.mailboxes.find((box) => box.id === mailboxId);

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
    if (outcome.ok) setNotice(`Merged. ${outcome.messagesMoved} message(s) moved.`);
    else setProblem(outcome.message);
  }

  async function onSetTarget(minutes: number | null) {
    setNotice(null);
    setProblem(null);
    if (mailboxId === null) return;
    const outcome = await setResponseTarget(mailboxId, minutes);
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    if (outcome.ok) {
      setNotice(minutes === null
        ? "This mailbox now promises nothing, so its cases carry no clock."
        : `First response promised within ${minutes} minutes. Clocks start on the next message.`);
    } else setProblem(outcome.message);
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
    else setProblem(outcome.message);
  }

  const heading = (
    <header className="ledger-head">
      <h1>Queue</h1>
      {mailboxes.isSuccess && mailboxes.data.mailboxes.length > 1 ? (
        <label className="queue-picker">
          <span className="dim mono">mailbox</span>
          <select
            value={mailboxId ?? ""}
            onChange={(event) => setSelected(event.target.value)}
          >
            {mailboxes.data.mailboxes.map((box) => (
              <option key={box.id} value={box.id}>
                {box.name} ({box.unclaimed} unclaimed)
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </header>
  );

  if (mailboxes.isPending) return <section className="ledger">{heading}<Nothing kind="loading" /></section>;
  if (mailboxes.isError) {
    return <section className="ledger">{heading}<Nothing kind="failed" detail={mailboxes.error.message} /></section>;
  }
  if (mailboxes.data.mailboxes.length === 0) {
    return (
      <section className="ledger" aria-label="Queue">
        {heading}
        {/* Not "no mailboxes exist": this person may work none of them, and §5C keeps those alike. The fix
            is a grant, so the message names it rather than leaving somebody to guess. */}
        <Nothing
          kind="empty"
          detail="You cannot work any mailbox on this Node yet. An administrator grants send.propose on one."
        />
      </section>
    );
  }

  return (
    <section className="ledger" aria-label="Queue">
      {heading}

      {/*
        The target. Rendered here rather than on a settings screen because it is the number every clock in
        this table derives from, and a promise nobody can see the source of is one nobody trusts. Refused
        for non-administrators by the Node, whose message says so.
      */}
      <p className="notice dim queue-target">
        {current === undefined || current.first_response_minutes === null
          ? "This mailbox promises no response time, so no case here carries a clock."
          : `First response promised within ${current.first_response_minutes} minutes.`}
        {" "}
        {/*
          An inline field, not window.prompt. A prompt blocks the page — it stops the accessibility harness
          dead and cannot be styled, labelled or read by a screen reader as part of the form it belongs to.
          Empty means "promise nothing", which is the same request as null.
        */}
        <label className="target-edit">
          <span className="dim mono">minutes</span>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            defaultValue={current?.first_response_minutes ?? ""}
            aria-label="First response target in minutes; empty promises nothing"
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
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
        {current !== undefined && current.breached > 0 ? (
          <span className="state clock-breached queue-breached">{current.breached} overdue</span>
        ) : null}
      </p>

      {picked.length === 2 ? (
        <p className="notice">
          Two cases picked. <button type="button" className="linkish" onClick={() => void onMerge()}>
            merge them
          </button>{" "}
          <span className="dim">
            — most merges are refused, and the refusal names the pair to resolve first.
          </span>{" "}
          <button type="button" className="linkish" onClick={() => setPicked([])}>clear</button>
        </p>
      ) : null}

      {notice === null ? null : <p className="notice" role="status">{notice}</p>}
      {lost === null ? null : (
        <p className="notice bad" role="alert">
          {/* Names who won. This is the compare-and-swap's `changes = 0`, rendered — the whole reason the
              server re-reads the row instead of reporting a bare failure. */}
          {lost.message}
        </p>
      )}
      {problem === null ? null : (
        <p className="notice bad" role="alert">{problem}</p>
      )}

      {cases.isPending ? <Nothing kind="loading" /> : cases.isError ? (
        <Nothing kind="failed" detail={cases.error.message} />
      ) : cases.data.cases.length === 0 ? (
        <Nothing kind="empty" detail="Nothing waiting in this queue." />
      ) : (
        <table className="queue-table">
          <thead>
            <tr>
              <th scope="col">State</th>
              <th scope="col">Subject</th>
              <th scope="col">From</th>
              <th scope="col">Held by</th>
              <th scope="col">Response</th>
              <th scope="col" className="num">Action</th>
            </tr>
          </thead>
          <tbody>
            {cases.data.cases.map((row) => (
              <CaseRowView
                key={row.id}
                row={row}
                mine={row.assignee !== null && row.assignee === me.data?.userId}
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
      )}
    </section>
  );
}
