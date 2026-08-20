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

/**
 * A cache of vault keys **belonging to one operation**, or absent (#65).
 *
 * ## Why this is a parameter and not a module-level map
 *
 * Every vault call is a Durable Object RPC and therefore a subrequest. A read-decrypt-re-emit spends two of
 * them per message — one opening key, one sealing key — and on a bulk export that is the difference between
 * a run finishing in one instance and needing two. Caching them removes both.
 *
 * What it costs is **staleness of a content key**, and that is why the cache is scoped to a caller's own
 * object rather than to the isolate. `auth/keys.ts` caches signing keys isolate-wide with its TTL reasoned
 * explicitly as *"a staleness bound on key revocation"*; doing the same here would make content-key
 * revocation eventually-consistent **product-wide** in order to speed up one feature, which is a much
 * heavier promise than the one being asked for. Confined to one run, the longest a stale key can survive is
 * that run — which is already the unit the export's approval authorizes.
 *
 * Every other caller passes nothing and behaves exactly as before, byte for byte: `undefined` means "ask the
 * vault", which is what `getEvidence`, `streamEvidence` and `openForReseal` all still do. Forgetting to pass
 * one costs subrequests and can never cost correctness, which is the direction an optional parameter is
 * allowed to fail in.
 */
export interface RunKeyCache {
  /** Opening keys by generation. A generation's key never changes, so within a run this cannot go wrong. */
  opening: Map<number, CryptoKey>;
  /** The sealing key and the generation it is. Null until the first seal in this run. */
  sealing: { generation: number; key: CryptoKey } | null;
}

/** A fresh cache. Held by one operation and discarded with it — there is deliberately no way to share one. */
export function runKeyCache(): RunKeyCache {
  return { opening: new Map(), sealing: null };
}

async function contentKeyFor(
  env: Env,
  generation: number,
  cache?: RunKeyCache,
): Promise<CryptoKey> {
  const cached = cache?.opening.get(generation);
  if (cached !== undefined) return cached;
  const key = await aesKeyFrom((await vault(env).openingKey("content", generation)).secret);
  cache?.opening.set(generation, key);
  return key;
}

export interface StoredEvidence {
  blobKey: string;
  plaintextSha256: string;
  plaintextBytes: number;
  keyGeneration: number;
}

/** Hex SHA-256 of the plaintext, so integrity survives a re-seal under a new key. */
/** Exported so a caller can ask "is this the same content?" without writing an object to find out. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function putEvidence(
  env: Env,
  blobKey: string,
  plaintext: Bytes,
  options: {
    /** See `RunKeyCache`. Absent means "ask the vault", which is what every pre-#65 caller does. */
    cache?: RunKeyCache;
    /**
     * Extra `customMetadata` entries, merged **under** the two this function owns.
     *
     * One caller: an eDiscovery export stamps each staged object with its plaintext SHA-256, so the manifest
     * can be built from a single `R2Bucket.list()` with `include: ["customMetadata"]` rather than from one
     * `get` per message. The order of the spread is what makes that safe — `frames` and `keyGeneration` are
     * written last, so a caller cannot overwrite the fields that decide whether an object can be opened.
     */
    metadata?: Record<string, string>;
  } = {},
): Promise<StoredEvidence> {
  // Always the highest generation. `sealingKey` never returns the legacy constant, so a Node cannot
  // write a new object under a published key even by mistake.
  const cached = options.cache?.sealing;
  const sealing = cached ?? await (async () => {
    const key = await vault(env).sealingKey("content");
    const derived = { generation: key.generation, key: await aesKeyFrom(key.secret) };
    if (options.cache !== undefined) options.cache.sealing = derived;
    return derived;
  })();
  const sealed = await seal(sealing.key, plaintext, DEFAULT_FRAME_BYTES);

  const object = new Uint8Array(sealed.header.length + sealed.body.length);
  object.set(sealed.header, 0);
  object.set(sealed.body, sealed.header.length);

  await env.EVIDENCE.put(blobKey, object, {
    customMetadata: {
      ...options.metadata,
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

/**
 * A receipt points at bytes that are not there.
 *
 * Its own class rather than a plain `Error` because the two answers are not alike: this is **lost mail**
 * (§24), and the generic handler reported it as "this Node failed to handle the request" — a fault, opaque,
 * indistinguishable from a bug in the request path. The message below has always said exactly what happened
 * and what to do about it; nothing was reading it.
 */
export class EvidenceMissing extends Error {
  constructor(readonly blobKey: string, message: string) {
    super(message);
    this.name = "E_EVIDENCE_MISSING";
  }
}

async function fetchSealed(env: Env, blobKey: string): Promise<FetchedEvidence> {
  const object = await env.EVIDENCE.get(blobKey);
  if (object === null) {
    throw new EvidenceMissing(
      blobKey,
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

/**
 * Whole-object read. For small messages and tests; see `streamEvidence` for a response path.
 *
 * `cache` is the export's run-scoped key cache and is absent everywhere else — see `RunKeyCache`.
 */
export async function getEvidence(
  env: Env,
  blobKey: string,
  cache?: RunKeyCache,
): Promise<Bytes> {
  const fetched = await fetchSealed(env, blobKey);
  return openFrames(await contentKeyFor(env, fetched.generation, cache), fetched);
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
