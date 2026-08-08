import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "/app/session.js";

import { Nothing } from "../chrome.tsx";
import { type MessageRow, useMessages } from "../api.ts";
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

  // The heading is rendered before any of the states below, and that ordering is the fix rather than a
  // style: with it inside the branches, a loading or empty inbox was a screen with no level-one heading —
  // which the advisory axe run caught on the first pass. A screen's name should not depend on whether its
  // data arrived.
  const heading = (
    <header className="ledger-head">
      <h1>Inbox</h1>
      {messages.isSuccess ? <p className="dim mono">{messages.data.messages.length} messages</p> : null}
    </header>
  );

  if (messages.isPending) return <>{heading}<Nothing kind="loading" /></>;
  if (messages.isError) {
    return <>{heading}<Nothing kind="failed" detail={messages.error.message} /></>;
  }

  const rows = messages.data.messages;
  if (rows.length === 0) {
    return (
      <>
        {heading}
        <Nothing
          kind="empty"
          detail="This Node is claimed and routing is live. Nothing has arrived yet — send one to an address routed here."
        />
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
          onReply={() => setComposing(replyContext(current, current.mailbox_id))}
        />
      )}
      {composing === null ? null : (
        <Composer context={composing} onClose={() => setComposing(null)} />
      )}
    </div>
    </>
  );
}
