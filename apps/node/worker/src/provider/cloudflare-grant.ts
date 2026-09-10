import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { unwrapCredential, wrapCredential } from "../auth/kek.ts";
import { conflict, unprocessable } from "../errors.ts";

/**
 * The Node's own Cloudflare grant (#162 L1, ADR 42).
 *
 * ## What this is and what it is not
 *
 * ADR 42 struck provision-and-claim, dropped the bootstrap orchestrator with it, and replaced both with the
 * Node as its own **private** OAuth client. A private client is authorizable only by members of the account
 * that created it, so **no Mailda-operated service holds a Cloudflare grant at any point** — which is what
 * makes §1's promise that disconnecting Mailda stops nothing true by construction rather than by policy.
 *
 * This file is the grant: the ceremony, the redirect, the exchange, the refresh, and the states an operator
 * can be in while doing it. Reading the account's inventory and producing a deployment plan are the next
 * layer's and are deliberately not here — a module that both obtained authority and spent it would have no
 * place to put the honest answer *"connected, and nothing has been read yet"*.
 *
 * ## The endpoints are measured, and read from a constant rather than from discovery
 *
 * `docs/receipts/cloudflare-oauth-endpoints.md` records the discovery document these four URLs come from, and
 * the reason they are not fetched at runtime: `dash.cloudflare.com` answers the RFC 8414 path with **HTML**, a
 * 200 carrying the dashboard's shell. A Node that discovered its endpoints by trusting that 200 would parse a
 * web page and fail on the authorization path, at the moment an operator was trying to connect. `doctor`
 * compares these against live discovery instead, which puts the drift check in the thing whose job is
 * detecting drift.
 *
 * That receipt also records a contradiction bearing on this whole design: the discovery document advertises
 * `client_credentials` and a device-code grant, which Cloudflare's documentation says third-party clients
 * cannot use. If a private client *can* use either, ADR 42's browser ceremony is unnecessary. The receipt
 * names the probe that would settle it. Until then this Node does authorization-code, because a Node that
 * trusted the document over the documentation would fail inside the token exchange with an error about the
 * client rather than about the flow.
 */

/**
 * Cloudflare's authorization server, measured.
 *
 * @see docs/receipts/cloudflare-oauth-endpoints.md
 */
export const CLOUDFLARE_OAUTH = {
  issuer: "https://dash.cloudflare.com",
  authorize: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
  /** Where the four above were read from, so `doctor` re-reads the same document rather than a guess. */
  discovery: "https://dash.cloudflare.com/.well-known/openid-configuration",
} as const;

/**
 * **Nothing. This Node names no scope literally, and that is measured.**
 *
 * There used to be `OFFLINE_SCOPE = "offline_access"`, appended to every authorization request on the
 * argument that discovery's `scopes_supported` lists it and that without it there is no refresh token.
 * Both halves were wrong, and one real consent settled it:
 *
 * ```text
 * invalid_scope — The OAuth 2.0 Client is not allowed to request scope 'offline_access'.
 * ```
 *
 * `scopes_supported` describes what the **authorization server** implements; a client may only request what
 * it was registered with, and the dashboard's picker offers Cloudflare permission names rather than OIDC
 * scopes. So appending it did not add a capability, it made every authorization request refusable — and the
 * Node would have failed the ceremony for every operator who followed its own printed steps.
 *
 * The refresh token comes from the client's **grant type**, not from a scope: a client registered with
 * `refresh_token` alongside `authorization_code` gets one. Cloudflare's own documented example lists no
 * `offline_access` in `scopes` either, which is the reading this measurement confirms.
 *
 * @see docs/receipts/cloudflare-oauth-endpoints.md
 */

/**
 * The scopes this Node asks for, as Cloudflare's own scope ids (#162).
 *
 * ## Five readings to get here, and the last one was the documentation being right
 *
 * The shape is **`<group>.<verb>`** — a dot — confirmed against `GET /client/v4/oauth/scopes`:
 * `aiaudit.read`, `access-app.read`, `aig.metadata_read`. Which is exactly the form Cloudflare's own
 * documentation example uses (`workers-platform.read`), and which an earlier version of this comment
 * dismissed as *"the dotted form from Cloudflare's documentation example, which is not the vocabulary in
 * use"* — because `wrangler`'s bundle spells its own scopes with colons.
 *
 * wrangler is a **first-party** client. Its strings are a shorthand nobody else may use: every one of them
 * was refused by a real self-managed client, identically to an invented control. So the documentation was
 * right and this file contradicted it, which is the fifth misreading in this flow and the only one that had
 * the answer in front of it.
 *
 * The others, kept together because the pattern is the point:
 *
 * | read as | actually |
 * |:--|:--|
 * | `grant_types_supported` = what a third-party client may use | what the server implements |
 * | `scopes_supported` = what a client may request | what the server implements |
 * | a client's registered scopes = a default for a request naming none | a **ceiling**; name none, get none |
 * | wrangler's scope list = the provider's vocabulary | what *wrangler* asks for |
 * | the docs' dotted example = not the real format | the real format |
 *
 * **A list of what something supports or uses is not a list of what you may have.** Every one cost a live
 * consent to find out, and each was answerable from `GET /oauth/scopes` — one call, behind a token.
 *
 * ## The ids are singular, and Email Routing is four of them
 *
 * `email-routing-address.write`, not `-addresses`. And Email Routing is not one permission: the account
 * rules are read-only, and addresses, rules and suppressions are separate. So *"read the routing state"* and
 * *"change a rule"* are different asks, which is what L2 will need.
 *
 * ## What this list is
 *
 * The fourteen a real client was registered with, each verified accepted by the authorization endpoint. It is
 * therefore **an operator's selection**, not a minimum: `d1.write` and `queues.write` are here because that
 * is what the picker had checked, where L1 would rather have had the reads Cloudflare does offer.
 * `/api/provider/authorize` takes an override so another Node's operator can send their own set.
 *
 * @see docs/receipts/cloudflare-oauth-scopes.md
 */
export const REQUIRED_SCOPES = [
  {
    scope: "account-settings.read",
    why: "the account's plan. ADR 25 requires Workers Paid, and a Node that cannot read the plan cannot say "
      + "why a deploy will fail before it fails",
    readOnlyExists: true,
  },
  {
    scope: "user-details.read",
    why: "who consented, so the ownership page can say whose grant this is",
    readOnlyExists: true,
  },
  {
    scope: "zone.read",
    why: "which zone would carry mail, and whether a name collides before anything creates one",
    readOnlyExists: true,
  },
  {
    scope: "zone-settings.read",
    why: "the zone's own configuration, which decides whether it can carry mail at all",
    readOnlyExists: true,
  },
  {
    scope: "account-dns-settings.read",
    why: "the account's DNS state. L2 proposes MX records as a diff and needs to read what is there first",
    readOnlyExists: true,
  },
  {
    scope: "account-api-gateway.read",
    why: "part of the account-level read the picker groups with settings",
    readOnlyExists: true,
  },
  {
    scope: "workers-scripts.read",
    why: "the Workers inventory a deployment plan is diffed against. #92 measured that auto-provisioning "
      + "creates or fails and never adopts, so a plan that cannot see what exists is wrong from the second "
      + "attempt onwards",
    readOnlyExists: true,
  },
  {
    scope: "d1.write",
    why: "the catalog. **Write because that is what this client was registered with** — `d1.read` exists and "
      + "is what L1 would ask for, since it provisions nothing",
    readOnlyExists: true,
  },
  {
    scope: "queues.write",
    why: "the delivery-events queue and its consumer. Write for the same reason; `queues.read` exists",
    readOnlyExists: true,
  },
  {
    scope: "email-routing-account-rule.read",
    why: "the account's catch-all routing. Read-only by Cloudflare's own shape — this permission has no write",
    readOnlyExists: true,
  },
  {
    scope: "email-routing-address.write",
    why: "the destination addresses a routing rule can name, which must be verified before mail reaches them",
    readOnlyExists: true,
  },
  {
    scope: "email-routing-rule.write",
    why: "the rules themselves: what L2 proposes as a diff and applies on approval",
    readOnlyExists: true,
  },
  {
    scope: "email-routing-suppression.write",
    why: "suppressions, which decide what silently does not arrive — so a Node that could not read them "
      + "would report a mailbox as healthy while mail was being dropped",
    readOnlyExists: true,
  },
  {
    scope: "email-sending.write",
    why: "sending. The transport uses a binding or a token rather than this grant, so this is what lets a "
      + "plan report whether the account is entitled to send at all",
    readOnlyExists: true,
  },
  {
    /*
     * **A protocol scope, so no dot** — and it was removed from this list once, wrongly.
     *
     * A consent refused it (`invalid_scope`), and the conclusion drawn was that a client may not request it
     * and therefore that a self-managed client cannot hold a refreshable grant at all. Both wrong. The API
     * reference says it plainly: *"Protocol scopes `offline_access` and `openid` are added or removed
     * automatically based on `grant_types`"* — so the client simply had `authorization_code` alone, and
     * `offline_access` was never in its registered set to request.
     *
     * With `refresh_token` added to `grant_types`, Cloudflare adds this to the client's scopes itself. So it
     * is requested here, and a client without it gets a refusal that **names** it — which points at the
     * grant type rather than at a mystery.
     */
    scope: "offline_access",
    why: "the refresh token. Without it the grant expires with its access token — measured at one hour — and "
      + "ADR 42's one dashboard ceremony becomes one per hour. Cloudflare adds this to a client's scopes "
      + "automatically when its grant types include `refresh_token`",
    readOnlyExists: true,
  },
] as const;

/** Just the strings, for a caller building an authorization request. */
export const REQUIRED_SCOPE_NAMES: readonly string[] = REQUIRED_SCOPES.map((one) => one.scope);

/**
 * The states an operator can be in, as a closed union.
 *
 * ## Only the ones this layer can reach are declared
 *
 * #162 lists nine states, and five of them — inventory read, plan produced, partially provisioned,
 * provisioned unverified, verified — are facts about an inventory and a plan that this layer does not build.
 * Declaring them here would put five branches in a union that nothing could construct, which is a closed world
 * whose members cannot be tested. The union grows with the layer that reaches them.
 *
 * What is here is every state the grant itself has, and one that the grant cannot observe.
 */
export type ProviderState =
  /** No row. This Node has never been given a client. */
  | "no_client"
  /** A client is registered and nobody has consented yet. A place an operator is, not a failure. */
  | "awaiting_consent"
  /**
   * The operator reports the consent screen did not list their account.
   *
   * **Reported, not observed**, and every surface that shows it says so. An administrator can disable public
   * OAuth app access under Manage Account → Members → Settings, and the consequence is that the account
   * simply is not listed — no error, and no response the Node ever sees, because the authorization request
   * never comes back. Inferring it from a consent that did not return would mean telling an operator who
   * closed the tab that their administrator has disabled OAuth apps.
   */
  | "account_not_selectable"
  /** A grant is held. Nothing has been read with it — that is the next layer's first act. */
  | "consent_granted"
  /**
   * Cloudflare rejected the stored grant: revoked in the dashboard, or a refresh past its grant session.
   *
   * Distinct from `awaiting_consent` on purpose. The tokens are still in the row, so *never granted* and
   * *granted and then refused* stay different questions — and #162 requires revoking the grant to leave mail,
   * users, Butlers, schedules, API, backup and recovery working, which is a claim about this state and not
   * about an error.
   */
  | "grant_refused";

/** Every member, for the closed-world test and for the surfaces that enumerate them. */
export const PROVIDER_STATES: readonly ProviderState[] = [
  "no_client", "awaiting_consent", "account_not_selectable", "consent_granted", "grant_refused",
] as const;

/** What a surface may say about the binding. Carries no secret, so `doctor` and the API may both use it. */
export interface ProviderStatus {
  state: ProviderState;
  /** Whether this state was observed by the Node or asserted by a person. See `account_not_selectable`. */
  evidence: "observed" | "reported";
  clientId: string | null;
  redirectUri: string | null;
  registeredAt: string | null;
  accountId: string | null;
  grantedAt: string | null;
  /** As granted, which may be a subset of those requested. Null before a grant. */
  scopesGranted: string[] | null;
  /** Set only in `grant_refused`, and it is Cloudflare's own words rather than a paraphrase. */
  refusedDetail: string | null;
}

interface BindingRow {
  client_id: string;
  redirect_uri: string;
  registered_at: string;
  account_id: string | null;
  granted_at: string | null;
  scopes_granted: string | null;
  refused_at: string | null;
  refused_detail: string | null;
  unselectable_reported_at: string | null;
}

/**
 * Every column the state is derived from, and **no** token column.
 *
 * Exported so a test can assert the absence rather than trust this comment. `providerStatus` is what `doctor`
 * and every surface call, so a token column arriving in this list would put the account's provisioning
 * authority on the path that renders a page — and it would make the key vault a dependency of displaying one.
 */
export const STATUS_COLUMNS =
  "client_id, redirect_uri, registered_at, account_id, granted_at, scopes_granted, "
  + "refused_at, refused_detail, unselectable_reported_at";

/**
 * The binding's state, reading no secret.
 *
 * The order of the branches is the total order of the states, and it is not arbitrary: a refusal outranks a
 * grant because a held-but-rejected grant is the more urgent fact, and a report of an unselectable account
 * outranks `awaiting_consent` because it is the reason the consent has not happened.
 */
export async function providerStatus(env: Env): Promise<ProviderStatus> {
  const row = await env.CATALOG.prepare(
    `SELECT ${STATUS_COLUMNS} FROM provider_binding WHERE id = 1`,
  ).first<BindingRow>().catch(() => null);

  if (row === null) {
    return {
      state: "no_client", evidence: "observed", clientId: null, redirectUri: null, registeredAt: null,
      accountId: null, grantedAt: null, scopesGranted: null, refusedDetail: null,
    };
  }

  const common = {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    registeredAt: row.registered_at,
    accountId: row.account_id,
    grantedAt: row.granted_at,
    scopesGranted: row.scopes_granted === null ? null : (JSON.parse(row.scopes_granted) as string[]),
    refusedDetail: row.refused_detail,
  };

  if (row.refused_at !== null) return { ...common, state: "grant_refused", evidence: "observed" };
  if (row.granted_at !== null) return { ...common, state: "consent_granted", evidence: "observed" };
  if (row.unselectable_reported_at !== null) {
    return { ...common, state: "account_not_selectable", evidence: "reported" };
  }
  return { ...common, state: "awaiting_consent", evidence: "observed" };
}

/**
 * The guided ceremony, as text the Node prints.
 *
 * ADR 42 accepts one dashboard ceremony and requires it be *guided*: **"the difference between learning the
 * dashboard and following four printed steps."** This is those steps, built rather than written into a
 * template, because two of the four contain values only the Node knows — its own redirect URI and the
 * capabilities it needs.
 *
 * `redirectUri` is derived from the request's own origin, which is the one place that knows what hostname an
 * operator actually reached this Node on. It is then **stored** at registration, because RFC 6749 requires the
 * token exchange to send the same value the authorization used — see the migration.
 */
export function ceremony(redirectUri: string): {
  steps: string[];
  redirectUri: string;
  scopes: typeof REQUIRED_SCOPES;
  unmeasured: string;
} {
  return {
    redirectUri,
    scopes: REQUIRED_SCOPES,
    steps: [
      "In the Cloudflare dashboard, go to Manage Account → OAuth clients, and create a client.",
      "Set the grant types to Authorization Code **and Refresh Token** — the second is what gets this Node a "
        + "refresh token, so without it the grant expires with its access token and this ceremony recurs. "
        + "Add exactly this redirect URI: " + redirectUri,
      `Select exactly these scopes: ${REQUIRED_SCOPES.filter((one) => one.scope.includes("."))
        .map((one) => one.scope).join(", ")}. Leave offline_access alone — Cloudflare adds it for you `
        + "because the grant types include Refresh Token, and without it this grant dies in an hour.",
      "Leave the client private. A private client can only be authorized by members of your own account, "
        + "which is what keeps this grant yours.",
      "Copy the client id and the client secret, and paste both here. Cloudflare shows the secret once.",
    ],
    /*
     * Said in the ceremony itself rather than only in a receipt. An operator following printed steps is
     * entitled to know which parts of them this Node has verified.
     */
    unmeasured: "These scope names come from wrangler's own OAuth vocabulary rather than from "
      + "GET /client/v4/oauth/scopes, which needs a token this Node does not have — so they are the right "
      + "shape and may not be the exact set a third-party client may request. Cloudflare names any it "
      + "refuses, and after you consent this Node reports which were actually granted.",
  };
}

/** The client half, as the operator pastes it. */
export interface ClientRegistration {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Stores the client id and secret, replacing any previous registration.
 *
 * **Replacing, and it discards any grant with it.** A grant belongs to the client that obtained it: keeping
 * the tokens across a re-registration would leave a row whose `client_id` did not issue its `refresh_token`,
 * and the first refresh would be refused with an error about the client that an operator would read as a
 * revocation. So re-registering returns the binding to `awaiting_consent`, which is the truth about it.
 */
export async function registerClient(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, registration: ClientRegistration,
): Promise<void> {
  const clientId = registration.clientId.trim();
  const clientSecret = registration.clientSecret.trim();
  const redirectUri = registration.redirectUri.trim();

  if (clientId === "" || clientSecret === "") {
    throw unprocessable("E_PROVIDER_NEEDS_BOTH", {
      what: `clientId was ${clientId === "" ? "empty" : "given"} and clientSecret was `
        + `${clientSecret === "" ? "empty" : "given"}`,
      why: "a client id without its secret cannot complete a token exchange, so a binding holding one half "
        + "would reach the consent screen and fail after the operator had granted it — the worst place to "
        + "discover a missing value",
      fix: "put { clientId, clientSecret }. Cloudflare shows the secret once, when the client is created; if "
        + "it is lost, rotate it in Manage Account → OAuth clients rather than creating a second client",
    });
  }

  /*
   * Wrapped before the batch is built: `auditedBatch`'s statement builder is synchronous and the wrap is a
   * Durable Object round trip for the key. 0036's comment says the same thing at the same seam.
   */
  const wrapped = await wrapCredential(env, clientSecret);
  const at = new Date(ctx.now()).toISOString();

  await auditedBatch(
    env, ctx, orgId,
    {
      action: "provider.client_registered", outcome: "ok", actorUserId, subject: clientId,
      /*
       * The client id and the redirect URI, and never the secret — not even its length. 0036's rule, and the
       * audit trail is the one table designed to be read widely and kept for ever.
       */
      detail: { clientId, redirectUri },
    },
    (entry) => [
      entry,
      /*
       * `INSERT OR REPLACE` rather than an upsert that preserves the grant columns, which is the discarding
       * described above. Written as a full replacement so the columns it clears are visible in the statement
       * instead of being absent from an `ON CONFLICT` list.
       */
      env.CATALOG.prepare(
        "INSERT OR REPLACE INTO provider_binding "
        + "(id, client_id, client_secret, redirect_uri, registered_at, registered_by, "
        + " account_id, access_token, refresh_token, access_expires_at, scopes_granted, granted_at, "
        + " refused_at, refused_detail, unselectable_reported_at, unselectable_reported_by) "
        + "VALUES (1, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
      ).bind(clientId, wrapped, redirectUri, at, actorUserId),
      // Any consent in flight was started by the previous client, so its verifier can never be exchanged.
      env.CATALOG.prepare("DELETE FROM provider_authorizations WHERE consumed_at IS NULL"),
    ],
  );
}

/**
 * How long a consent may sit in flight.
 *
 * Was ten minutes, on the reasoning that it is *"the redirect's own working life"*. It is not — that is a
 * guess about how fast somebody signs in to Cloudflare, reviews fourteen permissions and clicks Authorize,
 * and it expired twice on one operator doing exactly that.
 *
 * **The nonce's protection is that it is single-use, not that it is short-lived.** `consumed_at` is set by an
 * `UPDATE … WHERE consumed_at IS NULL`, so a spent state cannot be spent again however long it lived; the
 * expiry only bounds how long an *unused* verifier sits in D1. Half an hour for a ceremony a person performs
 * once, in a browser, possibly after signing in to a provider first.
 */
const AUTHORIZATION_TTL_MS = 30 * 60 * 1000;

/** Cloudflare's enforced minimum, measured in `cloudflare-oauth-node-as-client.md`. */
export const MIN_STATE_LENGTH = 8;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Begins a consent: mints the nonce and the PKCE verifier, stores them, and returns the URL to send a browser
 * to.
 *
 * ## PKCE, on a confidential client that does not need it
 *
 * Cloudflare's table says PKCE is *"Optional/not required"* for a server-side client with a secret, and
 * discovery confirms `S256` is available. It is used anyway: the authorization code arrives through the
 * operator's browser and a Node's redirect URI is a public hostname, so a code seen in a browser's history, a
 * proxy log or a referrer is a code somebody else holds. With a verifier it is worth nothing to them. The cost
 * is one SHA-256.
 *
 * The state is 32 random bytes rather than the enforced minimum of 8 characters. The minimum is recorded and
 * asserted because a Node that generated a short one would fail *at the redirect* with a message about
 * entropy, which does not read like a configuration problem — see the migration's CHECK.
 */
export async function beginAuthorization(
  env: Env, ctx: Ctx, actorUserId: string, requestedScopes: readonly string[],
): Promise<{ url: string; state: string }> {
  const row = await env.CATALOG.prepare(
    "SELECT client_id, redirect_uri FROM provider_binding WHERE id = 1",
  ).first<{ client_id: string; redirect_uri: string }>().catch(() => null);

  if (row === null) {
    throw conflict("E_PROVIDER_NO_CLIENT", {
      what: "this Node has no OAuth client to authorize",
      why: "the authorization URL is built from a client id this Node does not have, and a redirect URI it "
        + "cannot have registered with Cloudflare",
      fix: "follow the printed ceremony first: create the client in Manage Account → OAuth clients and give "
        + "this Node its id and secret",
    });
  }

  const state = base64Url(ctx.random(32));
  /*
   * Asserted rather than assumed. 32 random bytes cannot base64 to fewer than 8 characters, so this can only
   * fire if the generator or the encoder changes — which is exactly the condition under which a Node would
   * start failing at Cloudflare's redirect with an error about entropy.
   */
  if (state.length < MIN_STATE_LENGTH) {
    throw new Error(
      `E_PROVIDER_STATE_TOO_SHORT  length=${state.length}  minimum=${MIN_STATE_LENGTH}\n`
      + "  why  Cloudflare enforces a minimum state length and answers a shorter one by redirecting with "
      + "error=invalid_state and a message about entropy (cloudflare-oauth-node-as-client.md)",
    );
  }

  const verifier = base64Url(ctx.random(32));
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

  /*
   * `offline_access` is added rather than required of the caller. It is the one scope discovery names, the
   * grant is useless without it, and a caller that forgot it would produce a binding that expired in an hour
   * and read as a revocation.
   */
  /*
   * Blanks dropped, and **nothing added**. A caller passing `"".split(",")` hands this `[""]`, which came out
   * as `scope=+offline_access` — a leading empty scope in a parameter the provider splits on whitespace.
   * Filtered here rather than in the caller because every caller can produce it the same way.
   *
   * An empty list still omits the `scope` parameter, and a caller should not send one: **measured, a request
   * naming no scope is granted none.** The consent screen reads *"0 total permissions"* with `Authorize`
   * disabled. `/api/provider/authorize` therefore substitutes `REQUIRED_SCOPE_NAMES`; this function keeps the
   * empty case honest rather than inventing a default a caller did not ask for.
   */
  const scopes = requestedScopes.map((one) => one.trim()).filter((one) => one !== "");

  const now = ctx.now();
  await env.CATALOG.prepare(
    "INSERT INTO provider_authorizations "
    + "(state, code_verifier, requested_scopes, started_at, started_by, expires_at, consumed_at) "
    + "VALUES (?, ?, ?, ?, ?, ?, NULL)",
  ).bind(
    state,
    await wrapCredential(env, verifier),
    JSON.stringify(scopes),
    new Date(now).toISOString(),
    actorUserId,
    new Date(now + AUTHORIZATION_TTL_MS).toISOString(),
  ).run();

  const url = new URL(CLOUDFLARE_OAUTH.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", row.client_id);
  url.searchParams.set("redirect_uri", row.redirect_uri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Omitted entirely when empty, not set to "". See the comment on `scopes` above.
  if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));

  return { url: url.toString(), state };
}

/**
 * What the token endpoint answered.
 *
 * ## `accountId` is optional because its presence is **not measured**
 *
 * `cloudflare-oauth-endpoints.md` read the discovery document; nothing in this repository has yet seen a
 * Cloudflare token response, because no Node has held a grant. Whether it names the account the operator
 * selected is therefore unknown, and the two honest options were to invent a field or to admit it may be
 * absent.
 *
 * Absent is handled: the binding stores `account_id` as null and every surface says *not yet determined*
 * rather than showing an empty account. Resolving it costs one `GET /client/v4/accounts` with the grant, and
 * that call belongs to the layer that already talks to the API rather than to this one — a module that
 * obtained authority and immediately spent it to fill in a field would have no place to put the honest answer
 * "connected, and nothing has been read yet".
 *
 * If the response does carry it, this reads it and the extra call never happens. That is a difference the
 * first real consent settles, and it is #162's to record.
 */
interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  account_id?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** What the callback did, as the surface reports it. Never carries a token. */
export interface ConsentOutcome {
  ok: boolean;
  /** Cloudflare's own error code when it refused, e.g. `access_denied`. Null on success. */
  error: string | null;
  detail: string | null;
  accountId: string | null;
  /** As granted. A declined optional scope is a fact about the consent, not a fault. */
  scopesGranted: string[];
  /** Asked for but not granted, computed rather than reported by Cloudflare. */
  scopesDeclined: string[];
}

interface PendingRow {
  code_verifier: string;
  requested_scopes: string;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * Consumes a callback: validates the nonce, exchanges the code, and stores the grant.
 *
 * ## The nonce is checked before anything else and consumed exactly once
 *
 * A callback carrying a state this Node did not issue is not a callback this Node started, which is the whole
 * job of the parameter — so it is looked up first, before the code is read and certainly before it is sent
 * anywhere. Three refusals rather than one, because they are three different things that happened and an
 * operator meeting them needs to know which:
 *
 * - **unknown** — this Node never issued that state. A forged or stale callback.
 * - **already consumed** — a code replayed. The `UPDATE ... WHERE consumed_at IS NULL` is what makes this a
 *   property of the row rather than of a check in the handler, so two callbacks racing cannot both proceed.
 * - **expired** — the operator left the consent screen open past the redirect's working life.
 *
 * ## Cloudflare's refusal is not this Node's failure, and is not stored as a binding
 *
 * When the query carries `error=access_denied` the operator declined, which is an ordinary outcome. The state
 * is consumed — it has been used, and letting it be retried would leave a nonce alive after its redirect — and
 * nothing is written to the binding. The state stays `awaiting_consent`, which is exactly where the operator
 * is.
 */
export async function completeAuthorization(
  env: Env, ctx: Ctx, orgId: string,
  callback: { state: string; code: string | null; error: string | null; errorDescription: string | null },
): Promise<ConsentOutcome> {
  const pending = await env.CATALOG.prepare(
    "SELECT code_verifier, requested_scopes, expires_at, consumed_at FROM provider_authorizations "
    + "WHERE state = ?",
  ).bind(callback.state).first<PendingRow>().catch(() => null);

  if (pending === null) {
    throw unprocessable("E_PROVIDER_STATE_UNKNOWN", {
      what: "the callback carried a state this Node did not issue",
      why: "the state parameter is what distinguishes a consent this Node started from one somebody else "
        + "did, so a callback it cannot match is not one it can act on",
      fix: "start the connection again from this Node rather than reusing an old authorization URL",
    });
  }
  if (pending.consumed_at !== null) {
    throw conflict("E_PROVIDER_STATE_CONSUMED", {
      what: `that authorization was already completed at ${pending.consumed_at}`,
      why: "an authorization code is single use, and a state that could be spent twice would let a code seen "
        + "in a browser's history be exchanged again",
      fix: "read the current connection state rather than replaying the callback. If the binding is not "
        + "connected, start a new authorization",
    });
  }
  if (new Date(pending.expires_at).getTime() <= ctx.now()) {
    throw conflict("E_PROVIDER_STATE_EXPIRED", {
      what: `that authorization expired at ${pending.expires_at}`,
      why: "a nonce and a PKCE verifier waiting for a redirect that has not come are a secret with no "
        + "remaining purpose, so they stop being usable rather than waiting indefinitely",
      fix: "start the connection again",
    });
  }

  const consumedAt = new Date(ctx.now()).toISOString();
  /*
   * Consumed **before** the exchange, not after. If the exchange fails the code is already spent at
   * Cloudflare's end, so a state left open would only permit a retry that could not succeed — and the
   * predicate is what makes two racing callbacks resolve to one.
   */
  const claim = await env.CATALOG.prepare(
    "UPDATE provider_authorizations SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL",
  ).bind(consumedAt, callback.state).run();
  if (claim.meta.changes === 0) {
    throw conflict("E_PROVIDER_STATE_CONSUMED", {
      what: "that authorization was completed by another request while this one was reading it",
      why: "two callbacks arrived for one state and exactly one may proceed, which the row decides rather "
        + "than the order the handlers happened to run in",
      fix: "read the current connection state; the other request has already finished the exchange",
    });
  }

  const requested = JSON.parse(pending.requested_scopes) as string[];

  if (callback.error !== null) {
    /*
     * Nothing is written to the binding. The operator declined, or Cloudflare refused, and either way this
     * Node holds no grant and should not record one — `awaiting_consent` is the accurate state.
     */
    await auditedBatch(
      env, ctx, orgId,
      {
        action: "provider.consent_refused", outcome: "refused", actorUserId: null, subject: callback.error,
        detail: { error: callback.error, description: callback.errorDescription },
      },
      (entry) => [entry],
    );
    return {
      ok: false, error: callback.error, detail: callback.errorDescription,
      accountId: null, scopesGranted: [], scopesDeclined: requested,
    };
  }

  if (callback.code === null || callback.code === "") {
    throw unprocessable("E_PROVIDER_NO_CODE", {
      what: "the callback carried neither an authorization code nor an error",
      why: "one of the two is the whole content of an authorization response, so a callback with neither is "
        + "not a response this Node can act on and must not be reported as a connection",
      fix: "start the connection again. If this recurs, the redirect URI registered with Cloudflare may not "
        + "be the one this Node is reachable on",
    });
  }

  const row = await env.CATALOG.prepare(
    "SELECT client_id, client_secret, redirect_uri FROM provider_binding WHERE id = 1",
  ).first<{ client_id: string; client_secret: string; redirect_uri: string }>();
  if (row === null) {
    throw conflict("E_PROVIDER_NO_CLIENT", {
      what: "the binding was removed while an authorization was in flight",
      why: "the exchange authenticates with the client secret, and a code obtained by a client this Node no "
        + "longer holds cannot be exchanged by it",
      fix: "register the client again and start a new authorization",
    });
  }

  const secret = await unwrapCredential(env, row.client_secret);
  const verifier = await unwrapCredential(env, pending.code_verifier);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: callback.code,
    /*
     * The same value the authorization used, read from the row rather than recomputed. RFC 6749 requires them
     * to match, and a Node reachable on more than one hostname would otherwise be refused *after* consent.
     */
    redirect_uri: row.redirect_uri,
    code_verifier: verifier,
  });

  let response: Response;
  try {
    response = await fetch(CLOUDFLARE_OAUTH.token, {
      method: "POST",
      headers: {
        /*
         * `client_secret_basic`, which discovery lists first among the supported methods. Basic rather than
         * `client_secret_post` so the secret is in a header rather than a form body — the two are equally
         * supported and headers are the half less likely to be logged by something in between.
         *
         * **Both values are form-url-encoded before base64, which RFC 6749 §2.3.1 requires and the first
         * version of this did not.** A real exchange answered `invalid_client` — *"client authentication
         * failed"* — after a consent had already succeeded, which is the worst place to fail: the code is
         * single-use, so there is no retry and the operator has to consent again.
         *
         * It matters because a Cloudflare client secret is base64-ish and routinely contains `+`, `/` and
         * `=`. Unencoded, those change what the server decodes the password as. This authorization server
         * is Ory Hydra (`credentials_endpoint_draft_00` in its discovery document) and Hydra enforces the
         * encoding, so an unencoded credential is rejected rather than accepted leniently.
         */
        authorization: `Basic ${btoa(
          `${encodeURIComponent(row.client_id)}:${encodeURIComponent(secret)}`,
        )}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (cause) {
    /*
     * A network failure at the exchange, with the code already spent. Not stored as a refusal: nothing is
     * known about the grant, and `grant_refused` means Cloudflare rejected a grant this Node held.
     */
    throw conflict("E_PROVIDER_EXCHANGE_UNREACHABLE", {
      what: `the token endpoint could not be reached: ${String(cause)}`,
      why: "the authorization code has been spent and this Node cannot tell whether a grant was issued, "
        + "which is an unknown rather than a failure and must not be recorded as either",
      fix: "read the connection state, and start a new authorization. If a grant was issued it is visible in "
        + "Cloudflare under Manage Account → OAuth clients and can be revoked there",
    });
  }

  const payload = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok || typeof payload.access_token !== "string") {
    const error = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    const detail = typeof payload.error_description === "string" ? payload.error_description : null;
    await auditedBatch(
      env, ctx, orgId,
      {
        action: "provider.consent_refused", outcome: "refused", actorUserId: null, subject: error,
        detail: { error, description: detail, status: response.status },
      },
      (entry) => [entry],
    );
    return { ok: false, error, detail, accountId: null, scopesGranted: [], scopesDeclined: requested };
  }

  /*
   * The scopes **as granted**, split from the response's own string. Cloudflare permits optional scopes to be
   * declined, so what was asked for is not what is held — and a Node recording its request would report an
   * authority it does not have.
   */
  const granted = typeof payload.scope === "string"
    ? payload.scope.split(" ").filter((one) => one !== "")
    : requested;
  const declined = requested.filter((one) => !granted.includes(one));
  const accountId = typeof payload.account_id === "string" && payload.account_id !== ""
    ? payload.account_id
    : null;
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
  const refresh = typeof payload.refresh_token === "string" ? payload.refresh_token : null;

  const grantedAt = new Date(ctx.now()).toISOString();
  const wrappedAccess = await wrapCredential(env, payload.access_token);
  const wrappedRefresh = refresh === null ? null : await wrapCredential(env, refresh);

  await auditedBatch(
    env, ctx, orgId,
    {
      action: "provider.consent_granted", outcome: "ok", actorUserId: null,
      subject: accountId ?? row.client_id,
      /*
       * The account, the scopes and what was declined — and neither token, nor their lengths. The scopes are
       * the interesting half later: the question an investigator has is what this Node was permitted to do.
       */
      detail: { accountId, scopesGranted: granted, scopesDeclined: declined, hasRefreshToken: refresh !== null },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        "UPDATE provider_binding SET account_id = ?, access_token = ?, refresh_token = ?, "
        + "access_expires_at = ?, scopes_granted = ?, granted_at = ?, "
        // Cleared together with the grant: a refusal or a report that predates a successful consent is history,
        // and leaving either set would make a connected Node report itself refused.
        + "refused_at = NULL, refused_detail = NULL, "
        + "unselectable_reported_at = NULL, unselectable_reported_by = NULL "
        + "WHERE id = 1",
      ).bind(
        accountId, wrappedAccess, wrappedRefresh,
        expiresIn === null ? null : new Date(ctx.now() + expiresIn * 1000).toISOString(),
        JSON.stringify(granted), grantedAt,
      ),
    ],
  );

  return { ok: true, error: null, detail: null, accountId, scopesGranted: granted, scopesDeclined: declined };
}

/**
 * Records that the operator could not find their account on the consent screen.
 *
 * **The one state this Node cannot observe**, and the write is deliberately shaped so that stays visible: the
 * columns are named `unselectable_reported_at` and `unselectable_reported_by`, `providerStatus` returns
 * `evidence: "reported"`, and the audit entry's outcome is the operator's assertion rather than a measurement.
 *
 * Refused when a grant already exists, because it cannot be true: an account that was granted was selectable.
 */
export async function reportUnselectable(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string,
): Promise<void> {
  const status = await providerStatus(env);
  if (status.state === "no_client") {
    throw conflict("E_PROVIDER_NO_CLIENT", {
      what: "there is no client to report a consent screen for",
      why: "the consent screen is reached from an authorization URL built from a client this Node does not "
        + "have, so no operator has seen one",
      fix: "register the client first",
    });
  }
  if (status.grantedAt !== null) {
    throw conflict("E_PROVIDER_ALREADY_GRANTED", {
      what: `this Node holds a grant obtained at ${status.grantedAt}`,
      why: "an account that granted a consent was selectable on the consent screen, so the report cannot be "
        + "true of this binding",
      fix: "if the grant is the wrong account, disconnect it and authorize again. If it stopped working, the "
        + "state to look for is grant_refused rather than this one",
    });
  }

  const at = new Date(ctx.now()).toISOString();
  await auditedBatch(
    env, ctx, orgId,
    {
      action: "provider.account_reported_unselectable", outcome: "ok", actorUserId, subject: status.clientId,
      detail: {
        /*
         * Recorded in the entry itself, because an audit trail read later is exactly where a reported fact
         * gets mistaken for an observed one.
         */
        evidence: "reported by an operator; this Node cannot observe which accounts a consent screen lists",
      },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        "UPDATE provider_binding SET unselectable_reported_at = ?, unselectable_reported_by = ? WHERE id = 1",
      ).bind(at, actorUserId),
    ],
  );
}

/**
 * The Cloudflare API, called as this Node (#162 L2).
 *
 * ## Why this is the first thing L2 needs
 *
 * L1 obtained a grant and deliberately spent none of it — `doctor` reported *"nothing has been read with it
 * yet"*, which was honest and is not a place to stay. Every later layer reads or writes through here.
 *
 * ## The access token lives an hour, so refreshing is not an optimisation
 *
 * Measured: `access_expires_at` is one hour after the grant. A caller that used the stored token without
 * checking would work for an hour after each consent and fail silently afterwards, which is the failure mode
 * ADR 42's *one ceremony* exists to avoid — it would make the ceremony hourly in practice while claiming
 * otherwise.
 *
 * Refreshed **before** expiry rather than on a 401, with a minute of margin: a token that expires between
 * the check and the request is a request that fails for a reason the caller cannot distinguish from a
 * revocation. The margin costs one refresh an hour.
 *
 * ## A rejected refresh is what makes `grant_refused` real
 *
 * L1 could describe that state and not reach it — the drill had to write the row by hand. This is the path
 * that reaches it: Cloudflare answering `invalid_grant` to a refresh means the grant is gone, revoked in the
 * dashboard or past its session, and the row records **Cloudflare's own words** rather than a paraphrase.
 *
 * The tokens are kept, deliberately. #162's distinction between *never granted* and *granted and then
 * refused* is only legible while they are there.
 */
async function accessTokenFor(env: Env, ctx: Ctx, orgId: string): Promise<string> {
  const row = await env.CATALOG.prepare(
    "SELECT client_id, client_secret, access_token, refresh_token, access_expires_at, refused_at "
    + "FROM provider_binding WHERE id = 1",
  ).first<{
    client_id: string; client_secret: string; access_token: string | null;
    refresh_token: string | null; access_expires_at: string | null; refused_at: string | null;
  }>();

  if (row === null || row.access_token === null) {
    throw conflict("E_PROVIDER_NO_GRANT", {
      what: "this Node holds no Cloudflare grant",
      why: "reading the account needs an authorization somebody consented to, and none has been given",
      fix: "connect the account first: `mailda provider` prints the steps",
    });
  }
  if (row.refused_at !== null) {
    throw conflict("E_PROVIDER_GRANT_REFUSED", {
      what: `Cloudflare rejected this Node's grant at ${row.refused_at}`,
      why: "a refused grant is not a missing one — it was consented to and has since been revoked or has "
        + "expired past its session, and this Node keeps it so the difference stays legible",
      fix: "authorize again: `mailda provider --scopes …`. Nothing else on this Node is affected by the "
        + "refusal — mail, sign-in, Butlers, backup and recovery do not use this grant",
    });
  }

  /*
   * A minute of margin. Cutting it finer would let a token expire between this check and the request it was
   * fetched for, and a caller cannot tell that failure from a revocation.
   */
  const expiresAt = row.access_expires_at === null ? 0 : new Date(row.access_expires_at).getTime();
  if (expiresAt - 60_000 > ctx.now()) return unwrapCredential(env, row.access_token);

  if (row.refresh_token === null) {
    throw conflict("E_PROVIDER_NO_REFRESH", {
      what: "this Node's access token has expired and there is no refresh token to renew it",
      why: "Cloudflare issues a refresh token only when the client's grant types include `refresh_token`, "
        + "which adds `offline_access` to its scopes automatically — a client without it grants an hour and "
        + "no more",
      fix: "add Refresh Token to the client's grant types in Manage Account → OAuth clients, then authorize "
        + "again. `docs/receipts/cloudflare-oauth-scopes.md` records the measurement",
    });
  }

  const secret = await unwrapCredential(env, row.client_secret);
  const refresh = await unwrapCredential(env, row.refresh_token);
  const response = await fetch(CLOUDFLARE_OAUTH.token, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${encodeURIComponent(row.client_id)}:${encodeURIComponent(secret)}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }).toString(),
  }).catch(() => null);

  const payload = response === null
    ? null
    : (await response.json().catch(() => ({}))) as TokenResponse;

  if (response === null || !response.ok || typeof payload?.access_token !== "string") {
    /*
     * A network failure is **not** recorded as a refusal. `grant_refused` means Cloudflare rejected a grant
     * this Node holds; an unreachable token endpoint says nothing about the grant, and marking it refused
     * would tell an operator their authorization had been revoked because a request timed out. ADR 40's
     * distinction between a refusal and an unknown, in a third place.
     */
    if (response === null) {
      throw conflict("E_PROVIDER_REFRESH_UNREACHABLE", {
        what: "the token endpoint could not be reached to renew this Node's access token",
        why: "an unreachable endpoint says nothing about whether the grant is still good, so it is not "
          + "recorded as a refusal",
        fix: "retry. If it persists, check whether Cloudflare's API is reachable from this Node",
      });
    }
    const detail = typeof payload?.error_description === "string"
      ? payload.error_description
      : (typeof payload?.error === "string" ? payload.error : `http_${response.status}`);
    await auditedBatch(
      env, ctx, orgId,
      {
        action: "provider.grant_refused", outcome: "refused", actorUserId: null,
        subject: row.client_id, detail: { error: detail },
      },
      (entry) => [
        entry,
        env.CATALOG.prepare(
          "UPDATE provider_binding SET refused_at = ?, refused_detail = ? WHERE id = 1",
        ).bind(new Date(ctx.now()).toISOString(), detail),
      ],
    );
    throw conflict("E_PROVIDER_GRANT_REFUSED", {
      what: `Cloudflare refused to renew this Node's grant: ${detail}`,
      why: "the refresh token is the durable half of the authorization, so a refusal means the grant is "
        + "gone — revoked in the dashboard, or past its session",
      fix: "authorize again: `mailda provider --scopes …`. Nothing else on this Node uses this grant",
    });
  }

  /*
   * The new refresh token replaces the old **when one is returned**. Rotation is at the server's discretion:
   * a response carrying only an access token means the existing refresh token stays valid, and overwriting
   * it with null would discard the durable half on a successful renewal.
   */
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
  const rotated = typeof payload.refresh_token === "string" ? payload.refresh_token : null;
  await env.CATALOG.prepare(
    "UPDATE provider_binding SET access_token = ?, access_expires_at = ?"
    + (rotated === null ? "" : ", refresh_token = ?") + " WHERE id = 1",
  ).bind(
    ...[
      await wrapCredential(env, payload.access_token),
      expiresIn === null ? null : new Date(ctx.now() + expiresIn * 1000).toISOString(),
      ...(rotated === null ? [] : [await wrapCredential(env, rotated)]),
    ],
  ).run();

  return payload.access_token;
}

/**
 * One authenticated read of Cloudflare's API as this Node.
 *
 * `GET` only, deliberately: L1 provisions nothing, and a helper that could write would be reached for by the
 * layer that eventually does before anybody decided what that layer may change.
 */
export async function cloudflareGet<T>(
  env: Env, ctx: Ctx, orgId: string, path: string,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const token = await accessTokenFor(env, ctx, orgId);
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  }).catch(() => null);
  if (response === null) return { ok: false, error: "the Cloudflare API could not be reached" };

  const body = (await response.json().catch(() => ({}))) as {
    success?: boolean; result?: T; errors?: Array<{ message?: string; code?: number }>;
  };
  if (response.ok && body.success === true && body.result !== undefined) {
    return { ok: true, result: body.result };
  }
  /*
   * Cloudflare's own words, not a paraphrase — and its error codes are what distinguish "this scope was not
   * granted" from "this resource does not exist", which a caller has to be able to tell apart.
   */
  const said = (body.errors ?? []).map((one) => `${one.code ?? "?"} ${one.message ?? ""}`.trim()).join("; ");
  return { ok: false, error: said === "" ? `http_${response.status}` : said };
}

/**
 * Which account this grant covers.
 *
 * **Measured as absent from the token response** (`oauth.token_response_names_account: 0`), so it costs a
 * call. `provider_binding.account_id` is filled from here the first time anything needs it rather than at
 * consent, which is why the column is nullable and why every surface says *not yet determined* instead of
 * showing an empty account.
 *
 * More than one account is a real answer and not an error: a person may belong to several, and a grant is
 * scoped to what they chose on the consent screen. Recorded only when there is exactly one, because writing
 * a guess into the column a deployment plan reads is worse than leaving it null.
 */
export async function resolveAccount(
  env: Env, ctx: Ctx, orgId: string,
): Promise<{ accountId: string | null; found: number; error: string | null }> {
  const answer = await cloudflareGet<Array<{ id: string; name: string }>>(
    env, ctx, orgId, "/accounts?per_page=50",
  );
  if (!answer.ok) return { accountId: null, found: 0, error: answer.error };

  const only = answer.result.length === 1 ? answer.result[0]!.id : null;
  if (only !== null) {
    await env.CATALOG.prepare("UPDATE provider_binding SET account_id = ? WHERE id = 1").bind(only).run();
  }
  return { accountId: only, found: answer.result.length, error: null };
}

/**
 * What Cloudflare says about receiving mail for one domain this Node routes (#163 L2).
 *
 * ## Why this is the read side and stops there
 *
 * #163 wants DNS and MX changes *"proposed as a diff, approved, and applied through the Node's own grant"*.
 * The diff has to come from somewhere, and inventing one from what Mailda thinks Email Routing needs would be
 * a second copy of Cloudflare's own requirements — the kind that is right the day it is written.
 *
 * Cloudflare publishes both halves: `GET /zones/{id}/email/routing` answers **whether receiving works**
 * (`enabled`, and a `status` of `ready` / `unconfigured` / `misconfigured`), and
 * `GET /zones/{id}/email/routing/dns` answers **which records it needs**. So the proposal is Cloudflare's
 * list against Cloudflare's verdict, and this Node's job is to ask and to say.
 *
 * Both need `Zone Settings Read`, which the grant carries as `zone-settings.read`. Nothing here writes.
 *
 * ## The zone is not the domain, and finding it is most of the work
 *
 * This Node routes `inbox@mailda-test.whymelabs.com`. There is no zone of that name — the zone is
 * `whymelabs.com`, and the address lives on a subdomain of it. So the search walks up the labels until a zone
 * answers, which is what a person does by eye and what nothing in the address itself reveals.
 *
 * It stops at two labels. A single label is a public suffix rather than a zone anybody owns, and asking
 * Cloudflare for `com` would be a request whose only possible answers are wrong.
 */
export interface RoutingState {
  domain: string;
  /** The zone that turned out to carry it, which is often a parent of the domain. */
  zone: string | null;
  zoneId: string | null;
  enabled: boolean | null;
  /** Cloudflare's own word: `ready`, `unconfigured`, `misconfigured`, or another it may add. */
  status: string | null;
  /** The records Cloudflare says this zone needs, as it describes them. */
  required: Array<{ type: string; name: string; content: string; priority: number | null }>;
  /** Why this domain could not be answered for. Null when it could. */
  error: string | null;
}

export async function emailRoutingFor(
  env: Env, ctx: Ctx, orgId: string, domain: string,
): Promise<RoutingState> {
  const blank: RoutingState = {
    domain, zone: null, zoneId: null, enabled: null, status: null, required: [], error: null,
  };

  /*
   * Longest first: a subdomain that *is* its own zone must be found as itself rather than as its parent,
   * because Email Routing is configured per zone and the two would report different states.
   */
  const labels = domain.split(".");
  for (let at = 0; at + 2 <= labels.length; at++) {
    const candidate = labels.slice(at).join(".");
    const found = await cloudflareGet<Array<{ id: string; name: string }>>(
      env, ctx, orgId, `/zones?name=${encodeURIComponent(candidate)}`,
    );
    if (!found.ok) return { ...blank, error: found.error };
    const zone = found.result[0];
    if (zone === undefined) continue;

    const settings = await cloudflareGet<{ enabled?: boolean; status?: string }>(
      env, ctx, orgId, `/zones/${zone.id}/email/routing`,
    );
    if (!settings.ok) {
      return { ...blank, zone: zone.name, zoneId: zone.id, error: settings.error };
    }

    const dns = await cloudflareGet<Array<{
      type?: string; name?: string; content?: string; priority?: number;
    }>>(env, ctx, orgId, `/zones/${zone.id}/email/routing/dns`);

    return {
      domain,
      zone: zone.name,
      zoneId: zone.id,
      enabled: settings.result.enabled ?? null,
      status: settings.result.status ?? null,
      /*
       * An unreadable record list is **not** an empty one. Empty means Cloudflare says this zone needs
       * nothing; unreadable means nobody knows, and a proposal built from the second would tell an operator
       * their DNS is complete because a request failed.
       */
      required: dns.ok
        ? dns.result.map((one) => ({
          type: one.type ?? "?",
          name: one.name ?? "?",
          content: one.content ?? "?",
          priority: one.priority ?? null,
        }))
        : [],
      error: dns.ok ? null : dns.error,
    };
  }

  return { ...blank, error: `no zone in this account carries ${domain}` };
}

/** Every domain this Node accepts mail for, and what Cloudflare says about each. */
export async function emailRoutingState(
  env: Env, ctx: Ctx, orgId: string,
): Promise<RoutingState[]> {
  const rows = await env.CATALOG.prepare(
    /*
     * The domains this Node **actually routes**, from its own addresses rather than from configuration. A
     * list read from config would describe what somebody intended; this describes what mail is expected at.
     */
    "SELECT DISTINCT substr(address, instr(address, '@') + 1) AS domain FROM addresses WHERE org_id = ?",
  ).bind(orgId).all<{ domain: string }>();

  const seen: RoutingState[] = [];
  for (const row of rows.results) {
    seen.push(await emailRoutingFor(env, ctx, orgId, row.domain));
  }
  return seen;
}
