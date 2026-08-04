import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { putEvidence } from "../src/evidence-store.ts";
import { materialiseReceipt } from "../src/materialise.ts";
import {
  addressOf, decodeEncodedWords, headerBlock, headerFields, messageIds, parseHeaders, sentAt,
} from "../src/mime.ts";

const testEnv = env as unknown as Env;
const ORG = "org_mime";
const MAILBOX = "mbx_mime";
const ADDRESS = "inbox@example.com";
const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(async () => {
  for (const table of ["messages", "mailbox_items", "ingress_receipts", "addresses", "mailboxes"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Inbox", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
  ]);
});

async function accept(raw: Uint8Array, id = "rcpt_test"): Promise<string> {
  const ctx = createSystemCtx();
  const stored = await putEvidence(testEnv, `${ORG}/raw/2026-Q3/${id}.eml`, raw);
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
       raw_bytes, blob_key, blob_sha256, accepted_at, key_generation) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, ORG, id, "sender@example.net", ADDRESS, raw.length, stored.blobKey,
    stored.plaintextSha256, "2026-08-01T00:00:00.000Z", stored.keyGeneration).run();
  return id;
}

describe("header block extraction", () => {
  it("splits on CRLFCRLF and on bare LFLF, because real senders emit both", () => {
    expect(headerBlock(bytes("A: 1\r\nB: 2\r\n\r\nbody"))).toBe("A: 1\r\nB: 2");
    // Refusing bare LF would lose mail every other client accepts.
    expect(headerBlock(bytes("A: 1\nB: 2\n\nbody"))).toBe("A: 1\nB: 2");
  });

  it("treats a message with no separator as headers rather than discarding it", () => {
    // §24: accepted mail is never lost. A header-only message is still readable.
    expect(headerBlock(bytes("Subject: no body here"))).toBe("Subject: no body here");
  });
});

describe("header fields", () => {
  it("unfolds continuation lines", () => {
    const fields = headerFields("Subject: a very\r\n long subject\r\n\tcontinued again");
    expect(fields.get("subject")?.[0]).toBe("a very long subject continued again");
  });

  it("keeps duplicates instead of overwriting them", () => {
    // `Received` repeats by definition, and two Subject headers is a real thing that exists. Silently
    // picking one is how a parser and a renderer end up disagreeing.
    const fields = headerFields("Received: from a\r\nReceived: from b\r\nSubject: x\r\nSubject: y");
    expect(fields.get("received")).toEqual(["from a", "from b"]);
    expect(fields.get("subject")).toEqual(["x", "y"]);
  });

  it("lowercases names, because header names are case-insensitive", () => {
    const fields = headerFields("MESSAGE-ID: <a@b>\r\nsUbJeCt: hi");
    expect(fields.get("message-id")?.[0]).toBe("<a@b>");
    expect(fields.get("subject")?.[0]).toBe("hi");
  });

  it("skips lines that are not fields rather than guessing", () => {
    const fields = headerFields("not a header\r\nSubject: real\r\n: empty name");
    expect(fields.get("subject")?.[0]).toBe("real");
    expect(fields.size).toBe(1);
  });
});

describe("RFC 2047 encoded words", () => {
  it("decodes base64 and quoted-printable", () => {
    expect(decodeEncodedWords("=?utf-8?B?SGVsbG8gd29ybGQ=?=")).toBe("Hello world");
    expect(decodeEncodedWords("=?utf-8?Q?Hello_world?=")).toBe("Hello world");
    expect(decodeEncodedWords("=?utf-8?Q?caf=C3=A9?=")).toBe("café");
  });

  it("decodes non-UTF-8 charsets", () => {
    // ISO-8859-1 0xE9 is é. Getting this wrong mangles a large fraction of European mail.
    expect(decodeEncodedWords("=?iso-8859-1?Q?caf=E9?=")).toBe("café");
  });

  it("handles several words in one value, and plain text around them", () => {
    expect(decodeEncodedWords("Re: =?utf-8?B?SGVsbG8=?= and =?utf-8?B?d29ybGQ=?=")).toBe(
      "Re: Hello and world",
    );
  });

  it("leaves an undecodable word as written rather than dropping it", () => {
    // Ugly and honest beats an empty subject, which would be a lie about what the sender sent.
    expect(decodeEncodedWords("=?utf-8?B?!!!not-base64!!!?=")).toContain("=?utf-8?B?");
    expect(decodeEncodedWords("=?not-a-charset?B?SGVsbG8=?=")).toContain("=?not-a-charset?");
  });

  it("never throws, whatever it is handed", () => {
    for (const nasty of ["=?", "=?utf-8?", "=?utf-8?B?", "=?utf-8?X?abc?=", "=?utf-8?Q?=ZZ?="]) {
      expect(() => decodeEncodedWords(nasty)).not.toThrow();
    }
  });
});

describe("message ids", () => {
  it("strips angle brackets and reads a chain in order", () => {
    expect(messageIds("<a@x.com> <b@x.com> <c@x.com>")).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("tolerates commas and missing brackets, which real mail produces", () => {
    expect(messageIds("<a@x.com>,<b@x.com>")).toEqual(["a@x.com", "b@x.com"]);
    expect(messageIds("a@x.com b@x.com")).toEqual(["a@x.com", "b@x.com"]);
  });

  it("bounds a hostile chain", () => {
    const long = Array.from({ length: 500 }, (_, i) => `<id${i}@x.com>`).join(" ");
    expect(messageIds(long).length).toBe(50);
    // The bound is on parse work, not storage — only two ids are ever stored.
  });

  it("returns nothing for a value with no ids", () => {
    expect(messageIds("")).toEqual([]);
    expect(messageIds("not an id")).toEqual([]);
  });
});

describe("addresses and dates", () => {
  it("takes the address out of a display-name form", () => {
    expect(addressOf('"Soh, Wei Meng" <WeiMeng@Example.COM>')).toBe("weimeng@example.com");
    expect(addressOf("bare@example.com")).toBe("bare@example.com");
    expect(addressOf("")).toBe("");
  });

  it("returns null for an unreadable date instead of substituting now", () => {
    expect(sentAt("Mon, 3 Aug 2026 12:00:00 +0000")).toBe("2026-08-03T12:00:00.000Z");
    // Substituting the current time would silently reorder a mailbox.
    expect(sentAt("not a date")).toBeNull();
    expect(sentAt(undefined)).toBeNull();
  });
});

describe("materialising an accepted receipt (#27)", () => {
  const REAL = bytes([
    "Received: from mail.example.net by mx.cloudflare.net; Mon, 3 Aug 2026 12:00:00 +0000",
    "From: Alice Example <Alice@Example.NET>",
    "To: inbox@example.com",
    "Subject: =?utf-8?B?SW52b2ljZSBjYWZversion?=",
    "Message-ID: <root-abc@example.net>",
    "Date: Mon, 3 Aug 2026 12:00:00 +0000",
    "",
    "body",
  ].join("\r\n"));

  it("writes a message and its mailbox delivery in one commit", async () => {
    const ctx = createSystemCtx();
    const receiptId = await accept(REAL);

    const outcome = await materialiseReceipt(testEnv, ctx, receiptId);
    expect(outcome.status).toBe("created");

    const message = await testEnv.CATALOG.prepare(
      "SELECT rfc_message_id, subject, from_addr, sent_at, thread_root_rfc_id, in_reply_to, parse_error FROM messages WHERE ingress_receipt_id = ?",
    ).bind(receiptId).first<Record<string, string | null>>();

    expect(message?.rfc_message_id).toBe("root-abc@example.net");
    expect(message?.from_addr).toBe("alice@example.net");
    expect(message?.sent_at).toBe("2026-08-03T12:00:00.000Z");
    // No References chain, so the message is its own root — which keeps the column non-null for every
    // message and the thread query one index scan.
    expect(message?.thread_root_rfc_id).toBe("root-abc@example.net");
    expect(message?.in_reply_to).toBeNull();
    expect(message?.parse_error).toBeNull();

    const item = await testEnv.CATALOG.prepare(
      "SELECT mailbox_id, sent_at FROM mailbox_items WHERE message_id = (SELECT id FROM messages WHERE ingress_receipt_id = ?)",
    ).bind(receiptId).first<{ mailbox_id: string; sent_at: string }>();
    // A message row with no mailbox item would be mail that exists and is in no inbox.
    expect(item?.mailbox_id).toBe(MAILBOX);
  });

  it("threads a reply onto its parent's root", async () => {
    const ctx = createSystemCtx();
    const reply = bytes([
      "From: bob@example.net",
      "To: inbox@example.com",
      "Subject: Re: Invoice",
      "Message-ID: <reply-def@example.net>",
      "In-Reply-To: <root-abc@example.net>",
      "References: <root-abc@example.net> <middle@example.net>",
      "Date: Mon, 3 Aug 2026 13:00:00 +0000",
      "",
      "reply body",
    ].join("\r\n"));

    await materialiseReceipt(testEnv, ctx, await accept(REAL, "rcpt_root"));
    await materialiseReceipt(testEnv, ctx, await accept(reply, "rcpt_reply"));

    const rows = await testEnv.CATALOG.prepare(
      "SELECT rfc_message_id, thread_root_rfc_id, in_reply_to FROM messages ORDER BY sent_at",
    ).all<{ rfc_message_id: string; thread_root_rfc_id: string; in_reply_to: string | null }>();

    // Both share a root, which is what makes them one conversation to every other client too.
    expect(rows.results.map((r) => r.thread_root_rfc_id)).toEqual([
      "root-abc@example.net", "root-abc@example.net",
    ]);
    expect(rows.results[1]?.in_reply_to).toBe("root-abc@example.net");
  });

  it("is idempotent, because delivery is at-least-once", async () => {
    const ctx = createSystemCtx();
    const receiptId = await accept(REAL);

    const first = await materialiseReceipt(testEnv, ctx, receiptId);
    const second = await materialiseReceipt(testEnv, ctx, receiptId);
    expect(first.status).toBe("created");
    expect(second.status).toBe("already_present");

    const count = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(count?.n).toBe(1);
    const items = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM mailbox_items").first<{ n: number }>();
    expect(items?.n).toBe(1);
  });

  it("still records a message with no Message-ID, and says why", async () => {
    const ctx = createSystemCtx();
    const anonymous = bytes("From: nobody@example.net\r\nSubject: no id\r\n\r\nbody");
    const receiptId = await accept(anonymous, "rcpt_noid");

    const outcome = await materialiseReceipt(testEnv, ctx, receiptId);
    expect(outcome.status).toBe("created");
    expect(outcome.parseError).toContain("E_NO_MESSAGE_ID");

    const message = await testEnv.CATALOG.prepare(
      "SELECT rfc_message_id, thread_root_rfc_id, parse_error FROM messages WHERE ingress_receipt_id = ?",
    ).bind(receiptId).first<Record<string, string>>();
    // §24: accepted mail is never lost. A derived id keeps it threadable and stable under re-parsing.
    expect(message?.rfc_message_id).toContain(receiptId);
    expect(message?.thread_root_rfc_id).toBe(message?.rfc_message_id);
    expect(message?.parse_error).toContain("E_NO_MESSAGE_ID");
  });

  it("falls back to acceptance time for an unreadable Date, visibly", async () => {
    const ctx = createSystemCtx();
    const undated = bytes("From: a@example.net\r\nMessage-ID: <u@x>\r\nDate: garbage\r\n\r\nbody");
    const receiptId = await accept(undated, "rcpt_undated");

    await materialiseReceipt(testEnv, ctx, receiptId);
    const message = await testEnv.CATALOG.prepare(
      "SELECT sent_at, parse_error FROM messages WHERE ingress_receipt_id = ?",
    ).bind(receiptId).first<{ sent_at: string; parse_error: string }>();

    // The one timestamp this Node actually observed, and the row says that is what happened.
    expect(message?.sent_at).toBe("2026-08-01T00:00:00.000Z");
    expect(message?.parse_error).toContain("E_NO_DATE");
  });

  it("does not wedge the outbox on a receipt that can never succeed", async () => {
    const ctx = createSystemCtx();
    // No such receipt: raising would leave the event unpublished forever on work that cannot complete.
    const outcome = await materialiseReceipt(testEnv, ctx, "rcpt_does_not_exist");
    expect(outcome.status).toBe("already_present");
  });

  it("stores only bounded threading anchors, never the whole References chain", async () => {
    const ctx = createSystemCtx();
    const chain = Array.from({ length: 40 }, (_, i) => `<id${i}@x.com>`).join(" ");
    const deep = bytes([
      "From: a@example.net", "To: inbox@example.com", "Message-ID: <last@x.com>",
      `References: ${chain}`, "Date: Mon, 3 Aug 2026 12:00:00 +0000", "", "body",
    ].join("\r\n"));
    const receiptId = await accept(deep, "rcpt_deep");

    await materialiseReceipt(testEnv, ctx, receiptId);
    const message = await testEnv.CATALOG.prepare(
      "SELECT thread_root_rfc_id, in_reply_to FROM messages WHERE ingress_receipt_id = ?",
    ).bind(receiptId).first<{ thread_root_rfc_id: string; in_reply_to: string | null }>();

    // Two single ids, whatever the chain's length — the byte budget §11B's sharding depends on stays
    // bounded, and the full chain remains in the immutable MIME for the composer to read.
    expect(message?.thread_root_rfc_id).toBe("id0@x.com");
    expect(message!.thread_root_rfc_id.length).toBeLessThan(100);
  });
});
