import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { apiFetch } from "/app/session.js";
import { CONFIG } from "/app/config.js";

import { claimCase, stealCase, useMailboxes } from "../api.ts";
import { splitAddresses } from "./split-addresses.ts";
import { classifyAttachment, DANGEROUS, encodedBytes } from "../../../attachments.ts";
import type { AttachmentVerdict } from "@mailda/contract/schemas";
import { VERDICT_WORDS } from "./reader.tsx";

/**
 * The docked composer — the reason ADR 30 put React at this layer.
 *
 * ## Why it is docked rather than a route
 *
 * Variant A's compose-as-route was rejected on a product ground, not a taste one: a route unmounts with
 * navigation, and a reply is often written while checking something elsewhere. So the composer is one dock in
 * the shell. Over a mail screen it takes the whole reader column (never the list), and its head names the
 * message it answers, because the reader it covers is where that was said; the quote in the body carries the
 * PO number or container reference a reply to invoice or shipment mail exists to repeat.
 *
 * ## The three draft phases, and why the middle one exists now
 *
 * #32 named them, worded about where the bytes are:
 *
 *   this browser only · a reload loses it  →  saved on your node  →  sealed · immutable · stoppable for Ns
 *
 * The middle one was absent on purpose when this shell first shipped, because nothing saved a draft on the
 * Node and a label claiming durability that did not exist would be the interface lying about where
 * somebody's writing is. `0012_drafts.sql` is what earns it. The phase now reflects an actual round trip
 * that committed, not an optimistic assumption that one will.
 *
 * The wording still refuses to overstate: after a save it says when, because "saved" with no time is the
 * kind of reassurance people stop believing the first time it is wrong.
 *
 * ## From is the mailbox
 *
 * ADR 36: the send goes out as the mailbox, and who wrote it is recorded without travelling with the
 * message. A person's name in the From line would tell every correspondent who works here.
 */

/**
 * The hold window, from the receipt-generated budget by way of `/app/config.js`. Never a literal.
 *
 * It used to arrive on `window.MAILDA_CONFIG`, set by an inline `<script>` in the served document, and #97
 * removed that script: an inline one is what makes a CSP decorative. The same two values now ship as a
 * same-origin ES module, so this reads them from an import instead of off the window — and the `?? 15`
 * went with the global, a literal standing in for a budget inside the function whose comment said never a
 * literal, live for exactly as long as a `window` property might have been absent.
 *
 * ## Why through the served module rather than `import { BUDGETS } from "@mailda/budgets"`
 *
 * That was the first shape and it is the obvious one — this screen *is* bundled by esbuild from this
 * repository, so the generated module is genuinely in scope. It was measured and withdrawn. Pulling
 * `BUDGETS` in for one integer put the whole 218-entry table in the shell bundle: **+7,960 bytes raw,
 * +2,783 gzip** (`pnpm --filter @mailda/worker run build:client`, before and after), against a receipt
 * whose whole subject is what this bundle costs a person waiting for it. It also gave the browser two
 * channels for receipt-derived numbers — one baked in at build, one served at runtime — which is two
 * places to look when a number in the interface disagrees with the Node.
 *
 * So there is one channel: `/app/config.js` carries every figure the browser needs, whether the reader is
 * bundled or not, and `test/security-headers.test.ts` asserts each field against the budget it came from.
 */
function holdWindowSeconds(): number {
  return CONFIG.holdWindowSeconds;
}

/**
 * How long the composer waits after the last keystroke before saving.
 *
 * Not a receipt value: it is a interaction choice rather than a measurement of anything, and inventing a
 * receipt for it would dilute what a receipt means. Long enough that ordinary typing produces one write per
 * pause rather than one per word.
 *
 * It deliberately no longer claims to be "short enough that a person who types a sentence and closes the
 * laptop has it". That was never true of any value — it was the debounce being asked to cover for a close
 * path that threw the pending write away (#90) — and closing is now safe at every value of this constant,
 * which is what makes it free to be an interaction choice rather than a safety margin.
 */
const AUTOSAVE_IDLE_MS = 1_500;

export interface ComposerContext {
  mailboxId: string;
  inReplyToMessageId?: string;
  /** The message this send forwards, whole: its bytes go out as a `message/rfc822` part (0059). */
  forwardOfMessageId?: string;
  /** A draft to resume by id — a new-message draft from the drafts list, which no reply keys. */
  draftId?: string;
  /**
   * The case this reply answers, claimed by `reply()` before the composer opened. When present the send claims
   * it again immediately before sealing (a claim is idempotent for its holder), so a case released or taken
   * while this was being written stops the send and names the holder (#42).
   */
  caseId?: string;
  /**
   * The subject of the message this answers or forwards, as the reader showed it. The dock covers the reader
   * column, so its head says what the reply is about; absent (a new message, a draft resumed from its list),
   * the head says nothing it does not know.
   */
  originalSubject?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  bodyUnavailable?: "missing" | "unreadable" | null;
}

interface DraftResponse {
  draft: {
    id: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    /** Why `body` is empty when the row says it should not be — see `drafts.ts` (#143). */
    bodyUnavailable?: "missing" | "unreadable" | null;
    updatedAt: string;
  } | null;
}

/**
 * What the shell may ask of the open composer (`shell-context.tsx`): which draft it is writing, so reopening that
 * draft from `/drafts` keeps the dock rather than reloading it, and to save now, so signing out does not end the
 * session under words typed in the autosave pause.
 */
export interface ComposerHandle {
  /** The draft's id once the Node has one; a new message has none until its first save. */
  draftId(): string | null;
  /** Everything on screen onto the Node. Null once it is there, or the Node's words for why it is not. */
  save(): Promise<string | null>;
  /**
   * Whether Seal and send is running, from the claim before it to the Node's answer. The shell keeps this dock while
   * it is: replaced, its refusal would land on a component nobody can see.
   */
  sealing(): boolean;
}

/** Where the bytes are. Three states, and none of them claims more than happened. */
type Phase =
  | { kind: "empty" }
  | { kind: "browser" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "failed"; why: string };

function phaseText(phase: Phase): string {
  switch (phase.kind) {
    case "empty":
      return "empty draft";
    case "browser":
      return "this browser only · a reload loses it";
    case "saving":
      return "saving to your node…";
    case "saved":
      return `saved on your node · ${new Date(phase.at).toLocaleTimeString(undefined, { hour12: false })}`;
    case "failed":
      // The failure has to be louder than the success it replaces. A draft that silently stopped saving is
      // worse than one that never saved, because the first version taught the person to trust it.
      return `not saved — ${phase.why}`;
  }
}

export function Composer({ context, onClose, ref }: {
  context: ComposerContext;
  onClose: () => void;
  ref?: React.Ref<ComposerHandle>;
}) {
  const [to, setTo] = useState(context.to ?? "");
  // Cc and Bcc: the seal and the draft have taken both for months (the 17 September coverage audit); the
  // interface offered one To. Shown folded unless something is in them, so a plain reply stays a plain form.
  const [cc, setCc] = useState(context.cc ?? "");
  const [bcc, setBcc] = useState("");
  const [showCopies, setShowCopies] = useState((context.cc ?? "") !== "");
  const [subject, setSubject] = useState(context.subject ?? "");
  const [body, setBody] = useState(context.body ?? "");
  /*
   * Files attached in this session, held in the browser until the seal (0060). Not part of the draft: a
   * draft is text the Node keeps so writing survives a closed tab, and a file the author still has on disk
   * is not writing. The list says so beside the control.
   * ponytail: attachments are lost with the tab; carry them on the draft if that turns out to matter.
   */
  const [files, setFiles] = useState<Attached[]>([]);
  /** Files the author will send although this Node judges them dangerous: what the warning names. */
  const flagged = files.filter(({ verdict }) => verdict !== null && DANGEROUS.has(verdict));
  /**
   * The budget in the sizes a person sees, and what the attached files use of it: their own sizes, the figure
   * beside each file. Whether they fit is counted as the seal counts it, at base64 size, padding and all.
   */
  const rawBudget = Math.floor(CONFIG.attachmentBudgetBytes * 3 / 4);
  const usedRaw = files.reduce((n, { file }) => n + file.size, 0);
  const usedEncoded = files.reduce((n, { file }) => n + encodedBytes(file.size), 0);
  const overBudget = usedEncoded > CONFIG.attachmentBudgetBytes;
  const overCount = files.length > CONFIG.maxAttachments;
  /** How many are still being read to be judged: sent now, a dangerous one would leave without its warning or flag. */
  const checking = files.filter((one) => one.judging).length;
  /** Could not be read here, so the send, which reads the same bytes, cannot carry it either. */
  const unreadable = files.filter(({ unread }) => unread !== null).length;
  /** Every reason the attachments stop a send. Both send buttons obey it, and the limit line names each one. */
  const blocked = overBudget || overCount || checking > 0 || unreadable > 0;
  const [bodyUnavailable, setBodyUnavailable] = useState(context.bodyUnavailable ?? null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "empty" });
  const [sealing, setSealing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The Node's words when the claim at send found the case held by somebody else (#42). Separate from
   * `problem` because it carries a way through — take the case, audited, and send — which a refusal of the
   * seal itself does not.
   */
  const [held, setHeld] = useState<string | null>(null);
  /**
   * Which address this goes out as. Empty means "not chosen", which is only a problem when there is a choice
   * to make — the Node decides that, and its refusal names the addresses.
   */
  const [senderAddress, setSenderAddress] = useState("");
  const [resuming, setResuming] = useState(context.inReplyToMessageId !== undefined || context.draftId !== undefined);
  const queryClient = useQueryClient();
  /**
   * The addresses this mailbox may send as, from the rail's own query rather than a second endpoint — it is
   * already loaded and already bounded by the relation that decides whether this composer should exist.
   */
  const mailboxes = useMailboxes();
  const sendingBox = mailboxes.data?.mailboxes.find((box) => box.id === context.mailboxId);
  const senderOptions = (sendingBox?.addresses ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
  const navigate = useNavigate();
  const fromField = useRef<HTMLSelectElement>(null);
  const toField = useRef<HTMLInputElement>(null);
  const bodyField = useRef<HTMLTextAreaElement>(null);

  /**
   * Focus goes into the dock when it opens, and that is a keyboard-safety rule as much as a convenience.
   *
   * The Inbox answers single keys (R, A, E, J…) anywhere outside a field. A composer opened by R and left
   * unfocused would hand the next letter typed to the list: an "a" meant for the reply would claim and open a
   * reply-all instead. So a reply lands in its body with the caret **before** the quote, where the answer goes;
   * a forward or a new message lands on the first field it needs, the From choice when there is one.
   *
   * Once, on mount: the Shell keys the composer by context, so a different message is a new mount.
   */
  useEffect(() => {
    if (context.inReplyToMessageId !== undefined) {
      bodyField.current?.focus();
      bodyField.current?.setSelectionRange(0, 0);
      return;
    }
    (fromField.current ?? toField.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `latest` exists so the debounced save reads the values at the moment it fires rather than the ones
  // captured when the timer was set — otherwise the last keystroke before a pause is the one that is lost,
  // which is the single most annoying way for an autosave to be wrong.
  const latest = useRef({ to, cc, bcc, subject, body, draftId });
  latest.current = { to, cc, bcc, subject, body, draftId };

  /**
   * What the Node already has, so opening a draft does not re-save it.
   *
   * Found by looking at the screen: after a reload the phase read "saved on your node" with a timestamp
   * *later* than the one before the reload, because resuming set the fields, which looked like a change,
   * which scheduled a save. Two things wrong with that. It costs an R2 write every time somebody opens a
   * draft to read it — and worse, `updated_at` stops meaning "when you last changed this" and starts
   * meaning "when you last looked at it", which is a false statement in a label whose whole job is telling
   * people where their writing is.
   */
  const saved = useRef<{ to: string; cc: string; bcc: string; subject: string; body: string } | null>(null);

  /**
   * Resume the draft already in progress for this reply, if there is one.
   *
   * The server answers this in one call (`?inReplyTo=`) because the alternative is listing every draft and
   * choosing in the browser, which is a decision about somebody's unfinished work made in the wrong place.
   * A unique index guarantees at most one, so there is nothing to disambiguate.
   */
  useEffect(() => {
    if (context.inReplyToMessageId === undefined && context.draftId === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        // By the reply's parent, or — for a new-message draft opened from the list — by its own id.
        const response = await apiFetch(
          context.draftId !== undefined
            ? `/api/drafts/${encodeURIComponent(context.draftId)}`
            : `/api/drafts?inReplyTo=${encodeURIComponent(context.inReplyToMessageId!)}`,
        );
        if (!response.ok) return;
        const { draft } = (await response.json()) as DraftResponse;
        if (cancelled || draft === null) return;
        // The saved draft wins over the freshly-quoted template. Somebody's own words are worth more than a
        // quote block this code can regenerate at any time.
        setDraftId(draft.id);
        setTo(draft.to.join(", "));
        setCc(draft.cc.join(", "));
        setBcc(draft.bcc.join(", "));
        if (draft.cc.length > 0 || draft.bcc.length > 0) setShowCopies(true);
        setSubject(draft.subject);
        setBody(draft.body);
        /*
         * An empty body this Node could not read is not an empty draft (#143). Left unsaid, the composer
         * shows a blank box, and the ordinary response to a blank box is to type in it — which on the
         * server would replace an object that is intact and merely waiting for a key. The write refuses,
         * so nothing is lost either way; this is what stops somebody wasting the afternoon rewriting a
         * draft that is still there.
         */
        setBodyUnavailable(draft.bodyUnavailable ?? null);
        // Recorded as already-saved, so resuming is not mistaken for editing.
        saved.current = { to: draft.to.join(", "), cc: draft.cc.join(", "), bcc: draft.bcc.join(", "), subject: draft.subject, body: draft.body };
        setPhase({ kind: "saved", at: draft.updatedAt });
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context.inReplyToMessageId, context.draftId]);

  const touched = to !== "" || subject !== "" || body !== "";

  /**
   * Whichever write is in the air, so nothing ever starts a second one beside it.
   *
   * A ref rather than state: every reader wants the value at the moment they ask, and a re-render is not
   * only unnecessary but wrong — `flush` is called from a click handler and from an effect cleanup, and
   * neither can wait for React to tell it what it already needs to know.
   */
  const inFlight = useRef<Promise<boolean> | null>(null);
  /**
   * Set once this draft is being thrown away or sealed: from then on nothing may write it again.
   *
   * Discard and a successful seal both end in `onClose()`, which unmounts this dock, and the unmount flush
   * below then saw a reply that had never autosaved (or text typed inside the idle window) as unsaved and PUT a
   * **new** draft after the person had discarded or sent it. The next Reply on that message resumed it: a
   * discarded reply-all's Cc came back under R. Checked in `flush`, the one place every write passes through,
   * so the debounce timer and the unmount are both covered by one line. Close and Discard are disabled while a
   * seal is in the air, and anything else that asks for a write then waits for the seal's answer (`sealRun`).
   */
  const retired = useRef(false);
  /**
   * The seal in the air, resolving once the Node has answered it. A write asked for meanwhile (the dock taken
   * away, a sign-out) waits for it: sealed, `retired` stays set and there is nothing to write; refused, the words
   * are a draft again and are written like any others. Without the wait, `retired` answered "saved" for words
   * nothing had saved, and a refused seal lost them.
   */
  const sealRun = useRef<Promise<boolean> | null>(null);
  /** The Node's words for the last write that failed, which the phase label shows and `save` hands the shell. */
  const failure = useRef<string | null>(null);
  /** True while `close` is waiting for the Node, so the buttons cannot be pressed twice. */
  const [closing, setClosing] = useState(false);

  /** Whether the Node's copy is behind what is on screen. The one definition of "there is work to do". */
  function unsaved(): boolean {
    const now = latest.current;
    if (now.to === "" && now.cc === "" && now.bcc === "" && now.subject === "" && now.body === "") return false;
    const stored = saved.current;
    return stored === null
      || stored.to !== now.to || stored.cc !== now.cc || stored.bcc !== now.bcc
      || stored.subject !== now.subject || stored.body !== now.body;
  }

  /**
   * One write. Returns whether the Node now has what was sent.
   *
   * Extracted from the debounce timer it used to live inside, which is the substance of #90: a save that
   * only exists as a closure inside a `setTimeout` can only ever happen when that timer fires, so every
   * other path that needed the bytes on the Node — closing, discarding, sealing — had no way to ask for
   * one. The extraction is the fix; `close` awaiting it is just the call site.
   */
  async function writeDraft(): Promise<boolean> {
    const current = latest.current;
    setPhase({ kind: "saving" });
    try {
      const response = await apiFetch("/api/drafts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: current.draftId,
          mailboxId: context.mailboxId,
          inReplyToMessageId: context.inReplyToMessageId ?? null,
          to: splitAddresses(current.to),
          cc: splitAddresses(current.cc),
          bcc: splitAddresses(current.bcc),
          subject: current.subject,
          body: current.body,
        }),
      });
      if (!response.ok) {
        const refusal = (await response.json().catch(() => null)) as { message?: string } | null;
        return failed(refusal?.message ?? `this Node answered ${response.status}`);
      }
      const { draft } = (await response.json()) as DraftResponse;
      if (draft === null) return failed("this Node answered without a draft");
      setDraftId(draft.id);
      /*
       * Into the ref as well as into state, and this is load-bearing rather than belt-and-braces.
       *
       * `discard` and `seal` both await an in-flight write and then need the id it created. State gets
       * there via a re-render, and neither of them can be sure one has happened yet — so the version that
       * read `draftId` from its own closure would send `null` and leave the draft sitting on the Node
       * after somebody pressed discard. The ref is the value that is true immediately.
       */
      latest.current.draftId = draft.id;
      // The snapshot is what was *sent*, not what is on screen now: somebody may have typed while the
      // request was in flight, and recording the newer text as saved would skip the save that would have
      // stored it. `flush` reads this back and writes again when it differs.
      saved.current = { to: current.to, cc: current.cc, bcc: current.bcc, subject: current.subject, body: current.body };
      failure.current = null;
      setPhase({ kind: "saved", at: draft.updatedAt });
      return true;
    } catch (error) {
      return failed((error as Error).message);
    }
  }

  function failed(why: string): false {
    failure.current = why;
    setPhase({ kind: "failed", why });
    return false;
  }

  /**
   * Get everything on screen onto the Node, and say whether it arrived.
   *
   * Two writes at once is the thing this exists to prevent: the last-write-wins order between them is
   * whatever the network decides, so a slow first write can land after a fast second and leave the Node
   * holding the older text. So a caller that finds one in flight **waits for it** rather than racing it,
   * and then writes again only if the text moved on while it waited.
   */
  async function flush(): Promise<boolean> {
    const seal = sealRun.current;
    if (seal !== null) await seal;
    const already = inFlight.current;
    if (already !== null) {
      const ok = await already;
      // Nothing typed while that was in the air, so its result is this call's answer.
      if (!unsaved()) return ok;
    }
    // After the wait as well as before it: a discard or a seal can begin while this one waits.
    if (retired.current || !unsaved()) return true;
    const run = writeDraft();
    inFlight.current = run;
    try {
      return await run;
    } finally {
      inFlight.current = null;
    }
  }

  /**
   * Debounced autosave. One write per pause in typing, not one per keystroke.
   *
   * Its cleanup still only cancels the timer, which is right: this cleanup runs on **every** keystroke,
   * and the newer text always has a newer timer behind it. What was missing was never here — it was that
   * nothing else ever asked for a write. See the unmount effect below.
   */
  useEffect(() => {
    if (resuming || !touched || sealing) return;
    // Nothing has changed since the Node last acknowledged a save, so there is nothing to write.
    if (!unsaved()) return;
    if (phase.kind === "empty" || phase.kind === "saved") setPhase({ kind: "browser" });

    const timer = setTimeout(() => void flush(), AUTOSAVE_IDLE_MS);
    return () => clearTimeout(timer);
    // `phase` is deliberately not a dependency: including it would restart the timer on every phase change
    // the timer itself causes, so a save would never fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, body, resuming, touched, sealing, context.mailboxId, context.inReplyToMessageId]);

  /**
   * The last chance, for the paths that take the dock away without asking.
   *
   * `close` flushes and waits, so the ordinary path never needs this. What does need it is a rail link, a
   * route change, anything that unmounts the composer without going through a button — and for those,
   * cancelling the pending timer is exactly the data loss #90 is about.
   *
   * Empty deps, so this cleanup runs **once, on unmount**, and never on a keystroke. That is the whole
   * reason it is a separate effect rather than a branch inside the one above: that one's cleanup fires
   * constantly and cannot tell an unmount from a re-render, and guessing wrong in either direction is
   * either a lost draft or a write per keypress.
   *
   * Nobody awaits it. By the time a cleanup runs there is no component left to report to, and the request
   * is already with the browser, which finishes it without us. `setPhase` inside lands on an unmounted
   * component and is ignored — correct, since there is no longer a screen to update.
   *
   * Discard and a successful seal unmount the dock too, and must write nothing: `flush` refuses once
   * `retired` is set, which they set before they close.
   */
  useEffect(() => () => { if (unsaved()) void flush(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

  useImperativeHandle(ref, () => ({
    draftId: () => latest.current.draftId,
    save: async () => (await flush() ? null : failure.current ?? "this draft could not be saved"),
    sealing: () => sealing,
  }));

  /**
   * Closes the dock, and does not lose what was typed doing it.
   *
   * **This is #90.** The button used to be `onClick={onClose}`, straight through — while the autosave's
   * effect cleanup cancelled the pending timer on the way out. Type a sentence, press close inside the
   * idle window, and the writing was gone; on a draft that had never saved, all of it. The comment beside
   * the button said "Closing keeps the draft", which is what kept anybody from looking.
   *
   * A failed flush **does not close**. The dock stays, showing the Node's own words, exactly as `discard`
   * already does when a legal hold refuses its DELETE — somebody owed a reason has to still be looking at
   * the thing the reason is about. Closing anyway would be the original bug with a message attached.
   */
  async function close() {
    setProblem(null);
    if (!unsaved()) {
      onClose();
      return;
    }
    setClosing(true);
    try {
      if (await flush()) {
        onClose();
        return;
      }
      // The phase label already carries `why` and announces it. `problem` as well, because this person
      // asked to leave and is being kept here, which is a louder fact than an autosave that will retry.
      setProblem(
        "This draft is not saved on your Node yet, so the dock is staying open. Retry, or discard it "
        + "on purpose.",
      );
    } finally {
      setClosing(false);
    }
  }

  async function seal(event: React.FormEvent) {
    event.preventDefault();
    await send("claim");
  }

  /**
   * The seal, behind the claim at send (#42).
   *
   * `reply()` claimed the case before this composer opened, and this dock outlives navigation and can be
   * resumed from the drafts list days later. In between, the case can be released, or taken by a colleague who
   * is answering the same person. So a reply carrying a `caseId` claims again immediately before sealing —
   * idempotent for whoever already holds it — and a `held` answer stops the send and names the holder rather
   * than putting two answers in one correspondent's inbox. "Take it anyway" sends with `"steal"`: the audited
   * steal is the claim, and a steal that is itself refused seals nothing. Cost: one POST per reply sent.
   */
  async function send(take: "claim" | "steal") {
    setProblem(null);
    setSealing(true);
    let sealed = false;
    try {
      if (context.caseId !== undefined) {
        const claimed = take === "steal" ? await stealCase(context.caseId) : await claimCase(context.caseId);
        if (!claimed.ok) {
          setHeld(claimed.kind === "held" ? claimed.message : null);
          if (claimed.kind !== "held") setProblem(claimed.message);
          return;
        }
        setHeld(null);
      }
      // Assigned before `sealDraft` first yields, so no `flush` can run between the seal beginning and this.
      const run = sealDraft();
      sealRun.current = run;
      try {
        sealed = await run;
      } finally {
        sealRun.current = null;
      }
      if (!sealed) return;
      await queryClient.invalidateQueries({ queryKey: ["sends"] });
      await queryClient.invalidateQueries({ queryKey: ["drafts"] });
      onClose();
      await navigate({ to: "/outbox" });
    } catch (error) {
      // The claim before the seal, or the refresh after it: `sealDraft` answers the seal's own failures.
      setProblem(`This Node could not be reached (${(error as Error).message}).${sealed ? "" : " Nothing was sealed, so nothing will be sent."}`);
    } finally {
      setSealing(false);
    }
  }

  /**
   * The seal itself: the draft is retired for as long as the Node is deciding, and given back if it refuses.
   * Resolves whether it sealed; never rejects, because a seal that never reached the Node is a refusal with
   * its own words, shown here.
   */
  async function sealDraft(): Promise<boolean> {
    // No write starts from here on: the seal retires the draft, and one landing after it would bring it
    // back. Undone below if the seal does not happen, so a dock that stays open keeps saving.
    retired.current = true;
    try {
      // A write already in the air would otherwise land after the Node retires the draft below and
      // resurrect it — the same race `close` and `discard` wait out, in the one path that also has a
      // manifest riding on it.
      const pending = inFlight.current;
      if (pending !== null) await pending;
      const response = await apiFetch("/api/sends", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mailboxId: context.mailboxId,
          inReplyToMessageId: context.inReplyToMessageId,
          forwardOfMessageId: context.forwardOfMessageId,
          attachments: await Promise.all(files.map(async ({ file }) => ({
            filename: file.name,
            contentType: file.type === "" ? "application/octet-stream" : file.type,
            contentBase64: await base64Of(file),
          }))),
          to: splitAddresses(to),
          cc: splitAddresses(cc),
          bcc: splitAddresses(bcc),
          subject,
          body,
          // Only while the warning under a flagged file is on screen, which is the author saying so. The Node
          // refuses such a file without it, and records the ones it covered on the seal's audit entry.
          ...(flagged.length === 0 ? {} : { allowDangerousAttachments: true }),
          // Omitted rather than sent empty when there is nothing to choose: absent means "this mailbox has
          // one address, use it", and an empty string would be a sender that matches nothing.
          ...(senderAddress === "" ? {} : { senderAddress }),
          // The Node retires the draft once the manifest exists, rather than the browser deleting it and
          // hoping the seal succeeded. From the ref for the reason `discard` reads it there: the write
          // awaited above may be the one that created this draft.
          draftId: latest.current.draftId,
        }),
      });
      const result = (await response.json()) as { id?: string; message?: string };
      if (!response.ok) {
        retired.current = false;
        // The Node's four-part message, verbatim. It names the remedy, and paraphrasing it would drop
        // the half that tells somebody what to do.
        setProblem(result.message ?? "This message could not be sealed.");
        return false;
      }
      return true;
    } catch (error) {
      retired.current = false;
      setProblem(
        `This Node could not be reached (${(error as Error).message}). Nothing was sealed, so nothing ` +
        `will be sent.`,
      );
      return false;
    }
  }

  /**
   * Throws the draft away on purpose, which is different from closing the dock and leaving it saved.
   *
   * **The refusal is read, because one exists.** A legal hold answers this DELETE with 409 `E_LEGAL_HOLD` and
   * the Node's four-part message (#64), and `apiFetch` *resolves* for a non-ok response rather than throwing —
   * so the version that ignored the response closed the dock as though the draft had gone while it was still
   * there, and the reason `index.ts` deliberately declines to swallow was thrown away by the only caller that
   * presses this button. Handled exactly as `seal` handles its own refusal: the Node's words verbatim, and the
   * dock stays open, because a person owed a reason has to still be looking at the thing it is about.
   *
   * 404 closes as before. It means the draft is already absent, which is the state discard was asking for, and
   * that route answers it with no `message` for §5C's reason — it keeps "gone" and "not yours" alike.
   */
  async function discard() {
    setProblem(null);
    // Before any wait: an autosave timer firing during the wait or the DELETE would write the draft back.
    retired.current = true;
    try {
      // Same race as `seal`: a PUT still in the air would land after the DELETE and put the draft back.
      const pending = inFlight.current;
      if (pending !== null) await pending;
      // From the ref, not the closure: that write may be the one that created the draft being discarded.
      const discarding = latest.current.draftId;
      if (discarding !== null) {
        const response = await apiFetch(`/api/drafts/${encodeURIComponent(discarding)}`, { method: "DELETE" });
        await queryClient.invalidateQueries({ queryKey: ["drafts"] });
        if (!response.ok && response.status !== 404) {
          // Refused, so the draft and the dock both stay, and the dock goes on saving what is typed into it.
          retired.current = false;
          const result = (await response.json().catch(() => null)) as { message?: string } | null;
          setProblem(
            result?.message
            ?? `This Node answered ${response.status} and gave no reason, so this draft may still be here.`,
          );
          return;
        }
      }
    } catch (error) {
      // Never reached the Node: the same outcome as a refusal, said, rather than a rejection nobody hears.
      retired.current = false;
      setProblem(`This Node could not be reached (${(error as Error).message}), so this draft may still be here.`);
      return;
    }
    onClose();
  }

  const title = context.inReplyToMessageId ? "Reply" : context.forwardOfMessageId ? "Forward" : "New message";
  return (
    <section className="composer-dock" aria-label={title}>
      <header className="dock-head">
        <h2>{title}</h2>
        <span
          className={phase.kind === "failed" ? "draft-phase mono failed" : "draft-phase mono"}
          // Announced, unlike the session countdown: this one changes on a human action and says whether
          // their writing is safe, which is worth interrupting for.
          aria-live="polite"
        >
          {phaseText(phase)}
        </span>
        <span className="dock-actions">
          {/* Closing keeps the draft — it flushes first and stays open if that fails (#90). Discarding is
              a separate, named act: a single "close" that silently threw away somebody's writing would be
              the worst possible reading of this dock, and for a while it was what this one did. */}
          {/* Neither while a seal is in the air: the Node is deciding whether this is still a draft, and its
              refusal has to find the dock, and the words, still here. */}
          <button type="button" className="linkish" onClick={() => void discard()} disabled={closing || sealing}>
            Discard
          </button>
          <button type="button" className="linkish" onClick={() => void close()} disabled={closing || sealing}>
            {closing ? "Saving…" : "Close"}
          </button>
        </span>
        {context.originalSubject === undefined ? null : (
          <p className="dock-context">
            {context.forwardOfMessageId === undefined ? "Replying to" : "Forwarding"}: <span>{context.originalSubject}</span>
          </p>
        )}
      </header>

      <form onSubmit={(event) => void seal(event)} noValidate>
        {/*
          From, offered rather than assumed, and always on screen (Blueprint §4B.3).

          A mailbox may have several addresses, and the Node used to pick the oldest by `created_at` — so
          adding `billing@` to a support mailbox sent billing replies as `support@`, silently. The Node now
          refuses an unnamed sender when there is a choice, and this is how somebody complies: a select only
          when there *is* a choice, starting from none chosen (#94). With one address it is a line, not a
          select with one option: it used to be nothing at all, and somebody who claimed the Node as `admin@`
          replied as the mailbox's `hello@` without the screen ever saying so (28 September 2026). With none,
          the line says so, since the send will be refused (`E_MAILBOX_HAS_NO_ADDRESS`). Nothing while the
          mailboxes load, rather than a wrong answer for a moment; a list that failed, or that lacks this mailbox,
          is said, because the Node still sends as the mailbox's address and the screen would not have shown it.

          **First, before To.** It was appended after the message body in the first version, so somebody
          wrote the whole reply and only then met a required field — and From is identity, which belongs at
          the top of a letter rather than under it.
        */}
        {mailboxes.isPending ? null : sendingBox === undefined ? (
          <div className="field-row">
            <span>From</span>
            <div className="dim">
              {mailboxes.isError
                ? `This Node could not read this mailbox's addresses (${mailboxes.error.message}), so the address this goes out from is not shown.`
                : "This mailbox is not among the ones this Node listed, so the address this goes out from is not shown."}
            </div>
          </div>
        ) : senderOptions.length > 1 ? (
          <label className="field-row" htmlFor="composer-from">
            <span>From</span>
            <select
              id="composer-from"
              ref={fromField}
              className="mono"
              value={senderAddress}
              onChange={(event) => setSenderAddress(event.target.value)}
              required
            >
              <option value="">Choose an address…</option>
              {senderOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        ) : (
          <div className="field-row">
            <span>From</span>
            {senderOptions.length === 1
              ? <div><span className="mono">{senderOptions[0]}</span> <span className="dim">· the {sendingBox.name} mailbox</span></div>
              : <div className="dim">No address yet: a send from {sendingBox.name} is refused until an administrator adds one on People.</div>}
          </div>
        )}
        {senderOptions.length === 0 ? null : (
          <p className="hint">More addresses for this mailbox are added on People, by an administrator.</p>
        )}

        <label className="field-row" htmlFor="composer-to">
          <span>To</span>
          <input
            id="composer-to"
            ref={toField}
            className="mono"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            required
          />
          {showCopies ? null : (
            <button type="button" className="linkish composer-copies" onClick={() => setShowCopies(true)}>Cc / Bcc</button>
          )}
        </label>
        {showCopies ? (
          <>
            <label className="field-row" htmlFor="composer-cc">
              <span>Cc</span>
              <input id="composer-cc" className="mono" value={cc} onChange={(event) => setCc(event.target.value)} />
            </label>
            <label className="field-row" htmlFor="composer-bcc">
              <span>Bcc</span>
              <input id="composer-bcc" className="mono" value={bcc} onChange={(event) => setBcc(event.target.value)} />
            </label>
          </>
        ) : null}
        <label className="field-row" htmlFor="composer-subject">
          <span>Subject</span>
          <input
            id="composer-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            required
          />
        </label>
        <label className="field-row" htmlFor="composer-body">
          <span>Message</span>
          <textarea
            id="composer-body"
            ref={bodyField}
            rows={8}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
          />
        </label>

        <label className="field-row" htmlFor="composer-files">
          <span>Attach</span>
          <input
            id="composer-files"
            type="file"
            multiple
            aria-describedby="composer-files-limit"
            // Neither the list nor what it is judged to hold changes under a seal already reading it.
            disabled={sealing}
            onChange={(event) => {
              const chosen = Array.from(event.target.files ?? []);
              event.target.value = "";
              // Listed at once, so a send cannot leave without a file still being read (`blocked` waits for
              // it). Judged one at a time, so a large selection holds one file in memory rather than all.
              setFiles((was) => [...was, ...chosen.map((file) => ({ file, verdict: null, unread: null, judging: true }))]);
              void (async () => {
                for (const file of chosen) {
                  const judged = await judge(file);
                  // By identity, not position: a Remove while this read was in the air shifts the indexes.
                  setFiles((was) => was.map((one) => (one.file === file ? judged : one)));
                }
              })();
            }}
          />
        </label>
        {/*
          * The limit, before anything is attached (AGENTS.md §3: a limit somebody can hit is one they must
          * see). It used to surface only as the seal's refusal. Counted as the Node counts it, at base64 size,
          * and shown in the file sizes a person has: the budget's raw equivalent. A live region, and what the
          * send button points to, so a screen reader hears why a send just became impossible and what was
          * flagged, rather than meeting a dead button.
          */}
        <p
          id="composer-files-limit"
          className={`hint${overBudget || overCount || unreadable > 0 ? " bad" : ""}`}
          role="status"
        >
          {files.length === 0
            ? `Up to ${megabytes(rawBudget)} in total, ${CONFIG.maxAttachments} files.`
            // Padding can put a set over the budget while its sizes sum to the limit or a few bytes under it, so
            // an over figure is at least one byte past the limit and never rounds to read as fitting.
            : `${used(overBudget ? Math.max(usedRaw, rawBudget + 1) : usedRaw, overBudget)} of ${megabytes(rawBudget)} used, ${files.length} of ${CONFIG.maxAttachments} files.`}
          {overBudget ? " Over the limit: remove a file or send a link." : ""}
          {overCount ? " Too many files." : ""}
          {/*
            * A wait, not a fault, so not in the danger tone; but it holds the send, so it is named here. Uncounted,
            * and the flagged count held back until every file is judged: this region is read whole on each change,
            * so a count per judged file would read the line again for every file attached.
            */}
          {checking === 0 ? "" : " Checking files…"}
          {unreadable === 0 ? "" : ` ${count(unreadable)} could not be read: remove and attach again.`}
          {checking > 0 || flagged.length === 0 ? "" : ` ${count(flagged.length)} judged dangerous: see the warning below.`}
        </p>
        {files.length === 0 ? null : (
          <ul className="attachments" aria-label="Attached files">
            {files.map(({ file, verdict, unread, judging: reading }, index) => (
              <li key={`${file.name}-${index}`}>
                <span className="mono">{file.name}</span>{" "}
                <span className="dim">{kilobytes(file.size)}</span>{" "}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => setFiles((was) => was.filter((one) => one.file !== file))}
                  disabled={sealing}
                >
                  Remove
                </button>
                {reading ? <span className="dim"> Checking…</span> : null}
                {verdict !== null && DANGEROUS.has(verdict) ? (
                  <p className="notice warn">
                    {file.name} is {VERDICT_WORDS[verdict]}. It will be sent because you attached it, and the seal
                    records that you did. Some receiving servers refuse programs and scripts (Gmail refuses .exe,
                    .js, .jar and others, even inside a zip), so a link may be the only way it arrives.
                  </p>
                ) : null}
                {unread === null ? null : (
                  <span className="bad">
                    {" "}This browser could not read it ({unread}), so it cannot be sent: remove it and attach it again.
                  </span>
                )}
              </li>
            ))}
            <li className="dim">
              Files travel with the send, not with the draft: close this and they are not kept.
            </li>
          </ul>
        )}

        {bodyUnavailable === null ? null : (
          /*
           * Said where the empty box is, not in a banner somewhere else (#143). The two states get different
           * words because the reader does different things with them: one is recoverable and names the act
           * that recovers it, the other is not and says so rather than offering hope.
           */
          <p className="notice bad" role="status">
            {bodyUnavailable === "unreadable"
              ? "This draft's text is stored on this Node and cannot be opened — it is sealed under a key "
                + "generation the vault does not hold. It is not lost, and saving over it is refused. "
                + "Restore the vault with one of the ten recovery codes, then reopen this draft."
              : "This draft's text is gone: the row recording it is here and the stored object is not. The "
                + "recipients and subject above are intact. Nothing can recover the writing."}
          </p>
        )}

        {problem === null ? null : (
          <div className="errors" role="alert">
            <p className="notice bad">{problem}</p>
          </div>
        )}
        {held === null ? null : (
          <p className="composer-held" role="alert">
            {held}{" "}
            {/* Available to any colleague and audited, the escape hatch the absent claim timeout depends on. */}
            <button
              type="button"
              className="linkish"
              onClick={() => void send("steal")}
              disabled={sealing || blocked}
              aria-describedby={blocked ? "composer-files-limit" : undefined}
            >
              Take it anyway
            </button>
          </p>
        )}

        <div className="dock-send">
          <button
            type="submit"
            className="primary"
            disabled={sealing || resuming || blocked}
            // The reason, where a browse-mode reader meets the disabled button.
            aria-describedby={blocked ? "composer-files-limit" : undefined}
          >
            {sealing ? "Sealing…" : "Seal and send"}
          </button>
          {/*
            Every fact of the send, at the weight of a footnote beside the act: it goes out as the mailbox (ADR
            36), the author is recorded, the hold, and no recall. The why is one click down, not gone.
          */}
          <span className="send-note">
            Sent as the mailbox; who wrote it is recorded here. Held {holdWindowSeconds()} s so you can stop it;
            no recall.
          </span>
        </div>
        <details className="send-how">
          <summary>How sending works</summary>
          <p>
            This will be sent from the mailbox, not from you. Who wrote it is recorded here and does not
            travel with the message. Sealing records exactly what will be sent before anything leaves, then
            waits {holdWindowSeconds()} seconds so you can still stop it — nothing is recalled, because a
            recall would not be honest.
          </p>
        </details>
      </form>
    </section>
  );
}

/** A file as attached: the file, and this Node's verdict on it, or null when it was not judged here. */
interface Attached {
  file: File;
  verdict: AttachmentVerdict | null;
  /** Why this browser could not read it. Shown under the file, and it blocks the send, which reads the same bytes. */
  unread: string | null;
  /** Listed but not yet read to be judged. */
  judging: boolean;
}

/**
 * Judges a file once it is attached, by the rule the seal applies (`src/attachments.ts`), so the warning is on
 * screen before anybody presses send rather than arriving as a refusal. A file over the whole budget is not read
 * into memory to be judged: it cannot be sent however it is judged, and the limit line says so. A file the browser
 * cannot read is left unjudged and blocks the send until it is removed.
 */
async function judge(file: File): Promise<Attached> {
  if (encodedBytes(file.size) > CONFIG.attachmentBudgetBytes) return { file, verdict: null, unread: null, judging: false };
  try {
    const verdict = classifyAttachment(file.name, new Uint8Array(await file.arrayBuffer()));
    return { file, verdict, unread: null, judging: false };
  } catch (error) {
    // Shown under the file and on the limit line rather than dropped, and the send waits for it to be removed.
    return { file, verdict: null, unread: (error as Error).message, judging: false };
  }
}

/** "1 file", "2 files": the count the limit line leads a clause with. */
function count(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/** A file's size in KB (1,024 bytes), never "0 KB" for a file that is there. */
function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Bytes as a person reads a file size, in tenths of a megabyte. MB here is 1,048,576 bytes, the binary unit the
 * KB beside each file already uses; read as decimal, the stated limit only looks smaller. Rounded **down** by
 * default, because a limit rounded to nearest overclaims whenever its raw figure sits in the upper half of a
 * tenth: at 3.375 MB, the budget when this was written, it read "Up to 3.4 MB", room the seal refuses.
 */
function megabytes(bytes: number, round: (n: number) => number = Math.floor): string {
  return `${(round(bytes / 104_857.6) / 10).toFixed(1)} MB`;
}

/**
 * What the attached files use, beside the limit. In KB (to the nearest, never 0) below a tenth of a megabyte, so a
 * small file does not read as nothing attached. In MB above that, rounded down while it fits and **up** once it does
 * not, so the figure never contradicts the verdict beside it: rounded down both ways, a send just over the limit read
 * "3.3 MB of 3.3 MB used … Over".
 */
function used(bytes: number, over: boolean): string {
  return bytes < 104_857.6 ? kilobytes(bytes) : megabytes(bytes, over ? Math.ceil : Math.floor);
}

/** A file's bytes as standard base64, the way the seal decodes it. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.byteLength; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}
