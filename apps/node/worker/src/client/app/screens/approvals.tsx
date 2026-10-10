import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { t } from "/app/locale.js";
import { Nothing } from "../chrome.tsx";
import { count, dateTime, list } from "../format.ts";
import {
  approvalAttachmentHref, decide, useApprovalContent, useApprovals, withdrawDecision, type ApprovalRow, type Said,
} from "../api.ts";
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
        {row.scopeName == null ? null : (
          <>
            <dt>{t("approvals.mailbox")}</dt>
            <dd>{row.scopeName}</dd>
          </>
        )}
        <dt>{t("approvals.askedBy")}</dt>
        {/* By address, or a Butler's name; the id stays as the title, and is all a Node before 10 October 2026 sends. */}
        <dd className="mono" title={row.actorUserId}>{row.actorLabel ?? row.actorUserId}</dd>
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
        {/* The id last and quiet: a reference to quote, not what is being decided. */}
        <dt>{t("approvals.subject")}</dt>
        <dd className="mono dim">{row.subjectId}</dd>
      </dl>

      {row.send == null ? null : <SendUnderReview approvalId={row.id} send={row.send} />}

      {(row.reason ?? row.domainPause?.reason ?? null) === null ? null : (
        // The requester's own words. Present for a hold lift and a supervised read; a domain pause's are on the pause
        // (`src/approval-pending.ts` sends them as `domainPause.reason`); a send carries none, because the reason it is
        // being reviewed is the rule that matched.
        <blockquote className="approval-reason">{row.reason ?? row.domainPause?.reason}</blockquote>
      )}

      {row.supervised == null ? null : (
        <dl className="headers">
          <dt>{t("approvals.read.whose")}</dt>
          <dd className="mono" title={row.supervised.subjectId}>{row.supervised.subjectEmail ?? row.supervised.subjectId}</dd>
          <dt>{t("approvals.read.scope")}</dt>
          {/* The scope is the Node's token (`metadata`, `content`), an identifier in every locale. */}
          <dd><code>{row.supervised.scope}</code></dd>
          <dt>{t("approvals.read.until")}</dt>
          <dd className="mono">{when(row.supervised.expiresAt)}</dd>
          <dt>{t("approvals.matter")}</dt>
          <dd>{row.supervised.matter == null ? t("approvals.noMatter") : row.supervised.matter.description}</dd>
        </dl>
      )}
      {row.exportRequest == null ? null : (
        <dl className="headers">
          <dt>{t("approvals.matter")}</dt>
          <dd>{row.exportRequest.matter == null ? row.exportRequest.matterId : row.exportRequest.matter.description}</dd>
          <dt>{t("approvals.export.which")}</dt>
          <dd><code>{row.exportRequest.predicate}</code></dd>
          <dt>{t("approvals.export.most")}</dt>
          <dd>{t("approvals.export.messages", { n: row.exportRequest.maxMessages, count: count(row.exportRequest.maxMessages) })}</dd>
          <dt>{t("approvals.export.to")}</dt>
          <dd className="mono">{row.exportRequest.destination}</dd>
        </dl>
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

/**
 * The send an approver is asked to decide (§18, amended 10 October 2026): its addresses and subject from the queue,
 * its body and attachments' names from `GET /api/approvals/:id/content`, read when the card is shown and recorded as
 * a disclosure, which the card says. The body is the author's text and is shown as text, never as markup. Each
 * attachment's name is a link to its bytes, recorded per file when followed; no `download` attribute, because the
 * route sends content-disposition itself, as the reader's attachments do.
 */
function SendUnderReview({ approvalId, send }: { approvalId: string; send: NonNullable<ApprovalRow["send"]> }) {
  const content = useApprovalContent(approvalId, true);
  return (
    <section className="approval-send" aria-label={t("approvals.send.label")}>
      <dl className="headers">
        <dt>{t("approvals.send.from")}</dt>
        <dd className="mono">{send.from}</dd>
        <dt>{t("approvals.send.to")}</dt>
        <dd className="mono">{list(send.to)}</dd>
        {send.cc.length === 0 ? null : (
          <>
            <dt>{t("approvals.send.cc")}</dt>
            <dd className="mono">{list(send.cc)}</dd>
          </>
        )}
        {send.bcc.length === 0 ? null : (
          <>
            <dt>{t("approvals.send.bcc")}</dt>
            <dd className="mono">{list(send.bcc)}</dd>
          </>
        )}
        <dt>{t("approvals.send.subject")}</dt>
        <dd>{send.subject}</dd>
      </dl>
      {content.isPending ? <Nothing kind="loading" /> : null}
      {content.isError ? <Nothing kind="failed" detail={marked(content.error)} /> : null}
      {content.isSuccess ? (
        <>
          <pre className="approval-body">{content.data.body}</pre>
          {content.data.attachments.length === 0 ? null : (
            <ul className="approval-attachments" aria-label={t("approvals.send.attachments")}>
              {content.data.attachments.map((one) => (
                <li key={one.id}>
                  <a className="mono" href={approvalAttachmentHref(approvalId, one.id)}>{one.filename}</a>{" "}
                  <span className="dim">{t("composer.size.kb", { size: String(Math.max(1, Math.round(one.bytes / 1024))) })}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="dim">{t("approvals.send.recorded")}</p>
        </>
      ) : null}
    </section>
  );
}
