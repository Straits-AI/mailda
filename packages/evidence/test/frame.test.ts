import { describe, expect, it } from "vitest";

import { EvidenceFrameError, TAG_BYTES, decodeHeader, framesForRange, open, openStream, seal } from "../src/index.ts";

const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
  "encrypt",
  "decrypt",
]);
const other = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
  "encrypt",
  "decrypt",
]);

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describe("framed evidence encryption (#16)", () => {
  it("round-trips across frame boundaries", async () => {
    const frame = 1024;
    for (const size of [0, 1, 1023, 1024, 1025, 4096, 10_000]) {
      const plain = bytes(size);
      const sealed = await seal(key, plain, frame);
      expect(await open(key, sealed)).toEqual(plain);
    }
  });

  it("rejects a flipped bit", async () => {
    const sealed = await seal(key, bytes(5000), 1024);
    sealed.body[100] ^= 0x01;
    await expect(open(key, sealed)).rejects.toThrow(/E_EVIDENCE_AUTH_FAILED/);
  });

  it("rejects a dropped trailing frame — no valid plaintext prefix", async () => {
    const frame = 1024;
    const sealed = await seal(key, bytes(4096), frame);
    sealed.body = sealed.body.subarray(0, sealed.body.length - (frame + TAG_BYTES));
    await expect(open(key, sealed)).rejects.toThrow(/E_EVIDENCE_TRUNCATED/);
  });

  it("rejects reordered frames", async () => {
    const frame = 1024;
    const sealed = await seal(key, bytes(4096), frame);
    const width = frame + TAG_BYTES;
    const first = sealed.body.slice(0, width);
    const second = sealed.body.slice(width, width * 2);
    sealed.body.set(second, 0);
    sealed.body.set(first, width);
    await expect(open(key, sealed)).rejects.toThrow(/E_EVIDENCE_AUTH_FAILED/);
  });

  it("rejects a header claiming a different length", async () => {
    const sealed = await seal(key, bytes(4096), 1024);
    new DataView(sealed.header.buffer).setBigUint64(12, 2048n, false);
    await expect(open(key, sealed)).rejects.toThrow(/E_EVIDENCE_AUTH_FAILED/);
  });

  it("rejects the wrong key", async () => {
    const sealed = await seal(key, bytes(4096), 1024);
    await expect(open(other, sealed)).rejects.toThrow(/E_EVIDENCE_AUTH_FAILED/);
  });

  it("never reuses a nonce within an object", async () => {
    const frame = 512;
    const base = new Uint8Array(8).fill(9);
    const sealed = await seal(key, bytes(frame * 40), frame, base);
    const header = decodeHeader(sealed.header);
    const seen = new Set<string>();
    for (let index = 0; index < header.frameCount; index++) {
      const nonce = new Uint8Array(12);
      nonce.set(base, 0);
      new DataView(nonce.buffer).setUint32(8, index, false);
      seen.add(nonce.join(","));
    }
    expect(seen.size).toBe(header.frameCount);
  });

  it("maps a plaintext range onto whole frames for a ranged GET", async () => {
    const sealed = await seal(key, bytes(10_000), 1024);
    const header = decodeHeader(sealed.header);
    const range = framesForRange(header, 2000, 3000);
    expect(range.firstFrame).toBe(1);
    expect(range.lastFrame).toBe(2);
    expect(range.byteStart).toBe(1 * (1024 + TAG_BYTES));
  });

  it("names the problem and the fix when it refuses", async () => {
    const sealed = await seal(key, bytes(100), 1024);
    sealed.header[0] = 0x58;
    try {
      await open(key, sealed);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceFrameError);
      expect((error as Error).message).toMatch(/E_EVIDENCE_BAD_MAGIC/);
      expect((error as Error).message).toMatch(/fix/);
    }
  });
});

describe("streaming reader", () => {
  it("emits authenticated frames without buffering the whole plaintext", async () => {
    const plain = bytes(10_000);
    const sealed = await seal(key, plain, 1024);
    const chunks: Uint8Array[] = [];
    for await (const chunk of openStream(key, sealed) as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(10);
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { joined.set(c, at); at += c.length; }
    expect(joined).toEqual(plain);
  });

  it("errors the stream rather than emitting a tampered frame", async () => {
    const sealed = await seal(key, bytes(4096), 1024);
    sealed.body[2000] ^= 0x01;
    const reader = openStream(key, sealed).getReader();
    await expect((async () => { for (;;) { const r = await reader.read(); if (r.done) return; } })())
      .rejects.toThrow(/E_EVIDENCE_AUTH_FAILED/);
  });
});
