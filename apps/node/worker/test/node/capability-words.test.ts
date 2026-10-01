import { describe, expect, it } from "vitest";

import { CAPABILITIES, CAPABILITY_IDS } from "@mailda/contract/capability";

import { CATALOGS } from "../../src/i18n/catalog.ts";

/**
 * A capability's words on the Agents screen are the catalog's `capability.<id>` (ADR 46, layer 3), and the Node
 * still serves its own `says` to the API, the CLI and the Skill. Two copies of one sentence, so this holds them
 * equal: the English the screen shows is the Node's, byte for byte, and a `says` edited in the contract without
 * the catalog (or the reverse) fails here instead of reading differently on the screen and on the wire.
 */
describe("a capability's words", () => {
  it("lists every capability id exactly once in CAPABILITY_IDS", () => {
    expect([...CAPABILITY_IDS].sort()).toEqual(CAPABILITIES.map((one) => one.id).sort());
    expect(new Set(CAPABILITY_IDS).size).toBe(CAPABILITY_IDS.length);
  });

  it("are the Node's own says, in English, for every capability", () => {
    const en: Readonly<Record<string, unknown>> = CATALOGS.en.app;
    const differing = CAPABILITIES
      .filter((one) => en[`capability.${one.id}`] !== one.says)
      .map((one) => one.id);
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    expect(differing).toEqual([]);
  });
});
