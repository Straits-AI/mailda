import { DEFAULT_FRAME_BYTES, open as openFrames, seal } from "@mailda/evidence";

/**
 * Credential wrapping (ADR 22).
 *
 * #7 split keys by purpose, and this is the other half of the split from `evidence-store.ts`:
 * the **credential** KEK protects things that mint or spend authority — token-signing keys,
 * transport credentials, model keys — and is never used for message content.
 *
 * The split only pays off if it is maintained. One KEK for both would mean a single leaked
 * secret that can read every message *and* forge a session for any user; two means a content
 * compromise cannot escalate into impersonation.
 *
 * Wrapping reuses `@mailda/evidence`'s framed AES-GCM rather than opening a second
 * hand-rolled AES-GCM path. A wrapped JWK is a few hundred bytes and fits in one frame, so
 * framing costs nothing here — and the alternative is a second nonce discipline to get right,
 * which is how nonce reuse happens.
 */

const DEV_ONLY_CREDENTIAL_KEK = "mailda-local-development-only-credential-kek";

/**
 * Present when the Node is running without a provisioned credential KEK. `doctor` must fail
 * on this: a signing key wrapped under a published constant is not protected, and looking
 * protected is worse than being visibly unprotected.
 */
export function isUsingDevCredentialKek(env: Env): boolean {
  return env.CREDENTIAL_KEK === undefined;
}

async function credentialKey(env: Env): Promise<CryptoKey> {
  const secret = await credentialSecret(env);
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Three states, not two, and conflating the middle one is how a silent downgrade happens:
 *
 *   binding absent        — local development. Falls back to a published constant, and `doctor`
 *                           refuses to let a Node reach production in this state.
 *   binding present, ok   — the real thing.
 *   binding present, fails — a **misconfiguration**: the store or secret name is wrong, or access
 *                           was revoked. This must fail loudly. Falling back here would silently
 *                           re-wrap credentials under a key published in this repository, and
 *                           everything would appear to work.
 */
async function credentialSecret(env: Env): Promise<string> {
  if (env.CREDENTIAL_KEK === undefined) return DEV_ONLY_CREDENTIAL_KEK;

  try {
    return await env.CREDENTIAL_KEK.get();
  } catch (cause) {
    throw new Error(
      "E_CREDENTIAL_KEK_UNREADABLE  binding CREDENTIAL_KEK is present but could not be read\n" +
        `  why      ${(cause as Error).message}\n` +
        "  why      refusing to fall back — the fallback key is published in this repository, so " +
        "wrapping credentials under it would look like it worked\n" +
        "  fix      check secrets_store_secrets in wrangler.jsonc against " +
        "`wrangler secrets-store secret list <store-id> --remote`",
      { cause },
    );
  }
}

/** Wraps a credential for storage in D1. Returns base64 of `header || body`. */
export async function wrapCredential(env: Env, plaintext: string): Promise<string> {
  const sealed = await seal(await credentialKey(env), new TextEncoder().encode(plaintext), DEFAULT_FRAME_BYTES);
  const bytes = new Uint8Array(sealed.header.length + sealed.body.length);
  bytes.set(sealed.header, 0);
  bytes.set(sealed.body, sealed.header.length);
  return btoa(String.fromCharCode(...bytes));
}

const HEADER_BYTES = 32;

export async function unwrapCredential(env: Env, wrapped: string): Promise<string> {
  const bytes = Uint8Array.from(atob(wrapped), (c) => c.charCodeAt(0));
  const plaintext = await openFrames(await credentialKey(env), {
    header: bytes.subarray(0, HEADER_BYTES),
    body: bytes.subarray(HEADER_BYTES),
  });
  return new TextDecoder().decode(plaintext);
}
