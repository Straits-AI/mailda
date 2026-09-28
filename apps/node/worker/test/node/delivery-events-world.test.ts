import { describe, expect, it } from "vitest";

import { doctorSource, doctorTokens } from "./support/doctor-source.ts";

import { ROUTES } from "@mailda/contract";

const doctor = doctorSource();

/**
 * `sending_events_consumer` says the question is answered elsewhere. This is what makes that true (#163).
 *
 * ## The hazard this exists for
 *
 * That finding is `report`, `ok: true`, on every Node, for ever. Nothing it says can fail, so its `detail`
 * is prose that no test touches — and its previous version stayed accurate for exactly as long as it took
 * ADR 42 to land, after which it told every operator the question was unanswerable while the Node held the
 * grant that answers it. It still ran. It still passed. It still read as verified.
 *
 * `butler-execution-world.test.ts` exists for the identical reason and is the precedent: the way to make an
 * unfailable sentence able to fail is to assert the world it describes.
 *
 * So there are two claims here. The **positive** one — the named route exists, is `GET`, and is reachable
 * only by an admin — fails the day somebody removes or renames the surface the finding sends people to. The
 * **negative** one fails the day the old sentence comes back, which is the direction a revert would take it.
 */
describe("what sending_events_consumer promises", () => {
  const named = "/api/provider/delivery-events";

  it("names a route that exists", () => {
    expect(doctor).toContain(`\`GET ${named}\``);

    const route = ROUTES.find((one) => one.path === named && one.method === "GET");
    expect(route).toBeDefined();
    /*
     * Admin-only, and organization-scoped: it spends the account's own authority, so a delegated token
     * holding an ordinary read scope must not reach it.
     */
    expect(route!.authority).toEqual({ scope: "organization", allOf: ["org.admin"] });
  });

  it("no longer claims the question cannot be answered from inside a Worker", () => {
    expect(doctor).not.toContain("no account API access");
  });

  /*
   * The reason the answer is *not* folded into `doctor` — it would reach the network on every report — is
   * itself a claim, and this is the thing that would make it false.
   */
  it("keeps the live read out of doctor", () => {
    expect(doctor).not.toContain("deliveryEventsState");
  });
});

/*
 * `sending_events_consumer` also names the route that creates the subscription. Read from doctor's string
 * literals (AGENTS.md §2c, rung 3), so a comment naming the route cannot satisfy it: this fails the day the
 * finding stops naming it, or the route goes or stops being admin-only.
 */
describe("what sending_events_consumer names to create the subscription", () => {
  it("names a route that exists, admin-only", () => {
    expect(doctorTokens().literals.some((one) => one.includes("`POST /api/provider/subscription`"))).toBe(true);
    const route = ROUTES.find((one) => one.path === "/api/provider/subscription" && one.method === "POST");
    expect(route).toBeDefined();
    expect(route!.authority).toEqual({ scope: "organization", allOf: ["org.admin"] });
  });
});

/*
 * `delivery_visibility` sends a Node that has never read its account's verified destinations to the route that
 * reads them (28 September 2026), and reads what that route recorded rather than reading the account itself.
 * That the fix names the route is held by `test/doctor-blindness.test.ts` ("asks for the read first when this
 * Node has never read the list"), against the registry. Here: the route exists and is admin-only, and, read by the
 * TypeScript parser (AGENTS.md §2c, rung 3) so that a comment naming any of them cannot decide it, doctor's code
 * reads the recorded state, no identifier in doctor is the function that spends the credential, and no string in
 * doctor holds the Cloudflare path it calls.
 */
describe("what delivery_visibility says reads the verified destinations", () => {
  it("names a route that exists, reads what it recorded, and makes no live read of its own", () => {
    const route = ROUTES.find((one) => one.path === "/api/provider/verified-destinations" && one.method === "POST");
    expect(route).toBeDefined();
    expect(route!.authority).toEqual({ scope: "organization", allOf: ["org.admin"] });

    const { identifiers, literals } = doctorTokens();
    // The parse found doctor's code: a scan that stopped matching would otherwise pass over nothing.
    expect(identifiers.has("sendingEventsConsumerCheck")).toBe(true);
    expect(literals.some((one) => one.includes("FROM verified_destination_read"))).toBe(true);
    expect(identifiers.has("recordVerifiedDestinations")).toBe(false);
    expect(literals.filter((one) => one.includes("email/routing/addresses"))).toEqual([]);
  });
});
