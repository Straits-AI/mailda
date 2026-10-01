import { describe, expect, it } from "vitest";

import { BODY_SCRIPTS } from "@mailda/contract/schemas";

import { SHELL_CSS } from "../../src/shell-css.ts";
import { scriptFamily } from "../../src/theme.ts";
import { cssRules } from "./support/theme-blocks.ts";

/**
 * Chinese type without a CJK webfont (ADR 30 as amended, ADR 46), read from the served sheet's rules.
 *
 * The stack is the whole mechanism: Inter first, so Latin is unchanged; the named Simplified Chinese faces
 * next, so Han is set in a real SC face at real weights; and only then `system-ui`, which on Linux Chromium drew
 * Japanese glyph forms and a faux bold. Tracking is a token so Chinese can zero it.
 *
 * "Inter first" is Inter's own files under a second name, `"Inter Latin"`, whose `unicode-range` leaves out the
 * punctuation Chinese shares with Latin (“ ” ‘ ’ — … ·). Inter has those glyphs, so under the plain name it would
 * set 在邮件中搜索“发票” with narrow Latin quotes and a baseline ellipsis; left out, they fall through to the SC face.
 */

const rules = cssRules(SHELL_CSS);
const ZH = ":root:lang(zh)";
const SC_FACES = ['"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', '"Noto Sans CJK SC"', '"Source Han Sans SC"', '"Noto Sans SC"'];

/** A custom property's value in the rules whose selector is exactly `selector`. */
function property(selector: string, name: string): string | undefined {
  return rules.filter((rule) => rule.selectors.includes(selector)).flatMap((rule) => rule.declarations)
    .find((declaration) => declaration.property === name)?.value;
}

const stack = (value: string | undefined): string[] => (value ?? "").split(",").map((one) => one.trim());

/** Every `@font-face` block's declarations (`cssRules` skips them: they hold no selector). */
function fontFaces(): Array<Record<string, string>> {
  const css = SHELL_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((block) => Object.fromEntries(block[1]!.split(";")
    .flatMap((one) => (one.includes(":") ? [[one.slice(0, one.indexOf(":")).trim(), one.slice(one.indexOf(":") + 1).trim()]] : []))));
}

/** A `unicode-range` as closed intervals of code points; absent means every code point. */
function ranges(value: string | undefined): Array<[number, number]> {
  if (value === undefined) return [[0, 0x10ffff]];
  return value.split(",").map((one) => {
    const [from, to = from] = one.trim().replace(/^U\+/i, "").split("-");
    return [parseInt(from!, 16), parseInt(to!, 16)];
  });
}

const SHARED_PUNCTUATION = { "·": 0xb7, "—": 0x2014, "‘": 0x2018, "’": 0x2019, "“": 0x201c, "”": 0x201d, "…": 0x2026 };

describe("the Simplified Chinese type", () => {
  it("names the SC faces after Inter and before system-ui in the body stack", () => {
    const body = stack(property(ZH, "--body"));
    expect(body[0]).toBe('"Inter Latin"');
    const faces = SC_FACES.map((face) => body.indexOf(face));
    expect(faces.every((at) => at > 0), `missing from ${body.join(", ")}`).toBe(true);
    expect(Math.max(...faces)).toBeLessThan(body.indexOf("system-ui"));
  });

  it("sets Latin in Inter's own files under Chinese, and leaves the punctuation Chinese shares to the SC face", () => {
    const faces = fontFaces();
    const inter = faces.filter((face) => face["font-family"] === "Inter");
    const twin = faces.filter((face) => face["font-family"] === '"Inter Latin"');
    expect(inter.length).toBe(4);
    // The same four files at the same weights: no byte is added, the browser's cache already holds them.
    expect(twin.map((face) => [face.src, face["font-weight"]])).toEqual(inter.map((face) => [face.src, face["font-weight"]]));
    const covers = (face: Record<string, string>, point: number) =>
      ranges(face["unicode-range"]).some(([from, to]) => point >= from && point <= to);
    for (const face of twin) {
      const kept = Object.entries(SHARED_PUNCTUATION).filter(([, point]) => covers(face, point)).map(([mark]) => mark);
      expect(kept, `${face["font-weight"]} still sets these in Latin`).toEqual([]);
      for (const mark of "Az09,.:;!?()@-'\"") expect(covers(face, mark.codePointAt(0)!), mark).toBe(true);
    }
    // English is untouched: its stack still starts with the plain name, which covers everything Inter has.
    expect(stack(property(":root", "--body"))[0]).toBe("Inter");
  });

  it("gives the monospace stack the same SC tail, before the generic family", () => {
    const mono = stack(property(ZH, "--mono"));
    const faces = SC_FACES.map((face) => mono.indexOf(face));
    expect(faces.every((at) => at > 0)).toBe(true);
    expect(Math.max(...faces)).toBeLessThan(mono.indexOf("monospace"));
  });

  it("sets tracking only through a token, and zeroes every token under Chinese", () => {
    const CODE_RULES = new Set([".codes li", ".invite-value"]);
    const spaced = rules.flatMap((rule) => rule.declarations.filter((one) => one.property === "letter-spacing")
      .map((one) => ({ selectors: rule.selectors, value: one.value })));
    expect(spaced.length).toBeGreaterThan(5);
    const literal = spaced.filter(({ selectors, value }) =>
      !/^var\(--track-[a-z]+\)$/.test(value) && value !== "inherit" && !selectors.every((one) => CODE_RULES.has(one)));
    // A literal letter-spacing on words would not be zeroed under Chinese. Codes and secrets are Latin identifiers.
    expect(literal).toEqual([]);
    const used = new Set(spaced.flatMap(({ value }) => /^var\((--track-[a-z]+)\)$/.exec(value)?.[1] ?? []));
    for (const token of used) expect(property(ZH, token), `${token} is not zeroed under Chinese`).toBe("0");
  });

  it("sets the rail's labels at 12px under Chinese, and the group toggle at a line-height its glyphs fit", () => {
    expect(property(`${ZH} .rail-heading`, "font-size")).toBe("12px");
    expect(property(`${ZH} .rail-group-toggle`, "font-size")).toBe("12px");
    expect(Number(property(`${ZH} .rail-group-toggle`, "line-height"))).toBeGreaterThanOrEqual(1.3);
  });

  it("keeps a column header's Han together under Chinese, as a Latin header's word is", () => {
    expect(property(`${ZH} thead th`, "word-break")).toBe("keep-all");
  });

  it("keeps a control's Han together in a table cell under Chinese, so a row's 发布 is not one character per line", () => {
    expect(property(`${ZH} td button`, "word-break")).toBe("keep-all");
    expect(property(`${ZH} td a`, "word-break")).toBe("keep-all");
  });
});

describe("a plain-text body's type", () => {
  it("is the message's script, the frame's own families, over the interface's stack (critic M9)", () => {
    // The `<pre>` sits in the shell, under `:root:lang(zh)` when the interface is Chinese; its `data-script` is the
    // message's, and a rule nothing matched would leave a Japanese message in the SC faces.
    for (const script of BODY_SCRIPTS) {
      const family = rules.filter((rule) => rule.selectors.includes(`.message-text[data-script="${script}"]`))
        .flatMap((rule) => rule.declarations).find((one) => one.property === "font-family")?.value;
      expect(family, script).toBe(scriptFamily(script));
    }
  });
});
