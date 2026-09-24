#!/usr/bin/env node
/**
 * Renders the repository's Markdown into Starlight's content collection.
 *
 * The site never holds a second copy of a claim: every page under /docs is one of these files, read at
 * build time, given the frontmatter Starlight wants (a title from the first H1, a description from the
 * first paragraph) and otherwise unchanged. A receipt's own YAML frontmatter — id, kind, measured_on,
 * stale_when, values — is kept and rendered as a table at the top of its page, because the frontmatter *is*
 * the receipt. Relative links between docs are rewritten to their site paths.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const out = resolve(here, "../src/content/docs/docs");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "product"), { recursive: true });
mkdirSync(join(out, "operating"), { recursive: true });
mkdirSync(join(out, "receipts"), { recursive: true });

/** Which section a doc belongs to. Operating a Node is what an operator reads; the product is what it is. */
const OPERATING = new Set([
  "cloudflare-settings.md", "cloudflare-grant.md", "disaster-recovery.md", "onboarding-journey.md",
  "send-transport.md", "send-breakers.md", "machine-surfaces.md", "api-contract.md",
]);

function titleOf(md, fallback) {
  const h1 = /^#\s+(.+)$/m.exec(md);
  return (h1?.[1] ?? fallback).replace(/[`*_]/g, "").trim();
}
function descriptionOf(md) {
  const body = md.replace(/^---[\s\S]*?---\s*/, "").replace(/^#.*$/m, "");
  const para = body.split(/\n\s*\n/).map((one) => one.trim()).find((one) => one !== "" && !one.startsWith("#") && !one.startsWith("|") && !one.startsWith("```"));
  return (para ?? "").replace(/\s+/g, " ").replace(/[`*_[\]]/g, "").slice(0, 160);
}
function yamlEscape(value) { return JSON.stringify(String(value)); }

/** Rewrites relative Markdown links — dot-slash, parent, and repository-rooted forms alike — to the site's own paths. */
function rewriteLinks(md, fromDir) {
  return md.replace(/\]\(([^)\s]+\.md)(#[^)]*)?\)/g, (whole, target, hash) => {
    if (/^https?:/.test(target)) return whole;
    const abs = resolve(fromDir, target);
    const rel = abs.startsWith(repo) ? abs.slice(repo.length + 1) : null;
    if (rel === null) return whole;
    const slug = slugFor(rel);
    return slug === null ? whole : `](/docs/${slug}/${hash ?? ""})`;
  });
}
function slugFor(rel) {
  const name = basename(rel, ".md").toLowerCase();
  if (rel === "README.md") return "readme";
  if (rel === "AGENTS.md") return "agents";
  if (rel.startsWith("docs/receipts/")) return `receipts/${name}`;
  if (rel.startsWith("docs/")) return `${OPERATING.has(basename(rel)) ? "operating" : "product"}/${name}`;
  return null;
}

function emit(rel, dest) {
  const src = join(repo, rel);
  let md = readFileSync(src, "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  let receipt = "";
  if (fm !== null) {
    // A receipt's frontmatter, rendered as a table rather than swallowed as page metadata.
    md = md.slice(fm[0].length);
    const rows = fm[1].split("\n").filter((line) => /^\S/.test(line)).map((line) => line.split(":")[0]);
    receipt = "\n:::note[This is a receipt]\nThe frontmatter below is the record: `" + rows.join("`, `") + "`. The file in the repository is the authority. This page renders it.\n:::\n\n```yaml\n" + fm[1] + "\n```\n\n";
  }
  const idLine = fm === null ? null : /^id:\s*(.+)$/m.exec(fm[1]);
  const title = titleOf(md, idLine?.[1]?.trim() ?? basename(rel, ".md"));
  const body = rewriteLinks(md.replace(/^#\s+.+\n/m, ""), dirname(src));
  writeFileSync(dest, `---\ntitle: ${yamlEscape(title)}\ndescription: ${yamlEscape(descriptionOf(md))}\neditUrl: ${yamlEscape(`https://github.com/Straits-AI/mailda/blob/main/${rel}`)}\n---\n${receipt}${body}`);
}

emit("README.md", join(out, "readme.md"));
emit("AGENTS.md", join(out, "agents.md"));
let n = 2;
for (const file of readdirSync(join(repo, "docs")).filter((one) => one.endsWith(".md"))) {
  emit(`docs/${file}`, join(out, OPERATING.has(file) ? "operating" : "product", file)); n += 1;
}
for (const file of readdirSync(join(repo, "docs/receipts")).filter((one) => one.endsWith(".md"))) {
  emit(`docs/receipts/${file}`, join(out, "receipts", file)); n += 1;
}
if (existsSync(join(repo, "docs/agents"))) { /* the agents/ subfolder is prompts, not docs */ }
// The receipts' own index: what a receipt is, and every one of them with its kind and when it was measured.
const receipts = readdirSync(join(repo, "docs/receipts")).filter((one) => one.endsWith(".md")).map((file) => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(repo, "docs/receipts", file), "utf8"))?.[1] ?? "";
  const pick = (key) => (new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm)?.[1] ?? "").trim();
  return { slug: basename(file, ".md").toLowerCase(), id: pick("id") || basename(file, ".md"), kind: pick("kind"), on: pick("re_measured_on") || pick("measured_on") };
}).sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(join(out, "receipts", "index.md"), `---
title: "Receipts"
description: "Every number the product carries, with how it was measured and when it goes stale."
---
Every limit, cost, timing and platform fact in the product comes from one of these files. A generator
writes \`packages/budgets\` from their \`values:\` blocks, nobody edits it by hand, and a test refuses a
constant without a receipt. Each receipt's \`stale_when\` names what would make it wrong. A **measured**
receipt means somebody ran it. **Sized** means somebody reasoned and said so. **Platform-limit** means
Cloudflare published it.

| receipt | kind | measured |
|:--|:--|:--|
${receipts.map((one) => `| [${one.id}](/docs/receipts/${one.slug}/) | ${one.kind} | ${one.on} |`).join("\n")}
`);

// The installer, served at /install.sh so `curl -fsSL https://mailda.site/install.sh | bash` is the repo's
// own file. Copied at build, never committed here: the root is the one place it is written.
mkdirSync(resolve(here, "../public"), { recursive: true });
writeFileSync(resolve(here, "../public/install.sh"), readFileSync(join(repo, "install.sh"), "utf8"));
// And the updater beside it, for the same reason: the command in the README has to be the script in the repo.
writeFileSync(resolve(here, "../public/update.sh"), readFileSync(join(repo, "update.sh"), "utf8"));
console.log(`rendered ${n + 1} pages into src/content/docs/docs, and install.sh and update.sh into public/`);
