import { unwrapCredential } from "../auth/kek.ts";
import {
  type SubmitOutcome, type SubmitRequest, type TransportAdapter, type TransportCapability,
} from "./transport.ts";

/**
 * Cloudflare Email Sending over HTTP — the second adapter (#86, ADR 33).
 *
 * ADR 33 locks *"the transport offers **both** send APIs, and every send records which one carried it."* The
 * recording half was built and correct — `recheck.ts` puts `adapter` on the sealed envelope — and had
 * exactly one possible value, so a question the envelope was designed to answer had one answer for every
 * send ever made.
 *
 * ## What this adapter can and cannot carry, which is the whole shape of it
 *
 * `POST /accounts/{account_id}/email/sending/send` takes **structured JSON** — `to`, `from`, `subject`,
 * `html`, `text`, `cc`, `bcc`, `replyTo`, `attachments`, `headers` — and **no raw MIME**. Checked against
 * Cloudflare's own documentation rather than assumed, because it decides what this file is for:
 *
 * **It cannot serve `authored` fidelity, and refuses it rather than approximating it.** ADR 33 requires
 * authored submission for customer mail because the record must prove exactly what was sent, and an API that
 * builds its own MIME cannot make the bytes stored and the bytes submitted the same object.
 * `dispatch.ts`'s own header already reached this conclusion about the structured Workers API for the same
 * reason; the REST endpoint is that API over HTTP, so the conclusion transfers unchanged.
 *
 * ## Two of the ticket's three arguments for it did not survive, and that is recorded rather than glossed
 *
 * #86 argued the REST endpoint takes structured recipients in one request where the binding takes one per
 * call — fifty recipients being fifty subrequests. **Both halves of that are already answered in this tree,
 * against it:**
 *
 * - `dispatch.ts` submits **once per recipient on purpose**, because migration 0013 makes the *delivery* the
 *   unit. Per-recipient submission is what makes a correct Bcc possible, what lets a retry reach only the
 *   recipients that never left, and what gives each delivery its own recorded outcome. Batching would
 *   collapse all of that into one verdict for the group.
 * - and it would save nothing: *"measured before choosing: one structured send to three recipients moved
 *   Cloudflare's own count from 0 to 3, so submitting N times costs nothing extra."*
 *
 * So this adapter deliberately does **not** batch. What is left is narrower than the ticket claimed and
 * still worth having:
 *
 * 1. **A Node with no `send_email` binding can send.** The binding is added by editing `wrangler.jsonc`; the
 *    REST path needs no binding at all, which is the only way a Node that cannot be redeployed can be made
 *    to speak.
 * 2. **Cloudflare's documented outcome, per recipient.** The response carries `delivered`,
 *    `permanent_bounces` and `queued`, which the binding does not report at all — so a `permanent_bounce`
 *    known at submit becomes `suppressed` here instead of an optimistic `handed_over`.
 * 3. **`adapter` on the envelope becomes informative**, which is the half of ADR 33 that was already built.
 *
 * ## The credential is not a Secrets Store binding, and that is ADR 24 rather than a shortcut
 *
 * This is the first credential authorizing an external effect this Node has held, so it is the first real
 * test of ADR 22 — and the rule as written does not survive ADR 24. Migration 0036 carries the argument. The
 * token is wrapped under the credential KEK, read here with `await unwrapCredential(...)` at the moment of
 * use, and is never a property of `env` — which is the property ADR 22 was actually buying and the one ADR 28
 * says survives intact.
 */

/** Where the token and account id live. `null` when this Node has never been given either. */
interface RestCredentials {
  accountId: string;
  token: string;
}

/**
 * Reads and unwraps the credentials, or answers that there are none.
 *
 * One statement and one decrypt, on the send path, per submission. Not cached: a cached transport token is a
 * secret with a lifetime beyond the call that needed it, which is the exact property ADR 22 exists to
 * prevent, and the alternative saving is one indexed read of a one-row table.
 */
async function credentials(env: Env): Promise<RestCredentials | null> {
  const row = await env.CATALOG.prepare(
    "SELECT account_id, api_token FROM sending_transport WHERE id = 1",
  ).first<{ account_id: string; api_token: string }>().catch(() => null);
  if (row === null) return null;
  return { accountId: row.account_id, token: await unwrapCredential(env, row.api_token) };
}

/** Whether this Node has been given REST credentials at all. Reads no secret, so `doctor` may call it. */
export async function restConfigured(env: Env): Promise<{ accountId: string; at: string } | null> {
  const row = await env.CATALOG.prepare(
    "SELECT account_id, configured_at FROM sending_transport WHERE id = 1",
  ).first<{ account_id: string; configured_at: string }>().catch(() => null);
  return row === null ? null : { accountId: row.account_id, at: row.configured_at };
}

/**
 * Cloudflare's own error families, mapped onto the four outcomes.
 *
 * The mapping is not cosmetic and this is where conflating the outcomes would happen. **An HTTP error with a
 * JSON body provably never sent**, so it is `refused` and safe to retry once the cause is fixed; a network
 * failure or a timeout is `outcome_unknown`, which ADR 40 forbids retrying automatically because Cloudflare
 * offers no idempotency key to deduplicate against.
 *
 * Unrecognised codes become `outcome_unknown` rather than `refused`, deliberately — the same default
 * `classifyError` takes for the binding. The safe answer to an unclassifiable failure is the state that
 * forbids automatic retry, not the one that permits it.
 */
export function classifyRestError(status: number, code: number | null, message: string): SubmitOutcome {
  if (code === 10105) {
    return {
      kind: "refused",
      retryable: false,
      reason: "Cloudflare answered 10105 not_entitled: this account is not entitled to Email Sending. "
        + `Nothing was submitted. ${message}`,
    };
  }
  if (code === 10203) {
    return {
      kind: "refused",
      retryable: false,
      reason: "Cloudflare answered 10203 sending_disabled: Email Sending is disabled for this account or "
        + `domain. Nothing was submitted. ${message}`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "refused",
      retryable: false,
      reason: "Cloudflare rejected the sending API token. It needs the Email Sending: Edit permission on "
        + `this account, and a rotated token must be re-supplied to this Node. Nothing was submitted. ${message}`,
    };
  }
  if (status === 429) {
    // Provably never left, so automatic retry is safe — the one outcome for which that is true.
    return { kind: "throttled", reason: `Cloudflare answered 429. ${message}` };
  }
  if (status >= 400 && status < 500) {
    return { kind: "refused", retryable: false, reason: `Cloudflare answered ${status}. ${message}` };
  }
  /*
   * 5xx and anything else. A server error is **not** provably a non-send: Cloudflare may have accepted the
   * message and failed to answer, so this is the state that forbids a retry rather than the one that invites
   * a duplicate the recipient keeps for ever.
   */
  return { kind: "outcome_unknown", reason: `Cloudflare answered ${status}. ${message}` };
}

export const restTransport: TransportAdapter = {
  name: "cloudflare-email-rest",

  async capability(env: Env): Promise<TransportCapability> {
    const configured = await restConfigured(env);
    if (configured === null) {
      return {
        canSend: false,
        arbitraryRecipients: false,
        verifiedAt: null,
        detail: "No sending API token. This Node cannot use the REST send API — supply an account id and a "
          + "token with the Email Sending: Edit permission (PUT /api/transport).",
      };
    }

    /*
     * `canSend: true` here, and it is a **weaker** claim than the binding adapter's — said plainly because
     * the two fields look identical on the envelope.
     *
     * What is known is that credentials exist. Whether the account is entitled and whether a sending domain
     * is onboarded are the two gates ADR 34 records as unanswerable before a send, and the REST endpoint
     * does not answer them either: `10105 not_entitled` arrives *after* committing a message. So this
     * reports what it knows, `verifiedAt` stays null exactly as it does for the binding, and the honest
     * sentence is in `detail` rather than in a boolean.
     */
    return {
      canSend: true,
      arbitraryRecipients: false,
      verifiedAt: null,
      detail: `A sending API token is configured for account ${configured.accountId} (since `
        + `${configured.at}). Whether that account is entitled and whether a sending domain is onboarded `
        + "are still not knowable before a send: Cloudflare reports 10105 not_entitled only in response to "
        + "one. This adapter carries reconstructed sends only — an authored send's record must prove the "
        + "exact bytes, and this API builds its own MIME.",
    };
  },

  async submit(env, request: SubmitRequest, fidelity): Promise<SubmitOutcome> {
    if (fidelity === "authored") {
      return {
        kind: "refused",
        retryable: false,
        reason: "The REST send API accepts structured fields and no raw MIME, so it cannot carry an "
          + "authored send: the bytes submitted would not be the bytes recorded, which is the one thing "
          + "authored fidelity exists to guarantee (ADR 33). Nothing was submitted. Add a send_email "
          + "binding to send authored mail.",
      };
    }

    const creds = await credentials(env);
    if (creds === null) {
      return {
        kind: "refused",
        retryable: false,
        reason: "This Node has no sending API token, so the REST transport cannot send.",
      };
    }

    let response: Response;
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(creds.accountId)}`
        + "/email/sending/send",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${creds.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: request.from,
            to: request.to,
            ...(request.cc === undefined || request.cc.length === 0 ? {} : { cc: request.cc }),
            ...(request.bcc === undefined || request.bcc.length === 0 ? {} : { bcc: request.bcc }),
            subject: request.subject,
            text: request.text ?? "",
          }),
        },
      );
    } catch (error) {
      /*
       * The request never completed, so whether Cloudflare received it is unknown. `outcome_unknown` rather
       * than `refused`: a refusal claims the message provably never left, and a socket that closed
       * mid-request cannot claim that.
       */
      return {
        kind: "outcome_unknown",
        reason: `The request to Cloudflare did not complete: ${(error as Error).message}`,
      };
    }

    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      errors?: Array<{ code?: number; message?: string }>;
      result?: { delivered?: string[]; permanent_bounces?: string[]; queued?: string[] };
    } | null;

    if (!response.ok || body?.success !== true) {
      const first = body?.errors?.[0];
      return classifyRestError(response.status, first?.code ?? null, first?.message ?? "");
    }

    /*
     * The one thing this adapter knows that the binding does not: Cloudflare reports the outcome **per
     * recipient**, and a permanent bounce is knowable now rather than by a later event.
     *
     * `dispatch.ts` submits one recipient at a time, so these arrays hold at most one address — which is why
     * a bounce can be reported as `suppressed` for *this* delivery rather than having to be attributed. A
     * batching adapter could not do that, which is a second reason not to batch.
     */
    if ((body.result?.permanent_bounces?.length ?? 0) > 0) {
      return {
        kind: "suppressed",
        reason: "Cloudflare reported a permanent bounce at submission, so this address will never receive "
          + "it. Reported by the REST API and not by the binding, which is why this send records that "
          + "adapter.",
      };
    }

    return { kind: "handed_over", transportMessageId: "unreported" };
  },
};
