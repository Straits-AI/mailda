import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { apiFetch } from "/app/session.js";

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

/** The hold window, from the receipt-generated budget by way of `window.MAILDA_CONFIG`. Never a literal. */
function holdWindowSeconds(): number {
  const config = (window as unknown as { MAILDA_CONFIG?: { holdWindowSeconds?: number } }).MAILDA_CONFIG;
  return config?.holdWindowSeconds ?? 15;
}

/**
 * How long the composer waits after the last keystroke before saving.
 *
 * Not a receipt value: it is a interaction choice rather than a measurement of anything, and inventing a
 * receipt for it would dilute what a receipt means. Long enough that ordinary typing produces one write per
 * pause rather than one per word, short enough that a person who types a sentence and closes the laptop
 * has it.
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

function splitAddresses(value: string): string[] {
  return value.split(/[,;]+/).map((part) => part.trim()).filter(Boolean);
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
  const [resuming, setResuming] = useState(context.inReplyToMessageId !== undefined);
  const queryClient = useQueryClient();
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

  /** Debounced autosave. One write per pause in typing, not one per keystroke. */
  useEffect(() => {
    if (resuming || !touched || sealing) return;
    // Nothing has changed since the Node last acknowledged a save, so there is nothing to write.
    const current = saved.current;
    if (current !== null && current.to === to && current.subject === subject && current.body === body) return;
    if (phase.kind === "empty" || phase.kind === "saved") setPhase({ kind: "browser" });

    const timer = setTimeout(() => {
      void (async () => {
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
            return;
          }
          const { draft } = (await response.json()) as DraftResponse;
          if (draft !== null) {
            setDraftId(draft.id);
            // The snapshot is what was *sent*, not what is on screen now: somebody may have typed while
            // the request was in flight, and recording the newer text as saved would skip the save that
            // would have stored it.
            saved.current = { to: current.to, subject: current.subject, body: current.body };
            setPhase({ kind: "saved", at: draft.updatedAt });
          }
        } catch (error) {
          setPhase({ kind: "failed", why: (error as Error).message });
        }
      })();
    }, AUTOSAVE_IDLE_MS);

    return () => clearTimeout(timer);
    // `phase` is deliberately not a dependency: including it would restart the timer on every phase change
    // the timer itself causes, so a save would never fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, subject, body, resuming, touched, sealing, context.mailboxId, context.inReplyToMessageId]);

  async function seal(event: React.FormEvent) {
    event.preventDefault();
    setProblem(null);
    setSealing(true);
    try {
      const response = await apiFetch("/api/sends", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mailboxId: context.mailboxId,
          inReplyToMessageId: context.inReplyToMessageId,
          to: splitAddresses(to),
          subject,
          body,
          // The Node retires the draft once the manifest exists, rather than the browser deleting it and
          // hoping the seal succeeded.
          draftId,
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

  /** Throws the draft away on purpose, which is different from closing the dock and leaving it saved. */
  async function discard() {
    if (draftId !== null) {
      await apiFetch(`/api/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["drafts"] });
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
          {/* Closing keeps the draft. Discarding is a separate, named act — a single "close" that silently
              threw away somebody's writing would be the worst possible reading of this dock. */}
          <button type="button" className="linkish" onClick={() => void discard()}>
            discard
          </button>
          <button type="button" className="linkish" onClick={onClose}>
            close
          </button>
        </span>
      </header>

      <form onSubmit={(event) => void seal(event)} noValidate>
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
