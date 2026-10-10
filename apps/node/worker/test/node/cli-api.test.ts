import { ROUTES } from "@mailda/contract/routes";
import { methodNameFor } from "@mailda/contract/naming";
import { describe, expect, it } from "vitest";

const { exitCodeFor, methods, requestFor } = await import("../../../../../packages/cli/src/api-call.mjs");

/**
 * `mailda api` reaches every route the contract registers, by the SDK's method names (10 October 2026). Until
 * then the CLI was the operator's alone: no command read mail, drafted a reply or ran a Butler, and the Blueprint's
 * §19 families had no verb behind them.
 */
describe("mailda api builds requests from the contract", () => {
  it("offers every route, by the name the SDK and MCP give it", () => {
    expect(methods().map((one) => one.name).sort()).toEqual(ROUTES.map((spec) => methodNameFor(spec)).sort());
  });

  it("fills path parameters and passes only the query the route declares", () => {
    const call = requestFor("getMessagesByReceiptIdBody", ["--receiptId", "ir_1", "--url", "https://node.example"]);
    expect(call).toMatchObject({ usage: null, method: "GET", template: "/api/messages/:receiptId/body", params: { receiptId: "ir_1" } });
    expect(call.usage === null && call.query, "a path parameter or --url leaked into the query string").toEqual({});

    const listed = requestFor("getMessages", ["--q", "invoice", "--mailbox", "mbx_1"]);
    expect(listed.usage, "a declared query parameter was refused").toBeNull();
    expect(listed).toMatchObject({ query: { q: "invoice", mailbox: "mbx_1" } });
  });

  it("refuses before sending: an unknown method, an undeclared flag, a missing path parameter, a body on a GET", () => {
    expect(requestFor("getMail", []).usage).toMatch(/no method named getMail/);
    // The refusal names what the route does take, so the next attempt can be right.
    expect(requestFor("getMessages", ["--colour", "red"]).usage).toMatch(/takes no --colour\. It takes .*--mailbox/);
    expect(requestFor("getMessagesByReceiptIdBody", []).usage).toBe("getMessagesByReceiptIdBody needs --receiptId");
    expect(requestFor("getMessages", ["--body", "{}"]).usage).toMatch(/is a GET and takes no --body/);
    expect(requestFor("getMessages", ["--mailbox"]).usage).toMatch(/expected --<parameter> <value>/);
  });

  it("carries a body for a write, and marks a route that answers a file", () => {
    expect(requestFor("putDrafts", ["--body", "@draft.json"])).toMatchObject({ usage: null, method: "PUT", body: "@draft.json" });
    expect(requestFor("getMessagesByReceiptIdRaw", ["--receiptId", "ir_1", "--out", "m.eml"]))
      .toMatchObject({ binary: true, out: "m.eml" });
    expect(requestFor("getMessages", [])).toMatchObject({ usage: null, binary: false });
  });

  it("exits with the Blueprint's categories for what a status says for certain", () => {
    expect([200, 201, 204].map(exitCodeFor)).toEqual([0, 0, 0]);
    expect([401, 403, 404, 409, 412, 429].map(exitCodeFor)).toEqual([3, 4, 5, 6, 6, 8]);
    expect([400, 422, 500, 503].map(exitCodeFor)).toEqual([9, 9, 9, 9]);
  });
});
