/**
 * Types for `oauth-client.mjs`, so a TypeScript test can import it. Hand-written like `preflight.d.mts`,
 * and compared against the module's real exports by `test/node/declaration-drift.test.ts`.
 */

/** The one permission group an API token needs to create the client. */
export const OAUTH_CLIENTS_PERMISSION: string;

/** Cloudflare's own page where that token is created. */
export const API_TOKENS_URL: string;

/** That page with the one permission, the account and a name prefilled. */
export function tokenTemplateUrl(accountId: string, name: string): string;

export interface ClientRequest {
  client_name: string;
  grant_types: string[];
  response_types: string[];
  redirect_uris: string[];
  scopes: string[];
  token_endpoint_auth_method: string;
}

/** The create body, from the Node's ceremony: scopes may be strings or `{ scope }` rows. */
export function clientRequest(input: {
  name: string;
  redirectUri: string;
  scopes: ReadonlyArray<string | { scope: string }>;
}): ClientRequest;

export type CreatedClient =
  | { ok: true; clientId: string; clientSecret: string; scopes: string[] }
  | { ok: false; reason: string };

/** Cloudflare's answer, read into what `PUT /api/provider/client` takes, or a refusal. */
export function createdClient(status: number, json: unknown): CreatedClient;
