import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publicJwks } from "../src/auth/keys.ts";
import { handoverManifest } from "../src/provider/handover.ts";

/**
 * The handover manifest, and what its signature is worth (#165 L4).
 *
 * ## What these tests are for
 *
 * #165 asks for a manifest *"verifiable by the client without Mailda"*. Three properties carry that, and all
 * three are about honesty rather than cryptography:
 *
 * 1. **It verifies against the Node's published JWKS**, using a key fetched the way a stranger would fetch
 *    it. Not against a key the manifest supplies — one that shipped its own verification key would be one a
 *    forger could mint.
 * 2. **The signature covers the manifest**, so a changed byte fails. Asserted by changing one.
 * 3. **The ceremonies are derived from measurements**, not typed out. A hand-written list decays silently:
 *    Cloudflare shipped the sending-subdomain API between August and September, and a list written in August
 *    would still be telling a client to open the dashboard for it.
 */

const testEnv = env as unknown as Env;
const ORG = "org_handover";
const AT = Date.parse("2026-09-14T12:00:00.000Z");
const ORIGIN = "https://node.example.test";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

beforeEach(async () => {
  await testEnv.CATALOG.prepare("DELETE FROM provider_token").run();
});
afterEach(() => vi.restoreAllMocks());

/** Verify exactly as a client would: the key comes from the JWKS, chosen by the `kid` in the header. */
async function verifies(jws: string): Promise<boolean> {
  const [header, payload, signature] = jws.split(".");
  const head = JSON.parse(Buffer.from(header!, "base64url").toString("utf8")) as { kid: string };
  const { keys } = await publicJwks(testEnv, AT);
  const jwk = keys.find((one) => (one as { kid?: string }).kid === head.kid);
  if (jwk === undefined) return false;

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
  );
  return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, key,
    Buffer.from(signature!, "base64url"),
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

const payloadOf = (jws: string) =>
  JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8"));

describe("the handover manifest", () => {
  it("verifies against the JWKS it names, with a key it does not carry", async () => {
    const { jws } = await handoverManifest(testEnv, atTime(AT), ORG, ORIGIN);
    expect(await verifies(jws)).toBe(true);

    const manifest = payloadOf(jws);
    expect(manifest.verification.jwks).toBe(`${ORIGIN}/.well-known/jwks.json`);
    /*
     * The manifest must not contain anything usable as a verification key. A client that could verify from
     * the file alone would be verifying that the file agrees with itself.
     */
    expect(JSON.stringify(manifest)).not.toContain('"crv"');
    expect(JSON.stringify(manifest)).not.toContain('"x"');
  });

  it("fails when one byte of the manifest changes", async () => {
    const { jws } = await handoverManifest(testEnv, atTime(AT), ORG, ORIGIN);
    const [header, payload, signature] = jws.split(".");

    const tampered = payloadOf(jws);
    tampered.node = "https://not-this-node.example.test";
    const forged = Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url");

    expect(await verifies(`${header}.${forged}.${signature}`)).toBe(false);
    // And the original still does, so the check above is not failing for an unrelated reason.
    expect(await verifies(`${header}.${payload}.${signature}`)).toBe(true);
  });

  it("says what the signature does not prove, in the manifest rather than in a document", async () => {
    /*
     * The honest half. A signed artifact invites more confidence than it earns, and the caveat has to travel
     * with it — a reader who has the file may never see this repository.
     */
    const manifest = payloadOf((await handoverManifest(testEnv, atTime(AT), ORG, ORIGIN)).jws);
    expect(manifest.verification.doesNotProve).toContain("reported truthfully");
    expect(manifest.verification.doesNotProve).toContain("unreachable");
  });

  it("derives each ceremony from a measurement a client can check", async () => {
    const manifest = payloadOf((await handoverManifest(testEnv, atTime(AT), ORG, ORIGIN)).jws);
    expect(manifest.ceremonies.length).toBeGreaterThan(3);

    for (const one of manifest.ceremonies) {
      expect(one.evidence.receipt, one.what).toMatch(/^docs\/receipts\//);
      expect(one.evidence.measuredOn, one.what).toMatch(/^\d{4}-\d{2}-\d{2}$|^unrecorded$/);
    }

    // The one that is a live measurement rather than a design property, named so this cannot pass vacuously.
    const routing = manifest.ceremonies.find((one: { what: string }) =>
      one.what.includes("Email Routing"));
    expect(routing.evidence.value).toBe("routing.subdomain_dashboard_only");
    expect(routing.evidence.is).toBe(BUDGETS["routing.subdomain_dashboard_only"]);
  });

  it("stops naming a ceremony the moment the measurement says it is automatable", async () => {
    /*
     * **The property that makes the list worth having.** Cloudflare shipped the sending-subdomain API
     * between August and September; a typed-out list would still be telling a client to open the dashboard.
     * The entry for it is still in the source, conditioned on `sending.subdomain_api_available === 0`, and
     * is absent from the output because that value is now 1. So this asserts the suppressing direction
     * directly rather than by proxy: removing the condition makes the entry reappear and fails here.
     */
    const manifest = payloadOf((await handoverManifest(testEnv, atTime(AT), ORG, ORIGIN)).jws);
    const named = manifest.ceremonies.map((one: { what: string }) => one.what).join(" ");

    // Present, because un-onboarding is measured not to clean up after itself.
    expect(BUDGETS["sending.unonboard_removes_every_created_record"]).toBe(0);
    expect(named).toContain("_dmarc");

    /*
     * Absent, because onboarding a **sending** subdomain has an API and this Node uses it. No entry claims
     * otherwise — which is exactly what a hand-written list would have got wrong.
     */
    expect(BUDGETS["sending.subdomain_api_available"]).toBe(1);
    expect(named).not.toContain("Onboarding a sending subdomain in the Cloudflare dashboard");
  });

  it("carries the ownership facts, sources and all", async () => {
    const manifest = payloadOf((await handoverManifest(testEnv, atTime(AT), ORG, ORIGIN)).jws);
    expect(manifest.ownership.length).toBeGreaterThan(0);
    // No grant on this fixture, so nothing may claim to be the provider's.
    expect(manifest.ownership.every((one: { source: string }) => one.source !== "provider")).toBe(true);
  });
});
