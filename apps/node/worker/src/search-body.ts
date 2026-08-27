import { BUDGETS } from "@mailda/budgets";

import { extractBody } from "./render/body.ts";

/**
 * Turning a message into the text the body index holds (#107 L2).
 *
 * ## Why this is not `renderBody`
 *
 * `renderBody` produces something to **show a reader**: sanitised HTML with remote content blocked, a
 * fallback to the plain alternative, and a state saying which happened. None of that matters to a tokenizer.
 * What matters here is the opposite set of concerns — that every word a sender wrote reaches the index, that
 * no markup becomes a word, and that the work is bounded.
 *
 * Using the display renderer would also mean a message's searchability depended on whether the sanitiser
 * liked its markup, which is a coupling nobody would choose deliberately: mail that renders oddly should
 * still be findable.
 *
 * ## HTML-only mail is the case that decides this file exists
 *
 * `extractBody` returns `text` and `html` separately, and the obvious implementation indexes `text`. A great
 * deal of real mail has **no text part at all** — and indexing only the plain alternative would make that
 * mail silently unsearchable, which is exactly the shape of failure this repository keeps finding: it looks
 * like working search until somebody notices a whole class of message never appears.
 *
 * So HTML is reduced to words. Doing that safely is much easier here than it would be for display, because
 * the output is never rendered — it goes to a tokenizer and is then discarded. Nothing in this file needs to
 * produce safe markup; it needs to produce *words*, and a tag that survives as the word `div` is a quality
 * problem rather than a security one.
 */

/**
 * The most text one message contributes to the index.
 *
 * `render.max_body_bytes` is what `extractBody` already bounds to, so this inherits the bound rather than
 * inventing a second one — a message whose body is cut for display and whole for search would make the two
 * disagree about what the message says, and the display bound is the one with a receipt behind it.
 */
const MAX_INDEXED = BUDGETS["render.max_body_bytes"];

/**
 * Elements whose **contents** are not prose and must not become words.
 *
 * Stripped whole, tags and all. `<style>` is the one that matters: a mail template's CSS is thousands of
 * tokens of `font-family`, `sans-serif` and hex colours, and indexing it would put junk in the index for
 * every HTML message while making the common-term statistics that drive bm25 ranking meaningless.
 */
const NOT_PROSE = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** The handful of entities common enough in mail that leaving them would produce wrong words. */
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
};

/**
 * HTML reduced to the words in it.
 *
 * Deliberately crude, and crude in the safe direction: anything it fails to understand becomes whitespace
 * rather than a word. A regex is not an HTML parser and this does not pretend to be one — but the failure
 * mode of a bad reduction here is *a message that is slightly harder to find*, not a message that is
 * rendered wrongly, which is why the display path uses a real sanitiser and this does not.
 */
export function wordsFromHtml(html: string): string {
  let text = html.replace(NOT_PROSE, " ");
  // Tags become spaces rather than nothing: `a<br>b` is two words, and deleting the tag would make it one.
  text = text.replace(/<[^>]*>/g, " ");
  for (const [entity, character] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(character);
  }
  // Numeric entities, which mail templates produce in quantity. Unknown ones become a space, not a literal.
  text = text.replace(/&#\d+;|&[a-zA-Z]+;/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The text to index for one message, or `null` when there is nothing to index.
 *
 * **Both parts when both exist**, rather than preferring one. A multipart/alternative message is supposed to
 * carry the same content twice, and usually does — but "supposed to" is doing a lot of work in a mail system,
 * and a sender whose HTML says more than their plain text would otherwise have the extra words dropped. The
 * duplication costs index size and nothing else: FTS5 stores a posting per distinct term per row, so a word
 * appearing in both parts is one entry either way.
 *
 * `null` rather than an empty string for a message with no body, so the caller writes no row at all. An empty
 * index row is a row that can never match, taking space and appearing in every count of what has been
 * indexed — which would make the backfill's progress figure a lie.
 */
export async function indexableText(raw: Uint8Array): Promise<string | null> {
  let extracted;
  try {
    extracted = await extractBody(raw);
  } catch {
    /*
     * §24 forbids losing accepted mail, and an unparseable body is still a message. It is not searchable by
     * its contents, and it stays reachable by paging and by subject — the same position `renderBody` takes
     * when it reports `unparsed` rather than pretending the message is empty.
     *
     * Swallowed here rather than thrown, and this is the one place in the ingest batch where that is right:
     * a message whose body cannot be parsed must still be **delivered**. Raising would make an unparseable
     * body block the mailbox item, which is the failure §24 names.
     */
    return null;
  }

  const parts: string[] = [];
  if (extracted.text !== null) parts.push(extracted.text);
  if (extracted.html !== null) parts.push(wordsFromHtml(extracted.html));

  const joined = parts.join(" ").trim();
  if (joined === "") return null;
  return joined.slice(0, MAX_INDEXED);
}
