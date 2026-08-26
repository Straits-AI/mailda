import { BUDGETS } from "@mailda/budgets";

/**
 * The browser-side policy every response from this Node carries (#97).
 *
 * ## What was here before, and why nobody noticed it was nothing
 *
 * Nothing. Not a thin policy — an absent one: no CSP, no `frame-ancestors`, no `nosniff`, no HSTS, no
 * `Referrer-Policy`. The reader's sandboxed iframe is a real and well-reasoned defence against hostile
 * *mail*, and it is documented as such, so it read as **the** browser-security story. It is not: it
 * protects the document from the message and says nothing about the document itself. Every governance
 * control in this product is a button — approve, release, lift, grant — and an application that any
 * origin may frame turns a button into a signature.
 *
 * ## The policy is a constant, because the alternative was a nonce and a nonce needs a correspondence
 *
 * `script-src 'self'` with no `'unsafe-inline'` is only true because the shell now ships **no inline
 * script and no inline style at all** — the config moved to `/app/config.js` and the stylesheet to
 * `/app/app.css`, both same-origin (see `ui.ts`). A per-response nonce was the other way to get there
 * and it was rejected on shape rather than on effort: the nonce would have to be minted here, spent in
 * `page()`, and the two would have to agree on every response forever. That is the correspondence
 * problem this repository keeps paying for — and its failure mode is either a blank application or, far
 * worse, a nonce that repeats because something cached the document that carried it. A static policy
 * cannot get out of step with a document it does not appear in.
 *
 * `test/security-headers.test.ts` holds the other half: the shell is asserted to contain no inline
 * script or style, so re-introducing one fails a test here rather than the application in a browser.
 *
 * ## `frame-src 'self'`, not `'none'`
 *
 * The message reader renders sanitised mail into an iframe with `sandbox=""` and `srcDoc` (ADR 37), and
 * that has to keep working — a policy that breaks the reader gets diagnosed by deleting the policy.
 *
 * **What `frame-src` actually decides here was measured rather than assumed, and the answer is "nothing, in
 * Chromium".** Driven through playwright against a real Chromium: a `sandbox=""` `srcdoc` frame loads and
 * renders its document under `frame-src 'self'`, under `frame-src 'none'`, and under no `frame-src` at all
 * with `default-src 'none'` — three runs, no refusal logged in any of them. A `srcdoc` navigation is a local
 * scheme that inherits its parent's policy instead of being matched against a source list, so the directive
 * never gets asked. That is worth writing down because the obvious reading of this line — "`'self'` is what
 * keeps the reader working" — is false in the engine this application is built for, and somebody would
 * eventually prove it false by setting `'none'` and seeing nothing break.
 *
 * `'self'` is still the value, for two reasons that do not depend on that measurement. Only Chromium was
 * measured, and a policy whose correctness rests on one engine declining to enforce a directive is a policy
 * that changes meaning when a customer opens Safari. And `'self'` is the true description of what this
 * application frames: same-origin documents and nothing else. `'none'` would be a claim that it frames
 * nothing, which is not so.
 *
 * The frame **inherits this policy** — a `srcdoc` document has no URL of its own to attach one to — and
 * that is the reason the inheritance is safe rather than a lucky escape: the sanitiser already strips
 * `<style>`, every `style` attribute and `src` on images, so the mail HTML that arrives in the frame asks
 * for none of the things `default-src 'none'` refuses. Both halves are asserted together in
 * `test/security-headers.test.ts`, against the sanitiser's real output.
 *
 * Exported because `test/client/message-frame.test.tsx` renders the reader and asserts against the same
 * directive list, in one test, so the frame and the policy that has to permit it cannot drift apart in two
 * files that never mention each other. The header the Node actually sends is asserted from a real response
 * rather than from this constant, so exporting it does not become a way for the suite to agree with itself.
 */
export const CONTENT_SECURITY_POLICY = [
  // Everything not named below is refused, which is what makes the named ones the whole list. No
  // `font-src`: the interface loads no webfont, on purpose (`ui.ts`), so a policy permitting one would
  // describe an interface we do not ship.
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  // `data:` for the favicon and the grain texture, both inline SVG in `ui.ts` for the same custody reason
  // the fonts are local: a page about owning your mail must not fetch anything from anywhere.
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  // The clickjacking answer, and the one directive that only matters on the shell.
  "frame-ancestors 'none'",
  // A `<base>` injected into the document would re-point every relative URL on it, including the ones
  // `script-src 'self'` is trusting.
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/**
 * Applies the policy above to a response, whatever produced it.
 *
 * A new `Response` rather than `headers.set` on the one passed in, for the reason `noStore` already
 * discovered: a response that came back from a subrequest is immutable, and `/mcp` re-enters this
 * Worker's own `fetch`.
 */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  // Content-type confusion on anything served from this origin. Cheap, and it is the difference between
  // an uploaded `.eml` being bytes and being a document.
  headers.set("x-content-type-options", "nosniff");
  // Paths here carry message ids, send ids and matter ids. `no-referrer` rather than
  // `strict-origin-when-cross-origin`: a link in a message goes to a stranger's server, and the origin
  // alone still tells them somebody's Mailda Node exists at that hostname.
  headers.set("referrer-policy", "no-referrer");
  // Three features this product has no use for and no plan to acquire. Named individually because an
  // unknown feature name is ignored rather than refused, so a list of everything would be a list nobody
  // could check.
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  // `includeSubDomains` is deliberately absent — see `docs/receipts/hsts-max-age.md`, which is also where
  // the year comes from. A Node at an apex domain would otherwise assert HTTPS for hosts it has never
  // seen, for a year, on behalf of a customer who deployed a mailbox.
  headers.set(
    "strict-transport-security",
    `max-age=${BUDGETS["security.hsts_max_age_seconds"]}`,
  );
  // No `X-Frame-Options`. It is the pre-CSP spelling of `frame-ancestors`, it cannot express `'none'`
  // plus an allowlist coherently, and every browser that can run this application's bundle (`es2022`,
  // `build-client.mjs`) enforces `frame-ancestors`. A second header saying nearly the same thing is a
  // second thing to keep in agreement.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
