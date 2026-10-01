import { t } from "/app/locale.js";

import { useDrafts } from "../api.ts";
import { Nothing, Truncated } from "../chrome.tsx";
import * as format from "../format.ts";
import { marked } from "../words.tsx";
import { useCompose } from "../shell-context.tsx";

/**
 * Unfinished writing, as a place of its own (`/drafts`), replacing the strip that sat above the Inbox.
 *
 * Opening one hands it to the shell's one composer by id, so a new message put down is picked up again. A
 * reply draft carries two more things: the message it answers, and **its case**. The composer claims that
 * case again immediately before sealing (#42), so a reply resumed hours later, after the case was released or
 * taken, stops at the send and names the holder instead of going out beside somebody else's answer.
 */
export function Drafts() {
  const drafts = useDrafts();
  const compose = useCompose();
  const heading = <header className="ledger-head"><h1>{t("route./drafts")}</h1></header>;

  if (drafts.isPending) return <>{heading}<Nothing kind="loading" /></>;
  if (drafts.isError) return <>{heading}<Nothing kind="failed" detail={marked(drafts.error)} /></>;
  const rows = drafts.data.drafts;
  if (rows.length === 0) return <>{heading}<Nothing kind="empty" detail={t("drafts.empty")} /></>;

  return (
    <>
      {heading}
      <Truncated when={drafts.data.truncated} shown={rows.length} noun={t("drafts.noun")} />
      <ul className="draft-list" aria-label={t("route./drafts")}>
        {rows.map((draft) => (
          <li key={draft.id}>
            <button
              type="button"
              className="draft-row"
              onClick={() => compose.open({
                mailboxId: draft.mailboxId,
                draftId: draft.id,
                ...(draft.inReplyToMessageId === null ? {} : { inReplyToMessageId: draft.inReplyToMessageId }),
                ...(draft.caseId === null ? {} : { caseId: draft.caseId }),
              })}
            >
              <span>{draft.subject.trim() === "" ? t("drafts.noSubject") : draft.subject}</span>
              {" · "}
              <span>{draft.to.length === 0 ? t("drafts.noRecipient") : draft.to.join(", ")}</span>
              {" · "}
              <time dateTime={draft.updatedAt} title={format.dateTime(draft.updatedAt)}>
                {format.mediumDateTime(draft.updatedAt)}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
