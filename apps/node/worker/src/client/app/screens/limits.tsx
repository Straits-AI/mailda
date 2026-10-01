import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { t } from "/app/locale.js";
import { Nothing, Scroller, Truncated } from "../chrome.tsx";
import { dateTime } from "../format.ts";
import { NodeWords, marked } from "../words.tsx";
import {
  liftDomainPause, liftSuppression, requestDomainPause, useBreakers, useDomainPauses, useSuppressions,
  type BreakerReading, type Said,
} from "../api.ts";

/**
 * What is stopping mail, and what would (#66, #81).
 *
 * ## Why the breakers are on a screen at all
 *
 * `GET /api/breakers` exists because of AGENTS.md's third principle rather than for a dashboard: *a limit
 * developers can hit is a limit they must see*. The refusal on a gated send already names the budget, the
 * limit and how long until it clears — but only once it has stopped something. Until then the readings were
 * available to a `curl` and to nobody else, so the first time an operator learned their Node was near its
 * bounce ceiling was when it stopped sending.
 *
 * ## Nothing here is configurable, and that is the point
 *
 * Every limit is a **budget with a receipt** (`docs/receipts/send-breakers.md`), generated from a
 * measurement rather than typed in. A slider on this screen would be a number with no receipt — the one
 * thing this repository does not allow — so the numbers are shown and not edited. Changing one means
 * changing the receipt, which is a change with an argument attached.
 *
 * ## Unarmed is a real answer
 *
 * A breaker with too few observations to judge is **unarmed**, not at zero. Rendering `0%` for a Node that
 * has sent four messages would invite exactly the wrong conclusion — that the rate is healthy — when the
 * honest answer is that there is nothing to compute a rate from yet. `armed: false` carries that, and this
 * screen says it in words.
 */

function percentage(reading: BreakerReading): string {
  if (!reading.armed) return t("limits.reading.unarmed");
  if (reading.percent === null) return t("limits.reading.count", { observed: reading.observed, limit: reading.limit });
  return t("limits.reading.percent", { percent: reading.percent.toFixed(1), limit: reading.limit });
}

function windowWords(seconds: number): string {
  if (seconds % 86_400 === 0) return t("limits.window.days", { n: seconds / 86_400 });
  if (seconds % 3_600 === 0) return t("limits.window.hours", { n: seconds / 3_600 });
  return t("limits.window.minutes", { n: Math.round(seconds / 60) });
}

function Breakers() {
  const breakers = useBreakers();
  if (breakers.isPending) return <Nothing kind="loading" />;
  if (breakers.isError) return <Nothing kind="failed" detail={marked(breakers.error)} />;

  return (
    <Scroller label={t("limits.breakers")}>
      <table>
        <caption className="dim">{t("limits.breakers.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("limits.col.breaker")}</th>
            <th scope="col">{t("limits.col.now")}</th>
            <th scope="col">{t("limits.col.over")}</th>
            <th scope="col">{t("limits.col.seen")}</th>
            <th scope="col">{t("limits.col.state")}</th>
          </tr>
        </thead>
        <tbody>
          {breakers.data.breakers.map((reading) => (
            <tr key={reading.breaker}>
              <td>
                <span className="mono">{reading.breaker.replace(/_/g, " ")}</span>
                <br />
                {/* The Node's own sentence, so a person reads the same words here and on a stopped send. */}
                <span className="dim"><NodeWords>{reading.sentence}</NodeWords></span>
              </td>
              <td className="mono">{percentage(reading)}</td>
              <td className="mono dim">{windowWords(reading.windowSeconds)}</td>
              <td className="mono num">{reading.observations}</td>
              <td>
                {reading.tripped
                  ? <span className="bad">{t("limits.state.tripped")}</span>
                  : reading.armed
                    ? <span className="dim">{t("limits.state.armed")}</span>
                    : (
                      <span className="dim">
                        {reading.unarmedReason === null ? t("limits.state.unarmed") : t(`limits.state.unarmed.${reading.unarmedReason}`)}
                      </span>
                    )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroller>
  );
}

function Pauses() {
  const pauses = useDomainPauses();
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<Said | null>(null);
  const [asked, setAsked] = useState<string | null>(null);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["domain-pauses"] });
    await queryClient.invalidateQueries({ queryKey: ["approvals"] });
  }

  async function ask() {
    setProblem(null);
    setAsked(null);
    const outcome = await requestDomainPause(domain.trim(), reason.trim());
    if (!outcome.ok) { setProblem(outcome); return; }
    setDomain("");
    setReason("");
    // Not "paused". Two other administrators have to agree first, and saying it stopped when it has not is
    // the §5C mistake in the one place it would matter most — somebody would stop watching.
    setAsked(t("limits.pauses.asked"));
    await refresh();
  }

  async function lift(id: string) {
    setProblem(null);
    const outcome = await liftDomainPause(id);
    if (!outcome.ok) { setProblem(outcome); return; }
    await refresh();
  }

  return (
    <section className="limits-pauses" aria-label={t("limits.pauses")}>
      <h2>{t("limits.pauses")}</h2>
      {/*
        The asymmetry is the design and it is worth stating on the screen: pausing a customer's mail needs two
        administrators besides whoever asks, lifting it needs one. Getting it wrong in the safe direction should be
        easy to undo.
      */}
      <p className="dim">{t("limits.pauses.lead")}</p>

      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{marked(problem)}</pre>}
      {asked === null ? null : <p className="notice" role="status">{asked}</p>}

      <div className="limits-ask">
        <label className="field-row" htmlFor="pause-domain">
          <span>{t("limits.pauses.domain")}</span>
          <input
            id="pause-domain"
            className="mono"
            placeholder="example.com"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <label className="field-row" htmlFor="pause-reason">
          <span>{t("limits.why")}</span>
          <input
            id="pause-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button className="quiet"
          type="button"
          onClick={() => void ask()}
          disabled={domain.trim() === "" || reason.trim() === ""}
        >
          {t("limits.pauses.act")}
        </button>
      </div>

      {pauses.isSuccess && pauses.data.pauses.length > 0 ? (
        <Scroller label={t("limits.pauses.list")}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("limits.pauses.domain")}</th><th scope="col">{t("limits.why")}</th>
                <th scope="col">{t("limits.since")}</th><th scope="col">{t("limits.pauses.lift")}</th>
              </tr>
            </thead>
            <tbody>
              {pauses.data.pauses.map((pause) => (
                <tr key={pause.id}>
                  <td className="mono">{pause.domain}</td>
                  <td>{pause.reason}</td>
                  <td className="mono">{dateTime(pause.placedAt)}</td>
                  <td>
                    <button type="button" className="linkish" onClick={() => void lift(pause.id)}>
                      {t("limits.pauses.liftAct")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      ) : (
        <Nothing kind="empty" detail={t("limits.pauses.empty")} />
      )}
    </section>
  );
}

/**
 * The recipients this Node will not send to, and the one act on the list. Nothing is placed here: the
 * provider's own events are the list, so a row appears when a hard bounce or a complaint arrives and goes
 * when an administrator vouches for the address with a reason.
 */
function Suppressions() {
  const suppressed = useSuppressions();
  const queryClient = useQueryClient();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Said | null>(null);

  async function lift(address: string) {
    setProblem(null);
    const outcome = await liftSuppression(address, (reasons[address] ?? "").trim());
    if (!outcome.ok) { setProblem(outcome); return; }
    await queryClient.invalidateQueries({ queryKey: ["suppressions"] });
  }

  return (
    <section className="limits-pauses" aria-label={t("limits.suppressed")}>
      <h2>{t("limits.suppressed.heading")}</h2>
      <p className="dim">{t("limits.suppressed.lead")}</p>
      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{marked(problem)}</pre>}
      {suppressed.isError ? <p className="notice dim">{marked(suppressed.error)}</p> : null}
      {suppressed.isSuccess
        ? <Truncated when={suppressed.data.truncated} shown={suppressed.data.suppressed.length} noun={t("limits.suppressed.noun")} />
        : null}
      {suppressed.isSuccess && suppressed.data.suppressed.length > 0 ? (
        <Scroller label={t("limits.suppressed.heading")}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("limits.suppressed.address")}</th><th scope="col">{t("limits.why")}</th>
                <th scope="col">{t("limits.since")}</th><th scope="col">{t("limits.vouch")}</th>
              </tr>
            </thead>
            <tbody>
              {suppressed.data.suppressed.map((row) => (
                <tr key={row.address}>
                  <td className="mono">{row.address}</td>
                  <td>{t(`limits.cause.${row.cause}`)}{row.detail === null ? null : <> — <NodeWords>{row.detail}</NodeWords></>}</td>
                  <td className="mono dim">{row.observedAt.slice(0, 16).replace("T", " ")}</td>
                  <td>
                    <label className="target-edit">
                      <span className="dim mono">{t("limits.why")}</span>
                      <input
                        value={reasons[row.address] ?? ""}
                        aria-label={t("limits.vouch.why", { address: row.address })}
                        onChange={(event) => setReasons({ ...reasons, [row.address]: event.target.value })}
                      />
                    </label>{" "}
                    <button type="button" className="linkish" disabled={(reasons[row.address] ?? "").trim() === ""} onClick={() => void lift(row.address)}>
                      {t("limits.vouch")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      ) : suppressed.isSuccess ? <Nothing kind="empty" detail={t("limits.suppressed.empty")} /> : null}
    </section>
  );
}

export function Limits() {
  return (
    <>
      <header className="ledger-head">
        <h1>{t("limits.title")}</h1>
      </header>
      <Breakers />
      <Pauses />
      <Suppressions />
    </>
  );
}
