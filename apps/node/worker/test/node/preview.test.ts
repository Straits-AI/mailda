import { describe, expect, it } from "vitest";

import { displayNameOf, NAME_CHARS } from "../../src/mime.ts";
import { openPreview, PREVIEW_CHARS, PREVIEW_SCAN_CHARS, previewText, sealPreview } from "../../src/preview.ts";

/**
 * The row projections (0068) as pure functions: what one line of a body is, what a display name is allowed to
 * be, and that a sealed preview opens only on the row and under the key it was sealed for.
 *
 * Node rather than workerd, because none of it touches a binding: WebCrypto is the platform's in both.
 * `test/message-previews.test.ts` drives the same functions through ingest, the backfill and the listing.
 */

async function key(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) as CryptoKey;
}

describe("one line of a body", () => {
  it("prefers the plain part, and falls back to the HTML reduced to words", () => {
    expect(previewText({ text: "Plain words here", html: "<p>HTML words</p>" })).toBe("Plain words here");
    expect(previewText({ text: "   \r\n  ", html: "<p>Only <b>HTML</b> here</p>" })).toBe("Only HTML here");
    expect(previewText({ text: null, html: "<style>p { color: red }</style><p>Styled</p>" })).toBe("Styled");
  });

  it("drops quoted lines, so a reply previews its own words and not the message it answers", () => {
    expect(previewText({ text: "Thanks, sorted.\r\n\r\n> On Monday you wrote:\r\n  > the invoice", html: null }))
      .toBe("Thanks, sorted.");
  });

  it("removes control and format characters, and collapses whitespace", () => {
    // A zero-width joiner (Cf) and a bell (Cc) vanish; a tab and newlines become one space.
    expect(previewText({ text: "a‍b\u0007c\tsecond\n\nthird", html: null })).toBe("abc second third");
  });

  it("cuts at PREVIEW_CHARS code points, never inside a surrogate pair, and adds no ellipsis", () => {
    const astral = "😀".repeat(PREVIEW_CHARS + 10);
    const cut = previewText({ text: astral, html: null })!;
    expect(Array.from(cut)).toHaveLength(PREVIEW_CHARS);
    expect(cut.endsWith("…")).toBe(false);
    expect(cut).toBe("😀".repeat(PREVIEW_CHARS));
    // A cut that lands on a space is trimmed rather than stored with a trailing blank.
    expect(previewText({ text: `${"x".repeat(PREVIEW_CHARS - 1)} tail`, html: null }))
      .toBe("x".repeat(PREVIEW_CHARS - 1));
  });

  it("reads only the first PREVIEW_SCAN_CHARS of a very large body, whatever lies past them", () => {
    // A reply under a quote longer than the scan: 25 MiB of words the unbounded version would reach and list.
    const quoted = "> quoted line of an earlier message\n";
    const quote = quoted.repeat(Math.ceil(PREVIEW_SCAN_CHARS / quoted.length));
    const huge = `${quote}Reply written below the quote\n${"filler words ".repeat(2 * 1024 * 1024)}`;
    expect(huge.length).toBeGreaterThan(25 * 1024 * 1024);
    expect(previewText({ text: huge, html: null }), "the scan read past PREVIEW_SCAN_CHARS").toBeNull();
    // The same body with its words on top previews as a small one does.
    expect(previewText({ text: `Top line\n${huge}`, html: null })).toBe("Top line");
  });

  it("cuts the scan before a high surrogate, never between the halves of a pair", () => {
    const text = `a${" ".repeat(PREVIEW_SCAN_CHARS - 2)}😀tail`;
    expect(text.charCodeAt(PREVIEW_SCAN_CHARS - 1)).toBe(0xd83d);
    expect(previewText({ text, html: null })).toBe("a");
  });

  it("is null when there is nothing to show", () => {
    expect(previewText({ text: null, html: null })).toBeNull();
    expect(previewText({ text: " \n\t ", html: "<br>" })).toBeNull();
    expect(previewText({ text: "> only a quote", html: null })).toBeNull();
  });
});

describe("a display name, and the ones that are refused", () => {
  it("keeps a real name, quoted or not, decoded", () => {
    expect(displayNameOf("Aisha Rahman <aisha@example.net>")).toBe("Aisha Rahman");
    expect(displayNameOf('"Rahman, Aisha" <aisha@example.net>')).toBe("Rahman, Aisha");
    expect(displayNameOf('"Say \\"hi\\"" <x@example.net>')).toBe('Say "hi"');
    expect(displayNameOf("=?utf-8?B?w4lsb2RpZQ==?= <e@example.net>")).toBe("Élodie");
  });

  it("finds the address bracket outside quotes only", () => {
    expect(displayNameOf('"a <b" <c@example.net>')).toBe("a <b");
  });

  it("is null for a bare address, which has no name", () => {
    expect(displayNameOf("aisha@example.net")).toBeNull();
    expect(displayNameOf("")).toBeNull();
    expect(displayNameOf("<aisha@example.net>")).toBeNull();
  });

  it("refuses a name shaped like an address or a domain, which is how a spoof would wear one", () => {
    // The spoof: the name claims an address the real one (smaller text, beside it) is not.
    expect(displayNameOf('"ceo@whymelabs.test" <x@evil.example>')).toBeNull();
    expect(displayNameOf("aisha@example.net <aisha@example.net>")).toBeNull();
    expect(displayNameOf("paypal.com <x@evil.example>")).toBeNull();
    // A name with a dot that is not a domain is still a name.
    expect(displayNameOf("J. Smith <j@example.net>")).toBe("J. Smith");
  });

  it("refuses the lookalikes of an address or a domain, and a name with nothing visible in it", () => {
    // A fullwidth at sign (U+FF20) and a small commercial at (U+FE6B) read as `@` in a list row.
    expect(displayNameOf('"ceo\uFF20whymelabs.test" <x@evil.example>')).toBeNull();
    expect(displayNameOf('"ceo\uFE6Bwhymelabs.test" <x@evil.example>')).toBeNull();
    // A Cyrillic у (U+0443) in a domain, and a domain dotted with a fullwidth or ideographic full stop.
    expect(displayNameOf('"wh\u0443melabs.test" <x@evil.example>')).toBeNull();
    expect(displayNameOf('"whymelabs\uFF0Etest" <x@evil.example>')).toBeNull();
    expect(displayNameOf('"whymelabs\u3002test" <x@evil.example>')).toBeNull();
    // A Hangul filler (U+3164) renders as a blank sender; so does a braille blank (U+2800).
    expect(displayNameOf('"\u3164" <x@evil.example>')).toBeNull();
    expect(displayNameOf('"\u2800\u2800" <x@evil.example>')).toBeNull();
    // A name in another script is still a name, returned as written.
    expect(displayNameOf('"\u4F8B\u3048 \u592A\u90CE" <t@example.jp>')).toBe("\u4F8B\u3048 \u592A\u90CE");
    expect(displayNameOf('"\u0410\u0439\u0448\u0430 \u0420\u0430\u0445\u043C\u0430\u043D" <a@example.net>'))
      .toBe("\u0410\u0439\u0448\u0430 \u0420\u0430\u0445\u043C\u0430\u043D");
  });

  it("removes control characters and caps the length at NAME_CHARS code points", () => {
    expect(displayNameOf("Ai\u0000sha​ Rahman <a@example.net>")).toBe("Aisha Rahman");
    const long = displayNameOf(`${"n".repeat(NAME_CHARS + 50)} <a@example.net>`)!;
    expect(Array.from(long)).toHaveLength(NAME_CHARS);
  });
});

describe("a sealed preview", () => {
  it("round-trips, and the stored text does not contain the words", async () => {
    const k = await key();
    const sealed = await sealPreview(k, "msg_1", "Invoice INV-2041 is attached");
    expect(sealed).not.toContain("Invoice");
    expect(atob(sealed)).not.toContain("Invoice");
    expect(await openPreview(k, "msg_1", sealed)).toBe("Invoice INV-2041 is attached");
  });

  it("opens only on the row it was sealed for, because the message id is the additional data", async () => {
    const k = await key();
    const sealed = await sealPreview(k, "msg_1", "for the first row");
    await expect(openPreview(k, "msg_2", sealed)).rejects.toThrow();
  });

  it("opens only under its own key", async () => {
    const sealed = await sealPreview(await key(), "msg_1", "text");
    await expect(openPreview(await key(), "msg_1", sealed)).rejects.toThrow();
  });

  it("refuses a tampered or malformed value rather than returning something", async () => {
    const k = await key();
    const sealed = await sealPreview(k, "msg_1", "text");
    const bytes = Uint8Array.from(atob(sealed), (char) => char.charCodeAt(0));
    bytes[bytes.length - 1]! ^= 1;
    await expect(openPreview(k, "msg_1", btoa(String.fromCharCode(...bytes)))).rejects.toThrow();
    await expect(openPreview(k, "msg_1", "not base64 at all!")).rejects.toThrow();
    await expect(openPreview(k, "msg_1", btoa("short"))).rejects.toThrow();
  });
});
