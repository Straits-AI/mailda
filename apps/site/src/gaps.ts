import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The README's status table — what is thin, in the product's own words — read at build time. The first
 * table after "## Status" and only that one; each row cut at the second sentence boundary (a full stop
 * followed by a space and a capital, so a filename's dot does not end a sentence), the README link carrying the rest.
 */
export function readGaps(repo: string): { title: string; detail: string }[] {
  const readme = readFileSync(resolve(repo, "README.md"), "utf8");
  const start = readme.indexOf("## Status");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
  const lines = section.split("\n");
  const first = lines.findIndex((line) => /^\| \*\*/.test(line));
  const rows: string[] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith("|")) break;
    if (/^\| \*\*/.test(line)) rows.push(line);
  }
  return rows.flatMap((line) => {
    const m = /^\| \*\*([^*]+)\*\* \| (.+?) \|$/.exec(line);
    if (m === null) return [];
    const plain = m[2]!.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\*\*/g, "");
    const cut = /^(.*?[.!?])\s+[A-Z(].*?[.!?](?=\s+[A-Z(]|$)/.exec(plain);
    const detail = (cut?.[0] ?? plain).trim();
    return [{ title: m[1]!, detail: detail.length > 320 ? `${detail.slice(0, 300).replace(/\s\S*$/, "")}…` : detail }];
  });
}
