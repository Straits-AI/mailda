/**
 * Chunked envelope encryption for R2 evidence (#16).
 *
 * #7 decided the default profile encrypts raw MIME, attachments and exports at rest.
 * One-shot AES-GCM cannot deliver that: a 25 MiB message (§11B records Cloudflare
 * Email's inbound limit) would have to be held whole in memory against the Worker's
 * 128 MB budget, and its authentication tag only arrives at the very end — so nothing
 * could stream to the client until the entire object had been decrypted and verified.
 *
 * The object is therefore split into independently-authenticated frames.
 *
 * ```
 * header (32 bytes, authenticated as AAD on every frame)
 *   0  magic      "MLDA"            4
 *   4  version    1                 1
 *   5  reserved   0                 3
 *   8  frameSize  uint32 BE         4
 *  12  plainLen   uint64 BE         8
 *  20  baseNonce  random            8
 *  28  frameCount uint32 BE         4
 * then frameCount frames, each: ciphertext || 16-byte GCM tag
 * ```
 *
 * **Nonce discipline.** The 12-byte GCM nonce is `baseNonce(8) || frameIndex(4)`.
 * `baseNonce` is 8 fresh random bytes per object and `frameIndex` is unique within it,
 * so a nonce cannot repeat under a given DEK by construction rather than by care. GCM
 * nonce reuse is catastrophic, so this must not depend on anyone remembering.
 *
 * **Truncation and reordering.** Every frame's AAD is the full header plus its own
 * index. The header carries the plaintext length and frame count, so dropping a
 * trailing frame, reordering two frames, or splicing frames from another object all
 * fail authentication rather than yielding a valid plaintext prefix.
 */

/**
 * Bytes backed by a non-shared buffer.
 *
 * Not decoration. WebCrypto refuses a view onto a `SharedArrayBuffer`, and a bare `Uint8Array` means
 * `Uint8Array<ArrayBufferLike>`, which admits one — so the plain annotation claims this module accepts
 * input that `crypto.subtle` would reject at runtime. Stating the constraint in the type puts the
 * failure at the call site instead of inside an encrypt loop.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * UTF-8 encode into `Bytes`.
 *
 * The assertion is sound rather than convenient: TextEncoder is specified to return a view onto a
 * freshly allocated, non-shared ArrayBuffer, so the value always satisfies `Bytes` — but
 * `@cloudflare/workers-types` declares the looser `Uint8Array<ArrayBufferLike>` and cannot express
 * that. Kept here, once, so the reasoning is written down in the module that owns the constraint
 * instead of being re-derived at every call site as a bare cast.
 */
export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text) as Bytes;
}

export const MAGIC: Bytes = new Uint8Array([0x4d, 0x4c, 0x44, 0x41]); // "MLDA"
export const VERSION = 1;
export const HEADER_BYTES = 32;
export const TAG_BYTES = 16;

/** Measured in docs/receipts/evidence-frame-size.md. */
export const DEFAULT_FRAME_BYTES = 262_144;

export interface Header {
  version: number;
  frameSize: number;
  plainLength: number;
  baseNonce: Bytes;
  frameCount: number;
}

export class EvidenceFrameError extends Error {
  readonly code: string;
  constructor(code: string, detail: string, fix: string) {
    super(`${code}  ${detail}\n  fix      ${fix}`);
    this.code = code;
    this.name = "EvidenceFrameError";
  }
}

export function frameCountFor(plainLength: number, frameSize: number): number {
  return plainLength === 0 ? 1 : Math.ceil(plainLength / frameSize);
}

export function encodeHeader(header: Header): Bytes {
  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = header.version;
  view.setUint32(8, header.frameSize, false);
  view.setBigUint64(12, BigInt(header.plainLength), false);
  out.set(header.baseNonce, 20);
  view.setUint32(28, header.frameCount, false);
  return out;
}

export function decodeHeader(bytes: Uint8Array): Header {
  if (bytes.length < HEADER_BYTES) {
    throw new EvidenceFrameError(
      "E_EVIDENCE_TRUNCATED_HEADER",
      `object is ${bytes.length} bytes, header needs ${HEADER_BYTES}`,
      "the object is truncated or is not Mailda evidence; check the R2 key and version",
    );
  }
  for (let index = 0; index < MAGIC.length; index++) {
    if (bytes[index] !== MAGIC[index]) {
      throw new EvidenceFrameError(
        "E_EVIDENCE_BAD_MAGIC",
        `expected "MLDA", found ${JSON.stringify(String.fromCharCode(...bytes.slice(0, 4)))}`,
        "this object was not written by the evidence encoder",
      );
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[4]!;
  if (version !== VERSION) {
    throw new EvidenceFrameError(
      "E_EVIDENCE_BAD_VERSION",
      `frame version=${version}, this build understands ${VERSION}`,
      "restore from a build that understands this version, or migrate the object",
    );
  }
  return {
    version,
    frameSize: view.getUint32(8, false),
    plainLength: Number(view.getBigUint64(12, false)),
    baseNonce: bytes.slice(20, 28),
    frameCount: view.getUint32(28, false),
  };
}

/** nonce = baseNonce(8) || frameIndex(4). Unique per frame, per object, by construction. */
function nonceFor(baseNonce: Bytes, frameIndex: number): Bytes {
  const nonce = new Uint8Array(12);
  nonce.set(baseNonce, 0);
  new DataView(nonce.buffer).setUint32(8, frameIndex, false);
  return nonce;
}

/** AAD = header || frameIndex. Binds every frame to its object and its position. */
function aadFor(header: Bytes, frameIndex: number): Bytes {
  const aad = new Uint8Array(header.length + 4);
  aad.set(header, 0);
  new DataView(aad.buffer).setUint32(header.length, frameIndex, false);
  return aad;
}

export interface Sealed {
  header: Bytes;
  body: Bytes;
}

export async function seal(
  key: CryptoKey,
  plaintext: Bytes,
  frameSize: number = DEFAULT_FRAME_BYTES,
  baseNonce: Bytes = crypto.getRandomValues(new Uint8Array(8)),
): Promise<Sealed> {
  const frameCount = frameCountFor(plaintext.length, frameSize);
  const header = encodeHeader({
    version: VERSION,
    frameSize,
    plainLength: plaintext.length,
    baseNonce,
    frameCount,
  });

  const body = new Uint8Array(plaintext.length + frameCount * TAG_BYTES);
  let offset = 0;
  for (let index = 0; index < frameCount; index++) {
    const slice = plaintext.subarray(index * frameSize, (index + 1) * frameSize);
    const sealedFrame = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonceFor(baseNonce, index), additionalData: aadFor(header, index) },
        key,
        slice,
      ),
    );
    body.set(sealedFrame, offset);
    offset += sealedFrame.length;
  }
  return { header, body: body.subarray(0, offset) };
}

export async function open(key: CryptoKey, sealed: Sealed): Promise<Bytes> {
  const header = decodeHeader(sealed.header);
  const out = new Uint8Array(header.plainLength);
  let read = 0;
  let written = 0;

  for (let index = 0; index < header.frameCount; index++) {
    const remaining = header.plainLength - written;
    const plainInFrame = Math.min(header.frameSize, remaining);
    const sealedLength = plainInFrame + TAG_BYTES;
    const frame = sealed.body.subarray(read, read + sealedLength);
    if (frame.length !== sealedLength) {
      throw new EvidenceFrameError(
        "E_EVIDENCE_TRUNCATED",
        `frame ${index} of ${header.frameCount} is ${frame.length} bytes, expected ${sealedLength}`,
        "the object is truncated; restore it from backup rather than serving a partial message",
      );
    }
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonceFor(header.baseNonce, index), additionalData: aadFor(sealed.header, index) },
        key,
        frame,
      );
    } catch {
      throw new EvidenceFrameError(
        "E_EVIDENCE_AUTH_FAILED",
        `frame ${index} of ${header.frameCount} failed authentication`,
        "the object was altered, reordered, or encrypted under a different key; do not serve it",
      );
    }
    out.set(new Uint8Array(plain), written);
    written += plain.byteLength;
    read += sealedLength;
  }
  return out;
}

/**
 * Frames covering a plaintext byte range, for R2 ranged GETs.
 *
 * Frame size is the range-read granularity: reading one byte costs one whole frame.
 */
export function framesForRange(
  header: Header,
  start: number,
  end: number,
): { firstFrame: number; lastFrame: number; byteStart: number; byteEnd: number } {
  const firstFrame = Math.floor(start / header.frameSize);
  const lastFrame = Math.min(header.frameCount - 1, Math.floor((end - 1) / header.frameSize));
  const sealedFrame = header.frameSize + TAG_BYTES;
  return {
    firstFrame,
    lastFrame,
    byteStart: firstFrame * sealedFrame,
    byteEnd: (lastFrame + 1) * sealedFrame,
  };
}

/**
 * Streaming reader: emits each frame as it is authenticated, so a 25 MiB message never
 * exists whole in memory and the first bytes reach the client after one frame rather
 * than after the entire object.
 *
 * This is the reason for framing at all. `open()` above buffers the full plaintext and
 * exists for small objects and for tests; anything on a response path should use this.
 */
export function openStream(key: CryptoKey, sealed: Sealed): ReadableStream<Bytes> {
  const header = decodeHeader(sealed.header);
  let index = 0;
  let read = 0;
  let written = 0;

  return new ReadableStream<Bytes>({
    async pull(controller) {
      if (index >= header.frameCount) {
        controller.close();
        return;
      }
      const plainInFrame = Math.min(header.frameSize, header.plainLength - written);
      const sealedLength = plainInFrame + TAG_BYTES;
      const frame = sealed.body.subarray(read, read + sealedLength);
      if (frame.length !== sealedLength) {
        controller.error(
          new EvidenceFrameError(
            "E_EVIDENCE_TRUNCATED",
            `frame ${index} of ${header.frameCount} is ${frame.length} bytes, expected ${sealedLength}`,
            "the object is truncated; restore it from backup rather than serving a partial message",
          ),
        );
        return;
      }
      try {
        const plain = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: nonceFor(header.baseNonce, index),
            additionalData: aadFor(sealed.header, index),
          },
          key,
          frame,
        );
        controller.enqueue(new Uint8Array(plain));
        written += plain.byteLength;
      } catch {
        controller.error(
          new EvidenceFrameError(
            "E_EVIDENCE_AUTH_FAILED",
            `frame ${index} of ${header.frameCount} failed authentication`,
            "the object was altered, reordered, or encrypted under a different key; do not serve it",
          ),
        );
        return;
      }
      read += sealedLength;
      index += 1;
    },
  });
}
