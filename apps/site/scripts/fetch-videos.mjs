#!/usr/bin/env node
/**
 * Puts the landing pages' videos into `dist/videos/` at deploy (`pnpm run deploy`), after `astro build`. The build
 * itself stays offline, so CI and `pnpm test` never download them; the tests hold the pages to `src/videos.json`.
 *
 * The videos are not in git: the repository is how every Node installs and updates, so 80 MB of marketing would be
 * pulled by every clone and kept by history forever. They are assets of the GitHub release `src/videos.json` names,
 * and the site serves its own copies, so nothing on mailda.site is fetched from another origin (a release download
 * is a redirect to a signed URL that expires within the hour, served as an attachment). Each file is checked against
 * the sha256 the manifest records, so the site serves the bytes the repository reviewed, and a missing or changed
 * asset stops the deploy rather than shipping a broken player.
 *
 * Downloads are kept in `.videos/`, so a second build fetches nothing. A file already there that matches its hash
 * is used as it is, which is also how a build works before the release is published: put the files there by hand.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const site = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(site, "src/videos.json"), "utf8"));
const cache = join(site, ".videos");
const out = join(site, "dist/videos");
mkdirSync(cache, { recursive: true });
mkdirSync(out, { recursive: true });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const asset of manifest.videos.flatMap((one) => [one.video, one.poster])) {
  const kept = join(cache, asset.file);
  if (!existsSync(kept) || sha256(readFileSync(kept)) !== asset.sha256) {
    const url = `https://github.com/Straits-AI/mailda/releases/download/${manifest.release}/${asset.file}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`fetch-videos: ${url} answered ${response.status}. Is release ${manifest.release} published with ${asset.file}?`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const got = sha256(bytes);
    if (got !== asset.sha256) {
      throw new Error(`fetch-videos: ${asset.file} from ${manifest.release} is sha256 ${got}, and src/videos.json records ${asset.sha256}. Re-upload the reviewed file, or record the new one.`);
    }
    writeFileSync(kept, bytes);
    console.log(`fetch-videos: ${asset.file} downloaded and verified`);
  }
  // The site's Worker answers byte ranges from this number (worker/index.mjs), so it must be the file's.
  if (statSync(kept).size !== asset.bytes) {
    throw new Error(`fetch-videos: ${asset.file} is ${statSync(kept).size} bytes, and src/videos.json records ${asset.bytes}. Record its size.`);
  }
  copyFileSync(kept, join(out, asset.file));
}
