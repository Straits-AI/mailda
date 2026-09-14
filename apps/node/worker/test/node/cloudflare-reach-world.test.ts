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
 * ## The gap this was written to keep visible, and then closed
 *
 * It first found the grant holding **fifteen** scopes for paths needing **five** — the rest being what the
 * dashboard's picker had checked when a real client was registered. That surplus is gone: the list is six,
 * consented to on a live account, every path exercised against the result.
 *
 * So the assertion changed shape with it. It no longer counts idle scopes; it asserts there are **none** —
 * every scope asked for authorizes something this Node calls, and every path has a scope behind it. Adding
 * a permission "just in case" fails here, which is the direction the surplus arrived from in the first
 * place.
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
 * ## Three ways this scan has been wrong, all of them the same mistake
 *
 * Naming an endpoint is not calling one, and the scanner kept counting the first as the second:
 *
 *  1. A **doc comment** quoting `/zones/{zone_id}/email/sending/subdomains` from Cloudflare's reference.
 *     Comments are stripped.
 *  2. A **refusal message** — `ownershipFacts` tells an operator that `/accounts/{id}/subscriptions` answers
 *     403 — which is prose in a runtime string, so stripping comments does not reach it.
 *  3. The onboarding **`POST`**, which builds a full `https://api.cloudflare.com/…` URL and so was never
 *     matched at all. That one is the dangerous direction: an endpoint the scan cannot see is an endpoint
 *     the closed world does not close.
 *
 * So the base URL is stripped first, and a literal counts only when it is **entirely** a path — no
 * whitespace anywhere in it — **and** sits in argument position. Prose mentioning a path has spaces around
 * it and follows a quote; an argument follows a comma or an open bracket.
 */
function pathsIn(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replaceAll("https://api.cloudflare.com/client/v4", "");
  const found = new Set<string>();
  for (const match of code.matchAll(/[,(]\s*["`](\/(?:accounts|zones)[^"`\s]*)["`]/g)) {
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
  // The account's own record: its name, `type` — which decides the ownership claim — and its settings.
  "/accounts/{}": { scope: "account-settings.read", reference: null },
  "/accounts/{}/event_subscriptions/subscriptions": {
    scope: "queues.read",
    reference: "Queues Write | Queues Read | Workers Scripts Write | Workers Scripts Read",
  },
  "/accounts/{}/queues/{}": {
    scope: "queues.read",
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

  it("asks for no scope that authorizes nothing", () => {
    const spent = new Set(Object.values(REACHES).map((one) => one.scope));
    expect([...spent].sort()).toEqual([
      "account-settings.read", "email-sending.write", "queues.read", "zone-settings.read", "zone.read",
    ]);

    const asked = scopesAskedFor(grant);
    /*
     * `offline_access` authorizes no endpoint and belongs in neither direction of this check: it is what
     * makes the token renewable, and a grant without it would reach every path above exactly once.
     */
    const idle = asked.filter((one) => !spent.has(one) && one !== "offline_access");
    expect(idle).toEqual([]);
    // And the other direction: a path whose scope nobody asks for would fail at runtime, not here.
    expect([...spent].filter((one) => !asked.includes(one))).toEqual([]);
    expect(asked).toHaveLength(6);
  });

  it("finds paths at all, so the scan cannot agree with everything by reading nothing", () => {
    // The regex is the weak part: a change to how paths are written would empty it and pass both tests.
    expect(pathsIn(grant).length).toBeGreaterThan(5);
    expect(pathsIn("nothing here")).toEqual([]);
    // The three near-misses, as cases rather than as a paragraph.
    expect(pathsIn("/* `/zones/{zone_id}/nothing` */")).toEqual([]);
    expect(pathsIn('const m = "`/accounts/{id}/subscriptions` answers 403 here";')).toEqual([]);
    expect(pathsIn('fetch(`https://api.cloudflare.com/client/v4/zones/${z}/thing`)')).toEqual(["/zones/{}/thing"]);
    // The scope scan has the same weakness and the same anti-vacuity check.
    expect(scopesAskedFor(grant).length).toBe(6);
    // And a documented path is not a called one, which is what stripping comments is for.
    expect(pathsIn("/* `/zones/{zone_id}/nothing` */")).toEqual([]);
    expect(scopesAskedFor("nothing here")).toEqual([]);
  });
});
