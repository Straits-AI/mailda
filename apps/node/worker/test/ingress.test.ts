import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createFrozenCtx } from "@mailda/runtime";

import { acceptInbound, bucketFor } from "../src/ingress.ts";
import { getEvidence } from "../src/evidence-store.ts";
import type { Env } from "../src/env.ts";

const testEnv = env as unknown as Env;

const RAW = new TextEncoder().encode(
  [
    "From: customer@example-supplier.com",
    "To: invoices@example.com",
    "Subject: Invoice 4500219877 — revised delivery schedule",
    "Message-ID: <CAJ123.abcdef@mail.example-supplier.com>",
    "Date: Mon, 3 Aug 2026 12:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please find the revised schedule attached.",
    "",
  ].join("\r\n"),
);

let orgId: string;
let mailboxId: string;

beforeAll(async () => {
  const ctx = createFrozenCtx();
  orgId = ctx.id("org");
  mailboxId = ctx.id("mbx");
  const at = new Date(ctx.now()).toISOString();

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)").bind(
      mailboxId, orgId, "Invoices", at,
    ),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), orgId, "invoices@example.com", mailboxId, at),
  ]);
});

describe("inbound receipt (§13, Layer 1)", () => {
  it("accepts a message, stores it losslessly, and returns the original bytes", async () => {
    const ctx = createFrozenCtx(1_760_000_000_000);
    const result = await acceptInbound(testEnv, ctx, orgId, {
      providerEventId: "<CAJ123.abcdef@mail.example-supplier.com>",
      envelopeFrom: "customer@example-supplier.com",
      envelopeTo: "invoices@example.com",
      raw: RAW,
    });

    expect(result.status).toBe("accepted");
    expect(result.receiptId).toMatch(/^rcpt_/);

    const row = await testEnv.CATALOG.prepare(
      "SELECT blob_key, raw_bytes, blob_sha256 FROM ingress_receipts WHERE id = ?",
    )
      .bind(result.receiptId)
      .first<{ blob_key: string; raw_bytes: number; blob_sha256: string }>();

    expect(row?.raw_bytes).toBe(RAW.length);

    // Lossless is the claim Layer 1 makes. Byte-for-byte, through encryption and framing.
    const recovered = await getEvidence(testEnv, row!.blob_key);
    expect(recovered).toEqual(RAW);
  });

  it("commits the receipt and its outbox event in one batch (§22)", async () => {
    const ctx = createFrozenCtx(1_770_000_000_000);
    const result = await acceptInbound(testEnv, ctx, orgId, {
      providerEventId: "<outbox-pairing@example.com>",
      envelopeFrom: "a@example-supplier.com",
      envelopeTo: "invoices@example.com",
      raw: RAW,
    });

    const event = await testEnv.CATALOG.prepare(
      "SELECT topic, payload, published_at FROM outbox WHERE payload LIKE ?",
    )
      .bind(`%${result.receiptId}%`)
      .first<{ topic: string; payload: string; published_at: string | null }>();

    expect(event?.topic).toBe("mail.ingress.accepted");
    // Unpublished until the publisher enqueues it — that is what makes the sweeper's job
    // well-defined (#9).
    expect(event?.published_at).toBeNull();
    // §13: references only. The MIME must never travel in the event.
    expect(event!.payload.length).toBeLessThan(400);
    expect(event!.payload).not.toContain("revised schedule");
  });

  it("is idempotent: redelivery creates no second receipt (#9)", async () => {
    const same = {
      providerEventId: "<duplicate-delivery@example.com>",
      envelopeFrom: "b@example-supplier.com",
      envelopeTo: "invoices@example.com",
      raw: RAW,
    };
    const first = await acceptInbound(testEnv, createFrozenCtx(1_780_000_000_000), orgId, same);
    const second = await acceptInbound(testEnv, createFrozenCtx(1_790_000_000_000), orgId, same);

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("already_accepted");
    expect(second.receiptId).toBe(first.receiptId);

    const count = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM ingress_receipts WHERE org_id = ? AND provider_event_id = ?",
    )
      .bind(orgId, same.providerEventId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects an unknown recipient without storing anything (§13)", async () => {
    const before = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM ingress_receipts").first<{ n: number }>();

    const result = await acceptInbound(testEnv, createFrozenCtx(1_800_000_000_000), orgId, {
      providerEventId: "<nobody@example.com>",
      envelopeFrom: "c@example-supplier.com",
      envelopeTo: "nobody@example.com",
      raw: RAW,
    });

    expect(result.status).toBe("unknown_recipient");
    const after = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM ingress_receipts").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("records the plaintext hash, so integrity survives re-sealing under a new key", async () => {
    const ctx = createFrozenCtx(1_810_000_000_000);
    const result = await acceptInbound(testEnv, ctx, orgId, {
      providerEventId: "<hash-check@example.com>",
      envelopeFrom: "d@example-supplier.com",
      envelopeTo: "invoices@example.com",
      raw: RAW,
    });
    const row = await testEnv.CATALOG.prepare("SELECT blob_sha256 FROM ingress_receipts WHERE id = ?")
      .bind(result.receiptId)
      .first<{ blob_sha256: string }>();

    const expected = [...new Uint8Array(await crypto.subtle.digest("SHA-256", RAW))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(row?.blob_sha256).toBe(expected);
  });
});

describe("time bucket (#12)", () => {
  it("is quarterly, and is a routing unit rather than a shard", () => {
    expect(bucketFor(Date.parse("2026-01-15T00:00:00Z"))).toBe("2026-Q1");
    expect(bucketFor(Date.parse("2026-08-03T00:00:00Z"))).toBe("2026-Q3");
    expect(bucketFor(Date.parse("2026-12-31T23:59:59Z"))).toBe("2026-Q4");
  });
});
