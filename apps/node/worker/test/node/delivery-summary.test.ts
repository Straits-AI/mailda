import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * The outbox's honesty rule, tested.
 *
 * ## What went wrong, and why no test could have caught it
 *
 * The summary beside a send's state was suppressed whenever the recipients agreed, and skipped entirely
 * for any send with fewer than two recipients. Both reads as reasonable — repeating a unanimous result
 * is noise, and one recipient needs no summary. Both are wrong in the same direction:
 *
 *   - a send whose **every** recipient bounced is unanimous, so the row showed `handed over` in green
 *     and nothing else. Three recipients, none reached, rendered identically to a send that arrived.
 *   - a **single-recipient** send — most mail — never got a chip at all, so a bounce was invisible until
 *     somebody expanded the row.
 *
 * The per-recipient table underneath was correct the whole time. Only the summary lied, which is the
 * failure per-recipient state exists to prevent, reached through the summary instead of through the data.
 *
 * It was unreachable by the suite because it lived in `app.client.js`, which touches `document` and calls
 * `start()` at module scope — so it cannot be imported, and 289 tests said nothing about it. It was found
 * by rendering the page and looking at it.
 *
 * ## Why the module is evaluated rather than imported
 *
 * `delivery.client.js` is bundled as **text** (wrangler.jsonc `rules`) so `ui.ts` can serve it verbatim.
 * A TypeScript import of that path therefore yields a string, not a namespace. Evaluating the string is
 * not a workaround for that — it is the stronger check: what this test exercises is byte-identical to
 * what a browser is served, so a second copy cannot drift from the served one.
 */

const SOURCE = join(import.meta.dirname, "..", "..", "src", "client", "delivery.client.js");

interface DeliveryEntry {
  state: string;
  count: number;
  label: string;
  note: string;
}

interface Recipient { kind?: string; address?: string; delivery_state: string | null }

let summariseDelivery: (recipients: unknown) => DeliveryEntry[];
let orderRecipients: (recipients: unknown) => Recipient[];
let DELIVERY_SEVERITY: string[];

beforeAll(async () => {
  const source = readFileSync(SOURCE, "utf8");
  // A data: URL rather than a temporary file — the module is DOM-free by design, which is the property
  // that makes this possible and is worth having a test depend on.
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  summariseDelivery = module.summariseDelivery;
  orderRecipients = module.orderRecipients;
  DELIVERY_SEVERITY = module.DELIVERY_SEVERITY;
});

const recipient = (delivery_state: string | null) => ({ delivery_state });

describe("the outbox delivery summary", () => {
  it("shows a total failure rather than calling it unanimous", () => {
    // The regression. Three recipients, all bounced, and the row must not be silent about it.
    const summary = summariseDelivery([recipient("bounced"), recipient("bounced"), recipient("bounced")]);
    expect(summary).toEqual([
      { state: "bounced", count: 3, label: "bounced", note: expect.stringContaining("refused") },
    ]);
  });

  it("shows the outcome of a single recipient, which is most mail", () => {
    // The `length < 2` guard meant one bounced recipient produced nothing at all.
    expect(summariseDelivery([recipient("bounced")])).toEqual([
      { state: "bounced", count: 1, label: "bounced", note: expect.any(String) },
    ]);
  });

  it("collapses a unanimous success to one entry instead of repeating it per recipient", () => {
    const summary = summariseDelivery([recipient("accepted"), recipient("accepted")]);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ state: "accepted", count: 2 });
  });

  it("keeps a mixed outcome mixed, worst first", () => {
    const summary = summariseDelivery([
      recipient("accepted"), recipient("bounced"), recipient(null), recipient("deferred"),
    ]);
    // Worst first: the reader's eye should land on the bounce, not on the acceptance.
    expect(summary.map((entry) => entry.state)).toEqual(["bounced", "deferred", "unobserved", "accepted"]);
    expect(summary.map((entry) => entry.count)).toEqual([1, 1, 1, 1]);
  });

  it("says nothing only when nothing at all has been observed", () => {
    // Not a suppression: the submission state is the whole of what the Node knows here, and an
    // "unobserved" chip beside `handed over` would add no fact. The detail row says it in words.
    expect(summariseDelivery([recipient(null), recipient(null)])).toEqual([]);
    expect(summariseDelivery([])).toEqual([]);
    expect(summariseDelivery(undefined)).toEqual([]);
  });

  it("still reports when only some recipients are unobserved", () => {
    const summary = summariseDelivery([recipient(null), recipient("accepted")]);
    expect(summary.map((entry) => entry.state)).toEqual(["unobserved", "accepted"]);
  });

  it("puts an outcome it does not recognise first rather than last", () => {
    // A state Cloudflare adds later must not sort below "accepted" and read as probably fine.
    const summary = summariseDelivery([recipient("accepted"), recipient("quarantined")]);
    expect(summary[0]!.state).toBe("quarantined");
    // And it is still named, using the provider's own word rather than being relabelled or dropped.
    expect(summary[0]!.label).toBe("quarantined");
  });

  it("reads recipients in envelope order, not alphabetical order", () => {
    // `ORDER BY kind` sorts bcc, cc, to — so the blind copy came first and the addressee last. A reader
    // of a bounce report should meet the person the mail was actually addressed to first.
    const ordered = orderRecipients([
      { kind: "bcc", address: "archive@example.com", delivery_state: null },
      { kind: "to", address: "ops@example.com", delivery_state: "accepted" },
      { kind: "cc", address: "finance@example.com", delivery_state: "bounced" },
    ]);
    expect(ordered.map((r) => r.kind)).toEqual(["to", "cc", "bcc"]);
  });

  it("keeps a kind it does not know rather than dropping it", () => {
    const ordered = orderRecipients([
      { kind: "resent-to", address: "z@example.com", delivery_state: null },
      { kind: "to", address: "a@example.com", delivery_state: null },
    ]);
    // Last, because its place in an envelope is not known — but present, because a recipient this client
    // cannot classify still received the mail.
    expect(ordered.map((r) => r.kind)).toEqual(["to", "resent-to"]);
  });

  it("does not mutate the array it was given", () => {
    // The caller's array is the API response; reordering it in place would silently change what any
    // later reader of the same object sees.
    const input = [
      { kind: "bcc", address: "b@example.com", delivery_state: null },
      { kind: "to", address: "a@example.com", delivery_state: null },
    ];
    orderRecipients(input);
    expect(input.map((r) => r.kind)).toEqual(["bcc", "to"]);
  });

  it("ranks every state it knows, so none can silently sort first", () => {
    // `severityRank` returns -1 for anything absent from this list, which is deliberate for an unknown
    // state and would be a bug for a known one — a state missing here would outrank a bounce.
    expect(DELIVERY_SEVERITY).toEqual(
      ["bounced", "failed", "rejected", "deferred", "unobserved", "accepted"],
    );
  });
});
