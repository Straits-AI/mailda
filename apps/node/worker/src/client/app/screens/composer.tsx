import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { apiFetch } from "/app/session.js";
import { CONFIG } from "/app/config.js";

import { useMailboxes } from "../api.ts";
import { splitAddresses } from "./split-addresses.js";

/**
 * The docked composer — the reason ADR 30 put React at this layer.
 *
 * ## Why it is docked rather than a route
 *
 * Variant A's compose-as-route was rejected on a product ground, not a taste one: replying moves the
 * original off screen, and for invoice and shipment mail a reply exists precisely to quote a PO number or
 * a container reference. So the composer collapses into a dock and the message stays readable behind it.
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
  to?: string;
  subject?: string;
  body?: string;
}

interface DraftResponse {
  draft: {
    id: string;
    to: string[];
    subject: string;
    body: string;
    updatedAt: string;
  } | null;
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

export function Composer({ context, onClose }: { context: ComposerContext; onClose: () => void }) {
  const [to, setTo] = useState(context.to ?? "");
  const [subject, setSubject] = useState(context.subject ?? "");
  const [body, setBody] = useState(context.body ?? "");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "empty" });
  const [sealing, setSealing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * Which address this goes out as. Empty means "not chosen", which is only a problem when there is a choice
   * to make — the Node decides that, and its refusal names the addresses.
   */
  const [senderAddress, setSenderAddress] = useState("");
  const [resuming, setResuming] = useState(context.inReplyToMessageId !== undefined);
  const queryClient = useQueryClient();
  /**
   * The addresses this mailbox may send as, from the rail's own query rather than a second endpoint — it is
   * already loaded and already bounded by the relation that decides whether this composer should exist.
   */
  const mailboxes = useMailboxes();
  const senderOptions = (mailboxes.data?.mailboxes
    .find((box) => box.id === context.mailboxId)?.addresses ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
  const navigate = useNavigate();

  // `latest` exists so the debounced save reads the values at the moment it fires rather than the ones
  // captured when the timer was set — otherwise the last keystroke before a pause is the one that is lost,
  // which is the single most annoying way for an autosave to be wrong.
  const latest = useRef({ to, subject, body, draftId });
  latest.current = { to, subject, body, draftId };

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
  const saved = useRef<{ to: string; subject: string; body: string } | null>(null);

  /**
   * Resume the draft already in progress for this reply, if there is one.
   *
   * The server answers this in one call (`?inReplyTo=`) because the alternative is listing every draft and
   * choosing in the browser, which is a decision about somebody's unfinished work made in the wrong place.
   * A unique index guarantees at most one, so there is nothing to disambiguate.
   */
  useEffect(() => {
    if (context.inReplyToMessageId === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch(
          `/api/drafts?inReplyTo=${encodeURIComponent(context.inReplyToMessageId!)}`,
        );
        if (!response.ok) return;
        const { draft } = (await response.json()) as DraftResponse;
        if (cancelled || draft === null) return;
        // The saved draft wins over the freshly-quoted template. Somebody's own words are worth more than a
        // quote block this code can regenerate at any time.
        setDraftId(draft.id);
        setTo(draft.to.join(", "));
        setSubject(draft.subject);
        setBody(draft.body);
        // Recorded as already-saved, so resuming is not mistaken for editing.
        saved.current = { to: draft.to.join(", "), subject: draft.subject, body: draft.body };
        setPhase({ kind: "saved", at: draft.updatedAt });
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context.inReplyToMessageId]);

  const touched = to !== "" || subject !== "" || body !== "";

  /**
   * Whichever write is in the air, so nothing ever starts a second one beside it.
   *
   * A ref rather than state: every reader wants the value at the moment they ask, and a re-render is not
   * only unnecessary but wrong — `flush` is called from a click handler and from an effect cleanup, and
   * neither can wait for React to tell it what it already needs to know.
   */
  const inFlight = useRef<Promise<boolean> | null>(null);
  /** True while `close` is waiting for the Node, so the buttons cannot be pressed twice. */
  const [closing, setClosing] = useState(false);

  /** Whether the Node's copy is behind what is on screen. The one definition of "there is work to do". */
  function unsaved(): boolean {
    const now = latest.current;
    if (now.to === "" && now.subject === "" && now.body === "") return false;
    const stored = saved.current;
    return stored === null
      || stored.to !== now.to || stored.subject !== now.subject || stored.body !== now.body;
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
          subject: current.subject,
          body: current.body,
        }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { message?: string } | null;
        setPhase({ kind: "failed", why: failure?.message ?? `this Node answered ${response.status}` });
        return false;
      }
      const { draft } = (await response.json()) as DraftResponse;
      if (draft === null) return false;
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
      saved.current = { to: current.to, subject: current.subject, body: current.body };
      setPhase({ kind: "saved", at: draft.updatedAt });
      return true;
    } catch (error) {
      setPhase({ kind: "failed", why: (error as Error).message });
      return false;
    }
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
    const already = inFlight.current;
    if (already !== null) {
      const ok = await already;
      // Nothing typed while that was in the air, so its result is this call's answer.
      if (!unsaved()) return ok;
    }
    if (!unsaved()) return true;
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
  }, [to, subject, body, resuming, touched, sealing, context.mailboxId, context.inReplyToMessageId]);

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
   */
  useEffect(() => () => { if (unsaved()) void flush(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

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
    setProblem(null);
    setSealing(true);
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
          to: splitAddresses(to),
          subject,
          body,
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
        // The Node's four-part message, verbatim. It names the remedy, and paraphrasing it would drop
        // the half that tells somebody what to do.
        setProblem(result.message ?? "This message could not be sealed.");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["sends"] });
      await queryClient.invalidateQueries({ queryKey: ["drafts"] });
      onClose();
      await navigate({ to: "/outbox" });
    } catch (error) {
      setProblem(
        `This Node could not be reached (${(error as Error).message}). Nothing was sealed, so nothing ` +
        `will be sent.`,
      );
    } finally {
      setSealing(false);
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
    // Same race as `seal`: a PUT still in the air would land after the DELETE and put the draft back.
    const pending = inFlight.current;
    if (pending !== null) await pending;
    // From the ref, not the closure: that write may be the one that created the draft being discarded.
    const discarding = latest.current.draftId;
    if (discarding !== null) {
      const response = await apiFetch(`/api/drafts/${encodeURIComponent(discarding)}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["drafts"] });
      if (!response.ok && response.status !== 404) {
        const result = (await response.json().catch(() => null)) as { message?: string } | null;
        setProblem(
          result?.message
          ?? `This Node answered ${response.status} and gave no reason, so this draft may still be here.`,
        );
        return;
      }
    }
    onClose();
  }

  return (
    <section className="composer-dock" aria-label={context.inReplyToMessageId ? "Reply" : "New message"}>
      <header className="dock-head">
        <h2>{context.inReplyToMessageId ? "Reply" : "New message"}</h2>
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
          <button type="button" className="linkish" onClick={() => void discard()} disabled={closing}>
            discard
          </button>
          <button type="button" className="linkish" onClick={() => void close()} disabled={closing}>
            {closing ? "saving…" : "close"}
          </button>
        </span>
      </header>

      <form onSubmit={(event) => void seal(event)} noValidate>
        {/*
          From, offered rather than assumed.

          A mailbox may have several addresses, and the Node used to pick the oldest by `created_at` — so
          adding `billing@` to a support mailbox sent billing replies as `support@`, silently. The Node now
          refuses an unnamed sender when there is a choice, and this is how somebody complies. Rendered only
          when there *is* a choice: a select with one option is furniture, and the overwhelming majority of
          mailboxes have exactly one address.

          **First, before To.** It was appended after the message body in the first version, so somebody
          wrote the whole reply and only then met a required field — and From is identity, which belongs at
          the top of a letter rather than under it.
        */}
        {senderOptions.length > 1 ? (
          <label className="field-row" htmlFor="composer-from">
            <span>From</span>
            <select
              id="composer-from"
              className="mono"
              value={senderAddress}
              onChange={(event) => setSenderAddress(event.target.value)}
              required
            >
              <option value="">choose an address…</option>
              {senderOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="field-row" htmlFor="composer-to">
          <span>To</span>
          <input
            id="composer-to"
            className="mono"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            required
          />
        </label>
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
            rows={8}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
          />
        </label>

        <p className="hint">
          This will be sent from the mailbox, not from you. Who wrote it is recorded here and does not
          travel with the message. Sealing records exactly what will be sent before anything leaves, then
          waits {holdWindowSeconds()} seconds so you can still stop it — nothing is recalled, because a
          recall would not be honest.
        </p>

        {problem === null ? null : (
          <div className="errors" role="alert">
            <p className="notice bad">{problem}</p>
          </div>
        )}

        <button type="submit" className="primary" disabled={sealing || resuming}>
          {sealing ? "Sealing…" : "Seal and send"}
        </button>
      </form>
    </section>
  );
}
