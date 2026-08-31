import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
