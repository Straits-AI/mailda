import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "/app/session.js";

import { Nothing } from "../chrome.tsx";
import { type MessageRow, claimCase, stealCase, useMailboxes, useMessages } from "../api.ts";
import { Composer, type ComposerContext } from "./composer.tsx";

/**
 * The list and the reading pane — the half of variant B that is not a ledger.
 *
 * ## The body goes in a sandboxed iframe, and the sandbox is the boundary
 *
 * `/api/messages/:id/body` returns sanitised HTML. ADR 37 is explicit that the sanitiser is **not** the
 * trust boundary: it reduces what the browser's parser is handed and withholds remote content, and the
 * thing that actually contains a hostile message is the iframe's `sandbox` with neither `allow-scripts`
 * nor `allow-same-origin`. Those two omissions are load-bearing. `allow-same-origin` would hand the frame
 * this document's origin, which is where the session cookies live.
 *
 * `srcDoc` rather than a URL, so the frame is opaque-origin and never a same-origin document that
 * happened to be sandboxed.
 */

interface RenderedBody {
  state: string;
  html: string | null;
  text: string | null;
  blockedRemote: number;
  truncated: boolean;
  problem: string | null;
}

function received(at: string): string {
  // A message whose own Date header was unreadable has `accepted_at` and nothing else; that is what is
  // shown, and it is labelled as when the Node accepted it rather than when it was sent.
  return new Date(at).toLocaleString(undefined, { hour12: false });
}

function MessageBody({ id }: { id: string }) {
  const body = useQuery({
    queryKey: ["body", id],
    queryFn: async (): Promise<RenderedBody> => {
      const response = await apiFetch(`/api/messages/${encodeURIComponent(id)}/body`);
      if (!response.ok) throw new Error(`The body could not be read (${response.status}).`);
      return (await response.json()) as RenderedBody;
    },
    // A body is immutable once accepted, so unlike the lists this can be cached hard. Authorization is
    // still re-checked server-side on every request; what is cached is bytes the caller already read.
    staleTime: Infinity,
  });

  if (body.isPending) return <Nothing kind="loading" />;
  if (body.isError) return <Nothing kind="failed" detail={body.error.message} />;

  const rendered = body.data;

  if (rendered.state === "unparsed") {
    return (
      <Nothing
        kind="failed"
        detail={rendered.problem ?? "This message's body could not be read. The original is unchanged."}
      />
    );
  }

  return (
    <>
      {rendered.blockedRemote > 0 ? (
        <p className="notice dim">
          {rendered.blockedRemote} remote resource{rendered.blockedRemote === 1 ? "" : "s"} withheld. Loading
          them would tell the sender you opened this.
        </p>
      ) : null}
      {rendered.truncated ? <p className="notice dim">Shown truncated. The original is complete.</p> : null}
      {rendered.state === "html" && rendered.html !== null ? (
        <iframe
          className="message-body"
          title="Message body"
          // Neither allow-scripts nor allow-same-origin. See the header — this is the trust boundary.
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={rendered.html}
        />
      ) : (
        <pre className="message-text">{rendered.text ?? ""}</pre>
      )}
    </>
  );
}

/**
 * The reply context. `Re:` is not doubled, and the quote line names when *this Node accepted* the message
 * rather than when the sender says they wrote it — a sender-supplied Date can be unreadable or absent, and
 * `accepted_at` is the one timestamp the Node observed itself.
 */
function replyContext(message: MessageRow, mailboxId: string): ComposerContext {
  const subject = message.subject ?? "";
  return {
    mailboxId,
    // ADR 36 threads on the message's own id. Absent when the sender sent none, in which case this is a
    // new message that happens to be addressed back — which is the truth, so it is not faked.
    inReplyToMessageId: message.message_id ?? undefined,
    to: message.envelope_from,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    body: `\n\nOn ${new Date(message.accepted_at).toLocaleString()}, ${message.envelope_from} wrote:\n> …`,
  };
}

/**
 * A message nobody prompted (#79).
 *
 * The composer has rendered "New message" in two places since it was written and `inReplyToMessageId` has
 * always been optional — what was missing was any caller that left it out, so every outbound path the product
 * had ran through somebody else having written first. This is that caller, and it is four fields short of
 * `replyContext` on purpose:
 *
 * **No `to`.** A composer that opens pre-addressed to anything is how a message goes to the wrong person, and
 * there is no candidate here that is not a guess. **No `subject`** and **no `body`** for the same reason —
 * `replyContext` derives all three from the message being answered, and there is no such message.
 *
 * **No case, either**, and that is the substantive difference rather than an omission. Reply claims the case
 * in the same act (#42) because two people answering one correspondent is the collision that matters. A
 * message nobody sent has no case to claim and no collision to lose: the mailbox is a place to send *from*,
 * not a conversation somebody else might already be holding.
 */
function newMessageContext(mailboxId: string): ComposerContext {
  return { mailboxId };
}

/**
 * The control that starts one, and the mailbox it will be sent from.
 *
 * The mailbox is **chosen, never inferred**. `From` is the mailbox (ADR 36) and `send.propose` is held per
 * mailbox, so which one this goes from is a real decision with a governance consequence — picking the first
 * row for somebody would put their name on an address they did not choose. `useMailboxes` already returns
 * exactly the mailboxes the caller holds `send.propose` on, so the options need no separate authority check
 * and cannot offer one they may not use.
 *
 * Nothing renders when they hold none: a button that can only fail is worse than no button.
 */
function StartMessage({ onStart }: { onStart: (mailboxId: string) => void }) {
  const mailboxes = useMailboxes();
  const rows = mailboxes.data?.mailboxes ?? [];
  /**
   * What has been chosen. `null` means **nobody has chosen yet**, which is a different thing from "the
   * first one" and is the whole of #94.
   *
   * It used to be `from ?? rows[0]!.id`, nine lines under the comment above saying picking the first row
   * would put somebody's name on an address they did not choose. The `<select>` rendered with that value,
   * so the first mailbox looked chosen, and pressing the button without touching the dropdown sent from
   * whichever mailbox `useMailboxes` happened to return first — an order that is not even stable.
   */
  const [from, setFrom] = useState<string | null>(null);
  if (rows.length === 0) return null;
  /*
   * One mailbox is not a choice, so it needs no act: there is exactly one possible answer and asking for it
   * would be ceremony. More than one and the default is **nothing**, because a default here is a governance
   * decision made on somebody's behalf and then hidden from them by the control that claims to show it.
   */
  const chosen = from ?? (rows.length === 1 ? rows[0]!.id : null);

  return (
    <p className="new-message">
      {rows.length === 1 ? null : (
        <>
          <label htmlFor="new-message-from" className="dim">from</label>
          {" "}
          <select
            id="new-message-from"
            // The empty string is the unchosen state, and it has to be a real option rather than an absent
            // value: a `<select>` given a value matching no option shows its first one anyway, which is the
            // original bug wearing a different implementation.
            value={chosen ?? ""}
            onChange={(event) => setFrom(event.target.value === "" ? null : event.target.value)}
          >
            <option value="">choose a mailbox…</option>
            {rows.map((row) => (
              // The address, not only the name: two mailboxes can be called Support and what a recipient
              // sees is the address. `addresses` is NULL when a mailbox has none, and `sealManifest` refuses
              // that mailbox — so it is shown as such rather than silently looking sendable.
              <option key={row.id} value={row.id}>
                {row.name}{row.addresses === null ? " (no address)" : ` · ${row.addresses.split(",")[0]!}`}
              </option>
            ))}
          </select>
          {" "}
        </>
      )}
      <button
        type="button"
        className="primary"
        // Disabled rather than hidden, and rather than opening a composer with no sender: the control has
        // to say that a choice is missing, not silently do nothing or silently pick. `aria-disabled` is not
        // used in its place because there is genuinely nothing to activate yet.
        disabled={chosen === null}
        onClick={() => { if (chosen !== null) onStart(chosen); }}
      >
        new message
      </button>
    </p>
  );
}

function ReadingPane({ message, onReply }: { message: MessageRow; onReply: () => void }) {
  return (
    <article className="reading-pane" aria-label="Message">
      {/* h2, not h1. The screen's heading is "Inbox"; a message is a section inside it, and two h1s on
          one page is the same landmark confusion in heading form. */}
      <h2 className="message-title">{message.subject ?? <span className="dim">(no subject)</span>}</h2>
      <dl className="headers">
        <dt>from</dt>
        <dd className="mono">{message.from_addr ?? message.envelope_from}</dd>
        <dt>to</dt>
        <dd className="mono">{message.envelope_to}</dd>
        <dt>accepted</dt>
        <dd className="mono">{received(message.accepted_at)}</dd>
        <dt>original</dt>
        <dd>
          {/* The bytes as they arrived. §12's whole point is that this is producible, so it is a link
              rather than a feature request. */}
          <a className="mono" href={`/api/messages/${encodeURIComponent(message.id)}/raw`}>
            .eml
          </a>{" "}
          <span className="dim mono">{message.raw_bytes} bytes</span>
        </dd>
      </dl>
      <p className="row-actions">
        <button type="button" className="linkish" onClick={onReply}>
          reply
        </button>
      </p>
      {message.parse_error === null ? null : (
        <p className="notice dim">
          Headers were only partly readable: {message.parse_error}. The original is unchanged.
        </p>
      )}
      <MessageBody id={message.id} />
    </article>
  );
}

export function Inbox() {
  const messages = useMessages();
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState<ComposerContext | null>(null);
  /** Set when a claim lost the race, so the reader is told who holds it rather than nothing happening. */
  const [blocked, setBlocked] = useState<{ message: string; caseId: string } | null>(null);
  const queryClient = useQueryClient();

  /**
   * Reply claims the case and opens the composer **in one act** (#42).
   *
   * The guarantee lives in the compare-and-swap, not in a separate gesture, so this is what the reply button
   * does rather than a step before it. Losing the race means the composer does not open and the reader is
   * told who holds the case — with the option to take it, which is audited.
   */
  async function reply(message: MessageRow, steal = false) {
    setBlocked(null);
    if (message.case_id === null) {
      // Honest rather than silent: mail with no case cannot be claimed, so composing would produce a reply
      // nobody holds and the collision mechanism would not apply to it.
      setBlocked({
        message: "This message has no case yet, so it cannot be claimed. It predates the queue.",
        caseId: "",
      });
      return;
    }
    const outcome = steal ? await stealCase(message.case_id) : await claimCase(message.case_id);
    await queryClient.invalidateQueries({ queryKey: ["messages"] });
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    if (outcome.ok) {
      setComposing(replyContext(message, message.mailbox_id));
      return;
    }
    setBlocked({ message: outcome.message, caseId: message.case_id });
  }

  // The heading is rendered before any of the states below, and that ordering is the fix rather than a
  // style: with it inside the branches, a loading or empty inbox was a screen with no level-one heading —
  // which the advisory axe run caught on the first pass. A screen's name should not depend on whether its
  // data arrived.
  /*
   * `StartMessage` lives in the heading, which is rendered before every branch below — so it is present
   * while the inbox is loading, when it is empty, and when it is full.
   *
   * The empty case is the one that matters and the reason it is here rather than beside the reading pane.
   * That screen currently says "Nothing has arrived yet — send one to an address routed here", which until
   * now was advice the product could not take: a Node with no mail had no way to send any. A fresh install
   * could receive before it could speak.
   */
  const heading = (
    <header className="ledger-head">
      <h1>Inbox</h1>
      <StartMessage onStart={(mailboxId) => setComposing(newMessageContext(mailboxId))} />
      {messages.isSuccess ? <p className="dim mono">{messages.data.messages.length} messages</p> : null}
    </header>
  );

  /*
   * Rendered in **every** branch, not only the populated one.
   *
   * `StartMessage` sits in the heading and the heading precedes all four returns, so a composer mounted only
   * beside the reading pane would let somebody open one on an empty inbox and watch nothing happen — state
   * set, no dock. That is the failure mode of putting a new entry point on a screen written around a list.
   */
  const composer = composing === null
    ? null
    : <Composer context={composing} onClose={() => setComposing(null)} />;

  if (messages.isPending) return <>{heading}<Nothing kind="loading" />{composer}</>;
  if (messages.isError) {
    return <>{heading}<Nothing kind="failed" detail={messages.error.message} />{composer}</>;
  }

  const rows = messages.data.messages;
  if (rows.length === 0) {
    return (
      <>
        {heading}
        {/*
          What an empty list means, and nothing further (#101).

          It used to say "This Node is claimed and routing is live", concluded from an empty result set —
          which establishes neither. Email Routing never enabled, MX records pointing elsewhere, a catch-all
          aimed at another Worker, no address configured at all: every one of those produces this same
          screen, and the sentence told the reader it was working. They would then wait, send a test message,
          watch that not arrive either, and still be looking at "routing is live".

          The status is not restated here, because this screen cannot establish it and the version that
          guessed is the bug. `doctor`'s `inbound_routing` finding is what can: it proves whether an address
          exists and whether anything has ever arrived, and says plainly that whether routing is pointing
          here *right now* needs the Cloudflare dashboard, because that lives in the account and this Node
          holds no token for it. The link goes to /doctor rather than a Domain Setup screen because /doctor
          is what exists.
        */}
        <Nothing
          kind="empty"
          detail="No messages are visible to you yet. Whether mail can reach this Node is a separate question — Doctor's inbound routing check answers it."
          action={{ to: "/doctor", label: "check inbound routing" }}
        />
        {composer}
      </>
    );
  }

  const current = rows.find((row) => row.id === selected) ?? null;

  return (
    <>
    {heading}
    <div className="split">
      {/*
        A plain list of buttons, with `aria-current` marking the one being read.

        This was a `role="listbox"` of `role="option"`s wrapping buttons, and axe was right to reject it:
        `nested-interactive` — an option must not contain an interactive control, because a screen reader
        user then has two things to operate for one row and the listbox's own keyboard model never applies.
        A real listbox would mean owning arrow keys, Home/End and typeahead; a list of buttons is the
        pattern that is already correct, and `aria-current` says which one is open without claiming a
        selection model this list does not implement.

        It surfaced only once the inbox had a message in it. The earlier clean run rendered an empty
        inbox, so the list did not exist to be checked — worth remembering about any harness that
        measures whatever state the fixture happens to be in.
      */}
      <ul className="message-list" aria-label="Messages">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className={row.id === selected ? "message-row current" : "message-row"}
              aria-current={row.id === selected ? "true" : undefined}
              onClick={() => setSelected(row.id)}
            >
              <span className="message-from mono">{row.from_addr ?? row.envelope_from}</span>
              <span className="message-subject">
                {row.subject ?? <span className="dim">(no subject)</span>}
              </span>
              <span className="message-when dim mono">{received(row.accepted_at)}</span>
            </button>
          </li>
        ))}
      </ul>
      {current === null ? (
        <p className="reading-pane notice dim">Select a message.</p>
      ) : (
        <ReadingPane
          message={current}
          // From is the mailbox (ADR 36), so composing needs to know which one. It is read off the message
          // being replied to rather than guessed: that address is routed to exactly one mailbox.
          onReply={() => void reply(current)}
        />
      )}
      {blocked === null ? null : (
        <p className="notice bad" role="alert">
          {blocked.message}
          {blocked.caseId === "" || current === null ? null : (
            <>
              {" "}
              {/* Available to any colleague and audited — the escape hatch the absent timeout depends on. */}
              <button type="button" className="linkish" onClick={() => void reply(current, true)}>
                take it anyway
              </button>
            </>
          )}
        </p>
      )}
      {composer}
    </div>
    </>
  );
}
