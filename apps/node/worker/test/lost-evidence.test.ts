import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { utf8 } from "@mailda/evidence";

import { EvidenceMissing, getEvidence, putEvidence } from "../src/evidence-store.ts";

const testEnv = env as unknown as Env;

/**
 * Lost mail must not be reported as a bug in the request path.
 *
 * `fetchSealed` has always thrown a four-part message naming §24, the reason ("this is lost mail rather
 * than a bookkeeping error") and the fix (run the reconciler). Nothing read it: a plain `Error` reaching
 * the top-level handler became `500 { error: "internal", message: "This Node failed to handle the
 * request." }`, so the interface said "the body could not be read (500)" and an operator's only route to
 * the actual sentence was the log.
 *
 * Found while seeding a local fixture — I wrote a receipt row pointing at an object I never stored, and
 * the Node's answer was indistinguishable from a crash.
 */
describe("a receipt pointing at bytes that are gone", () => {
  it("throws a condition with its own type, not a bare Error", async () => {
    const ctx = createSystemCtx();
    const key = `org_lost/inbound/${ctx.id("rcp")}.eml`;
    await putEvidence(testEnv, key, utf8("From: a@example.net\r\n\r\nhello"));
    await testEnv.EVIDENCE.delete(key);

    // The type is what lets the handler tell data loss from a fault. Without it the two are one branch.
    await expect(getEvidence(testEnv, key)).rejects.toThrow(EvidenceMissing);
  });

  it("keeps the four-part message, including the reconciler as the fix", async () => {
    // `then(() => null)` so the success branch is not part of the union — otherwise the caught value is
    // typed `Error | Bytes` and every assertion below needs a cast.
    const error = await getEvidence(testEnv, "org_lost/inbound/never-written.eml")
      .then(() => null)
      .catch((thrown: unknown) => thrown as EvidenceMissing);

    expect(error).toBeInstanceOf(EvidenceMissing);
    expect(error!.message).toContain("E_EVIDENCE_MISSING");
    // The three things an operator needs, in the message rather than in a wiki: what, why, and what to run.
    expect(error!.message).toContain("§24");
    expect(error!.message).toContain("reconciler");
    expect(error!.message).toContain("do not delete the receipts");
    // And the key, so the reconciler has somewhere to start.
    expect(error!.blobKey).toBe("org_lost/inbound/never-written.eml");
  });
});
