import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import { decide, useApprovals, withdrawDecision, type ApprovalRow } from "../api.ts";

/**
 * What is waiting on you (#81).
 *
 * ## Why this screen is the first of the governance surfaces to be built
 *
 * A published `require_approval` policy gates a send into `awaiting`, and until this existed there was no
 * way for anybody to clear one. The outbox's only control for an `awaiting` send is *stop*, and its own
 * comment says the send is "cleared by an approver (#61)" — an approver with no screen. So a policy that is
 * supposed to add a second pair of eyes instead made mail undeliverable, and the only resolution through the
 * product was for the author to cancel their own message. That is a stop with no drain, which is exactly the
 * failure #66 kept `deny` out of `awaiting` to avoid, arriving at the surface instead of in the predicate.
 *
 * ## This screen decides nothing about who may decide
 *
 * `GET /api/approvals` returns `pendingApprovals`, which computes the eligible set per subject kind and
 * excludes the actor. So the list is already exactly what this person may act on, and the screen never works
 * that out for itself: a rule about separation of duty (§18) held in the browser would be a second opinion
 * about the thing the whole mechanism exists to guarantee. A refusal — `E_APPROVER_IS_ACTOR` — is rendered
 * verbatim if one ever arrives, because it explains the rule better than any wording here would.
 *
 * ## Five subject kinds, one list, and the differences are shown rather than flattened
 *
 * A send, a hold lift, a supervised read, an e-discovery export and a domain pause are all approvals, and
 * they are not the same decision. Approving a supervised read lets somebody read a colleague's mail;
 * approving a domain pause stops a customer's mail. Rendering them as identical rows with an id would make
 * the gravest and the most routine look the same, so each kind says what it is and carries the detail its
 * own request already provides — the requester's `reason` where there is one, the grant's scope and matter,
 * the domain and why.
 */

/** Human words for a machine token. A reader should not have to learn the enum to use the screen. */
const KIND_WORDS: Record<ApprovalRow["subjectKind"], { title: string; what: string }> = {
  send_manifest: {
    title: "A message waiting to go out",
    what: "A policy asked for a second pair of eyes before this leaves.",
  },
  hold_lift: {
    title: "Lifting a legal hold",
    what: "Approving this ends the hold, and the mail it preserved becomes deletable again.",
  },
  supervised_read: {
    title: "Reading somebody else's mail",
    what: "Approving this lets the requester read a mailbox they hold no standing relation to. "
      + "The person whose mailbox it is will be told when the matter closes (§7).",
  },
  ediscovery_export: {
    title: "Exporting mail out of this Node",
    what: "Approving this produces a copy of matching mail that leaves the system's own controls.",
  },
  domain_pause: {
    title: "Stopping a domain's mail",
    what: "Approving this stops every message to that domain until somebody lifts it.",
  },
};

function when(at: string | null): string {
  return at === null ? "—" : new Date(at).toLocaleString();
}

/** How far through the stages this request is, in words rather than a pair of numbers. */
function progress(row: ApprovalRow): string {
  if (row.stages.length === 0) return "one approval needed";
  const total = row.stages.reduce((sum, stage) => sum + stage.count, 0);
  const stage = row.openStage === null ? row.stages.length : row.openStage;
  const plural = total === 1 ? "" : "s";
  return row.stages.length === 1
    ? `${total} approval${plural} needed`
    : `stage ${stage} of ${row.stages.length} · ${total} approval${plural} in total`;
}

function Waiting({ row, onDone }: { row: ApprovalRow; onDone: () => Promise<void> }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const words = KIND_WORDS[row.subjectKind];

  async function act(run: () => ReturnType<typeof decide>) {
    setBusy(true);
    setProblem(null);
    const outcome = await run();
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await onDone();
  }

  return (
    <article className="approval" aria-label={words.title}>
      <h2>{words.title}</h2>
      <p>{words.what}</p>
      <dl className="headers">
        <dt>subject</dt>
        <dd className="mono">{row.subjectId}</dd>
        <dt>asked by</dt>
        <dd className="mono">{row.actorUserId}</dd>
        <dt>asked</dt>
        <dd className="mono">{when(row.requestedAt)}</dd>
        <dt>lapses</dt>
        {/*
          An approval can expire, and a send whose approval lapsed is refused terminally — "compose again,
          and the new message gets its own approval". Somebody deciding today needs to know they are the
          reason it will or will not make it, so the deadline is a header rather than a detail.
        */}
        <dd className="mono">{row.expiresAt === null ? "does not lapse" : when(row.expiresAt)}</dd>
        <dt>needs</dt>
        <dd>{progress(row)}</dd>
      </dl>

      {row.reason === null ? null : (
        // The requester's own words. Present for a hold lift, a supervised read and a domain pause; a send
        // carries none, because the reason it is being reviewed is the policy that matched.
        <blockquote className="approval-reason">{row.reason}</blockquote>
      )}

      {row.supervised == null ? null : (
        <p className="dim mono">
          scope {row.supervised.scope} · subject {row.supervised.subjectId}
          {row.supervised.matterId === null ? " · no matter cited" : ` · matter ${row.supervised.matterId}`}
        </p>
      )}
      {row.pause == null ? null : (
        <p className="dim mono">domain {row.pause.domain}</p>
      )}

      {problem === null ? null : <p className="notice bad" role="alert">{problem}</p>}

      <p className="approval-actions">
        {row.decidedByMe ? (
          <>
            {/*
              Already decided by this person, so the act available is to take it back — which is a real act
              with its own route, not an undo. Offering approve/deny again would let one person satisfy a
              stage twice, which `apd_one_per_person` refuses at the database anyway; showing it would be
              inviting a refusal.
            */}
            <span className="dim">You have decided this. </span>
            <button type="button" onClick={() => void act(() => withdrawDecision(row.id))} disabled={busy}>
              take my decision back
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="primary"
              onClick={() => void act(() => decide(row.id, "approve"))}
              disabled={busy}
            >
              approve
            </button>
            {" "}
            <button type="button" onClick={() => void act(() => decide(row.id, "deny"))} disabled={busy}>
              deny
            </button>
          </>
        )}
      </p>
    </article>
  );
}

export function Approvals() {
  const approvals = useApprovals();
  const queryClient = useQueryClient();

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["approvals"] });
    // The outbox is the other half of the same fact: approving a send moves it out of `awaiting`, and a
    // stale outbox beside a cleared approval is the two-truths shape this repository keeps splitting apart.
    await queryClient.invalidateQueries({ queryKey: ["sends"] });
    await queryClient.invalidateQueries({ queryKey: ["notifications"] });
  }

  const heading = (
    <header className="ledger-head">
      <h1>Approvals</h1>
      {approvals.isSuccess
        ? <p className="dim mono">{approvals.data.approvals.length} waiting on you</p>
        : null}
    </header>
  );

  if (approvals.isPending) return <>{heading}<Nothing kind="loading" /></>;
  if (approvals.isError) {
    return <>{heading}<Nothing kind="failed" detail={approvals.error.message} /></>;
  }

  const rows = approvals.data.approvals;
  if (rows.length === 0) {
    /*
     * "Nothing is waiting on **you**" rather than "there are no approvals".
     *
     * The list is scoped to this person by the eligible-set computation, so an empty screen says nothing
     * about whether the organization has pending approvals — and claiming otherwise would be the interface
     * making §5C's mistake, where a refused read reads as an absent one.
     */
    return <>{heading}<Nothing kind="empty" detail="Nothing is waiting on you to decide." /></>;
  }

  return (
    <>
      {heading}
      <div className="approval-list">
        {rows.map((row) => <Waiting key={row.id} row={row} onDone={refresh} />)}
      </div>
    </>
  );
}
