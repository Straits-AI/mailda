import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import {
  liftDomainPause, requestDomainPause, useBreakers, useDomainPauses, type BreakerReading,
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
  if (!reading.armed) return "not enough traffic to judge";
  if (reading.percent === null) return `${reading.observed} of ${reading.limit}`;
  return `${reading.percent.toFixed(1)}% of ${reading.limit}%`;
}

function windowWords(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  return `${Math.round(seconds / 60)} minutes`;
}

function Breakers() {
  const breakers = useBreakers();
  if (breakers.isPending) return <Nothing kind="loading" />;
  if (breakers.isError) return <Nothing kind="failed" detail={breakers.error.message} />;

  return (
    <div className="scroller">
      <table>
        <caption className="dim">
          Rates this Node applies to itself. Every limit is a measured budget, not a setting — changing one
          means changing its receipt.
        </caption>
        <thead>
          <tr>
            <th scope="col">Breaker</th>
            <th scope="col">Now</th>
            <th scope="col">Over</th>
            <th scope="col">Seen</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {breakers.data.breakers.map((reading) => (
            <tr key={reading.breaker}>
              <td>
                <span className="mono">{reading.breaker.replace(/_/g, " ")}</span>
                <br />
                {/* The Node's own sentence, so a person reads the same words here and on a stopped send. */}
                <span className="dim">{reading.sentence}</span>
              </td>
              <td className="mono">{percentage(reading)}</td>
              <td className="mono dim">{windowWords(reading.windowSeconds)}</td>
              <td className="mono num">{reading.observations}</td>
              <td>
                {reading.tripped
                  ? <span className="bad">stopping mail</span>
                  : reading.armed
                    ? <span className="dim">armed</span>
                    : <span className="dim">unarmed — {reading.unarmedReason?.replace(/_/g, " ")}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pauses() {
  const pauses = useDomainPauses();
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["domain-pauses"] });
    await queryClient.invalidateQueries({ queryKey: ["approvals"] });
  }

  async function ask() {
    setProblem(null);
    setAsked(null);
    const outcome = await requestDomainPause(domain.trim(), reason.trim());
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setDomain("");
    setReason("");
    // Not "paused". Two other administrators have to agree first, and saying it stopped when it has not is
    // the §5C mistake in the one place it would matter most — somebody would stop watching.
    setAsked("Asked. Two other administrators have to agree before this domain's mail stops.");
    await refresh();
  }

  async function lift(id: string) {
    setProblem(null);
    const outcome = await liftDomainPause(id);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await refresh();
  }

  return (
    <section className="limits-pauses" aria-label="Paused domains">
      <h2>Stopped domains</h2>
      {/*
        The asymmetry is the design and it is worth stating on the screen: stopping a customer's mail needs
        three people, restarting it needs one. Getting it wrong in the safe direction should be easy to undo.
      */}
      <p className="dim">
        Stopping a domain takes three administrators — you and two who agree. Restarting one takes a single
        administrator, alone, because a mistake in the cautious direction should be easy to undo.
      </p>

      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{problem}</pre>}
      {asked === null ? null : <p className="notice" role="status">{asked}</p>}

      <div className="limits-ask">
        <label className="field-row" htmlFor="pause-domain">
          <span>Domain</span>
          <input
            id="pause-domain"
            className="mono"
            placeholder="example.com"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <label className="field-row" htmlFor="pause-reason">
          <span>Why</span>
          <input
            id="pause-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => void ask()}
          disabled={domain.trim() === "" || reason.trim() === ""}
        >
          ask to stop this domain
        </button>
      </div>

      {pauses.isSuccess && pauses.data.pauses.length > 0 ? (
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th scope="col">Domain</th><th scope="col">Why</th>
                <th scope="col">Since</th><th scope="col">Restart</th>
              </tr>
            </thead>
            <tbody>
              {pauses.data.pauses.map((pause) => (
                <tr key={pause.id}>
                  <td className="mono">{pause.domain}</td>
                  <td>{pause.reason}</td>
                  <td className="mono">{new Date(pause.placedAt).toLocaleString()}</td>
                  <td>
                    <button type="button" className="linkish" onClick={() => void lift(pause.id)}>
                      let it send again
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Nothing kind="empty" detail="No domain is stopped." />
      )}
    </section>
  );
}

export function Limits() {
  return (
    <>
      <header className="ledger-head">
        <h1>Sending limits</h1>
      </header>
      <Breakers />
      <Pauses />
    </>
  );
}
