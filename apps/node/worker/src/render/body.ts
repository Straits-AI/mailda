import { BUDGETS } from "@mailda/budgets";

/**
 * Extracting a message body, and rendering it without trusting it (ADR 37, ADR 38).
 *
 * ## The parser is wrapped so it cannot leak headers
 *
 * ADR 38 adopted `postal-mime` for **body extraction only**, and keeps `mime.ts` as the single source of
 * header truth. That is enforced by this module's shape rather than by a rule: `extractBody` returns a
 * body and nothing else, so there is no way for a caller to reach the parser's own header view and start
 * a second, disagreeing one. Two parsers for one format is drift; two parsers with **one exit each** is
 * a boundary.
 *
 * ## Sanitising is not the trust boundary
 *
 * The trust boundary is the sandboxed iframe the client renders this into — no `allow-scripts`, no
 * `allow-same-origin`, so nothing here executes whatever this function misses. That matters, because a
 * sanitiser's correctness depends on agreeing with every browser's parser about ambiguous input, and
 * that is a class of bug with a decades-long history. ADR 37 uses both for precisely this reason, and
 * the reason they are not belt-and-braces is that they stop different things: the sandbox stops script,
 * this stops **remote content** and reduces what the browser's parser is handed.
 *
 * ## Allowlist, never blocklist
 *
 * Tags and attributes are both allowlisted. A blocklist is wrong by construction: it is a bet that
 * nobody will invent a new dangerous attribute, and that bet has lost repeatedly. Anything unrecognised
 * is dropped — content preserved where the element was merely decorative, discarded where the element's
 * content is itself a payload.
 */

const MAX_BODY_BYTES = BUDGETS["render.max_body_bytes"];
const MAX_ATTRIBUTES = BUDGETS["render.max_attributes_per_element"];

/**
 * Elements whose children are **not parsed as markup** by the tokenizer.
 *
 * This set is separate from the one below because getting it wrong has a specific and nasty
 * consequence, found by adversarial review after this file had already shipped. lol-html — like every
 * HTML tokenizer — switches text mode by tag name: `xmp`, `noembed`, `noframes` and `listing` become
 * RAWTEXT, `plaintext` swallows the rest of the document. Everything inside arrives as a **single
 * verbatim text chunk**, so the per-element handler never sees the `<img>` or `<meta>` in there.
 *
 * The original code had none of these in either set, so they fell through to `removeAndKeepContent()`:
 * the wrapper was deleted and its raw text written out unescaped, and **the browser then reparsed that
 * text as live markup**. The payload was inert in the message the sender wrote — browsers treat these
 * contents as raw text too — and *the sanitiser was what made it dangerous*. Measured leak:
 * `<xmp><img src="https://tracker.example/x.gif"></xmp>` came out as a working tracking pixel with
 * `blockedRemote` still reporting 0, so the panel affirmatively told the reader nothing was withheld.
 *
 * Named as its own concept rather than merged into the list below, because the invariant is
 * "`removeAndKeepContent` must never be reachable for an element whose children are not parsed in Data
 * mode" — and an invariant with a name is one a future author can check.
 */
const RAW_TEXT = new Set(["xmp", "noembed", "noframes", "plaintext", "listing"]);

/** Elements whose *content* is a payload, not text. Removed with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  ...RAW_TEXT,
  "script", "style", "iframe", "object", "embed", "applet", "template", "noscript",
  "svg", "math", "form", "input", "button", "select", "textarea", "option",
  "link", "meta", "base", "title", "frame", "frameset", "audio", "video", "source", "track",
]);

/**
 * `head` is deliberately **not** in the set above, and removing it from there fixed a total message
 * loss.
 *
 * `<html><head><body><p>the whole message</p>` has no `</head>`, so `element.remove()` on an
 * unterminated `head` took everything after it — the entire body — and the result was still reported
 * as `state: "html"`. A reader saw an empty panel for a message that had content, with the product
 * asserting it had rendered it. That is the §5C lie in its purest form.
 *
 * `head` is structural, not a payload: the dangerous things it contains (`title`, `meta`, `link`,
 * `base`, `style`, `script`) are each dropped on their own, so unwrapping the container loses nothing
 * and takes nothing with it.
 */

/**
 * Elements kept, with their attributes allowlisted below. Everything else is **unwrapped** — its text
 * survives, the element does not — because an unknown tag in email is usually a layout wrapper and
 * discarding its content would silently lose the message.
 */
const KEEP = new Set([
  "html", "body", "div", "span", "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "strike", "small", "sub", "sup", "code", "pre", "kbd", "samp",
  "blockquote", "q", "cite", "abbr",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "a", "img", "figure", "figcaption",
]);

/**
 * Attributes kept per element.
 *
 * `style` is **absent deliberately**, and it is the most consequential omission here. Inline CSS can
 * fetch a remote resource (`background-image: url(...)`), which defeats the whole point of blocking
 * images, and it can break out of the iframe's layout. #28 recorded CSS containment as open fog needing
 * its own measurement of what real mail relies on; until that exists, stripping it is the answer that
 * cannot leak. The cost is real: most business mail will render plainly.
 */
const ALLOWED_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["alt", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "type"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
  abbr: new Set(["title"]),
};

/** Schemes a link may use. Everything else — `javascript:`, `data:`, `vbscript:` — is dropped. */
const SAFE_SCHEMES = /^(https?:|mailto:)/i;

export interface ExtractedBody {
  html: string | null;
  text: string | null;
  /** True when the source exceeded the render bound. Stated, never silently cut (§5C). */
  truncated: boolean;
}

/**
 * The body, and only the body.
 *
 * Returns no headers, deliberately — see the module note. `postal-mime`'s own header view is discarded
 * before it can be reached.
 */
export async function extractBody(raw: Uint8Array): Promise<ExtractedBody> {
  // The **whole** message is parsed, and the bound is applied to the extracted body afterwards.
  //
  // The first version truncated the raw MIME before parsing, which cut off any part that began past
  // the bound: a message whose first part was a 1.1 MB attachment and whose second part was the actual
  // text rendered as `state: "no-body"` — asserting the sender wrote nothing, when they had written a
  // message the reader could not see. The bound belongs where the cost is (a body held in memory and
  // handed to a client), not where it silently changes what the message *is*.
  const { default: PostalMime } = await import("postal-mime");
  const parsed = await PostalMime.parse(raw);

  const rawHtml = typeof parsed.html === "string" && parsed.html.length > 0 ? parsed.html : null;
  const rawText = typeof parsed.text === "string" && parsed.text.length > 0 ? parsed.text : null;
  const overBound = (rawHtml?.length ?? 0) > MAX_BODY_BYTES || (rawText?.length ?? 0) > MAX_BODY_BYTES;

  return {
    html: rawHtml === null ? null : rawHtml.slice(0, MAX_BODY_BYTES),
    text: rawText === null ? null : rawText.slice(0, MAX_BODY_BYTES),
    truncated: overBound,
  };
}

export interface SanitizedBody {
  html: string;
  /** How many remote resources were withheld. Shown to the reader, never hidden (ADR 37). */
  blockedRemote: number;
  inputHadContent: boolean;
}

/**
 * Sanitises with `HTMLRewriter` — a Workers built-in, so this costs no bundle bytes.
 *
 * Counting blocked resources requires buffering the output, which is why the input is bounded. The
 * *evidence* path stays unbounded and streamed (§16); this bound is on the rendered panel only.
 */
export async function sanitizeHtml(html: string): Promise<SanitizedBody> {
  let blockedRemote = 0;

  const rewriter = new HTMLRewriter().on("*", {
    element(element) {
      const tag = element.tagName.toLowerCase();

      if (DROP_WITH_CONTENT.has(tag)) {
        element.remove();
        return;
      }

      if (!KEEP.has(tag)) {
        // Unknown, but its text is probably the message. Keep the content, lose the element.
        element.removeAndKeepContent();
        return;
      }

      // Allowlist the attributes. Collected first, because removing while iterating is undefined.
      const present = [...element.attributes].map(([name]) => (name ?? "").toLowerCase());

      // `removeAttribute` is a linear scan of the remaining attributes, so removing them one by one is
      // quadratic. Measured in the Workers runtime: 10,000 attributes took 112 ms, 50,000 took **35
      // seconds** — past the CPU limit, so the request is killed every time and the message becomes
      // permanently unopenable. 439 KB of attributes fits inside `render.max_body_bytes` with room to
      // spare, so the input bound does not contain it. Anyone who can send mail could do this.
      //
      // Real mail never approaches 64 attributes on one element. Past that, drop the element and keep
      // its text in a single operation rather than paying the quadratic cost to reach the same result.
      if (present.length > MAX_ATTRIBUTES) {
        element.removeAndKeepContent();
        return;
      }

      const allowed = ALLOWED_ATTRIBUTES[tag] ?? new Set<string>();
      for (const name of present) {
        if (!allowed.has(name)) element.removeAttribute(name);
      }

      if (tag === "img") {
        // The attribute was already stripped by the allowlist; this counts what was withheld so the
        // reader can be told, and leaves a marker the client can style.
        const had = present.some((name) => name === "src" || name === "srcset");
        if (had) {
          blockedRemote += 1;
          element.setAttribute("data-mailda-blocked", "remote-image");
        }
      }

      if (tag === "a") {
        const href = element.getAttribute("href");
        if (href === null || !SAFE_SCHEMES.test(href.trim())) {
          element.removeAttribute("href");
        } else {
          // Opening in a new context with no window handle back to this one.
          element.setAttribute("target", "_blank");
          element.setAttribute("rel", "noopener noreferrer nofollow");
        }
      }
    },

    /**
     * Re-encodes every text chunk on the way out.
     *
     * Without this, the sanitiser's safety rested on an assumption it did not enforce: that the
     * browser would retokenize the output exactly as lol-html tokenized the input. **Removing tags is
     * precisely what breaks that assumption.** A lone `<` is a character token, so
     * `<foo><</foo>img src=...>` gives lol-html an unknown element containing the text `<`, then the
     * text `img src=...>`. Unwrapping `<foo>` makes those adjacent, and the browser reads a working
     * `<img>` — measured, with `blockedRemote` reporting 0.
     *
     * Escaping on output means the two tokenizers can no longer disagree. It fixes that case, the
     * raw-text case above, and — the reason it is worth more than either fix — **it fails closed for
     * whatever the next parser differential turns out to be.**
     *
     * The existing test for this only used the entity form (`&lt;img`), which was already safe, so it
     * passed while the real case failed. A test that cannot fail is not evidence.
     */
    text(chunk) {
      // Only `<`, and only ever as `html: true` so nothing else is touched.
      //
      // The first attempt used `chunk.replace(chunk.text, { html: false })` and let HTMLRewriter do the
      // escaping. That double-encoded: `chunk.text` returns the **raw source**, not decoded text, so an
      // `&lt;` in the message came back as `&amp;lt;` and the reader saw `&lt;img ...` instead of the
      // `<img ...` the sender wrote. Caught by the test for the entity case — the same test that had
      // been giving false confidence a moment earlier.
      //
      // `&` cannot open a tag, so escaping it buys nothing and costs correctness. `<` is the whole
      // vector.
      const raw = chunk.text;
      if (raw.includes("<")) chunk.replace(raw.replaceAll("<", "&lt;"), { html: true });
    },
  });

  // `onDocument`, not `on("*")`.
  //
  // A comments handler attached to an element selector only fires for comments *inside* a matched
  // element, so a top-level comment survived untouched — found by a test that asserted the intent
  // rather than the implementation. That matters because `<!--[if IE]><img src=...><![endif]-->` is a
  // real and widely used tracking technique: Outlook-family renderers process conditional comments, and
  // even where a browser treats the content as inert, the tracker URL survives into anything that later
  // quotes, forwards or exports this body.
  rewriter.onDocument({
    comments(comment) {
      comment.remove();
    },
  });

  const sanitized = await rewriter
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }))
    .text();

  return { html: sanitized, blockedRemote, inputHadContent: html.trim().length > 0 };
}

/**
 * The four states §5C requires be distinguishable. A blank panel standing in for any of them is the
 * first lie a mail client tells.
 */
export type BodyState = "html" | "text-only" | "no-body" | "unparsed";

export interface RenderedBody {
  state: BodyState;
  /** Sanitized HTML, for a sandboxed iframe. Never present unless `state` is `html`. */
  html: string | null;
  text: string | null;
  blockedRemote: number;
  truncated: boolean;
  /** Set when `state` is `unparsed`: what went wrong, in the reader's terms. */
  problem: string | null;
}

export async function renderBody(raw: Uint8Array): Promise<RenderedBody> {
  let extracted: ExtractedBody;
  try {
    extracted = await extractBody(raw);
  } catch (error) {
    // §24 forbids losing accepted mail: a body that cannot be parsed is still a message, and the
    // original remains downloadable in full. Reported as its own state rather than as an empty one.
    return {
      state: "unparsed",
      html: null,
      text: null,
      blockedRemote: 0,
      truncated: false,
      problem:
        `This message's body could not be read (${(error as Error).message.split("\n")[0]}). ` +
        `The original is unchanged and can still be downloaded.`,
    };
  }

  if (extracted.html !== null) {
    try {
      const { html, blockedRemote, inputHadContent } = await sanitizeHtml(extracted.html);

      // Nothing survived, but there was something to begin with. Reporting `html` here would show an
      // empty panel while asserting the message had been rendered — a reader cannot tell that from a
      // message that is genuinely empty, and §5C requires they can. Fall back to the plain alternative
      // if one exists, and say so otherwise.
      if (inputHadContent && html.trim().length === 0) {
        return {
          state: extracted.text === null ? "unparsed" : "text-only",
          html: null,
          text: extracted.text,
          blockedRemote,
          truncated: extracted.truncated,
          problem:
            "Nothing in this message's HTML survived sanitising. " +
            (extracted.text === null
              ? "The original is unchanged and can still be downloaded."
              : "Its plain-text alternative is shown instead."),
        };
      }

      return {
        state: "html",
        html,
        text: extracted.text,
        blockedRemote,
        truncated: extracted.truncated,
        problem: null,
      };
    } catch (error) {
      // The careful error handling above stopped one line short: `extractBody` was wrapped and
      // `sanitizeHtml` was not, so a rewriter failure escaped as a 500 instead of the state §24
      // requires. Falling back to the plain alternative where one exists means a body that cannot be
      // *rendered* is still readable.
      return {
        state: extracted.text === null ? "unparsed" : "text-only",
        html: null,
        text: extracted.text,
        blockedRemote: 0,
        truncated: extracted.truncated,
        problem:
          `This message's HTML could not be rendered safely ` +
          `(${(error as Error).message.split("\n")[0]}). ` +
          (extracted.text === null
            ? "The original is unchanged and can still be downloaded."
            : "Its plain-text alternative is shown instead."),
      };
    }
  }

  if (extracted.text !== null) {
    return {
      state: "text-only",
      html: null,
      text: extracted.text,
      blockedRemote: 0,
      truncated: extracted.truncated,
      problem: null,
    };
  }

  return {
    state: "no-body",
    html: null,
    text: null,
    blockedRemote: 0,
    truncated: extracted.truncated,
    problem: null,
  };
}
