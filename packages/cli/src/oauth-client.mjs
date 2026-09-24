/**
 * The Node's OAuth client, created through Cloudflare's API rather than typed into a dashboard form.
 *
 * Pure: the request body and the reading of the answer live here, and `install.mjs` does the fetching, so
 * the shape can be tested without a token (AGENTS.md §2b: the pure part in one module, the effect in another).
 *
 * The endpoint is IAM → OAuth Clients, `POST /accounts/{account_id}/oauth_clients`, measured on
 * 23 September 2026 (receipt: `docs/receipts/cloudflare-oauth-endpoints.md`). It takes an API token carrying
 * one permission group, named below; wrangler's own login cannot call it, because wrangler's scope
 * vocabulary has no OAuth-clients scope at all.
 */
export const OAUTH_CLIENTS_PERMISSION = "OAuth App Registrations Write";

/** Where the operator creates the one token this needs. Cloudflare's own page; not a Mailda service. */
export const API_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * The same page with the form filled in: one permission, this account, a name that says what it is for.
 *
 * Cloudflare documents template URLs (`fundamentals/api/how-to/account-owned-token-template`): a
 * `permissionGroupKeys` array of `{ key, type }` and an `accountId`. The key for a permission is its group
 * label without the trailing verb, `dns_admin` → `dns`, so `oauth_app_registrations_write` (the label the
 * permission-groups API returns for "OAuth App Registrations Write") → `oauth_app_registrations`. That last
 * step is inferred from the documented examples, not measured on this permission: the link opens the token
 * page regardless, and `grant()` says to check that the one permission is ticked.
 */
export function tokenTemplateUrl(accountId, name) {
  const keys = JSON.stringify([{ key: "oauth_app_registrations", type: "edit" }]);
  return `${API_TOKENS_URL}?permissionGroupKeys=${encodeURIComponent(keys)}&accountId=${encodeURIComponent(accountId)}`
    + `&name=${encodeURIComponent(`Mailda install (${name}), delete after use`)}`;
}

/**
 * The body for creating the client, from the Node's own ceremony: the redirect URI is the hostname the Node
 * was reached on, and the scopes are `REQUIRED_SCOPES` as `GET /api/provider` returns them. `offline_access`
 * is left out on purpose — Cloudflare adds it itself when the grant types include `refresh_token`, and its
 * create schema documents it as a protocol scope it manages rather than one a client asks for.
 */
export function clientRequest({ name, redirectUri, scopes }) {
  return {
    client_name: `Mailda (${name})`,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    redirect_uris: [redirectUri],
    scopes: scopes.map((one) => (typeof one === "string" ? one : one.scope)).filter((one) => one.includes(".")),
    // The Node exchanges with `client_secret_basic` (`grant-oauth.ts`); the client is registered to match.
    token_endpoint_auth_method: "client_secret_basic",
  };
}

/**
 * Reads Cloudflare's answer into the two values `PUT /api/provider/client` takes, or a refusal in the
 * four-part shape every Mailda refusal has (what, why, fix), naming the permission when that is the cause.
 */
export function createdClient(status, json) {
  const result = json?.result ?? null;
  if (json?.success === true && typeof result?.client_id === "string" && typeof result?.client_secret === "string") {
    return {
      ok: true,
      clientId: result.client_id,
      clientSecret: result.client_secret,
      scopes: Array.isArray(result.scopes) ? result.scopes.map(String) : [],
    };
  }
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  // Measured: an expired token gets 401 and a token without the permission gets 403, both with code 10000.
  if (status === 401 || status === 403) {
    return {
      ok: false,
      reason: `Cloudflare refused to create the client (${status}).\n`
        + `  why      the token does not carry "${OAUTH_CLIENTS_PERMISSION}" on this account, or it is not a\n`
        + "           token at all\n"
        + `  fix      create one at ${API_TOKENS_URL} with exactly that permission, scoped to this account`,
    };
  }
  const said = errors.map((one) => `${one?.code ?? "?"}: ${one?.message ?? ""}`).join("; ");
  return {
    ok: false,
    reason: `Cloudflare refused to create the client (${status})${said === "" ? "" : `: ${said}`}`,
  };
}
