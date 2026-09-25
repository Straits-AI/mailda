import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";

import { Copyable, Nothing } from "../chrome.tsx";
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
 * `/setup` and `/doctor` still render as themselves, because the second way happens on `/setup`.
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
    <section className="first-run" aria-label="Setup needed">
      <header className="ledger-head"><h1>This Node is not ready to use yet</h1></header>
      <p className="dim">
        It has been deployed and claimed. Before it can be used as an inbox it needs an address and mail
        routed to it; this is where that stands.
      </p>
      <ProgressList steps={steps} />
      {next === null ? null : (
        <section className="first-run-next" aria-label="Next step">
          <h2>Next: {next.label.toLowerCase()}</h2>
          <p className="dim">{next.detail}</p>
          <h3>From a terminal (recommended, no token)</h3>
          <p>
            <Copyable text={UPDATE} label="command" />
          </p>
          <p className="dim">
            Run it in the directory the install made. After the deploy it asks which domain this Node
            receives at and sets up receiving, sending and delivery outcomes with the consent wrangler
            already has.
          </p>
          <h3>From this screen</h3>
          <p className="dim">
            The browser has no wrangler, so this way needs the Node's own credential:{" "}
            <Link to="/setup" className="linkish">connect this Node (one API token), then set up receiving there</Link>.
            On an apex domain the catch-all is one act, and addresses are then managed on this Node.
          </p>
        </section>
      )}
      <p className="dim first-run-anyway">
        <button type="button" className="linkish" onClick={onOpenAnyway}>open the app anyway</button>
        {" "}(this tab only; sending will refuse until an address is routed)
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
  if (path === "/setup" || path === "/doctor" || opened || readiness.state === "unknown" || readiness.state === "ready") {
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
