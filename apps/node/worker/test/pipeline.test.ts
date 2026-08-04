import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { drainOutbox, pendingEvents } from "../src/outbox.ts";
import { dispatch, registeredTopics } from "../src/pipeline.ts";

const testEnv = env as unknown as Env;

async function enqueue(topic: string, ageMs = 60_000): Promise<string> {
  const ctx = createSystemCtx();
  const id = ctx.id("evt");
  await testEnv.CATALOG.prepare(
    "INSERT INTO outbox (id, org_id, topic, payload, published_at, created_at) VALUES (?,?,?,?,NULL,?)",
  ).bind(id, "org_pipeline", topic, "{}", new Date(ctx.now() - ageMs).toISOString()).run();
  return id;
}

beforeEach(async () => {
  await testEnv.CATALOG.prepare("DELETE FROM outbox").run();
});

describe("processing pipeline (#25)", () => {
  it("consumes a registered topic and marks it published", async () => {
    const ctx = createSystemCtx();
    const id = await enqueue("mail.ingress.accepted");

    const { drained } = await drainOutbox(testEnv, ctx, (event) => dispatch(testEnv, ctx, event));
    expect(drained).toBe(1);

    const row = await testEnv.CATALOG.prepare("SELECT published_at FROM outbox WHERE id = ?")
      .bind(id).first<{ published_at: string | null }>();
    expect(row?.published_at).not.toBeNull();
  });

  it("leaves an unregistered topic unpublished rather than silently marking it done", async () => {
    const ctx = createSystemCtx();
    await enqueue("mail.something.nobody.registered");

    const { drained } = await drainOutbox(testEnv, ctx, (event) => dispatch(testEnv, ctx, event));
    // Nothing consumed it, so nothing claims it was handled. This is the whole point of the registry:
    // adding a topic without deciding what consumes it fails loudly instead of vanishing.
    expect(drained).toBe(0);
    expect((await pendingEvents(testEnv, ctx)).length).toBe(1);
  });

  it("names the fix when a topic has no handler", async () => {
    const ctx = createSystemCtx();
    await expect(
      dispatch(testEnv, ctx, { id: "evt_x", orgId: "org_pipeline", topic: "unknown.topic", payload: "{}" }),
    ).rejects.toThrow(/E_NO_HANDLER/);
    await expect(
      dispatch(testEnv, ctx, { id: "evt_x", orgId: "org_pipeline", topic: "unknown.topic", payload: "{}" }),
    ).rejects.toThrow(/register it in HANDLERS/);
  });

  it("registers every topic the Node actually emits", async () => {
    // `ingress.ts` emits exactly this topic. A mismatch here means accepted mail would pile up
    // unpublished, which is the failure the registry is designed to make visible rather than silent.
    expect(registeredTopics()).toContain("mail.ingress.accepted");
  });

  it("is idempotent, because #9's model delivers at least once", async () => {
    const ctx = createSystemCtx();
    const event = { id: "evt_dup", orgId: "org_pipeline", topic: "mail.ingress.accepted", payload: "{}" };
    // The enqueue can succeed while the published-flag write fails, so a handler sees the same event
    // twice and must not care.
    await dispatch(testEnv, ctx, event);
    await expect(dispatch(testEnv, ctx, event)).resolves.toBeUndefined();
  });
});
