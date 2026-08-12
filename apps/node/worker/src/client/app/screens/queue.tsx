import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import {
  type CaseRow, type ClaimResult, claimCase, closeCase, releaseCase, stealCase, useCases, useMailboxes,
  useMe,
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

/** Minutes and hours, not a library. A claim's age is read at a glance and rounded is fine. */
function ageOf(since: string): string {
  const ms = Date.now() - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

type Held = { kind: "held"; heldBy: string; heldSince: string; message: string };

function CaseRowView({
  row, mine, onAct,
}: {
  row: CaseRow;
  mine: boolean;
  onAct: (action: "claim" | "steal" | "release" | "close", id: string) => void;
}) {
  const unclaimed = row.assignee === null;
  // The state word, which is the channel that does not depend on colour being measured.
  const state = unclaimed ? "unclaimed" : mine ? "yours" : "held";

  return (
    <tr className={mine ? "case-row mine" : unclaimed ? "case-row" : "case-row theirs"}>
      <td>
        <span className={`state case-${state}`}>{state}</span>
      </td>
      <td>
        <span className="case-subject">{row.subject ?? <span className="dim">(no subject)</span>}</span>
        {row.message_count > 1 ? (
          <span className="dim mono case-count"> · {row.message_count} messages</span>
        ) : null}
      </td>
      <td className="dim mono">{row.from_addr ?? "—"}</td>
      <td className="mono dim">
        {/* Who and how long, in the same cell, because they are one fact a person acts on. */}
        {/* A name, not an id. Falls back to the identifier only if the user row has gone, which would be a
            real inconsistency worth seeing rather than hiding behind "somebody". */}
        {unclaimed ? "—" : `${mine ? "you" : row.assignee_email ?? row.assignee} · ${ageOf(row.claimed_at ?? row.state_at)}`}
      </td>
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
  const queryClient = useQueryClient();

  // The first mailbox this person may work, until they pick another. Not persisted: which queue somebody is
  // looking at is not a decision worth remembering wrongly across sessions.
  const mailboxId = selected ?? mailboxes.data?.mailboxes[0]?.id ?? null;
  const cases = useCases(mailboxId);

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
        <table>
          <thead>
            <tr>
              <th scope="col">State</th>
              <th scope="col">Subject</th>
              <th scope="col">From</th>
              <th scope="col">Held by</th>
              <th scope="col" className="num">Action</th>
            </tr>
          </thead>
          <tbody>
            {cases.data.cases.map((row) => (
              <CaseRowView
                key={row.id}
                row={row}
                mine={row.assignee !== null && row.assignee === me.data?.userId}
                onAct={(action, id) => void onAct(action, id)}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
