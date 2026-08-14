import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { sealManifest } from "../src/outbound/manifest.ts";
import { mailboxQueues } from "../src/cases.ts";
import { CallerError } from "../src/errors.ts";

/**
 * Which address a send goes out as, when the mailbox has more than one.
 *
 * ## The silent choice
 *
 * `addresses` is `UNIQUE (org_id, address)` — **not** unique on `mailbox_id` — so several addresses may route
 * to one mailbox. From was then chosen by `ORDER BY created_at LIMIT 1`: **the oldest**. So an organisation
 * that added `billing@` to its support mailbox sent billing replies as `support@`, decided by a timestamp,
 * with nothing anywhere saying so.
 *
 * The authorization grain is unchanged and deliberately so — `send.propose` is bound to the **mailbox**, per
 * ADR 36, and §16's `sender:` grain stays deferred. What changed is that the *choice* is no longer silent:
 * one address is used without ceremony, a named one is verified against the mailbox, and more than one with
 * none named is **refused**, naming them. Refusing rather than picking is the move merge made, for the same
 * reason: a choice with consequences for every recipient must not be made by `created_at`.
 *
 * ## Why the composer had to change in the same breath
 *
 * A refusal a person cannot comply with is a dead end, so `mailboxQueues` now carries the mailbox's addresses
 * and the composer offers a From selector when there is a choice. The last test here pins that the data
 * needed to comply actually reaches the client — without it the refusal would be a wall.
 */

const testEnv = env as unknown as Env;
const ORG = "org_sender";
const ONE = "mbx_one";
const MANY = "mbx_many";
const AUTHOR = "usr_author";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

const composition = (mailboxId: string, senderAddress?: string) => ({
  mailboxId,
  authorUserId: AUTHOR,
  to: ["customer@example.net"],
  subject: "Re: invoice",
  bodyTyped: "Answered.",
  fidelity: "authored" as const,
  ...(senderAddress === undefined ? {} : { senderAddress }),
});

beforeEach(async () => {
  for (const table of ["send_manifests", "send_recipients", "send_counters", "addresses", "mailboxes",
                       "relationship_tuples", "audit_entries", "outbox", "cases", "conversations"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  const older = "2026-01-01T00:00:00.000Z";
  const newer = "2026-06-01T00:00:00.000Z";
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(ONE, ORG, "Solo", at),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MANY, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, "solo@acme.example", ONE, at),
    // Deliberately ordered: `support@` is older, so it is what the previous behaviour would have picked for
    // every send from this mailbox, including the billing ones.
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, "support@acme.example", MANY, older),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, "billing@acme.example", MANY, newer),
    ...[ONE, MANY].map((mailboxId) => testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'send.propose','mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, AUTHOR, mailboxId, at)),
  ]);
});

describe("choosing which address a send goes out as", () => {
  it("needs no ceremony when the mailbox has one address", async () => {
    // The overwhelming majority of mailboxes, and the whole reason this change is not breaking: absent
    // `senderAddress` still means "use the one address".
    const sealed = await sealManifest(testEnv, atTime(2_600_000_000_000), ORG, composition(ONE));
    expect(sealed.state).toBe("held");
  });

  it("refuses rather than picking the oldest when there is a choice", async () => {
    const failure = await sealManifest(testEnv, atTime(2_600_000_000_000), ORG, composition(MANY))
      .catch((error: unknown) => error as CallerError);

    expect(failure).toBeInstanceOf(CallerError);
    expect((failure as CallerError).code).toBe("E_SENDER_AMBIGUOUS");
  });

  it("names the addresses in the refusal, because the fix is to pick one", async () => {
    const failure = await sealManifest(testEnv, atTime(2_600_000_000_000), ORG, composition(MANY))
      .catch((error: unknown) => error as CallerError);

    const text = JSON.stringify(failure, Object.getOwnPropertyNames(failure));
    expect(text).toContain("support@acme.example");
    expect(text).toContain("billing@acme.example");
  });

  it("accepts a named address that belongs to the mailbox", async () => {
    const sealed = await sealManifest(
      testEnv, atTime(2_600_000_000_000), ORG, composition(MANY, "billing@acme.example"),
    );
    expect(sealed.state).toBe("held");

    const row = await testEnv.CATALOG.prepare(
      "SELECT envelope_from FROM send_manifests WHERE id = ?",
    ).bind(sealed.id).first<{ envelope_from: string }>();
    // The chosen one, not the oldest — which is the whole point.
    expect(row?.envelope_from).toBe("billing@acme.example");
  });

  it("does not care about capitalisation, because a display echoes it back", async () => {
    const sealed = await sealManifest(
      testEnv, atTime(2_600_000_000_000), ORG, composition(MANY, "Billing@Acme.Example"),
    );
    expect(sealed.state).toBe("held");
  });

  it("refuses an address that belongs to a different mailbox", async () => {
    // Otherwise `senderAddress` would be a way to send as an address routed somewhere the author may hold
    // nothing, which is exactly the authority `send.propose` is bound to.
    const failure = await sealManifest(
      testEnv, atTime(2_600_000_000_000), ORG, composition(MANY, "solo@acme.example"),
    ).catch((error: unknown) => error as CallerError);

    expect((failure as CallerError).code).toBe("E_SENDER_NOT_ON_MAILBOX");
  });

  it("refuses an address that exists nowhere", async () => {
    const failure = await sealManifest(
      testEnv, atTime(2_600_000_000_000), ORG, composition(MANY, "attacker@example.net"),
    ).catch((error: unknown) => error as CallerError);

    expect((failure as CallerError).code).toBe("E_SENDER_NOT_ON_MAILBOX");
  });

  it("hands the client the addresses it needs to comply", async () => {
    // Without this the refusal above is a wall: a person told to name one of two addresses has no way to
    // learn what they are. The composer renders a From selector from exactly this field.
    const queues = await mailboxQueues(testEnv, ORG, AUTHOR);
    const many = queues.find((queue) => queue.id === MANY);

    expect(many?.addresses).toContain("support@acme.example");
    expect(many?.addresses).toContain("billing@acme.example");
    // Oldest first, so a selector's order matches the order the refusal lists them in.
    expect(many!.addresses.indexOf("support@")).toBeLessThan(many!.addresses.indexOf("billing@"));
  });
});
