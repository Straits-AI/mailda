import { describe, expect, it } from "vitest";

import { BODY_INDEX_MAX_ATTEMPTS, afterFailedAttempt, nextAttemptAt } from "../src/search.ts";

/**
 * The body index's state machine (`migrations/0044_body_index_state.sql`).
 *
 * ## What was wrong with the design this replaces
 *
 * One timestamp, `body_indexed_at`, recorded that the index had *finished* with a message and said nothing
 * about how. The backfill settled every message it reached, including ones whose evidence it could not
 * fetch — on the reasoning that an unreadable body does not become readable next minute, which is right about
 * a **parse** failure and wrong about a momentary R2 error. So a transient blip made a message permanently
 * unsearchable by its text, with no record of why and no supported repair. The receipt said so plainly and
 * named clearing the column by hand as the only route.
 *
 * These are pure functions, so they are tested here rather than through a fixture: what matters is the
 * boundary between "try again" and "stop", and a behavioural test would exercise it once at whatever attempt
 * count the fixture happened to reach.
 */

describe("retrying is bounded, and giving up is a different state from having nothing to index", () => {
  it("retries below the limit and stops at it", () => {
    /*
     * The boundary, checked from both sides. An off-by-one here is either a message retried forever — the
     * failure mode that made this bounded in the first place — or one abandoned on its first blip.
     */
    for (let attempts = 1; attempts < BODY_INDEX_MAX_ATTEMPTS; attempts++) {
      expect(afterFailedAttempt(attempts, "r2 unavailable").state, `attempt ${attempts} should retry`)
        .toBe("retryable");
    }
    expect(afterFailedAttempt(BODY_INDEX_MAX_ATTEMPTS, "r2 unavailable").state).toBe("unindexable");
  });

  it("keeps the reason and says it gave up, rather than reporting nothing to index", () => {
    /*
     * `unindexable` covers two facts — "no parser will read this" and "we stopped trying" — and an operator
     * deciding whether to repair needs to know which. Repairing the first spends attempts on work that cannot
     * succeed; repairing the second is exactly right once the cause is fixed.
     *
     * That is also why exhaustion does **not** become `empty`: "there was nothing there" is a claim about the
     * message, and this is a claim about us.
     */
    const gaveUp = afterFailedAttempt(BODY_INDEX_MAX_ATTEMPTS, "vault unreachable");
    expect(gaveUp.error).toContain("abandoned after");
    expect(gaveUp.error).toContain("vault unreachable");
    expect(gaveUp.state).not.toBe("empty");
  });

  it("backs off, and stops backing off before the interval becomes useless", () => {
    /*
     * The cap matters more than the curve. Uncapped doubling reaches days by attempt eleven, and a message
     * nobody retries for a day is a message nobody retries — the pass would look busy and the mail would stay
     * unsearchable.
     *
     * Asserted as a shape rather than exact strings: the interval grows, and it never exceeds the cap.
     */
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    const minutes = (attempts: number) => (Date.parse(nextAttemptAt(now, attempts)) - now) / 60_000;

    expect(minutes(1)).toBe(1);
    for (let attempts = 2; attempts <= BODY_INDEX_MAX_ATTEMPTS; attempts++) {
      expect(minutes(attempts), `attempt ${attempts} does not wait longer than ${attempts - 1}`)
        .toBeGreaterThanOrEqual(minutes(attempts - 1));
    }
    // The cap, checked well past the limit so a future raise to the attempt count cannot walk past it.
    for (const attempts of [10, 20, 50]) {
      expect(minutes(attempts), `attempt ${attempts} waits longer than the cap`).toBeLessThanOrEqual(16);
    }
  });

  it("never schedules a retry in the past", () => {
    // A next-attempt instant at or before now makes the selector's comparison meaningless: the message is
    // picked up on the same pass that just failed it, and the backoff does nothing.
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    for (let attempts = 0; attempts <= 12; attempts++) {
      expect(Date.parse(nextAttemptAt(now, attempts)), `attempt ${attempts}`).toBeGreaterThan(now);
    }
  });
});
