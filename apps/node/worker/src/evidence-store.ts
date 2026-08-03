import { DEFAULT_FRAME_BYTES, open as openFrames, openStream, seal } from "@mailda/evidence";

import type { Env } from "./env.ts";

/**
 * Raw MIME storage (§12, #7, #16).
 *
 * Evidence is envelope-encrypted at rest and framed at 256 KiB so a 25 MiB message can be
 * streamed rather than buffered — one-shot AES-GCM leaves 13.2 ms of dead air before the
 * first byte and holds the whole object in memory against the 128 MB limit
 * (receipt: evidence-frame-size.md).
 *
 * The sealed layout is `header || body` in one R2 object: the 32-byte header first, then
 * the frames. Keeping them together means one object per message, so there is no partial
 * state where a header exists without its body.
 */
const HEADER_BYTES = 32;

/**
 * Per-object DEK, wrapped by the content KEK.
 *
 * #7 split keys by purpose: the *content* key is one the Worker must be able to unwrap,
 * because serving mail is its job. A *credential* key — for transport tokens and model
 * keys — is never used for content and lives in Secrets Store (ADR 22).
 *
 * Layer 1 derives the content key from the KEK directly. Per-object DEK wrapping is the
 * next increment; the seam is here so it does not require touching callers.
 */
async function contentKey(env: Env): Promise<CryptoKey> {
  const secret = (await env.CONTENT_KEK?.get()) ?? DEV_ONLY_KEK;
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Used only when CONTENT_KEK is unbound, which happens in local tests. A Node without the
 * binding must never reach production: `doctor` fails on it rather than falling back
 * silently, because a silent fallback to a known key is worse than no encryption at all —
 * it looks encrypted.
 */
const DEV_ONLY_KEK = "mailda-local-development-only-not-a-secret";

export function isUsingDevKek(env: Env): boolean {
  return env.CONTENT_KEK === undefined;
}

export interface StoredEvidence {
  blobKey: string;
  plaintextSha256: string;
  plaintextBytes: number;
}

/** Hex SHA-256 of the plaintext, so integrity survives a future re-seal under a new key. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function putEvidence(
  env: Env,
  blobKey: string,
  plaintext: Uint8Array,
): Promise<StoredEvidence> {
  const key = await contentKey(env);
  const sealed = await seal(key, plaintext, DEFAULT_FRAME_BYTES);
  const object = new Uint8Array(sealed.header.length + sealed.body.length);
  object.set(sealed.header, 0);
  object.set(sealed.body, sealed.header.length);

  await env.EVIDENCE.put(blobKey, object, {
    customMetadata: { frames: "aes-256-gcm/256KiB/v1" },
  });

  return {
    blobKey,
    plaintextSha256: await sha256Hex(plaintext),
    plaintextBytes: plaintext.length,
  };
}

async function fetchSealed(env: Env, blobKey: string) {
  const object = await env.EVIDENCE.get(blobKey);
  if (object === null) {
    throw new Error(
      `E_EVIDENCE_MISSING  no R2 object at ${blobKey}\n` +
        `  fix      a receipt references a blob that is absent — run the orphan/missing-blob ` +
        `reconciler (§13); do not report the message as readable`,
    );
  }
  const all = new Uint8Array(await object.arrayBuffer());
  return { header: all.subarray(0, HEADER_BYTES), body: all.subarray(HEADER_BYTES) };
}

/** Whole-object read. For small messages and tests; see `streamEvidence` for a response path. */
export async function getEvidence(env: Env, blobKey: string): Promise<Uint8Array> {
  return openFrames(await contentKey(env), await fetchSealed(env, blobKey));
}

/**
 * Streaming read — emits each frame as it authenticates and never materialises the whole
 * plaintext. This is what any response path must use (#16).
 */
export async function streamEvidence(env: Env, blobKey: string): Promise<ReadableStream<Uint8Array>> {
  return openStream(await contentKey(env), await fetchSealed(env, blobKey));
}
