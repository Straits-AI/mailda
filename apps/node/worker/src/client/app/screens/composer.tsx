import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
 * ## The draft phases say where the bytes are, and only what is true
 *
 * #32 named three: `this browser only · a reload loses it` → `saved on your node` → `sealed · immutable ·
 * stoppable for Ns`. Two of them exist here. **The middle one deliberately does not appear**, because
 * nothing saves a draft on the Node yet — there is no drafts endpoint — and a label claiming otherwise
 * would be the interface telling the exact kind of lie §5C forbids. The wording of phase one is the honest
 * version of the same fact, and it is unpleasant on purpose: a draft that a reload loses is the first
 * thing in this product a person would be angry to lose, and that discomfort is the argument for building
 * the endpoint rather than for softening the sentence.
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

export interface ComposerContext {
  mailboxId: string;
  inReplyToMessageId?: string;
  to?: string;
  subject?: string;
  body?: string;
}

function splitAddresses(value: string): string[] {
  return value.split(/[,;]+/).map((part) => part.trim()).filter(Boolean);
}

export function Composer({ context, onClose }: { context: ComposerContext; onClose: () => void }) {
  const [to, setTo] = useState(context.to ?? "");
  const [subject, setSubject] = useState(context.subject ?? "");
  const [body, setBody] = useState(context.body ?? "");
  const [sealing, setSealing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const touched = to !== "" || subject !== "" || body !== "";

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

  return (
    <section className="composer-dock" aria-label={context.inReplyToMessageId ? "Reply" : "New message"}>
      <header className="dock-head">
        <h2>{context.inReplyToMessageId ? "Reply" : "New message"}</h2>
        <span className="draft-phase mono" aria-live="polite">
          {touched ? "this browser only · a reload loses it" : "empty draft"}
        </span>
        <button type="button" className="linkish dock-close" onClick={onClose}>
          close
        </button>
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

        <button type="submit" className="primary" disabled={sealing}>
          {sealing ? "Sealing…" : "Seal and send"}
        </button>
      </form>
    </section>
  );
}
