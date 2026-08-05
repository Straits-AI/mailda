import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

import { renderBody, sanitizeHtml } from "../src/render/body.ts";

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
