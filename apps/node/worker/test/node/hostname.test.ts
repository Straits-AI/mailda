import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { deriveConfig, hostnameIn } = await import("../../../../../packages/cli/src/deploy-parse.mjs");

/**
 * A hostname of the operator's own, as a custom domain in the derived config (25 September 2026). Measured on
 * a scratch Worker: a first `wrangler deploy` attaches it, the canary path keeps it, `wrangler triggers
 * deploy` adds one to an existing Worker. What is tested here is the text: the route lands inside the
 * object, the rest of the derivation is untouched, and the hostname reads back.
 */
describe("a hostname in the derived config", () => {
  const real = readFileSync(new URL("../../wrangler.jsonc", import.meta.url).pathname, "utf8");

  it("adds one custom-domain route inside the object and reads it back", () => {
    const derived = deriveConfig(real, "mailda-support", "mail.example.test");
    expect(hostnameIn(derived)).toBe("mail.example.test");
    expect(derived.trimEnd().endsWith("}")).toBe(true);
    expect((derived.match(/"custom_domain": true/g) ?? []).length).toBe(1);
    // The name derivation is unchanged by the hostname.
    expect(derived).toContain('"name": "mailda-support"');
  });

  it("changes nothing without a hostname, and the base config carries none", () => {
    expect(deriveConfig(real, "mailda-support")).toBe(deriveConfig(real, "mailda-support", null));
    expect(hostnameIn(real)).toBeNull();
  });
});
