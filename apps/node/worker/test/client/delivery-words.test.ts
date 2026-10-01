import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { deliveryWords, sendReasonWords, sendStateWords, shown } from "../../src/client/app/delivery-words.ts";

/**
 * The lookup half of the Outbox's vocabulary (`src/client/app/delivery-words.ts`): the tokens `/app/delivery.js`
 * returns, in the installed English. The decisions are `test/node/delivery-summary.test.ts`'s; this holds that each
 * kind of token finds its own words, and that a token from a newer Node is shown as it came rather than as a key.
 */
describe("the words for a delivery token", () => {
  it("reads never_submitted with the stored state's label and the stronger note", () => {
    expect(sendStateWords("never_submitted").label).toBe("outcome unknown");
    expect(sendStateWords("never_submitted").note).toContain("It never left");
    expect(sendStateWords("outcome_unknown").note).toContain("We do not know");
  });

  it("finds a state, a reason, a delivery state, unobserved and a delivery reason", () => {
    expect(sendStateWords("handed_over").label).toBe("handed over");
    expect(sendReasonWords("policy_hold").label).toBe("rule hold");
    // Notes, not labels, where the English label is the token itself: a lookup that fell through to the raw
    // token would read the same.
    expect(deliveryWords("bounced").note).toContain("refused it");
    expect(deliveryWords("unobserved").note).toContain("Nothing has been reported");
    expect(deliveryWords("verified_destination").label).toBe("verified destination");
  });

  it("shows a token it has no words for as it came, with no note, in code so it cannot pass for a word", () => {
    const drawn = (words: ReturnType<typeof sendStateWords>) => renderToStaticMarkup(createElement("p", null, shown(words)));
    for (const words of [sendStateWords("paused"), sendReasonWords("paused"), deliveryWords("paused")]) {
      expect(words).toEqual({ label: "paused", note: "", raw: true });
      expect(drawn(words)).toBe("<p><code>paused</code></p>");
    }
    expect(drawn(sendStateWords("handed_over"))).toBe("<p>handed over</p>");
  });
});
