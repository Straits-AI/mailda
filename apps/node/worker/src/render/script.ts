import type { BodyScript } from "@mailda/contract/schemas";

/**
 * Which glyph forms a message's Han should be drawn in, from what the message itself says (critic M9, ADR 46).
 *
 * One code point is drawn differently in Simplified Chinese, Traditional Chinese and Japanese, and a platform with
 * no hint picks by its own locale: on some systems a GB2312 message renders in Japanese forms. The frame never
 * takes the reader's interface language, so the hint comes from the message, in the order it is most reliable:
 *
 * 1. The rendered part's charset. A legacy CJK charset names its script outright: GB2312, GBK and GB18030 are
 *    Simplified, Big5 is Traditional, ISO-2022-JP, Shift_JIS and EUC-JP are Japanese. The label is read through
 *    `TextDecoder`, which maps every WHATWG alias (`x-gbk`, `x-sjis`, `csbig5`, …) to one canonical name, the same
 *    reading `postal-mime` decoded the part with.
 * 2. `Content-Language`, its first tag's likely script (`zh` is Hans, `zh-TW` and `zh-HK` are Hant, `ja` is Jpan).
 * 3. The HTML's own root `lang`, read the same way: `renderBody` asks again with it when the first two are silent.
 *
 * None is a claim about the language, only about the glyphs: the result is `data-script` on the frame, not
 * `lang`. UTF-8 that says none of them says nothing, and null leaves the choice to the reader (`reader.tsx`).
 */
const BY_ENCODING: ReadonlyMap<string, BodyScript> = new Map([
  ["gbk", "sc"], ["gb18030", "sc"], ["big5", "tc"], ["iso-2022-jp", "jp"], ["shift_jis", "jp"], ["euc-jp", "jp"],
]);
const BY_SCRIPT: ReadonlyMap<string, BodyScript> = new Map([["Hans", "sc"], ["Hant", "tc"], ["Jpan", "jp"]]);

export function bodyScript(charset: string | null, contentLanguage: string | null): BodyScript | null {
  const byCharset = charset === null ? undefined : BY_ENCODING.get(encodingOf(charset) ?? "");
  if (byCharset !== undefined) return byCharset;
  const tag = contentLanguage?.split(",")[0]?.trim() ?? "";
  if (tag === "") return null;
  try {
    return BY_SCRIPT.get(new Intl.Locale(tag).maximize().script ?? "") ?? null;
  } catch {
    // A malformed tag states no language, so there is no script to take from it; null is the answer, not a lost error.
    return null;
  }
}

/** The WHATWG canonical name for a charset label, or null for a label no browser knows. */
function encodingOf(label: string): string | null {
  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    // An unknown label names no encoding (postal-mime then decodes as windows-1252), so no script either.
    return null;
  }
}
