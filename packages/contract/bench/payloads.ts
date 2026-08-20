/**
 * Realistic payloads for the validator measurement (#15), including the awkward ones
 * the ticket asked for: a large recipient list, many attachment descriptors, and a
 * large HTML body.
 */
const ULID = "01JQR8X4K2N7VB3TCFMH9DYEWZ";

function address(index: number) {
  return { address: `person.${index}@example-customer-company.com`, name: `Person ${index}` };
}

function attachment(index: number) {
  return {
    filename: `invoice-4500219877-page-${index}.pdf`,
    contentType: "application/pdf",
    sha256: Array.from({ length: 64 }, (_, n) => "0123456789abcdef"[(index + n) % 16]).join(""),
    bytes: 240_000 + index,
    disposition: "attachment" as const,
  };
}

const base = {
  mailboxId: `mbx_${ULID}`,
  senderIdentityId: `snd_${ULID}`,
  idempotencyKey: "cli-run-2026-08-03-0001",
  to: [address(1)],
  subject: "Re: Purchase order 4500219877 — revised delivery schedule for week 34",
  bodyText: "Thanks for the update. Confirming the revised dates below.\n\n".repeat(8),
};

export const payloads = {
  valid: {
    /** The overwhelmingly common case: one recipient, short body, no attachments. */
    typical: base,

    /** §11B records Cloudflare Email's 50-recipient limit — the boundary case. */
    "50 recipients": { ...base, to: Array.from({ length: 50 }, (_, n) => address(n)) },

    /** A case thread with a document set attached. */
    "20 attachments": {
      ...base,
      attachments: Array.from({ length: 20 }, (_, n) => attachment(n)),
    },

    /** A marketing-shaped HTML body, near the top of what a human sends. */
    "400KB html body": {
      ...base,
      bodyHtml: `<html><body>${"<p>Regarding the delivery schedule.</p>".repeat(10_000)}</body></html>`,
    },

    /** Everything at once — the worst realistic request. */
    "worst realistic": {
      ...base,
      to: Array.from({ length: 50 }, (_, n) => address(n)),
      cc: Array.from({ length: 20 }, (_, n) => address(100 + n)),
      attachments: Array.from({ length: 20 }, (_, n) => attachment(n)),
      bodyHtml: `<html><body>${"<p>Regarding the delivery schedule.</p>".repeat(5_000)}</body></html>`,
      // `cas_`, not `case_`: #49 chose the prefix once, in the contract and the runtime together, and this
      // payload is meant to look like real traffic.
      headers: { "X-Mailda-Case": `cas_${ULID}`, "X-Priority": "3" },
    },
  },

  invalid: {
    /** Fails on the first field — the cheap rejection. */
    "bad mailbox id": { ...base, mailboxId: "not-a-ulid" },

    /** Valid until the very last recipient — the expensive rejection. */
    "51st recipient invalid": {
      ...base,
      to: [
        ...Array.from({ length: 49 }, (_, n) => address(n)),
        { address: "definitely not an email", name: "Broken" },
      ],
    },
  },
} as const;
