import { unprocessable } from "../errors.ts";
import { isAdmin } from "../access.ts";
import type { Some } from "../router.ts";

export const provider = {
  /**
   * The Node's own Cloudflare grant (#162 L1, ADR 42).
   *
   * `GET  /api/provider`             — the connection state, the guided ceremony, and no secret
   * `PUT  /api/provider/client`      — the client id and secret the operator created in the dashboard
   * `POST /api/provider/authorize`   — mint a state and a PKCE challenge, and answer with the URL
   * `POST /api/provider/unselectable`— record that the consent screen did not list the operator's account
   * `GET  /oauth/cloudflare/callback`— where Cloudflare sends the authorization response
   *
   * Administrator-gated except the callback, and for a stronger reason than the transport's: this decides
   * which Cloudflare account the Node can act in, and every later provisioning act inherits it.
   *
   * **The callback is not gated, and that is deliberate rather than an omission.** It arrives from
   * Cloudflare through the operator's browser, and requiring a Mailda session would fail whenever the
   * consent was completed in a different browser profile — which is common, because the operator may hold
   * their Cloudflare account somewhere other than where they administer their mail. What protects it is the
   * `state` nonce: a callback carrying a state this Node did not issue is refused, and one carrying a state
   * already spent is refused by the row rather than by a check. That is what the parameter is *for*, and a
   * session check would be a second gate that does not answer the same question.
   */
  "GET /api/provider": async ({ env, url, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { providerStatus, ceremony } = await import("../provider/cloudflare-grant.ts");
    return Response.json({
      provider: await providerStatus(env),
      /*
       * The ceremony is returned beside the state rather than from a second route, because an operator in
       * `no_client` needs the steps and an operator in `consent_granted` needs to be able to check that the
       * redirect URI Cloudflare holds is still the one this Node is reachable on.
       *
       * `url.origin` is the one thing that knows what hostname the operator actually reached this Node on.
       */
      ceremony: ceremony(`${url.origin}/oauth/cloudflare/callback`),
    });
  },

  "PUT /api/provider/client": async ({ request, env, clock, url, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { registerClient, providerStatus } = await import("../provider/cloudflare-grant.ts");
    await registerClient(env, clock, who.orgId, who.userId, {
      clientId: String(body.clientId ?? ""),
      clientSecret: String(body.clientSecret ?? ""),
      /*
       * Derived here and not taken from the body. A redirect URI the caller could choose is a redirect URI
       * an attacker could choose, and the whole value of storing it is that the exchange sends what the
       * authorization used — which has to be this Node's own hostname or Cloudflare refuses it anyway.
       */
      redirectUri: `${url.origin}/oauth/cloudflare/callback`,
    });
    return Response.json({ provider: await providerStatus(env) });
  },

  "POST /api/provider/authorize": async ({ request, env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    /*
     * `REQUIRED_SCOPE_NAMES` unless the caller names its own. The scopes cannot be left out: a request
     * naming none is granted none — measured, the consent screen reads "0 total permissions" with
     * `Authorize` disabled, because a client's registered scopes are a ceiling rather than a default.
     *
     * The override exists because these names come from wrangler's vocabulary rather than from
     * `GET /oauth/scopes`, so an operator whose account offers a different set needs a way to say so
     * without waiting for a release.
     */
    const asked = Array.isArray(body.scopes) ? body.scopes.map((one) => String(one)) : [];
    const { REQUIRED_SCOPE_NAMES } = await import("../provider/cloudflare-grant.ts");
    const scopes = asked.length > 0 ? asked : [...REQUIRED_SCOPE_NAMES];
    const { beginAuthorization } = await import("../provider/cloudflare-grant.ts");
    const begun = await beginAuthorization(env, clock, who.userId, scopes);
    // The URL, not a redirect: the client decides whether to navigate or to show the operator the link.
    return Response.json({ authorize: { url: begun.url } });
  },

  "GET /api/provider/email-routing": async ({ env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    /*
     * A `GET` that **spends the grant** — it may renew a token and it calls Cloudflare three times per
     * domain. Declared `operator` in the agent registry for that reason: the derivation rule would
     * otherwise offer it as an ordinary read, and an agent polling it would be spending the account's
     * authority to answer a question nothing it may do depends on.
     */
    const { emailRoutingState } = await import("../provider/cloudflare-grant.ts");
    return Response.json({ routing: await emailRoutingState(env, clock, who.orgId) });
  },

  "GET /api/provider/delivery-events": async ({ env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    /*
     * `operator` for `/api/provider/email-routing`'s reason: it spends the grant. This is the surface
     * `doctor`'s `sending_events_consumer` points at, which is why that finding can now name which of the
     * three objects is missing instead of saying the question is unanswerable from here.
     */
    const { deliveryEventsState } = await import("../provider/cloudflare-grant.ts");
    return Response.json({ delivery: await deliveryEventsState(env, clock, who.orgId) });
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

  "GET /api/provider/receiving": async ({ env, clock, url, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { receivingProposalFor } = await import("../provider/receiving.ts");
    return Response.json({
      proposal: await receivingProposalFor(
        env, clock, who.orgId, url.searchParams.get("domain") ?? "",
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
        env, clock, who.orgId, who.userId,
        String(body.domain ?? ""), String(body.digest ?? ""), String(body.address ?? ""),
        typeof body.mailboxId === "string" ? body.mailboxId : null,
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

  "GET /api/provider/sending": async ({ env, clock, url, who }) => {
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
    return Response.json({ proposal: await sendingProposalFor(env, clock, who.orgId, domain) });
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
        env, clock, who.orgId, who.userId, String(body.domain ?? ""), String(body.digest ?? ""),
      ),
    });
  },

  "GET /api/provider/subscription": async ({ env, clock, url, who }) => {
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
    return Response.json({ proposal: await subscriptionProposalFor(env, clock, who.orgId, domain) });
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
        env, clock, who.orgId, who.userId, String(body.domain ?? ""), String(body.digest ?? ""),
      ),
    });
  },

  "POST /api/provider/resolve-account": async ({ env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    /*
     * The first route that spends the grant. Separate from `GET /api/provider` because that one describes
     * the binding and this one *uses* it — a read that renewed a token as a side effect of being displayed
     * would make every status page a consumer of the account's authority.
     */
    const { resolveAccount } = await import("../provider/cloudflare-grant.ts");
    return Response.json({ account: await resolveAccount(env, clock, who.orgId) });
  },

  "POST /api/provider/unselectable": async ({ env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { reportUnselectable, providerStatus } = await import("../provider/cloudflare-grant.ts");
    await reportUnselectable(env, clock, who.orgId, who.userId);
    return Response.json({ provider: await providerStatus(env) });
  },

  "GET /oauth/cloudflare/callback": async ({ request, env, clock, url }) => {
    const { completeAuthorization } = await import("../provider/cloudflare-grant.ts");
    const state = url.searchParams.get("state");
    if (state === null || state === "") {
      throw unprocessable("E_PROVIDER_NO_STATE", {
        what: "the callback carried no state parameter",
        why: "the state is what distinguishes a consent this Node started from one somebody else did, so a "
          + "callback without one is not a callback it can act on",
        fix: "start the connection from this Node's own screen rather than by visiting this URL",
      });
    }
    /*
     * The org is read from the claim rather than from a session, because there is no session here — see the
     * route header. A Node has one organization, and the audit entry has to land in it.
     */
    const claim = await env.CATALOG.prepare(
      // The same predicate every other unauthenticated path uses. `id = 1` was wrong: a row exists before
      // it is claimed, so it would have found an org for a Node nobody had finished installing.
      "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
    ).first<{ org_id: string }>().catch(() => null);
    if (claim === null) {
      throw unprocessable("E_PROVIDER_UNCLAIMED", {
        what: "this Node has not been claimed, so a consent has nowhere to be recorded",
        why: "the grant's audit entry belongs to an organization, and an unclaimed Node has none",
        fix: "complete the install first; a Cloudflare grant is not part of claiming a Node",
      });
    }
    const outcome = await completeAuthorization(env, clock, claim.org_id, {
      state,
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
    });
    /*
     * HTML for a browser, JSON for everything else.
     *
     * This route is reached by the operator's browser — that is what a redirect URI is — and it answered
     * with `{"consent":{"ok":true,…}}`. The last step of connecting a Node showed raw JSON to somebody who
     * had been reading English up to that point, and offered no way back.
     *
     * `Accept` rather than a second path, so `mailda provider` and this suite still parse what they parse.
     */
    if ((request.headers.get("accept") ?? "").includes("text/html")) {
      const { consentPage } = await import("../ui.ts");
      return new Response(consentPage(outcome), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return Response.json({ consent: outcome });
  },
} satisfies Some;
