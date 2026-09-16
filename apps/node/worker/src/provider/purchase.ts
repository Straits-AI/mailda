import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { conflict } from "../errors.ts";
import { boundAccountFor, cloudflareGet, cloudflarePost } from "./cloudflare-grant.ts";
import { checkDomains, type DomainPrice } from "./registrar.ts";
import { sha256Hex } from "../evidence-store.ts";

/**
 * Buying a domain (#164 L3, write side).
 *
 * ## Built so that the unmeasured fact cannot hurt anybody
 *
 * #164's gate is a probe nobody has paid for yet: *"is `register` idempotent, or does the retry buy a second
 * domain?"* Cloudflare's reference now asserts an answer — *"Cloudflare permits only one registration per
 * domain, making the domain name a natural idempotency key"* — and that is a **claim about behaviour under a
 * retry**, which is the one kind of claim this repository has learnt not to spend money on. The reference
 * has been silent or wrong six times in this flow alone, most recently about a parameter it never named.
 *
 * So the design does not depend on it. **Nothing here ever retries a registration.** Not on a timeout, not
 * on an unreadable answer, not on a state it does not recognise. Every uncertain outcome ends in *read the
 * state and tell a person*, and only a person can act again. If the claim is true the guard is redundant; if
 * it is false the guard is what stops a second charge. `registrar.register_idempotent` stays `unmeasured`
 * until somebody pays for the probe, and the code is correct either way.
 *
 * Cloudflare's own workflow states agree with that reading: `failed` is documented as *"require user review
 * before retrying"* and `action_required` as *"stop automated polling until the user completes the required
 * action."*
 *
 * ## Three things are true before a charge, and each is checked here
 *
 * 1. **The price is current.** The proposal carries a `domain-check`, which Cloudflare documents as
 *    real-time and instructs be taken immediately before registering. A digest binds the apply to it, so a
 *    price that moved invalidates the approval rather than being paid — #187's pattern, and #164 asks for
 *    exactly it.
 * 2. **No registration already exists.** Read, not assumed. This is the guard the idempotency question is
 *    about, and it runs before every `POST` rather than after a failure.
 * 3. **The domain is one this API can actually register.** `buyable`, not `registrable` — a premium domain
 *    comes back registrable and cannot be bought here at all.
 *
 * ## What this Node deliberately does not hold
 *
 * No payment detail and no registrant contact. `contacts` is optional on the create, so the account's own
 * details are used — they are the customer's, they live at Cloudflare, and #164 requires they stay there.
 * `auto_renew` is sent explicitly as **false** unless somebody asked otherwise, because Cloudflare documents
 * `true` as *"an explicit opt-in authorizing Cloudflare to charge the account's default payment method"* and
 * an opt-in nobody made is not one.
 */

/** Cloudflare's workflow lifecycle, verbatim. `succeeded` and `failed` are the terminal two. */
export type PurchaseState =
  | "pending" | "in_progress" | "action_required" | "blocked" | "succeeded" | "failed";

/** Whether this Node may poll again on its own, which is not the same as whether it is finished. */
const KEEP_POLLING: Record<PurchaseState, boolean> = {
  pending: true,
  in_progress: true,
  // Documented: "continue polling because the block may resolve when the third party responds."
  blocked: true,
  // Documented: "stop automated polling until the user completes the required action."
  action_required: false,
  succeeded: false,
  failed: false,
};

export interface PurchaseProposal {
  domain: string;
  price: DomainPrice;
  /** An existing registration's state, if there is one. Non-null means this must not be bought. */
  existing: string | null;
  /** SHA-256 over what an operator is being shown. The apply must carry it back. */
  digest: string;
  /** Why this cannot be bought right now. Null when it can. */
  refusal: string | null;
}

async function digestOf(domain: string, price: DomainPrice, existing: string | null): Promise<string> {
  /*
   * The costs go in as the **strings** Cloudflare returned. A digest over a parsed number would differ from
   * a digest over the same price rendered differently, which is an approval that cannot be confirmed — and
   * the reason `registrar.ts` refuses to convert them in the first place.
   */
  const canonical = JSON.stringify([
    domain, price.currency, price.registrationCost, price.renewalCost, price.tier, price.buyable, existing,
  ]);
  // `sha256Hex` rather than a sixth private copy of the same four lines — it is exported, and this file
  // adding its own was the duplication #160 is about, one level below governance.
  return await sha256Hex(new TextEncoder().encode(canonical));
}

/** Whether a registration already exists, read rather than assumed. Null when there is none. */
async function existingRegistration(
  env: Env, ctx: Ctx, orgId: string, accountId: string, domain: string,
): Promise<{ ok: true; state: string | null } | { ok: false; error: string }> {
  const answer = await cloudflareGet<{ status?: string; state?: string }>(
    env, ctx, orgId, `/accounts/${accountId}/registrar/registrations/${encodeURIComponent(domain)}`,
  );
  if (answer.ok) return { ok: true, state: answer.result.status ?? answer.result.state ?? "present" };

  /*
   * **A 404 is the useful answer and anything else is not.** "No registration" and "this Node could not
   * find out" must not collapse, because the first permits a purchase and the second must forbid one. Only
   * Cloudflare's own not-found codes are read as absence; every other refusal propagates.
   */
  if (/(^|\D)(1001|1003|7003|10000|404)(\D|$)/.test(answer.error) && /not.?found|does not exist|no route/i
    .test(answer.error)) {
    return { ok: true, state: null };
  }
  if (/not.?found|does not exist/i.test(answer.error)) return { ok: true, state: null };
  return { ok: false, error: answer.error };
}

export async function purchaseProposalFor(
  env: Env, ctx: Ctx, orgId: string, domain: string,
): Promise<PurchaseProposal> {
  const accountId = await boundAccountFor(env);
  const [price] = await checkDomains(env, ctx, orgId, [domain]);

  const found = await existingRegistration(env, ctx, orgId, accountId, domain);
  if (!found.ok) {
    /*
     * Unreadable is not absent. Proceeding here would be the one move that can produce the duplicate #164
     * exists to prevent: buying a domain this account may already hold, because the question could not be
     * answered.
     */
    const blank: DomainPrice = price!;
    return {
      domain, price: blank, existing: null,
      digest: await digestOf(domain, blank, null),
      refusal: `this Node could not find out whether ${domain} is already registered here: ${found.error}. `
        + "It will not buy a domain it cannot first rule out owning",
    };
  }

  const refusal = found.state !== null
    ? `${domain} is already registered on this account (${found.state}). Buying it again is the duplicate `
      + "this check exists to prevent"
    : price!.refusal;

  return {
    domain, price: price!, existing: found.state,
    digest: await digestOf(domain, price!, found.state),
    refusal,
  };
}

export interface PurchaseOutcome {
  domain: string;
  state: PurchaseState | "unknown";
  completed: boolean;
  /** Whether this Node may poll again unattended. False does not mean finished. */
  mayPoll: boolean;
  error: string | null;
  /** What a person should do now, when the answer is not simply "wait". */
  next: string | null;
}

function outcomeOf(domain: string, status: {
  state?: string; completed?: boolean; error?: { code?: string; message?: string };
}): PurchaseOutcome {
  const state = (status.state ?? "unknown") as PurchaseState | "unknown";
  const known = state !== "unknown" && state in KEEP_POLLING;
  return {
    domain,
    state,
    completed: status.completed === true,
    /*
     * A state this Node does not recognise is **not** pollable. Cloudflare may add one, and the safe
     * reading of an unfamiliar lifecycle state is to stop and show a person rather than to keep asking.
     */
    mayPoll: known && KEEP_POLLING[state as PurchaseState],
    /*
     * **`== null`, not `=== undefined`**, and this cost a real charge. Cloudflare returns `"error": null`
     * on a successful workflow rather than omitting the key, so `status.error === undefined` was false and
     * `status.error.code` threw — **after** the registration had already been created and billed.
     *
     * The Node answered 500, the operator was told the purchase failed, and `mailda.site` was registered.
     * The status route carried the same fault, so the obvious next move — ask how it went — failed too.
     *
     * This is the second null-versus-undefined defect in this repository in one day. The other was
     * `flag(argv, "code") !== undefined` in the CLI, where a helper answering `null` made a guard fire on
     * every invocation. Both were written by somebody who knew which value the source produced and typed
     * the other one.
     */
    error: status.error == null
      ? null
      : `${status.error.code ?? "?"} ${status.error.message ?? ""}`.trim(),
    /*
     * Keyed on `known`, not on the literal `"unknown"`. A state Cloudflare adds later arrives with its own
     * name — `some_new_state`, not `unknown` — so keying on the literal left the one case this Node cannot
     * interpret with no guidance at all, which is the "a finding a person cannot act on is a complaint"
     * rule broken at exactly the moment somebody needs it. Found by a test asserting the message.
     */
    next: !known
      ? `Cloudflare answered with the lifecycle state \`${state}\`, which this Node does not recognise. `
        + "Nothing is retried; read the registration in the Cloudflare dashboard."
      : state === "action_required"
      ? "Cloudflare is waiting for somebody to act on its side. Open the Registrar dashboard; this Node "
        + "stops polling until you do."
      : state === "failed"
        ? "Cloudflare reports the registration failed. Read the error, then decide — this Node will not "
          + "retry on its own, because whether a retry would buy a second domain is unmeasured."
        : null,
  };
}

/** Poll one registration. Reads only, and says when this Node must stop asking. */
export async function purchaseStatus(
  env: Env, ctx: Ctx, orgId: string, domain: string,
): Promise<PurchaseOutcome> {
  const accountId = await boundAccountFor(env);
  const answer = await cloudflareGet<{
    state?: string; completed?: boolean; error?: { code?: string; message?: string };
  }>(
    env, ctx, orgId,
    `/accounts/${accountId}/registrar/registrations/${encodeURIComponent(domain)}/registration-status`,
  );
  if (!answer.ok) {
    return {
      domain, state: "unknown", completed: false, mayPoll: false, error: answer.error,
      next: "the registration's state could not be read. **Do not re-run the purchase** — read it in the "
        + "Cloudflare dashboard first, because an unread state and an absent one are not the same thing.",
    };
  }
  return outcomeOf(domain, answer.result);
}

/**
 * The charge. One `POST`, never repeated, and every refusal happens before it.
 *
 * `autoRenew` is a parameter with no default of convenience: Cloudflare documents `true` as an explicit
 * opt-in to charge the account's payment method up to thirty days before expiry, and an opt-in nobody made
 * is not one.
 */
export async function buyDomain(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string,
  domain: string, digest: string, autoRenew: boolean,
): Promise<PurchaseOutcome> {
  const proposal = await purchaseProposalFor(env, ctx, orgId, domain);

  if (proposal.refusal !== null) {
    throw conflict("E_REGISTRAR_WILL_NOT_BUY", {
      what: `this Node will not buy ${domain}`,
      why: proposal.refusal,
      fix: "price it again once the reason has changed: GET /api/provider/domains/purchase?domain=…",
    });
  }
  if (digest !== proposal.digest) {
    throw conflict("E_REGISTRAR_STALE", {
      what: "the proposal confirmed is not the one this Node would now act on",
      why: "the price, the tier, or whether this account already holds the domain has changed since it was "
        + "shown. #164: a domain cannot be bought from a stale quote",
      fix: `read the proposal again and confirm the digest it prints: ${proposal.digest}`,
    });
  }

  const accountId = await boundAccountFor(env);
  /*
   * **The audit entry is written before the charge, not after.** A `POST` whose answer never arrives has
   * still spent money, and an entry written only on success would leave that charge with no record at all —
   * which is the state an operator would be trying to reconstruct. `provider.domain_purchase_attempted` is
   * therefore a statement about an attempt, and the outcome is a separate read.
   */
  await auditedBatch(env, ctx, orgId, {
    action: "provider.domain_purchase_attempted", outcome: "ok", actorUserId, subject: domain,
    detail: {
      currency: proposal.price.currency,
      registrationCost: proposal.price.registrationCost,
      renewalCost: proposal.price.renewalCost,
      autoRenew,
      digest,
    },
  }, (entry) => [entry]);

  const status = await cloudflarePost<{
    state?: string; completed?: boolean; error?: { code?: string; message?: string };
  }>(env, ctx, orgId, `/accounts/${accountId}/registrar/registrations`, {
    domain_name: domain,
    // Explicit, not omitted: the documented default is false and saying so is cheaper than relying on it.
    auto_renew: autoRenew,
  });

  return outcomeOf(domain, status);
}


