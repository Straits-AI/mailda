/**
 * The README's status table — what is thin, in the product's own words — read at build time. The first
 * table after "## Status" and only that one; each row cut at the second sentence boundary (a full stop
 * followed by a space and a capital, so a filename's dot does not end a sentence), the README link carrying the rest.
 *
 * The pages hand in the README's text as a `?raw` import, which Vite resolves from the page's source. A path
 * built from `import.meta.dirname` resolves from the bundled chunk the build runs instead, and found the README
 * only because `dist/pages/` happens to sit four levels below the repository (found 3 October 2026, when a page
 * one directory deeper read `/home/README.md`).
 */
export function readGaps(readme: string): { title: string; detail: string }[] {
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
