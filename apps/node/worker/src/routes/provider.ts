import { unprocessable } from "../errors.ts";
import { isAdmin } from "../access.ts";
import type { Some } from "../router.ts";
import type { Ctx } from "@mailda/runtime";
import { withOperator } from "../provider/cloudflare-api.ts";

/**
 * An operator's own Cloudflare credential for this one request, from two headers (25 September 2026).
 *
 * `x-cloudflare-token` and `x-cloudflare-account`: `mailda install` sends wrangler's login token and the
 * account it settled, so a Node can be set up to receive, send and observe outcomes at install with a
 * consent the operator already gave, before or instead of the Node's own token. Administrator-only routes
 * carry it, the token is used for the request and never stored, and the audit entry says `operator` did it.
 * Headers rather than body fields so the proposal `GET`s can carry it without a token in a query string.
 */
function operatorCtx(request: Request, clock: Ctx): Ctx {
  const token = request.headers.get("x-cloudflare-token");
  const accountId = request.headers.get("x-cloudflare-account");
  if (token === null || token.trim() === "") return clock;
  if (accountId === null || !/^[0-9a-f]{32}$/.test(accountId)) {
    throw unprocessable("E_PROVIDER_OPERATOR_ACCOUNT_MISSING", {
      what: "x-cloudflare-token was sent without a valid x-cloudflare-account",
      why: "the account is the boundary every read is kept inside, and an operator token can see several",
      fix: "send x-cloudflare-account with the 32-hex account id the token should act in",
    });
  }
  return withOperator(clock, { token: token.trim(), accountId });
}

export const provider = {
  /**
   * The Node's own Cloudflare credential (#162 L1, ADR 42 as reopened on 26 September 2026).
   *
   * `GET    /api/provider`        — the state, what has been set up, the permissions to tick, and no secret
   * `PUT    /api/provider/token`  — verify an API token, bind it to the one account it sees, hold it wrapped
   * `DELETE /api/provider/token`  — forget it
   *
   * Administrator-gated, and for a stronger reason than the transport's: this decides which Cloudflare
   * account the Node can act in, and every later provisioning act inherits it.
   */
  "GET /api/provider": async ({ env, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { providerStatus, provisionedFacts, REQUIRED_PERMISSIONS, PROVIDER_NOTE } = await import("../provider/cloudflare-grant.ts");
    return Response.json({
      provider: await providerStatus(env),
      // What the install or a token has been observed to set up, from the audit trail (structured, dated).
      provisioned: await provisionedFacts(env, who.orgId),
      // The list an operator ticks in Cloudflare's token form, beside the state, because an operator in
      // `no_token` needs it and one in `token_held` checks a replacement against it.
      permissions: REQUIRED_PERMISSIONS,
      note: PROVIDER_NOTE,
    });
  },

  "PUT /api/provider/token": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as { token?: unknown; accountId?: unknown };
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (token === "") {
      throw unprocessable("E_PROVIDER_TOKEN_MISSING", {
        what: "no token was sent",
        why: "a connection is a token; there is nothing to verify without one",
        fix: "send { token } — the value Cloudflare showed once when the token was created",
      });
    }
    const { registerToken } = await import("../provider/cloudflare-grant.ts");
    const provider = await registerToken(env, clock, who.orgId, who.userId, {
      token, ...(typeof body.accountId === "string" ? { accountId: body.accountId } : {}),
    });
    return Response.json({ provider });
  },

  "DELETE /api/provider/token": async ({ env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { forgetToken } = await import("../provider/cloudflare-grant.ts");
    return Response.json({ provider: await forgetToken(env, clock, who.orgId, who.userId) });
  },

  "GET /api/provider/email-routing": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    /*
     * A `GET` that **spends the credential** — it calls Cloudflare three times per
     * domain. Declared `operator` in the agent registry for that reason: the derivation rule would
     * otherwise offer it as an ordinary read, and an agent polling it would be spending the account's
     * authority to answer a question nothing it may do depends on.
     */
    const { emailRoutingState } = await import("../provider/cloudflare-grant.ts");
    return Response.json({ routing: await emailRoutingState(env, operatorCtx(request, clock), who.orgId) });
  },

  "GET /api/provider/delivery-events": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    /*
     * `operator` for `/api/provider/email-routing`'s reason: it spends the credential. This is the surface
     * `doctor`'s `sending_events_consumer` points at, which is why that finding can now name which of the
     * three objects is missing instead of saying the question is unanswerable from here.
     */
    const { deliveryEventsState } = await import("../provider/cloudflare-grant.ts");
    return Response.json({ delivery: await deliveryEventsState(env, operatorCtx(request, clock), who.orgId) });
  },

  "GET /api/provider/domains/purchase": async ({ env, clock, url, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { purchaseProposalFor } = await import("../provider/purchase.ts");
    return Response.json({
      proposal: await purchaseProposalFor(
        env, clock, who.orgId, url.searchParams.get("domain") ?? "",
      ),
    });
  },

  "GET /api/provider/domains/purchase/status": async ({ env, clock, url, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { purchaseStatus } = await import("../provider/purchase.ts");
    return Response.json({
      outcome: await purchaseStatus(env, clock, who.orgId, url.searchParams.get("domain") ?? ""),
    });
  },

  "POST /api/provider/domains/purchase": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    /*
     * **The only route in this Node that spends money.** Every refusal is in `buyDomain` and happens
     * before the charge; `autoRenew` is read from the body with no default, because Cloudflare documents
     * `true` as an explicit opt-in to bill the account and an opt-in nobody made is not one.
     */
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { buyDomain } = await import("../provider/purchase.ts");
    return Response.json({
      outcome: await buyDomain(
        env, clock, who.orgId, who.userId,
        String(body.domain ?? ""), String(body.digest ?? ""), body.autoRenew === true,
      ),
    });
  },

  "GET /api/provider/domains": async ({ env, clock, url, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { searchDomains } = await import("../provider/registrar.ts");
    /*
     * `cached: true` is a constant in the response rather than a note in the summary, because this is the
     * list a caller is most likely to build a purchase on and Cloudflare is explicit that it must not be.
     * A field that travels with the data is harder to skip than a sentence in a document.
     */
    return Response.json({
      suggestions: await searchDomains(env, clock, who.orgId, url.searchParams.get("q") ?? ""),
      cached: true,
    });
  },

  "POST /api/provider/domains/check": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const asked = Array.isArray(body.domains) ? body.domains.map((one) => String(one)) : [];
    const { checkDomains } = await import("../provider/registrar.ts");
    /*
     * `checkedAt` is this Node's clock at the moment of the read, and it is in the response because the
     * whole point of this route is that its answer expires. An approval built on it has to be able to say
     * how old the quote was.
     */
    return Response.json({
      domains: await checkDomains(env, clock, who.orgId, asked),
      checkedAt: new Date(clock.now()).toISOString(),
    });
  },

  "GET /api/provider/receiving": async ({ request, env, clock, url, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { receivingProposalFor } = await import("../provider/receiving.ts");
    return Response.json({
      proposal: await receivingProposalFor(
        env, operatorCtx(request, clock), who.orgId, url.searchParams.get("domain") ?? "",
      ),
    });
  },

  "POST /api/provider/receiving": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    /*
     * **The route that writes DNS on the customer's zone**, which is the largest authority this Node
     * holds. Every refusal is in `onboardReceiving` and happens before the first record, and the routing
     * rule is written only after the records are read back — because a rule without them is accepted by
     * Cloudflare and never matches.
     */
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { onboardReceiving } = await import("../provider/receiving.ts");
    return Response.json({
      outcome: await onboardReceiving(
        env, operatorCtx(request, clock), who.orgId, who.userId,
        String(body.domain ?? ""), String(body.digest ?? ""), String(body.address ?? ""),
        typeof body.mailboxId === "string" ? body.mailboxId : null,
        body.catchAll === true,
      ),
    });
  },

  "POST /api/addresses": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    /*
     * An address and its routing in one act (25 September 2026). Reads the operator headers like the
     * provisioning routes, because the rule it may write is the same rule the receiving step writes.
     */
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { addAddress } = await import("../provider/receiving.ts");
    return Response.json(await addAddress(
      env, operatorCtx(request, clock), who.orgId, who.userId,
      String(body.address ?? ""), typeof body.mailboxId === "string" ? body.mailboxId : null,
    ));
  },

  "GET /api/provider/routing-rules": async ({ request, env, clock, url, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { routingRulesFor } = await import("../provider/routing-rules.ts");
    return Response.json({
      routing: await routingRulesFor(env, operatorCtx(request, clock), who.orgId, url.searchParams.get("domain") ?? ""),
    });
  },

  "POST /api/provider/routing-rules/take-over": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    // Replaces one rule's action on the customer's zone (#258). The previous action rides on the audit entry.
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { takeOverRule } = await import("../provider/routing-rules.ts");
    return Response.json({
      outcome: await takeOverRule(
        env, operatorCtx(request, clock), who.orgId, who.userId,
        String(body.domain ?? ""), String(body.ruleId ?? ""), String(body.digest ?? ""),
        typeof body.mailboxId === "string" ? body.mailboxId : null,
      ),
    });
  },

  "POST /api/provider/routing-rules/put-back": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { putBackRule } = await import("../provider/routing-rules.ts");
    return Response.json({
      outcome: await putBackRule(
        env, operatorCtx(request, clock), who.orgId, who.userId, String(body.domain ?? ""), String(body.ruleId ?? ""),
      ),
    });
  },

  "GET /api/provider/handover": async ({ env, clock, url, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    /*
     * `url.origin` rather than a configured hostname: the manifest tells a client where to fetch the
     * verification key, and the only origin this Node knows to be reachable is the one it was reached on.
     */
    const { handoverManifest } = await import("../provider/handover.ts");
    return Response.json(await handoverManifest(env, clock, who.orgId, url.origin));
  },

  "GET /api/provider/ownership": async ({ env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    // Asked for rather than rendered: two Cloudflare calls and possibly a renewal, per request.
    const { ownershipFacts } = await import("../provider/cloudflare-grant.ts");
    return Response.json({ ownership: await ownershipFacts(env, clock, who.orgId) });
  },

  "GET /api/provider/sending": async ({ request, env, clock, url, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const domain = url.searchParams.get("domain") ?? "";
    if (domain === "") {
      throw unprocessable("E_PROVIDER_SENDING_DOMAIN_MISSING", {
        what: "this route answers about one domain and none was named",
        why: "a proposal with no subject would be a digest over nothing, confirmable against anything",
        fix: "pass ?domain=<the domain to onboard for sending>",
      });
    }
    const { sendingProposalFor } = await import("../provider/cloudflare-grant.ts");
    return Response.json({ proposal: await sendingProposalFor(env, operatorCtx(request, clock), who.orgId, domain) });
  },

  "POST /api/provider/sending": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    /*
     * The one route that **changes the customer's Cloudflare account**. Its whole defence is in
     * `onboardSending`: the proposal is recomputed there and the digest must match it, so a stale proposal
     * or one aimed at a different domain refuses rather than applies.
     */
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { onboardSending } = await import("../provider/cloudflare-grant.ts");
    return Response.json({
      proposal: await onboardSending(
        env, operatorCtx(request, clock), who.orgId, who.userId, String(body.domain ?? ""), String(body.digest ?? ""),
      ),
    });
  },

  "GET /api/provider/subscription": async ({ request, env, clock, url, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const domain = url.searchParams.get("domain") ?? "";
    if (domain === "") {
      throw unprocessable("E_PROVIDER_SUBSCRIPTION_DOMAIN_MISSING", {
        what: "this route answers about one domain and none was named",
        why: "a proposal with no subject would be a digest over nothing, confirmable against anything",
        fix: "pass ?domain=<the sending domain whose delivery events this Node should receive>",
      });
    }
    const { subscriptionProposalFor } = await import("../provider/cloudflare-grant.ts");
    return Response.json({ proposal: await subscriptionProposalFor(env, operatorCtx(request, clock), who.orgId, domain) });
  },

  "POST /api/provider/subscription": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    // Changes the customer's Cloudflare account, with `POST /api/provider/sending`'s defence: the proposal
    // is recomputed in `subscribeDeliveryEvents` and the digest must match it.
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { subscribeDeliveryEvents } = await import("../provider/cloudflare-grant.ts");
    return Response.json({
      proposal: await subscribeDeliveryEvents(
        env, operatorCtx(request, clock), who.orgId, who.userId, String(body.domain ?? ""), String(body.digest ?? ""),
      ),
    });
  },
} satisfies Some;
