import { describe, expect, it } from "vitest";

import { APP_ROUTES, isAppRoute } from "../../src/app-routes.ts";

/**
 * Every route the interface ever served still serves (R25).
 *
 * The redesign regrouped the navigation (Rules and Butlers under Automations, the diagnostics under Admin),
 * and the natural next step of a regrouping is to rename or drop a path, which turns every bookmark and every
 * link in a runbook into a 404. So the fourteen paths that existed before it are written out here, as the
 * promise they are, rather than derived from the list that must keep them: a list cannot testify that it
 * still holds what it used to.
 */
const BEFORE_THE_REDESIGN = [
  "/", "/queue", "/approvals", "/rules", "/people", "/matters", "/butlers", "/agents", "/limits", "/outbox",
  "/audit", "/log", "/doctor", "/setup",
] as const;

/** The four places the redesign added. */
const ADDED = ["/drafts", "/archive", "/trash", "/settings"] as const;

describe("the application's routes", () => {
  it.each(BEFORE_THE_REDESIGN)("still serves %s", (path) => {
    expect(isAppRoute(path)).toBe(true);
  });

  it.each(ADDED)("serves the added %s", (path) => {
    expect(isAppRoute(path)).toBe(true);
  });

  it("serves nothing else, so a route is added here on purpose or not at all", () => {
    expect([...APP_ROUTES].sort()).toEqual([...BEFORE_THE_REDESIGN, ...ADDED].sort());
  });
});
