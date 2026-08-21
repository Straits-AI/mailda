import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { hashPassword } from "../src/auth/password.ts";
import { login } from "../src/auth/session.ts";

/**
 * Authoring a Butler **through the HTTP surface** (#77).
 *
 * `test/butlers.test.ts` calls `createButlerDraft`, `editButlerDraft` and `publishButler` directly. They
 * passed, and they were unreachable: nothing in the request path imported them, so the only way to publish a
 * Butler was to insert `butler_versions` rows with `wrangler d1 execute --remote`. That is the out-of-band
 * edit `interpret.ts` re-checks against in its own header — the defence existed and the front door did not,
 * which inverted #49's central decision that a Butler is runtime data so publishing needs no deploy.
 *
 * A function-level test cannot catch that, and this is the shape of test that can: it asserts the *plane is
 * reachable*, which is the same reason `policy-routes.test.ts` exists beside `policy.test.ts`.
 *
 * Four claims, each about what a caller is told:
 *
 *   - a Butler can be created, edited and published by an administrator, and the published version is what
 *     `butler_versions` actually holds;
 *   - a member without `org.admin` is refused **on the writes** and gets **404 on the reads** — 403 there
 *     would confirm that Butlers exist here, which is the oracle §5C closes;
 *   - the checker refuses a bad program **through the route**, so `checkButler` is a gate a person walks
 *     into rather than one only reachable from a test;
 *   - the list reports a pause a machine placed, because "published" and "running" are different facts and a
 *     list showing only the first is the enablement pointer #66 rejected.
 */

const testEnv = env as unknown as Env;
const ORG = "org_butler_routes";
const MAILBOX = "mbx_butler_routes";
const ADDRESS = "support@acme.example";
const ADMIN = "usr_btlroutes_admin";
const ANA = "usr_btlroutes_ana";
const PASSWORD = "fixture-password-not-a-real-secret";

/** A Butler that touches nothing: a guard and two stops need no capability, so the ceiling is empty. */
function source(name: string, reason = "nothing to answer"): string {
  return JSON.stringify({
    apiVersion: "mailda/v1",
    kind: "Butler",
    metadata: { name, owner: "team:support" },
    capabilities: [],
    trigger: { event: "mail.received", mailbox: ADDRESS },
    entry: "look",
    nodes: [
      { id: "look", type: "guard", when: "event.parse_error != null", then: "halt", otherwise: "halt" },
      { id: "halt", type: "stop", reason },
    ],
  });
}

async function sessionFor(userId: string): Promise<string> {
  const ctx = createSystemCtx();
  const outcome = await login(testEnv, ctx, ORG, `${userId}@acme.example`, PASSWORD);
  if (outcome.status !== "signed_in") throw new Error(`could not sign in ${userId}: ${outcome.status}`);
  return outcome.session.accessToken;
}

function as(token: string, body?: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { cookie: `mailda_at=${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function read(token: string): RequestInit {
  return { headers: { cookie: `mailda_at=${token}` } };
}

beforeEach(async () => {
  for (const table of ["butler_pauses", "butler_run_effects", "butler_runs", "butler_versions", "butlers",
                       "relationship_tuples", "addresses", "mailboxes", "users", "node_claim",
                       "login_attempts", "sessions", "refresh_tokens", "audit_entries", "outbox"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_btlroutes", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
  ]);

  for (const userId of [ADMIN, ANA]) {
    await testEnv.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations,
         password_updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, ORG, `${userId}@acme.example`, at, verifier.encoded, verifier.effectiveIterations, at)
      .run();
  }

  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, ADMIN, "org.admin", "organization", ORG, at).run();
});

describe("a Butler can be written through the product, and only by an administrator", () => {
  it("creates, edits, publishes and reads one back", async () => {
    const token = await sessionFor(ADMIN);

    const created = await SELF.fetch("https://node/api/butlers", as(token, {
      name: "acknowledge", source: source("acknowledge"),
    }));
    expect(created.status).toBe(200);
    const { butler } = await created.json() as { butler: { butlerId: string; versionId: string } };

    // Editing replaces the draft rather than minting a version: publication is the versioning event (#49).
    const edited = await SELF.fetch(
      `https://node/api/butlers/${butler.butlerId}/draft`,
      as(token, { source: source("acknowledge", "still nothing to answer") }, "PUT"),
    );
    expect(edited.status).toBe(200);

    const published = await SELF.fetch(`https://node/api/butlers/${butler.butlerId}/publish`, as(token));
    expect(published.status).toBe(200);
    type Published = { published: { versionId: string; version: number } };
    const { published: version } = await published.json() as Published;
    expect(version.version).toBe(1);

    // What the database holds, not what the response claimed about it.
    const row = await testEnv.CATALOG.prepare(
      "SELECT state, version, published_by FROM butler_versions WHERE id = ?",
    ).bind(version.versionId).first<{ state: string; version: number; published_by: string }>();
    // `published_by` is the sponsor whose live authority caps the version (#51), so the route's principal is
    // load-bearing rather than decorative — an anonymous publish would leave this NULL and uncapped.
    expect(row).toEqual({ state: "published", version: 1, published_by: ADMIN });

    const listed = await SELF.fetch("https://node/api/butlers", read(token));
    expect(listed.status).toBe(200);
    const { butlers } = await listed.json() as {
      butlers: Array<{ id: string; name: string; live_version: number | null; pause: unknown }>;
    };
    expect(butlers).toHaveLength(1);
    expect(butlers[0]!.name).toBe("acknowledge");
    expect(butlers[0]!.live_version).toBe(1);
    expect(butlers[0]!.pause).toBeNull();

    /*
     * A second version, so the three states are all present and the source rule can be checked where it
     * actually bites. With one version the rule is unfalsifiable: every row is the live one.
     */
    await SELF.fetch(
      `https://node/api/butlers/${butler.butlerId}/draft`,
      as(token, { source: source("acknowledge", "second version") }, "PUT"),
    );
    await SELF.fetch(`https://node/api/butlers/${butler.butlerId}/publish`, as(token));

    const one = await SELF.fetch(`https://node/api/butlers/${butler.butlerId}`, read(token));
    expect(one.status).toBe(200);
    const { versions } = await one.json() as {
      versions: Array<{ state: string; version: number | null; source_text: string | null }>;
    };
    expect(versions).toHaveLength(2);

    const byState = new Map(versions.map((row) => [row.state, row]));
    /*
     * **The live version's body travels**, because editing a published Butler means editing what is running.
     * Withholding it rendered an empty editor over a live Butler — which reads as "no program" and invites a
     * replacement written from scratch.
     */
    // Asserted non-null first, so withholding it fails with "expected null not to be null" rather than
    // chai complaining that `toContain` was handed the wrong type.
    expect(byState.get("published")?.source_text).not.toBeNull();
    expect(byState.get("published")?.source_text).toContain("second version");
    /*
     * **A superseded one's does not.** Its body is immutable and already named by `source_sha256`, and
     * returning every historical source would make this response grow with the number of times anybody ever
     * edited this Butler — a list endpoint that returns every version of every program is an export.
     */
    expect(byState.get("superseded")?.source_text).toBeNull();
    expect(byState.get("superseded")?.version).toBe(1);
  });

  it("refuses the checker's findings through the route rather than only in a test", async () => {
    const token = await sessionFor(ADMIN);
    const reserved = JSON.stringify({
      apiVersion: "mailda/v1",
      kind: "Butler",
      metadata: { name: "classify", owner: "team:support" },
      capabilities: [],
      trigger: { event: "mail.received", mailbox: ADDRESS },
      entry: "think",
      nodes: [{ id: "think", type: "llm.classify", prompt: "is this urgent" }],
    });
    const created = await SELF.fetch("https://node/api/butlers", as(token, {
      name: "classify", source: reserved,
    }));
    expect(created.status).toBeGreaterThanOrEqual(400);
    // Nothing was written: a refused program must not leave a Butler behind for somebody to publish later.
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM butlers").first<{ n: number }>())
      .toEqual({ n: 0 });
  });

  it("refuses a member who is not an administrator, and tells them nothing on a read", async () => {
    const admin = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/butlers", as(admin, {
      name: "acknowledge", source: source("acknowledge"),
    }));
    const { butler } = await created.json() as { butler: { butlerId: string } };

    const ana = await sessionFor(ANA);
    const write = await SELF.fetch("https://node/api/butlers", as(ana, {
      name: "mine", source: source("mine"),
    }));
    expect(write.status).toBe(403);
    expect((await write.json() as { error: string }).error).toBe("E_NOT_AN_ADMINISTRATOR");

    // 404 on the reads, not 403: a refusal that distinguishes "you may not" from "there is nothing" is an
    // oracle for whether this organization automates anything at all (§5C).
    expect((await SELF.fetch("https://node/api/butlers", read(ana))).status).toBe(404);
    expect((await SELF.fetch(`https://node/api/butlers/${butler.butlerId}`, read(ana))).status).toBe(404);

    // And an unauthenticated caller is told to sign in rather than given either answer.
    expect((await SELF.fetch("https://node/api/butlers")).status).toBe(401);
  });

  it("reports a pause the machine placed, beside the Butler it stopped", async () => {
    const token = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/butlers", as(token, {
      name: "acknowledge", source: source("acknowledge"),
    }));
    const { butler } = await created.json() as { butler: { butlerId: string } };
    await SELF.fetch(`https://node/api/butlers/${butler.butlerId}/publish`, as(token));

    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      `INSERT INTO butler_pauses (id, org_id, butler_id, reason, detail, tripped_by, placed_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("bpz"), ORG, butler.butlerId, "loop_suspected",
      "three self-provoked links in the window", "loop_detector",
      new Date(ctx.now()).toISOString()).run();

    const listed = await SELF.fetch("https://node/api/butlers", read(token));
    const { butlers } = await listed.json() as {
      butlers: Array<{ live_version: number | null; pause: { reason: string } | null }>;
    };
    // Published *and* stopped: a list reporting only the first would read as "deployed and working" over a
    // Butler a breaker halted, which is the enablement pointer #66 rejected.
    expect(butlers[0]!.live_version).toBe(1);
    expect(butlers[0]!.pause?.reason).toBe("loop_suspected");
  });
});
