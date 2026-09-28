import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { hashPassword } from "../src/auth/password.ts";
import { ACCESS_COOKIE, login } from "../src/auth/session.ts";
import { zipOf } from "./support/zip.ts";

/**
 * `POST /api/sends` sends a file this Node judges dangerous only when the body says `allowDangerousAttachments:
 * true`, literally. The seal's own rule is covered in `outbound.test.ts`; this holds the route's half: that a
 * truthy string or a number, which a careless agent could send, is not the author saying so.
 */

const testEnv = env as unknown as Env;
const ORG = "org_send_dangerous";
const MAILBOX = "mbx_send_dangerous";
const USER = "usr_send_dangerous";
const PASSWORD = "fixture-password-not-a-real-secret";

beforeEach(async () => {
  for (const table of ["send_attachments", "send_manifests", "send_recipients", "send_counters", "relationship_tuples",
                       "addresses", "mailboxes", "users", "node_claim", "login_attempts", "sessions",
                       "refresh_tokens", "audit_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  const verifier = await hashPassword(PASSWORD);
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_send_dangerous", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)")
      .bind(ctx.id("addr"), ORG, "support@acme.example", MAILBOX, at),
    testEnv.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations, password_updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(USER, ORG, `${USER}@acme.example`, at, verifier.encoded, verifier.effectiveIterations, at),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, USER, "send.propose", "mailbox", MAILBOX, at),
  ]);
});

async function send(allow: unknown): Promise<Response> {
  const outcome = await login(testEnv, createSystemCtx(), ORG, `${USER}@acme.example`, PASSWORD);
  if (outcome.status !== "signed_in") throw new Error(`could not sign in: ${outcome.status}`);
  const code = zipOf([["verifylab/index.js", "export {}"]]);
  return SELF.fetch("https://node/api/sends", {
    method: "POST",
    headers: { cookie: `${ACCESS_COOKIE}=${outcome.session.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      mailboxId: MAILBOX, to: ["customer@example.net"], subject: "The code", body: "Attached.",
      attachments: [{ filename: "verifylab-1.0.0.zip", contentType: "application/zip", contentBase64: btoa(String.fromCharCode(...code)) }],
      ...(allow === undefined ? {} : { allowDangerousAttachments: allow }),
    }),
  });
}

describe("POST /api/sends with a zip of source code", () => {
  it("sends it when the body says allowDangerousAttachments: true", async () => {
    const response = await send(true);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }).id).toMatch(/^snd_/);
  });

  it("refuses it when the field is absent, or anything but the literal true", async () => {
    for (const allow of [undefined, "true", 1, false]) {
      const response = await send(allow);
      expect(response.status, `allowDangerousAttachments: ${JSON.stringify(allow)}`).toBe(422);
      expect(((await response.json()) as { error?: string }).error).toBe("E_ATTACHMENT_DANGEROUS");
    }
  });
});
