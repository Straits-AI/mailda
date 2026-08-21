import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import {
  MATTER_TYPES, askToLiftHold, askToRead, closeMatter, openMatter, placeHold, runExport,
  useExports, useHolds, useMailboxes, useMatters, useSupervised,
} from "../api.ts";

/**
 * Investigations, and everything they authorise (#63, #64, #65, #81).
 *
 * ## Why four things share one screen
 *
 * A matter, a legal hold, a supervised read and an e-discovery export are not four features. They are one
 * sequence: something happens, somebody opens a **matter**, mail gets **held** so it cannot be deleted,
 * somebody is allowed to **read** a colleague's mailbox for a bounded time, and a **copy** may be taken out.
 * Each step cites the matter before it. Splitting them across four screens would make an investigator
 * navigate the relationship the data already has, and would hide the one thing that ties them: closing the
 * matter is what makes §7's notice to the person who was read about fall due.
 *
 * ## The matter is first because it is the thing that can close
 *
 * §7 requires telling the employee **after the matter closes**, and free text cannot close. That is why
 * `matters` is an object at all rather than a description field on a grant, and it is why this screen is
 * organised around it: the close button is the obligation, and it is on the row where a person will meet it.
 *
 * ## Nothing here pretends to be immediate
 *
 * A hold lift needs two other people. A supervised read needs two approvals, neither of them the requester.
 * An export needs an approval and then a run. Every act on this screen therefore reports what it **asked
 * for**, never what happened — the same distinction the domain pause makes, and for the same reason: an
 * investigator who believes a grant is live will act as though they can read, and they cannot.
 */

function when(at: string | null): string {
  return at === null ? "—" : new Date(at).toLocaleString();
}

const SCOPES = [
  { scope: "metadata", what: "Senders, subjects and dates. Not the messages." },
  { scope: "content", what: "The messages themselves." },
] as const;

export function Matters() {
  const matters = useMatters();
  const holds = useHolds();
  const supervised = useSupervised();
  const exports = useExports();
  const mailboxes = useMailboxes();
  const queryClient = useQueryClient();

  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [type, setType] = useState<string>(MATTER_TYPES[0].type);
  const [description, setDescription] = useState("");
  const [holdMailbox, setHoldMailbox] = useState("");
  const [holdMatter, setHoldMatter] = useState("");
  const [readMailbox, setReadMailbox] = useState("");
  const [readScope, setReadScope] = useState<string>("metadata");
  const [readHours, setReadHours] = useState(24);
  const [readMatter, setReadMatter] = useState("");

  async function refresh() {
    for (const key of ["matters", "holds", "supervised", "exports", "approvals"]) {
      await queryClient.invalidateQueries({ queryKey: [key] });
    }
  }

  async function run(act: () => Promise<{ ok: true } | { ok: false; message: string }>, said: string) {
    setProblem(null);
    setAsked(null);
    const outcome = await act();
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setAsked(said);
    await refresh();
  }

  const open = (matters.data?.matters ?? []).filter((matter) => matter.closedAt === null);

  return (
    <>
      <header className="ledger-head">
        <h1>Matters</h1>
        {matters.isSuccess ? <p className="dim mono">{open.length} open</p> : null}
      </header>

      <p className="dim">
        An investigation, and what it authorises. Mail is held so it cannot be deleted, a colleague&rsquo;s
        mailbox may be read for a bounded time, a copy may be taken. Closing the matter is what makes the
        notice to the person who was read about fall due (§7).
      </p>

      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{problem}</pre>}
      {asked === null ? null : <p className="notice" role="status">{asked}</p>}

      {/* ------------------------------------------------------------------ matters ----------------- */}
      <section className="matter-block" aria-label="Open a matter">
        <h2>Matters</h2>
        <div className="limits-ask">
          <label className="field-row" htmlFor="matter-type">
            <span>What kind</span>
            <select id="matter-type" value={type} onChange={(event) => setType(event.target.value)}>
              {MATTER_TYPES.map((entry) => (
                <option key={entry.type} value={entry.type}>{entry.what}</option>
              ))}
            </select>
          </label>
          <label className="field-row" htmlFor="matter-description">
            <span>Describe it</span>
            <input
              id="matter-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={description.trim() === ""}
            onClick={() => void run(
              () => openMatter(type, description.trim()),
              "Matter opened.",
            )}
          >
            open a matter
          </button>
        </div>

        {matters.isError ? (
          <Nothing kind="empty" detail="No matters, or you do not hold org.admin." />
        ) : (matters.data?.matters ?? []).length === 0 ? (
          <Nothing kind="empty" detail="No matters. Nothing is under investigation." />
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th scope="col">Matter</th><th scope="col">Kind</th><th scope="col">Opened</th>
                  <th scope="col">State</th><th scope="col">Close</th>
                </tr>
              </thead>
              <tbody>
                {(matters.data?.matters ?? []).map((matter) => (
                  <tr key={matter.id}>
                    <td>{matter.description}<br /><span className="dim mono">{matter.id}</span></td>
                    <td>{matter.type.replace(/_/g, " ")}</td>
                    <td className="mono">{when(matter.openedAt)}</td>
                    <td>
                      {matter.closedAt === null
                        ? <span>open</span>
                        : <span className="dim">closed {when(matter.closedAt)}</span>}
                    </td>
                    <td>
                      {matter.closedAt === null ? (
                        <button
                          type="button"
                          className="linkish"
                          onClick={() => void run(
                            () => closeMatter(matter.id),
                            "Matter closed. The people whose mail was read will be told.",
                          )}
                        >
                          close
                        </button>
                      ) : <span className="dim">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ holds ------------------- */}
      <section className="matter-block" aria-label="Legal holds">
        <h2>Held mail</h2>
        <p className="dim">
          While a mailbox is held, nothing in it can be deleted — not by a person, not by the reconciler.
          Lifting a hold takes two other people.
        </p>
        <div className="limits-ask">
          <label className="field-row" htmlFor="hold-mailbox">
            <span>Mailbox</span>
            <select
              id="hold-mailbox"
              value={holdMailbox}
              onChange={(event) => setHoldMailbox(event.target.value)}
            >
              <option value="">choose…</option>
              {(mailboxes.data?.mailboxes ?? []).map((box) => (
                <option key={box.id} value={box.id}>{box.name}</option>
              ))}
            </select>
          </label>
          <label className="field-row" htmlFor="hold-matter">
            <span>Under which matter</span>
            <select id="hold-matter" value={holdMatter} onChange={(event) => setHoldMatter(event.target.value)}>
              {/*
                "None" is a real option, not an oversight. #63 settled that the realistic first act precedes
                any matter — somebody preserves mail before anybody has written down why — so a hold cites a
                matter **or nothing**, and forcing one here would make people invent one.
              */}
              <option value="">no matter yet</option>
              {open.map((matter) => (
                <option key={matter.id} value={matter.id}>{matter.description}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={holdMailbox === ""}
            onClick={() => void run(
              () => placeHold(holdMailbox, holdMatter === "" ? null : holdMatter),
              "Hold placed. Nothing in that mailbox can be deleted now.",
            )}
          >
            hold this mailbox
          </button>
        </div>

        {holds.isError ? (
          <Nothing kind="empty" detail="No holds, or you do not hold org.admin." />
        ) : (holds.data?.holds ?? []).length === 0 ? (
          <Nothing kind="empty" detail="Nothing is held." />
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th scope="col">Mailbox</th><th scope="col">Matter</th>
                  <th scope="col">Since</th><th scope="col">Lift</th>
                </tr>
              </thead>
              <tbody>
                {(holds.data?.holds ?? []).map((hold) => (
                  <tr key={hold.id}>
                    <td className="mono">
                      {hold.mailboxId}
                      {/* A hold on a mailbox that no longer exists still preserves; saying so avoids a
                          reader concluding the row is stale and lifting it. */}
                      {hold.mailboxExists ? null : <span className="dim"> (mailbox gone)</span>}
                    </td>
                    <td className="mono dim">{hold.matterId ?? "none"}</td>
                    <td className="mono">{when(hold.placedAt)}</td>
                    <td>
                      {hold.pendingLift !== null ? (
                        <span className="dim">a lift is waiting on two approvals</span>
                      ) : (
                        <button
                          type="button"
                          className="linkish"
                          onClick={() => void run(
                            () => askToLiftHold(hold.id, "no longer required"),
                            "Asked. Two other people have to agree before this hold lifts.",
                          )}
                        >
                          ask to lift
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ supervised reads -------- */}
      <section className="matter-block" aria-label="Supervised reading">
        <h2>Reading somebody else&rsquo;s mail</h2>
        <p className="dim">
          A time-boxed grant to read a mailbox you hold nothing on. Two people have to approve it, neither of
          them you, and it stops at its expiry — renewal is a new request, because time is part of what was
          approved.
        </p>
        <div className="limits-ask">
          <label className="field-row" htmlFor="read-mailbox">
            <span>Mailbox</span>
            <select id="read-mailbox" value={readMailbox} onChange={(event) => setReadMailbox(event.target.value)}>
              <option value="">choose…</option>
              {(mailboxes.data?.mailboxes ?? []).map((box) => (
                <option key={box.id} value={box.id}>{box.name}</option>
              ))}
            </select>
          </label>
          <label className="field-row" htmlFor="read-scope">
            <span>How much</span>
            <select id="read-scope" value={readScope} onChange={(event) => setReadScope(event.target.value)}>
              {SCOPES.map((entry) => (
                <option key={entry.scope} value={entry.scope}>{entry.what}</option>
              ))}
            </select>
          </label>
          <label className="field-row" htmlFor="read-hours">
            <span>For how long (hours)</span>
            <input
              id="read-hours"
              type="number"
              min={1}
              value={readHours}
              onChange={(event) => setReadHours(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
          <label className="field-row" htmlFor="read-matter">
            <span>Under which matter</span>
            <select id="read-matter" value={readMatter} onChange={(event) => setReadMatter(event.target.value)}>
              <option value="">no matter yet</option>
              {open.map((matter) => (
                <option key={matter.id} value={matter.id}>{matter.description}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={readMailbox === ""}
            onClick={() => void run(
              () => askToRead(readMailbox, readScope, readHours * 3600, readMatter === "" ? null : readMatter),
              "Asked. Two people have to approve before you can read anything.",
            )}
          >
            ask to read
          </button>
        </div>

        {(supervised.data?.supervised ?? []).length === 0 ? (
          <Nothing kind="empty" detail="Nobody has been granted a supervised read." />
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th scope="col">Who</th><th scope="col">Mailbox</th><th scope="col">How much</th>
                  <th scope="col">Until</th><th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {(supervised.data?.supervised ?? []).map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.subjectId}</td>
                    <td className="mono">{row.mailboxId}</td>
                    <td>{row.scope}</td>
                    <td className="mono">{when(row.expiresAt)}</td>
                    <td>
                      {/*
                        Three states, and the middle one is the one that matters: a **requested** grant
                        grants nothing. Rendering "granted" from the row's existence would tell an
                        investigator they may read when they may not.
                      */}
                      {row.live
                        ? <span>reading now</span>
                        : row.grantedAt === null
                          ? <span className="dim">waiting on two approvals</span>
                          : <span className="dim">expired</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ exports ----------------- */}
      <section className="matter-block" aria-label="Exports">
        <h2>Copies taken out</h2>
        <p className="dim">
          An export produces mail that leaves this Node&rsquo;s controls. It cites a matter, it is approved
          before it runs, and what it emitted is counted.
        </p>
        {(exports.data?.exports ?? []).length === 0 ? (
          <Nothing kind="empty" detail="No exports have been requested." />
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th scope="col">Matter</th><th scope="col">Mailbox</th><th scope="col">Asked by</th>
                  <th scope="col">State</th><th scope="col" className="num">Messages</th>
                  <th scope="col">Run</th>
                </tr>
              </thead>
              <tbody>
                {(exports.data?.exports ?? []).map((row) => (
                  <tr key={row.id}>
                    <td className="mono dim">{row.matterId}</td>
                    <td className="mono">{row.mailboxId}</td>
                    <td className="mono">{row.requestedBy}</td>
                    <td>
                      {row.state}
                      {row.stateReason === null ? null : <span className="dim"> · {row.stateReason}</span>}
                    </td>
                    <td className="num mono">{row.messagesEmitted} of {row.maxMessages}</td>
                    <td>
                      {/*
                        An export runs in pages and is resumable, so "run" is offered while it is unfinished
                        rather than once: pressing it again continues from its cursor instead of starting a
                        second copy.
                      */}
                      {row.completedAt === null ? (
                        <button
                          type="button"
                          className="linkish"
                          onClick={() => void run(() => runExport(row.id), "Export run.")}
                        >
                          run
                        </button>
                      ) : <span className="dim">{when(row.completedAt)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
