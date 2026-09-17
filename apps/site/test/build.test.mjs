import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The site is a rendering of the repository: every Markdown file in docs/ and docs/receipts/ must be a page,
 * the landing page must carry the README's status rows, and nothing may be fetched from another origin.
 */
const site = resolve(import.meta.dirname, "..");
const repo = resolve(site, "../..");
const dist = join(site, "dist");

test("every doc and receipt in the repository is a page", () => {
  for (const file of readdirSync(join(repo, "docs")).filter((one) => one.endsWith(".md"))) {
    const slug = file.replace(/\.md$/, "").toLowerCase();
    assert.ok(existsSync(join(dist, "docs", "product", slug, "index.html")) || existsSync(join(dist, "docs", "operating", slug, "index.html")), `${file} has no page`);
  }
  for (const file of readdirSync(join(repo, "docs/receipts")).filter((one) => one.endsWith(".md"))) {
    assert.ok(existsSync(join(dist, "docs", "receipts", file.replace(/\.md$/, "").toLowerCase(), "index.html")), `${file} has no page`);
  }
  assert.ok(existsSync(join(dist, "docs", "receipts", "index.html")));
});

test("the landing page carries the README's own status rows, verbatim titles", () => {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  const start = readme.indexOf("## Status");
  // The first table under "## Status" is the gaps; the one after it says where things live.
  const status = readme.slice(start, readme.indexOf("\n## ", start + 1));
  const table = /^\|[\s\S]*?(?=\n\n)/m.exec(status)?.[0] ?? "";
  const rows = [...table.matchAll(/^\| \*\*([^*]+)\*\* \|/gm)].map((m) => m[1]);
  assert.ok(rows.length >= 3, "the README's status table went missing");
  for (const title of rows) assert.ok(html.includes(title.replace(/&/g, "&amp;")), `landing lacks status row: ${title}`);
});

test("nothing on the site is fetched from another origin", () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((one) => one.isDirectory() ? walk(join(dir, one.name)) : one.name.endsWith(".html") ? [join(dir, one.name)] : []);
  for (const page of walk(dist)) {
    const html = readFileSync(page, "utf8");
    for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:\/\/[^"]+)"/g)) {
      if (m[1].startsWith("https://mailda.site/")) continue; // canonical links to ourselves
      assert.fail(`${page} loads ${m[1]} from another origin`);
    }
  }
});
