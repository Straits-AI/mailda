/**
 * Which bytes a `Range` header asks for, out of `size` (RFC 9110 §14.1.2), apart from the Worker so a test can
 * import it (AGENTS.md 2b, the seam).
 *
 * `{ start, end }` (inclusive) is a range to answer with 206; `"unsatisfiable"` is a 416; `null` means answer the
 * whole file with 200, which the RFC allows for anything this does not serve: no header, a malformed one, a unit
 * other than bytes, or several ranges at once (no browser asks for those when it plays a video).
 */
export function byteRange(header, size) {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const last = Number(match[2]);
    return last === 0 ? "unsatisfiable" : { start: Math.max(0, size - last), end: size - 1 };
  }
  const start = Number(match[1]);
  if (start >= size) return "unsatisfiable";
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return end < start ? null : { start, end };
}
