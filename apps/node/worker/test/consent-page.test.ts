import { SELF, env } from "cloudflare:test";
import { createSystemCtx } from "@mailda/runtime";
import { beforeEach, describe, expect, it } from "vitest";

import { beginAuthorization, registerClient } from "../src/provider/cloudflare-grant.ts";

/**
 * The last step of connecting a Node, seen by the person who took it.
 *
 * ## What this route showed before
 *
 * `/oauth/cloudflare/callback` is where Cloudflare sends the operator's browser after they agree. It is, by
 * construction, reached by a human looking at a screen — and it answered with
 * `{"consent":{"ok":true,"error":null,…}}`. So somebody who had been reading English through the whole of
 * setup arrived at raw JSON, with no statement of what had happened and no way back other than the browser's
 * own history.
 *
 * That is the same defect as the nineteen provider routes with no screen, at the one point in the flow where
 * a person is definitely present.
 *
 * ## Why content negotiation rather than a second path
 *
 * Cloudflare is given *one* redirect URI, registered on the client in its dashboard. A second path would
 * have to be registered too, and an operator picking the wrong one gets a refusal from Cloudflare naming a
 * URI mismatch — a failure with nothing on this Node to explain it. `Accept` costs nothing and keeps
 * `mailda provider` parsing exactly what it parsed.
 *
 * ## The escaping is not hygiene, it is this route's one untrusted input
 *
 * `error_description` is a **query parameter**. Anybody who can get somebody to open a link controls it, and
 * it is rendered as prose on a page this Node serves from its own origin — on the one route with no session
 * check, because the state nonce is what guards it instead. So the assertion below is about markup surviving
 * into the document, not about tidiness.
 */

const testEnv = env as unknown as Env;
const ORG = "org_consent_page";
const ADMIN = "usr_consent_page_admin";
const ORIGIN = "https://node.example.test";

beforeEach(async () => {
  for (const table of ["provider_binding", "provider_authorizations", "node_claim", "audit_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run().catch(() => undefined);
  }
  const at = new Date(createSystemCtx().now()).toISOString();
  await testEnv.CATALOG.prepare(
    "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('claim','x',?,?)",
  ).bind(at, ORG).run();
});

/**
 * A real state, because an unissued one never reaches the page.
 *
 * A callback carrying a state this Node did not issue is refused before any outcome exists — correctly, that
 * is what the nonce is for — so a fixture that skipped this would be testing the refusal and calling it the
 * page. Each test gets its own: the state is consumed by the first callback that presents it.
 */
async function issuedState(): Promise<string> {
  const ctx = createSystemCtx();
  await registerClient(testEnv, ctx, ORG, ADMIN, {
    clientId: "cf-page-client",
    clientSecret: "the-page-secret",
    redirectUri: `${ORIGIN}/oauth/cloudflare/callback`,
  });
  const begun = await beginAuthorization(testEnv, ctx, ADMIN, ["account-settings.read"]);
  return begun.state;
}

/** The callback as a browser sends it: `Accept` naming HTML, which is what a redirect produces. */
function asBrowser(query: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/oauth/cloudflare/callback${query}`, {
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  });
}

describe("what Cloudflare's redirect lands a person on", () => {
  it("answers a browser with a page that says what happened, not with JSON", async () => {
    const response = await asBrowser(`?state=${await issuedState()}&error=access_denied`);

    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("<!doctype html>");
    // The sentence, not the shape. A page that rendered `ok: false` would be JSON with tags around it.
    expect(body).toContain("Cloudflare did not grant this Node access.");
    // And a way back, because the operator's setup screen is in a different tab or a different browser.
    expect(body).toContain('href="/setup"');
  });

  it("keeps answering JSON to everything that is not a browser", async () => {
    /*
     * `mailda provider` and the contract suite parse this. The negotiation must not quietly become "HTML for
     * everyone", which would break the CLI at the one step it cannot retry — the state is spent by then.
     */
    const response = await SELF.fetch(
      `${ORIGIN}/oauth/cloudflare/callback?state=${await issuedState()}&error=access_denied`,
    );

    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json() as { consent: { ok: boolean; error: string } };
    expect(body.consent.ok).toBe(false);
    expect(body.consent.error).toBe("access_denied");
  });

  it("escapes the description, which is a query parameter and therefore anybody's text", async () => {
    const markup = "<img src=x onerror=alert(1)>";
    const response = await asBrowser(
      `?state=${await issuedState()}&error=access_denied`
      + `&error_description=${encodeURIComponent(markup)}`,
    );
    const body = await response.text();

    // The text is shown — dropping it would lose Cloudflare's own reason, which is the point of showing it.
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // And it is not markup. Asserting on the raw substring rather than on the escaped form, because the
    // escaped form appearing does not prove the raw form does not appear somewhere else on the page.
    expect(body).not.toContain(markup);
  });

  it("refuses a callback carrying no state, in either shape", async () => {
    /*
     * The state nonce is what stands in for a session here. A callback without one is not a callback this
     * Node started, and the HTML path must not turn that into a reassuring page — which is what would happen
     * if the branch were placed after a generic 200.
     */
    const response = await asBrowser("");
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("E_PROVIDER_NO_STATE");
  });
});
