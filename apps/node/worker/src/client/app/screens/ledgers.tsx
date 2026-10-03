import { useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useState } from "react";
import { AUDIT_OUTCOMES, DOCTOR_CHECKS, LOG_LEVELS, RECIPIENT_KINDS, oneOf } from "@mailda/contract/schemas";
import { apiFetch } from "/app/session.js";
import { describeReason, describeRecipient, describeSend, orderRecipients, summariseDelivery } from "/app/delivery.js";
import { t } from "/app/locale.js";

import { Nothing, Scroller, Truncated } from "../chrome.tsx";
import { deliveryWords, sendReasonWords, sendStateWords, shown } from "../delivery-words.ts";
import { clock, fullTime, recipients, stamp } from "../format.ts";
import { marked, NodeWords, sentence } from "../words.tsx";
import {
  acknowledgeConflict, applyMigrations, type AuditRow, configureTransport, confirmRecoveryCode,
  type DoctorFinding, type EvidenceVerdict, type RecoveryCodesMinted, reconcileEvidence, type Refused, repairSearch,
  requeuePreviews, resealEvidence, rotateRecoveryCodes, type SendRow, useAudit, useDoctor, useLogs, useSearchFailed,
  useSends, useTransport, verifyAudit, verifyEvidence,
} from "../api.ts";

/**
 * The three ledgers and the diagnostic. Full-width tables, because for a ledger that is the right form.
 *
 * ## The delivery vocabulary is imported, not restated
 *
 * `summariseDelivery` and the decisions about which state a reader is shown come from `/app/delivery.js` at
 * runtime rather than being bundled or reimplemented. That module is the one place the rule lives — *never
 * suppress an outcome just because the recipients agree, because they agree when everything bounced too* — and
 * `test/node/delivery-summary.test.ts` evaluates the same served bytes. Reimplementing it in React would have
 * recreated exactly the bug that rule exists to prevent, in a file the test cannot see.
 *
 * It returns tokens; the words are the catalog's, looked up by `../delivery-words.ts` (ADR 46). The send-state
 * words were once a literal map here, keyed on `state` alone, so `outcome_unknown` read "We do not know whether
 * it left" even when the Node could prove it had not. That is a *reading* of three fields (`describeSend`'s
 * `never_submitted`), and it belongs in the module a test can import.
 *
 * ## The words
 *
 * Every word here is the catalog's (`ledgers.*`, ADR 46); the headings are the routes' names and the Doctor's
 * states are `health.status.*`. What the Node wrote (a finding's detail and fix, a refusal's reason, a remedy's
 * message, a log line) is shown as it came, inside `<NodeWords>`. Tokens the Node names things by (an audit
 * action, a check, an actor kind, a table and column) stay as they are: they are identifiers, in mono.
 */

function DeliveryChips({ send }: { send: SendRow }) {
  const summary = summariseDelivery(send.recipients);
  return (
    <>
      {summary.map((entry) => {
        const words = deliveryWords(entry.state);
        return (
          <span
            key={entry.state}
            className={`state delivery-${entry.state} delivery-chip`}
            title={words.note}
          >
            {send.recipients.length === 1 ? shown(words) : sentence("ledgers.outbox.chip", { n: entry.count, state: shown(words) })}
          </span>
        );
      })}
    </>
  );
}

function Recipients({ send }: { send: SendRow }) {
  if (send.recipients.length === 0) return null;
  return (
    <>
      <dt>{t("ledgers.outbox.recipients")}</dt>
      <dd>
        <div className="recipients">
          {orderRecipients(send.recipients).map((recipient) => {
            const said = describeRecipient(recipient);
            const state = deliveryWords(said.state);
            const reason = said.reason === null ? null : deliveryWords(said.reason);
            return (
              <div className="recipient" key={`${recipient.kind}:${recipient.address}`}>
                <span className="label">
                  {oneOf(RECIPIENT_KINDS, recipient.kind) ? t(`ledgers.outbox.kind.${recipient.kind}`) : <code>{recipient.kind}</code>}
                </span>
                <span className="mono">{recipient.address}</span>
                <span className={`state delivery-${recipient.delivery_state ?? "unobserved"}`} title={state.note}>
                  {shown(state)}
                </span>
                {/* The provider's bounce type (`hard`, `soft`), its token in every locale. Beside the state rather than
                    in its title, where a token cannot be marked as one. */}
                {recipient.bounce_type ? <code className="dim">{recipient.bounce_type}</code> : null}
                {reason === null ? null : (
                  // Beside `unobserved`, not instead of it, as the send row's reason sits beside its state (#62):
                  // the state is what was heard, which is nothing; the reason is why nothing is coming.
                  <span className="state state-reason delivery-chip" title={reason.note}>{shown(reason)}</span>
                )}
                {recipient.last_error ? (
                  // The provider's own words, which this Node passes on as it does its own (an SMTP reply is English
                  // by protocol), so marked as the Node's English. A paraphrase of somebody else's mail server is a guess.
                  <span className="dim mono recipient-error"><NodeWords>{recipient.last_error}</NodeWords></span>
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
  /** What the last act answered, when it refused: the Node's reason, or this screen's words when it gave none. */
  const [problem, setProblem] = useState<ReactNode>(null);
  /** The send whose duplicate-risk resend is waiting for a reason, or null. */
  const [resending, setResending] = useState<string | null>(null);
  const [resendReason, setResendReason] = useState("");

  if (sends.isPending || sends.isError) {
    return (
      <section className="ledger" aria-label={t("route./outbox")}>
        <header className="ledger-head"><h1>{t("route./outbox")}</h1></header>
        {sends.isPending ? <Nothing kind="loading" /> : <Nothing kind="failed" detail={marked(sends.error)} />}
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
    if (!outcome.cancelled) setProblem(outcome.reason === undefined ? t("ledgers.outbox.stop.failed") : <NodeWords>{outcome.reason}</NodeWords>);
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
    if (!outcome.released) setProblem(outcome.reason === undefined ? t("ledgers.outbox.letGo.failed") : <NodeWords>{outcome.reason}</NodeWords>);
  }

  /**
   * Lets go a send a **Butler** wrote (#61). A different route from `release`, because it is a different
   * gate: `release-hold` clears a policy's pause, this clears the person-must-see gate every Butler send
   * parks on, and the run that proposed it is woken if it is still there. The Node answers `not_found` alike
   * for absent, already released and not yours (§5C), so the refusal says all three rather than guessing.
   */
  async function releaseFromGate(id: string) {
    setProblem(null);
    const response = await apiFetch(`/api/sends/${encodeURIComponent(id)}/release`, { method: "POST" });
    const outcome = (await response.json()) as { released: boolean; reason?: string };
    await queryClient.invalidateQueries({ queryKey: ["sends"] });
    // The reason here is a code (`not_found`), Latin in every locale as the E_ codes are.
    if (!outcome.released) setProblem(t("ledgers.outbox.gate.failed", { reason: outcome.reason ?? t("api.refusal.code") }));
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
    if (!response.ok) {
      const said = outcome?.message ?? outcome?.what;
      setProblem(said === undefined ? t("api.answered", { status: String(response.status) }) : <NodeWords>{said}</NodeWords>);
    }
  }

  return (
    <section className="ledger" aria-label={t("route./outbox")}>
      <header className="ledger-head">
        <h1>{t("route./outbox")}</h1>
        <p className="dim mono">{t("ledgers.outbox.count", { n: rows.length })}</p>
      </header>
      {resendTarget === null ? null : (
        <p className="notice" role="status">
          {sentence("ledgers.outbox.resend.notice", { subject: <span className="mono">{resendTarget.subject}</span> })}{" "}
          <span className="inline-actions">
            <input className="mono resend-reason" aria-label={t("ledgers.outbox.resend.why")} value={resendReason} onChange={(event) => setResendReason(event.target.value)} />
            <button type="button" className="linkish" disabled={resendReason.trim() === ""} onClick={() => void retry(resendTarget, resendReason)}>{t("ledgers.outbox.resend.anyway")}</button>
            <button type="button" className="linkish dim" onClick={() => setResending(null)}>{t("ledgers.neverMind")}</button>
          </span>
        </p>
      )}

      {capability.canSend ? null : (
        <p className="notice bad"><NodeWords>{capability.detail}</NodeWords></p>
      )}
      {problem === null ? null : <p className="notice bad" role="alert">{problem}</p>}
      <p className="notice dim">
        {daily.throttledAtCount === null
          ? t("ledgers.outbox.daily.unmeasured", { count: String(daily.handedOver) })
          : t("ledgers.outbox.daily.throttled", { count: String(daily.handedOver), at: String(daily.throttledAtCount) })}
      </p>

      <Truncated when={sends.data.truncated} shown={rows.length} noun={t("ledgers.outbox.noun")} />
      {rows.length === 0 ? (
        <Nothing kind="empty" detail={t("ledgers.outbox.empty")} />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{t("ledgers.col.subject")}</th>
              <th scope="col">{t("ledgers.outbox.col.to")}</th>
              <th scope="col">{t("ledgers.col.state")}</th>
              <th scope="col" className="num">{t("ledgers.outbox.col.when")}</th>
              <th scope="col" className="num">{t("ledgers.outbox.col.submitted")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((send) => {
              const state = sendStateWords(describeSend(send));
              const token = describeReason(send);
              const reason = token === null ? null : sendReasonWords(token);
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
                        {/* Said, as the inbox rows say it: a blank subject left the row's only button nameless. */}
                        {send.subject.trim() === "" ? <span className="dim">{t("ledgers.outbox.noSubject")}</span> : send.subject}
                      </button>
                    </td>
                    <td className="dim mono">{recipients(send.envelope_to)}</td>
                    <td>
                      <span className={`state state-${send.state}`} title={state.note}>
                        {shown(state)}
                      </span>
                      {reason === null ? null : (
                        // Beside the state, not instead of it. The state says what happened to the send; the
                        // reason says who can act. Collapsing them would lose whichever half the reader needs.
                        <span className="state state-reason delivery-chip" title={reason.note}>
                          {shown(reason)}
                        </span>
                      )}
                      {/* A copy (ADR 47): nobody composed it, so the row says what it is. `?? 0` for an older Node. */}
                      {(send.is_copy ?? 0) === 1 ? (
                        <span className="state delivery-chip" title={t("ledgers.outbox.copy.note")}>{t("ledgers.outbox.copy")}</span>
                      ) : null}
                      <DeliveryChips send={send} />
                    </td>
                    <td className="num mono dim">{stamp(send.state_at)}</td>
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
                                {t("ledgers.outbox.letGo")}
                              </button>
                              {" · "}
                            </>
                          ) : null}
                          {/*
                            A Butler's send is the other gate a `send.propose` holder clears, and it is the
                            one the gate exists for: a program proposed this and no person has agreed yet.
                            Its own token, its own route — `release-hold` on this row would answer 409.
                          */}
                          {send.state_reason === "butler_release_required" ? (
                            <>
                              <button
                                type="button"
                                className="linkish"
                                title={t("ledgers.outbox.release.title")}
                                onClick={() => void releaseFromGate(send.id)}
                              >
                                {t("ledgers.outbox.release")}
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
                            {t("ledgers.outbox.stop")}
                          </button>
                        </>
                      ) : (
                        <>
                          {send.retry.mode === null ? null : (
                            <>
                              <button type="button" className="linkish" onClick={() => void retry(send)}>
                                {send.retry.mode === "retry-effect" ? t("ledgers.outbox.retry") : t("ledgers.outbox.resend")}
                              </button>
                              {/* A separator only between two things: an authored send never submitted has no .eml. */}
                              {send.fidelity === "authored" && send.has_submitted === 1 ? " · " : null}
                            </>
                          )}
                          {send.fidelity === "authored" && send.has_submitted === 1 ? (
                            // §12's point is that the submitted bytes are *producible*, so this is a link
                            // rather than a feature request — but only when they exist.
                            <a className="mono" href={`/api/sends/${encodeURIComponent(send.id)}/submitted`}>
                              .eml
                            </a>
                          ) : send.retry.mode === null ? (
                            // A copy whose outcome is unknown is never resent: what a person can do is said instead.
                            send.retry.why === "copy_not_resent"
                              ? <span className="dim">{t("ledgers.outbox.copy.noResend")}</span>
                              : <span className="dim mono">—</span>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                  <tr id={`detail-${send.id}`} className="detail" hidden={!expanded}>
                    <td colSpan={5}>
                      <dl>
                        <dt>{t("ledgers.outbox.means")}</dt>
                        <dd>{state.note}</dd>
                        {reason === null ? null : (
                          <>
                            <dt>{t("ledgers.outbox.why")}</dt>
                            <dd>{reason.note}</dd>
                          </>
                        )}
                        <Recipients send={send} />
                        <dt>{t("ledgers.outbox.manifest")}</dt>
                        <dd className="mono">{send.id}</dd>
                        {send.last_error === null ? null : (
                          <>
                            <dt>{t("ledgers.outbox.reported")}</dt>
                            <dd><NodeWords>{send.last_error}</NodeWords></dd>
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
  return t("ledgers.audit.actorFor", { actor: entry.actor_user_id, delegator: entry.delegator_user_id });
}

export function Audit() {
  const audit = useAudit();
  const [verdict, setVerdict] = useState<{ said: ReactNode; refused: boolean } | null>(null);

  if (audit.isPending || audit.isError) {
    return (
      <section className="ledger" aria-label={t("ledgers.audit.label")}>
        <header className="ledger-head"><h1>{t("route./audit")}</h1></header>
        {audit.isPending ? <Nothing kind="loading" /> : <Nothing kind="failed" detail={marked(audit.error)} />}
      </section>
    );
  }

  async function verify() {
    const outcome = await verifyAudit();
    // A refusal is the Node's answer to the request, not a verdict on the chain: read as one, it said "Chain broken at
    // entry undefined" (found by T4, 2 October 2026).
    if (!outcome.ok) { setVerdict({ said: marked(outcome), refused: true }); return; }
    const { intact, checked, brokenAt } = outcome.value;
    // Stated as what was checked, not as a reassurance. An unverified chain and a verified one must not
    // read the same.
    setVerdict({
      refused: false,
      said: intact
        ? t("ledgers.audit.intact", { count: String(checked) })
        : t("ledgers.audit.broken", { entry: String(brokenAt), count: String(checked) }),
    });
  }

  return (
    <section className="ledger" aria-label={t("ledgers.audit.label")}>
      <header className="ledger-head">
        <h1>{t("route./audit")}</h1>
        <button type="button" className="linkish" onClick={() => void verify()}>
          {t("ledgers.audit.verify")}
        </button>
      </header>
      {verdict === null ? null
        : verdict.refused ? <p className="notice bad" role="alert">{verdict.said}</p>
        : <p className="notice mono">{verdict.said}</p>}
      <Truncated when={audit.data.truncated} shown={audit.data.entries.length} noun={t("ledgers.noun.entries")} />
      {audit.data.entries.length === 0 ? (
        <Nothing kind="empty" detail={t("ledgers.audit.empty")} />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col" className="num">{t("ledgers.audit.col.seq")}</th>
              <th scope="col">{t("ledgers.audit.col.action")}</th>
              <th scope="col">{t("ledgers.audit.col.actor")}</th>
              <th scope="col">{t("ledgers.audit.col.outcome")}</th>
              <th scope="col">{t("ledgers.col.subject")}</th>
              <th scope="col" className="num">{t("ledgers.col.at")}</th>
            </tr>
          </thead>
          <tbody>
            {audit.data.entries.map((entry) => (
              <tr key={entry.id}>
                <td className="num mono dim">{entry.seq}</td>
                {/* The audit key, an identifier in every locale (docs/i18n.md, Register). */}
                <td className="mono"><code>{entry.action}</code></td>
                <td className="mono dim">{actorLabel(entry)}</td>
                <td>
                  <span className={`state state-audit-${entry.outcome}`}>
                    {oneOf(AUDIT_OUTCOMES, entry.outcome) ? t(`ledgers.audit.outcome.${entry.outcome}`) : <code>{entry.outcome}</code>}
                  </span>
                </td>
                <td className="mono dim">{entry.subject ?? "—"}</td>
                <td className="num mono dim">{stamp(entry.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** A level's word, or the Node's own token for a level this interface does not know yet. */
function levelWord(level: string): string {
  return oneOf(LOG_LEVELS, level) ? t(`ledgers.log.level.${level}`) : level;
}

export function Log() {
  const logs = useLogs();
  // Heading first, then the state. See the note in inbox.tsx: a screen whose name appears only once its
  // data has arrived is a screen with no heading while it loads.
  if (logs.isPending || logs.isError) {
    return (
      <section className="ledger" aria-label={t("ledgers.log.label")}>
        <header className="ledger-head"><h1>{t("route./log")}</h1></header>
        {logs.isPending ? <Nothing kind="loading" /> : <Nothing kind="failed" detail={marked(logs.error)} />}
      </section>
    );
  }

  return (
    <section className="ledger" aria-label={t("ledgers.log.label")}>
      <header className="ledger-head">
        <h1>{t("route./log")}</h1>
        <p className="dim mono">
          {logs.data.counts.map((count) => t("ledgers.log.count", { count: String(count.n), level: levelWord(count.level) })).join(" · ")
            || t("ledgers.log.counts.none")}
        </p>
      </header>
      <Truncated when={logs.data.truncated} shown={logs.data.entries.length} noun={t("ledgers.noun.entries")} />
      {logs.data.entries.length === 0 ? (
        <Nothing kind="empty" detail={t("ledgers.log.empty")} />
      ) : (
        // The one ledger with no control of its own, so a keyboard could not reach what scrolls past a phone's edge.
        <Scroller label={t("ledgers.log.entries")}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("ledgers.log.col.level")}</th>
                <th scope="col">{t("ledgers.log.col.event")}</th>
                <th scope="col">{t("ledgers.col.message")}</th>
                <th scope="col" className="num">{t("ledgers.col.at")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.data.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <span className={`state state-log-${entry.level}`}>{levelWord(entry.level)}</span>
                  </td>
                  <td className="mono"><code>{entry.event}</code></td>
                  <td><NodeWords>{entry.message}</NodeWords></td>
                  <td className="num mono dim">{stamp(entry.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
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
  const [problem, setProblem] = useState<Refused | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setProblem(null);
    const outcome = await configureTransport(accountId.trim(), apiToken);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome); return; }
    // Cleared on success: the token has been handed over and nothing can read it back, so holding it in a
    // form field afterwards would be the only place it still exists in the clear.
    setApiToken("");
    await queryClient.invalidateQueries({ queryKey: ["transport"] });
    await queryClient.invalidateQueries({ queryKey: ["doctor"] });
  }

  const report = transport.data?.transport;

  return (
    <section className="transport" aria-label={t("ledgers.transport.label")}>
      <h2>{t("ledgers.transport.label")}</h2>
      {report === undefined
        ? <Nothing kind="loading" />
        : (
          <p className="dim">
            {sentence("ledgers.transport.through", { adapter: <span className="mono"><NodeWords>{report.adapter}</NodeWords></span> })}
            {" "}
            {report.available.binding
              ? t("ledgers.transport.binding")
              : report.available.rest === null
                ? t("ledgers.transport.none")
                : t("ledgers.transport.rest", { account: report.available.rest.accountId })}
          </p>
        )}

      {problem === null ? null : <p className="notice bad" role="alert">{marked(problem)}</p>}

      <label className="field-row" htmlFor="transport-account">
        <span>{t("ledgers.transport.account")}</span>
        <input
          id="transport-account"
          className="mono"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        />
      </label>
      <label className="field-row" htmlFor="transport-token">
        <span>{t("ledgers.transport.token")}</span>
        <input
          id="transport-token"
          type="password"
          className="mono"
          value={apiToken}
          onChange={(event) => setApiToken(event.target.value)}
        />
      </label>
      <p className="dim">
        {sentence("ledgers.transport.needs", { permission: <span className="mono">Email Sending: Edit</span> })}
      </p>
      <p>
        <button className="quiet"
          type="button"
          onClick={() => void save()}
          disabled={busy || accountId.trim() === "" || apiToken === ""}
        >
          {t("ledgers.transport.save")}
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
function Outcome({ outcome }: { outcome: Shown }) {
  if (outcome === null) return null;
  return outcome.ok
    ? <p className="notice mono" role="status">{outcome.text}</p>
    : <p className="notice bad mono" role="alert" style={{ whiteSpace: "pre-wrap" }}>{marked(outcome)}</p>;
}

type Shown = { ok: true; text: ReactNode } | Refused | null;

/** A remedy's answer: the Node's count in this interface's words, then the Node's own sentence. */
function requeued(value: { requeued: number; message: string }): ReactNode {
  return sentence("ledgers.requeued", { count: String(value.requeued), message: <NodeWords>{value.message}</NodeWords> });
}

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
    return <OneAct label={t("ledgers.migrations.apply")} run={async () => {
      const outcome = await applyMigrations();
      return outcome.ok ? { ok: true, text: <NodeWords>{outcome.value.message}</NodeWords> } : outcome;
    }} />;
  }
  if (finding.check === "evidence_key_generation") {
    return <OneAct label={t("ledgers.reseal.act")} run={async () => {
      const outcome = await resealEvidence();
      if (!outcome.ok) return outcome;
      const { resealed, alreadyCurrent, failed, remaining, targetGeneration } = outcome.value;
      return {
        ok: true,
        text: t("ledgers.reseal.done", {
          resealed: String(resealed), generation: String(targetGeneration), current: String(alreadyCurrent),
          failed: String(failed.length), remaining: String(remaining),
        }),
      };
    }} />;
  }
  if (finding.check === "evidence_orphans" || finding.check === "draft_bodies_stranded") return <Collect />;
  if (finding.check === "recovery_key_conflicts") return <Acknowledge />;
  if (finding.check === "body_index_failed") return <SearchRepair />;
  if (finding.check === "preview_backlog") {
    return <OneAct label={t("ledgers.previews.requeue")} run={async () => {
      const outcome = await requeuePreviews();
      return outcome.ok ? { ok: true, text: requeued(outcome.value) } : outcome;
    }} />;
  }
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
    return <p><button type="button" className="quiet" onClick={() => setArmed(true)}>{t("ledgers.collect.arm")}</button></p>;
  }
  return (
    <>
      <p className="notice">{t("ledgers.collect.warning")}</p>
      <OneAct label={t("ledgers.collect.act")} run={async () => {
        const outcome = await reconcileEvidence(true);
        if (!outcome.ok) return outcome;
        const { orphansDeleted, draftBodiesDeleted, exportObjectsDeleted } = outcome.value;
        return {
          ok: true,
          text: t("ledgers.collect.done", {
            orphans: t("ledgers.collect.orphans", { n: orphansDeleted }),
            drafts: t("ledgers.collect.drafts", { n: draftBodiesDeleted }),
            exports: t("ledgers.collect.exports", { n: exportObjectsDeleted }),
          }),
        };
      }} />
      {" "}
      <button type="button" className="linkish dim" onClick={() => setArmed(false)}>{t("ledgers.neverMind")}</button>
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
      <label className="field-row" htmlFor="ack-restore"><span>{t("ledgers.conflict.restore")}</span>
        <input id="ack-restore" className="mono" value={restoreId} onChange={(event) => setRestoreId(event.target.value)} /></label>
      <label className="field-row" htmlFor="ack-scope"><span>{t("ledgers.conflict.scope")}</span>
        <input id="ack-scope" value={scope} onChange={(event) => setScope(event.target.value)} /></label>
      <label className="field-row" htmlFor="ack-conclusion"><span>{t("ledgers.conflict.conclusion")}</span>
        <input id="ack-conclusion" value={conclusion} onChange={(event) => setConclusion(event.target.value)} /></label>
      {/* No act without the id its path is built from: an empty one throws before any request (found by T4). */}
      <OneAct label={t("ledgers.conflict.act")} disabled={restoreId.trim() === ""} run={async () => {
        const outcome = await acknowledgeConflict(restoreId.trim(), scope, conclusion);
        if (!outcome.ok) return outcome;
        const { acknowledged } = outcome.value;
        return {
          ok: true,
          text: t("ledgers.conflict.done", {
            restoreId: acknowledged.restoreId, generations: acknowledged.generations, at: fullTime(acknowledged.acknowledgedAt),
          }),
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
    setShown(outcome.ok ? { ok: true, text: <NodeWords>{outcome.value.message}</NodeWords> } : outcome);
    await queryClient.invalidateQueries({ queryKey: ["doctor"] });
  }

  return (
    <>
      {minted === null ? (
        <p>
          <button type="button" className="quiet" disabled={busy} onClick={() => void rotate()}>{t("ledgers.codes.mint")}</button>
          {" "}
          <span className="dim">{t("ledgers.codes.mintNote")}</span>
        </p>
      ) : (
        <div className="codes-sheet">
          <p><strong>{t("ledgers.codes.now")}</strong> <NodeWords>{minted.notice}</NodeWords></p>
          <ol className="codes" aria-label={t("ledgers.codes.label")}>
            {minted.codes.map((one) => <li key={one} className="mono">{one}</li>)}
          </ol>
          <p className="dim">
            {sentence("ledgers.codes.set", {
              set: <span className="mono">{minted.set}</span>,
              content: String(minted.escrowed.content),
              credential: String(minted.escrowed.credential),
            })}
          </p>
          <p><button type="button" className="quiet" onClick={() => setMinted(null)}>{t("ledgers.codes.saved")}</button></p>
        </div>
      )}
      <label className="field-row" htmlFor="recovery-code">
        <span>{t("ledgers.codes.confirmOne")}</span>
        <input id="recovery-code" type="password" className="mono" autoComplete="off" value={code}
          onChange={(event) => setCode(event.target.value)} />
      </label>
      <p>
        <button type="button" className="quiet" disabled={busy || code.trim() === ""} onClick={() => void confirm()}>
          {t("ledgers.codes.confirm")}
        </button>
        {" "}
        <span className="dim">{t("ledgers.codes.confirmNote")}</span>
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
  if (failed.isError) return <Nothing kind="failed" detail={marked(failed.error)} />;
  if (failed.data.failed.length === 0) return <p className="dim">{t("ledgers.search.none")}</p>;

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
          <tr>
            <th scope="col">{t("ledgers.search.col.repair")}</th><th scope="col">{t("ledgers.col.message")}</th>
            <th scope="col">{t("ledgers.col.state")}</th><th scope="col" className="num">{t("ledgers.search.col.attempts")}</th>
            <th scope="col">{t("ledgers.search.col.error")}</th>
          </tr>
        </thead>
        <tbody>
          {failed.data.failed.map((row) => (
            <tr key={row.messageId}>
              <td>
                <input type="checkbox" aria-label={t("ledgers.search.repairOne", { id: row.messageId })} checked={chosen.has(row.messageId)}
                  onChange={() => toggle(row.messageId)} />
              </td>
              <td className="mono">{row.messageId}</td>
              <td><span className={`state state-index-${row.state}`}>{t(`ledgers.search.state.${row.state}`)}</span></td>
              <td className="num mono dim">{row.attempts}</td>
              <td className="dim mono">{row.error === null ? "—" : <NodeWords>{row.error}</NodeWords>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dim">{t("ledgers.search.advice")}</p>
      {/* Mounted whether or not anything is ticked, so the answer outlives the selection it was about. */}
      <OneAct label={t("ledgers.search.requeue", { n: chosen.size })} disabled={chosen.size === 0} run={async () => {
        const outcome = await repairSearch([...chosen]);
        if (!outcome.ok) return outcome;
        setChosen(new Set());
        await queryClient.invalidateQueries({ queryKey: ["search-failed"] });
        return { ok: true, text: requeued(outcome.value) };
      }} />
    </>
  );
}

/**
 * Verifying evidence, one bounded batch at a time. The verdict says what it covered, and the next
 * batch starts where this one stopped rather than from the beginning again.
 */
/** What a batch read and what it found: one plural per count, filled into the sentence that fits it. */
function batchRead(verdict: EvidenceVerdict): string {
  const counts = {
    checked: verdict.table === null
      ? t("ledgers.evidence.checked", { n: verdict.checked })
      : t("ledgers.evidence.checkedIn", { n: verdict.checked, table: verdict.table }),
    bytes: String(verdict.bytesRead),
  };
  return verdict.intact
    ? t("ledgers.evidence.intact", counts)
    : t("ledgers.evidence.faults", { ...counts, faults: t("ledgers.evidence.faultCount", { n: verdict.faults.length }) });
}

function EvidenceVerify() {
  const [verdict, setVerdict] = useState<EvidenceVerdict | null>(null);
  const [problem, setProblem] = useState<Refused | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify(after: string | null) {
    setBusy(true);
    setProblem(null);
    const outcome = await verifyEvidence(after);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome); return; }
    setVerdict(outcome.value);
  }

  return (
    <>
      <p>
        {/* A row of its own, 8px apart: a text space set the two buttons 4px apart (28 September 2026). */}
        <span className="inline-actions">
          <button type="button" className="quiet" disabled={busy} onClick={() => void verify(null)}>{t("ledgers.evidence.verify")}</button>
          {verdict?.resumeAfter == null ? null : (
            <button type="button" className="linkish" disabled={busy} onClick={() => void verify(verdict.resumeAfter)}>{t("ledgers.evidence.continue")}</button>
          )}
        </span>
      </p>
      {problem === null ? null : <p className="notice bad mono" role="alert" style={{ whiteSpace: "pre-wrap" }}>{marked(problem)}</p>}
      {verdict === null ? null : (
        <p className="notice mono" role="status">
          {t("ledgers.evidence.verdict", { head: batchRead(verdict), tail: t(verdict.resumeAfter === null ? "ledgers.evidence.last" : "ledgers.evidence.more") })}
          {verdict.faults.map((fault) => (
            <span key={`${fault.table}:${fault.rowId}:${fault.column}`} style={{ display: "block" }}>
              {sentence("ledgers.evidence.fault", {
                kind: t(`ledgers.evidence.kind.${fault.kind}`), table: fault.table, column: fault.column, rowId: fault.rowId,
                detail: <NodeWords>{fault.detail}</NodeWords>,
              })}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

/**
 * A finding's check: this interface's title for it (`doctor.check.*`) above its name, or, for a name a newer Node
 * emits that this interface does not know, the name alone. The name stays because the Node's own `fix` text cites
 * checks by it ("check the migrations_applied finding first").
 */
function CheckName({ check }: { check: string }) {
  if (!oneOf(DOCTOR_CHECKS, check)) return <td className="mono"><NodeWords>{check}</NodeWords></td>;
  return <td>{t(`doctor.check.${check}`)}<span className="mono dim block"><NodeWords>{check}</NodeWords></span></td>;
}

export function Doctor() {
  const doctor = useDoctor();
  if (doctor.isPending || doctor.isError) {
    return (
      <section className="ledger" aria-label={t("route./doctor")}>
        <header className="ledger-head"><h1>{t("route./doctor")}</h1></header>
        {doctor.isPending ? <Nothing kind="loading" /> : <Nothing kind="failed" detail={marked(doctor.error)} />}
      </section>
    );
  }

  const report = doctor.data;
  return (
    <section className="ledger" aria-label={t("route./doctor")}>
      <header className="ledger-head">
        <h1>{t("route./doctor")}</h1>
        <span className={`state verdict-${report.verdict}`}>{t(`health.status.${report.verdict}`)}</span>
      </header>
      <p className="notice dim mono">
        {t(report.claimed ? "ledgers.doctor.claimed" : "ledgers.doctor.unclaimed", { at: clock(report.at) })}
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">{t("ledgers.doctor.col.check")}</th>
            <th scope="col">{t("ledgers.col.state")}</th>
            <th scope="col">{t("ledgers.doctor.col.detail")}</th>
          </tr>
        </thead>
        <tbody>
          {report.findings.map((finding) => (
            <tr key={finding.check}>
              <CheckName check={finding.check} />
              <td>
                <span className={`state ${finding.ok ? "delivery-accepted" : `severity-${finding.severity}`}`}>
                  {t(finding.ok ? "health.status.ok" : `health.status.${finding.severity}`)}
                </span>
              </td>
              <td>
                <NodeWords>{finding.detail}</NodeWords>
                {finding.fix === undefined ? null : (
                  <>
                    {" "}
                    <span className="dim">{sentence("ledgers.doctor.fix", { fix: <NodeWords>{finding.fix}</NodeWords> })}</span>
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
