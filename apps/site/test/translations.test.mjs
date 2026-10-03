import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { NEVER } from "../../node/worker/src/i18n/glossary.ts";
import { covered, read, repo, sha256, translations } from "../scripts/translations.mjs";

/**
 * A translation in `docs/zh-cn/` may not fall behind its English silently (docs/i18n.md, *Doc translations*). Each
 * records the SHA-256 of the English it was made from, and a change to that English fails here until somebody updates
 * the translation or removes it. Each keeps its source's structure: the same code blocks byte for byte, the same
 * links, tables, headings and inline code, so a dropped command or link cannot hide in a language a reviewer may not
 * read. And each is held to the glossary's NEVER list and the register docs/i18n.md sets for zh-Hans.
 *
 * Reads the repository, not the build, so it runs without one.
 */
const all = translations();

test("the translations are found, so nothing below passes over an empty set", () => {
  assert.ok(all.length >= 3, `found ${all.length} translations in docs/zh-cn/`);
});

test("each translation's English is still the English it was translated from", () => {
  for (const one of all) {
    assert.ok(existsSync(join(repo, one.from)), `${one.rel} translates ${one.from}, which is gone: remove the translation`);
    assert.equal(
      sha256(read(one.from)),
      one.sha256,
      `${one.from} has changed since ${one.rel} was translated from it. Update the translation to match `
        + `\`git diff ${one.commit} -- ${one.from}\`, then record the English's new \`sha256sum\` as source_sha256 and `
        + `the commit as source_commit; or remove the translation.`,
    );
  }
});

/** A Markdown file's fenced blocks, whole, and the rest of its lines, which are prose. */
function split(md) {
  const fences = [];
  const prose = [];
  let open = null;
  for (const line of md.split("\n")) {
    if (/^\s*(>\s?)*(```|~~~)/.test(line)) { // a fence inside a blockquote is a fence too
      if (open === null) open = [line];
      else { open.push(line); fences.push(open.join("\n")); open = null; }
      continue;
    }
    if (open !== null) open.push(line);
    else prose.push(line.replace(/^>\s?/, "")); // a blockquote's marker, so a code span wrapping inside one compares whole
  }
  return { fences, prose };
}

/** A code span: one line, or several of one paragraph. */
const SPAN = /`((?:[^`\n]|\n(?!\n))+)`/g;

/** What a Markdown file is made of, besides its words. Links are resolved to repository paths from the file's own directory. */
function structure(md, rel) {
  const { fences, prose } = split(md);
  const text = prose.join("\n");
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => {
    const [path, hash = ""] = m[1].split("#");
    if (/^[a-z]+:/.test(m[1]) || path === "") return m[1];
    return `${relative(repo, normalize(join(repo, dirname(rel), path)))}${hash === "" ? "" : `#${hash}`}`;
  }).sort();
  return {
    fences,
    links,
    headings: prose.filter((line) => /^#{1,6}\s/.test(line)).map((line) => /^#+/.exec(line)[0]),
    tableRows: prose.filter((line) => line.startsWith("|")).length,
    // A span may wrap a line (never a paragraph) in the English and not in the translation, so its whitespace is folded.
    code: [...text.matchAll(SPAN)].map((m) => m[1].replace(/\s+/g, " ")).sort(),
  };
}

test("each translation keeps its source's code blocks, links, tables, headings and inline code", () => {
  for (const one of all) {
    const english = structure(covered(read(one.from).replace(/^---\n[\s\S]*?\n---\n/, ""), one.until), one.from);
    const chinese = structure(one.body, one.rel);
    assert.ok(english.links.length > 0 && english.code.length > 0, `${one.from}: found no links or inline code, so this compares nothing`);
    for (const key of Object.keys(english)) {
      assert.deepEqual(chinese[key], english[key], `${one.rel}: its ${key} differ from ${one.from}'s`);
    }
  }
});

test("each link in a translation resolves to a file in the repository", () => {
  for (const one of all) {
    for (const link of structure(one.body, one.rel).links.filter((one) => !/^[a-z]+:/.test(one))) {
      assert.ok(existsSync(join(repo, link.split("#")[0])), `${one.rel} links ${link}, which is not there`);
    }
  }
});

test("no translation uses a phrase in the glossary's NEVER list, or 同步", () => {
  const phrases = NEVER["zh-Hans"].map((one) => one.phrase);
  assert.ok(phrases.includes("送达") && phrases.length >= 5, "the glossary's NEVER list did not load");
  for (const one of all) {
    for (const phrase of [...phrases, "同步"]) assert.ok(!one.body.includes(phrase), `${one.rel} says ${phrase}`);
  }
});

/**
 * The register (docs/i18n.md, *Register (zh-Hans)*): one space between Han and Latin or a digit, a code span counted as
 * Latin, and full-width punctuation after Han. Code blocks, code spans' contents and link targets are not prose.
 */
export function registerFaults(md) {
  const prose = split(md).prose.join("\n").replace(SPAN, "x").replace(/\]\([^)\s]+\)/g, "]").replace(/\*/g, "");
  const faults = [];
  for (const line of prose.split("\n")) {
    // Lookaheads, so one character can be the second of one fault and the first of the next (节x与 is two).
    for (const m of line.matchAll(/\p{Script=Han}(?=[A-Za-z0-9,.;:?!()])|[A-Za-z0-9()](?=\p{Script=Han})/gu)) {
      faults.push(line.slice(Math.max(0, m.index - 8), m.index + 10)); // the text around it, to search for
    }
  }
  return faults;
}

test("each translation keeps the zh-Hans register: spaced Latin, full-width punctuation", () => {
  assert.deepEqual(registerFaults("节点 `x` 与 Worker，2026 年。"), [], "the check refuses correct text");
  assert.equal(registerFaults("节点`x`与Worker,2026年(注)").length, 7, "the check passes faulty text");
  for (const one of all) assert.deepEqual(registerFaults(one.body), [], `${one.rel} breaks the register`);
});
