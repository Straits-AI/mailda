import { BUTLER_PAUSE_REASONS, BUTLER_RUN_STATES, BUTLER_VERSION_STATES, oneOf } from "@mailda/contract/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { t } from "/app/locale.js";
import { Nothing, Scroller } from "../chrome.tsx";
import {
  answeredNotFound, createButler, publishButlerVersion, resumeButler, saveButlerDraft,
  grant, revokeAccess, useAccessOf, useButler, useButlerRuns, useButlers, useMe, useSponsorMailboxes,
  replayButlerRun, runFacts, simulateButler,
  type ButlerRow, type ButlerRunRow, type ButlerSourceFormat, type Said, type Simulation,
} from "../api.ts";
import { count, dateTime } from "../format.ts";
import { marked, NodeWords, sentence } from "../words.tsx";

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
  return at === null ? "—" : dateTime(at);
}

/**
 * One Butler's standing, in a sentence rather than a badge.
 *
 * A badge reading "paused" beside one reading "v3" makes a reader assemble the meaning themselves, and the
 * meaning is the point: a published Butler that a breaker stopped is *live and not running*, which is not
 * what either word says alone.
 */
/** A run's state in the viewer's words (`BUTLER_RUN_STATES`, H7); a token outside the list is the Node's, marked. */
function runState(state: string): ReactNode {
  return oneOf(BUTLER_RUN_STATES, state) ? t(`butlers.run.${state}`) : <NodeWords>{state}</NodeWords>;
}

function Standing({ butler }: { butler: ButlerRow }) {
  if (butler.pause !== null) {
    return (
      <span className="bad">
        {sentence("butlers.standing.paused", {
          reason: oneOf(BUTLER_PAUSE_REASONS, butler.pause.reason)
            ? t(`butlers.pauseReason.${butler.pause.reason}`)
            : <NodeWords>{butler.pause.reason.replace(/_/g, " ")}</NodeWords>,
        })}
      </span>
    );
  }
  if (butler.live_version !== null) {
    return <span>{t("butlers.standing.live", { version: String(butler.live_version) })}</span>;
  }
  return <span className="dim">{t("butlers.standing.draftOnly")}</span>;
}

/** The editor for one Butler: its versions, its draft, and the two acts. */
function Editing({ butler, onDone }: { butler: ButlerRow; onDone: () => void }) {
  const detail = useButler(butler.id);
  const queryClient = useQueryClient();
  const [source, setSource] = useState<string | null>(null);
  const [format, setFormat] = useState<ButlerSourceFormat | null>(null);
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  /** The Node's refusal or the checker's findings (`Said`), or this screen's own sentence, shown through `marked()`. */
  const [problem, setProblem] = useState<Said | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * This Butler's runs, for the dry run's input.
   *
   * `useButlerRuns` again rather than threading them down from `Butlers`: TanStack Query dedupes on the key,
   * so this is the same request and the same cache entry, and the alternative is a prop that exists only to
   * avoid a hook call.
   */
  const ranButler = (useButlerRuns().data?.runs ?? []).filter((row) => row.butler_id === butler.id);
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
    if (!outcome.ok) { setProblem(outcome); return; }
    setSource(null);
    setFormat(null);
    await refresh();
  }

  /**
   * A dry run: what this program would do, given what a real delivery gave a real run.
   *
   * Two requests rather than one, and the first is the reason this is worth having. A delivery's facts are
   * not something a person can type — `parentDelivery` refuses a malformed set, and the recipients a `draft`
   * node derives come from them — so the input is taken from a run this Node actually performed. What the
   * author changes is the *program*, and the question the panel answers is what their edit would do to
   * mail that already arrived.
   */
  async function dryRun(runId: string) {
    setBusy(true);
    setProblem(null);
    setSimulation(null);
    try {
      const inspected = await runFacts(runId);
      if (inspected.facts === null) {
        // A run opened before migration 0030 recorded no facts. Said rather than shown as an empty report.
        setProblem({ message: t("butlers.dry.noFacts"), fromNode: false });
        return;
      }
      const outcome = await simulateButler(butler.id, inspected.facts);
      if (!outcome.ok) { setProblem(outcome); return; }
      setSimulation(outcome.value.simulation);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true);
    setProblem(null);
    const outcome = await publishButlerVersion(butler.id);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome); return; }
    await refresh();
  }

  return (
    <section className="butler-detail" aria-label={t("butlers.detail.label", { name: butler.name })}>
      <header className="ledger-head">
        <h2>{butler.name}</h2>
        <button type="button" className="linkish" onClick={onDone}>{t("butlers.close")}</button>
      </header>

      {problem === null ? null : (
        // The Node's own four-part message, verbatim: the checker names the node and says what is wrong
        // with it, and a paraphrase would drop the half that says what to do.
        <pre className="notice bad butler-findings" role="alert">{marked(problem)}</pre>
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
        <legend>{t("butlers.format")}</legend>
        {/* The format's own name, an identifier, in every locale: the Node's `sourceFormat` token. */}
        {(["yaml", "json"] as const satisfies readonly ButlerSourceFormat[]).map((option) => (
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
            <code>{option}</code>
          </label>
        ))}
        {/*
          Said in the interface because it is the one thing about this control that surprises people: it
          changes which parser reads the box, and it does **not** rewrite the box. There is no AST-to-YAML
          renderer in this system on purpose — regenerating a document from the parsed program would delete
          every comment in it — so converting is a thing an author does to their own text, and this sentence
          is what stops them expecting the button to do it.
        */}
        <span className="dim">{t("butlers.format.hint")}</span>
      </fieldset>

      <label className="field-row" htmlFor="butler-source">
        <span>{t("butlers.source")}</span>
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
        <button className="quiet" type="button" onClick={() => void save()} disabled={busy}>
          {t("butlers.saveDraft")}
        </button>
        {" "}
        <button
          type="button"
          className="primary"
          onClick={() => void publish()}
          disabled={busy || draft === null}
        >
          {t("butlers.publish")}
        </button>
        {/*
          Which program is in the box, said rather than left to be inferred. "Nothing unpublished to publish"
          alone did not answer the question somebody actually has when they open a live Butler — *is this what
          is running, or a blank page?* — and the answer differs by one save.
        */}
        {draft === null
          ? (
            <span className="dim">
              {" "}
              {live === null
                ? t("butlers.draft.none")
                : t("butlers.draft.showingLive", { version: String(live.version ?? "?") })}
            </span>
          )
          : <span className="dim">{" "}{t("butlers.draft.unpublished")}</span>}
      </p>

      {/*
        The dry run (#87).
        
        Placed between the editor and the version history because that is where it is used: you change the
        program, you ask what it would do, and only then do you publish. Putting it after the history would
        have made it a report about the past, which is the one thing it is not.
      */}
      <section className="butler-dry" aria-label={t("butlers.dry")}>
        <h3>{t("butlers.dry")}</h3>
        {ranButler.length === 0
          ? (
            /*
             * Said rather than shown as a disabled control with no explanation. A dry run needs a delivery's
             * facts, those are not typeable by hand, and the honest answer to "why can I not test this" is
             * that nothing has arrived for it yet.
             */
            <p className="dim">{t("butlers.dry.notRun")}</p>
          )
          : (
            <>
              <p className="dim">{t("butlers.dry.explain")}</p>
              <ul className="butler-dry-runs">
                {ranButler.slice(0, 5).map((row) => (
                  <li key={row.id}>
                    <button className="quiet" type="button" onClick={() => void dryRun(row.id)} disabled={busy}>
                      {t("butlers.dry.over", { at: when(row.started_at) })}
                    </button>
                    {" "}
                    <span className="dim"><code>{row.trigger_event}</code> · {runState(row.state)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

        {simulation === null ? null : (
          <div className="butler-dry-result">
            <p>
              <strong>{runState(simulation.state)}</strong>
              {simulation.reason === null ? null : <> — <NodeWords>{simulation.reason}</NodeWords></>}
              {" "}
              <span className="dim">
                {t("butlers.dry.summary", {
                  program: simulation.version === null
                    ? t("butlers.dry.draft")
                    : t("butlers.dry.version", { version: String(simulation.version) }),
                  nodes: t("butlers.dry.nodes", { n: simulation.nodesExecuted }),
                  spend: simulation.wouldSpend,
                })}
              </span>
            </p>

            {simulation.effects.length === 0
              ? <p className="dim">{t("butlers.dry.noEffect")}</p>
              : (
                <table>
                  <caption className="dim">{t("butlers.dry.caption")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("butlers.dry.col.node")}</th>
                      <th scope="col">{t("butlers.dry.col.type")}</th>
                      <th scope="col">{t("butlers.dry.col.outcome")}</th>
                      <th scope="col">{t("butlers.dry.col.detail")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {simulation.effects.map((effect) => (
                      <tr key={effect.seq}>
                        <td className="mono">{effect.nodeId}</td>
                        <td className="mono">{effect.nodeType}</td>
                        <td className={effect.outcome === "refused" || effect.outcome === "failed"
                          ? "bad"
                          : undefined}>
                          <NodeWords>{effect.outcome}</NodeWords>
                          {effect.reason === null ? null : <> — <NodeWords>{effect.reason}</NodeWords></>}
                        </td>
                        {/*
                          The detail verbatim, as JSON. It is the recipients a reply would go to and the
                          mailbox it would come from — the answer the author came for — and shaping it into
                          prose per node type would be four renderers that drift from one producer.
                        */}
                        <td className="mono butler-dry-detail">
                          {effect.detail === undefined
                            ? <span className="dim">—</span>
                            : JSON.stringify(effect.detail)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

            {simulation.limits.length === 0 ? null : (
              /*
                Rendered verbatim and never summarised. These are the sentences that stop the report being
                read as a green light: the seal is where policy, the breakers and the approval gate decide,
                and none of them ran.
              */
              <ul className="butler-dry-limits">
                {simulation.limits.map((limit) => <li key={limit}><NodeWords>{limit}</NodeWords></li>)}
              </ul>
            )}
          </div>
        )}
      </section>

      <ButlerAccess butlerId={butler.id} name={butler.name} />

      <table>
        <caption className="dim">{t("butlers.versions.caption")}</caption>
        <thead>
          {/* `scope="col"` on every header, as the ledgers do: it is what tells a screen reader which
              header announces a cell, and a table this wide is unreadable without it. */}
          <tr>
            <th scope="col">{t("butlers.versions.col.version")}</th>
            <th scope="col">{t("butlers.col.state")}</th>
            <th scope="col">{t("butlers.col.published")}</th>
            <th scope="col">{t("butlers.versions.col.by")}</th>
            <th scope="col">{t("butlers.versions.col.ast")}</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((row) => (
            <tr key={row.id}>
              <td className="mono">{row.version ?? "—"}</td>
              <td>{oneOf(BUTLER_VERSION_STATES, row.state) ? t(`butlers.version.${row.state}`) : <NodeWords>{row.state}</NodeWords>}</td>
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
/**
 * The three mailbox permissions a Butler may declare and be granted, in the order People shows them. Equal to
 * `CAPABILITY_ACTIONS` in `@mailda/butler-ast`, held by `butlers-words.test.tsx`; restated here because importing
 * that module would bring its schemas into the shell's bundle for three strings.
 */
export const BUTLER_RELATIONS = ["mailbox.metadata.read", "mailbox.content.read", "send.propose"] as const;

/**
 * Which mailboxes this Butler may act on (10 October 2026): its own grants, one box per mailbox and permission,
 * each taking effect when it is ticked, as People's grid does. A Butler is its own principal (§16) and acts only
 * where its program declares the capability, it holds the grant, and whoever published it holds it too. Until this
 * the grant was an API call and the Butler's id was on no screen, so a Butler published here refused its every
 * effect with `case_not_actionable`, found while recording the product.
 */
function ButlerAccess({ butlerId, name }: { butlerId: string; name: string }) {
  const me = useMe();
  // Every mailbox: the catalogue the agent form uses, read here for its names, not for what the reader holds.
  const mailboxes = useSponsorMailboxes(me.data?.userId ?? null);
  const access = useAccessOf(butlerId);
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<Said | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const held = new Set((access.data?.relations ?? []).map((one) => `${one.objectId} ${one.relation}`));

  async function toggle(mailboxId: string, relation: string, on: boolean) {
    setBusy(`${mailboxId} ${relation}`);
    setProblem(null);
    const outcome = on ? await grant(butlerId, relation, mailboxId) : await revokeAccess(butlerId, relation, mailboxId);
    setBusy(null);
    if (!outcome.ok) { setProblem(outcome); return; }
    await queryClient.invalidateQueries({ queryKey: ["access", butlerId] });
  }

  return (
    <section className="butler-access" aria-label={t("butlers.access.heading")}>
      <h3>{t("butlers.access.heading")}</h3>
      <p className="dim">{t("butlers.access.note")}</p>
      {problem === null ? null : <p className="notice bad" role="alert">{marked(problem)}</p>}
      {mailboxes.isPending || access.isPending ? <Nothing kind="loading" /> : null}
      {mailboxes.isError ? <Nothing kind="failed" detail={marked(mailboxes.error)} /> : null}
      {access.isError ? <Nothing kind="failed" detail={marked(access.error)} /> : null}
      {mailboxes.isSuccess && mailboxes.data.mailboxes.length === 0 ? <p className="dim">{t("butlers.access.none")}</p> : null}
      {mailboxes.isSuccess && access.isSuccess && mailboxes.data.mailboxes.length > 0 ? (
        <Scroller label={t("butlers.access.heading")}>
          <table className="grant-grid">
            <thead>
              <tr>
                <th scope="col">{t("butlers.access.col.mailbox")}</th>
                {/* People's words for the three, the code kept as the title: the grid reads like People's. */}
                {BUTLER_RELATIONS.map((relation) => (
                  <th key={relation} scope="col" title={relation}>{t(`people.relation.${relation}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mailboxes.data.mailboxes.map((box) => (
                <tr key={box.mailboxId}>
                  <th scope="row">{box.mailboxName}</th>
                  {BUTLER_RELATIONS.map((relation) => (
                    <td key={relation}>
                      <input
                        type="checkbox"
                        aria-label={t("butlers.access.box", { permission: t(`people.relation.${relation}`), mailbox: box.mailboxName, butler: name })}
                        checked={held.has(`${box.mailboxId} ${relation}`)}
                        disabled={busy === `${box.mailboxId} ${relation}`}
                        onChange={(event) => void toggle(box.mailboxId, relation, event.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      ) : null}
    </section>
  );
}

function Paused({ butler }: { butler: ButlerRow }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<Said | null>(null);
  if (butler.pause === null) return null;

  async function resume() {
    setProblem(null);
    const outcome = await resumeButler(butler.pause!.pauseId, reason);
    if (!outcome.ok) { setProblem(outcome); return; }
    setReason("");
    await queryClient.invalidateQueries({ queryKey: ["butlers"] });
  }

  return (
    <div className="butler-pause notice bad">
      {/* The detector's own sentence. Somebody deciding whether to re-arm a Butler needs what it counted,
          not the word "paused". */}
      <p><NodeWords>{butler.pause.detail}</NodeWords></p>
      <p className="dim mono">{t("butlers.pause.placed", { by: butler.pause.trippedBy, at: when(butler.pause.placedAt) })}</p>
      <label className="field-row" htmlFor={`resume-${butler.id}`}>
        <span>{t("butlers.pause.why")}</span>
        <input
          id={`resume-${butler.id}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <button className="quiet" type="button" onClick={() => void resume()} disabled={reason.trim() === ""}>
        {t("butlers.pause.resume")}
      </button>
      {problem === null ? null : <p role="alert">{marked(problem)}</p>}
    </div>
  );
}

function Runs({ runs, onRunAgain }: { runs: ButlerRunRow[]; onRunAgain: (runId: string) => void }) {
  if (runs.length === 0) {
    return <Nothing kind="empty" detail={t("butlers.runs.none")} />;
  }
  return (
    <Scroller label={t("butlers.runs")}>
      {/*
        Said plainly, because "replay" invites the reading that nothing happens. A re-run is a new run whose
        writes are real; what makes it safe to offer is the gate, not the word — a Butler's send waits in the
        outbox for a person, so this button on its own moves no mail. See `replayButlerRun`.
      */}
      <p className="dim">{sentence("butlers.runs.explain", { again: <em>{t("butlers.runs.again")}</em> })}</p>
      <table>
        <thead>
          <tr>
            <th scope="col">{t("butlers.runs.col.started")}</th>
            <th scope="col">{t("butlers.col.state")}</th>
            <th scope="col">{t("butlers.runs.col.why")}</th>
            <th scope="col" className="num">{t("butlers.runs.col.nodes")}</th>
            <th scope="col" className="num">{t("butlers.runs.col.effects")}</th>
            <th scope="col" className="num">{t("butlers.runs.col.refusals")}</th>
            <th scope="col" className="num">{t("butlers.runs.col.spent")}</th>
            <th scope="col">{t("butlers.runs.col.again")}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td className="mono">{when(run.started_at)}</td>
              <td className={run.state === "failed" ? "bad" : undefined}>{runState(run.state)}</td>
              {/* The reason is the deliverable: `stopped` alone does not distinguish a Butler that decided
                  nothing needed doing from one a budget killed. */}
              <td>{run.outcome_reason === null ? <span className="dim">—</span> : <NodeWords>{run.outcome_reason}</NodeWords>}</td>
              <td className="mono num">{count(run.nodes_executed)}</td>
              <td className="mono num">{count(run.effects)}</td>
              <td className="mono num">{count(run.refusals)}</td>
              <td className="mono num">{count(run.subrequests_spent)}</td>
              <td>
                {/* Offered on every finished run: whether it *can* be re-run (input recorded, version still
                    published, Butler not paused) is the Node's answer, and its refusal names which. */}
                {run.finished_at === null ? <span className="dim">—</span> : (
                  <button type="button" className="linkish" onClick={() => onRunAgain(run.id)}>
                    {t("butlers.runs.again")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroller>
  );
}

export function Butlers() {
  const butlers = useButlers();
  const runs = useButlerRuns();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState<Said | null>(null);
  const [ranAgain, setRanAgain] = useState<string | null>(null);

  async function runAgain(runId: string) {
    setProblem(null);
    setRanAgain(null);
    const outcome = await replayButlerRun(runId);
    if (!outcome.ok) { setProblem(outcome); return; }
    setRanAgain(outcome.value.runId);
    await queryClient.invalidateQueries({ queryKey: ["butler-runs"] });
  }

  async function create() {
    setProblem(null);
    const outcome = await createButler("new butler", STARTER, "yaml");
    if (!outcome.ok) { setProblem(outcome); return; }
    await queryClient.invalidateQueries({ queryKey: ["butlers"] });
    setEditing(outcome.value.butler.butlerId);
  }

  const heading = (
    <header className="ledger-head">
      <h1>{t("route./butlers")}</h1>
      <p className="new-message">
        <button type="button" className="primary" onClick={() => void create()}>{t("butlers.new")}</button>
      </p>
    </header>
  );

  if (butlers.isPending) return <>{heading}<Nothing kind="loading" /></>;
  /*
   * A 404 here means "not an administrator", by §5C — the read deliberately cannot distinguish that from an
   * organization with no Butlers, and this screen must not undo that by guessing which it was. So the
   * message says what somebody in either position can act on and asserts neither. Any other failure is a
   * failed read, and says so.
   */
  if (butlers.isError) {
    return (
      <>
        {heading}
        {answeredNotFound(butlers.error)
          ? <Nothing kind="empty" detail={t("butlers.notAdmin")} />
          : <Nothing kind="failed" detail={marked(butlers.error)} />}
      </>
    );
  }

  const rows = butlers.data.butlers;
  const current = rows.find((row) => row.id === editing) ?? null;

  return (
    <>
      {heading}
      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{marked(problem)}</pre>}

      {rows.length === 0 ? (
        <Nothing kind="empty" detail={t("butlers.empty")} />
      ) : (
        <Scroller label={t("route./butlers")}>
          <table>
            <thead>
              {/*
                The last column is named rather than left as `<th />`. axe's `empty-table-header` caught it
                on this screen's first audit, and the rule is right: an unnamed header makes the cell under
                it announce with nothing, so the "open" control belongs to no column a reader can hear.
              */}
              <tr>
                <th scope="col">{t("butlers.col.name")}</th>
                <th scope="col">{t("butlers.col.standing")}</th>
                <th scope="col">{t("butlers.col.published")}</th>
                <th scope="col">{t("butlers.col.draft")}</th>
                <th scope="col">{t("butlers.col.editor")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td><Standing butler={row} /></td>
                  <td className="mono">{when(row.published_at)}</td>
                  <td className="dim">{row.draft_version_id === null ? "—" : t("butlers.unpublishedChanges")}</td>
                  <td>
                    <button type="button" className="linkish" onClick={() => setEditing(row.id)}>
                      {t("butlers.open")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      )}

      {rows.filter((row) => row.pause !== null).map((row) => (
        <Paused key={row.id} butler={row} />
      ))}

      {current === null ? null : <Editing butler={current} onDone={() => setEditing(null)} />}

      <h2 className="butler-runs-heading">{t("butlers.runs")}</h2>
      {ranAgain === null ? null : (
        <p className="notice" role="status">
          {sentence("butlers.startedAgain", { run: <span className="mono">{ranAgain}</span> })}
        </p>
      )}
      {runs.isPending ? <Nothing kind="loading" />
        : runs.isError ? <Nothing kind="failed" detail={marked(runs.error)} />
          : <Runs runs={runs.data.runs} onRunAgain={(runId) => void runAgain(runId)} />}
    </>
  );
}
