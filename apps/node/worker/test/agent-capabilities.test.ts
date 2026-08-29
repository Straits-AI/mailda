import { utf8 } from "@mailda/evidence";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { offerableCapabilities, requiresOf } from "@mailda/contract/capability";
import { ROUTES, type RouteSpec } from "@mailda/contract/routes";

import { mintAgent } from "../src/agents.ts";
import { putEvidence } from "../src/evidence-store.ts";

/**
 * Every capability, driven by an agent provisioned with exactly what it declares.
 *
 * ## The claim this exists to test
 *
 * > A capability is valid only when a minimally provisioned principal can execute every route it contains.
 *
 * Nothing proved that. `capability-world.test.ts` checks the declarations are internally complete — every
 * grantable route named once, every requirement drawn from a route's own authority — and a set of consistent
 * declarations can still be wrong about the handlers. Three were:
 *
 * - `mail.read` promised the original `.eml` on content read; the route also checks `message.export`.
 * - `send.observe` declared content read; `/submitted` shares the inbound raw path's decision, which is
 *   content read **and** export.
 * - Nine capabilities declared no relation while their routes check `org.admin`, which no mint can confer.
 *   An administrator could select `butler.read`, mint, and hand over a credential refused everywhere.
 *
 * Each of those is a promise a *declaration* test cannot falsify, because the declaration was the thing that
 * was wrong. Only a request can.
 *
 * ## What counts as passing
 *
 * Not a 200. Most of these routes need fixtures — a draft that exists, a send that was made — and building
 * every one would make this a suite about seeding rather than about authority. What is asserted is that no
 * route answers with an **authority** refusal: 401, or a 403 naming a missing relation. A 404 is allowed and
 * meaningful, because §5C makes an invisible thing and an absent one answer alike, so it is what a correctly
 * provisioned agent gets for a message id that does not exist.
 *
 * That is a weaker assertion than "it worked" and a much stronger one than "the lists agree", and it is the
 * one that fails on every defect above.
 */

const testEnv = env as unknown as Env;
const ORIGIN = "https://node.example";
const ORG = "org_capexec";
const ADMIN = "usr_CAPEXECADMN000000000000000";
const SPONSOR = "usr_CAPEXECSPNSR00000000000000";
const MAILBOX = "mbx_CAPEXECMBX0000000000000000";
const ADDRESS = "in@capexec.example";
const SEND = "snd_CAPEXECSND0000000000000000";
const RECEIPT = "rcpt_CAPEXECRCPT000000000000000";

/**
 * Routes with a real fixture behind them, which must answer **200**.
 *
 * The rest are checked for the absence of an authority refusal, and that is weaker than it looks: §5C makes an
 * invisible thing and an absent one answer alike, so a route that looks its resource up first answers 404 for
 * a non-existent id whatever the caller holds. Understating `mail.read`'s authority — the original defect —
 * therefore passed the weaker check, because the 404 arrived before the `message.export` test.
 *
 * So the routes where the defects were get a real message and are held to a success. That is what makes this
 * suite decisive rather than suggestive.
 */
const MUST_SUCCEED = new Set([
  "GET /api/mailboxes/readable",
  "GET /api/messages",
  "GET /api/messages/:receiptId/body",
  "GET /api/messages/:receiptId/raw",
  "GET /api/sends",
  "GET /api/sends/:sendId/submitted",
  "GET /api/mailboxes",
  "GET /api/mailboxes/:mailboxId/cases",
  "GET /api/drafts",
  "GET /api/notifications",
  "GET /api/me",
  "GET /health",
  "GET /api/doctor",
  "GET /api/breakers",
  "GET /api/domain-pauses",
  "GET /.well-known/jwks.json",
  "GET /api/auth/passkeys",
]);

async function tuple(subjectId: string, relation: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,'mailbox',?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectId, new Date(ctx.now()).toISOString()).run();
}

beforeEach(async () => {
  for (const table of ["relationship_tuples", "users", "node_claim", "mailboxes", "agents", "agent_actions"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table} WHERE 1=1`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind(ctx.id("clm"), "x", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(ADMIN, ORG, "admin@capexec.example", at),
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(SPONSOR, ORG, "sponsor@capexec.example", at),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Enquiries", at),
  ]);
  /*
   * A real message, so the routes that look one up can answer 200 rather than the §5C 404 that hides an
   * authority refusal.
   */
  const raw = utf8([
    "From: someone@capexec.example",
    `To: ${ADDRESS}`,
    "Subject: capability execution",
    "Message-ID: <capexec-1@capexec.example>",
    "Date: Mon, 3 Aug 2026 12:00:00 +0000",
    "",
    "body text",
  ].join("\r\n"));
  await putEvidence(testEnv, `${ORG}/raw/${RECEIPT}`, raw);
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare(
      "INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    testEnv.CATALOG.prepare(
      `INSERT OR IGNORE INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
         raw_bytes, blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(RECEIPT, ORG, `evt_${RECEIPT}`, "someone@capexec.example", ADDRESS, raw.byteLength,
      `${ORG}/raw/${RECEIPT}`, "0".repeat(64), at),
  ]);

  /*
   * A sealed send with submitted bytes, so `/submitted` can answer 200 and its authority is actually tested.
   * Without it that route 404s for everybody, and understating its requirement — the `send.observe` defect —
   * passed unnoticed.
   */
  const submitted = utf8("From: x@capexec.example\r\nSubject: out\r\n\r\nsent");
  await putEvidence(testEnv, `${ORG}/submitted/${SEND}`, submitted);
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO send_manifests
       (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to, subject, rfc_message_id,
        fidelity, body_typed_key, body_typed_sha256, body_normalized_key, body_normalized_sha256,
        submitted_key, submitted_sha256, sealed_at, release_at, state, state_at)
     VALUES (?,?,?,?,?,?,?,?,'authored',?,?,?,?,?,?,?,?,'sent',?)`,
  ).bind(SEND, ORG, MAILBOX, SPONSOR, ADDRESS, JSON.stringify(["out@example.test"]), "out",
    `<${SEND}@capexec.example>`, `${ORG}/typed/${SEND}`, "0".repeat(64), `${ORG}/norm/${SEND}`,
    "0".repeat(64), `${ORG}/submitted/${SEND}`, "0".repeat(64), at, at, at).run();

  await tuple(ADMIN, "org.admin", ORG);
  // `org.admin`'s object is the organization, not a mailbox — written directly for that one.
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,'org.admin','organization',?,?)`,
  ).bind(ctx.id("rt"), ORG, ADMIN, ORG, at).run();
});

/** A concrete URL for a route template, with ids that are well-formed and refer to nothing. */
function urlFor(spec: RouteSpec): string {
  return spec.path
    .replace(":mailboxId", MAILBOX)
    .replace(":receiptId", RECEIPT)
    .replace(":sendId", SEND)
    .replace(":draftId", "dft_CAPEXECDFT0000000000000000")
    .replace(":exportId", "exp_CAPEXECEXP0000000000000000")
    .replace(":objectId", "object-1")
    .replace(":butlerId", "btl_CAPEXECBT00000000000000000")
    .replace(":policyId", "pol_CAPEXECP000000000000000000")
    .replace(":runId", "btr_CAPEXECBTR0000000000000000");
}

/**
 * The minimum body a route needs to get past its own shape validation.
 *
 * Only what a route cannot answer without. `PUT /api/drafts` reads `String(body.mailboxId ?? "")` and asks
 * `maySend` about the result, so an empty body produces `E_MAY_NOT_SEND_AS_MAILBOX` for the mailbox `""` —
 * an authority-shaped refusal about a fixture rather than about authority. The suite flagged it, which is the
 * check working: a 403 naming a relation is exactly what it is looking for, and it is this file's job to make
 * sure the only ones left are real.
 */
const BODIES: Record<string, unknown> = {
  "PUT /api/drafts": { mailboxId: MAILBOX, to: ["someone@example.test"], subject: "x", body: "y" },
};

describe("every offered capability can be executed by an agent provisioned for it", () => {
  const byRoute = new Map(
    (ROUTES as readonly RouteSpec[]).map((spec) => [`${spec.method} ${spec.path}`, spec]),
  );

  for (const capability of offerableCapabilities()) {
    it(`${capability.id}: no route answers with an authority refusal`, async () => {
      /*
       * **The minimum the capability declares**, on one mailbox, and nothing else. Granting more would prove
       * that some provisioning works rather than that this one does, which is the difference between this
       * suite and the declaration test beside it.
       */
      const relations = requiresOf(capability);
      for (const relation of relations) {
        await tuple(SPONSOR, relation, MAILBOX);
      }
      const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
        name: `exec-${capability.id}`,
        sponsorUserId: SPONSOR,
        capabilities: [capability.id],
        grants: relations.map((relation) => ({ mailboxId: MAILBOX, relation })),
      });

      const refusals: string[] = [];
      for (const route of capability.routes) {
        const spec = byRoute.get(route)!;
        const response = await SELF.fetch(`${ORIGIN}${urlFor(spec)}`, {
          method: spec.method,
          headers: {
            authorization: `Bearer ${minted.token}`,
            ...(spec.method === "GET" ? {} : { "content-type": "application/json" }),
          },
          ...(spec.method === "GET" ? {} : { body: JSON.stringify(BODIES[route] ?? {}) }),
        });

        /*
         * 401 is always wrong here: the credential is valid, current and inside its ceiling. 403 is wrong
         * when it names authority — `E_AGENT_ACTION_NOT_PERMITTED` means the ceiling did not contain a route
         * its own capability listed, and `E_NOT_AN_ADMINISTRATOR` is the nine-capability defect exactly.
         *
         * A 404 passes, deliberately: §5C makes an invisible thing and an absent one answer alike, so it is
         * what a correctly provisioned agent gets for an id that refers to nothing.
         */
        if (response.status === 401) {
          refusals.push(`${route} → 401 unauthenticated`);
          continue;
        }
        if (response.status === 403) {
          const body = await response.json<{ error?: string }>().catch(() => null);
          refusals.push(`${route} → 403 ${body?.error ?? "forbidden"}`);
          continue;
        }
        /*
         * A route with a fixture must **succeed**. §5C means an under-provisioned caller gets the same 404 as
         * one asking about nothing, so on these routes 404 is the authority refusal wearing a disguise — and
         * it is exactly how understating `mail.read`'s authority passed the weaker check.
         */
        if (MUST_SUCCEED.has(route) && response.status !== 200) {
          refusals.push(`${route} → ${response.status} with a real fixture behind it`);
        }
      }

      expect(
        refusals,
        `${capability.id} promises routes an agent provisioned with exactly its declared relations `
        + `(${relations.join(", ") || "none"}) cannot reach:\n  ${refusals.join("\n  ")}`,
      ).toEqual([]);
    });
  }

  it("drives something, so a broken loop cannot pass by asserting over nothing", () => {
    // The control this suite most needs: an empty capability list, or a `routes` array that stopped being
    // read, would make every case above pass by checking no requests at all.
    const offered = offerableCapabilities();
    expect(offered.length, "no capabilities are offered").toBeGreaterThan(5);
    expect(offered.every((one) => one.routes.length > 0)).toBe(true);
    for (const capability of offered) {
      for (const route of capability.routes) {
        expect(byRoute.get(route), `${capability.id} names ${route}, which the registry does not declare`)
          .toBeDefined();
      }
    }
  });
});
