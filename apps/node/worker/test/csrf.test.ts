import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * A state-changing request has to come from this Node (#96).
 *
 * ## The hole this closes, which `SameSite=Lax` did not
 *
 * `session.ts` claimed Lax *"makes the state-changing endpoints CSRF-safe without a separate token"*. Lax
 * does withhold cookies from cross-site POST; the conclusion does not follow, because **same-site is not
 * same-origin**. Same-site is scheme plus registrable domain, so every host under the customer's apex sits
 * inside Lax's protection — on a product whose premise is running in the customer's own account, where a
 * marketing site, a Pages preview and a forgotten CNAME are the normal furniture.
 *
 * So the case that matters most here is `Sec-Fetch-Site: same-site`, and it is the one a reader would not
 * expect to be refused. Every other assertion in this file is ordinary defence in depth.
 *
 * ## Driven over the real routes, unauthenticated
 *
 * No session, no fixture. The guard runs before the route and before authentication, so what distinguishes
 * a refusal from a pass is the **status**: `403` is this check, `401` is the route deciding it needed a
 * session. That makes each assertion unambiguous — a 401 means the guard let it through, which is exactly
 * what a mutation that removes the guard produces.
 */

const ORIGIN = "https://node";

/** A mutation with whatever headers a test wants to claim it came with. */
async function mutate(headers: Record<string, string>): Promise<number> {
  const response = await SELF.fetch(`${ORIGIN}/api/policies`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name: "n", outcome: "deny" }),
  });
  return response.status;
}

describe("a sibling subdomain cannot act as the person signed in here", () => {
  it("refuses same-site, which is the case SameSite=Lax lets through", async () => {
    /*
     * **The whole point of the file.** `blog.example.com` is same-site to `mail.example.com`, so Lax sends
     * this Node's cookies there and a script on the sibling can issue writes. Nothing in the cookie
     * attributes distinguishes it; `Sec-Fetch-Site` does.
     */
    expect(await mutate({ "sec-fetch-site": "same-site" })).toBe(403);
  });

  it("refuses cross-site", async () => {
    expect(await mutate({ "sec-fetch-site": "cross-site" })).toBe(403);
  });

  it("says which case it refused, and why a same-site request is not a safe one", async () => {
    // The refusal has to be readable by whoever is debugging it, and "same-site was refused" is surprising
    // enough that the message has to carry the reason rather than the rule.
    const response = await SELF.fetch(`${ORIGIN}/api/policies`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-site" },
      body: JSON.stringify({ name: "n", outcome: "deny" }),
    });
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("E_CROSS_SITE_REQUEST");
    expect(body.message).toMatch(/registrable domain/);
    expect(body.message).toMatch(/sibling/);
  });

  it("allows same-origin and a direct navigation", async () => {
    /*
     * The other side, and it is what stops the guard being "refuse everything". `none` is a typed URL or a
     * bookmark — nothing else initiated it, so it cannot be a forgery. Both reach the route and are refused
     * for want of a session, which is the 401 below.
     */
    expect(await mutate({ "sec-fetch-site": "same-origin" })).toBe(401);
    expect(await mutate({ "sec-fetch-site": "none" })).toBe(401);
  });
});

describe("an Origin that is not this Node's is refused, exactly", () => {
  it("refuses a different host", async () => {
    expect(await mutate({ origin: "https://evil.example" })).toBe(403);
  });

  it("refuses a sibling subdomain, which is the comparison SameSite cannot make", async () => {
    // Compared exactly rather than by registrable domain. This is the same hole as the first describe,
    // caught in a browser that sends no Fetch metadata.
    expect(await mutate({ origin: "https://blog.node" })).toBe(403);
  });

  it("refuses a scheme change on the same host", async () => {
    // An origin is scheme + host + port. `http://node` is not `https://node`, and a downgrade is exactly
    // where a network attacker sits.
    expect(await mutate({ origin: "http://node" })).toBe(403);
  });

  it("allows this Node's own origin", async () => {
    expect(await mutate({ origin: ORIGIN })).toBe(401);
  });
});

describe("a form encoding is refused, because nothing here sends one", () => {
  for (const type of ["application/x-www-form-urlencoded", "multipart/form-data"]) {
    it(`refuses ${type}`, async () => {
      const response = await SELF.fetch(`${ORIGIN}/api/policies`, {
        method: "POST",
        headers: { "content-type": type },
        body: "name=n&outcome=deny",
      });
      expect(response.status).toBe(403);
    });
  }

  it("allows text/plain, which is deliberate and is the fetch default", async () => {
    /*
     * The third CORS-safelisted type is **not** refused, and the reasoning is in `csrf.ts`: `fetch` sets it
     * by default for a string body, so refusing it taxes every programmatic caller for a vector the two
     * checks above already cover twice. Asserted so the omission is a decision rather than something a
     * later reader "completes".
     */
    const response = await SELF.fetch(`${ORIGIN}/api/policies`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "n", outcome: "deny" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("what the guard deliberately does not refuse", () => {
  it("lets a request with no browser headers through, because CSRF needs a browser", async () => {
    /*
     * This looks like the bypass and is not. A browser **always** sends `Origin` on a state-changing request,
     * and CSRF is by definition somebody else's user agent attaching somebody else's cookies — so a request
     * with neither header came from something with no cookie jar: curl, the generated SDK, `mailda`, or this
     * Worker re-entering itself for `handleMcp`.
     *
     * Refusing them would break every non-browser surface ADR 12 requires parity for, and would buy nothing:
     * a caller who can omit a header can set one correctly. It is also why the decided answer here is not a
     * CSRF token — the exemption a token needs for those surfaces is reachable by omitting a header.
     */
    expect(await mutate({})).toBe(401);
  });

  it("does not guard reads", async () => {
    /*
     * A GET changes nothing, and every read authorizes in SQL against a live relationship (ADR 11) — so a
     * cross-site read returns what that reader may see anyway. Guarding reads would also refuse a browser
     * following a link to this Node.
     */
    const response = await SELF.fetch(`${ORIGIN}/api/messages`, {
      headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
    });
    expect(response.status).toBe(401);
  });

  it("guards every method that changes something, not only POST", async () => {
    // PUT and DELETE are as forgeable as POST from a fetch, and a guard that only knew about POST would be
    // the kind of partial coverage that reads as complete.
    for (const method of ["PUT", "DELETE"]) {
      const response = await SELF.fetch(`${ORIGIN}/api/transport`, {
        method,
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: JSON.stringify({}),
      });
      expect(response.status, `${method} was not guarded`).toBe(403);
    }
  });
});
