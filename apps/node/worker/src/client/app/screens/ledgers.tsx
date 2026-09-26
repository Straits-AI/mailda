import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { apiFetch } from "/app/session.js";
import { DELIVERY_STATES, UNOBSERVED, describeReason, describeSend, orderRecipients, summariseDelivery } from "/app/delivery.js";

import { Nothing, Truncated } from "../chrome.tsx";
import {
  acknowledgeConflict, applyMigrations, type AuditRow, configureTransport, confirmRecoveryCode,
  type DoctorFinding, type EvidenceVerdict, type RecoveryCodesMinted, reconcileEvidence, repairSearch,
  resealEvidence, rotateRecoveryCodes, type SendRow, useAudit, useDoctor, useLogs, useSearchFailed,
  useSends, useTransport, verifyEvidence,
} from "../api.ts";

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
  /** The send whose duplicate-risk resend is waiting for a reason, or null. */
  const [resending, setResending] = useState<string | null>(null);
  const [resendReason, setResendReason] = useState("");

  if (sends.isPending || sends.isError) {
    return (
      <section className="ledger" aria-label="Outbox">
        <header className="ledger-head"><h1>Outbox</h1></header>
        {sends.isPending ? <Nothing kind="loading" /> : <Nothing kind="failed" detail={sends.error.message} />}
      </section>
    );
  }

  const { sends: rows, daily, capability } = sends.data;
  const resendTarget = rows.find((one) => one.id === resending) ?? null;

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

  /**
   * Lets go a send a rule held.
   *
   * The same shape as `stop`: refetch rather than patch, and render the Node's refusal rather than guess.
   * The reason matters more here than for a cancel — "this message is waiting on an approval, which this
   * does not clear" tells somebody which gate they are actually looking at.
   */
  async function release(id: string) {
    const response = await apiFetch(`/api/sends/${encodeURIComponent(id)}/release-hold`, { method: "POST" });
    const outcome = (await response.json()) as { released: boolean; reason?: string };
    await queryClient.invalidateQueries({ queryKey: ["sends"] });
    if (!outcome.released) setProblem(outcome.reason ?? "It could not be released.");
  }

  /**
   * Retries a send the Node offers a retry for. The listing says which mode (ADR 40): `retry-effect` reuses
   * the idempotency key and cannot duplicate; `resend-may-duplicate` mints a new one and might, so that one
   * asks for a reason and an explicit acceptance before it goes. The route existed for months; the button
   * did not (the 17 September coverage audit).
   */
  async function retry(send: SendRow, reason = "") {
    setProblem(null);
    const duplicate = send.retry.mode === "resend-may-duplicate";
    // The duplicate-risk mode asks for a written reason first — inline, not window.prompt, which blocks the
    // page and cannot be read by the accessibility harness. The row's button opens the field; this sends.
    if (duplicate && reason.trim() === "") { setResending(send.id); return; }
    setResending(null);
    const response = await apiFetch(`/api/sends/${encodeURIComponent(send.id)}/retry`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(duplicate ? { mode: "resend-may-duplicate", acceptDuplicateRisk: true, reason } : { mode: "retry-effect" }),
    });
    const outcome = (await response.json().catch(() => null)) as { message?: string; what?: string } | null;
    await queryClient.invalidateQueries({ queryKey: ["sends"] });
    if (!response.ok) setProblem(outcome?.message ?? outcome?.what ?? `This Node answered ${response.status}.`);
  }

  return (
    <section className="ledger" aria-label="Outbox">
      <header className="ledger-head">
        <h1>Outbox</h1>
        <p className="dim mono">{rows.length} sends</p>
      </header>
      {resendTarget === null ? null : (
        <p className="notice" role="status">
          Resending <span className="mono">{resendTarget.subject}</span> mints a new message and may deliver it twice —
          the first attempt's outcome is unknown, not failed. Say why, for the trail:{" "}
          <input className="mono resend-reason" aria-label="Why resend" value={resendReason} onChange={(event) => setResendReason(event.target.value)} />{" "}
          <button type="button" className="linkish" disabled={resendReason.trim() === ""} onClick={() => void retry(resendTarget, resendReason)}>resend anyway</button>{" "}
          <button type="button" className="linkish dim" onClick={() => setResending(null)}>never mind</button>
        </p>
      )}

      {capability.canSend ? null : (
        <p className="notice bad">{capability.detail}</p>
      )}
      {problem === null ? null : <p className="notice bad" role="alert">{problem}</p>}
      <p className="notice dim">
        {daily.throttledAtCount === null
          ? `${daily.handedOver} handed over today. Your daily limit is not published by Cloudflare; it will be recorded here the first time you hit it.`
          : `${daily.handedOver} handed over today. This Node was first rate-limited at ${daily.throttledAtCount}.`}
      </p>

      <Truncated when={sends.data.truncated} shown={rows.length} noun="sends" />
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
                        <>
                          {/*
                            A send a **rule** held can now be let go, by anybody who could have sent it
                            (#60's own answer, built in #81). Only `policy_hold`: an approval-gated send is
                            cleared by an approver and a rate-broken one by its window, and offering one
                            button for all three would walk a message past whichever gate it was actually on.
                          */}
                          {send.state_reason === "policy_hold" ? (
                            <>
                              <button
                                type="button"
                                className="linkish"
                                onClick={() => void release(send.id)}
                              >
                                let it go
                              </button>
                              {" · "}
                            </>
                          ) : null}
                          {/*
                            `awaiting` too, and not as a convenience: either way the author may stop their own
                            message, which is what this is. `cancelSend` bounds the authority to the one they
                            already hold.
                          */}
                          <button type="button" className="linkish" onClick={() => void stop(send.id)}>
                            stop
                          </button>
                        </>
                      ) : (
                        <>
                          {send.retry.mode === null ? null : (
                            <>
                              <button type="button" className="linkish" title={send.retry.why} onClick={() => void retry(send)}>
                                {send.retry.mode === "retry-effect" ? "retry" : "resend…"}
                              </button>
                              {" · "}
                            </>
                          )}
                          {send.fidelity === "authored" && send.has_submitted === 1 ? (
                            // §12's point is that the submitted bytes are *producible*, so this is a link
                            // rather than a feature request — but only when they exist.
                            <a className="mono" href={`/api/sends/${encodeURIComponent(send.id)}/submitted`}>
                              .eml
                            </a>
                          ) : send.retry.mode === null ? (
                            <span className="dim mono">—</span>
                          ) : null}
                        </>
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

/**
 * Who an entry is attributed to, in one string.
 *
 * The table showed no actor at all — not the identifier, not the kind, not the delegator — so the interface
 * answered *what happened* and never *who did it*, which is half of what an audit trail is for.
 *
 * A machine's entry reads `agt_… for usr_…`, because those two facts are one answer and splitting them across
 * columns invites a reader to take the first without the second. `node` and `installer` have no identifier by
 * construction — `audit.ts` says so on `actorKind` — so the kind is the whole label.
 */
function actorLabel(entry: AuditRow): string {
  if (entry.actor_user_id === null) return entry.actor_kind;
  if (entry.delegator_user_id === null) return entry.actor_user_id;
  return `${entry.actor_user_id} for ${entry.delegator_user_id}`;
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
      <Truncated when={audit.data.truncated} shown={audit.data.entries.length} noun="entries" />
      {audit.data.entries.length === 0 ? (
        <Nothing kind="empty" detail="No audited action has been taken on this Node yet." />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col" className="num">Seq</th>
              <th scope="col">Action</th>
              <th scope="col">Actor</th>
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
                <td className="mono dim">{actorLabel(entry)}</td>
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
      <Truncated when={logs.data.truncated} shown={logs.data.entries.length} noun="entries" />
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
/**
 * Supplying the credentials this Node sends with (#86).
 *
 * **On the doctor screen, beside the finding it answers.** `transport_adapters` reports which adapters exist
 * and, when neither does, says a Node cannot send at all — and the act that fixes it belongs next to the
 * report that names it rather than on a settings screen an operator has to go looking for. This is the one
 * place in the interface where a report and its remedy sit together, and the reason is that this remedy has
 * nowhere else to be.
 *
 * **There is no CLI verb for this, and that is a constraint rather than an omission.** The token is wrapped
 * under the credential KEK, which lives in a Durable Object only the Worker can reach — so a credential this
 * Node encrypts can only be supplied through this Node. `mailda set-password` can be a script because a
 * password hash needs no vault; this cannot.
 *
 * The field is `type="password"`: an API token with Email Sending: Edit is a credential, and a credential
 * rendered in plain text is one a screen share discloses.
 */
function SendingCredentials() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setProblem(null);
    const outcome = await configureTransport(accountId.trim(), apiToken);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    // Cleared on success: the token has been handed over and nothing can read it back, so holding it in a
    // form field afterwards would be the only place it still exists in the clear.
    setApiToken("");
    await queryClient.invalidateQueries({ queryKey: ["transport"] });
    await queryClient.invalidateQueries({ queryKey: ["doctor"] });
  }

  const report = transport.data?.transport;

  return (
    <section className="transport" aria-label="Sending credentials">
      <h2>Sending credentials</h2>
      {report === undefined
        ? <Nothing kind="loading" />
        : (
          <p className="dim">
            Sends go through <span className="mono">{report.adapter}</span>.
            {" "}
            {report.available.binding
              ? "The EMAIL binding is present and is preferred: it holds no credential, and it is the only adapter that can submit the exact bytes an authored send records."
              : report.available.rest === null
                ? "There is no EMAIL binding and no API token, so this Node cannot send at all."
                : `There is no EMAIL binding, so reconstructed sends go over the REST API for account ${report.available.rest.accountId}. Authored sends are refused: that API builds its own MIME, so the bytes sent would not be the bytes recorded.`}
          </p>
        )}

      {problem === null ? null : <p className="notice bad" role="alert">{problem}</p>}

      <label className="field-row" htmlFor="transport-account">
        <span>Cloudflare account id</span>
        <input
          id="transport-account"
          className="mono"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        />
      </label>
      <label className="field-row" htmlFor="transport-token">
        <span>Email Sending API token</span>
        <input
          id="transport-token"
          type="password"
          className="mono"
          value={apiToken}
          onChange={(event) => setApiToken(event.target.value)}
        />
      </label>
      <p className="dim">
        Needs the <span className="mono">Email Sending: Edit</span> permission. It is encrypted on arrival and
        no route returns it — to change it, supply a new one.
      </p>
      <p>
        <button className="quiet"
          type="button"
          onClick={() => void save()}
          disabled={busy || accountId.trim() === "" || apiToken === ""}
        >
          save credentials
        </button>
      </p>
    </section>
  );
}

/**
 * What an act answered, rendered as the Node said it.
 *
 * A refusal is `role="alert"` and keeps its line breaks, because the four parts arrive joined by newlines
 * and the last one is what to do next. A result is `role="status"`: what was done, in the Node's counts,
 * never a reassurance the screen composed itself.
 */
function Outcome({ outcome }: { outcome: { ok: true; text: string } | { ok: false; message: string } | null }) {
  if (outcome === null) return null;
  return outcome.ok
    ? <p className="notice mono" role="status">{outcome.text}</p>
    : <p className="notice bad mono" role="alert" style={{ whiteSpace: "pre-wrap" }}>{outcome.message}</p>;
}

type Shown = { ok: true; text: string } | { ok: false; message: string } | null;

/**
 * The remedies, beside the findings that name them.
 *
 * `doctor`'s `fix` text already says which route answers each finding; these are those routes as buttons,
 * on that finding and no other. The CLI verbs stay in the text because they still work, and because a
 * terminal is where an operator is when the bundle cannot load (ADR 30). Each is offered only while the
 * finding is failing, since a "reseal" button under "every message is under the current key" would be
 * asking somebody to act on nothing. `evidence_present` is the exception: verification is a check rather
 * than a fix, and a clean report is exactly when one wants to check.
 *
 * `finding.check === "…"` rather than a lookup table, so `test/node/doctor-check-names.test.ts` holds every
 * name here to one a check actually emits — a button on a misspelled finding would be a button on nothing.
 */
function Remedy({ finding }: { finding: DoctorFinding }) {
  if (finding.check === "recovery_escrow") return <RecoveryCodes />;
  if (finding.check === "evidence_present") return <EvidenceVerify />;
  if (finding.ok) return null;
  if (finding.check === "migrations_applied") {
    return <OneAct label="apply migrations" run={async () => {
      const outcome = await applyMigrations();
      return outcome.ok ? { ok: true, text: outcome.value.message } : outcome;
    }} />;
  }
  if (finding.check === "evidence_key_generation") {
    return <OneAct label="reseal a batch" run={async () => {
      const outcome = await resealEvidence();
      if (!outcome.ok) return outcome;
      const { resealed, alreadyCurrent, failed, remaining, targetGeneration } = outcome.value;
      return {
        ok: true,
        text: `${resealed} resealed under generation ${targetGeneration}, ${alreadyCurrent} already current, `
          + `${failed.length} failed. ${remaining} remaining — run it again until that reaches 0.`,
      };
    }} />;
  }
  if (finding.check === "evidence_orphans" || finding.check === "draft_bodies_stranded") return <Collect />;
  if (finding.check === "recovery_key_conflicts") return <Acknowledge />;
  if (finding.check === "body_index_failed") return <SearchRepair />;
  return null;
}

/** One button, one call, one rendered answer. The doctor report is refetched after, whatever it said. */
function OneAct({ label, run, disabled = false }: { label: string; run: () => Promise<Shown>; disabled?: boolean }) {
  const queryClient = useQueryClient();
  const [shown, setShown] = useState<Shown>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    setShown(await run());
    setBusy(false);
    await queryClient.invalidateQueries({ queryKey: ["doctor"] });
  }
  return (
    <>
      <p><button type="button" className="quiet" disabled={busy || disabled} onClick={() => void go()}>{label}</button></p>
      <Outcome outcome={shown} />
    </>
  );
}

/**
 * `reconcile?collect=1` — the one call in the product that deletes content bytes. So the first click
 * reveals what the second will do and the second does it; a single button here would be the R2 delete one
 * mis-click away, on a screen an operator reaches when something is already wrong.
 */
function Collect() {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return <p><button type="button" className="quiet" onClick={() => setArmed(true)}>collect them…</button></p>;
  }
  return (
    <>
      <p className="notice">
        This deletes every object the reconciler finds no referent for — orphaned raw mail past the grace
        period, stranded draft bodies and export residue. It is refused for the whole organization while a
        legal hold stands.
      </p>
      <OneAct label="delete them now" run={async () => {
        const outcome = await reconcileEvidence(true);
        if (!outcome.ok) return outcome;
        const { orphansDeleted, draftBodiesDeleted, exportObjectsDeleted } = outcome.value;
        return {
          ok: true,
          text: `Deleted ${orphansDeleted} orphan(s), ${draftBodiesDeleted} draft body/bodies, `
            + `${exportObjectsDeleted} export object(s).`,
        };
      }} />
      {" "}
      <button type="button" className="linkish dim" onClick={() => setArmed(false)}>never mind</button>
    </>
  );
}

/**
 * Recording that a key collision has been assessed. The restore id is typed from the finding's own text
 * rather than parsed out of it: the detail is prose, and a screen that read identifiers from prose would
 * break the day the sentence was reworded. The Node refuses an id that did not collide, with the reason.
 */
function Acknowledge() {
  const [restoreId, setRestoreId] = useState("");
  const [scope, setScope] = useState("");
  const [conclusion, setConclusion] = useState("");
  return (
    <>
      <label className="field-row" htmlFor="ack-restore"><span>restore id</span>
        <input id="ack-restore" className="mono" value={restoreId} onChange={(event) => setRestoreId(event.target.value)} /></label>
      <label className="field-row" htmlFor="ack-scope"><span>what was examined</span>
        <input id="ack-scope" value={scope} onChange={(event) => setScope(event.target.value)} /></label>
      <label className="field-row" htmlFor="ack-conclusion"><span>what was concluded</span>
        <input id="ack-conclusion" value={conclusion} onChange={(event) => setConclusion(event.target.value)} /></label>
      <OneAct label="record the assessment" run={async () => {
        const outcome = await acknowledgeConflict(restoreId.trim(), scope, conclusion);
        if (!outcome.ok) return outcome;
        const { acknowledged } = outcome.value;
        return {
          ok: true,
          text: `Recorded against ${acknowledged.restoreId} (generations ${acknowledged.generations}) at `
            + `${acknowledged.acknowledgedAt}. The collision is not repaired; the alarm is discharged.`,
        };
      }} />
    </>
  );
}

/**
 * The ten codes, in the browser (the same flow as `mailda recovery-codes rotate` then `confirm`).
 *
 * ## Shown once, held only while rendered, typed back by a person
 *
 * The plaintext lives in one `useState` for as long as the list is on screen, and nowhere else: not in
 * storage, not in a log, not in the confirm request except as the one code a person typed. "I have saved
 * these" drops them. The confirm field is **never prefilled** from the mint response — the whole point of
 * confirming is to assert that a human holds the sheet, and a screen that typed it for them would clear the
 * finding without changing the fact (`docs/authentication.md`, #136). The field is `type="password"` for
 * the reason the CLI reads it at a prompt: a code that is not spent by confirming is a live key to the vault.
 *
 * Confirming is offered whether or not a set was just minted, because the finding it answers also fires
 * on a sheet minted elsewhere that nobody has typed back.
 */
function RecoveryCodes() {
  const queryClient = useQueryClient();
  const [minted, setMinted] = useState<RecoveryCodesMinted | null>(null);
  const [code, setCode] = useState("");
  const [shown, setShown] = useState<Shown>(null);
  const [busy, setBusy] = useState(false);

  async function rotate() {
    setBusy(true);
    setShown(null);
    const outcome = await rotateRecoveryCodes();
    setBusy(false);
    if (!outcome.ok) { setShown(outcome); return; }
    setMinted(outcome.value);
    await queryClient.invalidateQueries({ queryKey: ["doctor"] });
  }

  async function confirm() {
    setBusy(true);
    const outcome = await confirmRecoveryCode(code.trim());
    setBusy(false);
    // Cleared either way: the field held a live key, and a refused one is still a live key.
    setCode("");
    setShown(outcome.ok ? { ok: true, text: outcome.value.message } : outcome);
    await queryClient.invalidateQueries({ queryKey: ["doctor"] });
  }

  return (
    <>
      {minted === null ? (
        <p>
          <button type="button" className="quiet" disabled={busy} onClick={() => void rotate()}>mint a new set</button>
          {" "}
          <span className="dim">Ten codes, shown once. Confirming one retires any previous sheet.</span>
        </p>
      ) : (
        <div className="codes-sheet">
          <p><strong>Write these down now.</strong> {minted.notice}</p>
          <ol className="codes" aria-label="Recovery codes">
            {minted.codes.map((one) => <li key={one} className="mono">{one}</li>)}
          </ol>
          <p className="dim">
            Set <span className="mono">{minted.set}</span>, carrying content key generation {minted.escrowed.content} and
            credential key generation {minted.escrowed.credential}. Put them somewhere that survives losing this
            computer and this Cloudflare account.
          </p>
          <p><button type="button" className="quiet" onClick={() => setMinted(null)}>I have saved these ten codes</button></p>
        </div>
      )}
      <label className="field-row" htmlFor="recovery-code">
        <span>confirm one code</span>
        <input id="recovery-code" type="password" className="mono" autoComplete="off" value={code}
          onChange={(event) => setCode(event.target.value)} />
      </label>
      <p>
        <button type="button" className="quiet" disabled={busy || code.trim() === ""} onClick={() => void confirm()}>
          confirm
        </button>
        {" "}
        <span className="dim">Compared against the hash, never spent. Type it; nothing here fills it in for you.</span>
      </p>
      <Outcome outcome={shown} />
    </>
  );
}

/**
 * The body index's failures, listed with the reason each failed, and a repair for the ones worth it.
 *
 * Per message and never a sweep, which is the route's own rule: `unindexable` rows are deterministically
 * unparseable and repairing them spends attempts on work that cannot succeed. So the list says which is
 * which and nothing is pre-selected.
 */
function SearchRepair() {
  const failed = useSearchFailed();
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  if (failed.isPending) return <Nothing kind="loading" />;
  if (failed.isError) return <Nothing kind="failed" detail={failed.error.message} />;
  if (failed.data.failed.length === 0) return <p className="dim">The failed list is empty now.</p>;

  function toggle(id: string) {
    setChosen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <>
      <table className="search-failed">
        <thead>
          <tr><th scope="col">Repair</th><th scope="col">Message</th><th scope="col">State</th><th scope="col" className="num">Attempts</th><th scope="col">Error</th></tr>
        </thead>
        <tbody>
          {failed.data.failed.map((row) => (
            <tr key={row.messageId}>
              <td>
                <input type="checkbox" aria-label={`repair ${row.messageId}`} checked={chosen.has(row.messageId)}
                  onChange={() => toggle(row.messageId)} />
              </td>
              <td className="mono">{row.messageId}</td>
              <td><span className={`state state-index-${row.state}`}>{row.state}</span></td>
              <td className="num mono dim">{row.attempts}</td>
              <td className="dim mono">{row.error ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dim">Tick the ones worth retrying — fix the cause first.</p>
      {/* Mounted whether or not anything is ticked, so the answer outlives the selection it was about. */}
      <OneAct label={`requeue ${chosen.size} message(s)`} disabled={chosen.size === 0} run={async () => {
        const outcome = await repairSearch([...chosen]);
        if (!outcome.ok) return outcome;
        setChosen(new Set());
        await queryClient.invalidateQueries({ queryKey: ["search-failed"] });
        return { ok: true, text: `${outcome.value.requeued} requeued. ${outcome.value.message}` };
      }} />
    </>
  );
}

/**
 * Verifying evidence, one bounded batch at a time. The verdict says what it covered, and the next
 * batch starts where this one stopped rather than from the beginning again.
 */
function EvidenceVerify() {
  const [verdict, setVerdict] = useState<EvidenceVerdict | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify(after: string | null) {
    setBusy(true);
    setProblem(null);
    const outcome = await verifyEvidence(after);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setVerdict(outcome.value);
  }

  return (
    <>
      <p>
        <button type="button" className="quiet" disabled={busy} onClick={() => void verify(null)}>verify a batch</button>
        {verdict?.resumeAfter == null ? null : (
          <>
            {" "}
            <button type="button" className="linkish" disabled={busy} onClick={() => void verify(verdict.resumeAfter)}>continue from where it stopped</button>
          </>
        )}
      </p>
      {problem === null ? null : <p className="notice bad mono" role="alert" style={{ whiteSpace: "pre-wrap" }}>{problem}</p>}
      {verdict === null ? null : (
        <p className="notice mono" role="status">
          {verdict.checked} object(s) checked{verdict.table === null ? "" : ` in ${verdict.table}`}, {verdict.bytesRead} bytes read:{" "}
          {verdict.intact ? "intact." : `${verdict.faults.length} fault(s).`}
          {verdict.resumeAfter === null ? " That was the last batch." : " More remains."}
          {verdict.faults.map((fault) => (
            <span key={`${fault.table}:${fault.rowId}:${fault.column}`} style={{ display: "block" }}>
              {fault.kind} {fault.table}.{fault.column} {fault.rowId}: {fault.detail}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

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
                <Remedy finding={finding} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <SendingCredentials />
    </section>
  );
}
