import { describe, expect, it } from "vitest";

import { conflictNotice } from "../src/recovery.ts";

/**
 * A collided restore says so in words (#138).
 *
 * ## What was measured, and why integers were not enough
 *
 * #92's drill restored a catalog into a second Cloudflare account, copied the evidence, and redeemed one of
 * the ten codes. The Node answered:
 *
 *     HTTP 200
 *     {"restored":{"content":[],"credential":[]},"conflicted":{"content":[1],"credential":[1]}}
 *
 * Nothing installed, a single-use code spent, the mail still unreadable — and every layer above read it as a
 * success, including this repository's own CLI, which printed *"the vault is restored"*.
 *
 * The settlement is right to record `ok`: nothing broke and nothing was lost. What was missing is that the
 * *answer* has to say what happened, because two arrays of integers cannot.
 *
 * ## The sentence that matters most
 *
 * That **another code will not help.** All ten carry the same generations, so an operator who reads a
 * collision as bad luck spends the whole sheet on the same result. Everything else here is context; that one
 * is the difference between losing one code and losing ten.
 */

const NONE = { content: [], credential: [] };

describe("what a caller is told when a generation could not be installed", () => {
  it("says nothing at all when nothing collided, so the field's presence is the signal", () => {
    expect(conflictNotice(NONE, { content: [1], credential: [1] })).toBeNull();
    expect(conflictNotice(NONE, NONE)).toBeNull();
  });

  it("names the generations, so the notice is about this collision and not collisions in general", () => {
    const notice = conflictNotice({ content: [1, 2], credential: [3] }, NONE);
    expect(notice).toContain("content 1, 2");
    expect(notice).toContain("credential 3");
  });

  it("says the code is spent and the mail is unreadable", () => {
    /*
     * The two consequences an operator cannot see. The route answers 200 and the audit records `ok`, both
     * correctly — so unless the words say it, every honest signal available points the other way.
     */
    const notice = conflictNotice({ content: [1], credential: [1] }, NONE) ?? "";
    expect(notice).toContain("The code is spent");
    expect(notice).toContain("stays unreadable");
  });

  it("says another code will not help, which is what stops the sheet being spent", () => {
    const notice = conflictNotice({ content: [1], credential: [1] }, NONE) ?? "";
    expect(notice).toContain("Redeeming another code will not change this");
    expect(notice).toContain("all ten carry the same generations");
  });

  it("distinguishes nothing restored from partly restored", () => {
    /*
     * A partial restore is a third state and it reads as neither of the others: some mail became readable and
     * some did not. A message that said "nothing was restored" over it would be false in the direction that
     * makes an operator stop looking.
     */
    expect(conflictNotice({ content: [1], credential: [] }, NONE))
      .toContain("nothing was restored");
    const partly = conflictNotice({ content: [1], credential: [] }, { content: [2], credential: [] }) ?? "";
    expect(partly).not.toContain("nothing was restored");
    expect(partly).toContain("1 was installed");
  });

  it("gives the reason the live key was kept, because the trade is not obvious", () => {
    // Without it, keeping the key that cannot read the restored mail looks like the bug rather than the choice.
    const notice = conflictNotice({ content: [1], credential: [1] }, NONE) ?? "";
    expect(notice).toContain("one number cannot hold both");
    expect(notice).toContain("losing newer mail to recover older is the worse trade");
  });
});
