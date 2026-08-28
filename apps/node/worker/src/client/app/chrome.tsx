import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { accessExpiresAt, isSignedIn, logout } from "/app/session.js";

import {
  useApprovals, useDoctor, useMailboxes, useMessages, useNotifications, useSends, type NotificationRow,
} from "./api.ts";
import type { AppRoute } from "../../app-routes.ts";

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
  const approvals = useApprovals();
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
            {/*
              A count only once it is known. A zero rendered while loading is a claim about an unread list,
              which is precisely the §5C distinction between "empty" and "not yet answered".

              **`+` when more exist, because this number is a page and not a total** (#91). It always was —
              the listing was capped at fifty long before it was paginated — so the rail has been printing a
              page size where a reader reasonably reads a total, and the same commit that added paging
              renamed the inbox heading to `{n} shown` for exactly that reason while leaving this one as a
              bare figure. Two numbers from one query, one of them honest.

              `next_cursor` already answers it, so this costs nothing: a null means nothing older is visible
              and the figure is the whole of what this reader may see. A real total would need a second
              authorization-scoped `COUNT`, and it is not worth a query to turn `50+` into `4,213`.
            */}
            {messages.isSuccess ? (
              <span className="mono num">
                {messages.data.messages.length}{messages.data.next_cursor === null ? "" : "+"}
              </span>
            ) : null}
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
          {/*
            Approvals is first among the ledgers because it is the only one that is *work*: the others record
            what happened, this one is a queue of decisions somebody is waiting on. The count is the point —
            an approver who has to open a screen to discover they are blocking a message will not open it.
          */}
          <Link to="/approvals" className="rail-row" activeProps={{ className: "rail-row current" }}>
            <span className="rail-name">Approvals</span>
            {approvals.isSuccess && approvals.data.approvals.length > 0
              ? <span className="mono num">{approvals.data.approvals.length}</span>
              : null}
          </Link>
        </li>
        <li>
          {/*
            "Rules" rather than "Policies": the word a person uses for what their organization does with
            mail. The screen renders each one as a sentence for the same reason.
          */}
          <Link to="/rules" className="rail-row" activeProps={{ className: "rail-row current" }}>
            <span className="rail-name">Rules</span>
          </Link>
        </li>
        <li>
          <Link to="/people" className="rail-row" activeProps={{ className: "rail-row current" }}>
            <span className="rail-name">People</span>
          </Link>
        </li>
        <li>
          <Link to="/matters" className="rail-row" activeProps={{ className: "rail-row current" }}>
            <span className="rail-name">Matters</span>
          </Link>
        </li>
        <li>
          {/*
            Butlers sits with the ledgers rather than the mailboxes, and the placement is the claim: a
            Butler is not a place mail lands, it is a standing account of what this Node does without a
            person. The screen is refused to anybody without `org.admin` (§5C, as a 404), so the link is
            shown to everyone and the answer is given by the screen — hiding it would be a second, weaker
            copy of the authority decision, in the navigation, where it cannot be enforced.
          */}
          <Link to="/butlers" className="rail-row" activeProps={{ className: "rail-row current" }}>
            <span className="rail-name">Butlers</span>
          </Link>
        </li>
        <li>
          {/*
            * Beside Butlers, because the two are the same question from different directions: what acts
            * without a person present, and under whose authority. Refused to anybody without `org.admin` as a
            * 404, like Butlers, so the link is shown to everyone and the screen gives the answer.
            */}
          <Link to="/agents" className="rail-row" activeProps={{ className: "rail-row current" }}>
            <span className="rail-name">Agents</span>
          </Link>
        </li>
        <li>
          {/* Beside the outbox, because it is the answer to "why is nothing going out". */}
          <Link to="/limits" className="rail-row" activeProps={{ className: "rail-row current" }}>
            <span className="rail-name">Limits</span>
          </Link>
        </li>
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
/**
 * The three states a list can be in, said in words that do not claim more than is known.
 *
 * ## `unfiltered` is opt-in now, and used to be unconditional (#101)
 *
 * This appended *"An empty ledger. Not a filtered one: nothing has been hidden from you"* to **every** empty
 * state. On most of them that is false. Authorization on this Node happens **inside the SQL** (ADR 11, §5),
 * so an empty list routinely means "nothing you may see" rather than "nothing" — and telling a reader
 * nothing has been hidden from them is exactly the claim the architecture forbids the interface from making.
 *
 * The screens knew. `matters.tsx` writes *"No matters, or you do not hold org.admin"* in its own detail,
 * which is honest, and then this sentence contradicted it two words later on the same line.
 *
 * So a caller now has to **assert** it, and the assertion is only correct where the query is genuinely not
 * scoped by a relation. The default says nothing extra, because a blank prompts a question and a wrong
 * reassurance ends one.
 */
export function Nothing(
  { kind, detail, unfiltered = false, action }: {
    kind: "empty" | "failed" | "loading";
    detail?: string;
    /** Only pass this when the underlying query is not narrowed by authorization. It rarely is. */
    unfiltered?: boolean;
    /**
     * Where to go to answer the question this screen cannot.
     *
     * `AppRoute`, not `string`. The first version took a string and cast it at the `<Link>`, which bought
     * an `any` and gave up the one thing worth having here: a destination that does not exist becomes a
     * compile error rather than a dead link on an empty screen somebody only reaches when something is
     * already wrong. `app-routes.ts` is the same list `index.ts` serves deep links from, so the two cannot
     * disagree about which routes exist.
     */
    action?: { to: AppRoute; label: string };
  },
) {
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
      {detail ?? "Nothing here yet."}
      {unfiltered
        ? <> <span className="dim">An empty ledger. Not a filtered one: nothing has been hidden from you.</span></>
        : null}
      {action === undefined
        ? null
        : <> <Link to={action.to} className="linkish">{action.label}</Link></>}
    </p>
  );
}

/**
 * The notices this person has been delivered (#63 part B, §7).
 *
 * ## Why this is a band above the stage rather than a screen
 *
 * §7 requires that the person whose mail was read be told, and this project's argument is that an unusable
 * record is not a record. A notice behind a route is one nobody opens; a notice above whatever they came here
 * to do is one they read. It is also why there is **no dismiss control**: §7 requires the notification not be
 * disableable by the investigator, and the cheapest way to hold that is for the interface to have no way to
 * clear one — there is no endpoint behind a button that does not exist.
 *
 * ## Why the text is assembled here and the facts are not
 *
 * The Node freezes the *facts* at delivery — who read, how much, for how long, under what matter, and what
 * they actually did — and this turns them into a sentence. The split matters: the record must say the same
 * thing for ever, and the wording is allowed to improve. What this must not do is add a fact the Node did not
 * record, which is why every value below comes out of `body` and nothing is inferred.
 *
 * Absent fields render as absent rather than as a guess. A notice delivered by an older Node carries an older
 * shape, and "an unrecorded instant" is a truthful thing to print where a fabricated one is not.
 */
function noticeText(notice: NotificationRow): { headline: string; meta: string } {
  const body = (notice.body ?? {}) as Record<string, unknown>;
  const text = (key: string): string | null => typeof body[key] === "string" ? body[key] : null;

  if (notice.kind === "approval_request") {
    return {
      headline: `You were asked to decide an approval (${text("subjectKind") ?? "an act"}).`,
      meta: `request ${text("approvalId") ?? notice.subjectId} · asked by ${text("requestedBy") ?? "somebody"}`
        + ` · ${text("requestedAt") ?? "an unrecorded instant"}`,
    };
  }

  const acts = (body.acts ?? {}) as Record<string, number>;
  const count = (key: string): number => typeof acts[key] === "number" ? acts[key] : 0;
  const reader = text("readerEmail") ?? text("readerId") ?? "somebody";
  const mailbox = text("mailboxName") ?? text("mailboxId") ?? "a mailbox";
  return {
    headline: `${reader} was granted a supervised ${text("scope") ?? "read"} of ${mailbox}, `
      + `${text("grantedAt") ?? "at an unrecorded instant"} to ${text("expiresAt") ?? "an unrecorded instant"}.`,
    // The counts are the part that makes this actionable rather than ceremonial: the difference between a
    // grant nobody used and one under which everything was opened.
    meta: `${count("queries")} quer${count("queries") === 1 ? "y" : "ies"} listing ${count("listed")} `
      + `message(s) · ${count("opened")} opened · ${count("attachments")} raw message(s) read`
      + ` · matter ${text("matterId") ?? "none cited"}`
      + `${text("matterType") === null ? "" : ` (${text("matterType")})`}`
      + ` · grant ${text("grantId") ?? notice.subjectId}`,
  };
}

export function Notices() {
  const notices = useNotifications();
  // Nothing while it is loading and nothing on a failure: this band is an addition to whatever screen a
  // person is on, and a failure banner above every screen would be the loudest thing in the product for a
  // read that is not the one they asked for. The failure is visible where notices are the subject.
  if (!notices.isSuccess || notices.data.notifications.length === 0) return null;

  return (
    <section className="notices" aria-label="Notifications">
      {notices.data.notifications.map((notice) => {
        const { headline, meta } = noticeText(notice);
        return (
          <p key={notice.id} className="notice told">
            {headline}
            {" "}
            <span className="told-meta mono">{meta}</span>
          </p>
        );
      })}
    </section>
  );
}
