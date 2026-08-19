import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { accessExpiresAt, isSignedIn, logout } from "/app/session.js";

import { useDoctor, useMailboxes, useMessages, useSends } from "./api.ts";

/**
 * Variant B's chrome: a persistent rail, and an instrument bar along the bottom.
 *
 * ## Why the rail, when there is exactly one mailbox today
 *
 * Layer 3 is *share* — shared mailboxes, assignment, reply-collision, cases with SLA clocks — and it needs
 * a persistent list of mailboxes carrying per-item counts and claim state. That is what a rail is. Route
 * tabs are not, and choosing them would mean bolting a rail on at Layer 3 and rewriting the chrome around
 * it. So the rail exists now with one row in it, and Layer 3 adds rows rather than a new shape.
 *
 * There is deliberately **no mailboxes endpoint call** here. None exists — nothing can create a second
 * mailbox yet — and inventing a client-side list would be a decision about visibility, which ADR 11 puts
 * on the server on every request.
 *
 * ## Why the top status strip does not survive
 *
 * Layer 1 put node state in the top-right, which is where a reader's eye rests when there is nothing else
 * competing. With a rail present it is not, and the counts belong next to the mailboxes they describe. So
 * the session countdown, the `doctor` verdict and the outbound counts move to a bottom instrument bar —
 * the same instrument-panel language, in the place the eye now leaves last.
 */

/**
 * The session countdown, which is on screen for a reason rather than as decoration.
 *
 * An access token that silently expires is the exact failure the session layer exists to prevent, so its
 * clock is visible where a person can watch it happen. `Date.now()` is correct here: this is a page with
 * one user, one tab and one clock, and the ctx seam is a Worker concern (see eslint.config.js).
 */
function SessionClock() {
  const [readout, setReadout] = useState<string | null>(null);

  useEffect(() => {
    function tick() {
      if (!isSignedIn()) return setReadout(null);
      const expiresAt = accessExpiresAt();
      if (expiresAt === null) return setReadout(null);
      const remaining = Math.max(0, expiresAt - Date.now());
      const minutes = Math.floor(remaining / 60_000);
      const seconds = Math.floor((remaining % 60_000) / 1000);
      setReadout(`renews in ${minutes}:${String(seconds).padStart(2, "0")}`);
    }
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  if (readout === null) return null;
  // `aria-live` deliberately absent. A countdown that announces itself every second makes a screen reader
  // unusable; the information is available on focus, and the states that matter — renewing, signed out —
  // are announced by the surfaces that change.
  return <span className="field session mono">session · {readout}</span>;
}

/** The Node's verdict on itself, in the one place an operator will keep glancing at. */
function DoctorVerdict() {
  const doctor = useDoctor();
  if (doctor.isPending) return <span className="field dim mono">doctor · reading</span>;
  if (doctor.isError) {
    // A doctor that cannot be read is itself a finding, and saying nothing would read as healthy.
    return <span className="field mono state state-outcome_unknown">doctor · unreachable</span>;
  }
  const verdict = doctor.data!.verdict;
  const failing = doctor.data!.findings.filter((finding) => !finding.ok).length;
  return (
    <Link to="/doctor" className="field mono linkish" title={`${failing} check(s) not ok`}>
      doctor · <span className={`state verdict-${verdict}`}>{verdict}</span>
    </Link>
  );
}

/** Counts, next to nothing that could be mistaken for them. */
function OutboundCounts() {
  const sends = useSends();
  if (!sends.isSuccess) return null;
  const held = sends.data.sends.filter((send) => send.state === "held").length;
  // Counted separately rather than folded into `held`, and shown whenever it is non-zero. A policy-gated send
  // is pending mail somebody is waiting on, so leaving it out of the bar would make the bar under-report the
  // outbox — and folding it into `held` would say a person can release it by waiting, which is what `held`
  // means and is exactly what `awaiting` does not.
  const awaiting = sends.data.sends.filter((send) => send.state === "awaiting").length;
  return (
    <span className="field">
      <span className="key">handed over today</span>
      <span className="mono num">{sends.data.daily.handedOver}</span>
      {held > 0 ? (
        <>
          <span className="key">held</span>
          <span className="mono num">{held}</span>
        </>
      ) : null}
      {awaiting > 0 ? (
        <>
          <span className="key">awaiting</span>
          <span className="mono num">{awaiting}</span>
        </>
      ) : null}
    </span>
  );
}

export function InstrumentBar() {
  return (
    <footer className="instrument-bar" aria-label="Node status">
      <span className="field">
        <span className="dot live" />
        <span>listening</span>
      </span>
      <span className="field mono">{location.host}</span>
      <OutboundCounts />
      <span className="bar-spacer" />
      <DoctorVerdict />
      <SessionClock />
      <button type="button" className="linkish" onClick={() => void logout()}>
        sign out
      </button>
    </footer>
  );
}

/**
 * The rail. Mailboxes first, then the ledgers.
 *
 * The ledgers — outbox, audit, log — are full-width tables rather than rail-and-pane, because for a
 * ledger a table genuinely is the right form. That split is the one thing variant A got right and it is
 * kept.
 */
export function Rail() {
  const messages = useMessages();
  const mailboxes = useMailboxes();
  const sends = useSends();
  const state = useRouterState();
  const path = state.location.pathname;

  const unparsed = messages.isSuccess
    ? messages.data.messages.filter((message) => message.parse_error !== null).length
    : 0;

  return (
    <nav className="rail" aria-label="Mailboxes and ledgers">
      <p className="wordmark">
        MAIL<span className="accent">DA</span>
      </p>

      <p className="rail-heading" id="rail-mailboxes">
        mailboxes
      </p>
      <ul className="rail-list" aria-labelledby="rail-mailboxes">
        <li>
          <Link to="/" className="rail-row" activeProps={{ className: "rail-row current" }}>
            <span className="rail-name">Inbox</span>
            {/* A count only once it is known. A zero rendered while loading is a claim about an unread
                list, which is precisely the §5C distinction between "empty" and "not yet answered". */}
            {messages.isSuccess ? <span className="mono num">{messages.data.messages.length}</span> : null}
          </Link>
        </li>
        {/*
          The queues, one row per mailbox, with the count of **unclaimed** work.

          This is what the rail was chosen over route tabs for, and it carried one hardcoded row from the day
          it shipped until now, because nothing could tell it which mailboxes existed. The number is
          unclaimed rather than total on purpose: a queue's depth is the work nobody has taken, and counting
          claimed cases alongside it would make a busy queue look like a backlog.
        */}
        {mailboxes.isSuccess && mailboxes.data.mailboxes.length > 0 ? (
          <li className="rail-queues">
            <Link to="/queue" className="rail-row" activeProps={{ className: "rail-row current" }}>
              <span className="rail-name">Queue</span>
              <span className="mono num">
                {mailboxes.data.mailboxes.reduce((total, box) => total + box.unclaimed, 0)}
              </span>
            </Link>
            <ul className="rail-sublist">
              {mailboxes.data.mailboxes.map((box) => (
                <li key={box.id} className="rail-subrow">
                  <span className="rail-name dim">{box.name}</span>
                  <span className="mono num dim" title={`${box.unclaimed} unclaimed, ${box.claimed} in progress, ${box.mine} yours`}>
                    {box.unclaimed}
                    {box.mine > 0 ? <span className="rail-mine"> · {box.mine} yours</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ) : null}
        {unparsed > 0 ? (
          <li className="rail-note">
            <span className="state state-outcome_unknown">{unparsed} unparsed</span>
          </li>
        ) : null}
      </ul>

      <p className="rail-heading" id="rail-ledgers">
        ledgers
      </p>
      <ul className="rail-list" aria-labelledby="rail-ledgers">
        <li>
          <Link to="/outbox" className="rail-row" activeProps={{ className: "rail-row current" }}>
            <span className="rail-name">Outbox</span>
            {sends.isSuccess ? <span className="mono num">{sends.data.sends.length}</span> : null}
          </Link>
        </li>
        <li>
          <Link to="/audit" className="rail-row" activeProps={{ className: "rail-row current" }}>
            <span className="rail-name">Audit</span>
          </Link>
        </li>
        <li>
          <Link to="/log" className="rail-row" activeProps={{ className: "rail-row current" }}>
            <span className="rail-name">Log</span>
          </Link>
        </li>
      </ul>

      {/* The rail is also where an operator finds the diagnostic, because it is the screen they need when
          something else has stopped working. */}
      <ul className="rail-list rail-foot">
        <li>
          <Link
            to="/doctor"
            className="rail-row"
            activeProps={{ className: "rail-row current" }}
            aria-current={path === "/doctor" ? "page" : undefined}
          >
            <span className="rail-name dim">Doctor</span>
          </Link>
        </li>
      </ul>
    </nav>
  );
}

/**
 * The four empty states §5C requires kept distinct, as one component so they cannot drift apart.
 *
 * "Could not be read" is not "empty", and "you are not entitled to know" is neither. A single "nothing
 * here" for all three is how a mail client tells its first lie.
 */
export function Nothing({ kind, detail }: { kind: "empty" | "failed" | "loading"; detail?: string }) {
  if (kind === "loading") return <p className="notice dim">Reading…</p>;
  if (kind === "failed") {
    return (
      <p className="notice bad" role="alert">
        {detail ?? "This could not be read. That is different from it being empty."}
      </p>
    );
  }
  return (
    <p className="notice">
      {detail ?? "Nothing here yet."}{" "}
      <span className="dim">An empty ledger. Not a filtered one: nothing has been hidden from you.</span>
    </p>
  );
}
