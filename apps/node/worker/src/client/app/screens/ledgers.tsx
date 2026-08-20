import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { apiFetch } from "/app/session.js";
import { DELIVERY_STATES, UNOBSERVED, describeReason, describeSend, orderRecipients, summariseDelivery } from "/app/delivery.js";

import { Nothing } from "../chrome.tsx";
import { type SendRow, useAudit, useDoctor, useLogs, useSends } from "../api.ts";

/**
 * The three ledgers and the diagnostic. Full-width tables, because for a ledger that is the right form.
 *
 * ## The delivery vocabulary is imported, not restated
 *
 * `summariseDelivery` and the state words come from `/app/delivery.js` at runtime rather than being
 * bundled or reimplemented. That module is the one place the rule lives — *never suppress an outcome just
 * because the recipients agree, because they agree when everything bounced too* — and
 * `test/node/delivery-summary.test.ts` evaluates the same served bytes. Reimplementing it in React would
 * have recreated exactly the bug that rule exists to prevent, in a file the test cannot see.
 */

/** ADR 39's seven plus `withheld` and `awaiting`, nothing collapsed away. */
/*
 * The send-state words moved to `/app/delivery.js`.
 *
 * They were a literal map here, keyed on `state` alone, and `outcome_unknown` therefore read "We do not know
 * whether it left" even when the Node could prove it had not — `fidelity === "authored"` with no submitted
 * key means the bytes were stored before the transport was asked, and there are none. That is a *reading* of
 * three fields rather than a lookup on one, and it belongs beside the delivery vocabulary in a module a test
 * can import. This screen touches `document`, which is why the previous honesty defect in the outbox lived
 * here uncovered.
 */

function clock(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

function DeliveryChips({ send }: { send: SendRow }) {
  const summary = summariseDelivery(send.recipients);
  return (
    <>
      {summary.map((entry) => (
        <span
          key={entry.state}
          className={`state delivery-${entry.state} delivery-chip`}
          title={entry.note}
        >
          {send.recipients.length === 1 ? entry.label : `${entry.count} ${entry.label}`}
        </span>
      ))}
    </>
  );
}

function Recipients({ send }: { send: SendRow }) {
  if (send.recipients.length === 0) return null;
  return (
    <>
      <dt>recipients</dt>
      <dd>
        <div className="recipients">
          {orderRecipients(send.recipients).map((recipient) => {
            const observed =
              recipient.delivery_state == null
                ? UNOBSERVED
                : (DELIVERY_STATES[recipient.delivery_state] ?? { label: recipient.delivery_state, note: "" });
            return (
              <div className="recipient" key={`${recipient.kind}:${recipient.address}`}>
                <span className="label">{recipient.kind}</span>
                <span className="mono">{recipient.address}</span>
                <span
                  className={`state delivery-${recipient.delivery_state ?? "unobserved"}`}
                  title={observed.note + (recipient.bounce_type ? ` (${recipient.bounce_type})` : "")}
                >
                  {observed.label}
                </span>
                {recipient.last_error ? (
                  // The provider's own words. A paraphrase of somebody else's mail server is a guess.
                  <span className="dim mono recipient-error">{recipient.last_error}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </dd>
    </>
  );
}

export function Outbox() {
  const sends = useSends();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (sends.isPending || sends.isError) {
    return (
      <section className="ledger" aria-label="Outbox">
        <header className="ledger-head"><h1>Outbox</h1></header>
        {sends.isPending ? <Nothing kind="loading" /> : <Nothing kind="failed" detail={sends.error.message} />}
      </section>
    );
  }

  const { sends: rows, daily, capability } = sends.data;

  async function stop(id: string) {
    const response = await apiFetch(`/api/sends/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    const outcome = (await response.json()) as { cancelled: boolean; reason?: string };
    // Refetched rather than patched locally: the reason a cancel failed is a server fact, and guessing the
    // new state here is how a UI ends up disagreeing with the ledger it is displaying.
    await queryClient.invalidateQueries({ queryKey: ["sends"] });
    // Rendered, not alerted. `window.alert` blocks the page, cannot be styled or announced properly, and the
    // reason a send could not be stopped is exactly the kind of message somebody needs to read twice.
    if (!outcome.cancelled) setProblem(outcome.reason ?? "It could not be stopped.");
  }

  return (
    <section className="ledger" aria-label="Outbox">
      <header className="ledger-head">
        <h1>Outbox</h1>
        <p className="dim mono">{rows.length} sends</p>
      </header>

      {capability.canSend ? null : (
        <p className="notice bad">{capability.detail}</p>
      )}
      {problem === null ? null : <p className="notice bad" role="alert">{problem}</p>}
      <p className="notice dim">
        {daily.throttledAtCount === null
          ? `${daily.handedOver} handed over today. Your daily limit is not published by Cloudflare; it will be recorded here the first time you hit it.`
          : `${daily.handedOver} handed over today. This Node was first rate-limited at ${daily.throttledAtCount}.`}
      </p>

      {rows.length === 0 ? (
        <Nothing kind="empty" detail="Nothing has been sent from this Node yet." />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Subject</th>
              <th scope="col">To</th>
              <th scope="col">State</th>
              <th scope="col" className="num">When</th>
              <th scope="col" className="num">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((send) => {
              const state = describeSend(send);
              const reason = describeReason(send);
              const expanded = open === send.id;
              return (
                // `Fragment` with a key, not `<>`. A keyless fragment in a list leaves React reconciling
                // two rows per send by position, so re-sorting the outbox can pair a send's summary row
                // with another send's detail row. The production build strips the warning that would have
                // said so, which is why this is fixed by reasoning rather than by watching the console.
                <Fragment key={send.id}>
                  <tr className={expanded ? "entry open" : "entry"}>
                    <td>
                      <button
                        type="button"
                        className="row-toggle"
                        aria-expanded={expanded}
                        aria-controls={`detail-${send.id}`}
                        onClick={() => setOpen(expanded ? null : send.id)}
                      >
                        {send.subject}
                      </button>
                    </td>
                    <td className="dim mono">{(JSON.parse(send.envelope_to) as string[]).join(", ")}</td>
                    <td>
                      <span className={`state state-${send.state}`} title={state.note}>
                        {state.label}
                      </span>
                      {reason === null ? null : (
                        // Beside the state, not instead of it. The state says what happened to the send; the
                        // reason says who can act. Collapsing them would lose whichever half the reader needs.
                        <span className="state state-reason delivery-chip" title={reason.note}>
                          {reason.label}
                        </span>
                      )}
                      <DeliveryChips send={send} />
                    </td>
                    <td className="num mono dim">{clock(send.state_at)}</td>
                    <td className="num">
                      {send.state === "held" || send.state === "awaiting" ? (
                        // `awaiting` too, and not as a convenience. An approval-gated send is now cleared by
                        // an approver (#61), but a `policy_hold` still has no release act — and either way the
                        // author may stop their own message, which is what this is. `cancelSend` bounds the
                        // authority to the one they already hold.
                        <button type="button" className="linkish" onClick={() => void stop(send.id)}>
                          stop
                        </button>
                      ) : send.fidelity === "authored" && send.has_submitted === 1 ? (
                        // §12's point is that the submitted bytes are *producible*, so this is a link
                        // rather than a feature request — but only when they exist.
                        <a className="mono" href={`/api/sends/${encodeURIComponent(send.id)}/submitted`}>
                          .eml
                        </a>
                      ) : (
                        <span className="dim mono">—</span>
                      )}
                    </td>
                  </tr>
                  <tr id={`detail-${send.id}`} className="detail" hidden={!expanded}>
                    <td colSpan={5}>
                      <dl>
                        <dt>what this means</dt>
                        <dd>{state.note}</dd>
                        {reason === null ? null : (
                          <>
                            <dt>why</dt>
                            <dd>{reason.note}</dd>
                          </>
                        )}
                        <Recipients send={send} />
                        <dt>manifest</dt>
                        <dd className="mono">{send.id}</dd>
                        {send.last_error === null ? null : (
                          <>
                            <dt>reported</dt>
                            <dd>{send.last_error}</dd>
                          </>
                        )}
                      </dl>
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Audit() {
  const audit = useAudit();
  const [verdict, setVerdict] = useState<string | null>(null);

  if (audit.isPending || audit.isError) {
    return (
      <section className="ledger" aria-label="Audit trail">
        <header className="ledger-head"><h1>Audit</h1></header>
        {audit.isPending ? <Nothing kind="loading" /> : <Nothing kind="failed" detail={audit.error.message} />}
      </section>
    );
  }

  async function verify() {
    const response = await apiFetch("/api/audit/verify", { method: "POST" });
    const outcome = (await response.json()) as { intact: boolean; checked: number; brokenAt?: number };
    // Stated as what was checked, not as a reassurance. An unverified chain and a verified one must not
    // read the same.
    setVerdict(
      outcome.intact
        ? `${outcome.checked} entries checked, chain intact.`
        : `Chain broken at entry ${outcome.brokenAt}. ${outcome.checked} entries checked.`,
    );
  }

  return (
    <section className="ledger" aria-label="Audit trail">
      <header className="ledger-head">
        <h1>Audit</h1>
        <button type="button" className="linkish" onClick={() => void verify()}>
          verify chain
        </button>
      </header>
      {verdict === null ? null : <p className="notice mono">{verdict}</p>}
      {audit.data.entries.length === 0 ? (
        <Nothing kind="empty" detail="No audited action has been taken on this Node yet." />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col" className="num">Seq</th>
              <th scope="col">Action</th>
              <th scope="col">Outcome</th>
              <th scope="col">Subject</th>
              <th scope="col" className="num">At</th>
            </tr>
          </thead>
          <tbody>
            {audit.data.entries.map((entry) => (
              <tr key={entry.id}>
                <td className="num mono dim">{entry.seq}</td>
                <td className="mono">{entry.action}</td>
                <td>
                  <span className={`state state-audit-${entry.outcome}`}>{entry.outcome}</span>
                </td>
                <td className="mono dim">{entry.subject ?? "—"}</td>
                <td className="num mono dim">{clock(entry.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Log() {
  const logs = useLogs();
  // Heading first, then the state. See the note in inbox.tsx: a screen whose name appears only once its
  // data has arrived is a screen with no heading while it loads.
  if (logs.isPending || logs.isError) {
    return (
      <section className="ledger" aria-label="Operational log">
        <header className="ledger-head"><h1>Log</h1></header>
        {logs.isPending ? <Nothing kind="loading" /> : <Nothing kind="failed" detail={logs.error.message} />}
      </section>
    );
  }

  return (
    <section className="ledger" aria-label="Operational log">
      <header className="ledger-head">
        <h1>Log</h1>
        <p className="dim mono">
          {logs.data.counts.map((count) => `${count.n} ${count.level}`).join(" · ") || "empty"}
        </p>
      </header>
      {logs.data.entries.length === 0 ? (
        <Nothing kind="empty" detail="Nothing has been logged. This Node trims its log by design." />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Level</th>
              <th scope="col">Event</th>
              <th scope="col">Message</th>
              <th scope="col" className="num">At</th>
            </tr>
          </thead>
          <tbody>
            {logs.data.entries.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <span className={`state state-log-${entry.level}`}>{entry.level}</span>
                </td>
                <td className="mono">{entry.event}</td>
                <td>{entry.message}</td>
                <td className="num mono dim">{clock(entry.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * `doctor`, in the application.
 *
 * The framework-free version stays too, and that is not duplication for its own sake: ADR 30 keeps the
 * diagnostic reachable *before any bundle loads*, because it is the screen an operator needs precisely
 * when something else is broken — #23 was exactly that, a dropped binding making sign-in return 500 with
 * `doctor` the only working surface. This one is for the operator who is signed in and fine.
 */
export function Doctor() {
  const doctor = useDoctor();
  if (doctor.isPending || doctor.isError) {
    return (
      <section className="ledger" aria-label="Doctor">
        <header className="ledger-head"><h1>Doctor</h1></header>
        {doctor.isPending ? <Nothing kind="loading" /> : <Nothing kind="failed" detail={doctor.error.message} />}
      </section>
    );
  }

  const report = doctor.data;
  return (
    <section className="ledger" aria-label="Doctor">
      <header className="ledger-head">
        <h1>Doctor</h1>
        <span className={`state verdict-${report.verdict}`}>{report.verdict}</span>
      </header>
      <p className="notice dim mono">
        {report.claimed ? "claimed" : "unclaimed"} · read {clock(report.at)}
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">State</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {report.findings.map((finding) => (
            <tr key={finding.check}>
              <td className="mono">{finding.check}</td>
              <td>
                <span className={`state ${finding.ok ? "delivery-accepted" : `severity-${finding.severity}`}`}>
                  {finding.ok ? "ok" : finding.severity}
                </span>
              </td>
              <td>
                {finding.detail}
                {finding.fix === undefined ? null : (
                  <>
                    {" "}
                    <span className="dim">Fix: {finding.fix}</span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
