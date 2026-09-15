import type { Ctx } from "@mailda/runtime";

import { unprocessable } from "../errors.ts";
import { boundAccountFor, cloudflareGet, cloudflarePost } from "./cloudflare-grant.ts";

/**
 * What a domain costs, read at the moment somebody is deciding (#164 L3, read side).
 *
 * ## Two endpoints, and the difference between them is the whole design
 *
 * `GET /registrar/domain-search` suggests names and is documented as **non-authoritative and based on
 * cached data**. `POST /registrar/domain-check` queries the registries in real time, is documented as
 * *"read-only — it does not create, modify, or reserve any domains"*, and returns pricing only for domains
 * it says are registrable.
 *
 * #164 requires that *"availability and price are read at the moment of approval, not from search output. A
 * domain cannot be bought from a stale quote."* That is Cloudflare's own instruction — *"always check
 * availability immediately before registration as domain status can change rapidly"* — so the rule is not
 * Mailda's invention and the two calls are not interchangeable. They are kept as separate functions with
 * separate names for that reason: a single `lookup()` would let the cheap one be used where the binding one
 * belongs.
 *
 * ## Prices are strings, and stay strings
 *
 * The API returns every per-year price as a **string**, and says why: *"to preserve decimal precision"*.
 * Parsing to a number to render it, and formatting it back, is how a price becomes `10.440000000000001` —
 * and this value is destined for an approval digest, where a representation that round-trips differently is
 * an approval that cannot be confirmed. Nothing here converts.
 *
 * ## Not every domain Cloudflare sells can be bought through this API
 *
 * `registrable: false` carries a `reason`, and two of the five are about the **extension** rather than the
 * name: `extension_not_supported_via_api` means Cloudflare sells it in the dashboard and not here. A
 * surface that reported those as *unavailable* would tell an operator a domain is taken when it is for sale.
 * So the reason is carried through verbatim rather than collapsed into a boolean.
 *
 * `domain_premium` is the sharpest: premium registration is **not supported by this API at all**, so a
 * premium domain is one this Node must refuse to buy rather than fail to buy.
 */

/** Cloudflare's own words for why a domain cannot be registered here. Open, because it may add one. */
export type NotRegistrable =
  | "extension_not_supported_via_api"
  | "extension_not_supported"
  | "extension_disallows_registration"
  | "domain_premium"
  | "domain_unavailable";

export interface DomainPrice {
  name: string;
  registrable: boolean;
  /** `standard` or `premium`. Present on some unregistrable results too, which is why it is separate. */
  tier: string | null;
  /** Only ever present when `registrable` is true. Strings, deliberately. */
  currency: string | null;
  registrationCost: string | null;
  renewalCost: string | null;
  /** Cloudflare's reason when it is not registrable, verbatim. Null when it is. */
  reason: string | null;
  /** Whether this Node may proceed to buy it, which is narrower than `registrable`. */
  buyable: boolean;
  /** Why not, in words an operator can act on. Null when it may. */
  refusal: string | null;
}

/** Why a domain this Node could technically ask for is one it will not ask for. */
function refusalFor(one: { registrable?: boolean; reason?: string; tier?: string }): string | null {
  if (one.tier === "premium") {
    /*
     * Checked before `registrable`, because a premium domain can come back either way and the answer is the
     * same: the API does not register premium domains. Reading `registrable: true` and proceeding would put
     * this Node into a `POST` that cannot succeed, against a price the registry sets and that can be very
     * much larger than a standard one.
     */
    return "premium domains cannot be registered through this API at all. Buy it in the Cloudflare "
      + "dashboard if you want it, where the price the registry set is shown before you commit";
  }
  if (one.registrable === true) return null;
  switch (one.reason) {
    case "extension_not_supported_via_api":
      return "Cloudflare sells this extension in its dashboard but cannot register it through the API. "
        + "This is not the same as the domain being taken";
    case "extension_not_supported":
      return "Cloudflare Registrar does not carry this extension";
    case "extension_disallows_registration":
      return "the registry has frozen new registrations on this extension — no registrar can sell it now";
    case "domain_unavailable":
      return "already registered, reserved, or otherwise unavailable";
    default:
      // A reason Cloudflare added after this was written. Reported rather than mapped to the nearest one.
      return `Cloudflare refused it and gave a reason this Node does not recognise: ${one.reason ?? "none"}`;
  }
}

interface CloudflareDomain {
  name?: string;
  registrable?: boolean;
  tier?: string;
  reason?: string;
  pricing?: { currency?: string; registration_cost?: string; renewal_cost?: string };
}

function priceOf(one: CloudflareDomain, fallbackName: string): DomainPrice {
  const refusal = refusalFor(one);
  return {
    name: one.name ?? fallbackName,
    registrable: one.registrable === true,
    tier: one.tier ?? null,
    currency: one.pricing?.currency ?? null,
    registrationCost: one.pricing?.registration_cost ?? null,
    renewalCost: one.pricing?.renewal_cost ?? null,
    reason: one.reason ?? null,
    buyable: refusal === null,
    refusal,
  };
}

/** The maximum the API accepts in one `domain-check`, and a refusal rather than a silent truncation. */
export const CHECK_MAX = 20;

/**
 * The authoritative read: real-time registry status and the price to bind an approval to.
 *
 * Documented read-only, so this reserves nothing and costs nothing but the call.
 */
export async function checkDomains(
  env: Env, ctx: Ctx, orgId: string, names: string[],
): Promise<DomainPrice[]> {
  if (names.length === 0) {
    throw unprocessable("E_REGISTRAR_NO_DOMAINS", {
      what: "no domain was named to check",
      why: "this route answers about domains somebody asked for, and an empty check is a question with no "
        + "subject",
      fix: "pass one or more fully qualified names, each with its extension",
    });
  }
  if (names.length > CHECK_MAX) {
    /*
     * Refused rather than sliced. Cloudflare caps a request at twenty; sending twenty-one and reporting on
     * twenty would answer a different question from the one asked, and the caller would have no way to know
     * which name was dropped.
     */
    throw unprocessable("E_REGISTRAR_TOO_MANY", {
      what: `${names.length} domains were named and Cloudflare accepts ${CHECK_MAX} per check`,
      why: "checking the first twenty and staying quiet about the rest would answer a different question "
        + "from the one asked",
      fix: `ask in batches of ${CHECK_MAX} or fewer`,
    });
  }

  const accountId = await boundAccountFor(env);
  const answer = await cloudflarePost<{ domains?: CloudflareDomain[] }>(
    env, ctx, orgId, `/accounts/${accountId}/registrar/domain-check`, { domains: names },
  );

  /*
   * Cloudflare documents that the response **may omit malformed names**. So the answer is assembled against
   * what was asked rather than against what came back: a name with no result is reported as unanswered, not
   * dropped. A caller comparing lengths would otherwise get a shorter list with no indication which name
   * went missing.
   */
  const byName = new Map((answer.domains ?? []).map((one) => [one.name ?? "", one]));
  return names.map((name) => {
    const found = byName.get(name);
    if (found !== undefined) return priceOf(found, name);
    return {
      name, registrable: false, tier: null, currency: null, registrationCost: null, renewalCost: null,
      reason: null, buyable: false,
      refusal: "Cloudflare returned no result for this name, which it does for names it considers "
        + "malformed. Check the extension is present and the name is not an internationalised domain",
    };
  });
}

/** Suggestions, explicitly cached and non-authoritative. Never the basis for a purchase. */
export async function searchDomains(
  env: Env, ctx: Ctx, orgId: string, query: string,
): Promise<DomainPrice[]> {
  if (query.trim() === "") {
    throw unprocessable("E_REGISTRAR_NO_QUERY", {
      what: "no keyword was given to search for",
      why: "Cloudflare does not accept a bare extension as a query, and an empty one has no answer",
      fix: "pass a keyword or a domain name, such as `mailda` or `mailda.com`",
    });
  }
  const accountId = await boundAccountFor(env);
  const answer = await cloudflareGet<{ domains?: CloudflareDomain[] }>(
    env, ctx, orgId,
    `/accounts/${accountId}/registrar/domain-search?query=${encodeURIComponent(query.trim())}`,
  );
  if (!answer.ok) {
    throw unprocessable("E_REGISTRAR_SEARCH_REFUSED", {
      what: `Cloudflare refused the search for ${query}`,
      why: answer.error,
      fix: "check the grant carries `registrar-domains.read`, and that this account may use the Registrar",
    });
  }
  return (answer.result.domains ?? []).map((one) => priceOf(one, "?"));
}
