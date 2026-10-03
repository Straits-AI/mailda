import { env } from "cloudflare:test";
import { createSystemCtx } from "@mailda/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addDestination } from "../src/provider/destinations.ts";
import { holdToken } from "./support/provider-token.ts";

/**
 * Registering a destination address (ADR 47). Cloudflare mails the address a link; this Node records that it asked,
 * with Cloudflare's id and never the address, and a refusal names the permission it needs (AGENTS.md §3).
 */

const testEnv = env as unknown as Env;
const ORG = "org_destinations";
const ADMIN = "usr_destinations_admin";
const ACCOUNT = "1e0170aaabc90ecf5f466128d1f0466a";

const calls: Array<{ method: string; path: string }> = [];
function cloudflare(post: "ok" | "refuse") {
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, path: new URL(String(url)).pathname });
    if (method === "GET") return Response.json({ success: true, result: [{ email: "known@example.test", verified: null }] });
    return post === "ok"
      ? Response.json({ success: true, result: { id: "dest_42", email: "new@example.test", verified: null } })
      : Response.json({ success: false, errors: [{ code: 10000, message: "fixture: refused for the test" }] }, { status: 403 });
  });
}

const trail = async () => (await testEnv.CATALOG.prepare(
  "SELECT outcome, subject, detail FROM audit_entries WHERE org_id = ? AND action = 'provider.destination_added' ORDER BY seq",
).bind(ORG).all<{ outcome: string; subject: string; detail: string }>()).results;

beforeEach(async () => {
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("DELETE FROM provider_token"),
    testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG),
  ]);
  await holdToken(testEnv, ACCOUNT, Date.now());
});
afterEach(() => vi.unstubAllGlobals());

describe("registering a destination address", () => {
  it("asks Cloudflare once, says it waits for its link, and records Cloudflare's id, never the address", async () => {
    cloudflare("ok");
    expect(await addDestination(testEnv, createSystemCtx(), ORG, ADMIN, "new@example.test"))
      .toEqual({ email: "new@example.test", state: "waiting", added: true });
    expect(calls.filter((one) => one.method === "POST")).toHaveLength(1);
    const [entry] = await trail();
    expect(entry).toMatchObject({ outcome: "ok", subject: "dest_42" });
    expect(entry!.detail).not.toContain("@");
  });

  it("sends nothing for an address already listed, so no second link is mailed", async () => {
    cloudflare("ok");
    expect(await addDestination(testEnv, createSystemCtx(), ORG, ADMIN, "Known@Example.test"))
      .toEqual({ email: "Known@Example.test", state: "waiting", added: false });
    expect(calls.filter((one) => one.method === "POST")).toEqual([]);
  });

  it("names the permission when Cloudflare refuses, with its words, and records the refusal without the address", async () => {
    cloudflare("refuse");
    await expect(addDestination(testEnv, createSystemCtx(), ORG, ADMIN, "new@example.test"))
      .rejects.toThrow(/E_DESTINATION_NOT_ADDED[\s\S]*fixture: refused for the test[\s\S]*Email Routing Addresses: Edit/);
    const [entry] = await trail();
    expect(entry!.outcome).toBe("refused");
    expect(entry!.detail).not.toContain("new@example.test");
  });

  it("refuses something that is not an address before asking anybody", async () => {
    cloudflare("ok");
    await expect(addDestination(testEnv, createSystemCtx(), ORG, ADMIN, "not an address"))
      .rejects.toThrow(/E_DESTINATION_ADDRESS_INVALID/);
    expect(calls).toEqual([]);
  });
});
