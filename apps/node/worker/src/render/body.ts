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

/** Elements whose *content* is a payload, not text. Removed with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "applet", "template", "noscript",
  "svg", "math", "form", "input", "button", "select", "textarea", "option",
  "link", "meta", "base", "title", "head", "frame", "frameset", "audio", "video", "source", "track",
]);

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
  const truncated = raw.length > MAX_BODY_BYTES;
  const source = truncated ? raw.subarray(0, MAX_BODY_BYTES) : raw;

  const { default: PostalMime } = await import("postal-mime");
  const parsed = await PostalMime.parse(source);

  return {
    html: typeof parsed.html === "string" && parsed.html.length > 0 ? parsed.html : null,
    text: typeof parsed.text === "string" && parsed.text.length > 0 ? parsed.text : null,
    truncated,
  };
}

export interface SanitizedBody {
  html: string;
  /** How many remote resources were withheld. Shown to the reader, never hidden (ADR 37). */
  blockedRemote: number;
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

  return { html: sanitized, blockedRemote };
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
    const { html, blockedRemote } = await sanitizeHtml(extracted.html);
    return {
      state: "html",
      html,
      text: extracted.text,
      blockedRemote,
      truncated: extracted.truncated,
      problem: null,
    };
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
