import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workerDir = join(import.meta.dirname, "../..");
const inbox = readFileSync(join(workerDir, "src/client/app/screens/inbox.tsx"), "utf8");
const authzRead = readFileSync(join(workerDir, "src/authz-read.ts"), "utf8");

/**
 * What the search box says it searches must be what the Node searches.
 *
 * ## The gap this closes
 *
 * Body search shipped, and the interface went on saying **"sender or subject"** in the field and
 * *"only subjects and senders are searched — not message bodies"* on the empty state. Both were true when
 * written and false the day the body index landed, and the whole client suite stayed green: those tests
 * assert submission behaviour and which empty state renders, not whether the words are true.
 *
 * Two costs, and the second is the one that matters. People do not discover a feature the interface denies
 * having. And a reader with metadata-only access is told nothing about why their search reaches less than
 * somebody else's — the authorization boundary is invisible precisely where it bites.
 *
 * Found by a third-party audit. Nothing here could have caught it, because no test in this repository was
 * looking at product copy at all.
 *
 * ## Why lexical, and what that cannot do
 *
 * This compares strings in two files. It cannot tell whether the copy is *good* — only whether it still
 * contradicts the code. That is the failure mode that actually occurred: nobody wrote a wrong sentence, a
 * right sentence stopped being right and nothing was watching.
 */

describe("the search box does not deny a capability the Node has", () => {
  it("finds the body index in the query builder, so the claims below rest on something", () => {
    /*
     * Anti-vacuity. If the body arm were removed or renamed, every assertion here would agree with
     * everything — and would then be *wrong in the other direction*, insisting the copy mention a feature
     * that no longer exists.
     */
    expect(authzRead, "no body-index arm in messagePageQuery — does this Node still search message text?")
      .toContain("message_body_search MATCH");
  });

  it("says nothing that denies searching message text", () => {
    /*
     * The rule, as a list of the sentences that were actually there. Not a general check for truthfulness —
     * a regex cannot do that — but a guard against the specific phrasings that were false, and against them
     * coming back when somebody reverts a copy change without reverting the feature.
     */
    const denials = [
      "not message bodies",
      "only subjects and senders are searched",
      "sender or subject",
    ];
    const found = denials.filter((phrase) => inbox.includes(phrase));
    expect(
      found.length === 0 ? null : `the inbox still says ${found.map((f) => JSON.stringify(f)).join(", ")}, `
      + "which denies a capability messagePageQuery has. Body search shipped; the copy did not follow.",
    ).toBeNull();
  });

  it("tells a reader that message text is searched, and that access can limit it", () => {
    /*
     * The positive half. Removing a false sentence and replacing it with nothing would pass the assertion
     * above and leave the feature just as undiscoverable.
     *
     * The second clause is the one a metadata-only reader needs: body search requires
     * `mailbox.content.read`, so their results are narrower than a colleague's for a reason the interface
     * must state rather than let them infer from an empty screen.
     */
    expect(inbox, "the search field does not mention message text, so nobody will discover the feature")
      .toMatch(/message text/);
    expect(
      /read content|content access|where you can read/.test(inbox),
      "nothing tells a metadata-only reader why their search reaches less than somebody else's",
    ).toBe(true);
  });
});
