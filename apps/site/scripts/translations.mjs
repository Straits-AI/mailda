/**
 * The repository's doc translations: `docs/zh-cn/<name>.md`, each naming the English file it was translated from and
 * the SHA-256 of the English it covers at the time: the whole file, or for a translation of the file's opening part
 * (`translated_until`) only that part, so an edit further down does not fail it (docs/i18n.md, *Doc translations*).
 * Read here once, for the generator that renders them and for the test that refuses one whose English has moved since.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const repo = resolve(import.meta.dirname, "../../..");
export const DIR = "docs/zh-cn";

/** CRLF folded first, so a checkout on Git Bash hashes as the repository does. */
export const read = (rel) => readFileSync(join(repo, rel), "utf8").replace(/\r\n/g, "\n");
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * One translation: its frontmatter, parsed, and its body. A field the rule needs and the file lacks is an error here,
 * not a skipped file, so a translation cannot opt out of the hash check by leaving its hash off.
 */
export function translation(rel) {
  const text = read(rel);
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (fm === null) throw new Error(`${rel} has no frontmatter: a translation names translated_from and source_sha256`);
  const field = (key) => {
    const raw = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm[1])?.[1]?.trim();
    return raw === undefined ? undefined : raw.startsWith('"') ? JSON.parse(raw) : raw;
  };
  const one = {
    rel,
    from: field("translated_from"),
    sha256: field("source_sha256"),
    commit: field("source_commit"),
    // A translation of the source's opening part ends before this line of the English; the rest stays English.
    until: field("translated_until"),
    body: text.slice(fm[0].length),
  };
  for (const key of ["from", "sha256", "commit"]) {
    if (one[key] === undefined) throw new Error(`${rel} lacks ${key === "from" ? "translated_from" : key === "sha256" ? "source_sha256" : "source_commit"}`);
  }
  return one;
}

export function translations() {
  if (!existsSync(join(repo, DIR))) return [];
  return readdirSync(join(repo, DIR)).filter((one) => one.endsWith(".md")).sort().map((file) => translation(`${DIR}/${file}`));
}

/**
 * The part of the English a translation covers: all of it, or everything before its `translated_until` line. Null when
 * that line is gone from the English, which is a change to the covered part too: where it ends is no longer known.
 */
export function covered(source, until) {
  if (until === undefined) return source;
  const lines = source.split("\n");
  const at = lines.indexOf(until);
  return at === -1 ? null : lines.slice(0, at).join("\n");
}

/** What `source_sha256` records: the hash of the covered part, or null when it cannot be found. */
export function coveredHash(one) {
  const part = covered(read(one.from), one.until);
  return part === null ? null : sha256(part);
}

// `node apps/site/scripts/translations.mjs` prints each translation's current hash, for updating one (docs/i18n.md).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const one of translations()) console.log(`${one.rel}  ${coveredHash(one) ?? `(no line ${JSON.stringify(one.until)} in ${one.from})`}`);
}
