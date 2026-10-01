import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { t } from "/app/locale.js";
import { Nothing } from "../chrome.tsx";
import { dateTime } from "../format.ts";
import { decide, useApprovals, withdrawDecision, type ApprovalRow, type Said } from "../api.ts";
import { marked } from "../words.tsx";

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

function when(at: string | null): string {
  return at === null ? "—" : dateTime(at);
}

/** How far through the stages this request is, in words rather than a pair of numbers. */
function progress(row: ApprovalRow): string {
  if (row.stages.length === 0) return t("approvals.needs.one");
  const total = row.stages.reduce((sum, stage) => sum + stage.count, 0);
  const stage = row.openStage === null ? row.stages.length : row.openStage;
  return row.stages.length === 1
    ? t("approvals.needs.single", { n: total })
    : t("approvals.needs.staged", { n: total, stage, stages: row.stages.length });
}

function Waiting({ row, onDone }: { row: ApprovalRow; onDone: () => Promise<void> }) {
  const [problem, setProblem] = useState<Said | null>(null);
  const [busy, setBusy] = useState(false);
  // Human words for the kind's token (`approvals.kind.<subjectKind>.*`): a reader should not have to learn the enum.
  const title = t(`approvals.kind.${row.subjectKind}.title`);

  async function act(run: () => ReturnType<typeof decide>) {
    setBusy(true);
    setProblem(null);
    const outcome = await run();
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome); return; }
    await onDone();
  }

  return (
    <article className="approval" aria-label={title}>
      <h2>{title}</h2>
      <p>{t(`approvals.kind.${row.subjectKind}.what`)}</p>
      <dl className="headers">
        <dt>{t("approvals.subject")}</dt>
        <dd className="mono">{row.subjectId}</dd>
        <dt>{t("approvals.askedBy")}</dt>
        <dd className="mono">{row.actorUserId}</dd>
        <dt>{t("approvals.asked")}</dt>
        <dd className="mono">{when(row.requestedAt)}</dd>
        <dt>{t("approvals.lapses")}</dt>
        {/*
          An approval can expire, and a send whose approval lapsed is refused terminally — "compose again,
          and the new message gets its own approval". Somebody deciding today needs to know they are the
          reason it will or will not make it, so the deadline is a header rather than a detail.
        */}
        <dd className="mono">{row.expiresAt === null ? t("approvals.noLapse") : when(row.expiresAt)}</dd>
        <dt>{t("approvals.needs")}</dt>
        <dd>{progress(row)}</dd>
      </dl>

      {(row.reason ?? row.domainPause?.reason ?? null) === null ? null : (
        // The requester's own words. Present for a hold lift and a supervised read; a domain pause's are on the pause
        // (`src/approval-pending.ts` sends them as `domainPause.reason`); a send carries none, because the reason it is
        // being reviewed is the rule that matched.
        <blockquote className="approval-reason">{row.reason ?? row.domainPause?.reason}</blockquote>
      )}

      {row.supervised == null ? null : (
        <p className="dim mono">
          {row.supervised.matterId === null
            ? t("approvals.supervised.noMatter", { scope: row.supervised.scope, subject: row.supervised.subjectId })
            : t("approvals.supervised.matter", { scope: row.supervised.scope, subject: row.supervised.subjectId, matter: row.supervised.matterId })}
        </p>
      )}
      {row.domainPause == null ? null : (
        <p className="dim mono">{t("approvals.domain", { domain: row.domainPause.domain })}</p>
      )}

      {problem === null ? null : <p className="notice bad" role="alert">{marked(problem)}</p>}

      <p className="approval-actions">
        {row.decidedByMe ? (
          <>
            {/*
              Already decided by this person, so the act available is to take it back — which is a real act
              with its own route, not an undo. Offering approve/deny again would let one person satisfy a
              stage twice, which `apd_one_per_person` refuses at the database anyway; showing it would be
              inviting a refusal.
            */}
            <span className="dim">{t("approvals.decided")}{" "}</span>
            <button className="quiet" type="button" onClick={() => void act(() => withdrawDecision(row.id))} disabled={busy}>
              {t("approvals.takeBack")}
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
              {t("approvals.approve")}
            </button>
            {" "}
            <button className="quiet" type="button" onClick={() => void act(() => decide(row.id, "deny"))} disabled={busy}>
              {t("approvals.deny")}
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
      <h1>{t("route./approvals")}</h1>
      {approvals.isSuccess
        ? <p className="dim mono">{t("approvals.waiting", { n: approvals.data.approvals.length })}</p>
        : null}
    </header>
  );

  if (approvals.isPending) return <>{heading}<Nothing kind="loading" /></>;
  if (approvals.isError) {
    return <>{heading}<Nothing kind="failed" detail={marked(approvals.error)} /></>;
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
    return <>{heading}<Nothing kind="empty" detail={t("approvals.empty")} /></>;
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
