import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";
import { withoutComments } from "../without-comments.ts";

const PURCHASE = join(import.meta.dirname, "../../src/provider/purchase.ts");

/**
 * Nothing retries a registration, and the reason is that nobody has paid to find out what a retry does
 * (#164).
 *
 * ## Why this is lexical as well as behavioural
 *
 * `test/purchase.test.ts` asserts that each path this Node has *today* posts at most once. That is the
 * behaviour, and it is checked. What it cannot see is a retry added next month — a `for` around the `POST`,
 * a catch that calls `buyDomain` again, a backoff helper — because a new loop comes with new tests that
 * describe it as correct.
 *
 * `recovery-code-entry.test.ts` is the precedent and also the warning: it held a real rule lexically, and it
 * held the rule so literally that it pinned a **bug** in place. So this asserts the *absence of retry
 * machinery*, which cannot be satisfied by a wrong implementation, rather than the presence of a particular
 * comparison.
 *
 * ## The claim this exists to outlive
 *
 * Cloudflare's reference asserts the domain name is *"a natural idempotency key for registration
 * requests"*. That may well be true. It is a claim about behaviour under a retry, and this flow has been
 * given six documented claims that were silent, incomplete or wrong — most recently a query parameter the
 * reference never named. `registrar.register_idempotent` stays `unmeasured` until a real purchase, an
 * abandoned poll and a retry settle it.
 *
 * Until then the guard costs nothing and removes the whole class: if the claim is true this is redundant,
 * and if it is false this is what stops the second charge.
 */
describe("a registration is never retried", () => {
  const source = withoutComments(PURCHASE);

  it("reads the file it claims to, so nothing below passes by reading nothing", () => {
    expect(source.length).toBeGreaterThan(2000);
    expect(source).toContain("registrar/registrations");
    expect(source).toContain("buyDomain");
  });

  it("posts a registration from exactly one place", () => {
    /*
     * One call site is what makes the rest of this checkable. Two would mean two places to add a loop, and
     * the second is always the one nobody looks at.
     */
    const posts = [...source.matchAll(/cloudflarePost</g)];
    expect(posts).toHaveLength(1);
  });

  it("has no loop or scheduled repeat anywhere in it", () => {
    // A registration inside any of these is a registration that can happen more than once.
    for (const machinery of [/\bfor\s*\(/, /\bwhile\s*\(/, /\bsetTimeout\b/, /\bsetInterval\b/,
      /\.retry\b/, /\bbackoff\b/i, /\battempts?\s*\+\+/]) {
      expect(machinery.test(source), `retry machinery matching ${machinery} appeared in purchase.ts`)
        .toBe(false);
    }
  });

  it("does not catch a failed registration into another one", () => {
    /*
     * The subtle shape: not a loop, but a `catch` that calls the buy again. Cloudflare's own documentation
     * says `failed` should *"require user review before retrying"*, so an automatic second attempt would
     * contradict the provider as well as this ticket.
     */
    expect(/catch[\s\S]{0,200}buyDomain/.test(source)).toBe(false);
    expect(/catch[\s\S]{0,200}cloudflarePost/.test(source)).toBe(false);
  });

  it("keeps the measurement recorded as absent rather than assumed", () => {
    /*
     * The honest half, and it is asserted because a budget value is the thing somebody quietly flips when
     * the documentation looks convincing enough.
     */
    expect(BUDGETS["registrar.register_idempotent"]).toBe(0);
    expect(source).toContain("REGISTER_IDEMPOTENCY_UNMEASURED");
  });

  it("stops polling on every state that is not this Node's to continue", () => {
    // Cloudflare documents `action_required` and `failed` as stopping points; `succeeded` is terminal.
    for (const state of ["action_required", "succeeded", "failed"]) {
      expect(new RegExp(`${state}:\\s*false`).test(source), `${state} must not keep polling`).toBe(true);
    }
  });
});
