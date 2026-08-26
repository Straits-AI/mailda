import { forbidden } from "./errors.ts";

/**
 * Refusing a state-changing request that a browser was tricked into making (#96).
 *
 * ## What `SameSite=Lax` alone did not cover
 *
 * `session.ts` claimed for months that Lax *"makes the state-changing endpoints CSRF-safe without a separate
 * token"*. The first half is true — Lax does withhold cookies from cross-site POST — and the conclusion does
 * not follow, because **same-site is not same-origin**. Same-site is computed on scheme plus registrable
 * domain, so every host under the customer's apex is same-site to this Node and its cookies travel there.
 *
 * That is a weakness in any application relying on Lax alone. It is a sharper one here because of what this
 * product *is*: a Node deployed into the customer's own Cloudflare account, on the customer's own domain
 * (ADR 7). Sibling subdomains are not hypothetical — a marketing site, a Pages preview, a staging app, a
 * legacy CNAME someone forgot. Every one of them is same-site to the mailbox.
 *
 * ## Three checks, and why each is the one that closes something
 *
 * | check | closes |
 * |:--|:--|
 * | `Sec-Fetch-Site` is not `same-site` or `cross-site` | **the sibling subdomain** — the hole above |
 * | `Origin`, when present, equals this origin | the same hole in browsers not sending Fetch metadata |
 * | no HTML form encoding | a cross-site `<form>`, which cannot send anything else |
 *
 * The `Sec-Fetch-Site: same-site` case is the point of the whole file. Every other guard here is ordinary
 * defence in depth; refusing `same-site` is what makes a compromised sibling subdomain unable to act.
 *
 * ## Why an absent `Origin` is allowed, which looks like the bypass and is not
 *
 * The obvious objection: an attacker omits the header. They cannot. **A browser always sends `Origin` on a
 * state-changing request** — the Fetch standard requires it for any method other than GET/HEAD, same-origin
 * or not — and CSRF requires a browser, because the whole attack is *somebody else's* cookies being attached
 * by *somebody else's* user agent. A request with no `Origin` came from something with no cookie jar: curl,
 * the generated SDK, `mailda` on somebody's laptop, this Worker re-entering itself for `handleMcp`.
 *
 * Refusing those would break every non-browser surface ADR 12 requires parity for, and would buy nothing:
 * the caller who can omit a header can also set it correctly. This is the reason the decided answer here is
 * **not** a CSRF token. A token has to be exempted for the SDK, the CLI and MCP, none of which has a
 * document to read one from — and an exemption keyed on "no browser headers present" is reachable by
 * omitting a header, which is the bypass a token was supposed to prevent. See the blueprint's amended
 * browser section: origin checking is the defence, and the token is not built, with the argument recorded
 * rather than the requirement quietly skipped.
 *
 * ## Only mutations
 *
 * A GET changes nothing, and every read on this Node authorizes in SQL against a live relationship (ADR 11)
 * — so a cross-site read gets whatever that reader may see, which is what they would see anyway. Guarding
 * reads would also break the one legitimate cross-origin GET: a browser following a link to this Node.
 */

/** The methods that change something. `GET` and `HEAD` are exempt; see the header. */
const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The content types an HTML `<form>` produces, which no caller of this JSON API has a reason to send.
 *
 * Requiring `application/json` instead would refuse a bodyless `DELETE` for no reason, so this refuses the
 * form encodings rather than demanding a type.
 *
 * ## `text/plain` is deliberately **not** here, and it is the interesting omission
 *
 * It is the third CORS-safelisted type and `<form enctype="text/plain">` is a real forgery technique — this
 * Node reads bodies with `request.json()`, which never inspects the content type, so a text/plain body that
 * happens to parse as JSON would be accepted. That argues for refusing it.
 *
 * Against: `text/plain` is what `fetch` sets **by default** for a string body. Refusing it taxes every
 * programmatic caller — the SDK, the CLI, a script somebody writes against the API — with a refusal for
 * something that is not their mistake, and it broke seventy-four tests in this repository that were doing
 * exactly what a person writing a client naturally does.
 *
 * What decides it is that the residual risk is already covered twice over. A form-based forgery is a
 * *cross-site* request, and both checks above refuse one: browsers have sent `Origin` on cross-origin POST
 * for years, and `Sec-Fetch-Site` is in every current engine. So the text/plain vector needs a browser that
 * sends neither header, which is not a browser anyone is using. The two encodings below have **no**
 * legitimate use here, so refusing them is free; refusing the third is not free and buys the same thing
 * twice.
 *
 * Recorded rather than quietly dropped, because "we refuse the CORS-safelisted content types" is the sort of
 * claim that reads as complete and would be two-thirds true.
 */
const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data"];

/**
 * Refuses a mutation that did not come from this origin.
 *
 * Throws, so the refusal travels the same `CallerError` path as every other one and arrives as a four-part
 * message rather than needing a second copy of that handling.
 */
export function refuseCrossSite(request: Request, url: URL): void {
  if (!MUTATIONS.has(request.method)) return;

  /*
   * `Sec-Fetch-Site` first, because it is the only one of the three that distinguishes a sibling subdomain
   * from this origin. `none` is a direct navigation — a typed URL or a bookmark — which cannot be an attack
   * because nothing else initiated it.
   */
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    throw forbidden("E_CROSS_SITE_REQUEST", {
      what: `a ${request.method} arrived with Sec-Fetch-Site: ${site}`,
      why: site === "same-site"
        // Spelled out, because this is the case the whole check exists for and the one a reader will not
        // expect to be refused.
        ? "a same-site request is one from another host under the same registrable domain — a sibling "
          + "subdomain of this Node. `SameSite=Lax` sends this Node's cookies there, which is why Lax alone "
          + "was never the CSRF defence it was documented as"
        : "a cross-site request carrying this Node's cookies is somebody else's page acting as the person "
          + "signed in here",
      fix: "state-changing requests must come from this Node's own interface. A programmatic caller sends no "
        + "Fetch metadata and is unaffected — use the generated SDK or the API directly",
    });
  }

  /*
   * Then `Origin`, exact. This catches a browser that sends no Fetch metadata, and it is checked against the
   * request's **own** URL rather than a configured hostname: this Node has no idea what it is deployed as,
   * and a configured origin is one more account-specific value ADR 24 forbids in committed config.
   */
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    throw forbidden("E_CROSS_SITE_REQUEST", {
      what: `a ${request.method} arrived from ${origin}, and this Node is ${url.origin}`,
      why: "an Origin that is not this Node's is another site acting as the person signed in here. It is "
        + "compared exactly rather than by registrable domain, which is the distinction `SameSite` cannot "
        + "make and this check exists to make",
      fix: "state-changing requests must come from this Node's own interface",
    });
  }

  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (FORM_TYPES.includes(type)) {
    throw forbidden("E_CROSS_SITE_REQUEST", {
      what: `a ${request.method} arrived as ${type}`,
      why: "this Node reads JSON, and no caller of it has a reason to send a form encoding — those are what "
        + "an HTML form produces, which is the shape a cross-site forgery takes",
      fix: "send `content-type: application/json`",
    });
  }
}
