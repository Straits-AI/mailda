import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { NEVER } from "../../node/worker/src/i18n/glossary.ts";

/**
 * The site is a rendering of the repository: every Markdown file in docs/ and docs/receipts/ must be a page,
 * in English and under /zh-cn/, the landing pages must carry the README's status rows, and nothing may be fetched
 * from another origin. The Simplified Chinese landing page is held to the glossary's NEVER list, and the English
 * one to a golden of its markup.
 */
const site = resolve(import.meta.dirname, "..");
const repo = resolve(site, "../..");
const dist = join(site, "dist");

const page = (path) => readFileSync(join(dist, path), "utf8");

test("every doc and receipt in the repository is a page, in English and under /zh-cn/", () => {
  for (const root of [dist, join(dist, "zh-cn")]) {
    for (const file of readdirSync(join(repo, "docs")).filter((one) => one.endsWith(".md"))) {
      const slug = file.replace(/\.md$/, "").toLowerCase();
      assert.ok(existsSync(join(root, "docs", "product", slug, "index.html")) || existsSync(join(root, "docs", "operating", slug, "index.html")), `${file} has no page in ${root}`);
    }
    for (const file of readdirSync(join(repo, "docs/receipts")).filter((one) => one.endsWith(".md"))) {
      assert.ok(existsSync(join(root, "docs", "receipts", file.replace(/\.md$/, "").toLowerCase(), "index.html")), `${file} has no page in ${root}`);
    }
    assert.ok(existsSync(join(root, "docs", "receipts", "index.html")));
  }
});

test("both landing pages carry the README's own status rows, verbatim titles", () => {
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  const start = readme.indexOf("## Status");
  // The first table under "## Status" is the gaps; the one after it says where things live.
  const status = readme.slice(start, readme.indexOf("\n## ", start + 1));
  const table = /^\|[\s\S]*?(?=\n\n)/m.exec(status)?.[0] ?? "";
  const rows = [...table.matchAll(/^\| \*\*([^*]+)\*\* \|/gm)].map((m) => m[1]);
  assert.ok(rows.length >= 3, "the README's status table went missing");
  for (const path of ["index.html", "zh-cn/index.html"]) {
    const html = page(path);
    for (const title of rows) assert.ok(html.includes(title.replace(/&/g, "&amp;")), `${path} lacks status row: ${title}`);
  }
});

/** The README's rows as the zh page draws them: each a `<li lang="en">`, English under a Chinese heading. */
const englishRows = /<li class="finding[^"]*" lang="en">[\s\S]*?<\/li>/g;

test("/zh-cn/ is Simplified Chinese, under the mark 淼达, with the README's rows marked as English", () => {
  const html = page("zh-cn/index.html");
  assert.match(html, /<html lang="zh-Hans"/);
  assert.match(html, /<span class="word[^"]*">淼达<\/span><span class="word-secondary[^"]*" lang="en">Mailda<\/span>/);
  assert.match(html, /<title>淼达，/);
  const rows = html.match(englishRows) ?? [];
  assert.ok(rows.length >= 3 && rows.every((row) => row.includes('class="sev warn')), "the README's rows are not marked lang=en");
  assert.match(html, /<li class="gaps-head[^"]*"><h3[^>]*>.*?README[^<]*保留英文/, "no Chinese heading says the rows are kept in English");
  // The Register: an identifier beside Han is in <code>, never bare.
  for (const token of ["llm.*", "org.admin", "warn", "git"]) assert.match(html, new RegExp(`<code[^>]*>${token.replace(/[.*]/g, "\\$&")}</code>`), `${token} is bare`);
  // The English page marks nothing: its rows are in its own language.
  assert.doesNotMatch(page("index.html"), /<li[^>]* lang="en"/);
});

test("the Chinese words on /zh-cn/ use none of the glossary's NEVER phrases", () => {
  // Imported from the glossary, not copied: a phrase the owner adds there is held here too. The README's rows are
  // English and quoted, so they are left out; what remains is this site's own Chinese.
  const ours = page("zh-cn/index.html").replace(englishRows, "");
  const phrases = NEVER["zh-Hans"].map((one) => one.phrase);
  assert.ok(phrases.includes("送达") && phrases.length >= 5, "the glossary's NEVER list did not load");
  for (const phrase of phrases) assert.ok(!ours.includes(phrase), `/zh-cn/ says ${phrase}`);
  // AGENTS.md §4: a forwarded copy is never a sync. Not a NEVER row, since the Node has no word that could be one.
  assert.ok(!ours.includes("同步"), "/zh-cn/ says 同步");
});

/**
 * The English landing page's markup, held to a golden so the per-locale table (src/landing-words.ts) cannot change
 * an English word or link unnoticed. What is not the page's own is cut first: the README's warn rows (they change
 * with the README), the mark's SVG, Astro's scope classes and the bundled scripts. `UPDATE_GOLDEN=1 node --test`
 * rewrites it, for a change that means to.
 */
test("the English landing page is unchanged (golden)", () => {
  const body = page("index.html")
    .replace(/<li class="finding[^"]*">\s*<span class="sev warn[\s\S]*?<\/li>/g, "<li>(a README row)</li>")
    .replace(/(<li>\(a README row\)<\/li>)+/g, "<li>(the README's rows)</li>")
    .replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>")
    .replace(/<style>[\s\S]*?<\/style>/g, "<style/>")
    .replace(/<script type="module">[\s\S]*?<\/script>/g, "<script/>")
    .replace(/ ?\bastro-[a-z0-9]{8}\b/g, "")
    .replace(/ class=""/g, "")
    .replace(/\/_astro\/[\w.-]+/g, "/_astro/(asset)")
    .replace(/> </g, ">\n<");
  const golden = join(site, "test", "golden", "landing.en.html");
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(join(site, "test", "golden"), { recursive: true });
    writeFileSync(golden, body);
  }
  assert.equal(body, readFileSync(golden, "utf8"));
});

test("every link on both landing pages resolves to a page this build wrote, the switch included", () => {
  for (const path of ["index.html", "zh-cn/index.html"]) {
    const html = page(path);
    const hrefs = [...html.matchAll(/(?:href|src)="(\/[^"#]*)/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 15, `${path}: too few links found`);
    for (const href of hrefs) {
      const file = href.endsWith("/") ? join(dist, href, "index.html") : join(dist, href);
      assert.ok(existsSync(file), `${path} links ${href}, which is not in dist`);
    }
    // The switch: both languages, by their own names, each its own page, the current one marked.
    assert.match(html, /<a href="\/" hreflang="en" lang="en" data-locale="en"[^>]*>English<\/a>/);
    assert.match(html, /<a href="\/zh-cn\/" hreflang="zh-Hans" lang="zh-Hans" data-locale="zh-Hans"[^>]*>简体中文<\/a>/);
    assert.match(html, path === "index.html" ? /data-locale="en" aria-current="page"/ : /data-locale="zh-Hans" aria-current="page"/);
  }
});

test("hreflang alternates name both languages on the landing pages and on the docs", () => {
  for (const path of ["index.html", "zh-cn/index.html"]) {
    const html = page(path);
    assert.match(html, /<link rel="alternate" hreflang="en" href="https:\/\/mailda\.site\/">/, path);
    assert.match(html, /<link rel="alternate" hreflang="zh-Hans" href="https:\/\/mailda\.site\/zh-cn\/">/, path);
    assert.match(html, /<link rel="alternate" hreflang="x-default" href="https:\/\/mailda\.site\/">/, path);
  }
  assert.match(page("docs/readme/index.html"), /hreflang="zh-Hans" href="https:\/\/mailda\.site\/zh-cn\/docs\/readme\/"/);
});

test("/zh-cn/docs/* is the English page under Chinese menus and Starlight's not-yet-translated notice", () => {
  const html = page("zh-cn/docs/readme/index.html");
  assert.match(html, /<html lang="zh-Hans"/);
  assert.match(html, /<main[^>]* lang="en"/, "the English body is not marked as English");
  assert.ok(html.includes("此内容尚不支持你的语言。"), "no notice that the page is English");
  assert.ok(html.includes("搜索") && html.includes("跳转到内容"), "Starlight's own zh words are missing");
  for (const label of ["从这里开始", "产品", "运维节点", "测量记录"]) assert.ok(html.includes(label), `sidebar lacks ${label}`);
});

/** The first-visit redirect on `/`, run as the browser would, with everything it reads handed in. */
function firstVisit({ languages, stored = null, storage = "ok", referrer = "", webdriver = false, userAgent = "Mozilla/5.0" }) {
  const script = /<script data-first-visit>([\s\S]*?)<\/script>/.exec(page("index.html"))?.[1];
  assert.ok(script, "/ has no first-visit script");
  let went = null;
  const localStorage = { getItem: (key) => { if (storage === "refused") throw new Error("SecurityError"); return key === "mailda.locale" ? stored : null; } };
  vm.runInNewContext(script, {
    navigator: { languages, language: languages[0], webdriver, userAgent }, localStorage, document: { referrer }, URL,
    location: { origin: "https://mailda.site", replace: (to) => { went = to; } },
  });
  return went;
}

test("a first visit asking for Simplified Chinese goes to /zh-cn/, and nothing else does", () => {
  for (const tag of ["zh", "zh-CN", "zh-SG", "zh-MY", "zh-Hans"]) assert.equal(firstVisit({ languages: [tag] }), "/zh-cn/", tag);
  for (const tag of ["zh-TW", "zh-HK", "zh-MO"]) assert.equal(firstVisit({ languages: [tag] }), null, tag);
  assert.equal(firstVisit({ languages: ["zh-TW", "zh-CN"] }), "/zh-cn/", "a Traditional tag is skipped, as the Node negotiates");
  assert.equal(firstVisit({ languages: ["en-GB", "zh-CN"] }), null, "English asked first");
  assert.equal(firstVisit({ languages: ["fr", "zh-CN"] }), "/zh-cn/", "a language the site has not is skipped");
  assert.equal(firstVisit({ languages: ["zh-CN"], stored: "en" }), null, "the visitor chose English");
  assert.equal(firstVisit({ languages: ["zh-CN"], storage: "refused" }), "/zh-cn/", "refused storage still decides");
  assert.equal(firstVisit({ languages: ["zh-CN"], storage: "refused", referrer: "https://mailda.site/zh-cn/" }), null, "the switch back works without storage");
  assert.equal(firstVisit({ languages: ["zh-CN"], referrer: "https://example.com/" }), "/zh-cn/", "a visit from elsewhere is a first visit");
  assert.equal(firstVisit({ languages: ["zh-CN"], webdriver: true }), null, "automation");
  assert.equal(firstVisit({ languages: ["zh-CN"], userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" }), null, "a crawler");
  assert.equal(firstVisit({ languages: ["not a tag!", "zh-CN"] }), "/zh-cn/", "a malformed tag is skipped");
  // /zh-cn/ redirects nowhere, so the two pages cannot send a reader back and forth.
  assert.doesNotMatch(page("zh-cn/index.html"), /data-first-visit|location\.replace/);
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
