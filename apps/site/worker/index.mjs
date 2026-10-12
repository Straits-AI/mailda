/* global FixedLengthStream -- a Workers runtime global (developers.cloudflare.com/workers/runtime-apis/streams/) */
import manifest from "../src/videos.json";
import { byteRange } from "./range.mjs";

/** Each file's size, from the manifest whose sha256 the deploy checked: the assets' answer carries no Content-Length. */
const SIZES = new Map(manifest.videos.flatMap((one) => [one.video, one.poster]).map((file) => [`/videos/${file.file}`, file.bytes]));

/**
 * The site's one piece of runtime, for `/videos/*` only (`run_worker_first` in wrangler.jsonc); every other path is
 * served by the assets as before, without this script.
 *
 * Workers static assets answer a `Range` request with the whole file and 200, and Safari will not play a video
 * from a server that does that (measured on mailda.site, 12 October 2026: `Range: bytes=0-99` gave 200 and all
 * 16,334,642 bytes). So this answers ranges itself, streaming the asset and passing on only the bytes asked for,
 * never holding a whole video in memory. If the assets ever answer a range themselves (206), it is passed through
 * untouched rather than cut twice. A file the manifest does not name is answered whole. `If-Range` is not read: a
 * video changes only by a new file name.
 */
export default {
  async fetch(request, env) {
    const asset = await env.ASSETS.fetch(request);
    const size = SIZES.get(new URL(request.url).pathname);
    const range = asset.status === 200 && request.method === "GET" && size !== undefined
      ? byteRange(request.headers.get("range"), size)
      : null;
    const headers = new Headers(asset.headers);
    headers.set("accept-ranges", "bytes");
    if (range === null) return new Response(asset.body, { status: asset.status, headers });
    if (range === "unsatisfiable") {
      await asset.body?.cancel();
      headers.set("content-range", `bytes */${size}`);
      headers.delete("content-length");
      return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    return new Response(slice(asset.body, range.start, range.end), { status: 206, headers });
  },
};

/**
 * The stream's bytes from `start` to `end` inclusive; it stops reading the asset once `end` has passed. Through a
 * FixedLengthStream, so the answer carries its Content-Length rather than arriving chunked.
 */
function slice(body, start, end) {
  let at = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, out) {
      const from = Math.max(start - at, 0);
      const to = Math.min(end + 1 - at, chunk.byteLength);
      if (to > from) out.enqueue(chunk.subarray(from, to));
      at += chunk.byteLength;
      if (at > end) out.terminate();
    },
  })).pipeThrough(new FixedLengthStream(end - start + 1));
}
