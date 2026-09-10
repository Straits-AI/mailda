import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ROUTES } from "@mailda/contract";

const doctor = readFileSync(join(import.meta.dirname, "../../src/doctor.ts"), "utf8");

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
