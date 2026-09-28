import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withoutComments } from "../without-comments.ts";

/**
 * The claim handler reaches the recovery-codes screen instead of routing past it (#134).
 *
 * ## The defect in one line
 *
 * `src/client/app.client.js` did `adopt(); startSessionTicker(); return route();` — the response was checked
 * for `ok` and its body never touched. The claim returns ADR 29's ten codes in plaintext, and the contract
 * calls it *"the only response in this contract that carries them"*, because the Node keeps a hash to
 * recognise one and an escrow only the code's plaintext opens. So ten codes were minted, hashed, escrowed, and
 * dropped by the one interface that ever received them.
 *
 * Measured during #92's restore drill: a full catalog and every object restored into a different Cloudflare
 * account, the destination holding all ten hashes, and it refused —
 * `signing_key: E_EVIDENCE_AUTH_FAILED` — because the vault needs a code and none had ever been obtainable.
 *
 * ## Why this is lexical, and why it is in the node suite
 *
 * The screen itself is driven for real by `test/client/recovery-codes-screen.test.ts` under happy-dom. What is
 * left is narrow and exact — that the handler consults the body before it routes — and driving a whole claim
 * submission through a stubbed `fetch` to establish it would test the stub more than the code. This file reads
 * source, so it belongs where a filesystem exists.
 */
const CLIENT = join(import.meta.dirname, "../../src/client/app.client.js");

describe("the claim handler", () => {
  /*
   * Comments stripped — and this test is the eighth reason the helper exists. The assertion below searched for
   * `return route()` and found it inside a comment saying *"this used to be `return route()`"*.
   */
  const source = withoutComments(CLIENT);
  const handler = source.slice(source.indexOf('const response = await fetch("/api/claim"'));

  it("is found, so nothing below passes by reading an empty string", () => {
    expect(handler.length).toBeGreaterThan(200);
  });

  it("reads the claim response's body before it routes anywhere", () => {
    const readsBody = handler.indexOf("response.json()");
    const routes = handler.indexOf("return route()");
    expect(readsBody, "the claim response's body is never read").toBeGreaterThan(-1);
    expect(routes, "the handler never routes at all — has it changed shape?").toBeGreaterThan(-1);
    expect(readsBody).toBeLessThan(routes);
  });

  it("shows the codes when there are any, and routes only when there are none", () => {
    expect(handler).toContain("renderRecoveryCodes(claimed.recoveryCodes)");
    /*
     * The guard matters as much as the call. A Node claimed before the codes shipped returns none, and a
     * screen showing an empty list would be worse than going straight to the inbox — it would teach an
     * operator that this Node has no recovery codes, which is true and not the same as saying so.
     */
    expect(handler).toContain("Array.isArray(claimed.recoveryCodes)");
    expect(handler).toContain("claimed.recoveryCodes.length > 0");
  });
});

/**
 * `mailda install` claims in the terminal by default, and says there what the web claim form says under its
 * email field (28 September 2026): the email signs you in, and mail goes out from a mailbox's address. A founder
 * claimed as `admin@` and found replies going out as `hello@`, and the terminal is where most claims happen.
 */
describe("mailda install's claim", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("says the email signs you in and mail goes out from a mailbox's address, before it claims", async () => {
    // By computed path, typed here, as `closing-report.test.ts` imports `deploy.mjs`: `install.mjs` has no declaration.
    const { claim } = await import(join(import.meta.dirname, "../../../../../packages/cli/src/verbs/install.mjs")) as {
      claim: (origin: string, secret: string, yes: boolean) => Promise<{ email: string }>;
    };
    const order: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { order.push(String(chunk)); return true; });
    vi.stubGlobal("fetch", async (url: string) => {
      order.push(`fetch ${new URL(url).pathname}`);
      return Response.json({ recoveryCodes: [] });
    });
    vi.stubEnv("MAILDA_EMAIL", "admin@whymelabs.com");
    vi.stubEnv("MAILDA_PASSWORD", "a long enough password");

    const claimed = await claim("https://node.test", "secret", true);

    expect(claimed.email).toBe("admin@whymelabs.com");
    const said = order.findIndex((line) => line.includes("You sign in with this email. Mail goes out from a mailbox's address, which setup chooses."));
    expect(said, "the claim never said what its email is for").toBeGreaterThan(-1);
    expect(said).toBeLessThan(order.indexOf("fetch /api/claim"));
  });
});
