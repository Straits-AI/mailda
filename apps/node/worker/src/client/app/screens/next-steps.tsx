import { t } from "/app/locale.js";
import type { MessageRow } from "../api.ts";

/**
 * What a reader can do next with the message in front of them (U4), and the one place an AI result would sit.
 *
 * ## Deterministic, contextual, and never a copy of the action bar
 *
 * The memo drew "Mailda suggestions" with "Draft reply", "Assign" and "Create automation". None of those is
 * offered here, each for a reason a reader could check: "Draft reply" is Reply, and the word "draft" promises
 * generated text this Node does not produce; "Assign" is already on the action bar; "Create automation" would
 * create nothing, because every Butler route is `org.admin` and a chip that only navigates must not say it
 * creates. What is left is what applies to **this** message for **this** reader and is not a button above it:
 * take the case to work it later, put back a case you hold, and narrow the list to this sender.
 *
 * So the heading is "Next steps", not "Mailda suggestions": a suggestion implies inference, and nothing here
 * infers. README says there is no AI inside the app, and Blueprint §4B.4 requires any AI output to carry its
 * provenance. `AiFinding` is that slot, typed so a future `llm.*` node has somewhere honest to land; the only
 * provider today returns `null` for it.
 */

/** Where an LLM result came from. Required on every AI output (§4B.4); nothing produces one today. */
export interface Provenance { profile: string; model: string; runId: string; at: string }

/**
 * An LLM node's result about a message ("Invoice detected · RM 4,800"). Rendered only with its AI label and
 * provenance. The slot stays empty until an llm.* node exists (README: no AI inside the app).
 */
export interface AiFinding { text: string; provenance: Provenance }

/** A deterministic action that works today for this reader and is not already on the action bar. Never AI-badged. */
export interface NextStep { id: "claim" | "release" | "more-from-sender"; label: string; run(): void }

export interface NextStepsInput {
  message: MessageRow;
  /** The delivery's mailbox is among useMailboxes() rows (send.propose). */
  canSend: boolean;
  /** Inbox's claim(message): POST claim; a held answer becomes the collision notice. */
  claim(): void;
  /** POST release; toast "Released to the queue." */
  release(): void;
  /** Sets the list's sender filter (MESSAGE_PAGE_PARAMS.from). */
  showFromSender(address: string): void;
}

export type NextStepsProvider = (input: NextStepsInput) => { steps: NextStep[]; finding: AiFinding | null };

/** The only provider today. */
export const deterministicNextSteps: NextStepsProvider = ({ message, canSend, claim, release, showFromSender }) => {
  const steps: NextStep[] = [];
  /*
   * Claim and Release take `send.propose` on the mailbox, the same authority Reply needs; offering either to a
   * reader without it is a button that can only fail (the application-shell doc: what the reader offers follows what
   * the Node will allow).
   */
  if (canSend && message.case_state === "open") steps.push({ id: "claim", label: t("queue.act.claim"), run: claim });
  if (canSend && message.case_mine === 1) steps.push({ id: "release", label: t("queue.act.release"), run: release });
  /*
   * The envelope sender, because that is what the `from` filter matches. The label says "this sender" rather
   * than naming the display name: the name is whatever the sender typed, and the filter does not look at it.
   */
  const sender = message.envelope_from;
  if (sender !== "") steps.push({ id: "more-from-sender", label: t("ui.nextSteps.fromSender"), run: () => showFromSender(sender) });
  return { steps, finding: null };
};

/** Nothing at all when there is nothing to do: the calm state has no heading and no empty strip. */
export function NextSteps({ steps, finding }: { steps: NextStep[]; finding: AiFinding | null }) {
  if (steps.length === 0 && finding === null) return null;
  return (
    <section className="next-steps" aria-label={t("ui.nextSteps")}>
      <span className="next-steps-label">{t("ui.nextSteps")}</span>
      {steps.map((step) => (
        <button key={step.id} type="button" className="chip-action" onClick={step.run}>{step.label}</button>
      ))}
      {finding === null ? null : (
        /*
         * The AI label and the provenance come first and stay: an extraction "returned a result", and a reader
         * judging it needs to know which profile, which model and which run returned it before reading it.
         */
        <div className="ai-finding">
          <span className="ai-label">{t("ui.nextSteps.ai")}</span>{" "}
          <span className="ai-provenance">
            {t("ui.nextSteps.provenance", {
              profile: finding.provenance.profile, model: finding.provenance.model,
              runId: finding.provenance.runId, at: finding.provenance.at,
            })}
          </span>{" "}
          {finding.text}
        </div>
      )}
    </section>
  );
}
