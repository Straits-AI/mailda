import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";

import { t } from "/app/locale.js";
import { Copyable, Nothing } from "../chrome.tsx";
import { sentence } from "../words.tsx";
import { ProgressList, useReadiness, type Step } from "../onboarding.tsx";

/**
 * What an administrator sees instead of an inbox while the Node cannot be used as one (25 September 2026).
 *
 * The founder ran the install, then the update, opened the app and saw an inbox, and took it as ready. It
 * had no routed address; the first send refused with `E_MAILBOX_HAS_NO_ADDRESS`. An inbox on a Node that
 * cannot receive is not an inbox, it is a screen that lies by being there. So until an address exists and
 * mail is routed to it, this is the whole app for an administrator: the steps, and the next one with its
 * two ways, the terminal first because it needs no credential a browser cannot hold.
 *
 * `/setup`, `/doctor` and `/settings` still render as themselves: the second way happens on `/setup`,
 * Doctor is the diagnostic an administrator needs most when the Node is not working, and signing out lives
 * on `/settings`, so a gated administrator can always leave.
 */

const UPDATE = "curl -fsSL https://mailda.site/update.sh | bash";
const OVERRIDE = "mailda.first-run.override";

/** Per tab, so an administrator who opened the app anyway does not carry that choice into the next tab. */
function overridden(): boolean {
  try { return sessionStorage.getItem(OVERRIDE) === "1"; } catch { return false; }
}
function override(): void {
  try { sessionStorage.setItem(OVERRIDE, "1"); } catch { /* the page still renders; the choice is not kept */ }
}

export function FirstRun({ steps, next, onOpenAnyway }: { steps: Step[]; next: Step | null; onOpenAnyway: () => void }) {
  return (
    <section className="first-run" aria-label={t("ui.firstRun")}>
      <header className="ledger-head"><h1>{t("ui.firstRun.heading")}</h1></header>
      <p className="dim">{t("ui.firstRun.lead")}</p>
      <ProgressList steps={steps} />
      {next === null ? null : (
        <section className="first-run-next" aria-label={t("ui.firstRun.next")}>
          <h2>{t("ui.firstRun.next.heading", { step: next.phrase })}</h2>
          <p className="dim">{next.detail}</p>
          <h3>{t("ui.firstRun.terminal")}</h3>
          <p>
            <Copyable text={UPDATE} label={t("ui.firstRun.terminal.what")} />
          </p>
          <p className="dim">{t("ui.firstRun.terminal.body")}</p>
          <h3>{t("ui.firstRun.browser")}</h3>
          <p className="dim">
            {sentence("ui.firstRun.browser.body", {
              link: <Link to="/setup" className="linkish">{t("ui.firstRun.browser.link")}</Link>,
            })}
          </p>
        </section>
      )}
      <p className="dim first-run-anyway">
        <button type="button" className="linkish" onClick={onOpenAnyway}>{t("ui.firstRun.anyway")}</button>
        {t("join.sentence")}{t("ui.firstRun.anyway.note")}
      </p>
    </section>
  );
}

/**
 * The gate. Renders the first-run screen in place of everything, or the children as they were.
 *
 * Loading shows a loading state rather than the children: a flash of inbox that then turns into "not
 * ready" would teach the founder's lesson twice. A `/api/provider` that refused means a member, who cannot
 * set anything up, and the shell renders as it always did.
 */
export function Gate({ children }: { children: React.ReactNode }) {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const readiness = useReadiness();
  const [opened, setOpened] = useState(overridden);
  // Once the gate has let the shell through, a read going back to pending does not take it away. The shell reads the
  // provider too (`SetupUnfinished`), and a reader mounting on a failed read refetches it, so for a member, whose read
  // is refused, dropping to loading unmounted that reader, which mounted again on the failure: a re-read about once a
  // second and a screen flipping between loading and the shell (found by T4, 2 October 2026).
  const [through, setThrough] = useState(false);
  const decided = readiness.state === "unknown" || readiness.state === "ready";
  if (decided && !through) setThrough(true);
  if (
    path === "/setup" || path === "/doctor" || path === "/settings"
    || opened || decided || (through && readiness.state === "loading")
  ) {
    return <>{children}</>;
  }
  if (readiness.state === "loading") return <div className="first-run"><Nothing kind="loading" /></div>;
  return (
    <FirstRun
      steps={readiness.steps}
      next={readiness.next}
      onOpenAnyway={() => { override(); setOpened(true); }}
    />
  );
}
