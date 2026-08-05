/**
 * The outbound transport (§14, ADR 23, ADR 33).
 *
 * ADR 23 committed to **one shipped adapter** — Cloudflare Email Sending — while keeping the interface
 * so an organization can build its own. This is that interface, plus that one implementation.
 *
 * ## What an adapter may and may not claim
 *
 * The return type has no `delivered`. That is the whole point of it. Cloudflare tells a Node it
 * *accepted* a message, and ADR 33 established that neither of its send APIs can report what the
 * recipient received — Cloudflare adds `Received` and `DKIM-Signature` in transit either way. An
 * adapter that could return "delivered" would let §5C be violated by a type.
 *
 * ## Fidelity is the caller's declaration
 *
 * ADR 33 keeps both send APIs, and the cost of that is paid here: `submit` **requires** a fidelity and
 * the manifest stores it, so a sent message is never ambiguous about whether its record is
 * authoritative. The discriminator is structural rather than discretionary — can anything be required
 * to prove exactly what was sent? Customer mail can, so it goes `authored`; Mailda's own notifications
 * cannot, so they go `reconstructed`, where Cloudflare's builder is likelier correct than ours.
 */

export type SubmitOutcome =
  /** The transport accepted it. Whether it arrived is unknown and unknowable. */
  | { kind: "handed_over"; transportMessageId: string }
  /** Rejected at the API boundary. Provably never reached the network, so retry is safe. */
  | { kind: "refused"; reason: string; retryable: boolean }
  /** On the suppression list. Will never arrive, and that is knowable now. */
  | { kind: "suppressed"; reason: string }
  /** Rate-limited. Never left; the daily limit ADR 34 measures rather than reads. */
  | { kind: "throttled"; reason: string }
  /** We do not know whether it left. Never retried automatically (ADR 40). */
  | { kind: "outcome_unknown"; reason: string };

export interface SubmitRequest {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Present for `authored`: the exact bytes to submit. */
  raw?: Uint8Array;
  /** Present for `reconstructed`: the fields Cloudflare will assemble. */
  text?: string;
}

export interface TransportAdapter {
  readonly name: string;
  /**
   * §14 requires "can this Node send" answerable **before** a user composes rather than discovered at
   * submit. The capability comes from what `mailda deploy` recorded (ADR 34) — neither the plan nor
   * domain onboarding is visible from inside a Worker — so this reads a stored answer and its date.
   */
  capability(env: Env): Promise<TransportCapability>;
  submit(env: Env, request: SubmitRequest, fidelity: "authored" | "reconstructed"): Promise<SubmitOutcome>;
}

export interface TransportCapability {
  canSend: boolean;
  /** True only when a sending domain is onboarded. Without it, only verified destinations work. */
  arbitraryRecipients: boolean;
  /** When `mailda deploy` last verified this. Staleness is visible rather than implied (ADR 34). */
  verifiedAt: string | null;
  detail: string;
}

/**
 * Classifies whatever the binding threw.
 *
 * The four outcomes are **not** interchangeable and this is where conflating them would happen. A
 * throttle provably never left, so it is safe to retry automatically; an unknown outcome is not, and
 * retrying it risks a duplicate the recipient keeps forever (ADR 40) — Cloudflare offers no
 * idempotency key to deduplicate against.
 *
 * Anything unrecognised becomes `outcome_unknown`, deliberately. The safe default for an
 * unclassifiable failure is the state that forbids automatic retry, not the one that permits it.
 */
export function classifyError(message: string): SubmitOutcome {
  const text = message.toLowerCase();

  if (/rate.?limit|too many requests|429|quota exceeded|daily limit/.test(text)) {
    return { kind: "throttled", reason: message };
  }
  if (/suppress/.test(text)) {
    return { kind: "suppressed", reason: message };
  }
  // Measured against the live API: sending onboarding is **per subdomain**, not inherited from the
  // apex zone. A Node on `mail.example.com` is refused even when `example.com` is fully onboarded —
  // which matters because §10 makes a delegated subdomain the *default* install path.
  //
  // Classified as `refused` rather than `outcome_unknown`: the message provably never left, and this
  // is the most fixable failure in the list, so it must not carry the most alarming state.
  if (/sending not authorized|not authorized for subdomain|not onboarded/.test(text)) {
    return {
      kind: "refused",
      reason:
        "Email Sending is not enabled for the subdomain this mailbox sends from. Onboarding is " +
        "per-subdomain and is not inherited from the parent zone, so enabling it on the apex is not " +
        "enough. Run `wrangler email sending enable <subdomain>`, which adds the SPF and DKIM records.",
      retryable: false,
    };
  }

  // Cloudflare's own wording for an unonboarded domain. #19 recorded that this string must never
  // reach a user: it names neither the plan nor domain verification, so it teaches nothing.
  if (/not a verified address|verified destination/.test(text)) {
    return {
      kind: "refused",
      reason:
        "This Node may only send to addresses already verified in its own Cloudflare account, " +
        "because no sending domain has been onboarded. Onboarding adds SPF and DKIM records and " +
        "allows any recipient.",
      retryable: false,
    };
  }
  if (/invalid|malformed|too large|E_HEADER|E_BODY|400|422/i.test(message)) {
    return { kind: "refused", reason: message, retryable: false };
  }
  return { kind: "outcome_unknown", reason: message };
}

/**
 * Cloudflare Email Sending — the one shipped adapter (ADR 23).
 *
 * The binding is absent until the install flow adds it, and its absence is a *capability* answer
 * rather than an error: §14 wants a Node to say "I cannot send" before a user writes a reply.
 */
export const cloudflareTransport: TransportAdapter = {
  name: "cloudflare-email-sending",

  async capability(env: Env): Promise<TransportCapability> {
    if (env.EMAIL === undefined) {
      return {
        canSend: false,
        arbitraryRecipients: false,
        verifiedAt: null,
        detail:
          "No EMAIL binding. This Node cannot send at all — `mailda deploy` adds the binding and " +
          "verifies the plan and the onboarded sending domain (ADR 34).",
      };
    }

    const recorded = await env.CATALOG.prepare(
      "SELECT value, recorded_at FROM node_capabilities WHERE name = 'send' LIMIT 1",
    )
      .first<{ value: string; recorded_at: string }>()
      .catch(() => null);

    if (recorded === null) {
      // The binding exists but nothing has verified the two gates. Reporting "yes" here would be a
      // guess, and §14's whole point is not guessing.
      return {
        canSend: false,
        arbitraryRecipients: false,
        verifiedAt: null,
        detail:
          "The EMAIL binding is present but sending has never been verified. Neither the Workers plan " +
          "nor whether a sending domain is onboarded is visible from inside a Worker; run " +
          "`mailda deploy` or `mailda doctor --remote` to record it.",
      };
    }

    const parsed = JSON.parse(recorded.value) as { canSend: boolean; arbitraryRecipients: boolean };
    return {
      canSend: parsed.canSend,
      arbitraryRecipients: parsed.arbitraryRecipients,
      verifiedAt: recorded.recorded_at,
      detail: parsed.arbitraryRecipients
        ? "A sending domain is onboarded, so any recipient is reachable."
        : "No sending domain is onboarded, so only addresses already verified in this Cloudflare " +
          "account are reachable — this Node can receive a customer's message and be unable to answer it.",
    };
  },

  async submit(env, request, fidelity): Promise<SubmitOutcome> {
    if (env.EMAIL === undefined) {
      return {
        kind: "refused",
        reason: "This Node has no EMAIL binding, so it cannot send.",
        retryable: false,
      };
    }

    try {
      if (fidelity === "authored") {
        if (request.raw === undefined) {
          return {
            kind: "refused",
            reason: "An authored submission requires the exact bytes to send.",
            retryable: false,
          };
        }
        // The legacy raw-MIME form. Chosen for anything whose record must be exact (ADR 33): it is
        // the only path where the bytes stored and the bytes submitted are the same object.
        const { EmailMessage } = await import("cloudflare:email");
        const message = new EmailMessage(
          request.from,
          [...request.to, ...(request.cc ?? []), ...(request.bcc ?? [])].join(","),
          new TextDecoder().decode(request.raw),
        );
        const result = (await env.EMAIL.send(message)) as { messageId?: string } | undefined;
        return {
          kind: "handed_over",
          transportMessageId: result?.messageId ?? "unreported",
        };
      }

      const result = await env.EMAIL.send({
        from: request.from,
        to: request.to,
        subject: request.subject,
        text: request.text ?? "",
      });
      return { kind: "handed_over", transportMessageId: result?.messageId ?? "unreported" };
    } catch (error) {
      return classifyError((error as Error).message);
    }
  },
};
