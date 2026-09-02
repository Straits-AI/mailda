import { DEFAULT_FRAME_BYTES, open as openFrames, seal, utf8 } from "@mailda/evidence";

import { aesKeyFrom, vault } from "../keyvault.ts";

/**
 * Credential wrapping (ADR 22, ADR 28).
 *
 * #7 split keys by purpose and this is the other half of the split from `evidence-store.ts`: the
 * **credential** key protects things that mint or spend authority — token-signing keys, transport
 * credentials, model keys — and is never used for message content. The split only pays off if it is
 * maintained: one key for both would mean a single leaked secret that reads every message *and*
 * forges a session for any user.
 *
 * Both keys now come from the per-Node `KeyVault` rather than a Secrets Store binding. ADR 28 has the
 * argument; the short version is that Secrets Store bindings are not account-portable, and #7 had
 * already established they never protected against the platform anyway. ADR 22's load-bearing
 * property is unchanged — the key arrives over RPC and is never a property of `env`, so serializing
 * `env` still discloses nothing.
 *
 * Wrapping reuses `@mailda/evidence`'s framed AES-GCM rather than opening a second hand-rolled
 * AES-GCM path. A wrapped JWK is a few hundred bytes and fits in one frame, so framing costs nothing
 * here — and the alternative is a second nonce discipline to get right, which is how nonce reuse
 * happens.
 *
 * ## Wrapped values carry their generation
 *
 * The generation is prefixed to the ciphertext as `v<n>.<base64>`, because a wrapped credential in
 * D1 has no metadata to hang it on the way an R2 object does. Rotating the credential key therefore
 * leaves existing signing keys unwrappable-but-known rather than silently corrupt: `openingKey`
 * reports the generation it cannot find, and `doctor` surfaces it.
 *
 * Values without a prefix are generation 0 — written before the vault existed.
 */

const HEADER_BYTES = 32;
const PREFIX = /^v(\d+)\./;

async function wrapWith(sealing: { generation: number; secret: string }, plaintext: string) {
  const sealed = await seal(
    await aesKeyFrom(sealing.secret),
    utf8(plaintext),
    DEFAULT_FRAME_BYTES,
  );
  const bytes = new Uint8Array(sealed.header.length + sealed.body.length);
  bytes.set(sealed.header, 0);
  bytes.set(sealed.body, sealed.header.length);
  return `v${sealing.generation}.${btoa(String.fromCharCode(...bytes))}`;
}

export async function wrapCredential(env: Env, plaintext: string): Promise<string> {
  return wrapWith(await vault(env).sealingKey("credential"), plaintext);
}

/**
 * Whether the credential key can wrap and unwrap, without recording it as **used** (#138).
 *
 * `doctor` checks this key by using it, which is right — presence was never the interesting question. But it
 * wraps a constant and throws the result away, so nothing durable is sealed, and going through
 * `wrapCredential` marked the generation as load-bearing anyway. On a fresh Node that made the escrow's
 * generation 1 unusable before the Node could even be claimed: measured in #92's drill as a redemption that
 * answered 200 and installed nothing.
 *
 * A separate entry point rather than a `probe: true` parameter on `wrapCredential`. The hazard runs the other
 * way too — a real caller passing the flag would leave a genuinely used generation looking reserved, and a
 * later restore would then replace the key that opens this Node's signing keys. A function named for probing
 * cannot be mistaken for one that wraps something worth keeping, and both share `wrapWith`, so there is one
 * implementation of the crypto.
 */
export async function probeCredentialKey(env: Env): Promise<boolean> {
  const probe = "doctor-credential-key-round-trip";
  return (await unwrapCredential(env, await wrapWith(await vault(env).ensureKey("credential"), probe)))
    === probe;
}

export async function unwrapCredential(env: Env, wrapped: string): Promise<string> {
  const match = PREFIX.exec(wrapped);
  const generation = match === null ? 0 : Number(match[1]);
  const payload = match === null ? wrapped : wrapped.slice(match[0].length);

  const key = await aesKeyFrom((await vault(env).openingKey("credential", generation)).secret);
  const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  const plaintext = await openFrames(key, {
    header: bytes.subarray(0, HEADER_BYTES),
    body: bytes.subarray(HEADER_BYTES),
  });
  return new TextDecoder().decode(plaintext);
}

/** The generation a wrapped credential was sealed under, for `doctor` and for rotation. */
export function credentialGenerationOf(wrapped: string): number {
  const match = PREFIX.exec(wrapped);
  return match === null ? 0 : Number(match[1]);
}
