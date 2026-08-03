import { createSystemCtx } from "@mailda/runtime";

import type { Env } from "./env.ts";
import { acceptInbound } from "./ingress.ts";
import { streamEvidence } from "./evidence-store.ts";

/**
 * The Mailda Node. One Worker (ADR 18).
 *
 * Layer 1 of the ladder in AGENTS.md: receive one real internet message, store it
 * losslessly, and show it to one authorized human.
 */
export default {
  /** Cloudflare Email Routing invokes this with a real message (§13). */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const ctx = createSystemCtx();
    const org = await env.CATALOG.prepare("SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1")
      .first<{ org_id: string }>();

    if (org === null) {
      // An unclaimed Node has no organization to deliver to. Reject loudly rather than
      // accept mail we cannot attribute — §13 forbids silently losing an accepted message.
      message.setReject("Mailda Node is not yet claimed");
      return;
    }

    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const result = await acceptInbound(env, ctx, org.org_id, {
      // Message-ID is the provider's identity for this delivery. §14 keeps Mailda's own
      // trace identity separate and never assumes it can override provider headers.
      providerEventId: message.headers.get("message-id") ?? `no-message-id:${await hash(raw)}`,
      envelopeFrom: message.from,
      envelopeTo: message.to,
      raw,
    });

    if (result.status === "unknown_recipient") {
      message.setReject("No such recipient at this Mailda Node");
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const ctx = createSystemCtx();

    if (url.pathname === "/health") {
      return Response.json({ node: "mailda", layer: 1, at: new Date(ctx.now()).toISOString() });
    }

    // Original .eml, streamed frame by frame so a 25 MiB message is never buffered (#16).
    const evidence = /^\/api\/messages\/([^/]+)\/raw$/.exec(url.pathname);
    if (evidence && request.method === "GET") {
      const { authorize } = await import("./authz-read.ts");
      const allowed = await authorize(env, request, evidence[1]!);
      if (!allowed.ok) return allowed.response;
      return new Response(await streamEvidence(env, allowed.blobKey), {
        headers: {
          "content-type": "message/rfc822",
          "content-disposition": `attachment; filename="${evidence[1]}.eml"`,
        },
      });
    }

    if (url.pathname === "/api/messages" && request.method === "GET") {
      const { listMessages } = await import("./authz-read.ts");
      return listMessages(env, request);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function hash(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
