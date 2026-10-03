import { afterEach, describe, expect, it, vi } from "vitest";

const { verifiedDestinationLines, verifiedDestinationsStep } = await import("../../../../../packages/cli/src/verbs/provision.mjs");

/**
 * `mailda setup` and `mailda upgrade` read which of the Node's recipients are verified destinations of the
 * account (28 September 2026): Cloudflare published no delivery event for mail to one in the case measured, and
 * without the read the Outbox and doctor wait for it. What would print plausibly and be wrong: a failed read
 * printed as a count, which turns could not read into none verified; the operator's credential not sent, so the
 * Node answers with its own or refuses; a refusal that ends the run after the deploy already happened.
 *
 * `wranglerTokenRead` is run against a stub wrangler in `wrangler-config.test.ts` (the token returned, never
 * printed); the live `mailda setup` run the receipts are owed reaches it through `wranglerToken`. `mailda upgrade`'s own branch (the gate on `state.provisioned`, the
 * `token ??=` reuse, and the one line printed without a login) is not tested anywhere.
 */

const said = (lines: string[]) => lines.join(" ").replace(/\s+/g, " ");
const read = (overrides: Record<string, unknown> = {}) => ({
  accountId: "acc", readAt: "2026-09-28T05:00:00.000Z", attemptedAt: "2026-09-28T05:00:00.000Z",
  error: null as string | null, recipients: 2, verified: 1 as number | null,
  listed: null as { verified: number; waiting: number } | null, addresses: null as Array<{ email: string; state: "verified" | "waiting" }> | null, ...overrides,
});

describe("verifiedDestinationLines", () => {
  it("says could not read for a failed read, and never counts it", () => {
    const never = said(verifiedDestinationLines(read({ error: "fixture: refused for the test", readAt: null, verified: null })));
    expect(never).toContain("could not read: fixture: refused for the test; until a read succeeds, those recipients show as unobserved");
    expect(never).not.toContain("nothing to compare");
    expect(never).not.toContain(" of 2 ");

    const earlier = said(verifiedDestinationLines(read({ error: "fixture: refused for the test", recipients: 0 })));
    expect(earlier).toContain("the read of 2026-09-28T05:00:00.000Z stands");
    expect(earlier).not.toContain("nothing to compare");
  });

  it("says there was nothing to compare on a Node that has sent nothing", () => {
    expect(said(verifiedDestinationLines(read({ recipients: 0, verified: 0 }))))
      .toContain("nothing to compare: this Node has handed mail to nobody yet (read 2026-09-28T05:00:00.000Z, account acc)");
  });

  it("gives the count, the read and the account", () => {
    const lines = verifiedDestinationLines(read());
    expect(said(lines)).toBe(
      "verified destinations 1 of 2 address(es) this Node has handed mail to (read 2026-09-28T05:00:00.000Z, "
        + "account acc); no outcome is reported for verified destinations, in the one case measured "
        + "(docs/receipts/email-sending-events.md)",
    );
    expect(lines[0]!.startsWith("verified destinations  1 of 2")).toBe(true);
  });
});

describe("verifiedDestinationsStep", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function capture(answer: () => Response) {
    const asked: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      asked.push({ method: init?.method ?? "GET", path: new URL(url).pathname, headers: init?.headers as Record<string, string> });
      return answer();
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    return { asked, out };
  }
  const input = { origin: "https://node.test", cookie: "session=c", accountId: "acc", token: "tok" };

  it("posts the route with the cookie and the operator's credential, and prints what was recorded", async () => {
    const { asked, out } = capture(() => Response.json({ destinations: read() }));
    await verifiedDestinationsStep(input);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      method: "POST", path: "/api/provider/verified-destinations",
      headers: { cookie: "session=c", "x-cloudflare-token": "tok", "x-cloudflare-account": "acc" },
    });
    expect(out.join("")).toContain("   verified destinations  1 of 2 address(es)");
  });

  it("prints a refusal whole and resolves, so the run goes on", async () => {
    // A Node older than the route answers 404; this one says why in its own words.
    const { out } = capture(() => Response.json({ error: "not_found" }, { status: 404 }));
    // `fail` exits; here exiting throws instead, so a refusal that ends the run rejects rather than resolving.
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(verifiedDestinationsStep(input)).resolves.toBeUndefined();
    expect(out.join("")).toContain("verified destinations  not read:");
    expect(out.join("")).toContain("     POST /api/provider/verified-destinations answered 404:\n     {\"error\":\"not_found\"}");
  });

  it("prints an unreachable Node and resolves", async () => {
    const { out } = capture(() => { throw new TypeError("fetch failed"); });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(verifiedDestinationsStep(input)).resolves.toBeUndefined();
    expect(out.join("")).toContain("verified destinations  not read:");
    expect(out.join("")).toContain("could not reach https://node.test: fetch failed");
  });

  it("prints an answer that broke off after its headers and resolves", async () => {
    // The connection reset once the status line had arrived: fetch resolved, reading the body rejects.
    const { out } = capture(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("{\"destin")); controller.error(new TypeError("terminated")); },
    }), { status: 200 }));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(verifiedDestinationsStep(input)).resolves.toBeUndefined();
    expect(out.join("")).toContain("verified destinations  not read:");
    expect(out.join("")).toContain("answered 200 and the answer broke off: terminated");
  });

  it("prints a 200 whose destinations are not the route's and resolves", async () => {
    // Printing it as a read would say "could not read: undefined", or throw on null.
    const { out } = capture(() => Response.json({ destinations: null }));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(verifiedDestinationsStep(input)).resolves.toBeUndefined();
    expect(out.join("")).toContain("answered 200:\n     {\"destinations\":null}");

    const { out: empty } = capture(() => Response.json({ destinations: {} }));
    await expect(verifiedDestinationsStep(input)).resolves.toBeUndefined();
    expect(empty.join("")).toContain("answered 200:\n     {\"destinations\":{}}");
    expect(empty.join("")).not.toContain("could not read");
  });

  it("prints a 200 that is not the route's JSON and resolves", async () => {
    // A proxy's error page, say: answered 200 and is not an answer.
    const { out } = capture(() => new Response("<html>gateway</html>", { status: 200 }));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(verifiedDestinationsStep(input)).resolves.toBeUndefined();
    expect(out.join("")).toContain("verified destinations  not read:");
    expect(out.join("")).toContain("answered 200:\n     <html>gateway</html>");
  });
});
