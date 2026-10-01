import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";
import { BODY_PROBLEMS, messageBodyResponse } from "@mailda/contract/schemas";

import { CATALOGS } from "../src/i18n/catalog.ts";
import { text } from "../src/i18n/format.ts";
import { problemSentence, renderBody, sanitizeHtml } from "../src/render/body.ts";

const mime = (parts: { html?: string; text?: string }) => {
  const boundary = "b1";
  const sections: string[] = [];
  if (parts.text !== undefined) {
    sections.push(`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${parts.text}\r\n`);
  }
  if (parts.html !== undefined) {
    sections.push(`--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${parts.html}\r\n`);
  }
  return new TextEncoder().encode(
    [
      "From: sender@example.net",
      "To: inbox@example.com",
      "Subject: test",
      "Message-ID: <t@example.net>",
      "Date: Wed, 05 Aug 2026 08:00:00 +0000",
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      ...sections,
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
};

describe("sanitizer: links, judged against what they say (mail-security row 3)", () => {
  it("collects each kept anchor's href and its text, including text under nested inline markup", async () => {
    const { links, html } = await sanitizeHtml(
      '<p>Please <a href="https://evil.test/x">visit <b>https://acme.example</b>/login</a> and '
      + '<a href="https://acme.example/help">the help page</a>, or <a href="javascript:alert(1)">this</a>.</p>',
      ["acme.example"],
    );
    expect(links).toEqual([
      { href: "https://evil.test/x", text: "visit https://acme.example/login", verdict: "mismatch" },
      { href: "https://acme.example/help", text: "the help page", verdict: "plain" },
    ]);
    // The refused scheme is not a link and not judged; the destination of the kept ones is untouched.
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://evil.test/x"');
  });

  it("stops collecting past the bound and says nothing false about the rest", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `<a href="https://v${i}.test/">v${i}</a>`).join(" ");
    const { links } = await sanitizeHtml(many);
    expect(links).toHaveLength(200);
    expect(links.every((one) => one.verdict === "plain")).toBe(true);
  });
});

describe("sanitizer: remote content (the primary job, ADR 37)", () => {
  it("withholds an image and says how many", async () => {
    // A pixel tells a third party when an employee opened a message. That is the whole reason this
    // function exists, and the count is shown to the reader rather than hidden.
    const { html, blockedRemote } = await sanitizeHtml(
      '<p>hi</p><img src="https://tracker.example/pixel.gif" width="1" height="1" alt="">',
    );
    expect(blockedRemote).toBe(1);
    expect(html).not.toContain("tracker.example");
    expect(html).toContain('data-mailda-blocked="remote-image"');
    // Layout attributes survive, so a blocked image does not collapse the layout.
    expect(html).toContain('width="1"');
  });

  it("withholds srcset as well as src", async () => {
    const { blockedRemote, html } = await sanitizeHtml(
      '<img srcset="https://tracker.example/a.png 1x, https://tracker.example/b.png 2x" alt="x">',
    );
    expect(blockedRemote).toBe(1);
    expect(html).not.toContain("tracker.example");
  });

  it("drops every other element that can fetch without script", async () => {
    // Enumerated deliberately: each of these causes a network request with scripting disabled.
    const hostile = [
      '<link rel="preload" href="https://tracker.example/x">',
      '<link rel="dns-prefetch" href="//tracker.example">',
      '<meta http-equiv="refresh" content="0;url=https://tracker.example">',
      '<iframe src="https://tracker.example/x"></iframe>',
      '<object data="https://tracker.example/x"></object>',
      '<embed src="https://tracker.example/x">',
      '<video poster="https://tracker.example/x"><source src="https://tracker.example/v"></video>',
      '<audio src="https://tracker.example/a"></audio>',
      '<input type="image" src="https://tracker.example/i">',
      '<svg><image href="https://tracker.example/s"/></svg>',
      '<base href="https://tracker.example/">',
    ].join("");

    const { html } = await sanitizeHtml(`<p>keep me</p>${hostile}`);
    expect(html).toContain("keep me");
    expect(html).not.toContain("tracker.example");
  });

  it("strips body and table background attributes", async () => {
    // Legacy, still honoured by renderers, and not covered by any per-tag allowlist entry.
    const { html } = await sanitizeHtml(
      '<body background="https://tracker.example/bg.png"><table background="https://tracker.example/t.png"><tr><td>x</td></tr></table></body>',
    );
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("x");
  });

  it("strips style, which is the vector that would defeat image blocking", async () => {
    // Documented as deliberate: `background-image: url(...)` fetches remotely, so leaving style in
    // place would make blocking images pointless. #28 left CSS containment as open fog.
    const { html } = await sanitizeHtml(
      '<div style="background-image:url(https://tracker.example/bg.png)">x</div>',
    );
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("style");
  });
});

describe("sanitizer: script and event handlers", () => {
  it("removes script with its content, not just the tag", async () => {
    const { html } = await sanitizeHtml('<p>a</p><script>fetch("https://tracker.example")</script><p>b</p>');
    expect(html).toContain("a");
    expect(html).toContain("b");
    // The content is a payload, so keeping it as text would still leak once reparsed.
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("fetch(");
  });

  it("strips every event handler by allowlist rather than by pattern", async () => {
    // A blocklist is a bet that nobody invents a new handler. The allowlist means an attribute this
    // code has never heard of is dropped by default.
    const { html } = await sanitizeHtml(
      '<div onclick="x()" onmouseover="y()" onfocus="z()" onanimationstart="w()" ontotallynew="v()">t</div>',
    );
    expect(html).toBe("<div>t</div>");
  });

  it("drops javascript: and data: hrefs but keeps http and mailto", async () => {
    const { html } = await sanitizeHtml(
      '<a href="javascript:alert(1)">a</a>' +
        '<a href="data:text/html,<script>x</script>">b</a>' +
        '<a href="vbscript:x">c</a>' +
        '<a href="https://example.net/ok">d</a>' +
        '<a href="mailto:someone@example.net">e</a>',
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("vbscript:");
    expect(html).toContain('href="https://example.net/ok"');
    expect(html).toContain('href="mailto:someone@example.net"');
    // No window handle back to the opener.
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe("sanitizer: structure", () => {
  it("unwraps an unknown element rather than losing the message inside it", async () => {
    // Email is full of layout wrappers. Discarding their content would silently lose text.
    const { html } = await sanitizeHtml("<o:p>important text</o:p><custom-thing>more</custom-thing>");
    expect(html).toContain("important text");
    expect(html).toContain("more");
    expect(html).not.toContain("<o:p");
    expect(html).not.toContain("custom-thing");
  });

  it("removes comments, which some clients still execute", async () => {
    const { html } = await sanitizeHtml("<p>a</p><!--[if IE]><img src=https://tracker.example/x><![endif]--><p>b</p>");
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("<!--");
  });

  it("does not double-encode an entity the sender wrote", async () => {
    // This passed even while the raw form below was broken, which is why it was false confidence
    // rather than evidence. It then caught the *fix* double-encoding `&lt;` into `&amp;lt;`, which
    // would have shown the reader `&lt;img ...` instead of what the sender actually wrote.
    const { html } = await sanitizeHtml("<unknown>&lt;img src=x onerror=y&gt;</unknown>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes a lone < so unwrapping cannot splice it into a real tag", async () => {
    // Found by adversarial review. `<foo><` tokenizes the second `<` as a character token, so lol-html
    // sees an unknown element containing the text "<" then the text "img src=...>". Unwrapping made
    // them adjacent and the browser read a working <img> — the sanitizer's removal was what created
    // the tag. Output escaping means the two tokenizers can no longer disagree.
    const { html, blockedRemote } = await sanitizeHtml(
      "<foo><</foo>img src=https://tracker.example/split.gif>",
    );
    // The URL survives as *visible text*, which is correct and harmless — it is not fetched. What
    // must not survive is a tag, and the escaped `<` is what guarantees that.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(blockedRemote).toBe(0);
  });

  it("drops raw-text elements with their content, because unwrapping them makes inert text live", async () => {
    // The worst of the three: inside xmp/noembed/noframes/plaintext the tokenizer is in RAWTEXT mode,
    // so the payload arrives as one text chunk the element handler never inspects. Unwrapping wrote it
    // out and the browser reparsed it as markup — the payload was inert in the sender's message and
    // *the sanitizer made it dangerous*.
    for (const tag of ["xmp", "noembed", "noframes", "listing"]) {
      const { html } = await sanitizeHtml(
        `<p>hi</p><${tag}><img src="https://tracker.example/x.gif"><link rel="preconnect" href="https://tracker.example"></${tag}>`,
      );
      expect(html, tag).toContain("hi");
      expect(html, tag).not.toContain("tracker.example");
    }
    // plaintext swallows the rest of the document, so it is checked without a closing tag.
    const { html } = await sanitizeHtml('<p>hi</p><plaintext><img src="https://tracker.example/p.gif">');
    expect(html).not.toContain("tracker.example");
  });

  it("survives an absurd attribute count without burning the CPU budget", async () => {
    // Measured by review: 50,000 attributes took 35 seconds, past the Workers CPU limit, so the
    // message became permanently unopenable — and 439 KB of attributes fits inside the body bound.
    // Past 64 the element is dropped in one operation instead of paying the quadratic cost.
    const attrs = Array.from({ length: 20_000 }, (_, i) => `d${i}=v`).join(" ");
    const started = Date.now();
    const { html } = await sanitizeHtml(`<div ${attrs}>t</div>`);
    expect(html).toContain("t");
    expect(html).not.toContain("d0=");
    // Generous, because wall-clock in a test runner is noisy; the point is that it is not seconds.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("survives deep nesting without throwing", async () => {
    const deep = "<div>".repeat(500) + "text" + "</div>".repeat(500);
    const { html } = await sanitizeHtml(deep);
    expect(html).toContain("text");
  });

  it("keeps the content of an over-attributed element rather than losing the message", async () => {
    const attrs = Array.from({ length: 400 }, (_, i) => `data-x${i}="v"`).join(" ");
    const { html } = await sanitizeHtml(`<div ${attrs}>t</div>`);
    // Past the bound the element goes and its text stays — the same trade as an unknown tag.
    expect(html).toBe("t");
  });
});

describe("regressions from adversarial review", () => {
  it("does not delete the message when <head> is unterminated", async () => {
    // Found by review, and the worst of the twelve: `head` was dropped with content, so an
    // unterminated one took the entire body with it — and the result was still reported as rendered
    // HTML. The reader saw an empty panel while the product asserted it had shown them the message.
    const { html } = await sanitizeHtml("<html><head><body><p>the whole message</p>");
    expect(html).toContain("the whole message");
  });

  it("still drops the dangerous things head contains", async () => {
    // Unwrapping the container must not smuggle its contents through.
    const { html } = await sanitizeHtml(
      '<html><head><title>t</title><link rel="preload" href="https://tracker.example/x">' +
        '<style>body{background:url(https://tracker.example/b.png)}</style></head><body><p>kept</p></body></html>',
    );
    expect(html).toContain("kept");
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("<title");
  });

  it("never reports rendered HTML when nothing survived sanitising", async () => {
    // An empty panel that claims to be a rendered body is indistinguishable from a genuinely empty
    // message, and §5C requires a reader be able to tell those apart.
    const rendered = await renderBody(mime({ html: "<script>everything()</script>", text: "the real words" }));
    expect(rendered.state).toBe("text-only");
    expect(rendered.text).toContain("the real words");
    expect(rendered.problem).toContain("survived sanitising");
  });

  it("finds a body that sits past the render bound in the raw message", async () => {
    // The bound used to be applied to raw MIME *before* parsing, so a message whose first part was a
    // large attachment reported `no-body` — asserting the sender wrote nothing when they had written
    // something the reader could not see.
    const filler = "A".repeat(BUDGETS["render.max_body_bytes"] + 50_000);
    const boundary = "b9";
    const raw = new TextEncoder().encode([
      "From: sender@example.net", "To: inbox@example.com", "Subject: big attachment first",
      "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
      `--${boundary}`, "Content-Type: application/octet-stream", "Content-Transfer-Encoding: base64", "",
      filler, "",
      `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", "the actual message", "",
      `--${boundary}--`, "",
    ].join("\r\n"));

    const rendered = await renderBody(raw);
    expect(rendered.state).toBe("text-only");
    expect(rendered.text).toContain("the actual message");
  });

  it("degrades to the plain alternative when the sanitizer itself fails", async () => {
    // Deep nesting makes HTMLRewriter throw "memory limit exceeded". That used to escape renderBody as
    // an opaque 500; now it is a state, and the message stays readable.
    const nested = "<zz>".repeat(20_000) + "x";
    const rendered = await renderBody(mime({ html: nested, text: "readable fallback" }));
    expect(["text-only", "html"]).toContain(rendered.state);
    if (rendered.state === "text-only") expect(rendered.text).toContain("readable fallback");
  });
});

describe("the four body states (§5C)", () => {
  it("reports html, with its blocked count", async () => {
    const rendered = await renderBody(
      mime({ html: '<p>hello</p><img src="https://tracker.example/p.gif">', text: "hello" }),
    );
    expect(rendered.state).toBe("html");
    expect(rendered.blockedRemote).toBe(1);
    expect(rendered.html).not.toContain("tracker.example");
    // The plain alternative is kept alongside, so a reader can choose it.
    expect(rendered.text).toContain("hello");
  });

  it("reports text-only distinctly from html", async () => {
    const rendered = await renderBody(mime({ text: "just words" }));
    expect(rendered.state).toBe("text-only");
    expect(rendered.html).toBeNull();
    expect(rendered.text).toContain("just words");
  });

  it("reports no-body distinctly from a body that was refused", async () => {
    const rendered = await renderBody(
      new TextEncoder().encode("From: a@b.com\r\nSubject: empty\r\n\r\n"),
    );
    // A blank panel standing in for either of these is the first lie a mail client tells.
    expect(rendered.state).toBe("no-body");
    expect(rendered.problem).toBeNull();
  });

  it("never claims html when there is none", async () => {
    const rendered = await renderBody(mime({ text: "x" }));
    expect(rendered.html).toBeNull();
  });

  it("states truncation rather than silently cutting", async () => {
    const huge = "x".repeat(BUDGETS["render.max_body_bytes"] + 1000);
    const rendered = await renderBody(mime({ text: huge }));
    expect(rendered.truncated).toBe(true);
    // The full bytes are never withheld — /raw streams the complete original unbounded.
  });
});

/**
 * The message's own language and script reach the frame (critic M9, Blueprint §5C "preserved original message
 * language"): the sender's `lang` and `dir` survive the sanitiser, and the body route says which glyph forms the
 * message's Han is in, from the rendered part's charset and then `Content-Language`, so a GB2312 message is not
 * drawn in Japanese forms because the reader's system is Japanese.
 */
describe("the message's language and script", () => {
  const raw = (headers: string[], parts: Array<[type: string, charset: string]>) => new TextEncoder().encode([
    "From: sender@example.net", "To: inbox@example.com", "Subject: t", "MIME-Version: 1.0", ...headers,
    'Content-Type: multipart/alternative; boundary="b1"', "",
    ...parts.map(([type, charset]) => `--b1\r\nContent-Type: ${type}; charset=${charset}\r\n\r\n<p>hello</p>\r\n`),
    "--b1--", "",
  ].join("\r\n"));

  it("keeps a sender's lang and dir on every element, the root included, and nothing else new", async () => {
    const { html } = await sanitizeHtml('<html lang="zh-CN" dir="ltr" onload="x()"><p lang="ja" dir="rtl" class="c" title="t">t</p></html>');
    expect(html).toBe('<html lang="zh-CN" dir="ltr"><p lang="ja" dir="rtl">t</p></html>');
  });

  it("names the script a legacy CJK charset names, through any of its labels", async () => {
    const cases: Array<[string, string]> = [
      ["gb2312", "sc"], ["GBK", "sc"], ["gb18030", "sc"], ["x-gbk", "sc"], ["big5", "tc"], ["csbig5", "tc"], ["big5-hkscs", "tc"],
      ["iso-2022-jp", "jp"], ["shift_jis", "jp"], ["x-sjis", "jp"], ["euc-jp", "jp"],
    ];
    for (const [charset, script] of cases) {
      expect((await renderBody(raw([], [["text/html", charset]]))).script, charset).toBe(script);
    }
  });

  it("reads the part it renders: the HTML part's charset over the plain one's, and the plain one's when alone", async () => {
    expect((await renderBody(raw([], [["text/plain", "big5"], ["text/html", "gb2312"]]))).script).toBe("sc");
    expect((await renderBody(raw([], [["text/plain", "big5"]]))).script).toBe("tc");
  });

  it("falls back to Content-Language, and the charset outranks it", async () => {
    const utf8: Array<[string, string]> = [["text/html", "utf-8"]];
    expect((await renderBody(raw(["Content-Language: zh-TW"], utf8))).script).toBe("tc");
    expect((await renderBody(raw(["Content-Language: zh"], utf8))).script).toBe("sc");
    expect((await renderBody(raw(["Content-Language: ja, en"], utf8))).script).toBe("jp");
    expect((await renderBody(raw(["Content-Language: ja"], [["text/html", "gb2312"]]))).script).toBe("sc");
  });

  it("reads the rendered body's charset, never an attachment's", async () => {
    const body = ["Content-Type: text/html", "", "<p>hello</p>"];
    const report = ["Content-Type: text/html; charset=big5", 'Content-Disposition: attachment; filename="report.html"', "", "<p>report</p>"];
    const mixed = (...parts: string[][]) => new TextEncoder().encode([
      "From: sender@example.net", "To: inbox@example.com", "Subject: t", "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"', "",
      ...parts.flatMap((part) => ["--b1", ...part]), "--b1--", "",
    ].join("\r\n"));
    // An attached Big5 report is not the body, before it or after it, so its charset says nothing about the body.
    expect((await renderBody(mixed(body, report))).script).toBeNull();
    expect((await renderBody(mixed(report, body))).script).toBeNull();
  });

  it("takes the HTML's own root lang when the charset and Content-Language are silent, and only then", async () => {
    const html = (headers: string[], charset: string, root: string) => new TextEncoder().encode([
      "From: sender@example.net", "To: inbox@example.com", "Subject: t", "MIME-Version: 1.0", ...headers,
      `Content-Type: text/html; charset=${charset}`, "", `<html ${root}><p>hello</p></html>`, "",
    ].join("\r\n"));
    expect((await renderBody(html([], "utf-8", 'lang="ja"'))).script).toBe("jp");
    expect((await renderBody(html([], "utf-8", 'lang="zh-TW"'))).script).toBe("tc");
    expect((await renderBody(html([], "gb2312", 'lang="ja"'))).script).toBe("sc");
    expect((await renderBody(html(["Content-Language: zh-TW"], "utf-8", 'lang="ja"'))).script).toBe("tc");
    expect((await renderBody(html([], "utf-8", 'lang="en"'))).script).toBeNull();
  });

  it("keeps bdo and bdi, whose only job is the direction a sender states", async () => {
    const { html } = await sanitizeHtml('<p>Hello <bdi>إيان</bdi>: <bdo dir="rtl">abc</bdo></p>');
    expect(html).toBe('<p>Hello <bdi>إيان</bdi>: <bdo dir="rtl">abc</bdo></p>');
  });

  it("sends the script as a string a client narrows, so a newer Node's script or an older Node's silence parses", () => {
    const body = { state: "html", html: "<p>x</p>", text: null, blockedRemote: 0, truncated: false, problem: null,
      attachments: [], links: [], recipients: { to: [], cc: [], replyTo: null } };
    expect(messageBodyResponse.safeParse({ ...body, script: "kr" }).success).toBe(true);
    expect(messageBodyResponse.safeParse(body).success).toBe(true);
    expect(messageBodyResponse.safeParse({ ...body, script: 3 }).success).toBe(false);
  });

  it("says nothing when the message says nothing, or nothing a script follows from", async () => {
    const utf8: Array<[string, string]> = [["text/html", "utf-8"]];
    expect((await renderBody(raw([], utf8))).script).toBeNull();
    expect((await renderBody(raw(["Content-Language: en"], utf8))).script).toBeNull();
    expect((await renderBody(raw(["Content-Language: !!"], utf8))).script).toBeNull();
    expect((await renderBody(raw([], [["text/html", "no-such-charset"]]))).script).toBeNull();
  });
});

/**
 * A body's problem carries its code beside the Node's sentence (ADR 46, layer 3): the interface says the sentence
 * in its viewer's language by the code, and the API keeps the English. In English the two must read the same, so
 * the reader's English is the Node's byte for byte.
 */
describe("a body's problem, by code", () => {
  const en: Readonly<Record<string, unknown>> = CATALOGS.en.app;

  it("says in the interface's English exactly what the Node's sentence says, for every code", () => {
    const differing = BODY_PROBLEMS.filter((code) =>
      text(en[`reader.body.problem.${code}`] as string, { cause: "a parser's line" }, "en", undefined)
        !== problemSentence(code, "a parser's line", false));
    expect(differing).toEqual([]);
  });

  it("names the code and the cause beside the sentence, and none when there is no problem", async () => {
    const empty = await renderBody(mime({ html: "<script>everything()</script>" }));
    expect([empty.state, empty.problemCode, empty.problemCause]).toEqual(["unparsed", "sanitised_empty", null]);
    expect(empty.problem).toBe(en["reader.body.problem.sanitised_empty"]);
    expect(messageBodyResponse.safeParse({ ...empty, recipients: { to: [], cc: [], replyTo: null } }).success).toBe(true);

    const fallback = await renderBody(mime({ html: "<script>everything()</script>", text: "the real words" }));
    expect([fallback.state, fallback.problemCode]).toEqual(["text-only", "sanitised_empty"]);
    expect(fallback.problem).toBe("Nothing in this message's HTML survived sanitising. Its plain-text alternative is shown instead.");

    const plain = await renderBody(mime({ text: "just words" }));
    expect([plain.problem, plain.problemCode, plain.problemCause]).toEqual([null, null, null]);
  });
});
