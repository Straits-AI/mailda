import { describe, expect, it } from "vitest";

import { t } from "/app/locale.js";
import type { Twin } from "../../src/i18n/catalog.ts";
import type { language } from "../../src/i18n/en/language.ts";
import type { Area } from "../../src/i18n/areas.ts";
import type { Params, Text } from "../../src/i18n/format.ts";
import { language as zhLanguage } from "../../src/i18n/zh-Hans/language.ts";

/**
 * The catalog's closed world is a type (ADR 46, AGENTS.md §2c rung 1). Each `@ts-expect-error` below is a
 * defect the compiler must refuse; `pnpm typecheck` fails with "Unused '@ts-expect-error' directive" the day
 * one of them compiles. Deleting the line under a directive is how each was seen to fail.
 *
 * The cases sit in a function nothing calls, so the suite checks their types without running a wrong call.
 */
function refused(wire: string): unknown[] {
  const { ["language.heading"]: _dropped, ...partial } = zhLanguage;
  return [
    // b1: a translation missing a key.
    // @ts-expect-error Property '"language.heading"' is missing
    ((): Twin<typeof language> => partial)(),
    // b2: a translation with a key the source lacks.
    // @ts-expect-error Object literal may only specify known properties
    ((): Twin<typeof language> => ({ ...zhLanguage, "language.headng": "语言" }))(),
    // b3: a key outside its area's prefixes, which is how two areas could otherwise define the same key.
    // @ts-expect-error '"chrome.title"' does not exist in type 'Readonly<Record<`language.${string}`, Message>>'
    ({ "chrome.title": "x" }) satisfies Area<"language">,
    // b4: a key that does not exist. tsc says "Expected 2 arguments, but got 1": the key fails `Key`, so the
    // parameters are every key's at once. The line is refused, which is the property; the wording is tsc's.
    // @ts-expect-error Expected 2 arguments, but got 1
    t("brand.nmae"),
    // b5: a missing parameter.
    // @ts-expect-error '{ screen: string; }' is not assignable to parameter of type 'Params<"{screen} · {brand}">'
    t("title.route", { screen: "Outbox" }),
    // b6: a misspelt parameter.
    // @ts-expect-error Object literal may only specify known properties, but 'brnd' does not exist
    t("title.route", { screen: "Outbox", brand: "Mailda", brnd: "Mailda" }),
    // b7: a count passed as a string.
    // @ts-expect-error Type 'string' is not assignable to type 'number'
    ({ n: "3" }) satisfies Params<{ one: "{n} message"; other: "{n} messages" }>,
    // b8: a literal where the interface's own words go.
    // @ts-expect-error Type 'string' is not assignable to type 'Text'
    ((): Text => "Save")(),
    // b9: words glued to a translation, which no translation can reorder.
    // @ts-expect-error Type 'string' is not assignable to type 'Text'
    ((): Text => t("brand.name") + " anyway")(),
    // b10: a wire token nobody narrowed: `route.${string}` is not a key (refused as b4 is).
    // @ts-expect-error Expected 2 arguments, but got 1
    t(`route.${wire}`),
    // b11: a plural where the source has a string.
    // @ts-expect-error Type '{ other: string; }' is not assignable to type 'string'
    ((): Twin<{ readonly a: "x" }> => ({ a: { other: "y" } }))(),
  ];
}

describe("the catalog's types", () => {
  it("are checked by `pnpm typecheck`; at runtime the right call is simply words", () => {
    expect(typeof refused).toBe("function");
    expect(t("title.route", { screen: "Outbox", brand: t("brand.name") })).toBe("Outbox · Mailda");
  });
});
