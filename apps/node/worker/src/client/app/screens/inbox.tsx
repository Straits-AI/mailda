import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "/app/session.js";

import { BUDGETS } from "@mailda/budgets";

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
 * Narrows the listing to one mailbox (#91).
 *
 * ## Why this is a control on the screen and not a rail row
 *
 * The rail lists mailboxes, so a filter here looks like a duplicate — and the first reading of it was that
 * the rail should simply become clickable. It should not, at least not for this: the rail's per-mailbox rows
 * sit **under Queue** and carry *unclaimed* counts. They are about work nobody has taken, which is Layer 3's
 * subject, and repointing them at a filtered inbox would change what they mean rather than give them a
 * meaning. Whether a rail row navigates is a real question and it belongs with the queue, not with paging.
 *
 * ## Why it is not the same control as `StartMessage`'s
 *
 * That one picks a mailbox to **send as** — governance, per-mailbox `send.propose`, and #94's whole argument
 * that it must never be defaulted invisibly. This one picks what to *look at*. So this one **does** default,
 * to every mailbox, because "all" is a truthful description of an unfiltered list rather than a choice made
 * on somebody's behalf. Two controls that look alike and differ in exactly that way, which is why they are
 * separate functions with the reasoning written in both.
 *
 * The options come from `useMailboxes`, which returns what this reader holds `send.propose` on — **not** what
 * they may read. That is a genuine mismatch and it is the narrower set: a supervised reader may see messages
 * from a mailbox that is not in this list, so filtering cannot reach them and the unfiltered view is the one
 * that shows their mail. Filtering to fewer rows than exist is safe; the reverse would not be. Named here
 * because the honest fix is a `mailbox.content.read` listing, and inventing one for a filter would be a new
 * authority surface added for a convenience.
 */
function MailboxFilter({ chosen, onChoose }: {
  chosen: string | null;
  onChoose: (mailboxId: string | null) => void;
}) {
  const mailboxes = useMailboxes();
  const rows = mailboxes.data?.mailboxes ?? [];
  // Nothing to narrow with one mailbox, and nothing to narrow at all with none.
  if (rows.length < 2) return null;

  return (
    <span className="inbox-filter">
      <label htmlFor="inbox-mailbox" className="dim">mailbox</label>
      {" "}
      <select
        id="inbox-mailbox"
        value={chosen ?? ""}
        onChange={(event) => onChoose(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">all mailboxes</option>
        {rows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select>
    </span>
  );
}

/**
 * The search field (#107).
 *
 * ## A form, submitted — not search-as-you-type
 *
 * Every keystroke reaching the Node would be one authorization and, for a supervised reader, one
 * `supervised.query` audit entry **per keystroke** — recording mail they never looked at, against
 * `audit.max_detail_bytes`, on the hot read path. §7 records acts and typing is not an act. The same argument
 * `usePages` makes for one page being one request applies letter by letter here.
 *
 * So it submits. A form also gets the Enter key, a labelled control and a real submit button for nothing,
 * which is the accessible answer as well as the cheap one.
 *
 * ## The term is not interpreted here
 *
 * No trimming, no tokenizing, no "did you mean". The Node's `ftsQuery` decides what a search means, and a
 * client with its own opinion is how the shell and the SDK end up disagreeing about the same words. What this
 * does own is the **clear** affordance: a search with no way out is a mailbox that looks empty for ever.
 */
function SearchField({ term, onSearch }: {
  term: string | null;
  onSearch: (next: string | null) => void;
}) {
  /*
   * Local state, so typing does not refetch. `term` is what has been *asked*; `draft` is what is being typed,
   * and keeping them apart is what makes this a form rather than a subscription to the keyboard.
   */
  const [draft, setDraft] = useState(term ?? "");

  return (
    <form
      className="inbox-search"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(draft.trim() === "" ? null : draft);
      }}
    >
      {/*
        * The brand's search pill (#128), and the **form is unchanged**: a label, a real input and a real
        * submit. What was here was a native `<button>Search</button>` sitting beside an unstyled field —
        * the one control on the interface that had not been dressed at all, which is what made it the thing
        * a person noticed first.
        *
        * The submit button is still a button, and now carries the magnifier. That matters more than it
        * looks: the mockup shows an icon inside a field, which is usually built as a decorative glyph and a
        * field that submits on Enter — and that loses the button, so a person navigating by keyboard has
        * nothing to land on and a screen reader is told there is no way to run the search. The icon is the
        * button's face, not a picture beside it.
        */}
      <label htmlFor="inbox-q" className="visually-hidden">Search mail</label>
      <span className="search-pill">
        <input
          id="inbox-q"
          type="search"
          value={draft}
          placeholder="Search mail"
          onChange={(event) => setDraft(event.target.value)}
        />
        {/*
          * "Search", not "Search mail" — the label above already uses that, and **two controls in one form
          * sharing an accessible name is ambiguous**: a screen reader announces "Search mail, edit" then
          * "Search mail, button" with nothing to tell them apart. Caught by `search-field.test.tsx`, which
          * could no longer find either of them unambiguously. The field names itself; the button names the
          * act.
          */}
        <button type="submit" className="search-go" aria-label="Search">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="6.6" cy="6.6" r="4.6" stroke="currentColor" strokeWidth="1.7" />
            <path d="M10.1 10.1 L14 14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
      </span>
      {/*
        * **The capability, said where somebody can discover it** — and it is a tripwire, not a nicety.
        *
        * The field used to be labelled "search" with the placeholder "sender, subject or message text". The
        * brand's pill wants "Search mail", which is shorter and denies a feature the Node has:
        * `search-copy-world.test.ts` failed on exactly that, and its reasoning is that *"people do not
        * discover a feature the interface denies having"*. Putting the three fields back into the
        * placeholder would either overflow the pill or truncate at the tail, hiding "message text" —
        * the one word the test exists for.
        *
        * So the pill keeps the brand's two words and the hint carries the rest. The narrower half —
        * that content access decides how much of it a reader reaches — is on the empty state, where a person
        * who searched and found nothing is the one who needs it.
        */}
      <p className="hint search-hint">Searches senders, subjects and message text.</p>
      {term === null ? null : (
        <button
          type="button"
          className="search-clear"
          onClick={() => {
            setDraft("");
            onSearch(null);
          }}
        >
          Clear
        </button>
      )}
    </form>
  );
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

/**
 * The one control the inbox needed, and deliberately not a redesign of it (#91).
 *
 * **A cursor stack, one page at a time**, rather than an infinite list that appends. Three reasons, in the
 * order they decided it:
 *
 * 1. Every page re-runs the whole authorization server-side, so an appending list of ten pages refetches ten
 *    pages on every window focus — ten authorizations, and for a supervised reader ten more `supervised.query`
 *    entries recording mail they are not currently looking at. One page is one request.
 * 2. Going back needs no reverse query. The stack holds the cursors already used, so *newer* is a `pop`.
 * 3. It is honest about what the Node answered. An appended list reads as *"this is the mail"*; a page reads
 *    as *"this is a page of the mail"*, which is the true claim — `next_cursor` says whether more is visible
 *    and nothing here knows a total, because nothing counted one.
 *
 * The stack is component state and is meant to be: it is a scroll position, not a fact about the mailbox, and
 * a reload landing on the newest page is the right behaviour rather than a lost one.
 */
/**
 * What a full page looks like, so "capped" can be distinguished from "that is all there was".
 *
 * From `BUDGETS` rather than written here: `messages.page_size` is a measured tripwire
 * (`docs/receipts/message-page-size.md`) and a client with its own copy would tell the reader a page was
 * capped at a number the Node had stopped using.
 */
const PAGE_FULL = BUDGETS["messages.page_size"];

function usePages() {
  /** The cursors used to reach the current page. Empty means the newest one. */
  const [stack, setStack] = useState<string[]>([]);
  /** Which mailbox the listing is narrowed to, or null for every mailbox this reader may see. */
  const [mailbox, setMailbox] = useState<string | null>(null);
  /** What has been searched for, or null for the unsearched listing (#107). */
  const [term, setTerm] = useState<string | null>(null);
  return {
    cursor: stack[stack.length - 1] ?? null,
    mailbox,
    term,
    /** 1-based, for the reader. Never presented as "of N": nothing here knows N and nothing counted it. */
    number: stack.length + 1,
    older: (next: string) => setStack((was) => [...was, next]),
    newer: () => setStack((was) => was.slice(0, -1)),
    newest: () => setStack([]),
    /**
     * Narrowing the listing **resets the position**, and that is a correctness requirement rather than a
     * courtesy.
     *
     * A cursor is a position in one ordering. Change the filter and it is a position in a different
     * ordering — the row it names may not be in the new listing at all, so the page it produces is
     * somewhere arbitrary, or nowhere. The Node cannot catch this for us: the cursor is well-formed and the
     * authorization re-runs, so it answers correctly for a question nobody asked.
     */
    narrowTo: (next: string | null) => {
      setMailbox(next);
      setStack([]);
    },
    /**
     * Searching **resets the position**, for exactly the reason `narrowTo` does and worth stating rather than
     * leaving to the reader of the line above.
     *
     * A cursor is a position in one ordering, and a search is a different listing. The row the cursor names
     * may not be in the results at all, so keeping it would produce a page from somewhere arbitrary — and the
     * Node cannot catch it, because the cursor is well-formed and the authorization re-runs. It answers
     * correctly for a question nobody asked, which is the failure mode `messagePageRequest` refuses a
     * *malformed* cursor to avoid.
     */
    searchFor: (next: string | null) => {
      setTerm(next);
      setStack([]);
    },
  };
}

export function Inbox() {
  const pages = usePages();
  const messages = useMessages({ cursor: pages.cursor, mailbox: pages.mailbox, q: pages.term });
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
      <MailboxFilter chosen={pages.mailbox} onChoose={pages.narrowTo} />
      <SearchField term={pages.term} onSearch={pages.searchFor} />
      {/*
        `shown`, not `messages`, and the word is the fix rather than a tidy-up (#91).
        `{n} messages` was true only while the listing returned everything there was; against a page it
        states a count of the archive and prints the size of a page. Nothing here knows the total — no query
        counted one — so the honest sentence names what is on the screen and which page it is.
      */}
      {messages.isSuccess ? (
        <p className="dim mono">
          {messages.data.messages.length} shown{pages.number === 1 ? "" : ` · page ${pages.number}`}
          {pages.mailbox === null ? "" : " · one mailbox"}
          {/*
            A searched page says so, because `3 shown` over a mailbox of nine hundred is only honest if the
            reader can see that a filter is on. The empty case is the one that matters: without this, a search
            that matched nothing is a screen indistinguishable from an empty mailbox.

            **A full page of results says it is capped**, and this is the honest form of a decision rather than
            a nicety. A search returns one page of the best matches by relevance and there is no way to page
            further, because bm25 rank shifts as mail arrives and a cursor into a ranked list would skip and
            repeat rows silently. So a reader seeing exactly a page's worth needs to know that narrowing the
            words is how to see different mail — otherwise "50 shown" reads as "50 matches", which is a claim
            nothing here can make.
          */}
          {pages.term === null
            ? ""
            : messages.data.messages.length < PAGE_FULL
              ? " · searched"
              : " · best matches — narrow the words to see others"}
        </p>
      ) : null}
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
    /*
     * Two different empties, and saying the wrong one is #101 again in a new place (#91).
     *
     * *"Nothing has arrived yet"* is a statement about the whole Node, and on page four it is simply false —
     * mail arrived, it is on pages one to three. A page past the end says so and offers the way back, because
     * the reader who is looking at it got there by pressing a control this screen rendered.
     */
    return (
      <>
        {heading}
        {pages.term !== null ? (
          /*
            A search that matched nothing, which is a **third** empty and the reason this branch comes first
            (#107).

            The two below are statements about the Node and about the page. This one is a statement about the
            words: mail may well have arrived and be sitting on page one unsearched. Saying "no messages are
            visible to you yet" here would be false, and offering the routing check would send somebody to
            diagnose their DNS because they misspelled a supplier's name.

            So it names the term back, says what was searched, and offers the way out — a search with no
            clear affordance is a mailbox that stays empty for ever. `unfiltered` is deliberately **not**
            passed: this list is filtered, by the search and by authorization both, and claiming nothing has
            been hidden would be the exact opposite of true.
          */
          <>
            <Nothing
              kind="empty"
              detail={`No mail matches those words${
                pages.mailbox === null ? "" : " in this mailbox"
              }. Every word has to appear, and it has to appear in the same place — a word from a subject `
                + "and a word from a message's text will not match together. Message text is searched only "
                + "in mailboxes where you can read content; elsewhere this searched subjects and senders."}
            />
            <p className="row-actions">
              <button type="button" className="linkish" onClick={() => pages.searchFor(null)}>
                clear the search
              </button>
            </p>
          </>
        ) : pages.number === 1 ? (
          /*
            What an empty list means, and nothing further (#101).

            It used to say "This Node is claimed and routing is live", concluded from an empty result set —
            which establishes neither. Email Routing never enabled, MX records pointing elsewhere, a
            catch-all aimed at another Worker, no address configured at all: every one produces this same
            screen, and the sentence told the reader it was working.

            `doctor`'s `inbound_routing` finding is what can answer it: whether an address exists, whether
            anything has ever arrived, and plainly that whether routing points here *now* needs the
            Cloudflare dashboard, because that lives in the account and this Node holds no token for it.
          */
          <Nothing
            kind="empty"
            detail="No messages are visible to you yet. Whether mail can reach this Node is a separate question — Doctor's inbound routing check answers it."
            action={{ to: "/doctor", label: "check inbound routing" }}
          />
        ) : (
          /*
            Page two or later, which is a different statement and the reason this branches at all (#91). An
            empty *later* page does not mean nothing has arrived — it means nothing is older than where the
            reader is standing. Saying "nothing has arrived yet" here would be false, and saying anything
            about routing would be false twice.
          */
          <>
            <Nothing kind="empty" detail="Nothing older on this page." />
            <p className="row-actions">
              <button type="button" className="linkish" onClick={pages.newest}>newest</button>
            </p>
          </>
        )}
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
      {/*
        The pager (#91). Two buttons, each rendered only when it can do something.

        `older` exists exactly when `next_cursor` is non-null, which is the Node saying there is at least one
        more row **this reader may see at this instant** — not that the archive continues. So an absent button
        is the honest end of the list and never a disabled control the reader has to test.

        Not a page-number list: producing one needs a total, nothing counted a total, and a count is the one
        thing a listing authorized in SQL cannot cheaply have.
      */}
      {messages.data.next_cursor === null && pages.number === 1 ? null : (
        <nav className="row-actions" aria-label="Pages">
          {pages.number === 1 ? null : (
            <button type="button" className="linkish" onClick={pages.newer}>newer</button>
          )}
          {messages.data.next_cursor === null ? null : (
            <button
              type="button"
              className="linkish"
              onClick={() => pages.older(messages.data.next_cursor!)}
            >
              older
            </button>
          )}
        </nav>
      )}
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
