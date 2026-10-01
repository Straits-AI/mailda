import { BODY_SCRIPTS, oneOf, type AttachmentVerdict, type BodyScript, type LinkVerdict } from "@mailda/contract/schemas";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { current, t } from "/app/locale.js";
import { apiFetch } from "/app/session.js";
import { currentTheme, type ThemeChoice } from "/app/theme.js";

import type { Text } from "../../../i18n/format.ts";
import type { Locale } from "../../../i18n/locales.ts";
import { Nothing } from "../chrome.tsx";
import {
  type MessageRow, type Place, type SendRow, assignCase, labelsOf, setLabels, stealCase, useCases, useMe,
  useMessageHeaders, useThread,
} from "../api.ts";
import { sendStateWords, shown } from "../delivery-words.ts";
import { fullTime, shortTime } from "../format.ts";
import { NodeWords, marked, sentence } from "../words.tsx";
import { useToast } from "../shell-context.tsx";
import { Icon } from "../ui/icons.tsx";
import { isComposingKey } from "../ui/ime.ts";
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
  /** The four states `src/render/body.ts` distinguishes (Blueprint §5C). */
  state: "html" | "text-only" | "no-body" | "unparsed";
  html: string | null;
  text: string | null;
  blockedRemote: number;
  truncated: boolean;
  problem: string | null;
  attachments: Array<{
    filename: string | null;
    declaredType: string;
    bytes: number;
    verdict: AttachmentVerdict;
  }>;
  links: Array<{ href: string; text: string; verdict: LinkVerdict }>;
  recipients: { to: string[]; cc: string[]; replyTo: string | null };
  /**
   * The script the message is written in, where the message says (`src/render/script.ts`); absent from an older
   * Node, and possibly a script a newer Node knows and this client does not, so it is narrowed before use
   * (`bodyScriptOf`).
   */
  script?: string | null;
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
      if (!response.ok) throw new Error(t("reader.body.unreadable", { status: response.status }));
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
 * The start of the frame's document: the viewer's theme and the message's script on the frame's own `<html>`,
 * and the frame's sheet.
 *
 * The frame is opaque-origin and cannot see the shell's `<html>`, so it is told on its own, and
 * `frameStylesheet()` in `src/theme.ts` matches `:root[data-theme=…]` and `html[data-script=…]` there. `theme` is
 * one of three words by type, and `currentTheme()` checks the attribute it reads against them; `script` is one of
 * the contract's `BODY_SCRIPTS` by type. A sender cannot override either: the sanitiser keeps only `lang` and
 * `dir` on `<html>` (`src/render/body.ts`), and a later `<html>` start tag only adds attributes the element
 * lacks, so a sender's `lang` does reach the frame and nothing else of theirs does. The doctype first keeps the
 * frame in standards mode; a sender's own doctype then parses as an ignored duplicate.
 *
 * Never the interface's `lang`: the frame is the sender's (ADR 46). `script` only picks the glyph forms Han is
 * drawn in, which the message decides where it says (`bodyScript`), and the viewer's locale only where it does not.
 */
export function frameHead(theme: ThemeChoice, script: BodyScript | null): string {
  const scripted = script === null ? "" : ` data-script="${script}"`;
  return `<!doctype html><html data-theme="${theme}"${scripted}><link rel="stylesheet" href="/app/frame.css">`;
}

/**
 * The glyph forms each interface locale reads Han in, for a message that does not say its own (critic M9): the
 * one guess left once the charset and `Content-Language` are silent, and a better one than the platform's
 * default, which draws a UTF-8 Chinese message in Japanese forms on some systems. English guesses nothing.
 */
const VIEWER_SCRIPT: Readonly<Record<Locale, BodyScript | null>> = { en: null, "zh-Hans": "sc" };

/** The body's script: the message's own where it names one this client knows, else the viewer's guess. */
function bodyScriptOf(rendered: RenderedBody): BodyScript | null {
  return oneOf(BODY_SCRIPTS, rendered.script) ? rendered.script : VIEWER_SCRIPT[current().locale];
}

/** The original, as it arrived. A download is recorded as an export, and the route decides who may. */
export function rawHref(receiptId: string): string {
  return `/api/messages/${encodeURIComponent(receiptId)}/raw`;
}

/**
 * The links worth a word, with where each really goes. Nothing is rewritten in the body — the sender's
 * href is what a click follows — so this is the comparison a hover cannot make, stated once, above the body.
 */
function Links({ links }: { links: RenderedBody["links"] }) {
  type Flagged = RenderedBody["links"][number] & { verdict: Exclude<LinkVerdict, "plain"> };
  const flagged = links.filter((one): one is Flagged => one.verdict !== "plain");
  if (flagged.length === 0) return null;
  return (
    <div className="notice bad" role="alert">
      <p>{links.length === 1 ? t("reader.links.flaggedOfOne") : t("reader.links.flagged", { n: flagged.length, total: links.length })}</p>
      <ul className="links-flagged">
        {flagged.map((one, index) => (
          <li key={index}>
            {sentence(`reader.link.${one.verdict}`, {
              text: <span className="mono">{one.text === "" ? t("reader.links.image") : one.text}</span>,
              href: <span className="mono dim">{one.href}</span>,
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What an attachment's verdict means, in words, or null for a plain file. Also said by the composer, so a file is
 * described the same way both ways.
 */
export function verdictWords(verdict: AttachmentVerdict): Text | null {
  return verdict === "plain" ? null : t(`reader.verdict.${verdict}`);
}

/**
 * What was attached, named and judged, with no way to open it from here: the bytes stay in the original,
 * which the raw download carries whole. A verdict is a word a person can check against the file, not a scan.
 */
function Attachments({ parts, receiptId }: { parts: RenderedBody["attachments"]; receiptId: string }) {
  if (parts.length === 0) return null;
  return (
    <ul className="attachments" aria-label={t("reader.attachments")}>
      {parts.map((part, index) => {
        const word = verdictWords(part.verdict);
        return (
          <li key={index}>
            {/* A link to the part's own bytes; the Node serves a flagged one as octet-stream, to save and not run. */}
            <a className="mono" href={`/api/messages/${encodeURIComponent(receiptId)}/attachments/${index}`}>
              {part.filename ?? t("reader.attachment.unnamed")}
            </a>{" "}
            <span className="dim">{t("reader.attachment.size", { type: part.declaredType, kb: Math.max(1, Math.round(part.bytes / 1024)) })}</span>
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
  if (body.isError) return <Nothing kind="failed" detail={marked(body.error)} />;

  const rendered = body.data;

  if (rendered.state === "unparsed") {
    return (
      <Nothing
        kind="failed"
        detail={rendered.problem === null ? t("reader.body.unparsed") : <NodeWords>{rendered.problem}</NodeWords>}
      />
    );
  }

  return (
    <>
      {rendered.blockedRemote > 0 ? (
        <p className="notice dim">{t("reader.body.remote", { n: rendered.blockedRemote })}</p>
      ) : null}
      {rendered.truncated ? <p className="notice dim">{t("reader.body.truncated")}</p> : null}
      <Attachments parts={rendered.attachments} receiptId={id} />
      <Links links={rendered.links} />
      {rendered.state === "html" && rendered.html !== null ? (
        <iframe
          ref={frame}
          className="message-body"
          title={t("reader.body.frame")}
          data-focused={frameFocused ? "" : undefined}
          // Neither allow-scripts nor allow-same-origin. See the header — this is the trust boundary.
          sandbox=""
          referrerPolicy="no-referrer"
          // Read when the frame renders. The theme changes only on /settings, where no reader is mounted.
          srcDoc={frameHead(currentTheme(), bodyScriptOf(rendered)) + rendered.html}
        />
      ) : (
        // The sender's text, in the shell's document: `lang=""` so it does not claim the interface's language
        // (ADR 46), and the message's script, as the frame has, so its Han is drawn in the message's forms
        // (`.message-text[data-script]` in `src/shell-css.ts`, from the frame's own table).
        <pre className="message-text" lang="" data-script={bodyScriptOf(rendered) ?? undefined}>{rendered.text ?? ""}</pre>
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
 * `evidence` adds the parenthesis to a `fail`, the one verdict shown outside the details; the details line states
 * the three results before the sentence already. The results are the protocol's own tokens, in every locale.
 */
function Authenticated({ message, evidence }: { message: MessageRow; evidence: boolean }) {
  const domain = <span className="mono">{message.auth_from_domain ?? t("reader.auth.fromDomain")}</span>;
  if (message.auth_dmarc === null) return <>{t("reader.auth.unevaluated")}</>;
  if (message.auth_dmarc === "absent") return <>{t("reader.auth.absent")}</>;
  if (message.auth_dmarc === "pass") return <>{sentence("reader.auth.pass", { domain })}</>;
  if (message.auth_dmarc !== "fail") return <>{sentence("reader.auth.noPolicy", { domain })}</>;
  const notTheirs = <span className="bad">{t("reader.auth.notTheirs")}</span>;
  if (!evidence) return <>{sentence("reader.auth.fail", { domain, notTheirs })}</>;
  const results = { domain, notTheirs, spf: result(message.auth_spf), dkim: result(message.auth_dkim) };
  return message.auth_dmarc_policy === null
    ? <>{sentence("reader.auth.failEvidence", results)}</>
    : <>{sentence("reader.auth.failEvidencePolicy", { ...results, policy: message.auth_dmarc_policy })}</>;
}

/** An SPF or DKIM result as the header gave it, or the word for its absence. */
const result = (token: string | null): string => token ?? t("reader.auth.missing");

/** The details line: the three results, then what they add up to. */
function authLine(message: MessageRow) {
  if (message.auth_dmarc === null || message.auth_dmarc === "absent") return <Authenticated message={message} evidence={false} />;
  return sentence("reader.auth.line", {
    spf: result(message.auth_spf), dkim: result(message.auth_dkim), dmarc: message.auth_dmarc,
    verdict: <Authenticated message={message} evidence={false} />,
  });
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
      <summary className="reader-to">{t("reader.to", { address: message.envelope_to })} <Icon name="chevron-down" /></summary>
      <dl className="details-grid">
        <dt>{t("reader.details.from")}</dt>
        <dd>{message.from_name === null ? address : `${message.from_name} <${address}>`}</dd>
        <dt>{t("reader.details.to")}</dt>
        {/* The To header once the body has been read (it is content); the envelope's address until then. */}
        <dd>{to.length > 0 ? to.join(", ") : message.envelope_to}</dd>
        {cc.length > 0 ? <><dt>{t("reader.details.cc")}</dt><dd>{cc.join(", ")}</dd></> : null}
        {replyTo === null ? null : <><dt>{t("reader.details.replyTo")}</dt><dd>{replyTo}</dd></>}
        <dt>{t("reader.details.deliveredTo")}</dt>
        <dd>{message.envelope_to}</dd>
        {/* "Received": when this Node accepted it, the one time it observed itself. */}
        <dt>{t("reader.details.received")}</dt>
        <dd><time dateTime={message.accepted_at}>{fullTime(message.accepted_at)}</time></dd>
        <dt>{t("reader.details.authentication")}</dt>
        <dd>{authLine(message)}</dd>
        <dt>{t("reader.details.size")}</dt>
        <dd>{t("reader.details.bytes", { n: message.raw_bytes })}</dd>
      </dl>
      <div className="details-actions">
        {/* After the body: the headers route takes the body's authority, so a reader it refused is refused again. */}
        {body === undefined ? null : (
          <button type="button" className="btn" onClick={(event) => onHeaders(event.currentTarget)}><Icon name="headers" /> {t("reader.headers.view")}</button>
        )}
        {/*
          No `download` attribute: the route sends content-disposition itself, and without the attribute a
          `message.export` refusal opens as the Node's words instead of being saved as a file of error JSON.
        */}
        <a className="btn" href={rawHref(message.id)}><Icon name="download" /> {t("reader.original")}</a>
        <span className="details-note">{t("reader.original.recorded")}</span>
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
    <Modal className="headers-dialog" label={t("reader.headers")} onClose={onClose} returnTo={opener}>
      <header>
        <h2>{t("reader.headers")}</h2>
        <button type="button" className="btn btn-icon" aria-label={t("reader.headers.close")} onClick={onClose}><Icon name="close" /></button>
      </header>
      {headers.isPending ? <Nothing kind="loading" /> : headers.isError ? <Nothing kind="failed" detail={marked(headers.error)} /> : (
        <>
          {headers.data.truncated ? (
            <p className="headers-note">
              {sentence("reader.headers.truncated", { n: headers.data.limit_bytes, budget: <code>mime.max_header_bytes</code> })}
            </p>
          ) : null}
          {/*
            A named region in the Tab order, as the notices band: a real header block (a relay chain, DKIM, ARC) is
            taller than the dialog, and a browser that does not focus a scroller by itself (WebKit) left a keyboard
            no way to read past the first screen of it (R2AXE-1). ARIA names no bare `<pre>`, hence the role.
          */}
          <pre className="headers-text" tabIndex={0} role="region" aria-label={t("reader.headers.block")}>{headers.data.headers}</pre>
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
  const [problem, setProblem] = useState<React.ReactNode>(null);
  const unreachable = (error: unknown) => setProblem(sentence("inbox.unreachable", { problem: marked(error as Error) }));

  if (caseId === null) return <p>{t("reader.assign.noCase")}</p>;
  if (cases.isPending || me.isPending) return <Nothing kind="loading" />;
  if (cases.isError) return <Nothing kind="failed" detail={marked(cases.error)} />;
  if (me.isError) return <Nothing kind="failed" detail={marked(me.error)} />;
  const listed = cases.data.cases.find((one) => one.id === caseId);
  if (listed === undefined) return <p>{t("reader.assign.closed")}</p>;
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
          {listed.claimed_at === null
            ? t("reader.assign.heldUnrecorded", { who: listed.assignee_email ?? t("reader.assign.colleague") })
            : t("reader.assign.held", { who: listed.assignee_email ?? t("reader.assign.colleague"), when: fullTime(listed.claimed_at) })}{" "}
          <button
            type="button"
            className="linkish"
            onClick={() => void (async () => {
              setProblem(null);
              const taken = await stealCase(caseId);
              if (!taken.ok) {
                setProblem(marked(taken));
                return;
              }
              setStolen(true);
              await refresh();
            })().catch(unreachable)}
          >
            {t("inbox.takeAnyway")}
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
              setProblem(marked(outcome));
              return;
            }
            onDone();
            toast({ text: t("reader.assign.handed", { email }) });
            await refresh();
          })().catch(unreachable);
        }}
      >
        <label htmlFor="assign-email">{t("reader.assign.email")}</label>
        <input id="assign-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <button type="submit" className="primary">{t("reader.assign.handOver")}</button>
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
        <Icon name="assign" /> {t("reader.assign")}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label={t("reader.assign")} className="assign-popover popover-down popover-start" anchor={anchor}>
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
  const [problem, setProblem] = useState<React.ReactNode>(null);
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
      ok: false as const, unreachable: error as Error,
    }));
    if (!outcome.ok) {
      setProblem("unreachable" in outcome
        ? sentence("inbox.unreachable", { problem: marked(outcome.unreachable) })
        : marked(outcome));
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
          <button type="button" className="linkish" onClick={() => onFilter(label)} title={t("reader.label.show", { label })}>
            {label}
          </button>
          {may ? (
            <button type="button" className="chip-remove" aria-label={t("reader.label.remove", { label })} onClick={() => void change({ remove: [label] })}>
              ×
            </button>
          ) : null}
        </span>
      ))}
      {may && adding ? (
        <input
          ref={field}
          className="label-add"
          aria-label={t("reader.label.field")}
          // What to type and how to finish, visibly: opened from the menu, the field stands alone (WCAG 3.3.2).
          placeholder={t("reader.label.hint")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // The IME's own Enter commits a candidate, and its Escape cancels one: neither is meant for the field.
            if (isComposingKey(event.nativeEvent)) return;
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
    <section className="thread" aria-label={t("reader.thread")}>
      <h3>{t("reader.thread.count", { n: items.length })}</h3>
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
                {item.message !== undefined ? item.message.subject ?? t("reader.noSubject") : item.send!.subject}
                {/* A send's own state word, never "sent": `handed_over` is as far as this Node can know. */}
                {item.send !== undefined ? sentence("reader.thread.send", { state: shown(sendStateWords(item.send.state)) }) : null}
              </span>
            </button>
            {open === item.key && item.message !== undefined ? <MessageBody id={item.message.id} /> : null}
            {open === item.key && item.send !== undefined ? (
              <p className="notice dim">
                {item.send.has_submitted === 1
                  ? sentence("reader.thread.sendBytesAt", {
                    link: <a className="mono" href={`/api/sends/${encodeURIComponent(item.send.id)}/submitted`}>.eml</a>,
                  })
                  : t("reader.thread.sendBytes")}
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
  return message.subject === null || message.subject.trim() === "" ? t("reader.noSubject") : message.subject;
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
    items.push({ label: message.read === 1 ? t("inbox.act.unread") : t("inbox.act.read"), onSelect: () => onMarkRead(message.read !== 1) });
    items.push({ label: t("reader.label.add"), onSelect: () => setLabelling(true) });
    const places: MenuItem[] = [];
    if (message.place !== "archive") places.push({ label: t("inbox.act.archive"), onSelect: () => onMove("archive") });
    if (message.place !== "inbox") places.push({ label: t("reader.act.toInbox"), onSelect: () => onMove("inbox") });
    if (message.place !== "trash") places.push({ label: t("inbox.act.trash"), onSelect: () => onMove("trash") });
    items.push(...places.map((item, index) => (index === 0 ? { ...item, startsGroup: true } : item)));
  }
  // From the menu, focus has already gone back to its trigger, which is where it should return.
  if (body.isSuccess) items.push({ label: t("reader.headers.view"), startsGroup: true, onSelect: () => showHeaders(document.activeElement as HTMLElement | null) });
  items.push({ label: t("reader.original"), startsGroup: !body.isSuccess, href: rawHref(message.id), note: t("reader.original.note") });

  const address = message.from_addr ?? message.envelope_from;
  return (
    <article className="reading-pane" aria-label={t("reader.pane")}>
      {back === null ? null : (
        <>
          {/* The list's h1 is hidden with the list below 768px; the screen keeps its name. */}
          <h1 className="visually-hidden">{back.label}</h1>
          {/* Named for where it goes: "Inbox" alone is also the sidebar's link. The visible text is in the name. */}
          <button type="button" className="btn btn-ghost reader-back" aria-label={t("reader.back", { place: back.label })} onClick={back.run}>
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
          {sentence("reader.partlyReadable", { problem: <NodeWords>{message.parse_error}</NodeWords> })}
        </p>
      )}
      <div ref={actions} className="reader-actions" role="group" aria-label={t("reader.actions")}>
        {sendable === true ? (
          <>
            <button type="button" className="btn" onClick={() => onReply(false)}><Icon name="reply" /> {t("inbox.act.reply")}</button>
            <button type="button" className="btn" onClick={() => onReply(true)}><Icon name="reply-all" /> {t("inbox.act.replyAll")}</button>
            {/* A forward carries the original whole, so it needs no claim on the case: nothing is answered. */}
            <button type="button" className="btn" onClick={onForward}><Icon name="forward" /> {t("inbox.act.forward")}</button>
            <Assign message={message} />
          </>
        ) : null}
        <Menu label={t("reader.more")} face={<Icon name="more" />} items={items} />
      </div>
      {sendable === false ? (
        <p className="reader-note">{t("inbox.withheld.reply", { mailbox: mailboxName })}</p>
      ) : null}
      {notice}
      {nextSteps}
      <MessageBody id={message.id} />
      {headers ? <HeadersDialog receiptId={message.id} opener={headersOpener} onClose={() => setHeaders(false)} /> : null}
    </article>
  );
}
