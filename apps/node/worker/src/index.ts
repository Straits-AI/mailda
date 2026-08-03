import { createSystemCtx } from "@mailda/runtime";

import { claimNode, sessionCookie } from "./claim.ts";
import { streamEvidence } from "./evidence-store.ts";
import { acceptInbound } from "./ingress.ts";
import { listMessages, authorize, principalFor } from "./authz-read.ts";
import { page } from "./ui.ts";

export { OutboxSweeper } from "./outbox.ts";

/**
 * The Mailda Node. One Worker (ADR 18).
 *
 * Layer 1 of the ladder in AGENTS.md: receive one real internet message, store it
 * losslessly, and show it to one authorized human.
 */
export default {
  /** Cloudflare Email Routing invokes this with a real message (§13). */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const clock = createSystemCtx();
    const claimed = await env.CATALOG.prepare(
      "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
    ).first<{ org_id: string }>();

    if (claimed?.org_id == null) {
      // Reject rather than accept mail we cannot attribute. §13 forbids losing an accepted
      // message, and an unclaimed Node has nowhere to put one.
      message.setReject("Mailda Node is not yet claimed");
      return;
    }

    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const result = await acceptInbound(env, clock, claimed.org_id, {
      providerEventId: message.headers.get("message-id") ?? `sha256:${await hashHex(raw)}`,
      envelopeFrom: message.from,
      envelopeTo: message.to,
      raw,
    });

    if (result.status === "unknown_recipient") {
      message.setReject("No such recipient at this Mailda Node");
      return;
    }

    // Fast-path publication, with the DO alarm as the safety net (#9). waitUntil so accepting
    // the message is never delayed by publication.
    ctx.waitUntil(armSweeper(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const clock = createSystemCtx();

    if (url.pathname === "/health") {
      const claimed = await env.CATALOG.prepare(
        "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
      ).first<{ org_id: string }>();
      const pending = await env.CATALOG.prepare(
        "SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL",
      ).first<{ n: number }>();
      return Response.json({
        node: "mailda",
        layer: 1,
        claimed: claimed?.org_id != null,
        outboxPending: pending?.n ?? 0,
        at: new Date(clock.now()).toISOString(),
      });
    }

    if (url.pathname === "/api/claim" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<string, string>;
      const outcome = await claimNode(
        env,
        clock,
        body.secret ?? "",
        body.email ?? "",
        body.organization ?? "Mailda",
      );
      if (outcome.status !== "claimed") {
        const codes: Record<string, number> = {
          already_claimed: 409, bad_secret: 403, not_installed: 503,
        };
        return Response.json(
          { error: outcome.status, message: claimMessage(outcome.status) },
          { status: codes[outcome.status] ?? 400 },
        );
      }
      return Response.json(
        { claimed: true, organizationId: outcome.orgId },
        { headers: { "set-cookie": sessionCookie(outcome.sessionToken!) } },
      );
    }

    if (url.pathname === "/api/me") {
      const who = await principalFor(env, request);
      return who === null
        ? Response.json({ signedIn: false }, { status: 401 })
        : Response.json({ signedIn: true, userId: who.userId, organizationId: who.orgId });
    }

    if (url.pathname === "/api/messages" && request.method === "GET") {
      return listMessages(env, request);
    }

    // Original .eml, streamed frame by frame so a 25 MiB message is never buffered (#16).
    const raw = /^\/api\/messages\/([^/]+)\/raw$/.exec(url.pathname);
    if (raw && request.method === "GET") {
      const allowed = await authorize(env, request, raw[1]!);
      if (!allowed.ok) return allowed.response;
      return new Response(await streamEvidence(env, allowed.blobKey), {
        headers: {
          "content-type": "message/rfc822",
          "content-disposition": `attachment; filename="${raw[1]}.eml"`,
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      ctx.waitUntil(armSweeper(env));
      return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
};

/** Ensures a sweep is scheduled. Idempotent — the DO only sets an alarm if none is pending. */
async function armSweeper(env: Env): Promise<void> {
  try {
    await env.OUTBOX_SWEEPER.getByName("node").schedule();
  } catch {
    // A failure to arm is not a failure to accept mail. The next request arms it again, and
    // the row stays visibly unpublished meanwhile — which is the honest state.
  }
}

function claimMessage(status: string): string {
  switch (status) {
    case "already_claimed":
      return "This Node has already been claimed. Sign in instead, or restore from backup to start over.";
    case "bad_secret":
      return "That bootstrap secret does not match. It was shown once during `mailda deploy`.";
    case "not_installed":
      return "This Node has no bootstrap secret recorded. Run `mailda deploy` to complete installation.";
    default:
      return "Claim failed.";
  }
}

async function hashHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
