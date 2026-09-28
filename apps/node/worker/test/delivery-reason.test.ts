import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { route } from "@mailda/contract/routes";
import { createSystemCtx } from "@mailda/runtime";

import { ACCESS_COOKIE, issueSession } from "../src/auth/session.ts";

/**
 * `delivery_reason` on `GET /api/sends` (28 September 2026): why no outcome is expected for a recipient,
 * derived at read time from what `POST /api/provider/verified-destinations` recorded.
 *
 * The rule, one case per term: a recipient carries `verified_destination` only while it has no delivery
 * state, only when it was handed over, and only when the hand-over falls inside the interval a read proved
 * (`verified_from` to `verified_until`) or after the latest read for an address that read still listed. The
 * doctor's `delivery_visibility` holds a copy of the same predicate over the same tables; this file holds
 * the copy in `src/routes/sending.ts`.
 */

const testEnv = env as unknown as Env;
const ORG = "org_delivery_reason";
const READER = "usr_delivery_reason";
const MAILBOX = "mbx_delivery_reason";
const ORIGIN = "https://node";

const FROM = "2024-11-21T10:00:00.000Z";
const T = "2026-09-27T07:25:10.228Z";
const UNTIL = "2026-09-28T05:00:00.000Z";
const READ = UNTIL;

async function cookie(): Promise<string> {
  const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId: READER });
  return `${ACCESS_COOKIE}=${session.accessToken}`;
}

beforeEach(async () => {
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    ...["verified_destination_recipients", "verified_destination_read", "send_recipient_events", "send_recipients",
      "send_manifests",
      "relationship_tuples", "users", "node_claim", "mailboxes"]
      .map((table) => testEnv.CATALOG.prepare(`DELETE FROM ${table}`)),
  ]);
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(READER, ORG, "reader@reason.example", at),
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('claim','x',?,?)")
      .bind(at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'mailbox.content.read','mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, READER, MAILBOX, at),
  ]);
});

/** One send with one recipient, in the state the test names. Returns the manifest id. */
async function aSend(recipient: {
  address: string; at?: string; submission?: string; delivery?: string | null;
}): Promise<string> {
  const ctx = createSystemCtx();
  const id = ctx.id("snd");
  const at = recipient.at ?? T;
  const submission = recipient.submission ?? "handed_over";
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare(
      `INSERT INTO send_manifests
         (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to, subject, rfc_message_id,
          fidelity, body_normalized_key, body_normalized_sha256, body_typed_key, body_typed_sha256,
          sealed_at, release_at, state, state_at, attempts)
       VALUES (?,?,?,?,?,?,?,?, 'authored', 'k', 'sha', 'k2', 'sha2', ?, ?, ?, ?, 1)`,
    ).bind(id, ORG, MAILBOX, READER, "support@reason.example", JSON.stringify([recipient.address]), "s",
      `${id}@reason.example`, at, at, submission, at),
    testEnv.CATALOG.prepare(
      `INSERT INTO send_recipients (id, org_id, manifest_id, address, kind, submission_state,
                                    submission_state_at, attempts, delivery_state, created_at)
       VALUES (?,?,?,?, 'to', ?, ?, 1, ?, ?)`,
    ).bind(ctx.id("srr"), ORG, id, recipient.address, submission, at, recipient.delivery ?? null, at),
  ]);
  return id;
}

async function aVerifiedRecipient(address: string, from: string, until: string): Promise<void> {
  await testEnv.CATALOG.prepare(
    "INSERT INTO verified_destination_recipients (org_id, address, verified_from, verified_until) VALUES (?,?,?,?)",
  ).bind(ORG, address, from, until).run();
}

async function aRead(readAt: string): Promise<void> {
  await testEnv.CATALOG.prepare(
    `INSERT INTO verified_destination_read (id, account_id, authority, read_at, attempted_at, error)
     VALUES (1, '1e0170aaabc90ecf5f466128d1f0466a', 'operator', ?, ?, NULL)`,
  ).bind(readAt, readAt).run();
}

/** Every recipient's reason, by manifest, from the route as a client reads it, parsed with the contract. */
async function reasons(): Promise<Record<string, string | null>> {
  const response = await SELF.fetch(`${ORIGIN}/api/sends`, { headers: { cookie: await cookie() } });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const body = route("GET", "/api/sends").response!.parse(JSON.parse(text)) as {
    sends: Array<{ id: string; recipients: Array<{ delivery_reason: string | null }> }>;
  };
  return Object.fromEntries(body.sends.map((send) => [send.id, send.recipients[0]!.delivery_reason]));
}

describe("delivery_reason on GET /api/sends", () => {
  it("names a verified destination only while silent, handed over, and inside what a read proved", async () => {
    await aRead(READ);
    await aVerifiedRecipient("friend@gmail.com", FROM, UNTIL);
    // Mixed case on the send side: the stored address is folded, and the join folds the recipient.
    const proven = await aSend({ address: "Friend@Gmail.com" });
    const stranger = await aSend({ address: "stranger@example.net" });
    // An observed outcome always wins.
    const observed = await aSend({ address: "friend@gmail.com", delivery: "accepted" });
    // Never handed over: there is no silence to explain.
    const held = await aSend({ address: "friend@gmail.com", submission: "held" });
    // Handed over before the address was verified: it did not go the verified-destination way.
    await aVerifiedRecipient("late@gmail.com", "2026-09-27T12:00:00.000Z", UNTIL);
    const before = await aSend({ address: "late@gmail.com" });

    expect(await reasons()).toEqual({
      [proven]: "verified_destination",
      [stranger]: null,
      [observed]: null,
      [held]: null,
      [before]: null,
    });
  });

  it("names no reason for a recipient an event was published for, even one that set no state", async () => {
    // A complaint is stored attributed and sets no delivery state, so the row stays silent; the chip's note,
    // "no outcome is reported for verified destinations", would be false for this very row.
    await aRead(READ);
    await aVerifiedRecipient("friend@gmail.com", FROM, UNTIL);
    const complained = await aSend({ address: "friend@gmail.com" });
    const quiet = await aSend({ address: "friend@gmail.com" });
    await testEnv.CATALOG.prepare(
      `INSERT INTO send_recipient_events
         (event_id, org_id, manifest_id, recipient, event_type, transport_message_id, terminal, payload, received_at)
       VALUES ('evt_complained', ?, ?, 'Friend@Gmail.com', 'cf.email.sending.message.complained', NULL, 0, '{}', ?)`,
    ).bind(ORG, complained, UNTIL).run();

    expect(await reasons()).toEqual({ [complained]: null, [quiet]: "verified_destination" });
  });

  it("keeps a hand-over inside an interval a later read no longer extends", async () => {
    // Removed later: verified from < t <= until < the latest read. The interval proved it.
    await aRead("2026-09-28T09:00:00.000Z");
    await aVerifiedRecipient("gone@gmail.com", FROM, UNTIL);
    const inside = await aSend({ address: "gone@gmail.com" });
    // And after that interval ends, nothing explains a hand-over: the extrapolation is from the latest read only.
    const after = await aSend({ address: "gone@gmail.com", at: "2026-09-28T10:00:00.000Z" });
    expect(await reasons()).toEqual({ [inside]: "verified_destination", [after]: null });
  });

  it("extends the latest read to a hand-over after it, for an address that read still listed", async () => {
    await aRead(READ);
    await aVerifiedRecipient("friend@gmail.com", FROM, READ);
    const later = await aSend({ address: "friend@gmail.com", at: "2026-09-29T08:00:00.000Z" });
    expect(await reasons()).toEqual({ [later]: "verified_destination" });
  });
});
