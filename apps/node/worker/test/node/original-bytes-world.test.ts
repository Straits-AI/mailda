import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { handlerSites } from "./support/handlers.ts";

const workerDir = join(import.meta.dirname, "../..");
const authzRead = readFileSync(join(workerDir, "src/authz-read.ts"), "utf8");

/**
 * A closed world over the routes that stream a whole original message off this Node (#95).
 *
 * ## The divergence this exists because of
 *
 * There are two: the inbound `.eml` at `GET /api/messages/:id/raw`, and the submitted bytes at
 * `GET /api/sends/:sendId/submitted`. Both hand a caller a complete RFC 5322 message, attachments included.
 * They authorized **differently** for four months.
 *
 * The inbound one went through `authorizeExport`: `message.export` **and** `mailbox.content.read`, with a
 * `message.exported` entry appended before the blob key was returned. The outbound one took `mayRead` alone
 * — content access — under a comment claiming it took *"the same action rather than a weaker one"*. So
 * somebody holding content read and not `message.export` was refused the inbound copy and served the
 * outbound one, and #65's question — *who has taken a copy off this Node* — was answerable in one direction.
 *
 * **Nothing could have noticed.** The two routes are four hundred lines apart, they were written months
 * apart, and no test asked them the same question. That is what this file is: the question, asked of both.
 *
 * ## Why lexical
 *
 * The property is "every route that streams original bytes routes its authorization through one of the two
 * functions that own that decision". That is a claim about the *shape of the source*, not about a response —
 * a behavioural test can only check the routes that exist, and the failure mode here is a **third** route
 * added later with its own third opinion. `content-deletion-world.test.ts` guards the one R2 delete the same
 * way and for the same reason.
 */

/** How original bytes reach a caller: `streamEvidence` is the only function that serves an evidence blob. */
// No `g` flag: a global regex keeps `lastIndex` between `.test` calls and alternates its answer on repeated lines.
const STREAM = /streamEvidence\(/;

/** The two functions permitted to decide whether a caller may have them. */
const DECIDERS = ["authorizeExport", "authorizeSendExport"];

/** Lines that are not code — a mention inside prose is not a call site. */
function codeOnly(source: string): string[] {
  return source.split("\n").filter((line) => {
    const t = line.trimStart();
    return !(t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  });
}

describe("every route that streams an original message shares one authorization", () => {
  it("finds the streaming handlers, so nothing below passes by scanning nothing", () => {
    // Anti-vacuity: if `streamEvidence` were renamed, every assertion here would agree with everything.
    const streaming = handlerSites().filter((site) => codeOnly(site.text).some((line) => STREAM.test(line)));
    expect(streaming.map((site) => site.key).sort()).toEqual([
      "GET /api/exports/:exportId/objects/:objectId",
      "GET /api/messages/:receiptId/raw",
      "GET /api/sends/:sendId/submitted",
    ]);
  });

  it("routes every handler that streams original bytes through a decider, and none authorizes itself", () => {
    /*
     * The check that would have caught #95 on the day. Each handler that streams evidence must name one of
     * the two deciders; a handler calling `mayRead` directly and then streaming is the exact shape the
     * outbound one had. Read from the handler table, so a third streaming route is checked the day it is
     * written rather than the day somebody adds it to a list here.
     */
    for (const site of handlerSites()) {
      if (!codeOnly(site.text).some((line) => STREAM.test(line))) continue;
      /*
       * The export download is the third streaming route, and it was invisible to the previous version of
       * this test, which looked for two hand-written markers rather than asking the table. Its decider is
       * `authorizeExportObject` in `exports.ts`: the export's own grant, re-checked per object, which the
       * registry declares as `scope: "export"` rather than a mailbox relation.
       */
      const decided = DECIDERS.some((decider) => site.text.includes(`${decider}(env, clock, request`))
        || site.text.includes("authorizeExportObject(");
      expect(decided, `${site.key} streams original bytes without going through a shared decider`).toBe(true);
      expect(site.text.includes("mayRead("), `${site.key} decides for itself beside the decider`).toBe(false);
    }
  });

  it("keeps both deciders in one file, because that is how the divergence survived", () => {
    /*
     * Not tidiness. The two decisions were four hundred lines apart in different files, written months
     * apart, and nothing ever put them side by side — so one gained a requirement the other did not. Being
     * neighbours is what makes the next reader compare them.
     */
    for (const decider of DECIDERS) {
      expect(authzRead.includes(`export async function ${decider}`), `${decider} has moved out of authz-read.ts`)
        .toBe(true);
    }
  });

  it("requires message.export in both, not only in the inbound one", () => {
    /*
     * The substance. Both deciders must ask for `message.export`; the outbound one asked for nothing of the
     * kind. Counted rather than merely found, so a decider that lost the check while the other kept it fails
     * here.
     */
    const asks = codeOnly(authzRead).filter((line) => line.includes('["message.export"]'));
    expect(asks.length, "message.export is asked for in fewer than two places").toBe(2);
  });

  it("appends message.exported before returning either blob, and both name their direction", () => {
    /*
     * #65's guarantee is that taking a copy off the Node is recorded. Two routes, two entries, one action —
     * and `direction` on the outbound one so an auditor reading `message.exported` does not have to infer
     * which kind of bytes moved from whether the subject looks like a receipt id.
     */
    const entries = codeOnly(authzRead).filter((line) => line.includes('action: "message.exported"'));
    expect(entries.length, "message.exported is written from fewer than two places").toBe(2);
    expect(authzRead).toContain('direction: "outbound"');
  });
});
