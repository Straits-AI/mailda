import { createSystemCtx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { claimNode } from "./claim.ts";
import { streamEvidence } from "./evidence-store.ts";
import { acceptInbound } from "./ingress.ts";
import { listMessages, authorize, principalFor } from "./authz-read.ts";
import { publicJwks, rotateSigningKey } from "./auth/keys.ts";
import {
  clearedCookies,
  cookieValue,
  login,
  refreshSession,
  revokeAllSessions,
  sessionCookies,
  signOut,
  REFRESH_COOKIE,
  type IssuedSession,
} from "./auth/session.ts";
import { authenticationIsImpossible, formatReport, runDoctor, withoutDataFindings } from "./doctor.ts";
import { clientScript, page } from "./ui.ts";

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
    try {
      return noStore(new URL(request.url), await route(request, env, ctx));
    } catch (error) {
      // Bare `throw` reaches the client as Cloudflare's opaque "error code 1101", which tells an
      // operator nothing. The message goes to the log (observability is on); the response says only
      // that something failed, because an unauthenticated caller is not owed internals.
      console.error("E_UNHANDLED", (error as Error).stack ?? String(error));
      return Response.json(
        { error: "internal", message: "This Node failed to handle the request. Check its logs." },
        { status: 500 },
      );
    }
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  {
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

    /**
     * `doctor`. Open while unclaimed — no organization, no users, no mail, and this is exactly when
     * an operator needs it. Authenticated once claimed, because the report names tables, bindings,
     * receipt ids and counts, and a diagnostic is the obvious place to leak what §5C forbids
     * leaking. `/health` remains the unauthenticated surface and remains deliberately dull.
     *
     * `?format=text` for a CLI and for a log line; JSON otherwise.
     */
    if (url.pathname === "/api/doctor") {
      const orgId = await organizationId(env);
      const signedIn = (await principalFor(env, request)) !== null;
      const full = await runDoctor(env, clock);

      // A claimed Node normally requires authentication here. The exception is the case that made
      // this endpoint useless when it mattered: if the Node cannot authenticate *anyone*, the gate
      // is not one a caller can satisfy, so the reduced report is served instead of a 401.
      let report = full;
      if (orgId !== null && !signedIn) {
        if (!authenticationIsImpossible(full)) return unauthenticated();
        report = withoutDataFindings(full);
      }
      // A refusing verdict is a 503: the Node is telling a load balancer and a human the same
      // thing, rather than answering 200 with bad news in the body.
      const status = report.verdict === "refuse" ? 503 : 200;

      return url.searchParams.get("format") === "text"
        ? new Response(formatReport(report) + "\n", {
            status, headers: { "content-type": "text/plain; charset=utf-8" },
          })
        : Response.json(report, { status });
    }

    if (url.pathname === "/api/claim" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<string, string>;
      const outcome = await claimNode(
        env,
        clock,
        body.secret ?? "",
        body.email ?? "",
        body.password ?? "",
        body.organization ?? "Mailda",
      );
      if (outcome.status !== "claimed") {
        const codes: Record<string, number> = {
          already_claimed: 409, bad_secret: 403, not_installed: 503, weak_password: 422,
        };
        return Response.json(
          { error: outcome.status, message: outcome.problem ?? claimMessage(outcome.status) },
          { status: codes[outcome.status] ?? 400 },
        );
      }
      return sessionResponse(
        { claimed: true, organizationId: outcome.orgId, email: (body.email ?? "").toLowerCase() },
        outcome.session!,
      );
    }

    // ---- Session lifecycle -------------------------------------------------------------
    //
    // The client contract, stated once here because getting it wrong is what produces the
    // symptom nobody should ever see — a working session that surfaces a 401:
    //
    //   every 401 from this Node carries `refreshable: true | false`.
    //
    // `true` means the access token expired or is unverifiable and a refresh is worth trying.
    // `false` means the refresh token itself is gone, and the only honest next step is the
    // sign-in form. A client that cannot tell these apart either retries forever or signs
    // people out for a recoverable reason.

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<string, string>;
      const orgId = await organizationId(env);
      if (orgId === null) {
        return Response.json(
          { error: "not_claimed", message: "This Node has not been claimed yet." },
          { status: 503 },
        );
      }

      const outcome = await login(env, clock, orgId, body.email ?? "", body.password ?? "");
      if (outcome.status === "locked_out") {
        return Response.json(
          {
            error: "locked_out",
            message:
              `Too many failed sign-in attempts. Try again in ` +
              `${Math.ceil(outcome.retryAfterSeconds / 60)} minute(s).`,
          },
          { status: 429, headers: { "retry-after": String(outcome.retryAfterSeconds) } },
        );
      }
      if (outcome.status !== "signed_in") {
        // `no_password_set` is a genuinely different state internally, and it is collapsed here
        // on purpose: telling an anonymous caller that an address exists but has no password
        // hands them half the answer. §5C's rule about denials applies to sign-in too.
        return Response.json(
          { error: "invalid_credentials", message: "That email and password do not match." },
          { status: 401, headers: { "x-mailda-refreshable": "false" } },
        );
      }
      return sessionResponse(
        { signedIn: true, userId: outcome.session.userId, organizationId: outcome.session.orgId },
        outcome.session,
      );
    }

    if (url.pathname === "/api/auth/refresh" && request.method === "POST") {
      const presented = cookieValue(request, REFRESH_COOKIE) ?? "";
      if (presented === "") {
        return signedOutResponse("no_refresh_token", "Your session has ended. Please sign in again.");
      }

      const outcome = await refreshSession(env, clock, presented);
      if (outcome.status === "rotated" || outcome.status === "replayed") {
        return sessionResponse(
          {
            refreshed: true,
            // Surfaced rather than hidden: `replayed` means this Node handed back a successor it
            // had already issued, and an operator debugging a client's refresh behaviour needs
            // to be able to see that happening.
            replayed: outcome.status === "replayed",
            userId: outcome.session.userId,
            organizationId: outcome.session.orgId,
          },
          outcome.session,
        );
      }
      // Every remaining case is terminal: the refresh token is unknown, expired, or the family
      // was revoked because it was presented twice outside the replay window. None of them are
      // retryable, and the cookies are cleared so a client cannot loop on a dead token.
      return signedOutResponse(
        outcome.status,
        outcome.status === "reuse_detected"
          ? "This session was signed out because its token was used twice. Sign in again."
          : "Your session has ended. Please sign in again.",
      );
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const presented = cookieValue(request, REFRESH_COOKIE);
      if (presented !== null && presented !== "") await signOut(env, clock, presented);
      return signedOutResponse("signed_out", "Signed out.");
    }

    if (url.pathname === "/api/auth/logout-everywhere" && request.method === "POST") {
      const who = await principalFor(env, request);
      if (who === null) return unauthenticated();
      const revoked = await revokeAllSessions(env, clock, who.orgId, who.userId);
      return signedOutResponse("signed_out", `Signed out of ${revoked} session(s).`);
    }

    // Public keys. Verification never requires a secret — that is the point of ES256 over
    // HS256, and publishing them is what keeps it true.
    if (url.pathname === "/.well-known/jwks.json") {
      return Response.json(await publicJwks(env, clock.now()), {
        headers: { "cache-control": `max-age=${BUDGETS["auth.signing_key_cache_seconds"]}` },
      });
    }

    // Rotation. Owner-authenticated, because it is an ordinary operation that should be easy to
    // perform — a rotation procedure nobody can run is a key that never rotates.
    if (url.pathname === "/api/auth/rotate-signing-key" && request.method === "POST") {
      const who = await principalFor(env, request);
      if (who === null) return unauthenticated();
      const rotated = await rotateSigningKey(env, clock);
      return Response.json({
        rotated: true,
        kid: rotated.kid,
        // Named explicitly so the operator can see that outstanding tokens keep working.
        retiring: rotated.retired,
        stillVerifiesForSeconds: BUDGETS["auth.signing_key_verify_grace_seconds"],
      });
    }

    if (url.pathname === "/api/me") {
      const who = await principalFor(env, request);
      if (who === null) return unauthenticated();
      const user = await env.CATALOG.prepare("SELECT email FROM users WHERE id = ? LIMIT 1")
        .bind(who.userId)
        .first<{ email: string }>();
      return Response.json({
        signedIn: true,
        userId: who.userId,
        organizationId: who.orgId,
        email: user?.email ?? null,
      });
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

    const script = clientScript(url.pathname);
    if (script !== null) return script;

    if (url.pathname === "/" || url.pathname === "/index.html") {
      ctx.waitUntil(armSweeper(env));
      return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

/**
 * `Cache-Control: no-store` on every API response, which §8 requires for authentication, admin and
 * content surfaces.
 *
 * This was missing, and it was **not** theoretical: a `GET /api/doctor` response was served from an
 * edge cache during testing, returning a stale verdict and omitting a field the deployed code was
 * already producing. An authenticated diagnostic naming tables, receipt ids and counts is precisely
 * what must never sit in a shared cache.
 *
 * Applied centrally rather than per-route, because a header that every future handler has to
 * remember is a header that will be forgotten — the same structural-over-disciplined choice as
 * #4's binding rule. `/health` and the client scripts are deliberately excluded: one is
 * non-disclosive by design and the other is meant to be cached briefly.
 */
function noStore(url: URL, response: Response): Response {
  if (!url.pathname.startsWith("/api/")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("vary", "cookie");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * A response that installs a session. Three Set-Cookie headers, which is why this uses
 * `Headers.append` — assigning `set-cookie` in a header object keeps only the last one, and the
 * resulting bug is a session that half-works.
 */
function sessionResponse(body: unknown, session: IssuedSession): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of sessionCookies(session)) headers.append("set-cookie", cookie);
  return new Response(
    JSON.stringify({ ...(body as object), accessExpiresAt: session.accessExpiresAt }),
    { headers },
  );
}

/**
 * A terminal 401: the session is over and no refresh will fix it. Cookies are cleared, so a
 * client cannot sit in a refresh loop against a token that will never work again.
 */
function signedOutResponse(error: string, message: string): Response {
  const headers = new Headers({ "content-type": "application/json", "x-mailda-refreshable": "false" });
  for (const cookie of clearedCookies()) headers.append("set-cookie", cookie);
  const status = error === "signed_out" ? 200 : 401;
  return new Response(JSON.stringify({ error, message, refreshable: false }), { status, headers });
}

/**
 * A 401 that a refresh may fix. The access token is missing, expired or unverifiable — but the
 * refresh cookie is not consulted here, so this says "try refreshing", never "you are signed
 * out". Only the refresh endpoint gets to conclude the latter.
 */
function unauthenticated(): Response {
  return Response.json(
    { error: "unauthenticated", message: "Sign in to continue.", refreshable: true },
    { status: 401, headers: { "x-mailda-refreshable": "true" } },
  );
}

/** The claimed organization, or null on an unclaimed Node. */
async function organizationId(env: Env): Promise<string | null> {
  const row = await env.CATALOG.prepare(
    "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
  ).first<{ org_id: string }>();
  return row?.org_id ?? null;
}

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
