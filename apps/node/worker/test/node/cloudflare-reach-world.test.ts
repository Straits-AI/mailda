import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const grant = readFileSync(
  join(import.meta.dirname, "../../src/provider/cloudflare-grant.ts"), "utf8",
);

/**
 * Every Cloudflare endpoint this Node can reach, and every scope it asks for (#163 box 5).
 *
 * ## Why this is a closed world and not a table in a document
 *
 * #163's last box wants a dated receipt of *"the API coverage and scopes actually observed"*. A receipt is a
 * measurement on a day. What keeps it true is this: the set of paths the grant module calls is enumerable
 * from the source, so a new one is a decision somebody makes rather than a line that appears.
 *
 * `docs/machine-surfaces.md`'s count table is the precedent, and its lesson is the reason for the shape — a
 * table of coverage in a document about coverage reads as evidence of coverage, and nothing was watching it.
 *
 * ## The gap this exists to keep visible
 *
 * The live grant holds **fifteen** scopes and the paths below need **five**. The rest were what the
 * dashboard's picker had checked when a real client was registered, which `REQUIRED_SCOPES` says in its own
 * comment about `d1.write` and `queues.write`. An over-broad grant on a customer's Cloudflare account is
 * close to the thing this whole layer exists to be careful about, so the arithmetic is asserted rather than
 * described: narrowing the list changes a number here, and widening it changes the same number the other
 * way.
 */

/**
 * The scopes the module asks for, read from its **text**.
 *
 * Importing it is what this test tried first and cannot do: `cloudflare-grant.ts` reaches `keyvault.ts`,
 * which imports `cloudflare:workers`, which does not exist outside workerd — and vitest reported the file
 * as *0 tests* rather than as a failure, which is the quiet way a check stops checking.
 * `provider-blast-radius.test.ts` reads this module as text for the same reason.
 */
function scopesAskedFor(source: string): string[] {
  return [...source.matchAll(/^\s*scope: "([^"]+)",$/gm)].map((match) => match[1]!);
}

/**
 * Every path the grant module **calls**, with `${…}` collapsed so a template reads as its shape.
 *
 * Comments are stripped first, and the reason is a real near-miss: the doc comment above `onboardSending`
 * quotes `/zones/{zone_id}/email/sending/subdomains` from Cloudflare's reference, and the scan counted it as
 * a ninth reachable endpoint. Prose about an endpoint is not a call to it, and a closed world that cannot
 * tell them apart would fail whenever somebody documented something.
 */
function pathsIn(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = new Set<string>();
  for (const match of code.matchAll(/["`](\/(?:accounts|zones)[^"`]*)["`]/g)) {
    found.add(match[1]!.replace(/\$\{[^}]*\}/g, "{}").replace(/\?.*$/, ""));
  }
  return [...found].sort();
}

/**
 * What each path is for, and the permission the API reference names for it.
 *
 * `reference` is **what Cloudflare documents**, not what was observed — those are different claims and the
 * Email Sending rows are exactly why the distinction is kept. Their reference pages carry no *Accepted
 * Permissions* block at all, so nothing documents which scope authorizes them; all that is known is that a
 * grant holding `email-sending.write` reaches them.
 */
const REACHES: Record<string, { scope: string; reference: string | null }> = {
  "/accounts": { scope: "account-settings.read", reference: null },
  "/accounts/{}/event_subscriptions/subscriptions": {
    scope: "queues.write",
    reference: "Queues Write | Queues Read | Workers Scripts Write | Workers Scripts Read",
  },
  "/accounts/{}/queues/{}": {
    scope: "queues.write",
    reference: "Queues Write | Queues Read | Workers Scripts Write | Workers Scripts Read",
  },
  "/zones": { scope: "zone.read", reference: "Zone Zone Read" },
  "/zones/{}/email/routing": {
    scope: "zone-settings.read", reference: "Zone Settings Write | Zone Settings Read",
  },
  "/zones/{}/email/routing/dns": {
    scope: "zone-settings.read", reference: "Zone Settings Write | Zone Settings Read",
  },
  // No documented permission. Reached with a grant holding `email-sending.write`; nothing says it is needed.
  "/zones/{}/email/sending/subdomains": { scope: "email-sending.write", reference: null },
  "/zones/{}/email/sending/subdomains/{}/dns": { scope: "email-sending.write", reference: null },
};

describe("every Cloudflare endpoint this Node can reach", () => {
  it("is exactly the ones declared, so a new one cannot arrive unclassified", () => {
    /*
     * A path appearing in this module is a path an operator's authority can be spent on. The scan is over
     * the source rather than over calls, because the question is reachability rather than what one run did.
     */
    expect(pathsIn(grant)).toEqual(Object.keys(REACHES).sort());
  });

  it("needs five of the fifteen scopes the grant asks for", () => {
    const spent = new Set(Object.values(REACHES).map((one) => one.scope));
    /*
     * `offline_access` is the sixth and is not in the table, because it authorizes no endpoint — it is what
     * makes the token renewable, and a grant without it would reach every path above exactly once.
     */
    expect([...spent].sort()).toEqual([
      "account-settings.read", "email-sending.write", "queues.write", "zone-settings.read", "zone.read",
    ]);

    const asked = scopesAskedFor(grant);
    expect(asked).toHaveLength(15);
    /*
     * **Nine scopes authorize nothing this Node calls**, and naming them is the point rather than the count:
     * each is a permission on somebody's Cloudflare account that no code path uses. `REQUIRED_SCOPES` says
     * why in its own comment — they are what the dashboard's picker had checked.
     */
    const idle = asked.filter((one) => !spent.has(one) && one !== "offline_access");
    expect(idle.sort()).toEqual([
      "account-api-gateway.read", "account-dns-settings.read", "d1.write",
      "email-routing-account-rule.read", "email-routing-address.write", "email-routing-rule.write",
      "email-routing-suppression.write", "user-details.read", "workers-scripts.read",
    ]);
  });

  it("finds paths at all, so the scan cannot agree with everything by reading nothing", () => {
    // The regex is the weak part: a change to how paths are written would empty it and pass both tests.
    expect(pathsIn(grant).length).toBeGreaterThan(5);
    expect(pathsIn("nothing here")).toEqual([]);
    // The scope scan has the same weakness and the same anti-vacuity check.
    expect(scopesAskedFor(grant).length).toBe(15);
    // And a documented path is not a called one, which is what stripping comments is for.
    expect(pathsIn("/* `/zones/{zone_id}/nothing` */")).toEqual([]);
    expect(scopesAskedFor("nothing here")).toEqual([]);
  });
});
