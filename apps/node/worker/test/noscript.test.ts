import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { LOCALES } from "../src/i18n/locales.ts";

/**
 * What the shell says when the bundle does not run (#92).
 *
 * ## The defect this closes, found by driving a browser rather than by reading
 *
 * `main.tsx` claimed that sign-in, the first-run claim and a locked-out `doctor` *"stay server-rendered …
 * and must work before any bundle loads"*. The reasoning was sound — those are the screens an operator sees
 * when the Node is broken — and the mechanism was not there. `page()` ships `<main id="app"></main>` and a
 * script tag, so fetching the claim page returned 2.4 KB whose only visible text was the wordmark.
 *
 * The first screen a Node ever shows was therefore, without JavaScript, a blank page: no form, no error, no
 * hint. That is the worst available diagnostic, because it reads as a network problem rather than as a
 * requirement — and an operator claiming a Node has no reason yet to suspect their own browser.
 *
 * This does **not** make those screens work without scripting; that is a larger change and a decision rather
 * than an omission. It checks the honest minimum: the page says what is wrong, and points at the one
 * diagnostic that genuinely needs no scripting.
 *
 * ## Why the request rather than `page()`
 *
 * `ui.ts` imports `app.client.js`, which imports a session module by a specifier the browser resolves at
 * runtime and node cannot. So a node test importing `page()` fails before it asserts anything. Driven through
 * `SELF.fetch` instead, which also makes this a test of what a browser is actually served.
 */
describe("the shell explains itself when scripting is off", () => {
  async function shell(): Promise<string> {
    const response = await SELF.fetch("https://node.example/");
    expect(response.status).toBe(200);
    return await response.text();
  }

  it("carries a noscript, so a blank page cannot be the whole answer", async () => {
    const html = await shell();
    expect(html).toContain("<noscript>");
    expect(html).toContain("needs JavaScript");
  });

  it("points at the text diagnostic, which really does work without scripting", async () => {
    /*
     * `?format=text` renders `formatReport` on the server, so it is the one thing an operator with scripting
     * disabled can still read — and the one they need when the Node is what is broken.
     */
    expect(await shell()).toContain("/api/doctor?format=text");
  });

  it("says the screens are not server-rendered rather than implying they are", async () => {
    // The claim that was false is the one worth pinning: a reader told "nothing here is rendered on the
    // server" stops looking for a no-JS path that does not exist.
    expect(await shell()).toContain("rendered on the server");
  });

  it("leaves the wordmark as the only other visible text, which is why the notice is needed", async () => {
    /*
     * The measurement that produced this file, kept as an assertion so the claim stays true: strip the
     * scripts, the SVG and the tags, and what a browser without JavaScript can show is the wordmark and the
     * notice. If server-rendering ever arrives, this fails and should be rewritten rather than deleted.
     */
    const html = await shell();
    const body = html.slice(html.indexOf("<body>"), html.indexOf("</body>"));
    const withoutNotice = body.slice(0, body.indexOf("<noscript>"));
    const visible = withoutNotice
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<svg[\s\S]*?<\/svg>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    expect(visible).toBe("Mailda");
  });
});

/**
 * The notice in every language (ADR 46, layer 3). Without scripting nothing can choose a language for the reader,
 * so the page carries each locale's block, marked with its `lang`, and the reader finds their own.
 */
describe("the notice is in every language, each block marked", () => {
  const blocks = async (): Promise<Map<string, string>> => {
    const html = (await SELF.fetch("https://node.example/").then((response) => response.text()));
    const notice = html.slice(html.indexOf("<noscript>"), html.indexOf("</noscript>"));
    return new Map([...notice.matchAll(/<div class="rack" lang="([^"]+)">([\s\S]*?)<\/div><\/div>/g)].map((match) => [match[1]!, match[2]!]));
  };
  /** Each paragraph's words, its markup removed and its line breaks folded, as a browser lays it out. */
  const text = (block: string): string[] => [...block.matchAll(/<p>([\s\S]*?)<\/p>/g)]
    .map((match) => match[1]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());

  it("has one block per locale, English first", async () => {
    expect([...(await blocks()).keys()]).toEqual(LOCALES.map(({ tag }) => tag));
  });

  it("says in English what it said before the catalog held it, word for word", async () => {
    // The notice as `page()` wrote it on 2 October 2026, before its words moved into `preauth.noscript.*`.
    expect(text((await blocks()).get("en")!)).toEqual([
      "This page needs JavaScript.",
      "Claiming a Node, signing in and reading the diagnostic all run in the browser. Nothing here is rendered on the "
        + "server, so with scripting disabled this page can show you only this notice.",
      "The diagnostic is available as plain text and needs no scripting: /api/doctor?format=text.",
    ]);
  });

  it("says it in Chinese in the Chinese block, the link inside its sentence", async () => {
    const zh = (await blocks()).get("zh-Hans")!;
    expect(text(zh)).toEqual([
      "此页面需要 JavaScript。",
      "认领节点、登录和查看诊断都在浏览器中运行。这里没有任何内容在服务器上渲染，所以禁用脚本后，此页面只能显示这条提示。",
      "诊断报告有纯文本版本，无需脚本：/api/doctor?format=text。",
    ]);
    expect(zh).toContain('<a href="/api/doctor?format=text">/api/doctor?format=text</a>。');
  });
});
