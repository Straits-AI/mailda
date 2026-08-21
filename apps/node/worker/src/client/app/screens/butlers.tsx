import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import {
  createButler, publishButlerVersion, resumeButler, saveButlerDraft,
  useButler, useButlerRuns, useButlers,
  type ButlerRow, type ButlerRunRow,
} from "../api.ts";

/**
 * The Butler screen (#78): what is automated here, and what it has done.
 *
 * ## Why this screen exists at all
 *
 * The whole Layer 5 engine — the interpreter, the checker, the run ledger, the pause machinery, replay —
 * was built and had **no user interface whatsoever**. `grep -ric butler src/client/app/` returned 0. The
 * observation API was already correct and nobody could call it: `inspectRun` gates fact disclosure on
 * `mayReadMetadata` and classifies every field as content or operational (#53), an access decision written
 * carefully for a screen that did not exist. `doctor` reported a paused Butler and gave an operator nowhere
 * to look.
 *
 * ## Two halves, and they are not the same job
 *
 * **Author** is a rare, deliberate act by an administrator. **Observe** is what somebody does when mail is
 * behaving oddly at nine in the morning. They share a screen because the question *"why did it do that"* is
 * answered by looking at the program and the run together, and splitting them would make the common
 * diagnosis a two-screen navigation.
 *
 * ## What this screen deliberately does not do
 *
 * - **It does not fetch around a redaction.** Run facts are only shown through `/api/butler-runs/:id/inspect`,
 *   which redacts by `redactFacts`. The list endpoint carries no facts and this screen does not ask for any.
 * - **It does not offer resume as a bare button.** A pause was placed by a machine that had a reason, and
 *   `detail` is that reason in the detector's own words. Resuming without reading it is how a loop gets
 *   re-armed by somebody who thought the button meant refresh — so the detail is shown, and the act requires
 *   a written reason of its own, which `resumeButlerPause` refuses to default.
 * - **It does not validate the source in the browser.** `checkButler` is the gate, it runs on the Node, and a
 *   second copy here would be a second opinion about what publishes — which is the correspondence problem
 *   this repository keeps paying for. The findings come back from the route and are shown verbatim.
 */

/** The empty program a new Butler starts from: it parses, it checks, and it does nothing. */
const STARTER = JSON.stringify({
  apiVersion: "mailda/v1",
  kind: "Butler",
  metadata: { name: "new butler", owner: "team:support" },
  capabilities: [],
  trigger: { event: "mail.received", mailbox: "support@example.com" },
  entry: "halt",
  nodes: [{ id: "halt", type: "stop", reason: "not doing anything yet" }],
}, null, 2);

function when(at: string | null): string {
  return at === null ? "—" : new Date(at).toLocaleString();
}

/**
 * One Butler's standing, in a sentence rather than a badge.
 *
 * A badge reading "paused" beside one reading "v3" makes a reader assemble the meaning themselves, and the
 * meaning is the point: a published Butler that a breaker stopped is *live and not running*, which is not
 * what either word says alone.
 */
function Standing({ butler }: { butler: ButlerRow }) {
  if (butler.pause !== null) {
    return (
      <span className="bad">
        stopped — {butler.pause.reason.replace(/_/g, " ")}
      </span>
    );
  }
  if (butler.live_version !== null) return <span>live · v{butler.live_version}</span>;
  return <span className="dim">draft only, never published</span>;
}

/** The editor for one Butler: its versions, its draft, and the two acts. */
function Editing({ butler, onDone }: { butler: ButlerRow; onDone: () => void }) {
  const detail = useButler(butler.id);
  const queryClient = useQueryClient();
  const [source, setSource] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const versions = detail.data?.versions ?? [];
  const draft = versions.find((row) => row.state === "draft") ?? null;
  // `??` rather than `||`: an empty draft body is a real state and must not fall through to the stored one.
  const editing = source ?? draft?.source_text ?? "";

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["butlers"] });
    await queryClient.invalidateQueries({ queryKey: ["butler", butler.id] });
  }

  async function save() {
    setBusy(true);
    setProblem(null);
    const outcome = await saveButlerDraft(butler.id, editing);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setSource(null);
    await refresh();
  }

  async function publish() {
    setBusy(true);
    setProblem(null);
    const outcome = await publishButlerVersion(butler.id);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await refresh();
  }

  return (
    <section className="butler-detail" aria-label={`Butler ${butler.name}`}>
      <header className="ledger-head">
        <h2>{butler.name}</h2>
        <button type="button" className="linkish" onClick={onDone}>close</button>
      </header>

      {problem === null ? null : (
        // The Node's own four-part message, verbatim: the checker names the node and says what is wrong
        // with it, and a paraphrase would drop the half that says what to do.
        <pre className="notice bad butler-findings" role="alert">{problem}</pre>
      )}

      <label className="field-row" htmlFor="butler-source">
        <span>source</span>
        <textarea
          id="butler-source"
          className="butler-source mono"
          rows={18}
          spellCheck={false}
          value={editing}
          onChange={(event) => setSource(event.target.value)}
        />
      </label>
      <p className="butler-actions">
        <button type="button" onClick={() => void save()} disabled={busy}>save draft</button>
        {" "}
        <button
          type="button"
          className="primary"
          onClick={() => void publish()}
          disabled={busy || draft === null}
        >
          publish
        </button>
        {draft === null ? <span className="dim"> nothing unpublished to publish</span> : null}
      </p>

      <table>
        <caption className="dim">Versions — publication is the versioning event, and a published one is frozen</caption>
        <thead>
          <tr><th>version</th><th>state</th><th>published</th><th>by</th><th>ast sha256</th></tr>
        </thead>
        <tbody>
          {versions.map((row) => (
            <tr key={row.id}>
              <td className="mono">{row.version ?? "—"}</td>
              <td>{row.state}</td>
              <td className="mono">{when(row.published_at)}</td>
              <td className="mono">{row.published_by ?? "—"}</td>
              <td className="mono dim">{row.ast_sha256.slice(0, 12)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Lifting a machine-placed pause, with the reason it was placed shown and a reason required to lift it. */
function Paused({ butler }: { butler: ButlerRow }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  if (butler.pause === null) return null;

  async function resume() {
    setProblem(null);
    const outcome = await resumeButler(butler.id, reason);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setReason("");
    await queryClient.invalidateQueries({ queryKey: ["butlers"] });
  }

  return (
    <div className="butler-pause notice bad">
      {/* The detector's own sentence. Somebody deciding whether to re-arm a Butler needs what it counted,
          not the word "paused". */}
      <p>{butler.pause.detail}</p>
      <p className="dim mono">placed by {butler.pause.trippedBy} · {when(butler.pause.at)}</p>
      <label className="field-row" htmlFor={`resume-${butler.id}`}>
        <span>why is it safe to resume?</span>
        <input
          id={`resume-${butler.id}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <button type="button" onClick={() => void resume()} disabled={reason.trim() === ""}>
        resume
      </button>
      {problem === null ? null : <p role="alert">{problem}</p>}
    </div>
  );
}

function Runs({ runs }: { runs: ButlerRunRow[] }) {
  if (runs.length === 0) {
    return <Nothing kind="empty" detail="No Butler has run yet. A run comes from a delivery." />;
  }
  return (
    <div className="scroller">
      <table>
        <thead>
          <tr>
            <th>started</th><th>state</th><th>why it ended</th>
            <th>nodes</th><th>effects</th><th>refusals</th><th>spent</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td className="mono">{when(run.started_at)}</td>
              <td className={run.state === "failed" ? "bad" : undefined}>{run.state}</td>
              {/* The reason is the deliverable: `stopped` alone does not distinguish a Butler that decided
                  nothing needed doing from one a budget killed. */}
              <td>{run.outcome_reason ?? <span className="dim">—</span>}</td>
              <td className="mono num">{run.nodes_executed}</td>
              <td className="mono num">{run.effects}</td>
              <td className="mono num">{run.refusals}</td>
              <td className="mono num">{run.subrequests_spent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Butlers() {
  const butlers = useButlers();
  const runs = useButlerRuns();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function create() {
    setProblem(null);
    const outcome = await createButler("new butler", STARTER);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await queryClient.invalidateQueries({ queryKey: ["butlers"] });
    setEditing(outcome.value.butler.butlerId);
  }

  const heading = (
    <header className="ledger-head">
      <h1>Butlers</h1>
      <p className="new-message">
        <button type="button" className="primary" onClick={() => void create()}>new butler</button>
      </p>
    </header>
  );

  if (butlers.isPending) return <>{heading}<Nothing kind="loading" /></>;
  /*
   * A 404 here means "not an administrator", by §5C — the read deliberately cannot distinguish that from an
   * organization with no Butlers, and this screen must not undo that by guessing which it was. So the
   * message says what somebody in either position can act on and asserts neither.
   */
  if (butlers.isError) {
    return (
      <>
        {heading}
        <Nothing
          kind="empty"
          detail="No Butlers here, or you do not hold org.admin. Writing one is an administrator's act."
        />
      </>
    );
  }

  const rows = butlers.data.butlers;
  const current = rows.find((row) => row.id === editing) ?? null;

  return (
    <>
      {heading}
      {problem === null ? null : <p className="notice bad" role="alert">{problem}</p>}

      {rows.length === 0 ? (
        <Nothing kind="empty" detail="Nothing is automated on this Node yet." />
      ) : (
        <div className="scroller">
          <table>
            <thead>
              <tr><th>name</th><th>standing</th><th>published</th><th>draft</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td><Standing butler={row} /></td>
                  <td className="mono">{when(row.published_at)}</td>
                  <td className="dim">{row.draft_version_id === null ? "—" : "unpublished changes"}</td>
                  <td>
                    <button type="button" className="linkish" onClick={() => setEditing(row.id)}>
                      open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.filter((row) => row.pause !== null).map((row) => (
        <Paused key={row.id} butler={row} />
      ))}

      {current === null ? null : <Editing butler={current} onDone={() => setEditing(null)} />}

      <h2 className="butler-runs-heading">Runs</h2>
      {runs.isPending ? <Nothing kind="loading" />
        : runs.isError ? <Nothing kind="failed" detail={runs.error.message} />
          : <Runs runs={runs.data.runs} />}
    </>
  );
}
