import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import worker from "../src/index.ts";
import { acceptInbound } from "../src/ingress.ts";
import { forwardedBy } from "../src/kept-forward.ts";

/**
 * A kept forward at the email handler (ADR 47, `docs/receipts/email-worker-forward.md`): the message is stored first,
 * then forwarded to the destination the address row keeps, and every call leaves one settled row. The refusals the
 * stub throws are the drill's own words.
 */

const testEnv = env as unknown as Env;
const ORG = "org_keptfwd";
const MAILBOX = "mbx_keptfwd";
const ADDRESS = "hello@keptfwd.example";
const DEST = "someone@gmail.test";
const CLAIM = "clm_01KEPTFORWARDMARKER000000";

beforeEach(async () => {
  for (const table of ["outbox", "log_entries", "ingress_receipts", "addresses", "mailboxes", "node_claim", "kept_forward_attempts"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const at = new Date().toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,'x',?,?)").bind(CLAIM, at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)").bind(MAILBOX, ORG, "Hello", at),
    testEnv.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at, kept_forward_to) VALUES (?,?,?,?,?,?)")
      .bind("addr_keptfwd", ORG, ADDRESS, MAILBOX, at, DEST),
  ]);
});

interface Call { to: string; headers: Record<string, string>; storedFirst: boolean }

/** One delivery through the handler; `forward` is what Cloudflare's forward() does. */
async function deliver(options: {
  messageId?: string; headers?: Record<string, string>; forward?: () => Promise<unknown>; to?: string;
} = {}) {
  const calls: Call[] = [];
  let rejected: string | null = null;
  const message = {
    from: "sender@example.net",
    to: options.to ?? ADDRESS,
    headers: new Headers({ "message-id": options.messageId ?? "<kept-1@example.net>", ...options.headers }),
    raw: new Response("From: sender@example.net\r\nSubject: Hi\r\n\r\nhello\r\n").body,
    setReject: (reason: string) => { rejected = reason; },
    forward: async (to: string, headers?: Headers) => {
      // Stored before forwarded: the receipt row exists when the call is made.
      const stored = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM ingress_receipts WHERE envelope_to = ?")
        .bind(ADDRESS).first<{ n: number }>();
      calls.push({ to, headers: Object.fromEntries(headers?.entries() ?? []), storedFirst: (stored?.n ?? 0) > 0 });
      return await (options.forward ?? (async () => undefined))();
    },
  } as unknown as ForwardableEmailMessage;
  const execution = createExecutionContext();
  await worker.email!(message, testEnv, execution);
  await waitOnExecutionContext(execution);
  return { calls, rejected };
}

const attempts = async () => (await testEnv.CATALOG.prepare(
  "SELECT a.state, a.error, a.destination, a.settled_at, r.id AS receipt FROM kept_forward_attempts a "
  + "LEFT JOIN ingress_receipts r ON r.id = a.receipt_id ORDER BY a.attempted_at",
).all<{ state: string; error: string | null; destination: string; settled_at: string | null; receipt: string | null }>()).results;

describe("a kept forward at the email handler", () => {
  it("stores the message, then forwards it to the address's own destination with this Node's marker, and records it handed over", async () => {
    const { calls, rejected } = await deliver();
    expect(rejected).toBeNull();
    expect(calls).toEqual([{ to: DEST, headers: { "x-mailda-forwarded-by": CLAIM }, storedFirst: true }]);
    const [one] = await attempts();
    expect(one).toMatchObject({ state: "handed_over", error: null, destination: DEST });
    expect(one!.settled_at).not.toBeNull();
    expect(one!.receipt).not.toBeNull();
  });

  it("records Cloudflare's refusal verbatim, and neither rejects nor throws: the message is stored", async () => {
    const { calls, rejected } = await deliver({ forward: async () => { throw new Error("destination address not verified"); } });
    expect(calls).toHaveLength(1);
    expect(rejected).toBeNull();
    expect(await attempts()).toMatchObject([{ state: "refused", error: "destination address not verified" }]);
    const stored = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM ingress_receipts").first<{ n: number }>();
    expect(stored?.n).toBe(1);
  });

  it("forwards a redelivery of a stored message never again", async () => {
    await deliver({ messageId: "<again@example.net>" });
    const second = await deliver({ messageId: "<again@example.net>" });
    expect(second.calls).toEqual([]);
    expect(await attempts()).toHaveLength(1);
  });

  it("stores a message carrying its own marker and withholds the forward, saying why", async () => {
    const { calls } = await deliver({ headers: { "x-mailda-forwarded-by": CLAIM } });
    expect(calls).toEqual([]);
    const [one] = await attempts();
    expect(one!.state).toBe("withheld");
    expect(one!.error).toContain("X-Mailda-Forwarded-By");
  });

  it("forwards nothing, and writes no attempt, for an address that keeps no forward", async () => {
    await testEnv.CATALOG.prepare("UPDATE addresses SET kept_forward_to = NULL").run();
    const { calls } = await deliver();
    expect(calls).toEqual([]);
    expect(await attempts()).toEqual([]);
  });

  it("writes no attempt for the delivery that loses a race, so no attempt names a receipt that does not exist", async () => {
    const one = () => acceptInbound(testEnv, createSystemCtx(), ORG, {
      providerEventId: "<race@example.net>", envelopeFrom: "s@example.net", envelopeTo: ADDRESS,
      raw: new TextEncoder().encode("Subject: race\r\n\r\nx\r\n"),
    });
    const results = await Promise.all([one(), one(), one()]);
    // The race must have happened for this to measure anything: more than one call got past the early check.
    expect(results.filter((r) => r.status === "accepted")).toHaveLength(1);
    const rows = await attempts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.receipt).not.toBeNull();
  });

  it("reads another Node's marker as not this Node's", () => {
    expect(forwardedBy(`clm_OTHER, ${CLAIM}`, CLAIM)).toBe(true);
    expect(forwardedBy("clm_OTHER", CLAIM)).toBe(false);
    expect(forwardedBy(null, CLAIM)).toBe(false);
    expect(forwardedBy("anything", "")).toBe(false);
  });
});
