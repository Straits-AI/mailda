import { type Bytes, DEFAULT_FRAME_BYTES, open as openFrames, openStream, seal } from "@mailda/evidence";

import { aesKeyFrom, LEGACY_KEY_GENERATION, vault } from "./keyvault.ts";

/**
 * Raw MIME storage (§12, #7, #16).
 *
 * Evidence is envelope-encrypted at rest and framed at 256 KiB so a 25 MiB message can be streamed
 * rather than buffered — one-shot AES-GCM leaves 13.2 ms of dead air before the first byte and holds
 * the whole object in memory against the 128 MB limit (receipt: `evidence-frame-size.md`).
 *
 * The sealed layout is `header || body` in one R2 object: the 32-byte header first, then the frames.
 * One object per message, so there is no partial state where a header exists without its body.
 *
 * ## Which key opened it is recorded on the object
 *
 * ADR 28 gives each Node its own content key, generated into a Durable Object, and keys are
 * **numbered**. Every object carries its generation in R2 `customMetadata`, and that is the
 * authoritative answer to "what can decrypt this" — not a column, not a config value.
 *
 * Recording it on the object rather than in D1 is what makes re-sealing incremental. A crash between
 * writing the new object and updating D1's index costs one redundant pass; the reverse arrangement
 * would cost an unreadable message. Absent metadata means **generation 0**, the published constant
 * that shipped before the vault existed, which is why generation 0 remains readable and can never be
 * used to seal.
 */
const HEADER_BYTES = 32;

/** Metadata key. Changing this string orphans every existing object's generation. */
const GENERATION_META = "keyGeneration";

async function contentKeyFor(env: Env, generation: number): Promise<CryptoKey> {
  return aesKeyFrom((await vault(env).openingKey("content", generation)).secret);
}

export interface StoredEvidence {
  blobKey: string;
  plaintextSha256: string;
  plaintextBytes: number;
  keyGeneration: number;
}

/** Hex SHA-256 of the plaintext, so integrity survives a re-seal under a new key. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function putEvidence(
  env: Env,
  blobKey: string,
  plaintext: Bytes,
): Promise<StoredEvidence> {
  // Always the highest generation. `sealingKey` never returns the legacy constant, so a Node cannot
  // write a new object under a published key even by mistake.
  const sealing = await vault(env).sealingKey("content");
  const sealed = await seal(await aesKeyFrom(sealing.secret), plaintext, DEFAULT_FRAME_BYTES);

  const object = new Uint8Array(sealed.header.length + sealed.body.length);
  object.set(sealed.header, 0);
  object.set(sealed.body, sealed.header.length);

  await env.EVIDENCE.put(blobKey, object, {
    customMetadata: {
      frames: "aes-256-gcm/256KiB/v1",
      [GENERATION_META]: String(sealing.generation),
    },
  });

  return {
    blobKey,
    plaintextSha256: await sha256Hex(plaintext),
    plaintextBytes: plaintext.length,
    keyGeneration: sealing.generation,
  };
}

/** Absent metadata is generation 0 — an object written before the vault existed. */
export function generationOf(object: { customMetadata?: Record<string, string> }): number {
  const raw = object.customMetadata?.[GENERATION_META];
  const parsed = raw === undefined ? LEGACY_KEY_GENERATION : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : LEGACY_KEY_GENERATION;
}

interface FetchedEvidence {
  header: Bytes;
  body: Bytes;
  generation: number;
}

async function fetchSealed(env: Env, blobKey: string): Promise<FetchedEvidence> {
  const object = await env.EVIDENCE.get(blobKey);
  if (object === null) {
    throw new Error(
      `E_EVIDENCE_MISSING  no R2 object at ${blobKey}\n` +
        `  why      a receipt records this message as accepted, so this is lost mail rather than a ` +
        `bookkeeping error (§24)\n` +
        `  fix      run the reconciler (\`reconcile.ts\`) to enumerate every affected receipt; do not ` +
        `delete the receipts and do not report the message as readable`,
    );
  }
  const all = new Uint8Array(await object.arrayBuffer());
  return {
    header: all.subarray(0, HEADER_BYTES),
    body: all.subarray(HEADER_BYTES),
    generation: generationOf(object),
  };
}

/** Whole-object read. For small messages and tests; see `streamEvidence` for a response path. */
export async function getEvidence(env: Env, blobKey: string): Promise<Bytes> {
  const fetched = await fetchSealed(env, blobKey);
  return openFrames(await contentKeyFor(env, fetched.generation), fetched);
}

/**
 * Streaming read — emits each frame as it authenticates and never materialises the whole plaintext.
 * This is what any response path must use (#16).
 */
export async function streamEvidence(env: Env, blobKey: string): Promise<ReadableStream<Uint8Array>> {
  const fetched = await fetchSealed(env, blobKey);
  return openStream(await contentKeyFor(env, fetched.generation), fetched);
}

/** For `reseal.ts`: the plaintext plus the generation it was found under. */
export async function openForReseal(
  env: Env,
  blobKey: string,
): Promise<{ plaintext: Bytes; generation: number }> {
  const fetched = await fetchSealed(env, blobKey);
  return {
    plaintext: await openFrames(await contentKeyFor(env, fetched.generation), fetched),
    generation: fetched.generation,
  };
}
