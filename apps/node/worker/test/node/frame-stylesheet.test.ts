import { describe, expect, it } from "vitest";

import { BODY_SCRIPTS } from "@mailda/contract/schemas";

import { THEMES, declarations, frameStylesheet, scriptFamily } from "../../src/theme.ts";
import { cssRules, themeBlocks } from "./support/theme-blocks.ts";

/**
 * The sandboxed body frame's stylesheet, served at `/app/frame.css`.
 *
 * The frame is opaque-origin, so it cannot see the shell's `<html>`: the reader writes the viewer's theme on
 * the frame's own root, and this sheet has to mean the same thing by it. And the sheet loads into a frame
 * that holds a stranger's markup, so nothing in it may fetch anything.
 */

const sheet = frameStylesheet();

describe("the frame's stylesheet", () => {
  it("carries the shell's three theme blocks, with the same tokens", () => {
    const blocks = themeBlocks(sheet);
    expect(blocks.dark).toContain(declarations(THEMES.dark));
    expect(blocks.light).toContain(declarations(THEMES.light));
    expect(blocks.system).toContain(declarations(THEMES.light));
  });

  it("paints the frame's own ground and text, so mail is not a white box in a dark reader", () => {
    // The sanitiser strips every colour a sender wrote, so without this the frame is the browser's white
    // canvas with black serif text, whatever the viewer chose.
    const root = cssRules(sheet.slice(themeBlocks(sheet).end)).find((rule) => rule.selectors.includes("html"));
    const value = (property: string) => root?.declarations.find((one) => one.property === property)?.value;
    expect(value("background")).toBe("var(--bg-reader)");
    expect(value("color")).toBe("var(--text-primary)");
  });

  it("colours the mail only with the tokens, so a token change cannot leave the frame behind", () => {
    /** Everything after the three blocks: the rules that style the mail. */
    const rules = sheet.slice(themeBlocks(sheet).end);
    expect(rules.length, "no rules after the theme blocks").toBeGreaterThan(100);
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    const names = [...rules.matchAll(/var\(--([\w-]+)\)/g)].map((match) => match[1]!);
    expect(names.length).toBeGreaterThan(0);
    const known = new Set(Object.keys(THEMES.dark));
    expect(names.filter((name) => !known.has(name))).toEqual([]);
  });

  it("breaks only a word too long for its line in text, but anywhere in a link or code", () => {
    // `anywhere` on the body let a table cell shrink to one character, so a 320px reader split "Amount" in
    // an invoice table. A link or code token keeps `anywhere`, or a tracking URL in a cell widens the table
    // past the frame. The split itself needs a browser to see; these are the declarations that decide it.
    const rules = cssRules(sheet.slice(themeBlocks(sheet).end));
    const wrap = (selector: string) => rules
      .find((rule) => rule.selectors.includes(selector))?.declarations
      .find((one) => one.property === "overflow-wrap")?.value;
    expect(wrap("body")).toBe("break-word");
    expect(wrap("a")).toBe("anywhere");
    expect(wrap("pre")).toBe("anywhere");
    expect(wrap("code")).toBe("anywhere");
  });

  it("names Han faces of the message's own script, before the UI sans that would draw another's (critic M9)", () => {
    // The reader writes `data-script` from the message (`src/render/script.ts`); an attribute nothing reads would
    // be a landmine. Each script leads with its own faces, and every one of them still ends on the generic family.
    const rules = cssRules(sheet.slice(themeBlocks(sheet).end));
    const family = (script: string) => rules
      .find((rule) => rule.selectors.includes(`html[data-script="${script}"] body`))?.declarations
      .find((one) => one.property === "font-family")?.value;
    const lead = { sc: /^"PingFang SC",.*"Noto Sans CJK SC"/, tc: /^"PingFang TC",.*"Noto Sans CJK TC"/, jp: /^"Hiragino Sans",.*"Noto Sans CJK JP"/ };
    for (const script of BODY_SCRIPTS) {
      expect(family(script), script).toMatch(lead[script]);
      expect(family(script)!.indexOf("CJK"), script).toBeLessThan(family(script)!.indexOf("system-ui"));
      expect(family(script), script).toMatch(/, sans-serif$/);
    }
  });

  it("lets a sender's lang on an element pick that element's forms, Traditional tags after the zh they also match", () => {
    // `<p lang="ja">` inside a GB2312 message is Japanese there; the frame's `data-script` is the whole message's.
    // `:lang(zh)` matches zh-TW too, so at equal specificity the Traditional rule has to come later to win.
    const rules = cssRules(sheet.slice(themeBlocks(sheet).end));
    const at = (selector: string) => rules.findIndex((rule) => rule.selectors.includes(selector));
    const family = (selector: string) => rules[at(selector)]?.declarations.find((one) => one.property === "font-family")?.value;
    expect(family("[lang]:lang(ja)")).toBe(scriptFamily("jp"));
    expect(family("[lang]:lang(zh-TW)")).toBe(scriptFamily("tc"));
    expect(family("[lang]:lang(zh-Hant)")).toBe(scriptFamily("tc"));
    expect(family("[lang]:lang(zh)")).toBe(scriptFamily("sc"));
    expect(at("[lang]:lang(zh)")).toBeLessThan(at("[lang]:lang(zh-TW)"));
    expect(at("[lang]:lang(zh)")).toBeLessThan(at("[lang]:lang(zh-HK)"));
  });

  it("can fetch nothing", () => {
    // A font or an image fetched from the frame's opaque origin, or a sheet imported into it, is a request
    // a stranger's message could shape. None of these may appear anywhere in it.
    for (const hazard of ["url(", "@import", "@font-face", "expression("]) {
      expect(sheet, hazard).not.toContain(hazard);
    }
  });
});
