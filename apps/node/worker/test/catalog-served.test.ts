import { describe, expect, it } from "vitest";

import { CATALOGS } from "../src/i18n/catalog.ts";
import { LOCALES } from "../src/i18n/locales.ts";
import { messagePaths } from "../src/i18n/served.ts";
import { clientAsset } from "../src/ui.ts";

/**
 * What the Worker serves for the interface's words (ADR 46) is the catalog, byte for byte, and the pre-sign-in
 * module carries none of the signed-in words.
 *
 * In the workerd suite because `ui.ts` imports the built modules as text, which only wrangler's rules resolve.
 */

/** The served module's default export: `export default {…};` with `<` escaped, which JSON reads as it is. */
function exported(module: string): unknown {
  const match = /^export default (\{[\s\S]*\});\n$/.exec(module);
  if (match === null) throw new Error(`not a default-export module: ${module.slice(0, 60)}`);
  return JSON.parse(match[1]!);
}

describe("each locale's served table", () => {
  it.each(LOCALES.map(({ tag }) => tag))("is the %s catalog's app words, at a URL naming its content, cached for good", async (tag) => {
    const response = clientAsset(messagePaths()[tag]);
    expect(response, `${messagePaths()[tag]} is not served`).not.toBeNull();
    expect(exported(await response!.text())).toEqual(CATALOGS[tag].app);
    expect(response!.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response!.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  /*
   * A tab that loaded `/app/locale.js` before a deploy still names the old tag when it signs in. A 404 there failed
   * the whole shell ("could not be loaded") for as long as the tab was open. The redirect is never cached, so the
   * old URL is never handed new words at its own address, and the current table stays immutable at its own.
   */
  it("redirects an old content tag of a known locale to the current table, uncached", () => {
    for (const { tag } of LOCALES) {
      const response = clientAsset(messagePaths()[tag].replace(/\.[0-9a-z]+\.js$/, ".0.js"));
      expect(response?.status).toBe(307);
      expect(response!.headers.get("location")).toBe(messagePaths()[tag]);
      expect(response!.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("answers no untagged table and no unknown locale", () => {
    expect(clientAsset("/app/messages/en.js")).toBeNull();
    expect(clientAsset("/app/messages/fr.0.js")).toBeNull();
    expect(clientAsset("/app/messages/constructor.0.js")).toBeNull();
  });
});

describe("the pre-sign-in module, /app/locale.js", () => {
  it("names the URLs the Worker serves, because the build and the Worker computed them from the same catalogs", async () => {
    const module = await clientAsset("/app/locale.js")!.text();
    for (const path of Object.values(messagePaths())) expect(module).toContain(JSON.stringify(path));
  });

  it("carries every locale's pre-sign-in words, in UTF-8 rather than escapes", async () => {
    const module = await clientAsset("/app/locale.js")!.text();
    for (const { tag } of LOCALES) {
      for (const words of Object.values(CATALOGS[tag].preauth)) expect(module).toContain(JSON.stringify(words));
    }
    expect(module).toContain("淼达");
  });

  it("carries none of the signed-in words, which a side effect in a catalog module would drag in", async () => {
    const module = await clientAsset("/app/locale.js")!.text();
    const keys = Object.keys(CATALOGS.en.app);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((key) => module.includes(JSON.stringify(key)))).toEqual([]);
  });
});
