import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { DELIVERY_REASONS, DELIVERY_STATES, SEND_STATES } from "@mailda/contract/schemas";

import * as en from "../../src/i18n/en/index.ts";
import * as zhHans from "../../src/i18n/zh-Hans/index.ts";

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
    expect(summary).toEqual([{ state: "bounced", count: 3 }]);
  });

  it("shows the outcome of a single recipient, which is most mail", () => {
    // The `length < 2` guard meant one bounced recipient produced nothing at all.
    expect(summariseDelivery([recipient("bounced")])).toEqual([{ state: "bounced", count: 1 }]);
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
    // And it is still named, by the provider's own token rather than being relabelled or dropped: the shell
    // shows a token it has no words for as it came (`src/client/app/delivery-words.ts`).
    expect(summary[0]).toEqual({ state: "quarantined", count: 1 });
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
      ["bounced", "failed", "rejected", "deferred", "unobserved", "verified_destination", "accepted"],
    );
  });
});

/**
 * A reason beside `unobserved` (28 September 2026): Cloudflare published no delivery event for mail to a verified
 * destination of the account, in the one case measured, so such a recipient's silence is explained rather than
 * pending. What would render plausibly and be wrong: a reason shown over an outcome that did arrive; a send whose
 * every recipient is a verified destination summarised as nothing at all, which reads as "wait"; the reason
 * ranked with the outcomes a reader must act on; a token with no words, or words for a token nothing writes.
 */
describe("the reason beside unobserved", () => {
  let describeRecipient: (recipient: unknown) => { state: string; reason: string | null };

  beforeAll(async () => {
    const source = readFileSync(SOURCE, "utf8");
    const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    describeRecipient = module.describeRecipient;
  });

  const silent = (delivery_reason: string | null) => ({ delivery_state: null, delivery_reason });

  it("keeps the state unobserved and puts the reason beside it", () => {
    expect(describeRecipient(silent("verified_destination"))).toEqual({ state: "unobserved", reason: "verified_destination" });
  });

  it("drops the reason once an outcome is observed: an event wins", () => {
    expect(describeRecipient({ delivery_state: "accepted", delivery_reason: "verified_destination" }))
      .toEqual({ state: "accepted", reason: null });
  });

  it("gives a send whose every recipient is a verified destination its one chip", () => {
    // It adds a fact the submission state does not: nothing is coming, so do not wait.
    expect(summariseDelivery([silent("verified_destination")])).toEqual([{ state: "verified_destination", count: 1 }]);
  });

  it("ranks the reason below unobserved and above accepted", () => {
    const summary = summariseDelivery([
      recipient("accepted"), silent("verified_destination"), silent(null), recipient("bounced"),
    ]);
    expect(summary.map((entry) => entry.state)).toEqual(["bounced", "unobserved", "verified_destination", "accepted"]);
  });

  it("reads an empty reason as none, rather than a reason with no words", () => {
    expect(describeRecipient(silent(""))).toEqual({ state: "unobserved", reason: null });
    expect(describeRecipient(silent(null))).toEqual({ state: "unobserved", reason: null });
  });

  it("still says nothing when every recipient is plainly unobserved", () => {
    expect(summariseDelivery([silent(null)])).toEqual([]);
  });

  it("ranks every state and reason the contract names, so none can sort ahead of a bounce", () => {
    // `severityRank` returns -1 for a token absent from the list, which is right for a newer Node's unknown one
    // and a bug for a known one. The words for each are the catalog's, held to the same lists by its type.
    expect([...DELIVERY_SEVERITY].sort())
      .toEqual([...DELIVERY_STATES, "unobserved", ...DELIVERY_REASONS].sort());
  });
});

/**
 * The send's own state, and the one reading where the Node knows more than the state name admits.
 *
 * `outcome_unknown` used to read *"We do not know whether it left"* unconditionally, in a literal map inside
 * `ledgers.tsx`. But `dispatch.ts` stores the submitted bytes and sets `submitted_key` **before** calling
 * `transport.submit` on the authored path — so a terminal authored send with **no** submitted key never
 * reached the transport, and the Node can say so. Saying "we do not know" there is weaker than the evidence,
 * and Layer 2's proof line is that these words are never blurred.
 *
 * The words moved into the delivery module for the same reason the summary rule did: this is the rule that
 * decides what a person is told, and the previous outbox honesty defect lived in the one file no test could
 * import.
 */
describe("what a send's state is called", () => {
  let describeSend: (send: unknown) => string;
  let describeReason: (send: unknown) => string | null;

  beforeAll(async () => {
    const source = readFileSync(SOURCE, "utf8");
    const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    describeSend = module.describeSend;
    describeReason = module.describeReason;
  });

  it("reads never_submitted when the submitted bytes provably do not exist, and its words say so", () => {
    const unproven = { state: "outcome_unknown", fidelity: "authored", has_submitted: 0 };
    expect(describeSend(unproven)).toBe("never_submitted");
    const note = en.app["send.state.never_submitted.note"];
    expect(note).toContain("It never left");
    expect(note).not.toContain("We do not know");
    // And it says the useful operational thing, which is the whole point of knowing.
    expect(note).toContain("no duplicate");
    expect(en.app["send.state.outcome_unknown.note"]).toContain("We do not know");
  });

  it("keeps the plain state when the bytes were submitted", () => {
    expect(describeSend({ state: "outcome_unknown", fidelity: "authored", has_submitted: 1 })).toBe("outcome_unknown");
  });

  it("stays silent about the reconstructed path, where the NULL proves nothing", () => {
    // `submitted_key` is never written on that path at all, so its absence carries no information. This is
    // the guard that stops the stronger claim being made where it is unfounded.
    expect(describeSend({ state: "outcome_unknown", fidelity: "reconstructed", has_submitted: 0 }))
      .toBe("outcome_unknown");
  });

  it("accepts the integer D1 actually serves as well as a boolean", () => {
    // The API ships `submitted_key IS NOT NULL AS has_submitted`, which is 0 or 1. A truthiness assumption
    // here is how a correct rule renders the wrong sentence.
    expect(describeSend({ state: "outcome_unknown", fidelity: "authored", has_submitted: false })).toBe("never_submitted");
    expect(describeSend({ state: "outcome_unknown", fidelity: "authored", has_submitted: 0 })).toBe("never_submitted");
  });

  it("keeps the label consistent with the stored state, in every locale", () => {
    // The row in D1 really is `outcome_unknown`. This is a reading of it plus one column, not a different
    // state, so anything comparing label to stored state must still find them agreeing.
    for (const catalog of [en.app, zhHans.app]) {
      expect(catalog["send.state.never_submitted"]).toBe(catalog["send.state.outcome_unknown"]);
    }
  });

  it("passes every other state through as its token", () => {
    // The words for each are the catalog's `send.state.*`, which its type holds to the contract's list.
    for (const state of SEND_STATES) {
      if (state !== "outcome_unknown") expect(describeSend({ state, fidelity: "authored", has_submitted: 0 })).toBe(state);
    }
  });

  it("falls back to the raw state rather than rendering nothing", () => {
    expect(describeSend({ state: "some_future_state", fidelity: "authored", has_submitted: 1 })).toBe("some_future_state");
  });

  it("gives the reason as its token, and null when the row has none", () => {
    expect(describeReason({ state: "awaiting", state_reason: "policy_hold" })).toBe("policy_hold");
    expect(describeReason({ state: "held", state_reason: null })).toBeNull();
    expect(describeReason({ state: "held", state_reason: "" })).toBeNull();
  });
});

/**
 * ADR 39's two scales, in the words (`docs/i18n.md`, D5 and D8). At the submission scale this Node hands over,
 * or does not: nothing there says accepted, which is the receiving server's 250; a state says sent only to say a
 * send was not; and the empty Outbox does not say sent at all. Case-insensitive, because the glossary's `avoid`
 * check is not, and D8's defect began with a capital.
 */
describe("the Outbox's words keep to their scale", () => {
  const sendStateKeys = (Object.keys(en.app) as (keyof typeof en.app)[])
    .filter((key) => key.startsWith("send.state."));

  it("never says accepted, bounced or delivered about what this Node did (D8)", () => {
    // Anti-vacuity: the filter must find every state's label and note.
    expect(sendStateKeys.length).toBe(2 * (SEND_STATES.length + 1));
    for (const key of sendStateKeys) {
      expect(en.app[key], key).not.toMatch(/\b(accepted|bounced|delivered)\b/i);
      expect(zhHans.app[key], key).not.toMatch(/受理|退信|送达/);
    }
  });

  it("says sent about a send only to say it was not", () => {
    // "Not sent yet." and "Nothing was sent" claim no outcome; "Sent to the mail service" would claim one.
    const words = (key: (typeof sendStateKeys)[number]) => String(en.app[key]);
    const said = sendStateKeys.filter((key) => /\bsent\b/i.test(words(key)));
    expect(said.length, "anti-vacuity: the held, awaiting, withheld and never_submitted notes negate it").toBeGreaterThanOrEqual(4);
    for (const key of said) expect(words(key).replace(/\b(?:not|nothing was) sent\b/gi, ""), key).not.toMatch(/\bsent\b/i);
  });

  it("never says the send scale's 拒收 about what the receiving world did", () => {
    // 服务商拒收 is the mail service refusing a send; a receiving server's refusal is 退信 (the glossary's rows).
    const deliveryKeys = (Object.keys(zhHans.app) as (keyof typeof zhHans.app)[])
      .filter((key) => key.startsWith("delivery."));
    expect(deliveryKeys.length).toBe(2 * (DELIVERY_STATES.length + 1 + DELIVERY_REASONS.length));
    for (const key of deliveryKeys) expect(zhHans.app[key], key).not.toMatch(/拒收/);
  });

  it("does not call an empty Outbox a record of nothing sent (D5)", () => {
    expect(en.app["ledgers.outbox.empty"]).not.toMatch(/\bsent\b/i);
    expect(zhHans.app["ledgers.outbox.empty"]).not.toMatch(/已发送|发送/);
  });
});
