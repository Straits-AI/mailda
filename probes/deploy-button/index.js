import { DurableObject } from "cloudflare:workers";

export class MailboxDO extends DurableObject {
  async ping() {
    return "mailbox-do-ok";
  }
}

export default {
  async fetch(request, env) {
    // Report what actually got bound, which is the whole point of the probe.
    const report = { worker: "node", bindings: {} };

    try {
      const row = await env.CATALOG.prepare("SELECT 1 AS ok").first();
      report.bindings.d1 = row?.ok === 1 ? "ok" : "unexpected";
    } catch (error) {
      report.bindings.d1 = `error: ${error.message}`;
    }
    try {
      await env.EVIDENCE.head("probe");
      report.bindings.r2 = "ok";
    } catch (error) {
      report.bindings.r2 = `error: ${error.message}`;
    }
    try {
      report.bindings.durableObject = await env.MAILBOX.getByName("probe").ping();
    } catch (error) {
      report.bindings.durableObject = `error: ${error.message}`;
    }
    try {
      const res = await env.EFFECTS.fetch(new Request("https://effects/"));
      report.bindings.serviceBinding = (await res.json()).worker;
    } catch (error) {
      report.bindings.serviceBinding = `error: ${error.message}`;
    }
    report.bindings.queueProducer = typeof env.INBOUND?.send === "function" ? "ok" : "missing";

    return Response.json(report, { headers: { "content-type": "application/json" } });
  },
};
