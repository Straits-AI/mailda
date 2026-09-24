import { describe, expect, it } from "vitest";

import { onboardingSteps, type Sources } from "../../src/client/app/onboarding.tsx";
import type { DeliveryRow, DoctorReport, ProviderBinding, RoutingRow } from "../../src/client/app/api.ts";

/**
 * Onboarding progress is derived from structured fields, and each step's three states are told apart.
 *
 * What would be wrong and still render plausibly: a step reading "done" from a source that was never asked
 * (an unconnected Node showing routing as done because the list was empty), or "to do" for a source that
 * could not be read (a grant hiccup reading as "not routed"). Those are the assertions.
 */

const binding = (overrides: Partial<ProviderBinding> = {}): ProviderBinding => ({
  state: "consent_granted", evidence: "observed", clientId: "c", redirectUri: "https://n/cb",
  registeredAt: null, accountId: "acc", grantedAt: null, scopesGranted: [], scopesMissing: [], refusedDetail: null,
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

describe("onboarding steps", () => {
  it("is all done when every source says so", () => {
    expect(byId({ provider: binding(), doctor: doctor(true), routing: [routing()], delivery: [delivery()] }))
      .toEqual({ connected: "done", address: "done", routed: "done", sending: "done", outcomes: "done" });
  });

  it("is not connected while a scope is missing, and the later steps are unknown, not to do", () => {
    const steps = byId({ provider: binding({ scopesMissing: ["dns.write"] }), doctor: doctor(false) });
    expect(steps).toEqual({ connected: "todo", address: "todo", routed: "unknown", sending: "unknown", outcomes: "unknown" });
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
