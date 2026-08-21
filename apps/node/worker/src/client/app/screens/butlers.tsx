import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import {
  createButler, publishButlerVersion, resumeButler, saveButlerDraft,
  useButler, useButlerRuns, useButlers,
  type ButlerRow, type ButlerRunRow, type ButlerSourceFormat,
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
/**
 * What a new Butler starts as: YAML, with comments (#87).
 *
 * The starter was JSON until the parser landed, and switching it is the substance of the change rather than
 * a decoration. A new author's first encounter with this feature is this text, and in JSON it could not
 * contain a single word about what any of it means — every line below that begins with `#` is a line the
 * previous starter structurally could not have.
 *
 * It is deliberately a Butler that **does nothing**: one `stop` node, no capabilities. A starter that
 * proposed a send would be a program somebody publishes to see what happens, and what happens is mail.
 */
const STARTER = `# A new Butler. It does nothing yet — the one node below stops immediately.
#
# Delete these comments or keep them: the text you write is stored exactly as you write it, and
# comments are the reason this is YAML rather than JSON. Switch the format to json above if you
# would rather write it that way; nothing here rewrites your text for you.
apiVersion: mailda/v1
kind: Butler
metadata:
  name: new butler
  # A team rather than a person, so a leaver does not strand the Butler.
  owner: team:support

# Nothing is permitted until it is listed here. An empty list is a Butler that can read its trigger
# and decide, and can cause no effect at all.
capabilities: []

trigger:
  event: mail.received
  mailbox: support@example.com

entry: halt
nodes:
  - id: halt
    type: stop
    reason: not doing anything yet
`;

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
  const [format, setFormat] = useState<ButlerSourceFormat | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const versions = detail.data?.versions ?? [];
  const draft = versions.find((row) => row.state === "draft") ?? null;
  const live = versions.find((row) => row.state === "published") ?? null;
  /*
   * The draft if there is one, **otherwise what is running**.
   *
   * Falling back to the live version is not a convenience. Without it, opening a published Butler that has no
   * draft showed an empty box — which reads as *this Butler has no program*, over one that is live, and
   * invites somebody to write its replacement from scratch instead of editing what it does. Editing a
   * published Butler means starting from the published program.
   *
   * `??` throughout rather than `||`: an empty draft body is a real state — somebody clearing the box and
   * saving — and `||` would silently fall through it to the live source, resurrecting text they deleted.
   */
  const editing = source ?? draft?.source_text ?? live?.source_text ?? "";
  /*
   * The format follows the text, by the same `??` chain and for the same reason: opening a published YAML
   * Butler with the selector reading "json" would offer to re-parse the author's document in a grammar it
   * was not written in, and the first save would refuse with a syntax error about a document nobody touched.
   *
   * `"json"` last, because a Butler stored before #87 has no other truthful answer.
   */
  const editingFormat = format ?? draft?.source_format ?? live?.source_format ?? "json";

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["butlers"] });
    await queryClient.invalidateQueries({ queryKey: ["butler", butler.id] });
  }

  async function save() {
    setBusy(true);
    setProblem(null);
    const outcome = await saveButlerDraft(butler.id, editing, editingFormat);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setSource(null);
    setFormat(null);
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

      {/*
        A radio group rather than a `<select>`, because there are two options and both fit on the line — so
        the current one is readable without opening anything, which is what a control that changes how the
        box below is *parsed* should be.

        `fieldset`/`legend` rather than a bare pair with a label: two radios sharing a name are one question,
        and a screen reader that announces "json, radio, 1 of 2" without the question has read out half of
        it. That is the axe best-practice advisory this screen would otherwise carry.
      */}
      <fieldset className="field-row butler-format">
        <legend>format</legend>
        {(["yaml", "json"] as const).map((option) => (
          <label key={option} htmlFor={`butler-format-${option}`}>
            <input
              type="radio"
              id={`butler-format-${option}`}
              name="butler-format"
              value={option}
              checked={editingFormat === option}
              onChange={() => setFormat(option)}
            />
            {" "}
            {option}
          </label>
        ))}
        {/*
          Said in the interface because it is the one thing about this control that surprises people: it
          changes which parser reads the box, and it does **not** rewrite the box. There is no AST-to-YAML
          renderer in this system on purpose — regenerating a document from the parsed program would delete
          every comment in it — so converting is a thing an author does to their own text, and this sentence
          is what stops them expecting the button to do it.
        */}
        <span className="dim">
          which parser reads the source below. Switching it does not rewrite your text
        </span>
      </fieldset>

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
        {/*
          Which program is in the box, said rather than left to be inferred. "Nothing unpublished to publish"
          alone did not answer the question somebody actually has when they open a live Butler — *is this what
          is running, or a blank page?* — and the answer differs by one save.
        */}
        {draft === null
          ? (
            <span className="dim">
              {live === null
                ? " nothing saved yet"
                : ` showing live v${live.version ?? "?"} — save a draft to change it`}
            </span>
          )
          : <span className="dim"> unpublished draft</span>}
      </p>

      <table>
        <caption className="dim">Versions — publication is the versioning event, and a published one is frozen</caption>
        <thead>
          {/* `scope="col"` on every header, as the ledgers do: it is what tells a screen reader which
              header announces a cell, and a table this wide is unreadable without it. */}
          <tr>
            <th scope="col">Version</th>
            <th scope="col">State</th>
            <th scope="col">Published</th>
            <th scope="col">By</th>
            <th scope="col">AST sha256</th>
          </tr>
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
    const outcome = await resumeButler(butler.pause!.pauseId, reason);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setReason("");
    await queryClient.invalidateQueries({ queryKey: ["butlers"] });
  }

  return (
    <div className="butler-pause notice bad">
      {/* The detector's own sentence. Somebody deciding whether to re-arm a Butler needs what it counted,
          not the word "paused". */}
      <p>{butler.pause.detail}</p>
      <p className="dim mono">placed by {butler.pause.trippedBy} · {when(butler.pause.placedAt)}</p>
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
            <th scope="col">Started</th>
            <th scope="col">State</th>
            <th scope="col">Why it ended</th>
            <th scope="col" className="num">Nodes</th>
            <th scope="col" className="num">Effects</th>
            <th scope="col" className="num">Refusals</th>
            <th scope="col" className="num">Spent</th>
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
    const outcome = await createButler("new butler", STARTER, "yaml");
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
              {/*
                The last column is named rather than left as `<th />`. axe's `empty-table-header` caught it
                on this screen's first audit, and the rule is right: an unnamed header makes the cell under
                it announce with nothing, so the "open" control belongs to no column a reader can hear.
              */}
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Standing</th>
                <th scope="col">Published</th>
                <th scope="col">Draft</th>
                <th scope="col">Editor</th>
              </tr>
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
