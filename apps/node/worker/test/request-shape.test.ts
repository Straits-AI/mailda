import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { path } from "@mailda/contract/routes";

import { PROBE_FIELD, closedSets, probeBody } from "./closed-sets.ts";

/**
 * The other half of #93's tripwire: a **real Node** applies the contract, on every route that declares a
 * closed set.
 *
 * ## Why this cannot be folded into the Node-side test
 *
 * `test/node/request-shape-world.test.ts` enumerates the contract and drives `refuseUnknownFields` directly.
 * It would pass in full against a Worker that never called the function — which is precisely the state #93
 * found: schemas present, `@mailda/contract` not imported on the request path, every route reading as
 * covered. What can only be proved through a fetch is that the boundary is *in the path*: that
 * `specFor` matches the URL a client actually sends, that the throw becomes a 422 rather than a 500, and
 * that no handler runs first.
 *
 * So the enumeration is shared (`test/closed-sets.ts`) and the driving is not.
 *
 * ## Unauthenticated, deliberately
 *
 * No cookie, no fixture, no seeded organization. The boundary runs before authentication, and a body naming
 * a field that does not exist is not a permission question — refusing it discloses only the contract, which
 * every generated client already carries. That also makes this test's failure unambiguous: a **401 here means
 * the boundary was never reached**, because the handler got there first.
 *
 * ## What is not asserted here, and where it is
 *
 * That the handler still gets its body. The boundary reads a **clone**, and consuming the original would
 * break every schema-bearing route — so it needs proving, but not with a probe: it is proved by
 * `test/policy-routes.test.ts`, which posts `orgDailyVolumeMin: "10"` through this same boundary and reads
 * `10` back out of the column. A stored value is a stronger witness than a status code, because only a
 * handler that parsed the body could have produced it.
 */

const ORIGIN = "https://node";

/** Every `:param` filled with the same placeholder: no route is reached, so no id has to be real. */
function urlFor(spec: { method: string; path: string }): string {
  const params = Object.fromEntries(
    [...spec.path.matchAll(/:(\w+)/g)].map((match) => [match[1]!, "probe"]),
  );
  return `${ORIGIN}${path(spec as never, params)}`;
}

describe("a real Node refuses a field outside a closed set, before it does anything else", () => {
  it("has closed sets to drive, so a broken walk cannot report the world closed", () => {
    // Anti-vacuity: every assertion below is a loop, and a loop over nothing agrees with everything. A floor,
    // for the reason the Node-side twin uses one — six closed sets today, and a seventh should not edit this.
    expect(closedSets().length).toBeGreaterThan(3);
  });

  it("answers 422 with the schema's own code, on every route and at every position", async () => {
    const wrong: string[] = [];
    for (const set of closedSets()) {
      const where = `${set.spec.method} ${set.spec.path} at ${set.path.join(".") || "the body"}`;
      const response = await SELF.fetch(urlFor(set.spec), {
        method: set.spec.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(probeBody(set.path)),
      });
      const body = await response.json() as { error?: string; message?: string };
      if (response.status !== 422) {
        wrong.push(`${where} answered ${response.status} ${body.error ?? ""} — 401 means the handler ran `
          + "first and the boundary was never reached, anything else means it did not refuse");
        continue;
      }
      if (body.error !== set.refusal) wrong.push(`${where} refused as ${body.error}, not ${set.refusal}`);
      if (!(body.message ?? "").includes(PROBE_FIELD)) {
        wrong.push(`${where} did not name the field it refused`);
      }
    }
    expect(wrong.length === 0 ? null : wrong.join("; ")).toBeNull();
  });

  it("refuses before authenticating, which is what makes the check unforgettable", async () => {
    /*
     * Stated as its own case because it is the property, not a side effect. A check that ran inside each
     * handler would be one every future handler had to remember — and the forgotten case here writes an
     * immutable policy version matching every send in the organization and reports success.
     *
     * The pair below is the whole argument: the same route, the same absence of credentials, and the only
     * difference is whether the body names a field that exists.
     */
    const withUnknownField = await SELF.fetch(`${ORIGIN}/api/policies`, {
      method: "POST",
      body: JSON.stringify({ name: "n", outcome: "deny", conditions: { mailbox_id: "mbx_1" } }),
    });
    expect(withUnknownField.status).toBe(422);

    const wellFormed = await SELF.fetch(`${ORIGIN}/api/policies`, {
      method: "POST",
      body: JSON.stringify({ name: "n", outcome: "deny", conditions: { mailboxId: "mbx_1" } }),
    });
    expect(wellFormed.status).toBe(401);
  });

});
