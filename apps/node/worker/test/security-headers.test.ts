import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

import { EXPIRY_COOKIE } from "../src/auth/session.ts";
import { sanitizeHtml } from "../src/render/body.ts";
import { clientAsset, page } from "../src/ui.ts";
import worker from "../src/index.ts";

/**
 * The headers a browser is handed, on every path (#97).
 *
 * Before this, the Node sent **none of them**: no CSP, no `frame-ancestors`, no `nosniff`, no HSTS, no
 * `Referrer-Policy`. The gap was invisible because the reader's sandboxed iframe is a real defence and is
 * documented as one, so it read as the browser-security story rather than as one half of it. Every
 * governance control here is a button — approve, release, lift, grant — and a document any origin may frame
 * turns a button into a signature.
 *
 * ## Three paths, because they are three different pieces of code
 *
 * An API response, a client asset and the shell reach the browser through three different returns inside
 * `route`, and a header applied at any of them would have looked done. They are asserted separately so that
 * "applied in the one place every response passes through" is a tested claim rather than a design note.
 *
 * Then the two ways a request fails, because failures leave by different doors: a 404 is **returned** from
 * routing, a refusal is **thrown** and turned into a response in a `catch`. Both are asserted — the second
 * is what decides whether the wrapper goes around the routing call or around the handler, and the returns
 * inside that `catch` are the ones `noStore` had already been forgotten by.
 */

const testEnv = env as unknown as Env;

async function fetchPath(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://node.example${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * The policy off a real response, as a directive map.
 *
 * Parsed rather than string-matched, so a test says which directive it means and a reordering of the list
 * in `security-headers.ts` does not fail anything. Reading it from the response rather than from the
 * exported constant is deliberate: what matters is the bytes a browser receives.
 */
function policyOf(response: Response): Map<string, string[]> {
  const header = response.headers.get("content-security-policy");
  const directives = new Map<string, string[]>();
  for (const part of (header ?? "").split(";")) {
    const words = part.trim().split(/\s+/).filter((word) => word.length > 0);
    if (words.length > 0) directives.set(words[0]!, words.slice(1));
  }
  return directives;
}

/** The three surfaces, named as what they are rather than as paths. */
const SURFACES: ReadonlyArray<{ what: string; path: string; expect: string }> = [
  // Unauthenticated, so this answers 401 — which is the point: the headers do not depend on a session, and
  // the responses a caller sees *before* signing in are the ones an attacker sees too.
  { what: "an API response", path: "/api/mailboxes", expect: "application/json" },
  { what: "a client asset", path: "/app/app.js", expect: "text/javascript" },
  { what: "the shell", path: "/", expect: "text/html" },
];

describe("every response carries the browser policy", () => {
  for (const surface of SURFACES) {
    it(`sets all five headers on ${surface.what}`, async () => {
      const response = await fetchPath(surface.path);
      expect(response.headers.get("content-type"), surface.path).toContain(surface.expect);

      expect(policyOf(response).size, "no Content-Security-Policy at all").toBeGreaterThan(0);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("permissions-policy")).toContain("camera=()");
      expect(response.headers.get("strict-transport-security")).not.toBeNull();
    });
  }

  it("sets them on a request that fails, which is the return that gets forgotten", async () => {
    // A 404 travels the same wrapper as a 200. Before #97 the unhandled-500 return did not even carry
    // `no-store`, having been written after the three returns that did — which is the argument for a
    // wrapper around the whole handler rather than a call at each exit.
    const response = await fetchPath("/nonsense-that-no-route-serves");
    expect(response.status).toBe(404);
    expect(policyOf(response).size).toBeGreaterThan(0);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets them on a refusal that was thrown rather than returned", async () => {
    /*
     * The other exit, and the reason `fetch` wraps `answer` rather than wrapping `route`. A refusal here
     * travels as a `throw` (errors.ts) and is turned into a response inside a `catch`, so a policy applied
     * around the routing call alone would cover every success and miss every refusal — which is the half of
     * the traffic an attacker is most interested in provoking.
     *
     * `/api/invitations/redeem` is the probe because it is refusable without a session: it is how a person
     * with an invitation and no account gets one (#83), so an empty body reaches a real E_ refusal rather
     * than the 401 every other route answers first.
     */
    const response = await fetchPath("/api/invitations/redeem", { method: "POST", body: "{}" });
    expect(response.status).toBe(422);
    expect(policyOf(response).get("frame-ancestors")).toEqual(["'none'"]);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

/**
 * `no-store` on the exit that had forgotten it.
 *
 * This is the change's *second* claim and it shipped asserted by nothing. `noStore` moved out of the try
 * alongside `withSecurityHeaders`, on the stated grounds that the three error returns each had to remember
 * it and **the unhandled-500 return did not** — so the response to the worst thing that can happen to a
 * request was the one response a shared cache was free to keep. That is a good argument and a testable one,
 * and a relocation justified by a defect nobody demonstrates is the same shape as the defect: a claim with
 * nothing behind it.
 *
 * The 500 is reached with a `CATALOG` that throws rather than by dropping tables, which is how
 * `audit.test.ts` provokes the same class. It touches no storage, so it cannot leave this file's later tests
 * running against a schema that is not there.
 */
describe("the cache directive survives the exits, including the one nobody wrote it on", () => {
  const brokenCatalog = {
    ...testEnv,
    CATALOG: { prepare: () => { throw new Error("db gone"); } },
  } as unknown as Env;

  /**
   * `tolerateBackgroundFailure` settles the `waitUntil` work and swallows *its* error, deliberately.
   *
   * A request that dies on the catalog also schedules background work against the same broken catalog —
   * `trimLogs`, the sweeper — and `waitOnExecutionContext` re-throws whatever those threw. Two ways to get
   * that wrong, and the first version got both:
   *
   *   - letting it throw fails this test for a reason it is not testing (the response was already produced
   *     and already carried the right headers);
   *   - *not settling at all* leaves a rejected promise behind, which surfaces as an unhandled rejection and
   *     makes the whole suite exit non-zero while every test reports as passing. That is worse than a
   *     failure, because it fails somewhere else.
   *
   * So it is settled and the error is caught at exactly one call site, where the broken catalog is the point.
   * This is the one place in this file a `catch` does not re-raise, and AGENTS.md's rule is about production
   * code surfacing operational state — here the swallowed thing is the fixture, not the subject.
   */
  async function through(
    env: Env, path: string, init?: RequestInit, tolerateBackgroundFailure = false,
  ): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://node.example${path}`, init), env, ctx);
    if (tolerateBackgroundFailure) await waitOnExecutionContext(ctx).catch(() => {});
    else await waitOnExecutionContext(ctx);
    return response;
  }

  it("puts no-store on an unhandled 500, which is the return that had none", async () => {
    /*
     * `redeem` rather than an authenticated route, and the reason is the interesting part: with a broken
     * catalog, `principalFor` answers **401** having asked it nothing, so every session-gated path proves
     * only that an unauthenticated request is refused. Redeem is the one unauthenticated *write* — the
     * person using it has no account yet (#83) — so a well-formed body gets past validation and reaches the
     * catalog, where the throw becomes the unhandled return this test is about.
     */
    const response = await through(brokenCatalog, "/api/invitations/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: "inv_whatever_this_is_not_checked_yet", password: "a-long-enough-passphrase",
      }),
    }, true);
    expect(response.status, "the probe did not reach the unhandled return").toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("cookie");
    // And the browser policy on the same response, since both moved together for the same reason.
    expect(policyOf(response).get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("puts it on a thrown refusal and on a 404 under /api/ too", async () => {
    /*
     * The other two `/api/` exits. `no-store` matters most on exactly the responses that say why something
     * was refused, because those are the ones naming a resource — §5C's whole concern — and a shared cache
     * holding one answers the next person's question with somebody else's refusal.
     */
    const refused = await through(testEnv, "/api/invitations/redeem", { method: "POST", body: "{}" });
    expect(refused.status).toBe(422);
    expect(refused.headers.get("cache-control")).toBe("no-store");

    const missing = await through(testEnv, "/api/nothing-here");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  it("still leaves the client assets cacheable, which is the point of the path test", async () => {
    // `noStore` guards on `/api/`, and that guard is load-bearing rather than incidental: the shell and its
    // assets are meant to be cached briefly, and a wrapper that forgot the guard would make every page load
    // fetch the bundle again.
    const asset = await through(testEnv, "/app/app.js");
    expect(asset.headers.get("cache-control")).not.toBe("no-store");
    // …while still carrying the browser policy, which is not path-conditional.
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("the policy says what it needs to say", () => {
  it("refuses framing on the shell, which is where clickjacking lands", async () => {
    // The shell is the document with the buttons in it. `frame-ancestors` is the only directive here that
    // an attacker's page can be stopped by, and it is meaningless on a JSON response.
    const shell = await fetchPath("/");
    expect(policyOf(shell).get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("allows the reader's frame rather than every frame or none", async () => {
    /*
     * `'self'` is the true description of what this application frames: the reader's own sanitised mail, in
     * a `sandbox=""` `srcdoc` frame (ADR 37), and no cross-origin document anywhere.
     *
     * Not asserted as "otherwise the reader breaks", because that was measured and is not so in Chromium —
     * a `srcdoc` frame renders under `frame-src 'none'` too, since it inherits the parent policy rather than
     * being matched against a source list. `security-headers.ts` carries the run. What this pins is the
     * *claim*: one engine's declining to enforce a directive is not a reason to write a false one.
     */
    expect(policyOf(await fetchPath("/")).get("frame-src")).toEqual(["'self'"]);
  });

  it("permits no inline or evaluated script, which is the whole difference", async () => {
    const policy = policyOf(await fetchPath("/"));
    expect(policy.get("default-src")).toEqual(["'none'"]);
    for (const directive of ["script-src", "style-src"]) {
      expect(policy.get(directive), `${directive} is missing, so it falls back to default-src`).toEqual(
        ["'self'"],
      );
    }
    // Stated as its own assertion because this is the failure that matters: a policy carrying
    // `'unsafe-inline'` to accommodate one inline script is a header that looks like a defence and is not.
    expect(JSON.stringify([...policy])).not.toContain("unsafe-");
  });

  it("names the receipt's max-age and claims nothing about subdomains", async () => {
    const hsts = (await fetchPath("/")).headers.get("strict-transport-security");
    expect(hsts).toBe(`max-age=${BUDGETS["security.hsts_max_age_seconds"]}`);
    /*
     * `includeSubDomains` is absent on purpose (`docs/receipts/hsts-max-age.md`). A Node deployed at an
     * apex domain would otherwise assert HTTPS for every sibling host under it — hosts Mailda never saw —
     * for a year, in every browser that received one response. Asserted rather than commented, because it
     * is exactly the token somebody copies in from a hardening guide.
     */
    expect(hsts).not.toContain("includeSubDomains");
  });
});

describe("the policy is honest, because the document it governs contains no inline code", () => {
  it("serves a shell with no inline script and no inline style", () => {
    const html = page();
    // `<script>` with no `src`, or any `<style>` element: either one would need `'unsafe-inline'`, and
    // adding it here is how a CSP becomes decoration. `MAILDA_CONFIG` used to be exactly this.
    expect(html, "an inline <script> — move it to /app/config.js or serve it as a module").not
      .toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html, "an inline <style> — the stylesheet is served at /app/app.css").not.toMatch(/<style[\s>]/);
    expect(html, "a style attribute needs style-src-attr 'unsafe-inline'").not.toMatch(/\sstyle="/);
    expect(html).not.toContain("MAILDA_CONFIG");
    // The other direction, because every assertion above also passes for a document with **no** styling and
    // no script at all — which is what "moved the inline code out" looks like when only half of it happened.
    // Verified in a real browser as well: the served shell computes a themed background and renders the
    // sign-in form under this policy, with nothing refused.
    expect(html, "the stylesheet is served but the document never asks for it").toContain(
      '<link rel="stylesheet" href="/app/app.css">',
    );
    expect(html, "nothing loads the application").toContain('<script type="module" src="/app/app.js">');
  });

  it("serves the two things it stopped inlining, from this origin", async () => {
    const css = clientAsset("/app/app.css");
    expect(css, "the stylesheet is not served, so the shell has no styling at all").not.toBeNull();
    expect(css!.headers.get("content-type")).toContain("text/css");
    // A real stylesheet rather than an empty response: `nosniff` means a browser will not rescue a
    // mistyped one, so an empty or misdeclared asset now fails silently in the layout.
    expect(await css!.text()).toContain(":root");

    const config = clientAsset("/app/config.js");
    expect(config).not.toBeNull();
    expect(config!.headers.get("content-type")).toContain("text/javascript");
    const source = await config!.text();
    expect(source).toMatch(/^export const CONFIG = /);
    // Every number in it against the budget it came from — not a hand-copied figure in a browser file. Both
    // fields, because this module is now the browser's *only* channel for a receipt-derived number: the
    // composer took `holdWindowSeconds` from here rather than importing `@mailda/budgets`, which cost 7,960
    // bytes of shell bundle for one integer. A field silently dropped from this generator would show a
    // person `undefined seconds` beside the button that stops a send.
    expect(source).toContain(`"refreshMarginSeconds":${BUDGETS["auth.access_token_refresh_margin_seconds"]}`);
    expect(source).toContain(`"holdWindowSeconds":${BUDGETS["send.hold_window_default_seconds"]}`);
    expect(source, "the cookie name the client watches for expiry").toContain(`"${EXPIRY_COOKIE}"`);
  });

  it("has the session module import that config rather than read a global", async () => {
    // The other end: a config module nothing imports would pass every assertion above while the session
    // machinery quietly ran on the defaults it used to carry for a global that might be absent.
    const session = await clientAsset("/app/session.js")!.text();
    expect(session).toContain('from "./config.js"');
    // The expression, not the name — the module's own comment still says what this replaced, because that
    // is what somebody grepping for the old global needs to find.
    expect(session).not.toContain("window.MAILDA_CONFIG");
  });
});

describe("the frame inherits this policy, and the sanitiser gives it nothing to refuse", () => {
  it("emits mail HTML that asks for no style, no script and no remote resource", async () => {
    /*
     * A `srcdoc` frame has no URL of its own, so it does not get its own policy — it inherits the parent
     * document's. That means `default-src 'none'` applies **inside the reader**, and if the sanitiser's
     * output relied on an inline `<style>`, a `style` attribute or an `<img src>`, the reading pane would
     * render mail visibly worse than before the header existed.
     *
     * It does not, and that is not luck: ADR 37 already strips all three, for reasons that have nothing to
     * do with CSP (a `background-image: url(...)` in inline CSS defeats the whole point of blocking
     * images). This asserts the two decisions agree, against the sanitiser's real output rather than
     * against a fixture.
     */
    const { html } = await sanitizeHtml(
      '<style>p{color:red}</style><p style="background:url(https://tracker.example/x.png)">hello</p>'
      + '<img src="https://tracker.example/pixel.gif" alt="">'
      + '<script>fetch("https://tracker.example/exfil")</script>'
      + '<a href="https://example.net/invoice">invoice</a>',
    );

    expect(html, "an inline <style> inside the frame is refused by style-src").not.toMatch(/<style[\s>]/);
    expect(html, "a style attribute inside the frame is refused by style-src-attr").not.toMatch(/\sstyle=/);
    expect(html, "img-src does not permit a remote host, and blocking pixels is why").not.toMatch(/\ssrc=/);
    expect(html).not.toContain("<script");
    // The one thing that does survive, so this is not passing by having sanitised everything away: a link
    // is markup, not a fetch, and no directive here governs where a person may choose to navigate.
    expect(html).toContain('href="https://example.net/invoice"');
  });
});
