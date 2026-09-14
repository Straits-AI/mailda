import { BUDGETS, BUDGET_ORIGINS } from "@mailda/budgets";
import type { Ctx } from "@mailda/runtime";

import { currentSigningKey } from "../auth/keys.ts";
import { ownershipFacts, type OwnershipFact } from "./cloudflare-grant.ts";

/**
 * The handover manifest (#165 L4).
 *
 * #108: *"Handover is a state transition, not a folder of passwords."* And under ADR 42 there is no Mailda-held
 * credential to hand over at all — the Node is its own private OAuth client — so the manifest is a statement
 * about a **relationship**, not a transfer of secrets.
 *
 * ## Signed, and honest about what the signature proves
 *
 * A compact JWS over the manifest, using the Node's own ES256 signing key — the same key behind
 * `/.well-known/jwks.json`. So a client verifies with any JOSE tool against a public key they fetch
 * themselves, and **Mailda is not in that loop**, which is #165's requirement.
 *
 * What it proves is narrow and the manifest says so in its own text: *this came from the Node holding that
 * key, unaltered*. It does not prove the Node was honest, and it is only checkable while the key is
 * retrievable — a manifest carrying its own verification key would be a manifest a forger could mint. The
 * JWKS URL travels with it so a client knows where to look; the trust is in having reached that URL, not in
 * the file.
 *
 * ## Only the JWS is returned, and that is deliberate
 *
 * The obvious shape is the manifest *and* its signature side by side, and it is the wrong one: a reader
 * takes the convenient copy and verifies nothing, and the day the two disagree is the day nobody notices.
 * The payload inside the JWS is the only copy. `mailda provider --handover` verifies before it prints, so
 * what is read is what verified.
 */

/**
 * A provider ceremony a person has to perform, derived from measurements rather than listed.
 *
 * **This is the honest half of the manifest**, and #108 asks for it by name. A list typed out here would be
 * a claim that decays silently: Cloudflare shipped the sending-subdomain API between August and September,
 * and a hand-written list would still be telling a client to open the dashboard for it.
 *
 * So each entry is conditioned on a budget value with a receipt behind it. When a measurement changes, the
 * ceremony stops being reported — `pnpm receipts` regenerates the value, and this list follows.
 */
interface Ceremony {
  what: string;
  why: string;
  /** The measurement that makes this true, so a client can check the claim rather than take it. */
  evidence: { value: string; is: number; receipt: string; measuredOn: string };
}

function ceremonyOn(key: keyof typeof BUDGETS, when: number, what: string, why: string): Ceremony | null {
  if (BUDGETS[key] !== when) return null;
  const origin = BUDGET_ORIGINS[key];
  return {
    what, why,
    evidence: { value: key, is: BUDGETS[key], receipt: origin.receipt, measuredOn: origin.measuredOn },
  };
}

function ceremonies(): Ceremony[] {
  return [
    /*
     * The two ADR 42 requires and no measurement will remove, because they are properties of the design
     * rather than gaps in an API: a **private** OAuth client is authorizable only by a member of the account,
     * which is exactly what makes Mailda's non-involvement structural.
     */
    {
      what: "Registering this Node's OAuth client in the Cloudflare dashboard",
      why: "a private OAuth client is created by a person signed in to the account. This is not an API gap — "
        + "it is what makes the grant unobtainable by anyone outside the account, Mailda included",
      evidence: {
        value: "adr.42", is: 1, receipt: "docs/receipts/cloudflare-oauth-endpoints.md",
        measuredOn: BUDGET_ORIGINS["oauth.access_token_lifetime_seconds"]?.measuredOn ?? "unrecorded",
      },
    },
    {
      what: "Granting consent in the browser",
      why: "the authorization happens in Cloudflare's own session, past its own sign-in challenge. The Node "
        + "never sees who consented, which is why its ownership report says so rather than naming somebody",
      evidence: {
        value: "adr.42", is: 1, receipt: "docs/receipts/cloudflare-oauth-scopes.md",
        measuredOn: BUDGET_ORIGINS["oauth.access_token_lifetime_seconds"]?.measuredOn ?? "unrecorded",
      },
    },
    ceremonyOn(
      "routing.subdomain_dashboard_only", 1,
      "Adding a subdomain to Email Routing",
      "Cloudflare publishes no API for it. Its sending counterpart does have one and this Node uses it, so "
      + "this ceremony is about receiving mail on a subdomain and not about sending from one",
    ),
    /*
     * **Currently absent, and that is the point.** In August this was a dashboard ceremony and a list typed
     * out then would still be telling a client so. Cloudflare shipped
     * `POST /zones/{zone_id}/email/sending/subdomains` between August and September, this Node uses it, and
     * the entry disappeared on its own when `pnpm receipts` regenerated the value.
     *
     * It is kept here rather than deleted because the measurement can go back — a withdrawn API would put a
     * person back in the dashboard, and an entry that has to be *re-derived by a human* at that moment is an
     * entry nobody writes.
     */
    ceremonyOn(
      "sending.subdomain_api_available", 0,
      "Onboarding a sending subdomain in the Cloudflare dashboard",
      "no API exists for it, so a person must open Email Sending and onboard the domain by hand",
    ),
    ceremonyOn(
      "queues.subscription_creatable_by_cli", 0,
      "Creating the `email.sending` event subscription, if the dashboard is used rather than the API",
      "wrangler offers no `email.sending` source. The REST API does accept one — undocumented in its own "
      + "schema — so this is automatable by API and not by CLI",
    ),
    ceremonyOn(
      "queues.consumer_block_provisions", 0,
      "Attaching the sending-events queue consumer",
      "a consumer block cannot name a queue whose name the configuration does not know, so the consumer is "
      + "attached out of band by `pnpm --filter @mailda/worker run queue:attach-consumer`",
    ),
    ceremonyOn(
      "sending.unonboard_removes_every_created_record", 0,
      "Deleting the `_dmarc` record left behind after un-onboarding a sending domain",
      "un-onboarding removes five of the six records Cloudflare created and leaves the DMARC policy on a "
      + "name it then stops managing. Nothing in this Node can remove it: the grant carries no DNS write",
    ),
  ].filter((one): one is Ceremony => one !== null);
}

export interface HandoverManifest {
  issuedAt: string;
  node: string;
  /** What the client owns, with each answer's source — the same facts the ownership read reports. */
  ownership: OwnershipFact[];
  ceremonies: Ceremony[];
  /** What the signature does and does not establish, carried with the thing it is about. */
  verification: {
    jwks: string;
    kid: string;
    proves: string;
    doesNotProve: string;
  };
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The manifest as a compact JWS. The payload inside it is the only copy of the manifest there is. */
export async function handoverManifest(
  env: Env, ctx: Ctx, orgId: string, origin: string,
): Promise<{ jws: string }> {
  const key = await currentSigningKey(env, ctx);
  const manifest: HandoverManifest = {
    issuedAt: new Date(ctx.now()).toISOString(),
    node: origin,
    ownership: await ownershipFacts(env, ctx, orgId),
    ceremonies: ceremonies(),
    verification: {
      jwks: `${origin}/.well-known/jwks.json`,
      kid: key.kid,
      proves: "this manifest was issued by the Node holding the private half of the key at the JWKS URL "
        + "above, and has not been altered since",
      doesNotProve: "that the Node reported truthfully, and nothing at all once that key is unreachable. "
        + "The key is deliberately not carried inside this manifest: one that shipped its own verification "
        + "key would be one a forger could mint. Fetch it from the URL, or from a copy taken before handover",
    },
  };

  const encoder = new TextEncoder();
  const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.kid })));
  const payload = base64url(encoder.encode(JSON.stringify(manifest)));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key.privateKey, encoder.encode(`${header}.${payload}`),
  );
  return { jws: `${header}.${payload}.${base64url(new Uint8Array(signature))}` };
}
