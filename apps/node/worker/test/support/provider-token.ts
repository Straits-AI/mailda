import { wrapCredential } from "../../src/auth/kek.ts";

/**
 * A Node holding a Cloudflare API token, written the way `registerToken` writes it and skipping the two
 * Cloudflare reads it makes first. For the provisioning suites, whose subject is what happens *with* a
 * credential; `provider-grant.test.ts` is where registration itself is tested.
 */
export async function holdToken(
  env: Env, accountId: string, at: number, token = "an-access",
): Promise<void> {
  const iso = new Date(at).toISOString();
  await env.CATALOG.prepare(
    "INSERT OR REPLACE INTO provider_token (id, token, account_id, account_name, verified_at, registered_at, registered_by) "
    + "VALUES (1, ?, ?, ?, ?, ?, ?)",
  ).bind(await wrapCredential(env, token), accountId, "Test account", iso, iso, "usr_fixture").run();
}
