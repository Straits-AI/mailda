import { test } from "node:test";
import assert from "node:assert/strict";
import { byteRange } from "../worker/range.mjs";

/** What the site's Worker answers a video's `Range` with (worker/range.mjs): the cases Safari and Chrome send. */
test("a Range header becomes the bytes it asks for, a 416, or the whole file", () => {
  const size = 1000;
  assert.equal(byteRange(null, size), null, "no header: the whole file");
  assert.deepEqual(byteRange("bytes=0-1", size), { start: 0, end: 1 }, "Safari's first probe");
  assert.deepEqual(byteRange("bytes=500-", size), { start: 500, end: 999 }, "open-ended: to the last byte");
  assert.deepEqual(byteRange("bytes=-100", size), { start: 900, end: 999 }, "the last 100 bytes");
  assert.deepEqual(byteRange("bytes=-5000", size), { start: 0, end: 999 }, "a suffix longer than the file is all of it");
  assert.deepEqual(byteRange("bytes=900-5000", size), { start: 900, end: 999 }, "an end past the file is clamped");
  assert.deepEqual(byteRange("bytes=999-999", size), { start: 999, end: 999 }, "the last byte alone");
  assert.equal(byteRange("bytes=1000-", size), "unsatisfiable", "a start at the size is past the end");
  assert.equal(byteRange("bytes=-0", size), "unsatisfiable", "an empty suffix");
  assert.equal(byteRange("bytes=5-2", size), null, "an end before the start is invalid, so ignored");
  assert.equal(byteRange("bytes=0-1,5-6", size), null, "several ranges: the whole file");
  assert.equal(byteRange("items=0-1", size), null, "another unit");
  assert.equal(byteRange("bytes=-", size), null, "neither end");
});
