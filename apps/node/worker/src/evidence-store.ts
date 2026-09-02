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
  /** False when the object carried no generation metadata, so `generation` is a default and not a claim. */
  declared: boolean;
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
    /*
     * Whether the object **said** which key sealed it, as opposed to the generation-0 default standing in
     * for silence (#142). `generationOf` cannot distinguish the two — both answer 0 — and the difference
     * decides whether a failed open is a lost key or a lost label.
     */
    declared: object.customMetadata?.[GENERATION_META] !== undefined,
  };
}

/**
 * Opens an object whose metadata does not say which key sealed it, by trying the ones this vault holds.
 *
 * ## Why a Node should not need the label
 *
 * `putEvidence` records the sealing generation in R2 custom metadata, and **ordinary tooling drops it**:
 * `wrangler r2 object get | put` has no flag for custom metadata, so a bucket copied that way arrives
 * byte-perfect and unreadable. Measured in #92's restore drill, on objects whose correct key was sitting in
 * the destination's vault the whole time — the evidence was intact, the key was present, and a label lost in
 * transit was the only thing between them.
 *
 * A runbook warning is the wrong shape for that. The generation is a **hint**, not the authority: AES-GCM
 * authenticates, so a wrong key does not decrypt to wrong plaintext, it fails. Trying the small set the
 * vault holds either finds the one that works or proves none does, and it cannot be fooled.
 *
 * ## What it costs, and when
 *
 * Nothing in the ordinary case: an object that carries its label takes exactly the path it always did, and
 * this function is not called. On the fallback path it costs one extra decrypt of the **first frame** per
 * candidate, bounded by the number of generations in the vault — small, because rotation is rare, and
 * enumerated from storage rather than assumed.
 *
 * Generation 0 is tried first and separately: it is the published pre-vault constant, so an object genuinely
 * written before the vault existed opens immediately rather than after every real key has been tried.
 */
async function openWithoutALabel(
  env: Env,
  fetched: FetchedEvidence,
  cache?: RunKeyCache,
): Promise<{ plaintext: Bytes; generation: number }> {
  const candidates = [LEGACY_KEY_GENERATION, ...await vault(env).generations("content")];
  let last: unknown = null;
  for (const generation of candidates) {
    try {
      const plaintext = await openFrames(await contentKeyFor(env, generation, cache), fetched);
      return { plaintext, generation };
    } catch (error) {
      // Kept, not swallowed: if every candidate fails the caller gets a real decrypt error rather than a
      // summary this function invented, and the last one is the most informative.
      last = error;
    }
  }
  throw last ?? new Error("E_EVIDENCE_NO_KEY  the vault holds no key that opens this object");
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
  if (!fetched.declared) return (await openWithoutALabel(env, fetched, cache)).plaintext;
  return openFrames(await contentKeyFor(env, fetched.generation, cache), fetched);
}

/**
 * Streaming read — emits each frame as it authenticates and never materialises the whole plaintext.
 * This is what any response path must use (#16).
 */
export async function streamEvidence(env: Env, blobKey: string): Promise<ReadableStream<Uint8Array>> {
  const fetched = await fetchSealed(env, blobKey);
  if (!fetched.declared) {
    /*
     * Same recovery as `openWithoutALabel`, and it cannot share that function because a response path must
     * not materialise the plaintext (#16). What it can do is **probe one frame**: the sealed bytes are
     * already in memory, so a candidate key is tested by pulling the first chunk and discarding it, then
     * streaming properly with the key that worked. One frame's decrypt per candidate, and only for an object
     * whose label was lost — never on the ordinary path.
     *
     * The header is AES-GCM additional data, so a cheaper probe over a truncated copy is not available: any
     * edit to the header fails authentication by design, which is the property that makes the probe
     * trustworthy in the first place.
     */
    const key = await keyThatOpensTheFirstFrame(env, fetched);
    return openStream(key, fetched);
  }
  return openStream(await contentKeyFor(env, fetched.generation), fetched);
}

/** The first candidate key whose first frame authenticates. Throws the last failure if none does. */
async function keyThatOpensTheFirstFrame(env: Env, fetched: FetchedEvidence): Promise<CryptoKey> {
  const candidates = [LEGACY_KEY_GENERATION, ...await vault(env).generations("content")];
  let last: unknown = null;
  for (const generation of candidates) {
    const key = await contentKeyFor(env, generation);
    const reader = openStream(key, fetched).getReader();
    try {
      await reader.read();
      return key;
    } catch (error) {
      last = error;
    } finally {
      // Cancelled either way: a reader left open on a stream nobody consumes holds the object's bytes.
      await reader.cancel().catch(() => {});
    }
  }
  throw last ?? new Error("E_EVIDENCE_NO_KEY  the vault holds no key that opens this object");
}

/** For `reseal.ts`: the plaintext plus the generation it was found under. */
export async function openForReseal(
  env: Env,
  blobKey: string,
): Promise<{ plaintext: Bytes; generation: number }> {
  const fetched = await fetchSealed(env, blobKey);
  /*
   * The generation is **what opened it**, not what the object claimed, and for `reseal.ts` that is the
   * difference between re-sealing correctly and skipping. An unlabelled object read as generation 0 would
   * look older than the target and be re-sealed under a key it was never sealed with.
   */
  if (!fetched.declared) return openWithoutALabel(env, fetched);
  return {
    plaintext: await openFrames(await contentKeyFor(env, fetched.generation), fetched),
    generation: fetched.generation,
  };
}
