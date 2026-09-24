import { describe, expect, it } from "vitest";

const { clientRequest, createdClient, tokenTemplateUrl, API_TOKENS_URL, OAUTH_CLIENTS_PERMISSION } = await import("../../../../../packages/cli/src/oauth-client.mjs");

/**
 * `mailda install` creates the Node's OAuth client through Cloudflare's API (23 September 2026). The request
 * is built from the Node's own ceremony, so what the API registers is what the Setup screen would have told
 * a person to tick; and the answer is read into the two values `PUT /api/provider/client` takes, or a
 * refusal that names the one permission the token needed.
 *
 * The scopes here are a fixture in the ceremony's shape, not `REQUIRED_SCOPES`: `grant-oauth.ts` imports
 * the key vault's Durable Object and cannot load under node. Nothing is lost, because the CLI never holds
 * the list either — it reads `GET /api/provider` from the Node it just claimed and passes that through.
 */
describe("the OAuth client mailda install creates", () => {
  const redirectUri = "https://mailda.example.workers.dev/oauth/cloudflare/callback";
  const scopes = [
    { scope: "zone.read", why: "which zone would carry mail" },
    { scope: "dns.write", why: "the MX records" },
    { scope: "offline_access", why: "the refresh token; Cloudflare adds it itself" },
  ];
  const request = clientRequest({ name: "mailda", redirectUri, scopes });

  it("registers the Node's scopes as the ceremony lists them, without offline_access, which Cloudflare adds itself", () => {
    expect(request.scopes).toEqual(["zone.read", "dns.write"]);
    expect(request.client_name).toBe("Mailda (mailda)");
  });

  it("asks for the refresh token grant and the Node's own redirect URI, and authenticates the way the Node exchanges", () => {
    expect(request.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(request.redirect_uris).toEqual([redirectUri]);
    expect(request.response_types).toEqual(["code"]);
    expect(request.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  it("prefills the token form with the one permission, the account, and a name that says to delete it", () => {
    const url = new URL(tokenTemplateUrl("1e0170aaabc90ecf5f466128d1f0466a", "mailda"));
    expect(url.origin + url.pathname).toBe(API_TOKENS_URL);
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "")).toEqual([{ key: "oauth_app_registrations", type: "edit" }]);
    expect(url.searchParams.get("accountId")).toBe("1e0170aaabc90ecf5f466128d1f0466a");
    expect(url.searchParams.get("name")).toContain("delete after use");
  });

  it("reads a created client into the id and the once-shown secret", () => {
    const read = createdClient(200, {
      success: true,
      result: { client_id: "abc", client_secret: "s3cret+/=", scopes: ["zone.read", "offline_access"] },
    });
    expect(read).toEqual({ ok: true, clientId: "abc", clientSecret: "s3cret+/=", scopes: ["zone.read", "offline_access"] });
  });

  it("names the permission when Cloudflare answers with an authentication error, which is what a wrong token gets", () => {
    // Measured 23 September 2026: a token without the permission gets 403 with code 10000, not a scope name.
    const read = createdClient(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    if (read.ok) throw new Error("a 403 was read as a created client");
    expect(read.reason).toContain(OAUTH_CLIENTS_PERMISSION);
    expect(read.reason).toContain("fix");
  });

  it("repeats Cloudflare's own words for any other refusal, and a success without a secret is a refusal", () => {
    const read = createdClient(400, { success: false, errors: [{ code: 1001, message: "redirect_uris must be https" }] });
    if (read.ok) throw new Error("a 400 was read as a created client");
    expect(read.reason).toContain("1001: redirect_uris must be https");
    expect(createdClient(200, { success: true, result: { client_id: "abc" } }).ok).toBe(false);
  });
});
