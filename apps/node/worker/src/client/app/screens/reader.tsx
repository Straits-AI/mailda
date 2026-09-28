import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "/app/session.js";
import { currentTheme, type ThemeChoice } from "/app/theme.js";

import { Nothing } from "../chrome.tsx";
import {
  type MessageRow, type Place, type SendRow, assignCase, labelsOf, setLabels, stealCase, useCases, useMe,
  useMessageHeaders, useThread,
} from "../api.ts";
import { useToast } from "../shell-context.tsx";
import { Icon } from "../ui/icons.tsx";
import { Menu, type MenuItem } from "../ui/menu.tsx";
import { Modal, Popover } from "../ui/popover.tsx";

/**
 * The reading pane: one message, what is known about it, and what this reader may do with it.
 *
 * Split out of `inbox.tsx`, which keeps the list and the orchestration (selection, the claim, places, keys);
 * this file renders one message and asks the Node nothing it was not asked for — the body when the message is
 * opened, the headers and the cases only on the click that needs them.
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
 *
 * ## Offer only what works, and name what is withheld
 *
 * Reply, Reply all, Forward and Assign need `send.propose` on the delivery's mailbox, so they render only
 * where it is held, and where it is not the pane says which authority is missing (AGENTS.md §3: a capability
 * gap names the permission, never a greyed control). Read state, labels and places need standing content read
 * (`standing_content`), so their controls are omitted, not greyed, for a metadata or supervised reader —
 * opening the message is what such a reader may do, and it is the recorded act.
 */

export interface RenderedBody {
  state: string;
  html: string | null;
  text: string | null;
  blockedRemote: number;
  truncated: boolean;
  problem: string | null;
  attachments: Array<{
    filename: string | null;
    declaredType: string;
    bytes: number;
    verdict: "executable" | "script" | "archive" | "archive_dangerous" | "disguised" | "plain";
  }>;
  links: Array<{ href: string; text: string; verdict: "plain" | "mismatch" | "lookalike" | "userinfo" | "ip_host" }>;
  recipients: { to: string[]; cc: string[]; replyTo: string | null };
}

/**
 * One message's body, fetched once and shared by everything that reads it: the frame, the details' To and Cc,
 * the reply's addressees and quote. Two observers of one key are one request, and for a supervised reader one
 * recorded open. One definition, so the reader's `useBody` and `reply()`'s `fetchQuery` cannot disagree on the
 * key and become two reads.
 */
export function bodyQuery(id: string) {
  return queryOptions({
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
}

export function useBody(id: string) {
  return useQuery(bodyQuery(id));
}

/**
 * The start of the frame's document: the viewer's theme on the frame's own `<html>`, and the frame's sheet.
 *
 * The frame is opaque-origin and cannot see the shell's `<html>`, so it is told on its own, and
 * `frameStylesheet()` in `src/theme.ts` matches `:root[data-theme=…]` there. `theme` is one of three words by
 * type, and `currentTheme()` checks the attribute it reads against them, so nothing unchecked reaches the
 * frame. A sender cannot override it: the sanitiser keeps `<html>` with no attributes (`src/render/body.ts`),
 * and a later `<html>` start tag only adds attributes the element lacks. The doctype first keeps the frame in
 * standards mode; a sender's own doctype then parses as an ignored duplicate.
 */
export function frameHead(theme: ThemeChoice): string {
  return `<!doctype html><html data-theme="${theme}"><link rel="stylesheet" href="/app/frame.css">`;
}

/** The original, as it arrived. A download is recorded as an export, and the route decides who may. */
export function rawHref(receiptId: string): string {
  return `/api/messages/${encodeURIComponent(receiptId)}/raw`;
}

/** The full local time of an instant: the `title` behind every short time, and the details' Received. */
export function fullTime(at: string): string {
  return new Date(at).toLocaleString(undefined, { hour12: false });
}

/** Month names for dates in lists and chips; see `shortTime` for why they are written out. */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * When this Node received it, as short as it can be and still be unambiguous: `15:09` today, `26 Sep` this
 * year, `26 Sep 2025` before. The month names are written here rather than asked of `Intl`, whose `en-GB`
 * short month for September changed to "Sept" across ICU versions; a list is a place a date is scanned for.
 * `accepted_at` is this Node's own observation: a sender's Date header can be absent, unreadable or false.
 */
export function shortTime(at: string, now: Date = new Date()): string {
  const when = new Date(at);
  if (when.toDateString() === now.toDateString()) {
    return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  }
  const day = `${when.getDate()} ${MONTHS[when.getMonth()]}`;
  return when.getFullYear() === now.getFullYear() ? day : `${day} ${when.getFullYear()}`;
}

const LINK_WORDS: Record<RenderedBody["links"][number]["verdict"], string | null> = {
  plain: null,
  mismatch: "says one place and goes to another",
  lookalike: "goes to a domain that resembles one of yours and is not it",
  userinfo: "carries a name before the real host, so it reads as somewhere it is not",
  ip_host: "goes to a bare address rather than a named site",
};

/**
 * The links worth a word, with where each really goes. Nothing is rewritten in the body — the sender's
 * href is what a click follows — so this is the comparison a hover cannot make, stated once, above the body.
 */
function Links({ links }: { links: RenderedBody["links"] }) {
  const flagged = links.filter((one) => one.verdict !== "plain");
  if (flagged.length === 0) return null;
  return (
    <div className="notice bad" role="alert">
      <p>{flagged.length} of {links.length} link{links.length === 1 ? "" : "s"} in this message {flagged.length === 1 ? "is" : "are"} not what {flagged.length === 1 ? "it says" : "they say"}:</p>
      <ul className="links-flagged">
        {flagged.map((one, index) => (
          <li key={index}>
            <span className="mono">{one.text === "" ? "(an image)" : one.text}</span> {LINK_WORDS[one.verdict]}: <span className="mono dim">{one.href}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What each verdict means, in words. Also shown by the composer, so a file is described the same way both ways. */
export const VERDICT_WORDS: Record<RenderedBody["attachments"][number]["verdict"], string | null> = {
  plain: null,
  archive: "an archive; what is inside has not been opened",
  archive_dangerous: "an archive listing a program or a script",
  executable: "a program",
  script: "a script",
  disguised: "a program under a document's name",
};

/**
 * What was attached, named and judged, with no way to open it from here: the bytes stay in the original,
 * which the raw download carries whole. A verdict is a word a person can check against the file, not a scan.
 */
function Attachments({ parts, receiptId }: { parts: RenderedBody["attachments"]; receiptId: string }) {
  if (parts.length === 0) return null;
  return (
    <ul className="attachments" aria-label="Attachments">
      {parts.map((part, index) => {
        const word = VERDICT_WORDS[part.verdict];
        return (
          <li key={index}>
            {/* A link to the part's own bytes; the Node serves a flagged one as octet-stream, to save and not run. */}
            <a className="mono" href={`/api/messages/${encodeURIComponent(receiptId)}/attachments/${index}`}>
              {part.filename ?? "(unnamed)"}
            </a>{" "}
            <span className="dim">{part.declaredType} · {Math.max(1, Math.round(part.bytes / 1024))} KB</span>
            {word === null ? null : (
              <span className={part.verdict === "archive" ? "dim" : "bad"}> — {word}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Whether the body frame holds keyboard focus, for its focus ring (WCAG 2.4.7).
 *
 * The page sees none of the usual signs: a focused frame element matches neither `:focus` nor
 * `:focus-within` and fires no focus event (probed in Chromium). What the page does see is its window blurring
 * with the frame as `document.activeElement`, and focusing again when focus comes back out. Keyboard only, as
 * `:focus-visible` is: the blur counts when a Tab pressed on this page moved it, so a click into the message to
 * select its text draws no ring, and switching to another window leaves the ring as it was.
 */
function useFrameFocus(frame: React.RefObject<HTMLIFrameElement | null>): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    let tabbing = false;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      tabbing = true;
      // The focus move is this key's default action, which is over before any task runs.
      setTimeout(() => { tabbing = false; });
    }
    function onBlur() {
      if (document.activeElement !== frame.current) setFocused(false);
      else if (tabbing) setFocused(true);
    }
    const onFocus = () => setFocused(false);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [frame]);
  return focused;
}

/**
 * The body, and every notice about it **above** it: remote resources withheld, a truncated rendering, the
 * attachments with their verdicts, links that are not what they say. A warning under the fold of a long
 * message is a warning read after the click it was about.
 */
export function MessageBody({ id }: { id: string }) {
  const body = useBody(id);
  const frame = useRef<HTMLIFrameElement>(null);
  const frameFocused = useFrameFocus(frame);

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
      <Attachments parts={rendered.attachments} receiptId={id} />
      <Links links={rendered.links} />
      {rendered.state === "html" && rendered.html !== null ? (
        <iframe
          ref={frame}
          className="message-body"
          title="Message body"
          data-focused={frameFocused ? "" : undefined}
          // Neither allow-scripts nor allow-same-origin. See the header — this is the trust boundary.
          sandbox=""
          referrerPolicy="no-referrer"
          // Read when the frame renders. The theme changes only on /settings, where no reader is mounted.
          srcDoc={frameHead(currentTheme()) + rendered.html}
        />
      ) : (
        <pre className="message-text">{rendered.text ?? ""}</pre>
      )}
    </>
  );
}

/**
 * What the receiving server established about the sender, in one line a person can act on.
 *
 * DMARC is the verdict that matters — it is the sender's own domain saying whether this message is theirs —
 * so it leads; SPF and DKIM are the evidence beneath it. `none` is most of the internet (the domain
 * publishes no policy) and is said plainly rather than as a warning, so the warning that matters — a `fail`
 * against a domain that asked for `reject` — is the only red thing here. A message from before this Node
 * evaluated authentication says so, rather than reading as clean.
 *
 * `evidence` adds the parenthesis; the details line states the three results before the sentence already.
 */
function Authenticated({ message, evidence }: { message: MessageRow; evidence: boolean }) {
  const domain = <span className="mono">{message.auth_from_domain ?? "the From domain"}</span>;
  const why = `spf ${message.auth_spf ?? "absent"}, dkim ${message.auth_dkim ?? "absent"}`;
  if (message.auth_dmarc === null) return <>Not evaluated — arrived before this Node checked senders</>;
  if (message.auth_dmarc === "absent") return <>no authentication header from the receiving server</>;
  if (message.auth_dmarc === "pass") {
    return <>{domain} vouches for this message{evidence ? ` (dmarc pass; ${why})` : ""}</>;
  }
  if (message.auth_dmarc === "fail") {
    return (
      <>
        {domain} <span className="bad">says this message is not theirs</span>
        {evidence
          ? ` (dmarc fail; ${why}${message.auth_dmarc_policy === null ? "" : `; the domain asks receivers to ${message.auth_dmarc_policy}`})`
          : ""}
      </>
    );
  }
  return <>{domain} publishes no policy{evidence ? ` (dmarc ${message.auth_dmarc}; ${why})` : ""}</>;
}

/** The details line: the three results, then what they add up to. */
function authLine(message: MessageRow) {
  if (message.auth_dmarc === null || message.auth_dmarc === "absent") return <Authenticated message={message} evidence={false} />;
  return (
    <>
      SPF {message.auth_spf ?? "absent"} · DKIM {message.auth_dkim ?? "absent"} · DMARC {message.auth_dmarc}
      {" — "}
      <Authenticated message={message} evidence={false} />
    </>
  );
}

/**
 * Everything about the envelope, folded under "to {address}".
 *
 * The summary keeps the address the message **arrived at** visible (§4B.3): which of a mailbox's addresses
 * someone wrote to is often the first thing a reply depends on. A DMARC `fail` is not in here only; the pane
 * repeats it above, unfolded, because a spoofing warning behind a disclosure is a warning nobody opens.
 */
function Details({ message, body, onHeaders }: {
  message: MessageRow;
  body: RenderedBody | undefined;
  onHeaders: (opener: HTMLElement) => void;
}) {
  const address = message.from_addr ?? message.envelope_from;
  const to = body?.recipients.to ?? [];
  const cc = body?.recipients.cc ?? [];
  const replyTo = body?.recipients.replyTo ?? null;
  return (
    <details className="reader-details">
      <summary className="reader-to">to {message.envelope_to} <Icon name="chevron-down" /></summary>
      <dl className="details-grid">
        <dt>From</dt>
        <dd>{message.from_name === null ? address : `${message.from_name} <${address}>`}</dd>
        <dt>To</dt>
        {/* The To header once the body has been read (it is content); the envelope's address until then. */}
        <dd>{to.length > 0 ? to.join(", ") : message.envelope_to}</dd>
        {cc.length > 0 ? <><dt>Cc</dt><dd>{cc.join(", ")}</dd></> : null}
        {replyTo === null ? null : <><dt>Reply-To</dt><dd>{replyTo}</dd></>}
        <dt>Delivered to</dt>
        <dd>{message.envelope_to}</dd>
        {/* "Received": when this Node accepted it, the one time it observed itself. */}
        <dt>Received</dt>
        <dd><time dateTime={message.accepted_at}>{fullTime(message.accepted_at)}</time></dd>
        <dt>Authentication</dt>
        <dd>{authLine(message)}</dd>
        <dt>Size</dt>
        <dd>{message.raw_bytes.toLocaleString()} bytes</dd>
      </dl>
      <div className="details-actions">
        {/* After the body: the headers route takes the body's authority, so a reader it refused is refused again. */}
        {body === undefined ? null : (
          <button type="button" className="btn" onClick={(event) => onHeaders(event.currentTarget)}><Icon name="headers" /> View headers</button>
        )}
        {/*
          No `download` attribute: the route sends content-disposition itself, and without the attribute a
          `message.export` refusal opens as the Node's words instead of being saved as a file of error JSON.
        */}
        <a className="btn" href={rawHref(message.id)}><Icon name="download" /> Download original</a>
        <span className="details-note">Downloading is recorded as an export.</span>
      </div>
    </details>
  );
}

/**
 * The header block as it arrived, on demand. Content, so the body's authority and record: under a supervised
 * grant each fetch is a recorded open, which is why nothing asks for it before this dialog is open.
 */
function HeadersDialog({ receiptId, opener, onClose }: {
  receiptId: string;
  /** The control that opened it, which gets focus back: Safari does not focus a button on click. */
  opener: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const headers = useMessageHeaders(receiptId);
  return (
    <Modal className="headers-dialog" label="Headers" onClose={onClose} returnTo={opener}>
      <header>
        <h2>Headers</h2>
        <button type="button" className="btn btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </header>
      {headers.isPending ? <Nothing kind="loading" /> : headers.isError ? <Nothing kind="failed" detail={headers.error.message} /> : (
        <>
          {headers.data.truncated ? (
            <p className="headers-note">
              Shown: the first {headers.data.limit_bytes.toLocaleString()} bytes (<code>mime.max_header_bytes</code>).
              The full header block is in Download original.
            </p>
          ) : null}
          {/*
            A named region in the Tab order, as the notices band: a real header block (a relay chain, DKIM, ARC) is
            taller than the dialog, and a browser that does not focus a scroller by itself (WebKit) left a keyboard
            no way to read past the first screen of it (R2AXE-1). ARIA names no bare `<pre>`, hence the role.
          */}
          <pre className="headers-text" tabIndex={0} role="region" aria-label="Header block">{headers.data.headers}</pre>
        </>
      )}
    </Modal>
  );
}

/**
 * Hand the case to a colleague — without ever handing over a case somebody else holds by accident (R5).
 *
 * The holder is shown **first**, from the cases the Queue lists (fetched when this opens, never before), and a
 * case held by someone else offers only "Take it anyway" — the audited steal — until that succeeds. The
 * hand-over then sends the holder this popover displayed, so a colleague's claim landing in between is refused
 * by the Node's compare-and-swap, naming them, rather than overwritten.
 */
function AssignBody({ message, onDone }: { message: MessageRow; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const caseId = message.case_id;
  const cases = useCases(caseId === null ? null : message.mailbox_id);
  const me = useMe();
  const [stolen, setStolen] = useState(false);
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  if (caseId === null) return <p>This message has no case yet, so it cannot be assigned. It predates the queue.</p>;
  if (cases.isPending || me.isPending) return <Nothing kind="loading" />;
  if (cases.isError) return <Nothing kind="failed" detail={cases.error.message} />;
  if (me.isError) return <Nothing kind="failed" detail={me.error.message} />;
  const listed = cases.data.cases.find((one) => one.id === caseId);
  if (listed === undefined) return <p>This case is closed.</p>;
  const mine = stolen || (listed.assignee !== null && listed.assignee === me.data.userId);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["messages"] }),
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
      queryClient.invalidateQueries({ queryKey: ["cases"] }),
    ]);
  }

  if (listed.state === "claimed" && !mine) {
    return (
      <>
        <p className="assign-holder">
          Held by {listed.assignee_email ?? "a colleague"} since {listed.claimed_at === null ? "an unrecorded time" : fullTime(listed.claimed_at)}.{" "}
          <button
            type="button"
            className="linkish"
            onClick={() => void (async () => {
              setProblem(null);
              const taken = await stealCase(caseId);
              if (!taken.ok) {
                setProblem(taken.message);
                return;
              }
              setStolen(true);
              await refresh();
            })().catch((error: unknown) => setProblem(`This Node could not be reached (${(error as Error).message}).`))}
          >
            Take it anyway
          </button>
        </p>
        {problem === null ? null : <p className="bad" role="alert">{problem}</p>}
      </>
    );
  }

  // Unclaimed, or yours: the holder the Node is told this popover saw.
  const holder = mine ? me.data.userId : null;
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setProblem(null);
          void (async () => {
            const outcome = await assignCase(caseId, email, holder);
            if (!outcome.ok) {
              setProblem(outcome.message);
              return;
            }
            onDone();
            toast({ text: `Handed to ${email}. It is in their queue now, and the trail names you both.` });
            await refresh();
          })().catch((error: unknown) => setProblem(`This Node could not be reached (${(error as Error).message}).`));
        }}
      >
        <label htmlFor="assign-email">Colleague's sign-in address</label>
        <input id="assign-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <button type="submit" className="primary">Hand over</button>
      </form>
      {problem === null ? null : <p className="bad" role="alert">{problem}</p>}
    </>
  );
}

function Assign({ message }: { message: MessageRow }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <span className="popover-wrap">
      <button
        ref={anchor}
        type="button"
        className="btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="assign" /> Assign
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Assign" className="assign-popover popover-down popover-start" anchor={anchor}>
        <AssignBody message={message} onDone={() => setOpen(false)} />
      </Popover>
    </span>
  );
}

/**
 * The words on a message, visible without expanding anything, beside the "to …" line and only when there are
 * some. Removing is the × on the word; clicking the word narrows the list to it; adding is "Add label…" in the
 * ••• menu, which opens the field here. Flat labels rather than folders (0061 says why), so a message never
 * moves. `done` puts focus back on that menu when the field or a chip goes away, rather than on `<body>`.
 */
function Labels({ message, onFilter, adding, setAdding, done }: {
  message: MessageRow;
  onFilter: (label: string) => void;
  adding: boolean;
  setAdding: (adding: boolean) => void;
  done: () => void;
}) {
  const queryClient = useQueryClient();
  const [labels, setLabelsShown] = useState<string[]>(() => labelsOf(message));
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // The labels route takes standing content read, exactly what `standing_content` reports.
  const may = message.standing_content === 1 && message.message_id !== null;

  useEffect(() => {
    if (adding) field.current?.focus();
  }, [adding]);

  async function change(delta: { add?: string[]; remove?: string[] }) {
    // Unreachable past `may`, which already requires the id; it is here for the type, and `mutants` says so too.
    if (message.message_id === null) return;
    setProblem(null);
    const outcome = await setLabels(message.message_id, delta).catch((error: unknown) => ({
      ok: false as const, message: `This Node could not be reached (${(error as Error).message}).`,
    }));
    if (!outcome.ok) {
      setProblem(outcome.message);
      return;
    }
    setLabelsShown(outcome.labels);
    setDraft("");
    setAdding(false);
    done();
    await queryClient.invalidateQueries({ queryKey: ["messages"] });
  }

  if (labels.length === 0 && !adding) return null;
  return (
    <div className="reader-labels">
      {labels.map((label) => (
        <span key={label} className="chip chip-label">
          <button type="button" className="linkish" onClick={() => onFilter(label)} title={`Show mail labelled ${label}`}>
            {label}
          </button>
          {may ? (
            <button type="button" className="chip-remove" aria-label={`Remove label ${label}`} onClick={() => void change({ remove: [label] })}>
              ×
            </button>
          ) : null}
        </span>
      ))}
      {may && adding ? (
        <input
          ref={field}
          className="label-add"
          aria-label="Add a label"
          // What to type and how to finish, visibly: opened from the menu, the field stands alone (WCAG 3.3.2).
          placeholder="Label, then Enter"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setAdding(false);
              setDraft("");
              setProblem(null);
              done();
            }
            if (event.key === "Enter" && draft.trim() !== "") {
              event.preventDefault();
              void change({ add: [draft] });
            }
          }}
        />
      ) : null}
      {problem === null ? null : <span className="bad" role="alert"> {problem}</span>}
    </div>
  );
}

/**
 * The rest of the conversation, around the message being read (#30's other half).
 *
 * Every other message in the conversation this reader may see, and every send that replied into it, in
 * time order, each folded to a line until opened. The message being read is not repeated here: it is the
 * pane above, with its headers and its body, and this is what came before and after it. Nothing is guessed
 * about grouping — the conversation is the sender's own root, and a message with none is a thread of one.
 */
export function Thread({ conversationId, current }: { conversationId: string | null; current: string }) {
  const thread = useThread(conversationId);
  const [open, setOpen] = useState<string | null>(null);
  if (conversationId === null || !thread.isSuccess) return null;
  const items: Array<{ key: string; at: string; message?: MessageRow; send?: SendRow }> = [
    ...thread.data.messages.filter((one) => one.id !== current).map((one) => ({ key: one.id, at: one.accepted_at, message: one })),
    ...thread.data.sends.map((one) => ({ key: one.id, at: one.state_at, send: one })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (items.length === 0) return null;
  return (
    <section className="thread" aria-label="Conversation">
      <h3>{items.length} other message{items.length === 1 ? "" : "s"} in this conversation</h3>
      <ul className="thread-list">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className="thread-row"
              aria-expanded={open === item.key}
              onClick={() => setOpen(open === item.key ? null : item.key)}
            >
              {/* The address as the title, as in the list: the name is whatever the sender typed (ADR 45). */}
              <span className="row-sender"
                title={item.message !== undefined ? item.message.from_addr ?? item.message.envelope_from : undefined}>
                {item.message !== undefined
                  ? item.message.from_name ?? item.message.from_addr ?? item.message.envelope_from
                  : `→ ${item.send!.envelope_to}`}
              </span>
              <time className="row-time" dateTime={item.at} title={fullTime(item.at)}>{shortTime(item.at)}</time>
              <span className="row-subject">
                {item.message !== undefined ? item.message.subject ?? "(no subject)" : item.send!.subject}
                {/* A send's own state word, never "sent": `handed_over` is as far as this Node can know. */}
                {item.send !== undefined ? ` · a send from this Node, ${item.send.state}` : null}
              </span>
            </button>
            {open === item.key && item.message !== undefined ? <MessageBody id={item.message.id} /> : null}
            {open === item.key && item.send !== undefined ? (
              <p className="notice dim">
                A send from this Node. Its bytes are in the outbox
                {item.send.has_submitted === 1 ? (
                  <>: <a className="mono" href={`/api/sends/${encodeURIComponent(item.send.id)}/submitted`}>.eml</a></>
                ) : null}.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The subject, or the words for its absence: a header parse failure stores "" (`src/materialise.ts`). */
export function subjectOf(message: { subject: string | null }): string {
  return message.subject === null || message.subject.trim() === "" ? "(no subject)" : message.subject;
}

export function ReadingPane({
  message, sendable, mailboxName, onReply, onForward, onMove, onMarkRead, onFilterLabel, notice, nextSteps, back,
}: {
  message: MessageRow;
  /** Whether this reader holds `send.propose` on the delivery's mailbox; null while that is not yet known. */
  sendable: boolean | null;
  /** The delivery's mailbox by name, for the sentence that says which authority Reply needs. */
  mailboxName: string;
  onReply: (all: boolean) => void;
  onForward: () => void;
  onMove: (to: Place) => void;
  onMarkRead: (read: boolean) => void;
  onFilterLabel: (label: string) => void;
  /** The collision notice, rendered directly after the actions it answers. */
  notice: React.ReactNode;
  nextSteps: React.ReactNode;
  /** The single-pane layout's way back to the list. */
  back: { label: string; run: () => void } | null;
}) {
  const body = useBody(message.id);
  const [headers, setHeaders] = useState(false);
  const headersOpener = useRef<HTMLElement | null>(null);
  const showHeaders = (opener: HTMLElement | null) => {
    headersOpener.current = opener;
    setHeaders(true);
  };
  const [labelling, setLabelling] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  /** Back to the ••• menu that offers "Add label…", once the label field or a label chip is gone. */
  const toMenu = () => actions.current?.querySelector<HTMLElement>("[aria-haspopup=menu]")?.focus();

  /*
   * Below 768px the list hides as this pane opens, taking the focused row with it, so focus would fall to
   * `<body>`. The subject takes it instead: the message is announced, and Tab goes on into it. Once per
   * opened message (the pane is keyed by id), and only in the single-pane layout, where `back` exists; side by
   * side, focus stays on the row (J/K).
   */
  const subject = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (back !== null) subject.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Opening a message marks it read (0062), once per open and without a listing refetch (D13, R19).
   *
   * Once: the ref, not `message.read`, decides, so "Mark unread" is not undone by the effect re-running on the
   * row it just changed. Without a refetch: the Inbox patches the cached rows, because a refetch after every
   * open is one more listing — and for a supervised reader one more `supervised.query` entry. A reader without
   * standing content read makes no request at all: the Node would refuse it.
   */
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (opened.current === message.id) return;
    opened.current = message.id;
    if (message.read === 1 || message.message_id === null || message.standing_content === 0) return;
    onMarkRead(true);
  }, [message.id, message.message_id, message.read, message.standing_content, onMarkRead]);

  const may = message.standing_content === 1 && message.message_id !== null;
  // Three groups: this message's state (read, labels), where it lives, and the original.
  const items: MenuItem[] = [];
  if (may) {
    items.push({ label: message.read === 1 ? "Mark unread" : "Mark read", onSelect: () => onMarkRead(message.read !== 1) });
    items.push({ label: "Add label…", onSelect: () => setLabelling(true) });
    const places: MenuItem[] = [];
    if (message.place !== "archive") places.push({ label: "Archive", onSelect: () => onMove("archive") });
    if (message.place !== "inbox") places.push({ label: "Move to Inbox", onSelect: () => onMove("inbox") });
    if (message.place !== "trash") places.push({ label: "Move to Trash", onSelect: () => onMove("trash") });
    items.push(...places.map((item, index) => (index === 0 ? { ...item, startsGroup: true } : item)));
  }
  // From the menu, focus has already gone back to its trigger, which is where it should return.
  if (body.isSuccess) items.push({ label: "View headers", startsGroup: true, onSelect: () => showHeaders(document.activeElement as HTMLElement | null) });
  items.push({ label: "Download original", startsGroup: !body.isSuccess, href: rawHref(message.id), note: "Recorded as an export." });

  const address = message.from_addr ?? message.envelope_from;
  return (
    <article className="reading-pane" aria-label="Message">
      {back === null ? null : (
        <>
          {/* The list's h1 is hidden with the list below 768px; the screen keeps its name. */}
          <h1 className="visually-hidden">{back.label}</h1>
          {/* Named for where it goes: "Inbox" alone is also the sidebar's link. The visible text is in the name. */}
          <button type="button" className="btn btn-ghost reader-back" aria-label={`Back to ${back.label}`} onClick={back.run}>
            <Icon name="back" /> {back.label}
          </button>
        </>
      )}
      {/* h2, not h1: the screen's heading is the list's, and a message is a section inside it. */}
      <h2 ref={subject} className="reader-subject" tabIndex={back === null ? undefined : -1}>{subjectOf(message)}</h2>
      <div className="reader-sender">
        {/* The name beside the address, never instead of it: a display name is whatever the sender typed. */}
        {message.from_name === null ? <span className="sender-name">{address}</span> : (
          <>
            <span className="sender-name">{message.from_name}</span>{" "}
            <address className="sender-addr">&lt;{address}&gt;</address>
          </>
        )}
        <time className="reader-time" dateTime={message.accepted_at} title={fullTime(message.accepted_at)}>
          {shortTime(message.accepted_at)}
        </time>
      </div>
      <div className="reader-meta">
        <Details message={message} body={body.data} onHeaders={showHeaders} />
        <Labels key={message.id} message={message} onFilter={onFilterLabel} adding={labelling} setAdding={setLabelling} done={toMenu} />
      </div>
      {message.auth_dmarc === "fail" ? (
        <p className="auth-alert" role="alert"><Authenticated message={message} evidence /></p>
      ) : null}
      {message.parse_error === null ? null : (
        <p className="notice dim">
          Headers were only partly readable: {message.parse_error}. The original is unchanged.
        </p>
      )}
      <div ref={actions} className="reader-actions" role="group" aria-label="Message actions">
        {sendable === true ? (
          <>
            <button type="button" className="btn" onClick={() => onReply(false)}><Icon name="reply" /> Reply</button>
            <button type="button" className="btn" onClick={() => onReply(true)}><Icon name="reply-all" /> Reply all</button>
            {/* A forward carries the original whole, so it needs no claim on the case: nothing is answered. */}
            <button type="button" className="btn" onClick={onForward}><Icon name="forward" /> Forward</button>
            <Assign message={message} />
          </>
        ) : null}
        <Menu label="More actions" face={<Icon name="more" />} items={items} />
      </div>
      {sendable === false ? (
        <p className="reader-note">Replying from {mailboxName} needs send.propose on it, which you do not hold.</p>
      ) : null}
      {notice}
      {nextSteps}
      <MessageBody id={message.id} />
      {headers ? <HeadersDialog receiptId={message.id} opener={headersOpener} onClose={() => setHeaders(false)} /> : null}
    </article>
  );
}
