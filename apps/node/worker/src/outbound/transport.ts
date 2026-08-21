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
   * submit. Neither the plan nor domain onboarding is visible from inside a Worker, so this reads a stored
   * answer and its date out of `node_capabilities` (ADR 34).
   *
   * **Nothing writes that row.** It was to be `mailda deploy`, which did not exist (#80); the CLI that
   * exists now still cannot, because Cloudflare's sending-domain onboarding is a dashboard flow with no
   * endpoint listing its result, and a probe would mean sending a real message to a stranger to see whether
   * it was refused. So `capability()` returns the honest "never verified" answer on every Node today, and
   * the table is the seam that will hold the answer if Cloudflare ever exposes one.
   */
  capability(env: Env): Promise<TransportCapability>;
  submit(env: Env, request: SubmitRequest, fidelity: "authored" | "reconstructed"): Promise<SubmitOutcome>;
}

export interface TransportCapability {
  canSend: boolean;
  /** True only when a sending domain is onboarded. Without it, only verified destinations work. */
  arbitraryRecipients: boolean;
  /**
   * When this was last verified, or **null** — which is every Node today, because nothing can verify it.
   * Kept as a column rather than dropped: staleness is visible rather than implied (ADR 34), and a field
   * that is always null is a smaller lie than a date somebody invented.
   */
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
          // Was: "`mailda deploy` adds the binding and verifies the plan and the onboarded sending
          // domain". There was no CLI (#80), and the one that exists now can do neither — the plan is not
          // readable from anywhere this project has, and Cloudflare's sending-domain onboarding is a
          // dashboard flow with no endpoint listing its result.
          "No EMAIL binding. This Node cannot send at all — add a `send_email` binding to " +
          "wrangler.jsonc and deploy again (ADR 34).",
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
          // Neither gate is verifiable by anything this project has, which is stated rather than pointing
          // at a command that cannot do it. `mailda deploy`'s own help says the same two sentences.
          "The EMAIL binding is present but sending has never been verified, and nothing here can verify " +
          "it: the Workers plan is not readable from a Worker, and whether a sending domain is onboarded " +
          "has no documented API. Until one is onboarded this Node can only reach addresses already " +
          "verified in your Cloudflare account.",
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

        // `EmailMessage`'s second argument is **one** address, not a list.
        //
        // This used to join every recipient with commas, which produced a single malformed address and a
        // refusal from Cloudflare reading `invalid mail from email address (a@x,b@y,c@z): Invalid input`.
        // Measured on the deployed Node: a single recipient is handed over, and adding one `cc` refuses
        // the whole send. No test caught it because none sent to more than one recipient.
        //
        // Since migration 0011 `dispatchOne` submits once per recipient, so this guard no longer fires in
        // normal operation — and it stays precisely for that reason. It is now the thing that stops a
        // future caller quietly reintroducing a multi-recipient submission, which would send to exactly
        // one of them and report success. A guard that has stopped firing because the code above it got
        // correct is worth keeping; deleting it removes the only statement of why the loop exists.
        const recipients = [...request.to, ...(request.cc ?? []), ...(request.bcc ?? [])];
        if (recipients.length > 1) {
          return {
            kind: "refused",
            retryable: false,
            reason:
              `An authored send carries exactly one recipient on this transport, and this one has ` +
              `${recipients.length}. The raw-MIME submission API accepts a single address, and the ` +
              `multi-recipient API builds its own MIME — which would mean the bytes sent are not the ` +
              `bytes recorded. Nothing was submitted.`,
          };
        }

        const message = new EmailMessage(
          request.from,
          recipients[0]!,
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

/**
 * Which adapter carries this Node's mail (#86, ADR 33).
 *
 * **The binding when it exists, and that is a preference with a reason rather than an ordering.** It needs
 * no credential at all, so a Node using it holds nothing that could leak and nothing to rotate; and it is
 * the only path that can carry `authored` fidelity, which is what customer mail uses because the record must
 * prove the exact bytes. Reaching for the REST API while a binding is present would trade both away for
 * nothing.
 *
 * The REST adapter is therefore the answer to one question: *what does a Node do when it has no binding?*
 * Before #86 the answer was "nothing, permanently" — the binding arrives by editing `wrangler.jsonc` and
 * redeploying, which a Node whose operator cannot redeploy it cannot do.
 *
 * **Falling back to the binding when neither is available is deliberate**, and it is not a coin toss. Its
 * refusal — *"This Node has no EMAIL binding, so it cannot send"* — names the thing an operator should
 * install, where the REST adapter's would name a token that is the second-best answer. The most useful
 * refusal wins.
 *
 * Asynchronous because "is REST configured" is a D1 read. That is one statement on a path that is already
 * reading the manifest, and the alternative — caching the answer — is a Node that goes on believing it
 * cannot send after somebody gives it a token.
 */
export async function chooseTransport(env: Env): Promise<TransportAdapter> {
  if (env.EMAIL !== undefined) return cloudflareTransport;
  const { restTransport, restConfigured } = await import("./rest-transport.ts");
  return (await restConfigured(env)) === null ? cloudflareTransport : restTransport;
}
