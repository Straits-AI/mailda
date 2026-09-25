import { describe, expect, it } from "vitest";

import { onboardingSteps, type Sources } from "../../src/client/app/onboarding.tsx";
import type { DeliveryRow, DoctorReport, ProviderBinding, Provisioned, RoutingRow } from "../../src/client/app/api.ts";

/**
 * Onboarding progress is derived from structured fields, and each step's three states are told apart.
 *
 * What would be wrong and still render plausibly: a step reading "done" from a source that was never asked
 * (an unconnected Node showing routing as done because the list was empty), or "to do" for a source that
 * could not be read (a grant hiccup reading as "not routed"). Those are the assertions.
 */

const binding = (overrides: Partial<ProviderBinding> = {}): ProviderBinding => ({
  state: "token_held", accountId: "acc", accountName: "Example", registeredAt: null, verifiedAt: null,
  ...overrides,
});
const doctor = (addressOk: boolean): DoctorReport => ({
  verdict: "ok", claimed: true, at: "2026-09-24T00:00:00Z",
  findings: [{ check: "inbound_routing", severity: "report", ok: addressOk, detail: "prose the checklist must not read" }],
});
const routing = (over: Partial<RoutingRow> = {}): RoutingRow => ({
  domain: "mail.example.test", zone: "example.test", zoneId: "z", enabled: true, status: "ready", required: [], error: null, ...over,
});
const delivery = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  domain: "example.test", zone: "example.test",
  sending: { name: "example.test", enabled: true, returnPath: null, dkimSelector: null, required: [], error: null },
  subscription: "sub", subscriptionId: "s1", enabled: true, events: ["email.sending"], queueId: "q", queueName: "mailda-sending-events",
  consumers: ["mailda"], error: null, ...over,
});
const byId = (sources: Sources) => Object.fromEntries(onboardingSteps(sources).map((step) => [step.id, step.state]));
const NONE: Provisioned = { receiving: null, sending: null, deliveryEvents: null };
const RECORD: Provisioned = {
  receiving: { domain: "mail.example.test", at: "2026-09-24T10:00:00Z", authority: "operator", address: "hello@mail.example.test" },
  sending: { domain: "mail.example.test", at: "2026-09-24T10:01:00Z", authority: "operator", address: null },
  deliveryEvents: null,
};

describe("onboarding steps", () => {
  it("is all done when every source says so", () => {
    expect(byId({ provider: binding(), doctor: doctor(true), routing: [routing()], delivery: [delivery()] }))
      .toEqual({ connected: "done", address: "done", routed: "done", sending: "done", outcomes: "done" });
  });

  it("is optional when no token is held, and the later steps are unknown, not to do", () => {
    const steps = byId({ provider: binding({ state: "no_token", accountId: null, accountName: null }), doctor: doctor(false) });
    expect(steps).toEqual({ connected: "optional", address: "todo", routed: "unknown", sending: "unknown", outcomes: "unknown" });
  });

  it("calls the connection optional, not to do, when there is no client at all", () => {
    expect(byId({ provider: binding({ state: "no_token", accountId: null, accountName: null }), doctor: doctor(true), provisioned: NONE }).connected).toBe("optional");
    // The count leaves it out: four steps, and the fifth is optional.
    const counted = onboardingSteps({ provider: binding({ state: "no_token", accountId: null, accountName: null }), doctor: doctor(true), provisioned: NONE })
      .filter((step) => step.state !== "optional");
    expect(counted.map((step) => step.id)).toEqual(["address", "routed", "sending", "outcomes"]);
  });

  it("stands the audit trail's record in for the account when there is no grant, and calls it a record", () => {
    const steps = onboardingSteps({ provider: binding({ state: "no_token", accountId: null, accountName: null }), doctor: doctor(true), provisioned: RECORD });
    const routed = steps.find((step) => step.id === "routed")!;
    expect(routed.state).toBe("done");
    expect(routed.detail).toContain("at install");
    expect(routed.detail).toContain("a record, not a live read");
    expect(steps.find((step) => step.id === "sending")!.state).toBe("done");
    // Nothing recorded for delivery events is to do, not unknown: the record was read and had nothing.
    expect(steps.find((step) => step.id === "outcomes")!.state).toBe("todo");
  });

  it("lets a live read win over the record once connected", () => {
    const steps = byId({ provider: binding(), doctor: doctor(true), provisioned: RECORD, routing: [routing({ enabled: false })], delivery: [] });
    expect(steps.routed).toBe("todo");
    expect(steps.sending).toBe("todo");
  });

  it("tells an unreadable source from an empty one", () => {
    expect(byId({ provider: binding(), doctor: null, routing: null, delivery: null }).routed).toBe("unknown");
    expect(byId({ provider: binding(), doctor: null, routing: [], delivery: [] }).routed).toBe("todo");
    expect(byId({ provider: binding(), doctor: null, routing: [], delivery: [] }).address).toBe("unknown");
  });

  it("does not call a domain routed while a record is still required or routing is off", () => {
    expect(byId({ provider: binding(), doctor: doctor(true), routing: [routing({ required: [{ type: "MX", name: "x", content: "y", priority: 1 }] })] }).routed).toBe("todo");
    expect(byId({ provider: binding(), doctor: doctor(true), routing: [routing({ enabled: false })] }).routed).toBe("todo");
  });

  it("separates sending from outcomes: onboarded for sending but no consumer is outcomes to do", () => {
    const steps = byId({ provider: binding(), doctor: doctor(true), routing: [routing()], delivery: [delivery({ consumers: [] })] });
    expect(steps.sending).toBe("done");
    expect(steps.outcomes).toBe("todo");
    const detail = onboardingSteps({ provider: binding(), doctor: doctor(true), delivery: [delivery({ consumers: [] })] }).find((s) => s.id === "outcomes")!.detail;
    expect(detail).toContain("no consumer");
  });
});

describe("readiness", () => {
  it("is ready only with an address and mail routed here; sending and outcomes do not gate", async () => {
    const { readinessOf } = await import("../../src/client/app/onboarding.tsx");
    const steps = onboardingSteps({ provider: binding({ state: "no_token", accountId: null, accountName: null }), doctor: doctor(true), provisioned: { receiving: { domain: "d", at: "2026-09-24T00:00:00.000Z", authority: "operator", address: null }, sending: null, deliveryEvents: null } });
    expect(readinessOf(steps)).toBe("ready");
    expect(readinessOf(onboardingSteps({ provider: binding({ state: "no_token", accountId: null, accountName: null }), doctor: doctor(true), provisioned: { receiving: null, sending: null, deliveryEvents: null } }))).toBe("not-ready");
    expect(readinessOf(onboardingSteps({ provider: binding({ state: "no_token", accountId: null, accountName: null }), doctor: doctor(false), provisioned: { receiving: { domain: "d", at: "2026-09-24T00:00:00.000Z", authority: "operator", address: null }, sending: null, deliveryEvents: null } }))).toBe("not-ready");
  });
});
